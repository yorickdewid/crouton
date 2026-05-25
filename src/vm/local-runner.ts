import path from "path";
import { unlink } from "fs/promises";
import type { CloudHypervisor } from "../api/ch";
import type { NetworkManager } from "../net/manager";
import type { BootConfig, VMRuntime } from "../orchestrator/contract";
import type { VMRunner, VMRunnerEvents } from "./runner";

/**
 * Constructor dependencies for {@link createLocalRunner}.
 */
export interface LocalRunnerDeps {
  /** Per-VM Cloud Hypervisor REST client. */
  chApi: CloudHypervisor;
  /** Network helper for bridge / TAP / MAC operations. */
  net: NetworkManager;
  /** Root directory containing per-VM folders (used to derive socket paths). */
  vmDir: string;
  /** Path to the Cloud Hypervisor binary spawned for each VM. */
  chBinary: string;
}

/** Internal record kept for each live VM so we can teardown its TAP and socket on exit. */
interface LiveVM {
  pid: number;
  tap: string;
  mac: string;
  startedAt: string;
  sockPath: string;
}

/**
 * Builds the local {@link VMRunner}. Owns CH process spawning, TAP/bridge
 * setup, and socket cleanup — i.e. all the privileged / OS-touching work
 * that will eventually move to `croutond`.
 *
 * The runner keys every operation by the VM id passed through
 * {@link BootConfig.name}; it never sees the user-facing label.
 */
export function createLocalRunner(deps: LocalRunnerDeps): VMRunner {
  const { chApi, net, vmDir: rootDir, chBinary } = deps;
  const live = new Map<string, LiveVM>();

  const sockPathOf = (id: string): string => path.join(rootDir, id, "vmm.sock");

  const buildChArgs = (cfg: BootConfig, tap: string, mac: string): string[] => {
    const args = [`--api-socket=${sockPathOf(cfg.name)}`];

    for (const disk of cfg.disks) {
      const flags = disk.endsWith(".iso") ? ",readonly=on" : ",image_type=qcow2";
      args.push("--disk", `path=${disk}${flags}`);
    }

    args.push(
      "--cpus", `boot=${cfg.cpus}`,
      "--memory", `size=${cfg.memoryMb}M,shared=on`,
      "--net", `tap=${tap},mac=${mac}`,
      "--rng", "src=/dev/urandom",
      "--watchdog",
    );

    if (cfg.bootMode === "direct" && cfg.kernelPath && cfg.initrdPath) {
      args.push(
        "--kernel", cfg.kernelPath,
        "--initramfs", cfg.initrdPath,
        "--cmdline", cfg.cmdline ?? "console=hvc0 root=/dev/vda1 rw rootfstype=ext4",
      );
    } else if (cfg.firmwarePath) {
      args.push("--firmware", cfg.firmwarePath, "--serial", "tty", "--console", "off");
    }

    return args;
  };

  return {
    async start(config, events) {
      const id = config.name;
      if (live.has(id)) {
        throw new Error(`VM '${id}' is already running`);
      }

      const mac = net.macFor(id);
      await net.ensureBridge();
      const tap = await net.allocateTap();
      await net.setupTap(tap);

      const sp = sockPathOf(id);
      const args = buildChArgs(config, tap, mac);

      const proc = Bun.spawn([chBinary, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        onExit: async (_proc, exitCode) => {
          await net.teardownTap(tap).catch(() => { /* best-effort */ });
          try { await unlink(sp); } catch { /* socket may already be gone */ }
          live.delete(id);
          events?.onExit?.(id, exitCode ?? -1);
        },
      });

      const startedAt = new Date().toISOString();
      live.set(id, { pid: proc.pid, tap, mac, startedAt, sockPath: sp });

      return {
        name: id,
        mac,
        tap,
        pid: proc.pid,
        state: "running",
        startedAt,
      };
    },

    async stop(id) {
      const vm = live.get(id);
      try {
        await chApi.vmShutdown(id);
      } catch {
        // CH API unreachable — fall back to SIGTERM. onExit will still fire
        // through Bun.spawn and clean up TAP + socket.
        if (vm) process.kill(vm.pid, "SIGTERM");
      }
    },

    reboot: (id) => chApi.vmReboot(id),
    pause: (id) => chApi.vmPause(id),
    resume: (id) => chApi.vmResume(id),
    snapshot: (id, dest) => chApi.vmSnapshot(id, dest),
    counters: (id) => chApi.vmCounters(id),
    info: (id) => chApi.vmInfo(id),
    ping: (id) => chApi.vmmPing(id),

    async listRunning() {
      const out: VMRuntime[] = [];
      for (const [id, vm] of live) {
        out.push({ name: id, mac: vm.mac, tap: vm.tap, pid: vm.pid, state: "running", startedAt: vm.startedAt });
      }
      return out;
    },
  };
}
