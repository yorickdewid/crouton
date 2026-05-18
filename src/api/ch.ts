import path from "path";
import { config } from "../config";

async function request<T>(sockPath: string, endpoint: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`http://localhost/api/v1${endpoint}`, {
    method,
      // @ts-ignore — Bun-specific extension not in RequestInit types
    unix: sockPath,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CH ${method} ${endpoint} → ${res.status}: ${text}`);
  }

  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

function sockPath(vmName: string): string {
  return path.join(config.vmDir, vmName, "vmm.sock");
}

export async function vmmPing(vmName: string): Promise<boolean> {
  try {
    await request(sockPath(vmName), "/vmm.ping");
    return true;
  } catch {
    return false;
  }
}

export async function vmInfo(vmName: string): Promise<unknown> {
  return request(sockPath(vmName), "/vm.info");
}

export async function vmShutdown(vmName: string): Promise<void> {
  await request(sockPath(vmName), "/vm.shutdown", "PUT");
}

export async function vmReboot(vmName: string): Promise<void> {
  await request(sockPath(vmName), "/vm.reboot", "PUT");
}

export async function vmPause(vmName: string): Promise<void> {
  await request(sockPath(vmName), "/vm.pause", "PUT");
}

export async function vmResume(vmName: string): Promise<void> {
  await request(sockPath(vmName), "/vm.resume", "PUT");
}

export async function vmCounters(vmName: string): Promise<unknown> {
  return request(sockPath(vmName), "/vm.counters");
}

export async function vmSnapshot(vmName: string, destPath: string): Promise<void> {
  await request(sockPath(vmName), "/vm.snapshot", "PUT", { destination_url: `file://${destPath}` });
}
