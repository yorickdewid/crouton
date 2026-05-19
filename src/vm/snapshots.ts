import path from "path";
import { readdir } from "fs/promises";

/**
 * Read access to the per-VM snapshot directory (`<vmDir>/<name>/snapshots/`).
 * Snapshot creation lives on the Cloud Hypervisor client; this only enumerates
 * what's already on disk.
 */
export interface SnapshotStore {
  /**
   * Lists snapshot names for a VM, newest first. Returns an empty array if
   * the VM has no snapshots directory yet.
   */
  list(vmName: string): Promise<string[]>;
}

/**
 * Builds a {@link SnapshotStore}.
 * @param vmDir - Root directory containing per-VM folders.
 */
export function createSnapshotStore(vmDir: string): SnapshotStore {
  return {
    async list(vmName) {
      const dir = path.join(vmDir, vmName, "snapshots");
      const entries = await readdir(dir).catch(() => [] as string[]);
      return entries.sort().reverse();
    },
  };
}
