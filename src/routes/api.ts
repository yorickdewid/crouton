import path from "path";
import { readdir, mkdir } from "fs/promises";
import type { VMManager } from "../vm/manager";
import type { CloudHypervisor } from "../api/ch";
import type { VMProvisioner, CreateVMOptions } from "../vm/create";
import type { VMConfigStore } from "../vm/persist";
import type { NetworkManager } from "../net/manager";
import type { WsHub } from "../server/ws";

const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_MB = 2048;

/**
 * Constructor dependencies for {@link ApiRouter}.
 */
export interface ApiRouterOptions {
  vmManager: VMManager;
  chApi: CloudHypervisor;
  provisioner: VMProvisioner;
  configStore: VMConfigStore;
  net: NetworkManager;
  wsHub: WsHub;
  vmDir: string;
}

/**
 * Dispatcher for `/api/...` HTTP routes. Returns `null` for unmatched paths
 * so the outer Bun.serve handler can fall through to static UI delivery.
 */
export class ApiRouter {
  private readonly vmManager: VMManager;
  private readonly chApi: CloudHypervisor;
  private readonly provisioner: VMProvisioner;
  private readonly configStore: VMConfigStore;
  private readonly net: NetworkManager;
  private readonly wsHub: WsHub;
  private readonly vmDir: string;

  /**
   * @param opts - See {@link ApiRouterOptions}.
   */
  constructor(opts: ApiRouterOptions) {
    this.vmManager = opts.vmManager;
    this.chApi = opts.chApi;
    this.provisioner = opts.provisioner;
    this.configStore = opts.configStore;
    this.net = opts.net;
    this.wsHub = opts.wsHub;
    this.vmDir = opts.vmDir;
  }

  /**
   * Top-level route entry. Returns `null` when the path isn't matched.
   */
  async handle(req: Request, pathname: string): Promise<Response | null> {
    if (pathname === "/api/vms") {
      if (req.method === "GET")  return this.listVMs();
      if (req.method === "POST") return this.createVM(req);
    }

    if (pathname === "/api/images" && req.method === "GET") {
      return this.listImages();
    }

    const vmMatch = pathname.match(/^\/api\/vms\/([^/]+)$/);
    if (vmMatch) {
      const name = vmMatch[1];
      if (req.method === "GET")    return this.getVM(name);
      if (req.method === "DELETE") return this.deleteVM(name);
    }

    const startMatch = pathname.match(/^\/api\/vms\/([^/]+)\/start$/);
    if (startMatch && req.method === "POST") return this.startVM(startMatch[1]);

    const actionMatch = pathname.match(/^\/api\/vms\/([^/]+)\/(reboot|pause|resume|shutdown)$/);
    if (actionMatch && req.method === "PUT") {
      return this.runAction(actionMatch[1], actionMatch[2] as ChAction);
    }

    const countersMatch = pathname.match(/^\/api\/vms\/([^/]+)\/counters$/);
    if (countersMatch && req.method === "GET") return this.getCounters(countersMatch[1]);

    const snapshotsMatch = pathname.match(/^\/api\/vms\/([^/]+)\/snapshots$/);
    if (snapshotsMatch) {
      const name = snapshotsMatch[1];
      if (req.method === "GET")  return this.listSnapshots(name);
      if (req.method === "POST") return this.takeSnapshot(name);
    }

    return null;
  }

  // ── route handlers ─────────────────────────────────────────────────────

  /** `GET /api/vms` */
  private listVMs(): Response {
    return this.json(this.vmManager.listVMs());
  }

  /** `POST /api/vms` — provision + start. */
  private async createVM(req: Request): Promise<Response> {
    try {
      const opts = (await req.json()) as CreateVMOptions;
      const vmConfig = await this.provisioner.provision(opts);
      const instance = await this.vmManager.startVM(vmConfig);
      this.wsHub.pushVMs();
      return this.json(instance, 201);
    } catch (e) {
      return this.error(e);
    }
  }

