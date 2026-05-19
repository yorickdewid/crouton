import type { ServerWebSocket } from "bun";
import { listVMs } from "../vm/manager";
import { vmCounters } from "../api/ch";
import { macToIp } from "../net/ip";

type Client = ServerWebSocket<unknown>;

const clients = new Set<Client>();
let refreshTimer: ReturnType<typeof setInterval> | undefined;

export function addClient(ws: Client): void {
  clients.add(ws);
  // Send initial snapshot immediately so the new client doesn't wait for the next tick.
  pushVMs().catch(() => {});
}

export function removeClient(ws: Client): void {
  clients.delete(ws);
}

function send(msg: unknown): void {
  if (clients.size === 0) return;
  const text = JSON.stringify(msg);
  for (const ws of clients) {
    try { ws.send(text); } catch {}
  }
}

export async function pushVMs(): Promise<void> {
  const vms = listVMs();
  for (const vm of vms) {
    if (vm.state === "running") {
      const ip = await macToIp(vm.mac);
      if (ip) vm.ip = ip;
    }
  }
  send({ type: "vms", data: vms });
}

async function pushCounters(): Promise<void> {
  const data: Record<string, unknown> = {};
  for (const vm of listVMs()) {
    if (vm.state !== "running") continue;
    try { data[vm.name] = await vmCounters(vm.name); } catch {}
  }
  send({ type: "counters", ts: Date.now(), data });
}

export function startRefreshLoop(): void {
  if (refreshTimer) return;
  refreshTimer = setInterval(async () => {
    if (clients.size === 0) return; // skip work when nobody listening
    await pushVMs();
    await pushCounters();
  }, 2000);
}
