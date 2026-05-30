import path from "path";
import type { VMRuntime } from "../orchestrator/contract";
import type { VMRunner } from "./runner";
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
  /** Runtime backend used to list live VMs and enrich config from `vm.info`. */
  runner: VMRunner;
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
const INITRD_NAMES = ["initrd.img", "initrd", "initramfs.img"];
const FIRMWARE_NAMES = ["CLOUDHV.fd", "OVMF.fd", "edk2.fd"];

/**
 * Builds a {@link VMDiscoverer}. Per VM, it prefers a persisted
 * `crouton.json` over filesystem inference, and asks the runner
 * (backed by croutond) which VMs are currently live.
 */
export function createDiscoverer(deps: DiscovererDeps): VMDiscoverer {
  const { vmDir, configStore, runner, net } = deps;

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

  const inferConfig = (vmId: string, files: string[]): VMConfig => {
    const set = new Set(files);

    const kernelFile = KERNEL_NAMES.find(n => set.has(n))
      ?? files.find(f => !f.includes(".") || f.endsWith("vmlinuz") || f.endsWith("kernel"));
    const initrdFile = INITRD_NAMES.find(n => set.has(n));

    const hasFirmware = FIRMWARE_NAMES.some(n => set.has(n));
    const hasInitrd = Boolean(initrdFile);

    // Default to UEFI when we can't tell — that's how toBootConfig
    // resolves the firmware fallback at spawn time anyway.
    let bootMode: BootMode = "uefi";
    if (kernelFile && hasInitrd) bootMode = "direct";
    else if (hasFirmware) bootMode = "uefi";

    const disks = files.filter(f =>
      f.endsWith(".qcow2") || f.endsWith(".raw") || (f.endsWith(".img") && !f.startsWith("initr")),
    );

    // No persisted config — use the directory name as both id and label
    // so the user still sees something meaningful in the sidebar.
    return { id: vmId, label: vmId, bootMode, kernelPath: kernelFile, initrdPath: initrdFile, disks };
  };

  const enrichFromRunner = async (vmId: string, instance: VMInstance): Promise<void> => {
    try {
      const info = await runner.info(vmId) as ChVmInfo;
      const cfg = info?.config;
      if (cfg?.cpus?.boot_vcpus) instance.config.cpus = cfg.cpus.boot_vcpus;
      if (cfg?.memory?.size) instance.config.memoryMb = cfg.memory.size / (1024 * 1024);
    } catch {
      // Runner / CH unavailable; leave inferred/persisted values in place
    }
  };

  const discoverOne = async (id: string, runtime?: VMRuntime): Promise<VMInstance> => {
    const dir = path.join(vmDir, id);
    const files = await listEntries(dir);

    const persisted = await configStore.read(id);
    const vmConfig = persisted ?? inferConfig(id, files);
    const mac = net.macFor(id);

    const instance: VMInstance = {
      id,
      label: vmConfig.label,
      state: "stopped",
      mac,
      config: vmConfig,
    };

    if (runtime) {
      instance.state = runtime.state;
      instance.pid = runtime.pid;
      instance.tapInterface = runtime.tap;
      instance.startedAt = runtime.startedAt ? new Date(runtime.startedAt) : undefined;
      await enrichFromRunner(id, instance);
      instance.ip = await net.macToIp(mac);
    }

    return instance;
  };

  return {
    async discover() {
      const ids = await listEntries(vmDir);
      const running = await runner.listRunning().catch(() => []);
      const runningById = new Map(running.map(vm => [vm.name, vm]));
      const instances = await Promise.all(ids.map(id => discoverOne(id, runningById.get(id))));
      // Sort by label so the sidebar reads naturally to humans even though
      // directory ids are time-encoded ULIDs.
      return instances.sort((a, b) => a.label.localeCompare(b.label));
    },
  };
}
