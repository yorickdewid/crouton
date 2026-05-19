/** Lifecycle states for a managed VM instance. */
export type VMState = "stopped" | "booting" | "running" | "stopping" | "error";

/** Boot method detected or selected for the VM. */
export type BootMode = "direct" | "uefi" | "unknown";

/** Static configuration used to define and launch a VM. */
export interface VMConfig {
  /** Human-readable VM identifier. */
  name: string;
  /** Number of virtual CPUs to allocate. */
  cpus?: number;
  /** RAM allocation in megabytes. */
  memoryMb?: number;
  /** Boot strategy for the VM. */
  bootMode: BootMode;
  /** Optional kernel image path for direct boot mode. */
  kernelPath?: string;
  /** Attached disk image paths. */
  disks: string[];
}

/** Runtime metadata for a VM currently known by the manager. */
export interface VMInstance {
  /** VM identifier. */
  name: string;
  /** Current lifecycle state. */
  state: VMState;
  /** Process ID of the active VM process, when running. */
  pid?: number;
  /** TAP interface name used for VM networking. */
  tapInterface?: string;
  /** Assigned MAC address. */
  mac: string;
  /** Discovered guest IP address, if known. */
  ip?: string;
  /** Timestamp for when the VM last entered running state. */
  startedAt?: Date;
  /** Launch configuration associated with this VM instance. */
  config: VMConfig;
}
