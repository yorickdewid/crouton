import path from "path";
import { mkdir, copyFile, readdir } from "fs/promises";
import { $ } from "bun";
import type { VMConfig } from "../types";
import type { VMConfigStore } from "./persist";

/**
 * Parameters required to provision a new VM.
 */
export interface CreateVMOptions {
  /** Name to assign to the new VM (also the directory name under vmDir). */
  name: string;
  /** Filename of a base image inside the configured `imageDir`. */
  image: string;
  /** Target size for the root disk in gigabytes. */
  diskSizeGb: number;
  /** Number of vCPUs the VM should boot with. */
  cpus: number;
  /** Memory size in megabytes. */
  memoryMb: number;
}

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
  ) {}

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

    if (await Bun.file(diskPath).exists()) {
      throw new Error(`VM '${name}' already exists`);
    }

    await mkdir(vmDir, { recursive: true });
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
  }
}
