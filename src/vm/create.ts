import path from "path";
import { mkdir, copyFile, readdir, rm, cp } from "fs/promises";
import { $ } from "bun";
import { z } from "zod";
import type { VMConfig } from "../types";
import type { VMConfigStore } from "./persist";
import { buildSeedIso } from "./cloud-init";
import { ulid } from "../util/ulid";

/**
 * User-facing label schema: free-form, length-capped, trimmed. Doesn't
 * touch the filesystem so no path-safety regex is needed — directories
 * are ULIDs, not labels.
 */
const VMLabelSchema = z
  .string()
  .trim()
  .min(1, "label is required")
  .max(64, "label is too long");

/**
 * Single-tag alphabet: lowercase alphanumeric leading, plus `_`, `-`, `:`,
 * up to 32 chars. The colon is allowed so users can encode `k:v`-style
 * scopes (`env:prod`, `team:platform`) without us imposing a structure.
 */
export const TagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_:-]*$/, "must start alphanumeric and contain only letters, digits, '-', '_' or ':'");

/**
 * Array of tags. Bounded at 12 per VM, normalised on parse: deduplicated
 * (case-folded) and sorted. The output is canonical — callers can rely on
 * it being JSON-stable.
 */
export const TagsSchema = z
  .array(TagSchema)
  .max(12, "no more than 12 tags per VM")
  .transform((arr) => Array.from(new Set(arr)).sort());

/**
 * Zod schema for {@link CreateVMOptions}. Authoritative source of both the
 * runtime validation and the inferred TypeScript type.
 */
export const CreateVMOptionsSchema = z.object({
  /** User-facing display name. Mutable. Doesn't appear in any path. */
  label: VMLabelSchema,
  /** Filename of a base image inside the configured `imageDir`. */
  image: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "must be a simple filename (no '/' or path traversal)"),
  /** Target size for the root disk in gigabytes. */
  diskSizeGb: z.number().int().min(1).max(16384),
  /** Number of vCPUs the VM should boot with. */
  cpus: z.number().int().min(1).max(256),
  /** Memory size in megabytes. */
  memoryMb: z.number().int().min(64).max(4_194_304),
  /**
   * Optional `#cloud-config` user-data body. If present, the provisioner
   * writes `user-data` + `meta-data` into the VM directory, builds a
   * `seed.iso` via `cloud-localds`, and attaches it as a read-only disk.
   * Empty / omitted skips cloud-init entirely.
   */
  cloudInit: z.string().max(16384).optional(),
  /** Initial tags for the VM. Optional, defaults to empty. */
  tags: TagsSchema.optional(),
});

/**
 * Parameters required to provision a new VM.
 */
export type CreateVMOptions = z.infer<typeof CreateVMOptionsSchema>;

/**
 * Zod schema for {@link CloneVMOptions}.
 */
export const CloneVMOptionsSchema = z.object({
  /** Display label for the cloned VM. */
  label: VMLabelSchema,
});

/**
 * Parameters required to clone an existing VM.
 */
export type CloneVMOptions = z.infer<typeof CloneVMOptionsSchema>;

/**
 * Zod schema for a boolean toggle body, used by `PUT /api/vms/:name/autostart`.
 */
export const ToggleSchema = z.object({
  /** The new value for the flag. */
  value: z.boolean(),
});

/**
 * Zod schema for `PUT /api/vms/:name/config` — a partial patch of the
 * persisted {@link VMConfig}. Every field is optional; only the keys
 * present in the body are merged on top of the existing config. The
 * VM's `name` and `disks` are deliberately not editable here.
 */
export const VMConfigPatchSchema = z.object({
  label: VMLabelSchema.optional(),
  cpus: z.number().int().min(1).max(256).optional(),
  memoryMb: z.number().int().min(64).max(4_194_304).optional(),
  bootMode: z.enum(["direct", "uefi"]).optional(),
  kernelPath: z.string().max(255).optional(),
  autostart: z.boolean().optional(),
  tags: TagsSchema.optional(),
});

/**
 * Resolved patch body after schema parsing.
 */
export type VMConfigPatch = z.infer<typeof VMConfigPatchSchema>;

/**
 * Entries inside a source VM directory that must NOT be carried over to a clone.
 * Runtime sockets, snapshot archives, and the config file are all rewritten or
 * regenerated for the new VM.
 */