  /** `GET /api/images` */
  private async listImages(): Promise<Response> {
    return this.json(await this.provisioner.listImages());
  }

  /** `GET /api/vms/:name` */
  private async getVM(name: string): Promise<Response> {
    const vm = this.vmManager.getVM(name);
    if (!vm) return this.json({ error: "not found" }, 404);
    const ip = await this.net.macToIp(vm.mac);
    if (ip) vm.ip = ip;
    try {
      const info = await this.chApi.vmInfo(name);
      return this.json({ ...vm, chInfo: info });
    } catch {
      return this.json(vm);
    }
  }

  /** `DELETE /api/vms/:name` — wipe the VM directory (must be stopped). */
  private async deleteVM(name: string): Promise<Response> {
    try {
      await this.vmManager.deleteVM(name);
      this.wsHub.pushVMs();
      return this.ok();
    } catch (e) {
      return this.error(e);
    }
  }

  /** `POST /api/vms/:name/start` */
  private async startVM(name: string): Promise<Response> {
    const vm = this.vmManager.getVM(name);
    if (!vm) return this.json({ error: "not found" }, 404);
    if (vm.state === "running") return this.json({ error: "already running" }, 400);

    try {
      let cfg = await this.configStore.read(name);
      if (!cfg) {
        cfg = {
          ...vm.config,
          name,
          cpus: vm.config.cpus ?? DEFAULT_CPUS,
          memoryMb: vm.config.memoryMb ?? DEFAULT_MEMORY_MB,
        };
        await this.configStore.write(cfg);
      }
      const instance = await this.vmManager.startVM(cfg);
      this.wsHub.pushVMs();
      return this.json(instance);
    } catch (e) {
      return this.error(e);
    }
  }

  /** `PUT /api/vms/:name/{reboot|pause|resume|shutdown}` */
  private async runAction(name: string, action: ChAction): Promise<Response> {
    try {
      switch (action) {
        case "reboot":   await this.chApi.vmReboot(name); break;
        case "pause":    await this.chApi.vmPause(name); break;
        case "resume":   await this.chApi.vmResume(name); break;
        case "shutdown":
          try { await this.chApi.vmShutdown(name); }
          catch { await this.vmManager.stopVM(name); }
          break;
      }
      this.wsHub.pushVMs();
      return this.ok();
    } catch (e) {
      return this.error(e);
    }
  }

  /** `GET /api/vms/:name/counters` */
  private async getCounters(name: string): Promise<Response> {
    try {
      const data = await this.chApi.vmCounters(name);
      return this.json({ ts: Date.now(), counters: data });
    } catch (e) {
      return this.error(e);
    }
  }

  /** `GET /api/vms/:name/snapshots` */
  private async listSnapshots(name: string): Promise<Response> {
    const dir = path.join(this.vmDir, name, "snapshots");
    const entries = await readdir(dir).catch(() => [] as string[]);
    return this.json(entries.sort().reverse());
  }

  /** `POST /api/vms/:name/snapshots` */
  private async takeSnapshot(name: string): Promise<Response> {
    const vm = this.vmManager.getVM(name);
    if (!vm) return this.json({ error: "not found" }, 404);
    if (vm.state !== "running") return this.json({ error: "VM must be running to snapshot" }, 400);
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
      const snapDir = path.join(this.vmDir, name, "snapshots", ts);
      await mkdir(snapDir, { recursive: true });
      await this.chApi.vmSnapshot(name, snapDir);
      return this.json({ name: ts });
    } catch (e) {
      return this.error(e);
    }
  }

  // ── response helpers ───────────────────────────────────────────────────

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  private ok(): Response {
    return this.json({ ok: true });
  }

  private error(e: unknown, status = 400): Response {
    return this.json({ error: (e as Error).message }, status);
  }
}

type ChAction = "reboot" | "pause" | "resume" | "shutdown";
