import path from "path";
import { readdir, mkdir } from "fs/promises";
import { CreateVMOptionsSchema, type VMProvisioner } from "../vm/create";
import type { VMManager } from "../vm/manager";
import type { CloudHypervisor } from "../api/ch";
import type { VMConfigStore } from "../vm/persist";
import type { NetworkManager } from "../net/manager";
import type { WsHub } from "../server/ws";

const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_MB = 2048;

/**
 * Dependencies required to build the `/api/...` route handler.
 */
export interface ApiRouterDeps {
  vmManager: VMManager;
  chApi: CloudHypervisor;
  provisioner: VMProvisioner;
  configStore: VMConfigStore;
  net: NetworkManager;
  wsHub: WsHub;
  vmDir: string;
}

/**
 * Handler signature returned by {@link createApiRouter}. Returns `null` for
 * unmatched paths so the outer server can fall through to static UI delivery.
 */
export type ApiHandler = (req: Request, pathname: string) => Promise<Response | null>;

type ChAction = "reboot" | "pause" | "resume" | "shutdown";

/**
 * Builds the `/api/...` dispatcher. All handlers close over `deps`, so the
 * returned function is just a regular route table — no class needed.
 */
export function createApiRouter(deps: ApiRouterDeps): ApiHandler {
  const { vmManager, chApi, provisioner, configStore, net, wsHub, vmDir } = deps;

  // ── response helpers ───────────────────────────────────────────────────

  const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const ok = (): Response => json({ ok: true });
  const error = (e: unknown, status = 400): Response =>
    json({ error: (e as Error).message }, status);

  // ── route handlers ─────────────────────────────────────────────────────

  /** `GET /api/vms` */
  const listVMs = (): Response => json(vmManager.listVMs());

  /** `POST /api/vms` — provision + start. */
  const createVM = async (req: Request): Promise<Response> => {
    let raw: unknown;
    try { raw = await req.json(); }
    catch { return json({ error: "request body is not valid JSON" }, 400); }

    const parsed = CreateVMOptionsSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue.path.length ? issue.path.join(".") : "body";
      return json({ error: `${where}: ${issue.message}` }, 400);
    }

    try {
      const vmConfig = await provisioner.provision(parsed.data);
      const instance = await vmManager.startVM(vmConfig);
      wsHub.pushVMs();
      return json(instance, 201);
    } catch (e) {
      return error(e);
    }
  };

  /** `GET /api/images` */
  const listImages = async (): Promise<Response> => json(await provisioner.listImages());

  /** `GET /api/vms/:name` */
  const getVM = async (name: string): Promise<Response> => {
    const vm = vmManager.getVM(name);
    if (!vm) return json({ error: "not found" }, 404);
    const ip = await net.macToIp(vm.mac);
    if (ip) vm.ip = ip;
    try {
      const info = await chApi.vmInfo(name);
      return json({ ...vm, chInfo: info });
    } catch {
      return json(vm);
    }
  };

  /** `DELETE /api/vms/:name` — wipe the VM directory (must be stopped). */
  const deleteVM = async (name: string): Promise<Response> => {
    try {
      await vmManager.deleteVM(name);
      wsHub.pushVMs();
      return ok();
    } catch (e) {
      return error(e);
    }
  };

  /** `POST /api/vms/:name/start` */
  const startVM = async (name: string): Promise<Response> => {
    const vm = vmManager.getVM(name);
    if (!vm) return json({ error: "not found" }, 404);
    if (vm.state === "running") return json({ error: "already running" }, 400);

    try {
      let cfg = await configStore.read(name);
      if (!cfg) {
        cfg = {
          ...vm.config,
          name,
          cpus: vm.config.cpus ?? DEFAULT_CPUS,
          memoryMb: vm.config.memoryMb ?? DEFAULT_MEMORY_MB,
        };
        await configStore.write(cfg);
      }
      const instance = await vmManager.startVM(cfg);
      wsHub.pushVMs();
      return json(instance);
    } catch (e) {
      return error(e);
    }
  };

  /** `PUT /api/vms/:name/{reboot|pause|resume|shutdown}` */
  const runAction = async (name: string, action: ChAction): Promise<Response> => {
    try {
      switch (action) {
        case "reboot": await chApi.vmReboot(name); break;
        case "pause": await chApi.vmPause(name); break;
        case "resume": await chApi.vmResume(name); break;
        case "shutdown":
          try { await chApi.vmShutdown(name); }
          catch { await vmManager.stopVM(name); }
          break;
      }
      wsHub.pushVMs();
      return ok();
    } catch (e) {
      return error(e);
    }
  };

  /** `GET /api/vms/:name/counters` */
  const getCounters = async (name: string): Promise<Response> => {
    try {
      const data = await chApi.vmCounters(name);
      return json({ ts: Date.now(), counters: data });
    } catch (e) {
      return error(e);
    }
  };

  /** `GET /api/vms/:name/snapshots` */
  const listSnapshots = async (name: string): Promise<Response> => {
    const dir = path.join(vmDir, name, "snapshots");
    const entries = await readdir(dir).catch(() => [] as string[]);
    return json(entries.sort().reverse());
  };

  /** `POST /api/vms/:name/snapshots` */
  const takeSnapshot = async (name: string): Promise<Response> => {
    const vm = vmManager.getVM(name);
    if (!vm) return json({ error: "not found" }, 404);
    if (vm.state !== "running") return json({ error: "VM must be running to snapshot" }, 400);
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
      const snapDir = path.join(vmDir, name, "snapshots", ts);
      await mkdir(snapDir, { recursive: true });
      await chApi.vmSnapshot(name, snapDir);
      return json({ name: ts });
    } catch (e) {
      return error(e);
    }
  };

  // ── dispatch ───────────────────────────────────────────────────────────

  return async (req, pathname) => {
    if (pathname === "/api/vms") {
      if (req.method === "GET") return listVMs();
      if (req.method === "POST") return createVM(req);
    }

    if (pathname === "/api/images" && req.method === "GET") {
      return listImages();
    }

    const vmMatch = pathname.match(/^\/api\/vms\/([^/]+)$/);
    if (vmMatch) {
      const name = vmMatch[1];
      if (req.method === "GET") return getVM(name);
      if (req.method === "DELETE") return deleteVM(name);
    }

    const startMatch = pathname.match(/^\/api\/vms\/([^/]+)\/start$/);
    if (startMatch && req.method === "POST") return startVM(startMatch[1]);

    const actionMatch = pathname.match(/^\/api\/vms\/([^/]+)\/(reboot|pause|resume|shutdown)$/);
    if (actionMatch && req.method === "PUT") {
      return runAction(actionMatch[1], actionMatch[2] as ChAction);
    }

    const countersMatch = pathname.match(/^\/api\/vms\/([^/]+)\/counters$/);
    if (countersMatch && req.method === "GET") return getCounters(countersMatch[1]);

    const snapshotsMatch = pathname.match(/^\/api\/vms\/([^/]+)\/snapshots$/);
    if (snapshotsMatch) {
      const name = snapshotsMatch[1];
      if (req.method === "GET") return listSnapshots(name);
      if (req.method === "POST") return takeSnapshot(name);
    }

    return null;
  };
}
