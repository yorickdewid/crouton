import path from "path";
import { mkdir } from "fs/promises";
import { CreateVMOptionsSchema, CloneVMOptionsSchema, ToggleSchema, VMConfigPatchSchema, type VMProvisioner } from "../vm/create";
import { DownloadImageSchema, type ImageStore } from "../images/store";
import type { VMInstance } from "../types";
import type { SnapshotStore } from "../vm/snapshots";
import type { VMManager } from "../vm/manager";
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
  provisioner: VMProvisioner;
  configStore: VMConfigStore;
  net: NetworkManager;
  wsHub: WsHub;
  snapshots: SnapshotStore;
  images: ImageStore;
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
  const { vmManager, provisioner, configStore, net, wsHub, snapshots, images, vmDir } = deps;

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

  /** `GET /api/images` — list image metadata. */
  const listImages = async (): Promise<Response> => json(await images.list());

  /** `POST /api/images` — download a new image from a URL. */
  const downloadImage = async (req: Request): Promise<Response> => {
    let raw: unknown;
    try { raw = await req.json(); }
    catch { return json({ error: "request body is not valid JSON" }, 400); }

    const parsed = DownloadImageSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue.path.length ? issue.path.join(".") : "body";
      return json({ error: `${where}: ${issue.message}` }, 400);
    }

    try {
      const info = await images.download(parsed.data);
      return json(info, 201);
    } catch (e) {
      return error(e);
    }
  };

  /** `DELETE /api/images/:filename` — remove an image from disk. */
  const deleteImage = async (filename: string): Promise<Response> => {
    try {
      await images.delete(filename);
      return ok();
    } catch (e) {
      return error(e);
    }
  };

  /** `GET /api/vms/:name` */
  const getVM = async (name: string): Promise<Response> => {
    const vm = vmManager.getVM(name);
    if (!vm) return json({ error: "not found" }, 404);
    const ip = await net.macToIp(vm.mac);
    if (ip) vm.ip = ip;
    try {
      const info = await vmManager.info(name);
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

  /** `POST /api/vms/:name/clone` — duplicate a stopped VM under a new name. */
  const cloneVM = async (sourceName: string, req: Request): Promise<Response> => {
    let raw: unknown;
    try { raw = await req.json(); }
    catch { return json({ error: "request body is not valid JSON" }, 400); }

    const parsed = CloneVMOptionsSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue.path.length ? issue.path.join(".") : "body";
      return json({ error: `${where}: ${issue.message}` }, 400);
    }

    const source = vmManager.getVM(sourceName);
    if (!source) return json({ error: `source VM '${sourceName}' not found` }, 404);
    if (source.state !== "stopped") {
      return json({ error: `source VM is ${source.state}; must be stopped to clone` }, 400);
    }

    const targetName = parsed.data.name;
    if (vmManager.getVM(targetName)) {
      return json({ error: `VM '${targetName}' already exists` }, 400);
    }

    try {
      const targetConfig = await provisioner.clone(sourceName, targetName, source.config);
      const newInstance: VMInstance = {
        name: targetName,
        state: "stopped",
        mac: net.macFor(targetName),
        config: targetConfig,
      };
      vmManager.register(newInstance);
      wsHub.pushVMs();
      return json(newInstance, 201);
    } catch (e) {
      return error(e);
    }
  };

  /** `PUT /api/vms/:name/autostart` — toggle the autostart flag. */
  const setAutostart = async (name: string, req: Request): Promise<Response> => {
    let raw: unknown;
    try { raw = await req.json(); }
    catch { return json({ error: "request body is not valid JSON" }, 400); }

    const parsed = ToggleSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue.path.length ? issue.path.join(".") : "body";
      return json({ error: `${where}: ${issue.message}` }, 400);
    }

    const vm = vmManager.getVM(name);
    if (!vm) return json({ error: "not found" }, 404);

    vm.config.autostart = parsed.data.value;
    try {
      await configStore.write(vm.config);
    } catch (e) {
      return error(e);
    }
    wsHub.pushVMs();
    return ok();
  };

  /**
   * `PUT /api/vms/:name/config` — patch the persisted VMConfig.
   * Accepts a partial body; only the keys present are merged. The change
   * is written to `crouton.json` and mirrored on the in-memory instance.
   *
   * If the VM is running, the *live* VMM keeps its previous values; the
   * patch only affects the next boot. The UI shows a warning in that case.
   */
  const updateConfig = async (name: string, req: Request): Promise<Response> => {
    let raw: unknown;
    try { raw = await req.json(); }
    catch { return json({ error: "request body is not valid JSON" }, 400); }

    const parsed = VMConfigPatchSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue.path.length ? issue.path.join(".") : "body";
      return json({ error: `${where}: ${issue.message}` }, 400);
    }

    const vm = vmManager.getVM(name);
    if (!vm) return json({ error: "not found" }, 404);

    const updated = { ...vm.config, ...parsed.data };
    try {
      await configStore.write(updated);
      vm.config = updated;
    } catch (e) {
      return error(e);
    }
    wsHub.pushVMs();
    return json(updated);
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
        case "reboot": await vmManager.reboot(name); break;
        case "pause": await vmManager.pause(name); break;
        case "resume": await vmManager.resume(name); break;
        // `shutdown` goes via VMManager.stopVM, which delegates to the
        // runner; the runner tries CH's vm.shutdown and falls back to
        // SIGTERM internally so the process always dies.
        case "shutdown": await vmManager.stopVM(name); break;
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
      const data = await vmManager.counters(name);
      return json({ ts: Date.now(), counters: data });
    } catch (e) {
      return error(e);
    }
  };

  /** `GET /api/vms/:name/snapshots` */
  const listSnapshots = async (name: string): Promise<Response> => json(await snapshots.list(name));

  /** `POST /api/vms/:name/snapshots` */
  const takeSnapshot = async (name: string): Promise<Response> => {
    const vm = vmManager.getVM(name);
    if (!vm) return json({ error: "not found" }, 404);
    if (vm.state !== "running") return json({ error: "VM must be running to snapshot" }, 400);
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
      const snapDir = path.join(vmDir, name, "snapshots", ts);
      await mkdir(snapDir, { recursive: true });
      await vmManager.snapshot(name, snapDir);
      wsHub.pushVMs();
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

    if (pathname === "/api/images") {
      if (req.method === "GET") return listImages();
      if (req.method === "POST") return downloadImage(req);
    }

    const imageMatch = pathname.match(/^\/api\/images\/([^/]+)$/);
    if (imageMatch && req.method === "DELETE") return deleteImage(imageMatch[1]);

    const vmMatch = pathname.match(/^\/api\/vms\/([^/]+)$/);
    if (vmMatch) {
      const name = vmMatch[1];
      if (req.method === "GET") return getVM(name);
      if (req.method === "DELETE") return deleteVM(name);
    }

    const startMatch = pathname.match(/^\/api\/vms\/([^/]+)\/start$/);
    if (startMatch && req.method === "POST") return startVM(startMatch[1]);

    const cloneMatch = pathname.match(/^\/api\/vms\/([^/]+)\/clone$/);
    if (cloneMatch && req.method === "POST") return cloneVM(cloneMatch[1], req);

    const autostartMatch = pathname.match(/^\/api\/vms\/([^/]+)\/autostart$/);
    if (autostartMatch && req.method === "PUT") return setAutostart(autostartMatch[1], req);

    const configMatch = pathname.match(/^\/api\/vms\/([^/]+)\/config$/);
    if (configMatch && req.method === "PUT") return updateConfig(configMatch[1], req);

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
