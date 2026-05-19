import path from "path";
import { config } from "../config";

/**
 * Cloud Hypervisor API client bound to VM socket paths under the configured VM directory.
 */
export class CloudHypervisor {
  /**
   * @param vmDir Root directory containing per-VM folders with vmm.sock sockets.
   */
  constructor(private readonly vmDir: string = config.vmDir) { }

  /**
   * Sends an HTTP request over a Unix domain socket to the Cloud Hypervisor API.
   */
  private async request<T>(sockPath: string, endpoint: string, method = "GET", body?: unknown): Promise<T> {
    const res = await fetch(`http://localhost/api/v1${endpoint}`, {
      method,
      // @ts-ignore — Bun-specific extension not in RequestInit types
      unix: sockPath,
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
   * Resolves the Cloud Hypervisor socket path for a VM name.
   */
  private sockPath(vmName: string): string {
    return path.join(this.vmDir, vmName, "vmm.sock");
  }

  /**
   * Checks whether the VMM is reachable for a given VM.
   */
  async vmmPing(vmName: string): Promise<boolean> {
    try {
      await this.request(this.sockPath(vmName), "/vmm.ping");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retrieves VM configuration and runtime metadata.
   */
  async vmInfo(vmName: string): Promise<unknown> {
    return this.request(this.sockPath(vmName), "/vm.info");
  }

  /**
   * Requests a graceful VM shutdown.
   */
  async vmShutdown(vmName: string): Promise<void> {
    await this.request(this.sockPath(vmName), "/vm.shutdown", "PUT");
  }

  /**
   * Requests a VM reboot.
   */
  async vmReboot(vmName: string): Promise<void> {
    await this.request(this.sockPath(vmName), "/vm.reboot", "PUT");
  }

  /**
   * Pauses a running VM.
   */
  async vmPause(vmName: string): Promise<void> {
    await this.request(this.sockPath(vmName), "/vm.pause", "PUT");
  }

  /**
   * Resumes a paused VM.
   */
  async vmResume(vmName: string): Promise<void> {
    await this.request(this.sockPath(vmName), "/vm.resume", "PUT");
  }

  /**
   * Retrieves runtime counters for a VM.
   */
  async vmCounters(vmName: string): Promise<unknown> {
    return this.request(this.sockPath(vmName), "/vm.counters");
  }

  /**
   * Creates a VM snapshot at the provided destination path.
   */
  async vmSnapshot(vmName: string, destPath: string): Promise<void> {
    await this.request(this.sockPath(vmName), "/vm.snapshot", "PUT", { destination_url: `file://${destPath}` });
  }
}

export const chApi = new CloudHypervisor();

export async function vmmPing(vmName: string): Promise<boolean> {
  return chApi.vmmPing(vmName);
}

export async function vmInfo(vmName: string): Promise<unknown> {
  return chApi.vmInfo(vmName);
}

export async function vmShutdown(vmName: string): Promise<void> {
  return chApi.vmShutdown(vmName);
}

export async function vmReboot(vmName: string): Promise<void> {
  return chApi.vmReboot(vmName);
}

export async function vmPause(vmName: string): Promise<void> {
  return chApi.vmPause(vmName);
}

export async function vmResume(vmName: string): Promise<void> {
  return chApi.vmResume(vmName);
}

export async function vmCounters(vmName: string): Promise<unknown> {
  return chApi.vmCounters(vmName);
}

export async function vmSnapshot(vmName: string, destPath: string): Promise<void> {
  return chApi.vmSnapshot(vmName, destPath);
}
