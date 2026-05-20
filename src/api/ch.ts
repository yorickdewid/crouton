import path from "path";

/**
 * Cloud Hypervisor REST API client. Each VM has its own Unix domain socket
 * at `<vmDir>/<name>/vmm.sock`; requests are issued over those sockets via
 * Bun's `unix` fetch option.
 */
export interface CloudHypervisor {
  /** Liveness check. Returns `false` on any failure instead of throwing. */
  vmmPing(vmName: string): Promise<boolean>;
  /** Returns the VM's configuration and runtime info as reported by CH. */
  vmInfo(vmName: string): Promise<unknown>;
  /** Issues a graceful shutdown request to the VM's guest OS. */
  vmShutdown(vmName: string): Promise<void>;
  /** Reboots the VM. */
  vmReboot(vmName: string): Promise<void>;
  /** Pauses a running VM. */
  vmPause(vmName: string): Promise<void>;
  /** Resumes a paused VM. */
  vmResume(vmName: string): Promise<void>;
  /** Returns the latest virtio device counters for a VM. */
  vmCounters(vmName: string): Promise<unknown>;
  /** Writes a VM snapshot to a directory on the host filesystem. */
  vmSnapshot(vmName: string, destPath: string): Promise<void>;
}

/**
 * Builds a {@link CloudHypervisor} client bound to a VM directory.
 * @param vmDir - Root directory containing per-VM folders with `vmm.sock` sockets.
 */
export function createCloudHypervisor(vmDir: string): CloudHypervisor {
  const sockPath = (vmName: string): string => path.join(vmDir, vmName, "vmm.sock");

  const request = async <T>(vmName: string, endpoint: string, method = "GET", body?: unknown): Promise<T> => {
    const res = await fetch(`http://localhost/api/v1${endpoint}`, {
      method,
      // @ts-ignore — Bun-specific extension not in RequestInit types
      unix: sockPath(vmName),
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`CloudHypervisor ${method} ${endpoint} → ${res.status}: ${text}`);
    }

    if (res.status === 204) return {} as T;
    return res.json() as Promise<T>;
  };

  return {
    async vmmPing(vmName) {
      try {
        await request(vmName, "/vmm.ping");
        return true;
      } catch {
        return false;
      }
    },

    vmInfo: (vmName) => request(vmName, "/vm.info"),
    vmShutdown: async (vmName) => { await request(vmName, "/vm.shutdown", "PUT"); },
    vmReboot: async (vmName) => { await request(vmName, "/vm.reboot", "PUT"); },
    vmPause: async (vmName) => { await request(vmName, "/vm.pause", "PUT"); },
    vmResume: async (vmName) => { await request(vmName, "/vm.resume", "PUT"); },
    vmCounters: (vmName) => request(vmName, "/vm.counters"),
    vmSnapshot: async (vmName, destPath) => {
      await request(vmName, "/vm.snapshot", "PUT", { destination_url: `file://${destPath}` });
    },
  };
}
