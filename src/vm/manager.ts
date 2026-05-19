import path from "path";
import { rm, unlink } from "fs/promises";
import type { NetworkManager } from "../net/manager";
import type { VMConfig, VMInstance, VMState } from "../types";

/**
 * Constructor dependencies for {@link VMManager}.
 */
export interface VMManagerOptions {
  /** Initial set of instances (typically from {@link VMDiscoverer.discover}). */
  seed?: VMInstance[];
  /** Network helper used for TAP and MAC operations. */
  net: NetworkManager;
  /** Directory containing per-VM folders. */
  vmDir: string;
  /** Path to the Cloud Hypervisor binary. */
  chBinary: string;
  /** Directory containing UEFI firmware images for the firmware boot fallback. */
  firmwareDir: string;
}

/**
 * Lifecycle owner for VMs: tracks state in memory, spawns/kills the
 * Cloud Hypervisor process, and cleans up resources on exit.
 *
 * In-flight CH operations (reboot, pause, snapshot, …) live on
 * {@link CloudHypervisor}; this class only handles process & filesystem.
 */
export class VMManager {
  private readonly instances = new Map<string, VMInstance>();
  private readonly net: NetworkManager;
  private readonly vmDir: string;
  private readonly chBinary: string;
  private readonly firmwareDir: string;

  /**
   * @param opts - See {@link VMManagerOptions}.
   */
  constructor(opts: VMManagerOptions) {
    this.net = opts.net;
    this.vmDir = opts.vmDir;
    this.chBinary = opts.chBinary;
    this.firmwareDir = opts.firmwareDir;
    for (const vm of opts.seed ?? []) {
      this.instances.set(vm.name, vm);
    }
  }

  /**
   * Number of VMs currently tracked.
   */
  get count(): number {
    return this.instances.size;
  }

  /**
   * Snapshot of all tracked VMs.
   */
  listVMs(): VMInstance[] {
    return [...this.instances.values()];
  }

  /**
   * Returns a tracked VM by name, or `undefined` if not found.
   * @param name - VM name.
   */
  getVM(name: string): VMInstance | undefined {
    return this.instances.get(name);
  }

  /**
   * Spawns the Cloud Hypervisor process for a VM and tracks it as `running`.
   * @param vmConfig - Configuration for the VM to start.
   * @returns The tracked {@link VMInstance}.
   * @throws If a VM with this name is already in the `running` state.
   */
  async startVM(vmConfig: VMConfig): Promise<VMInstance> {
    const { name } = vmConfig;
    if (this.instances.get(name)?.state === "running") {
      throw new Error(`VM '${name}' is already running`);
    }

    const vmDir = path.join(this.vmDir, name);
    const sockPath = path.join(vmDir, "vmm.sock");
    const mac = this.net.macFor(name);

    await this.net.ensureBridge();
    const tap = await this.net.allocateTap();
    await this.net.setupTap(tap);

    const instance: VMInstance = {
      name,
      state: "booting",
      tapInterface: tap,
      mac,
      startedAt: new Date(),
      config: vmConfig,
    };
    this.instances.set(name, instance);

    const args = this.buildChArgs({ vmDir, sockPath, tap, mac, vmConfig });

    const proc = Bun.spawn(["sudo", this.chBinary, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      onExit: async (_proc, code) => {
        const nextState: VMState = code === 0 ? "stopped" : "error";
        if (instance.tapInterface) await this.net.teardownTap(instance.tapInterface);
        await this.removeSocket(sockPath);
        this.instances.set(name, {
          ...instance,
          state: nextState,
          pid: undefined,
          tapInterface: undefined,
        });
      },
    });

    instance.pid = proc.pid;
    this.setState(name, "running");
    return instance;
  }

  /**
   * Sends SIGTERM to the Cloud Hypervisor process for a VM. Use only as a
   * fallback when the CH `/vm.shutdown` API is unavailable.
   * @param name - VM name.
   * @throws If the VM is not tracked.
   */
  async stopVM(name: string): Promise<void> {
    const vm = this.instances.get(name);
    if (!vm) throw new Error(`VM '${name}' not found`);
    this.setState(name, "stopping");
    if (vm.pid) process.kill(vm.pid, "SIGTERM");
  }

  /**
   * Removes a VM's directory and untracks it.
   * @param name - VM name.
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

  /**
   * Mutates the tracked state for a VM if present.
   */
  private setState(name: string, state: VMState): void {
    const vm = this.instances.get(name);
    if (vm) vm.state = state;
  }

  /**
   * Best-effort socket cleanup after CH exits.
   */
  private async removeSocket(sockPath: string): Promise<void> {
    try { await unlink(sockPath); } catch { /* already gone */ }
  }

  /**
   * Builds the Cloud Hypervisor CLI argv for a VM start invocation.
   */
  private buildChArgs(opts: {
    vmDir: string;
    sockPath: string;
    tap: string;
    mac: string;
    vmConfig: VMConfig;
  }): string[] {
    const { vmDir, sockPath, tap, mac, vmConfig } = opts;

    const args = [`--api-socket=${sockPath}`];

    for (const disk of vmConfig.disks) {
      const diskPath = path.join(vmDir, disk);
      const flags = disk.endsWith(".iso") ? ",readonly=on" : ",image_type=qcow2";
      args.push("--disk", `path=${diskPath}${flags}`);
    }

    args.push(
      "--cpus", `boot=${vmConfig.cpus ?? 2}`,
      "--memory", `size=${vmConfig.memoryMb ?? 2048}M,shared=on`,
      "--net", `tap=${tap},mac=${mac}`,
      "--rng", "src=/dev/urandom",
      "--watchdog",
    );

    if (vmConfig.bootMode === "direct" && vmConfig.kernelPath) {
      args.push(
        "--kernel", path.join(vmDir, vmConfig.kernelPath),
        "--initramfs", path.join(vmDir, "initrd.img"),
        "--cmdline", "console=hvc0 root=/dev/vda1 rw rootfstype=ext4",
      );
    } else {
      const localFw = path.join(vmDir, "CLOUDHV.fd");
      const fw = Bun.file(localFw).size > 0 ? localFw : path.join(this.firmwareDir, "CLOUDHV.fd");
      args.push("--firmware", fw, "--serial", "tty", "--console", "off");
    }

    return args;
  }
}
