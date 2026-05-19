import path from "path";

/**
 * Cloud Hypervisor REST API client. Each VM has its own Unix domain socket
 * at `<vmDir>/<name>/vmm.sock`; requests are issued over those sockets via
 * Bun's `unix` fetch option.
 */
export class CloudHypervisor {
  /**
   * @param vmDir - Root directory containing per-VM folders with `vmm.sock` sockets.
   */
  constructor(private readonly vmDir: string) { }

  /**
   * Liveness check for a VMM. Returns `false` instead of throwing on
   * connection errors so callers can use it as a boolean health probe.
   * @param vmName - VM name.
   */
  async vmmPing(vmName: string): Promise<boolean> {
    try {
      await this.request(vmName, "/vmm.ping");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns the VM's configuration and runtime info as reported by CH.
   * @param vmName - VM name.
   */
  async vmInfo(vmName: string): Promise<unknown> {
    return this.request(vmName, "/vm.info");
  }

  /**
   * Issues a graceful shutdown request to the VM's guest OS.
   * @param vmName - VM name.
   */
  async vmShutdown(vmName: string): Promise<void> {
    await this.request(vmName, "/vm.shutdown", "PUT");
  }

  /**
   * Reboots the VM.
   * @param vmName - VM name.
   */
  async vmReboot(vmName: string): Promise<void> {
    await this.request(vmName, "/vm.reboot", "PUT");
  }

  /**
   * Pauses a running VM.
   * @param vmName - VM name.
   */
  async vmPause(vmName: string): Promise<void> {
    await this.request(vmName, "/vm.pause", "PUT");
  }

  /**
   * Resumes a paused VM.
   * @param vmName - VM name.
   */
  async vmResume(vmName: string): Promise<void> {
    await this.request(vmName, "/vm.resume", "PUT");
  }

  /**
   * Returns the latest virtio device counters (`_diskN`, `_netN`, …) for a VM.
   * @param vmName - VM name.
   */
  async vmCounters(vmName: string): Promise<unknown> {
    return this.request(vmName, "/vm.counters");
  }

  /**
   * Asks CH to write a VM snapshot to a directory on the host filesystem.
   * @param vmName - VM name.
   * @param destPath - Absolute path where the snapshot directory will be written.
   */
  async vmSnapshot(vmName: string, destPath: string): Promise<void> {
    await this.request(vmName, "/vm.snapshot", "PUT", { destination_url: `file://${destPath}` });
  }

  /**
   * Issues a JSON HTTP request to a VM's Unix socket.
   */
  private async request<T>(vmName: string, endpoint: string, method = "GET", body?: unknown): Promise<T> {
    const res = await fetch(`http://localhost/api/v1${endpoint}`, {
      method,
      // @ts-ignore — Bun-specific extension not in RequestInit types
      unix: this.sockPath(vmName),
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`CloudHypervisor ${method} ${endpoint} → ${res.status}: ${text}`);
    }

    if (res.status === 204) return {} as T;
    return res.json() as Promise<T>;
  }

  /**
   * Resolves the socket path for a VM.
   */
  private sockPath(vmName: string): string {
    return path.join(this.vmDir, vmName, "vmm.sock");
  }
}
