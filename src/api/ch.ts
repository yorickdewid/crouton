import path from "path";
import { config } from "../config";

export class CloudHypervisor {
  constructor(private readonly vmDir: string = config.vmDir) { }

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

  private sockPath(vmName: string): string {
    return path.join(this.vmDir, vmName, "vmm.sock");
  }

  async vmmPing(vmName: string): Promise<boolean> {
    try {
      await this.request(this.sockPath(vmName), "/vmm.ping");
      return true;
    } catch {
      return false;
    }
  }

  async vmInfo(vmName: string): Promise<unknown> {
    return this.request(this.sockPath(vmName), "/vm.info");
  }

  async vmShutdown(vmName: string): Promise<void> {
    await this.request(this.sockPath(vmName), "/vm.shutdown", "PUT");
  }

  async vmReboot(vmName: string): Promise<void> {
    await this.request(this.sockPath(vmName), "/vm.reboot", "PUT");
  }

  async vmPause(vmName: string): Promise<void> {
    await this.request(this.sockPath(vmName), "/vm.pause", "PUT");
  }

  async vmResume(vmName: string): Promise<void> {
    await this.request(this.sockPath(vmName), "/vm.resume", "PUT");
  }

  async vmCounters(vmName: string): Promise<unknown> {
    return this.request(this.sockPath(vmName), "/vm.counters");
  }

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