const SKIP_ON_CLONE = new Set(["vmm.sock", "snapshots", "crouton.json"]);

/**
 * Dependencies required by {@link createProvisioner}.
 */
export interface ProvisionerDeps {
  imageDir: string;
  vmDir: string;
  configStore: VMConfigStore;
}

/**
 * Creates new VM directories — either from a base image (provision) or by
 * duplicating an existing VM (clone) — and persists their config.
 */
export interface VMProvisioner {
  /** Provisions a new VM directory from a base image and persists its config. */
  provision(opts: CreateVMOptions): Promise<VMConfig>;
  /**
   * Duplicates an existing VM directory. The clone gets a freshly minted
   * ULID and the supplied label. Caller is responsible for ensuring the
   * source VM is stopped before invoking; cloning a running VM produces
   * a corrupt disk.
   *
   * @param sourceId - Id (directory name) of the VM being cloned.
   * @param targetLabel - Display label for the new VM.
   * @param sourceConfig - In-memory config of the source (used to seed the new `crouton.json`).
   * @returns The new VM's config (with its fresh id).
   */
  clone(sourceId: string, targetLabel: string, sourceConfig: VMConfig): Promise<VMConfig>;
}

/**
 * Builds a {@link VMProvisioner}.
 */
export function createProvisioner(deps: ProvisionerDeps): VMProvisioner {
  const { imageDir, vmDir: rootDir, configStore } = deps;

  return {
    async provision(opts) {
      const { label, image, diskSizeGb, cpus, memoryMb, cloudInit, tags } = opts;

      const id = ulid();
      const vmDir = path.join(rootDir, id);
      const diskPath = path.join(vmDir, "disk0.qcow2");
      const imagePath = path.join(imageDir, image);

      if (!(await Bun.file(imagePath).exists())) {
        throw new Error(`base image '${image}' not found in image directory`);
      }

      // Fresh ULID — overwhelmingly unlikely to collide with an existing
      // directory, but guard anyway so a one-in-a-trillion collision
      // can't silently clobber another VM's disk.
      if (await Bun.file(diskPath).exists()) {
        throw new Error(`id collision: ${id} already exists`);
      }

      await mkdir(vmDir, { recursive: true });
      try {
        await copyFile(imagePath, diskPath);
        await $`qemu-img resize ${diskPath} ${diskSizeGb}G`;

        const disks = ["disk0.qcow2"];
        const userData = cloudInit?.trim();
        if (userData) {
          // The cloud-init hostname is what the guest will see; the label
          // is the friendliest stable string we have for it.
          await buildSeedIso(vmDir, label, userData);
          disks.push("seed.iso");
        }

        const vmConfig: VMConfig = {
          id,
          label,
          cpus,
          memoryMb,
          bootMode: "uefi",
          disks,
          tags: tags ?? [],
        };

        await configStore.write(vmConfig);
        return vmConfig;
      } catch (err) {
        await rm(vmDir, { recursive: true, force: true }).catch(() => { /* nothing to roll back */ });
        throw err;
      }
    },

    async clone(sourceId, targetLabel, sourceConfig) {
      const sourceDir = path.join(rootDir, sourceId);
      const targetId = ulid();
      const targetDir = path.join(rootDir, targetId);

      if (await Bun.file(path.join(targetDir, "disk0.qcow2")).exists()) {
        throw new Error(`id collision: ${targetId} already exists`);
      }

      await mkdir(targetDir, { recursive: true });
      try {
        const entries = await readdir(sourceDir, { withFileTypes: true });
        for (const entry of entries) {
          if (SKIP_ON_CLONE.has(entry.name)) continue;
          const src = path.join(sourceDir, entry.name);
          const dst = path.join(targetDir, entry.name);
          if (entry.isDirectory()) {
            await cp(src, dst, { recursive: true });
          } else {
            await copyFile(src, dst);
          }
        }

        const targetConfig: VMConfig = { ...sourceConfig, id: targetId, label: targetLabel };
        await configStore.write(targetConfig);
        return targetConfig;
      } catch (err) {
        await rm(targetDir, { recursive: true, force: true }).catch(() => { /* nothing to roll back */ });
        throw err;
      }
    },
  };
}
