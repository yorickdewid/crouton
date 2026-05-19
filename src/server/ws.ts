import type { ServerWebSocket } from "bun";
import { listVMs } from "../vm/manager";
import { vmCounters } from "../api/ch";
import { macToIp } from "../net/ip";

type Client = ServerWebSocket<unknown>;

/**
 * Manages connected WebSocket clients and periodic VM state broadcasts.
 */
export class WsHub {
  private readonly clients = new Set<Client>();
  private refreshTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * Registers a client and immediately sends a VM snapshot.
   */
  addClient(ws: Client): void {
    this.clients.add(ws);
    // Send initial snapshot immediately so the new client doesn't wait for the next tick.
    this.pushVMs().catch(() => { });
  }

  /**
   * Unregisters a disconnected client.
   */
  removeClient(ws: Client): void {
    this.clients.delete(ws);
  }

  /**
   * Broadcasts a JSON-serializable message to all connected clients.
   */
  private send(msg: unknown): void {
    if (this.clients.size === 0) return;
    const text = JSON.stringify(msg);
    for (const ws of this.clients) {
      try { ws.send(text); } catch { }
    }
  }

  /**
   * Pushes the current VM list to clients, enriching running VMs with discovered IP addresses.
   */
  async pushVMs(): Promise<void> {
    const vms = listVMs();
    for (const vm of vms) {
      if (vm.state === "running") {
        const ip = await macToIp(vm.mac);
        if (ip) vm.ip = ip;
      }
    }
    this.send({ type: "vms", data: vms });
  }

  /**
   * Pushes per-VM runtime counters for running VMs.
   */
  private async pushCounters(): Promise<void> {
    const data: Record<string, unknown> = {};
    for (const vm of listVMs()) {
      if (vm.state !== "running") continue;
      try { data[vm.name] = await vmCounters(vm.name); } catch { }
    }
    this.send({ type: "counters", ts: Date.now(), data });
  }

  /**
   * Starts a single refresh loop that periodically pushes VM snapshots and counters.
   */
  startRefreshLoop(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(async () => {
      if (this.clients.size === 0) return; // skip work when nobody listening
      await this.pushVMs();
      await this.pushCounters();
    }, 500);
  }
}
