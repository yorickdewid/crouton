import path from "path";
import { mkdir, copyFile, readdir } from "fs/promises";
import { $ } from "bun";
import { config } from "../config";
import type { VMConfig, VMInstance } from "../types";
import { deterministicMac } from "../net/tap";
import { writeVMConfig } from "./persist";

export interface CreateVMOptions {
  name: string;
  image: string;       // filename from images/ dir
  diskSizeGb: number;
  cpus: number;
  memoryMb: number;
}

export async function listImages(): Promise<string[]> {
  try {
    const entries = await readdir(config.imageDir);
    return entries.filter(f => f.endsWith(".qcow2") || f.endsWith(".img") || f.endsWith(".raw")).sort();
  } catch {
    return [];
  }
}

export async function provisionVM(opts: CreateVMOptions): Promise<VMConfig> {
  const { name, image, diskSizeGb, cpus, memoryMb } = opts;

  const vmDir = path.join(config.vmDir, name);
  const diskPath = path.join(vmDir, "disk0.qcow2");
  const imagePath = path.join(config.imageDir, image);

  if (await Bun.file(path.join(vmDir, "disk0.qcow2")).exists()) {
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

  await writeVMConfig(vmConfig);
  return vmConfig;
}
