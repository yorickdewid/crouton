import path from "path";
import { stat } from "fs/promises";
import type { CloudHypervisor } from "../api/ch";
import type { NetworkManager } from "../net/manager";
import type { VMConfigStore } from "./persist";
import type { BootMode, VMConfig, VMInstance } from "../types";

/**
 * Result of inspecting Cloud Hypervisor's `/vm.info` for an already-running VM.
 */
interface ChVmInfo {
  config?: {
    cpus?: { boot_vcpus?: number };
    memory?: { size?: number };
  };
}

/**
 * Scans the VM directory at startup to build the initial set of {@link VMInstance}s.
 *
 * Per VM, it prefers a persisted `crouton.json` over filesystem inference,
 * and pings the Cloud Hypervisor socket to determine the live state.
 */
export class VMDiscoverer {
  private static readonly KERNEL_NAMES = ["vmlinuz", "kernel", "bzImage", "Image"];
  private static readonly FIRMWARE_NAMES = ["CLOUDHV.fd", "OVMF.fd", "edk2.fd"];

  /**
   * @param vmDir - Root directory containing per-VM folders.
   * @param configStore - Source of authoritative per-VM configs when present.
   * @param chApi - Client used to ping running VMs and enrich config from `vm.info`.
   * @param net - Used for deterministic MAC generation and IP resolution.
   */
  constructor(
    private readonly vmDir: string,
    private readonly configStore: VMConfigStore,
    private readonly chApi: CloudHypervisor,
    private readonly net: NetworkManager,
  ) { }

  /**
   * Walks `vmDir` and produces a {@link VMInstance} per subdirectory.
   * @returns Discovered instances sorted by name.
   */
  async discover(): Promise<VMInstance[]> {
    const vmNames = await this.listEntries(this.vmDir);
    const instances = await Promise.all(vmNames.map(name => this.discoverOne(name)));
    return instances.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Discovers a single VM by name.
   */
  private async discoverOne(name: string): Promise<VMInstance> {
    const dir = path.join(this.vmDir, name);
    const sockPath = path.join(dir, "vmm.sock");
    const files = await this.listEntries(dir);

    const hasSock = await stat(sockPath).then(s => s.isSocket()).catch(() => false);
    const persisted = await this.configStore.read(name);
    const vmConfig = persisted ?? this.inferConfig(name, files);
    const mac = this.net.macFor(name);

    const instance: VMInstance = {
      name,
      state: "stopped",
      mac,
      config: vmConfig,
    };

    if (hasSock) {
      const alive = await this.chApi.vmmPing(name).catch(() => false);
      instance.state = alive ? "running" : "error";
      if (alive) {
        await this.enrichFromChApi(name, instance);
        instance.ip = await this.net.macToIp(mac);
      }
    }

    return instance;
  }

  /**
   * Infers config from filesystem layout when no persisted config exists.
   * Picks a kernel filename, decides boot mode, and collects disk images.
   */
  private inferConfig(vmName: string, files: string[]): VMConfig {
    const set = new Set(files);

    const kernelFile = VMDiscoverer.KERNEL_NAMES.find(n => set.has(n))
      ?? files.find(f => !f.includes(".") || f.endsWith("vmlinuz") || f.endsWith("kernel"));

    const hasFirmware = VMDiscoverer.FIRMWARE_NAMES.some(n => set.has(n));
    const hasInitrd = set.has("initrd.img") || set.has("initrd") || set.has("initramfs.img");

    let bootMode: BootMode = "unknown";
    if (kernelFile && hasInitrd) bootMode = "direct";
    else if (hasFirmware) bootMode = "uefi";

    const disks = files.filter(f =>
      f.endsWith(".qcow2") || f.endsWith(".raw") || (f.endsWith(".img") && !f.startsWith("initr")),
    );

    return {
      name: vmName,
      bootMode,
      kernelPath: kernelFile,
      disks,
    };
  }

  /**
   * Fills `cpus` and `memoryMb` from the live `/vm.info` response when available.
   */
  private async enrichFromChApi(vmName: string, instance: VMInstance): Promise<void> {
    try {
      const info = await this.chApi.vmInfo(vmName) as ChVmInfo;
      const cfg = info?.config;
      if (cfg?.cpus?.boot_vcpus) instance.config.cpus = cfg.cpus.boot_vcpus;
      if (cfg?.memory?.size) instance.config.memoryMb = cfg.memory.size / (1024 * 1024);
    } catch {
      // CH API unavailable; leave inferred/persisted values in place
    }
  }

  /**
   * Lists top-level entries in a directory, swallowing access errors.
   */
  private async listEntries(dir: string): Promise<string[]> {
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
}
