import type { ServerWebSocket } from "bun";
import type { VMManager } from "../vm/manager";
import type { CloudHypervisor } from "../api/ch";
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
  /** CH client used to fetch per-VM counters for running VMs. */
  chApi: CloudHypervisor;
  /** Network helper used to resolve IP addresses from MACs. */
  net: NetworkManager;
  /** Read-side access to per-VM snapshot directories. */
  snapshots: SnapshotStore;
  /** Host-side resource metrics (CPU, memory, load, disk). */
  hostMetrics: HostMetrics;
  /** Refresh interval in milliseconds. Defaults to 500. */
  refreshInterval?: number;
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
  private readonly chApi: CloudHypervisor;
  private readonly net: NetworkManager;
  private readonly snapshots: SnapshotStore;
  private readonly hostMetrics: HostMetrics;
  private readonly refreshInterval: number;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * @param opts - See {@link WsHubOptions}.
   */
  constructor(opts: WsHubOptions) {
    this.vmManager = opts.vmManager;
    this.chApi = opts.chApi;
    this.net = opts.net;
    this.snapshots = opts.snapshots;
    this.hostMetrics = opts.hostMetrics;
    this.refreshInterval = opts.refreshInterval ?? 500;
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
    // Send initial VM + host snapshot so the dashboard renders immediately.
    this.pushVMs().catch(() => { /* swallow — broadcast errors mustn't crash add */ });
    this.pushHost().catch(() => { /* same */ });
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
      vm.snapshots = await this.snapshots.list(vm.name);
    }
    this.send({ type: "vms", data: vms });
  }

  /**
   * Begins the periodic refresh loop. Idempotent.
   */
  startRefreshLoop(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(async () => {
      if (this.clientCount === 0) return; // skip work when nobody listening
      await this.pushVMs();
      await this.pushCounters();
      await this.pushHost();
    }, this.refreshInterval);
  }

  /**
   * Stops the periodic refresh loop. Safe to call multiple times.
   */
  stopRefreshLoop(): void {
    if (!this.refreshTimer) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
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
   * map keyed by VM name. Errors on a single VM don't drop the rest.
   */
  private async pushCounters(): Promise<void> {
    const data: Record<string, unknown> = {};
    for (const vm of this.vmManager.listVMs()) {
      if (vm.state !== "running") continue;
      try { data[vm.name] = await this.chApi.vmCounters(vm.name); } catch { /* skip this VM */ }
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
