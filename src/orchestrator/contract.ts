/**
 * Wire contract between Crouton (the Bun UI/API process) and croutond
 * (the Rust orchestrator daemon that owns the CH VMM pool).
 *
 * All endpoints are HTTP/JSON over TCP. The same wire serves localhost
 * today and remote orchestrators in a future multi-host setup. See
 * `docs/architecture/orchestrator.md` for the design rationale.
 *
 * This file is the single source of truth for the wire shapes. The Rust
 * side mirrors these types; Bun uses them directly when building the
 * `RemoteVMRunner` client.
 *
 * Naming convention: request bodies end in `Request`, response bodies in
 * `Response`. Shared types are bare. Paths and timestamps are strings.
 */

/* ─── shared types ────────────────────────────────────────────────── */

/**
 * How the orchestrator should boot the VM.
 *
 * - `direct`: load `kernelPath` + `initrdPath` and use `cmdline`.
 * - `uefi`: load `firmwarePath` and let the disk's bootloader take over.
 */
export type BootMode = "direct" | "uefi";

/**
 * VM lifecycle states as reported by croutond. Note that croutond is
 * stateless about *configuration* — these values describe live process
 * state, not whether the VM "exists" in any larger sense.
 */
export type RuntimeState = "booting" | "running" | "stopping" | "stopped" | "error";

/**
 * The boot configuration croutond needs to spawn a VM. Crouton resolves
 * every path to an absolute string before sending; croutond treats them
 * as opaque inputs to Cloud Hypervisor.
 */
export interface BootConfig {
  /** Stable VM identifier. Must be unique across all VMs on this host. */
  name: string;
  /** Number of vCPUs. */
  cpus: number;
  /** RAM in megabytes. */
  memoryMb: number;
  /** Boot strategy; controls which of the *Path fields are required. */
  bootMode: BootMode;
  /** Absolute paths to disk images, attached in order. */
  disks: string[];
  /** Absolute kernel path. Required when `bootMode === "direct"`. */
  kernelPath?: string;
  /** Absolute initrd path. Required when `bootMode === "direct"`. */
  initrdPath?: string;
  /** Kernel command-line for direct boot. */
  cmdline?: string;
  /** Absolute firmware path. Required when `bootMode === "uefi"`. */
  firmwarePath?: string;
  /**
   * Optional snapshot directory to restore from. If set, croutond
   * skips disk attach + boot and instead calls CH's restore flow.
   */
  snapshotPath?: string;
}

/**
 * Runtime metadata for a VM that croutond is currently managing.
 */
export interface VMRuntime {
  /** Same name passed in {@link BootConfig.name}. */
  name: string;
  /** MAC assigned by croutond — derived from the name. */
  mac: string;
  /** TAP interface attached to the host bridge for this VM. */
  tap: string;
  /** Host PID of the CH process backing this VM. */
  pid: number;
  /** Current state. */
  state: RuntimeState;
  /** ISO-8601 timestamp of when croutond booted this VM. */
  startedAt: string;
}

/* ─── responses ───────────────────────────────────────────────────── */

/**
 * `GET /health` response.
 */
export interface HealthResponse {
  /** Always present, identifies the daemon. */
  service: "croutond";
  /** Semver-ish build/version string. */
  version: string;
  /** Total pool slots currently allocated (idle + busy). */
  poolSize: number;
  /** Slots currently holding a running VM. */
  poolInUse: number;
  /** Idle, ready slots. */
  poolIdle: number;
}

/**
 * `GET /vms` response.
 */
export interface ListVMsResponse {
  vms: VMRuntime[];
}

/**
 * Standard error body returned with any non-2xx status. Field-level
 * validation errors include `field`.
 */
export interface ErrorResponse {
  error: string;
  field?: string;
}

/* ─── endpoint shapes ─────────────────────────────────────────────── */

/**
 * Map of every endpoint to its request and response types. Useful for
 * defining a typed client (`fetch` wrapper) without re-stating shapes.
 */
export interface OrchestratorEndpoints {
  "GET /health": {
    request: never;
    response: HealthResponse;
  };
  "GET /vms": {
    request: never;
    response: ListVMsResponse;
  };
  "GET /vms/:name": {
    request: never;
    response: VMRuntime;
  };
  "POST /vms": {
    request: BootConfig;
    response: VMRuntime;
  };
  "DELETE /vms/:name": {
    request: never;
    response: { ok: true };
  };
  "PUT /vms/:name/reboot": {
    request: never;
    response: { ok: true };
  };
  "PUT /vms/:name/pause": {
    request: never;
    response: { ok: true };
  };
  "PUT /vms/:name/resume": {
    request: never;
    response: { ok: true };
  };
  "PUT /vms/:name/snapshot": {
    request: { destPath: string };
    response: { ok: true };
  };
  "GET /vms/:name/counters": {
    /** Returns whatever CH's `/vm.counters` returns; croutond proxies as-is. */
    request: never;
    response: unknown;
  };
}

// The Bun-side runner abstraction (`VMRunner`) lives in `src/vm/runner.ts`.
// This file is for wire types only — anything `croutond` consumes or
// produces over HTTP.
