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
 * is the runner's job. All public methods take the stable VM `id`; the
 * mutable user-facing `label` lives only on the config / instance.
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
      this.instances.set(vm.id, vm);
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

  /** Returns a tracked VM by id, or `undefined` if not found. */
  getVM(id: string): VMInstance | undefined {
    return this.instances.get(id);
  }

  /**
   * Tracks a new instance without starting it. Used after a VM is created
   * out-of-band (e.g. cloned from another VM's disk).
   * @throws If a VM with this id is already tracked.
   */
  register(instance: VMInstance): void {
    if (this.instances.has(instance.id)) {
      throw new Error(`VM '${instance.id}' is already tracked`);
    }
    this.instances.set(instance.id, instance);
  }

  /**
   * Boots a VM via the runner. Resolves config paths to absolutes first.
   * @throws If a VM with this id is already in the `running` state.
   */
  async startVM(vmConfig: VMConfig): Promise<VMInstance> {
    const { id, label } = vmConfig;
    if (this.instances.get(id)?.state === "running") {
      throw new Error(`VM '${id}' is already running`);
    }

    const bootConfig = this.toBootConfig(vmConfig);
    const runtime = await this.runner.start(bootConfig, {
      onExit: (n, code) => this.handleExit(n, code),
    });

    const instance: VMInstance = {
      id,
      label,
      state: runtime.state,
      pid: runtime.pid,
      tapInterface: runtime.tap,
      mac: runtime.mac,
      startedAt: new Date(runtime.startedAt),
      config: vmConfig,
    };
    this.instances.set(id, instance);
    return instance;
  }

  /**
   * Graceful shutdown via the runner (which falls back to SIGTERM
   * internally). On success we drive the state to `"stopped"` here
   * directly — the LocalRunner also fires `onExit` which redundantly
   * sets the same state (idempotent), and the RemoteRunner has no
   * `onExit` to fire at all, so this is the only signal it can rely on.
   */
  async stopVM(id: string): Promise<void> {
    const vm = this.instances.get(id);
    if (!vm) throw new Error(`VM '${id}' not found`);
    this.setState(id, "stopping");
    try {
      await this.runner.stop(id);
    } catch (err) {
      this.setState(id, "error");
      throw err;
    }
    this.setState(id, "stopped");
    vm.pid = undefined;
    vm.tapInterface = undefined;
  }

  /**
   * Removes a VM's directory and untracks it.
   * @throws If the VM is in any non-terminal state.
   */
  async deleteVM(id: string): Promise<void> {
    const vm = this.instances.get(id);
    if (vm && (vm.state === "running" || vm.state === "booting" || vm.state === "stopping")) {
      throw new Error(`VM '${id}' is ${vm.state}; shut it down first`);
    }
    await rm(path.join(this.vmDir, id), { recursive: true, force: true });
    this.instances.delete(id);
  }

  /* ─── pass-throughs to the runner ─────────────────────────────────── */

  reboot(id: string): Promise<void> { return this.runner.reboot(id); }
  pause(id: string): Promise<void> { return this.runner.pause(id); }
  resume(id: string): Promise<void> { return this.runner.resume(id); }
  /** Try graceful shutdown; runner falls back to a SIGTERM internally. */
  shutdown(id: string): Promise<void> { return this.runner.stop(id); }
  snapshot(id: string, destPath: string): Promise<void> { return this.runner.snapshot(id, destPath); }
  counters(id: string): Promise<unknown> { return this.runner.counters(id); }
  info(id: string): Promise<unknown> { return this.runner.info(id); }
  ping(id: string): Promise<boolean> { return this.runner.ping(id); }

  /* ─── internal ────────────────────────────────────────────────────── */

  private setState(id: string, state: VMState): void {
    const vm = this.instances.get(id);
    if (vm) vm.state = state;
  }

  private handleExit(id: string, exitCode: number): void {
    const vm = this.instances.get(id);
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
   *
   * Wire note: {@link BootConfig.name} is populated from `cfg.id`. From
   * croutond's perspective it's just an opaque slot key, so we don't need
   * a coordinated Rust change to rename the field.
   */
  private toBootConfig(cfg: VMConfig): BootConfig {
    const vmPath = path.join(this.vmDir, cfg.id);
    const mode = cfg.bootMode;
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
      name: cfg.id,
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
