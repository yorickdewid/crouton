import path from "path";
import { rm } from "fs/promises";
import type { VMRunner } from "./runner";
import type { BootConfig } from "../orchestrator/contract";
import type { VMConfig, VMInstance, VMState } from "../types";

/**
 * Constructor dependencies for {@link VMManager}.
 */
export interface VMManagerOptions {
  /** Initial set of instances (typically from {@link VMDiscoverer.discover}). */
  seed?: VMInstance[];
  /** Runtime backend that actually boots/proxies VMMs. */
  runner: VMRunner;
  /** Directory containing per-VM folders. */
  vmDir: string;
  /** Directory containing UEFI firmware images for the firmware boot fallback. */
  firmwareDir: string;
}

/**
 * Lifecycle owner for VMs: tracks state in memory, delegates all
 * process-level work to a {@link VMRunner}, and translates between
 * Bun's persistent {@link VMConfig} and the wire-shaped {@link BootConfig}.
 *
 * Knows nothing about Cloud Hypervisor, sudo, TAPs, or pool slots — that
 * is the runner's job.
 */
export class VMManager {
  private readonly instances = new Map<string, VMInstance>();
  private readonly runner: VMRunner;
  private readonly vmDir: string;
  private readonly firmwareDir: string;

  /**
   * @param opts - See {@link VMManagerOptions}.
   */
  constructor(opts: VMManagerOptions) {
    this.runner = opts.runner;
    this.vmDir = opts.vmDir;
    this.firmwareDir = opts.firmwareDir;
    for (const vm of opts.seed ?? []) {
      this.instances.set(vm.name, vm);
    }
  }

  /** Number of VMs currently tracked. */
  get count(): number {
    return this.instances.size;
  }

  /** Snapshot of all tracked VMs. */
  listVMs(): VMInstance[] {
    return [...this.instances.values()];
  }

  /** Returns a tracked VM by name, or `undefined` if not found. */
  getVM(name: string): VMInstance | undefined {
    return this.instances.get(name);
  }

  /**
   * Tracks a new instance without starting it. Used after a VM is created
   * out-of-band (e.g. cloned from another VM's disk).
   * @throws If a VM with this name is already tracked.
   */
  register(instance: VMInstance): void {
    if (this.instances.has(instance.name)) {
      throw new Error(`VM '${instance.name}' is already tracked`);
    }
    this.instances.set(instance.name, instance);
  }

  /**
   * Boots a VM via the runner. Resolves config paths to absolutes first.
   * @throws If a VM with this name is already in the `running` state.
   */
  async startVM(vmConfig: VMConfig): Promise<VMInstance> {
    const { name } = vmConfig;
    if (this.instances.get(name)?.state === "running") {
      throw new Error(`VM '${name}' is already running`);
    }

    const bootConfig = this.toBootConfig(vmConfig);
    const runtime = await this.runner.start(bootConfig, {
      onExit: (n, code) => this.handleExit(n, code),
    });

    const instance: VMInstance = {
      name,
      state: runtime.state,
      pid: runtime.pid,
      tapInterface: runtime.tap,
      mac: runtime.mac,
      startedAt: new Date(runtime.startedAt),
      config: vmConfig,
    };
    this.instances.set(name, instance);
    return instance;
  }

  /** Graceful shutdown via the runner (which falls back to SIGTERM internally). */
  async stopVM(name: string): Promise<void> {
    const vm = this.instances.get(name);
    if (!vm) throw new Error(`VM '${name}' not found`);
    this.setState(name, "stopping");
    await this.runner.stop(name);
  }

  /**
   * Removes a VM's directory and untracks it.
   * @throws If the VM is in any non-terminal state.
   */
  async deleteVM(name: string): Promise<void> {
    const vm = this.instances.get(name);
    if (vm && (vm.state === "running" || vm.state === "booting" || vm.state === "stopping")) {
      throw new Error(`VM '${name}' is ${vm.state}; shut it down first`);
    }
    await rm(path.join(this.vmDir, name), { recursive: true, force: true });
    this.instances.delete(name);
  }

  /* ─── pass-throughs to the runner ─────────────────────────────────── */

  reboot(name: string): Promise<void>   { return this.runner.reboot(name); }
  pause(name: string): Promise<void>    { return this.runner.pause(name); }
  resume(name: string): Promise<void>   { return this.runner.resume(name); }
  /** Try graceful shutdown; runner falls back to a SIGTERM internally. */
  shutdown(name: string): Promise<void> { return this.runner.stop(name); }
  snapshot(name: string, destPath: string): Promise<void> { return this.runner.snapshot(name, destPath); }
  counters(name: string): Promise<unknown> { return this.runner.counters(name); }
  info(name: string): Promise<unknown>     { return this.runner.info(name); }
  ping(name: string): Promise<boolean>     { return this.runner.ping(name); }

  /* ─── internal ────────────────────────────────────────────────────── */

  private setState(name: string, state: VMState): void {
    const vm = this.instances.get(name);
    if (vm) vm.state = state;
  }

  private handleExit(name: string, exitCode: number): void {
    const vm = this.instances.get(name);
    if (!vm) return;
    vm.state = exitCode === 0 ? "stopped" : "error";
    vm.pid = undefined;
    vm.tapInterface = undefined;
  }

  /**
   * Converts a persistent {@link VMConfig} (with relative paths and optional
   * fields) into a wire-shaped {@link BootConfig} the runner can boot
   * directly. Resolves the firmware fallback against the configured
   * `firmwareDir`.
   */
  private toBootConfig(cfg: VMConfig): BootConfig {
    const vmPath = path.join(this.vmDir, cfg.name);
    const mode = cfg.bootMode === "unknown" ? "uefi" : cfg.bootMode;
    const disks = cfg.disks.map(d => path.join(vmPath, d));

    let kernelPath: string | undefined;
    let initrdPath: string | undefined;
    let cmdline: string | undefined;
    let firmwarePath: string | undefined;

    if (mode === "direct" && cfg.kernelPath) {
      kernelPath = path.join(vmPath, cfg.kernelPath);
      initrdPath = path.join(vmPath, "initrd.img");
      cmdline = "console=hvc0 root=/dev/vda1 rw rootfstype=ext4";
    } else {
      const localFw = path.join(vmPath, "CLOUDHV.fd");
      firmwarePath = Bun.file(localFw).size > 0 ? localFw : path.join(this.firmwareDir, "CLOUDHV.fd");
    }

    return {
      name: cfg.name,
      cpus: cfg.cpus ?? 2,
      memoryMb: cfg.memoryMb ?? 2048,
      bootMode: mode,
      disks,
      kernelPath,
      initrdPath,
      cmdline,
      firmwarePath,
    };
  }
}
