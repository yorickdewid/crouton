import path from "path";
import { mkdir, copyFile, readdir, rm } from "fs/promises";
import { $ } from "bun";
import { z } from "zod";
import type { VMConfig } from "../types";
import type { VMConfigStore } from "./persist";

/**
 * Zod schema for {@link CreateVMOptions}. Authoritative source of both the
 * runtime validation and the inferred TypeScript type.
 *
 * `name` and `image` are tightened against path-traversal: they must look
 * like simple identifiers / filenames so they cannot escape `vmDir` /
 * `imageDir` when joined into a path.
 */
export const CreateVMOptionsSchema = z.object({
  /** Name to assign to the new VM (also the directory name under vmDir). */
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, "must start alphanumeric and contain only letters, digits, '-' or '_'"),
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
 * Dependencies required by {@link createProvisioner}.
 */
export interface ProvisionerDeps {
  imageDir: string;
  vmDir: string;
  configStore: VMConfigStore;
}

/**
 * Creates new VM directories: copies a base image, resizes its disk,
 * and writes the initial `crouton.json` config.
 */
export interface VMProvisioner {
  /** Sorted list of base-image filenames available in `imageDir`. */
  listImages(): Promise<string[]>;
  /** Provisions a new VM directory and persists its config. */
  provision(opts: CreateVMOptions): Promise<VMConfig>;
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
        // Roll back the partial VM directory so a retry starts from a clean slate.
        await rm(vmDir, { recursive: true, force: true }).catch(() => { /* nothing to roll back */ });
        throw err;
      }
    },
  };
}
