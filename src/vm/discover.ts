import path from "path";
import { stat } from "fs/promises";
import type { CloudHypervisor } from "../api/ch";
import type { NetworkManager } from "../net/manager";
import type { VMConfigStore } from "./persist";
import type { BootMode, VMConfig, VMInstance } from "../types";

/**
 * Subset of Cloud Hypervisor's `/vm.info` response that we care about.
 */
interface ChVmInfo {
  config?: {
    cpus?: { boot_vcpus?: number };
    memory?: { size?: number };
  };
}

/**
 * Dependencies required by {@link createDiscoverer}.
 */
export interface DiscovererDeps {
  /** Root directory containing per-VM folders. */
  vmDir: string;
  /** Source of authoritative per-VM configs when present. */
  configStore: VMConfigStore;
  /** Client used to ping running VMs and enrich config from `vm.info`. */
  chApi: CloudHypervisor;
  /** Network helper used for MAC generation and IP resolution. */
  net: NetworkManager;
}

/**
 * Scans the VM directory at startup to build the initial set of {@link VMInstance}s.
 */
export interface VMDiscoverer {
  /** Walks `vmDir` and produces a {@link VMInstance} per subdirectory. */
  discover(): Promise<VMInstance[]>;
}

const KERNEL_NAMES = ["vmlinuz", "kernel", "bzImage", "Image"];
const FIRMWARE_NAMES = ["CLOUDHV.fd", "OVMF.fd", "edk2.fd"];

/**
 * Builds a {@link VMDiscoverer}. Per VM, it prefers a persisted
 * `crouton.json` over filesystem inference, and pings the Cloud Hypervisor
 * socket to determine live state.
 */
export function createDiscoverer(deps: DiscovererDeps): VMDiscoverer {
  const { vmDir, configStore, chApi, net } = deps;

  const listEntries = async (dir: string): Promise<string[]> => {
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
  };

  const inferConfig = (vmName: string, files: string[]): VMConfig => {
    const set = new Set(files);

    const kernelFile = KERNEL_NAMES.find(n => set.has(n))
      ?? files.find(f => !f.includes(".") || f.endsWith("vmlinuz") || f.endsWith("kernel"));

    const hasFirmware = FIRMWARE_NAMES.some(n => set.has(n));
    const hasInitrd = set.has("initrd.img") || set.has("initrd") || set.has("initramfs.img");

    let bootMode: BootMode = "unknown";
    if (kernelFile && hasInitrd) bootMode = "direct";
    else if (hasFirmware) bootMode = "uefi";

    const disks = files.filter(f =>
      f.endsWith(".qcow2") || f.endsWith(".raw") || (f.endsWith(".img") && !f.startsWith("initr")),
    );

    return { name: vmName, bootMode, kernelPath: kernelFile, disks };
  };

  const enrichFromChApi = async (vmName: string, instance: VMInstance): Promise<void> => {
    try {
      const info = await chApi.vmInfo(vmName) as ChVmInfo;
      const cfg = info?.config;
      if (cfg?.cpus?.boot_vcpus) instance.config.cpus = cfg.cpus.boot_vcpus;
      if (cfg?.memory?.size) instance.config.memoryMb = cfg.memory.size / (1024 * 1024);
    } catch {
      // CH API unavailable; leave inferred/persisted values in place
    }
  };

  const discoverOne = async (name: string): Promise<VMInstance> => {
    const dir = path.join(vmDir, name);
    const sockPath = path.join(dir, "vmm.sock");
    const files = await listEntries(dir);

    const hasSock = await stat(sockPath).then(s => s.isSocket()).catch(() => false);
    const persisted = await configStore.read(name);
    const vmConfig = persisted ?? inferConfig(name, files);
    const mac = net.macFor(name);

    const instance: VMInstance = { name, state: "stopped", mac, config: vmConfig };

    if (hasSock) {
      const alive = await chApi.vmmPing(name).catch(() => false);
      instance.state = alive ? "running" : "error";
      if (alive) {
        await enrichFromChApi(name, instance);
        instance.ip = await net.macToIp(mac);
      }
    }

    return instance;
  };

  return {
    async discover() {
      const vmNames = await listEntries(vmDir);
      const instances = await Promise.all(vmNames.map(discoverOne));
      return instances.sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
