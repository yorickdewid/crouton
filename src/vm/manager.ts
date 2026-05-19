import path from "path";
import { rm } from "fs/promises";
import { config } from "../config";
import { allocateTap, deterministicMac, ensureBridge, setupTap, teardownTap } from "../net/tap";
import type { VMConfig, VMInstance, VMState } from "../types";

export class VMManager {
  private instances = new Map<string, VMInstance>();

  /**
   * Create a manager and optionally seed it with VM instances
   * @param instances - Array of VM instances to load into the manager
   */
  constructor(instances: VMInstance[] = []) {
    for (const vm of instances) {
      this.instances.set(vm.name, vm);
    }
  }

  /**
   * Get all VM instances
   * @returns Array of all managed VM instances
   */
  listVMs(): VMInstance[] {
    return [...this.instances.values()];
  }

  /**
   * Get a specific VM instance by name
   * @param name - The name of the VM to retrieve
   * @returns The VM instance if found, otherwise undefined
   */
  getVM(name: string): VMInstance | undefined {
    return this.instances.get(name);
  }

  /**
   * Update the state of a VM instance
   * @param name - The name of the VM to update
   * @param state - The new state for the VM
   * @private
   */
  private setState(name: string, state: VMState): void {
    const vm = this.instances.get(name);
    if (vm) vm.state = state;
  }

  /**
   * Start a VM with the given configuration
   * @param vmConfig - Configuration for the VM to start
   * @returns The created VM instance
   * @throws Error if VM is already running
   */
  async startVM(vmConfig: VMConfig): Promise<VMInstance> {
    const { name } = vmConfig;
    if (this.instances.get(name)?.state === "running") {
      throw new Error(`VM '${name}' is already running`);
    }

    const vmDir = path.join(config.vmDir, name);
    const sockPath = path.join(vmDir, "vmm.sock");
    const mac = deterministicMac(name);

    await ensureBridge();
    const tap = await allocateTap();
    await setupTap(tap);

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

    const proc = Bun.spawn(["sudo", config.chBinary, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      onExit: async (_proc, code) => {
        this.setState(name, code === 0 ? "stopped" : "error");
        if (instance.tapInterface) await teardownTap(instance.tapInterface);
        try { await Bun.file(sockPath).exists() && import("fs").then(fs => fs.promises.unlink(sockPath)); } catch { }
        this.instances.set(name, { ...instance, state: code === 0 ? "stopped" : "error", pid: undefined, tapInterface: undefined });
      },
    });

    instance.pid = proc.pid;
    this.setState(name, "running");
    return instance;
  }

  /**
   * Stop a running VM by name
   * @param name - The name of the VM to stop
   * @throws Error if VM is not found
   */
  async stopVM(name: string): Promise<void> {
    const vm = this.instances.get(name);
    if (!vm) throw new Error(`VM '${name}' not found`);
    this.setState(name, "stopping");
    if (vm.pid) process.kill(vm.pid, "SIGTERM");
  }

  /**
   * Delete a VM and remove its directory
   * @param name - The name of the VM to delete
   * @throws Error if VM is running, booting, or stopping
   */
  async deleteVM(name: string): Promise<void> {
    const vm = this.instances.get(name);
    if (vm && (vm.state === "running" || vm.state === "booting" || vm.state === "stopping")) {
      throw new Error(`VM '${name}' is ${vm.state}; shut it down first`);
    }
    const dir = path.join(config.vmDir, name);
    await rm(dir, { recursive: true, force: true });
    this.instances.delete(name);
  }

  /**
   * Build command line arguments for the Cloud Hypervisor binary
   * @param opts - Options for building arguments including VM directory, socket path, TAP interface, MAC address, and VM config
   * @returns Array of command line arguments
   * @private
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
      const readonly = disk.endsWith(".iso") ? ",readonly=on" : ",image_type=qcow2";
      args.push("--disk", `path=${diskPath}${readonly}`);
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
      const fw = Bun.file(path.join(vmDir, "CLOUDHV.fd")).size > 0
        ? path.join(vmDir, "CLOUDHV.fd")
        : path.join(config.firmwareDir, "CLOUDHV.fd");
      args.push("--firmware", fw, "--serial", "tty", "--console", "off");
    }

    return args;
  }
}
