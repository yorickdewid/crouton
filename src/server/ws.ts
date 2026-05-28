import type { ServerWebSocket } from "bun";
import type { VMManager } from "../vm/manager";
import type { NetworkManager } from "../net/manager";
import type { SnapshotStore } from "../vm/snapshots";
import type { HostMetrics } from "../host/metrics";

type Client = ServerWebSocket<unknown>;

/**
 * Constructor dependencies for {@link WsHub}.
 */
export interface WsHubOptions {
  /** Source of VM state. */
  vmManager: VMManager;
  /** Network helper used to resolve IP addresses from MACs. */
  net: NetworkManager;
  /** Read-side access to per-VM snapshot directories. */
  snapshots: SnapshotStore;
  /** Host-side resource metrics (CPU, memory, load, disk). */
  hostMetrics: HostMetrics;
  /** Refresh interval in milliseconds. Defaults to 500. */
  refreshInterval?: number;
  /**
   * Optional health probe — typically a `GET /health` against
   * croutond. Pushed to clients as `{type:"health", data:{ok,...}}`.
   * Returning a parsed body is treated as healthy; throwing is treated
   * as unreachable.
   */
  healthProbe?: () => Promise<unknown>;
  /** How often the health probe runs (ms). Defaults to 4000. */
  healthIntervalMs?: number;
}

/**
 * Push channel for the dashboard. Tracks connected WebSocket clients and
 * broadcasts periodic VM-state and counter snapshots; also exposes
 * {@link pushVMs} for callers (e.g. action routes) that want to send an
 * update immediately rather than waiting for the next tick.
 */
export class WsHub {
  private readonly clients = new Set<Client>();
  private readonly vmManager: VMManager;
  private readonly net: NetworkManager;
  private readonly snapshots: SnapshotStore;
  private readonly hostMetrics: HostMetrics;
  private readonly refreshInterval: number;
  private readonly healthProbe: (() => Promise<unknown>) | undefined;
  private readonly healthIntervalMs: number;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  /** Most recent health snapshot — sent to new clients on connect. */
  private lastHealth: unknown = { ok: false };

  /**
   * @param opts - See {@link WsHubOptions}.
   */
  constructor(opts: WsHubOptions) {
    this.vmManager = opts.vmManager;
    this.net = opts.net;
    this.snapshots = opts.snapshots;
    this.hostMetrics = opts.hostMetrics;
    this.refreshInterval = opts.refreshInterval ?? 500;
    this.healthProbe = opts.healthProbe;
    this.healthIntervalMs = opts.healthIntervalMs ?? 4000;
  }

  /**
   * Number of currently connected clients.
   */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Registers a new client and pushes an initial VM snapshot so the
   * dashboard doesn't have to wait for the next tick on first connect.
   */
  addClient(ws: Client): void {
    this.clients.add(ws);
    // Send initial VM + host + last-known-health snapshot so the
    // dashboard renders immediately without waiting for the next tick.
    this.pushVMs().catch(() => { /* swallow — broadcast errors mustn't crash add */ });
    this.pushHost().catch(() => { /* same */ });
    try { ws.send(JSON.stringify({ type: "health", data: this.lastHealth })); }
    catch { /* dropped send becomes a disconnect naturally */ }
  }

  /**
   * Unregisters a disconnected client.
   */
  removeClient(ws: Client): void {
    this.clients.delete(ws);
  }

  /**
   * Pushes the current VM list to all clients, enriching running VMs with
   * their currently-observed IP.
   */
  async pushVMs(): Promise<void> {
    const vms = this.vmManager.listVMs();
    for (const vm of vms) {
      if (vm.state === "running") {
        const ip = await this.net.macToIp(vm.mac);
        if (ip) vm.ip = ip;
      }
      vm.snapshots = await this.snapshots.list(vm.id);
    }
    this.send({ type: "vms", data: vms });
  }

  /**
   * Begins the periodic refresh loop. Idempotent.
   */
  startRefreshLoop(): void {
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(async () => {
        if (this.clientCount === 0) return; // skip work when nobody listening
        await this.pushVMs();
        await this.pushCounters();
        await this.pushHost();
      }, this.refreshInterval);
    }
    if (this.healthProbe && !this.healthTimer) {
      // Run the probe once on startup so the pill renders without
      // waiting for the first tick.
      this.pushHealth();
      this.healthTimer = setInterval(() => { this.pushHealth(); }, this.healthIntervalMs);
    }
  }

  /**
   * Stops both timers. Safe to call multiple times.
   */
  stopRefreshLoop(): void {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = undefined; }
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = undefined; }
  }

  /**
   * Runs the configured health probe and broadcasts the result. Treats
   * any thrown error / timeout as `{ok: false}`. Keeps the most recent
   * snapshot in {@link lastHealth} so new clients get it immediately.
   */
  private async pushHealth(): Promise<void> {
    if (!this.healthProbe) return;
    let payload: Record<string, unknown>;
    try {
      const data = await this.healthProbe();
      payload = { ok: true, ...(data as Record<string, unknown>) };
    } catch (e) {
      payload = { ok: false, error: (e as Error).message };
    }
    this.lastHealth = payload;
    this.send({ type: "health", data: payload });
  }

  /**
   * Collects a host metrics snapshot and broadcasts it.
   */
  private async pushHost(): Promise<void> {
    try {
      const data = await this.hostMetrics.collect();
      this.send({ type: "host", data });
    } catch {
      // collection failed (e.g. /proc unavailable); skip this tick
    }
  }

  /**
   * Polls counters for every running VM and broadcasts them as a single
   * map keyed by VM id. Errors on a single VM don't drop the rest.
   */
  private async pushCounters(): Promise<void> {
    const data: Record<string, unknown> = {};
    for (const vm of this.vmManager.listVMs()) {
      if (vm.state !== "running") continue;
      try { data[vm.id] = await this.vmManager.counters(vm.id); } catch { /* skip this VM */ }
    }
    this.send({ type: "counters", ts: Date.now(), data });
  }

  /**
   * Serialises a message and sends it to every connected client.
   */
  private send(msg: unknown): void {
    if (this.clientCount === 0) return;
    const text = JSON.stringify(msg);
    for (const ws of this.clients) {
      try { ws.send(text); } catch { /* dropped sends become disconnects naturally */ }
    }
  }
}
