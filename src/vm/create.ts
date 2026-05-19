import path from "path";
import { mkdir, copyFile, readdir, rm, cp } from "fs/promises";
import { $ } from "bun";
import { z } from "zod";
import type { VMConfig } from "../types";
import type { VMConfigStore } from "./persist";

/**
 * Shared name pattern: alphanumeric-leading, plus `_` and `-`, max 63 chars.
 * Used for both new and cloned VM names; the constraint guards against
 * path traversal when the name is joined into `vmDir/<name>`.
 */
const VMNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "must start alphanumeric and contain only letters, digits, '-' or '_'");

/**
 * Zod schema for {@link CreateVMOptions}. Authoritative source of both the
 * runtime validation and the inferred TypeScript type.
 */
export const CreateVMOptionsSchema = z.object({
  /** Name to assign to the new VM (also the directory name under vmDir). */
  name: VMNameSchema,
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
});

/**
 * Parameters required to provision a new VM.
 */
export type CreateVMOptions = z.infer<typeof CreateVMOptionsSchema>;

/**
 * Zod schema for {@link CloneVMOptions}.
 */
export const CloneVMOptionsSchema = z.object({
  /** Name for the cloned VM. */
  name: VMNameSchema,
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
  /** Sorted list of base-image filenames available in `imageDir`. */
  listImages(): Promise<string[]>;
  /** Provisions a new VM directory from a base image and persists its config. */
  provision(opts: CreateVMOptions): Promise<VMConfig>;
  /**
   * Duplicates an existing VM directory under a new name. Caller is
   * responsible for ensuring the source VM is stopped before invoking;
   * cloning a running VM produces a corrupt disk.
   *
   * @param sourceName - Name of the VM being cloned.
   * @param targetName - Name of the new VM.
   * @param sourceConfig - In-memory config of the source (used to seed the new `crouton.json`).
   * @returns The new VM's config.
   * @throws If a VM with `targetName` already exists.
   */
  clone(sourceName: string, targetName: string, sourceConfig: VMConfig): Promise<VMConfig>;
}

/**
 * Builds a {@link VMProvisioner}.
 */
export function createProvisioner(deps: ProvisionerDeps): VMProvisioner {
  const { imageDir, vmDir: rootDir, configStore } = deps;

  return {
    async listImages() {
      try {
        const entries = await readdir(imageDir);
        return entries
          .filter(f => f.endsWith(".qcow2") || f.endsWith(".img") || f.endsWith(".raw"))
          .sort();
      } catch {
        return [];
      }
    },

    async provision(opts) {
      const { name, image, diskSizeGb, cpus, memoryMb } = opts;

      const vmDir = path.join(rootDir, name);
      const diskPath = path.join(vmDir, "disk0.qcow2");
      const imagePath = path.join(imageDir, image);

      if (!(await Bun.file(imagePath).exists())) {
        throw new Error(`base image '${image}' not found in image directory`);
      }
      if (await Bun.file(diskPath).exists()) {
        throw new Error(`VM '${name}' already exists`);
      }

      await mkdir(vmDir, { recursive: true });
      try {
        await copyFile(imagePath, diskPath);
        await $`qemu-img resize ${diskPath} ${diskSizeGb}G`;

        const vmConfig: VMConfig = {
          name,
          cpus,
          memoryMb,
          bootMode: "uefi",
          disks: ["disk0.qcow2"],
        };

        await configStore.write(vmConfig);
        return vmConfig;
      } catch (err) {
        await rm(vmDir, { recursive: true, force: true }).catch(() => { /* nothing to roll back */ });
        throw err;
      }
    },

    async clone(sourceName, targetName, sourceConfig) {
      const sourceDir = path.join(rootDir, sourceName);
      const targetDir = path.join(rootDir, targetName);

      if (await Bun.file(path.join(targetDir, "disk0.qcow2")).exists()) {
        throw new Error(`VM '${targetName}' already exists`);
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

        const targetConfig: VMConfig = { ...sourceConfig, name: targetName };
        await configStore.write(targetConfig);
        return targetConfig;
      } catch (err) {
        await rm(targetDir, { recursive: true, force: true }).catch(() => { /* nothing to roll back */ });
        throw err;
      }
    },
  };
}
