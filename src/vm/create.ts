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
 * Creates new VM directories: copies a base image, resizes its disk,
 * and writes the initial `crouton.json` config.
 */
export class VMProvisioner {
  /**
   * @param imageDir - Directory containing base disk images.
   * @param vmDir - Directory under which per-VM folders are created.
   * @param configStore - Store used to persist the new VM's config.
   */
  constructor(
    private readonly imageDir: string,
    private readonly vmDir: string,
    private readonly configStore: VMConfigStore,
  ) { }

  /**
   * Lists candidate base images available for provisioning.
   * @returns Sorted list of filenames inside `imageDir` ending in `.qcow2`, `.img`, or `.raw`.
   */
  async listImages(): Promise<string[]> {
    try {
      const entries = await readdir(this.imageDir);
      return entries
        .filter(f => f.endsWith(".qcow2") || f.endsWith(".img") || f.endsWith(".raw"))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Provisions a new VM directory and persists its config.
   * @param opts - VM parameters; see {@link CreateVMOptions}.
   * @returns The persisted {@link VMConfig} ready to be passed to the manager to start.
   * @throws If a VM with this name already has a `disk0.qcow2` on disk.
   */
  async provision(opts: CreateVMOptions): Promise<VMConfig> {
    const { name, image, diskSizeGb, cpus, memoryMb } = opts;

    const vmDir = path.join(this.vmDir, name);
    const diskPath = path.join(vmDir, "disk0.qcow2");
    const imagePath = path.join(this.imageDir, image);

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

      await this.configStore.write(vmConfig);
      return vmConfig;
    } catch (err) {
      // Roll back the partial VM directory so a retry starts from a clean slate.
      await rm(vmDir, { recursive: true, force: true }).catch(() => { /* nothing to roll back */ });
      throw err;
    }
  }
}
