import type { BootConfig, VMRuntime } from "../orchestrator/contract";

/**
 * Optional lifecycle hooks passed to {@link VMRunner.start}. Today only
 * `onExit` is observed; the runner calls it after the underlying VMM exits
 * so the caller can update its tracked state.
 */
export interface VMRunnerEvents {
  /**
   * Fires after the VMM process has fully exited and the runner has cleaned
   * up its TAP / socket. The `exitCode` matches CH's process exit code (0
   * = clean shutdown, anything else = treat as error).
   */
  onExit?: (name: string, exitCode: number) => void;
}

/**
 * The execution seam between {@link VMManager} and the world of running
 * VMMs. Two implementations are planned:
 *
 * - `LocalVMRunner` — spawns CH directly inside Bun (today's behaviour,
 *   lives in `src/vm/local-runner.ts`). Used while we don't have a
 *   separate orchestrator yet.
 * - `RemoteVMRunner` — talks to the future `croutond` daemon over the
 *   wire contract in `src/orchestrator/contract.ts`. Will replace
 *   `LocalVMRunner` once croutond exists.
 *
 * The interface is the same for both: callers above this seam never see
 * CH, sudo, TAPs, or pool slots.
 */
export interface VMRunner {
  /**
   * Boot a VM from a fully-resolved {@link BootConfig}. Resolves once the
   * VMM is up; the optional {@link VMRunnerEvents.onExit} fires later if
   * the VMM exits unexpectedly.
   * @throws If a VM with this name is already running on this runner.
   */
  start(config: BootConfig, events?: VMRunnerEvents): Promise<VMRuntime>;
  /** Graceful shutdown via CH, falling back to SIGTERM. */
  stop(name: string): Promise<void>;
  /** Proxy CH's `/vm.reboot`. */
  reboot(name: string): Promise<void>;
  /** Proxy CH's `/vm.pause`. */
  pause(name: string): Promise<void>;
  /** Proxy CH's `/vm.resume`. */
  resume(name: string): Promise<void>;
  /** Write a snapshot to `destPath`. */
  snapshot(name: string, destPath: string): Promise<void>;
  /** Latest virtio counter snapshot (network + disk). */
  counters(name: string): Promise<unknown>;
  /** CH `vm.info` response, verbatim. */
  info(name: string): Promise<unknown>;
  /** True if the VMM responds to `vmm.ping`. */
  ping(name: string): Promise<boolean>;
  /** Enumerate the runner's currently-known live VMs. */
  listRunning(): Promise<VMRuntime[]>;
}
