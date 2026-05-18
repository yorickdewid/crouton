import path from "path";
import { stat } from "fs/promises";
import { config } from "../config";
import { vmmPing, vmInfo } from "../api/ch";
import { deterministicMac } from "../net/tap";
import { macToIp } from "../net/ip";
import { readVMConfig } from "./persist";
import type { BootMode, VMConfig, VMInstance } from "../types";

const KERNEL_NAMES = ["vmlinuz", "kernel", "bzImage", "Image"];
const FIRMWARE_NAMES = ["CLOUDHV.fd", "OVMF.fd", "edk2.fd"];

async function readDir(dir: string): Promise<string[]> {
  try {
    const glob = new Bun.Glob("*");
    const entries: string[] = [];
    for await (const entry of glob.scan({ cwd: dir, onlyFiles: false })) {
      entries.push(entry);
    }
    return entries;
  } catch {
    return [];
  }
}

async function inferConfig(vmName: string, vmDir: string, files: string[]): Promise<VMConfig> {
  const set = new Set(files);

  const kernelFile = KERNEL_NAMES.find(n => set.has(n))
    ?? files.find(f => !f.includes(".") || f.endsWith("vmlinuz") || f.endsWith("kernel"));

  const hasFirmware = FIRMWARE_NAMES.some(n => set.has(n));
  const hasInitrd = set.has("initrd.img") || set.has("initrd") || set.has("initramfs.img");

  let bootMode: BootMode = "unknown";
  if (kernelFile && hasInitrd) bootMode = "direct";
  else if (hasFirmware) bootMode = "uefi";

  const disks = files.filter(f => f.endsWith(".qcow2") || f.endsWith(".raw") || f.endsWith(".img") && !f.startsWith("initr"));

  return {
    name: vmName,
    bootMode,
    kernelPath: kernelFile,
    disks,
  };
}

async function enrichFromChApi(vmName: string, instance: VMInstance): Promise<void> {
  try {
    const info = await vmInfo(vmName) as any;
    const cfg = info?.config;
    if (cfg?.cpus?.boot_vcpus) instance.config.cpus = cfg.cpus.boot_vcpus;
    if (cfg?.memory?.size) instance.config.memoryMb = cfg.memory.size / (1024 * 1024);
  } catch {
    // CH api unavailable or VM not fully started yet — leave fields undefined
  }
}

export async function discoverVMs(): Promise<VMInstance[]> {
  const vmDir = config.vmDir;
  const vmNames = await readDir(vmDir);
  const instances: VMInstance[] = [];

  await Promise.all(vmNames.map(async (name) => {
    const dir = path.join(vmDir, name);
    const sockPath = path.join(dir, "vmm.sock");
    const files = await readDir(dir);

    const hasSock = await stat(sockPath).then(s => s.isSocket()).catch(() => false);
    const persisted = await readVMConfig(name);
    const vmConfig = persisted ?? await inferConfig(name, dir, files);
    const mac = deterministicMac(name);

    const instance: VMInstance = {
      name,
      state: "stopped",
      mac,
      config: vmConfig,
    };

    if (hasSock) {
      const alive = await vmmPing(name).catch(() => false);
      instance.state = alive ? "running" : "error";
      if (alive) {
        await enrichFromChApi(name, instance);
        instance.ip = await macToIp(mac);
      }
    }

    instances.push(instance);
  }));

  return instances.sort((a, b) => a.name.localeCompare(b.name));
}
