import path from "path";
import { rm } from "fs/promises";
import { config } from "../config";
import { allocateTap, deterministicMac, ensureBridge, setupTap, teardownTap } from "../net/tap";
import type { VMConfig, VMInstance, VMState } from "../types";

const instances = new Map<string, VMInstance>();

export function seedInstances(discovered: VMInstance[]): void {
  for (const vm of discovered) instances.set(vm.name, vm);
}

export function listVMs(): VMInstance[] {
  return [...instances.values()];
}

export function getVM(name: string): VMInstance | undefined {
  return instances.get(name);
}

function setState(name: string, state: VMState): void {
  const vm = instances.get(name);
  if (vm) vm.state = state;
}

export async function startVM(vmConfig: VMConfig): Promise<VMInstance> {
  const { name } = vmConfig;
  if (instances.get(name)?.state === "running") {
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
  instances.set(name, instance);

  const args = buildChArgs({ vmDir, sockPath, tap, mac, vmConfig });

  const proc = Bun.spawn(["sudo", config.chBinary, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    onExit: async (_proc, code) => {
      setState(name, code === 0 ? "stopped" : "error");
      if (instance.tapInterface) await teardownTap(instance.tapInterface);
      try { await Bun.file(sockPath).exists() && import("fs").then(fs => fs.promises.unlink(sockPath)); } catch {}
      instances.set(name, { ...instance, state: code === 0 ? "stopped" : "error", pid: undefined, tapInterface: undefined });
    },
  });

  instance.pid = proc.pid;
  setState(name, "running");
  return instance;
}

export async function stopVM(name: string): Promise<void> {
  const vm = instances.get(name);
  if (!vm) throw new Error(`VM '${name}' not found`);
  setState(name, "stopping");
  if (vm.pid) process.kill(vm.pid, "SIGTERM");
}

export async function deleteVM(name: string): Promise<void> {
  const vm = instances.get(name);
  if (vm && (vm.state === "running" || vm.state === "booting" || vm.state === "stopping")) {
    throw new Error(`VM '${name}' is ${vm.state}; shut it down first`);
  }
  const dir = path.join(config.vmDir, name);
  await rm(dir, { recursive: true, force: true });
  instances.delete(name);
}

function buildChArgs(opts: {
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
