/** Lifecycle states for a managed VM instance. */
export type VMState = "stopped" | "booting" | "running" | "stopping" | "error";

/** Boot method detected or selected for the VM. */
export type BootMode = "direct" | "uefi";

/** Static configuration used to define and launch a VM. */
export interface VMConfig {
  /**
   * Stable identifier. Equal to the on-disk directory name under `vmDir`.
   * Generated as a ULID when the VM is provisioned; never changes. Used
   * everywhere internally — MAC derivation, socket paths, API params,
   * WS payload keys, croutond's slot key on the wire.
   */
  id: string;
  /**
   * User-facing display name. Mutable, free-form, not required to be
   * unique across the fleet. Renaming a VM updates this field only —
   * the directory, MAC, IP, and croutond slot are unaffected.
   */
  label: string;
  /** Number of virtual CPUs to allocate. */
  cpus?: number;
  /** RAM allocation in megabytes. */
  memoryMb?: number;
  /** Boot strategy for the VM. */
  bootMode: BootMode;
  /** Optional kernel image path for direct boot mode. */
  kernelPath?: string;
  /** Optional initrd image path for direct boot mode. */
  initrdPath?: string;
  /** Attached disk image paths. */
  disks: string[];
  /** If `true`, Crouton starts this VM automatically on its own startup. */
  autostart?: boolean;
  /**
   * Free-form labels for filtering and grouping. Normalised on persist:
   * lowercased, trimmed, deduplicated, sorted.
   */
  tags?: string[];
}

/** Runtime metadata for a VM currently known by the manager. */
export interface VMInstance {
  /** Stable identifier (matches {@link VMConfig.id}). */
  id: string;
  /** User-facing display name (matches {@link VMConfig.label}). */
  label: string;
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
  /** Snapshot names found on disk, newest first. Populated by the broadcast layer. */
  snapshots?: string[];
}
