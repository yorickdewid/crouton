import type { BootConfig, VMRuntime } from "../orchestrator/contract";

/**
 * Optional lifecycle hooks passed to {@link VMRunner.start}. Today only
 * `onExit` is observed; implementations may call it after the underlying
 * VMM exits so the caller can update its tracked state.
 */
export interface VMRunnerEvents {
  /**
   * Fires after the VMM has fully exited. The `exitCode` follows Cloud
   * Hypervisor semantics (0 = clean shutdown, anything else = treat as
   * error). Remote runners may omit this callback when lifecycle events
   * are not pushed by the orchestrator.
   */
  onExit?: (name: string, exitCode: number) => void;
}

/**
 * The execution seam between {@link VMManager} and the world of running
 * VMMs. The Bun process uses a remote orchestrator implementation that
 * talks to `croutond` over the wire contract in
 * `src/orchestrator/contract.ts`.
 *
 * Callers above this seam never see CH, sudo, TAPs, or pool slots.
 */
export interface VMRunner {
  /**
   * Boot a VM from a fully-resolved {@link BootConfig}. Resolves once the
   * VMM is up; the optional {@link VMRunnerEvents.onExit} fires later if
   * the VMM exits unexpectedly.
   * @throws If a VM with this name is already running on this runner.
   */
  start(config: BootConfig, events?: VMRunnerEvents): Promise<VMRuntime>;
  /** Graceful shutdown via the orchestrator. */
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
