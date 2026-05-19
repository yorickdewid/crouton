import path from "path";
import { readdir, mkdir } from "fs/promises";
import { listVMs, getVM, startVM, stopVM, deleteVM } from "../vm/manager";
import { vmInfo, vmShutdown, vmReboot, vmPause, vmResume, vmCounters, vmSnapshot } from "../api/ch";
import { listImages, provisionVM } from "../vm/create";
import { readVMConfig, writeVMConfig } from "../vm/persist";
import { macToIp } from "../net/ip";
import { config } from "../config";
// import { pushVMs } from "../server/ws";
import type { CreateVMOptions } from "../vm/create";
import type { VMConfig } from "../types";

const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_MB = 2048;

export async function handleApi(req: Request, pathname: string): Promise<Response | null> {
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  // GET /api/vms
  if (pathname === "/api/vms" && req.method === "GET") {
    return json(listVMs());
  }

  // POST /api/vms — provision + start
  if (pathname === "/api/vms" && req.method === "POST") {
    try {
      const opts = (await req.json()) as CreateVMOptions;
      const vmConfig = await provisionVM(opts);
      const instance = await startVM(vmConfig);
      // pushVMs();
      return json(instance, 201);
    } catch (e: unknown) {
      return json({ error: (e as Error).message }, 400);
    }
  }

  // GET /api/images
  if (pathname === "/api/images" && req.method === "GET") {
    return json(await listImages());
  }

  // /api/vms/:name
  const vmMatch = pathname.match(/^\/api\/vms\/([^/]+)$/);
  if (vmMatch) {
    const name = vmMatch[1];

    if (req.method === "GET") {
      const vm = getVM(name);
      if (!vm) return json({ error: "not found" }, 404);
      const ip = await macToIp(vm.mac);
      if (ip) vm.ip = ip;
      try {
        const info = await vmInfo(name);
        return json({ ...vm, chInfo: info });
      } catch {
        return json(vm);
      }
    }

    // DELETE = wipe the VM directory (must be stopped)
    if (req.method === "DELETE") {
      try {
        await deleteVM(name);
        // pushVMs();
        return json({ ok: true });
      } catch (e: unknown) {
        return json({ error: (e as Error).message }, 400);
      }
    }
  }

  // POST /api/vms/:name/start
  const startMatch = pathname.match(/^\/api\/vms\/([^/]+)\/start$/);
  if (startMatch && req.method === "POST") {
    const name = startMatch[1];
    const vm = getVM(name);
    if (!vm) return json({ error: "not found" }, 404);
    if (vm.state === "running") return json({ error: "already running" }, 400);

    try {
      let cfg = await readVMConfig(name);
      if (!cfg) {
        cfg = {
          ...vm.config,
          name,
          cpus: vm.config.cpus ?? DEFAULT_CPUS,
          memoryMb: vm.config.memoryMb ?? DEFAULT_MEMORY_MB,
        };
        await writeVMConfig(cfg);
      }
      const instance = await startVM(cfg);
      // pushVMs();
      return json(instance);
    } catch (e: unknown) {
      return json({ error: (e as Error).message }, 400);
    }
  }

  // PUT /api/vms/:name/:action
  const actionMatch = pathname.match(/^\/api\/vms\/([^/]+)\/(reboot|pause|resume|shutdown)$/);
  if (actionMatch && req.method === "PUT") {
    const [, name, action] = actionMatch;
    try {
      if (action === "reboot") await vmReboot(name);
      else if (action === "pause") await vmPause(name);
      else if (action === "resume") await vmResume(name);
      else if (action === "shutdown") {
        try { await vmShutdown(name); }
        catch { await stopVM(name); }
      }
      // pushVMs();
      return json({ ok: true });
    } catch (e: unknown) {
      return json({ error: (e as Error).message }, 400);
    }
  }

  // GET /api/vms/:name/counters
  const countersMatch = pathname.match(/^\/api\/vms\/([^/]+)\/counters$/);
  if (countersMatch && req.method === "GET") {
    const name = countersMatch[1];
    try {
      const data = await vmCounters(name);
      return json({ ts: Date.now(), counters: data });
    } catch (e: unknown) {
      return json({ error: (e as Error).message }, 400);
    }
  }

  // /api/vms/:name/snapshots
  const snapshotsMatch = pathname.match(/^\/api\/vms\/([^/]+)\/snapshots$/);
  if (snapshotsMatch) {
    const name = snapshotsMatch[1];

    if (req.method === "GET") {
      try {
        const dir = path.join(config.vmDir, name, "snapshots");
        const entries = await readdir(dir).catch(() => []);
        return json(entries.sort().reverse());
      } catch {
        return json([]);
      }
    }

    if (req.method === "POST") {
      const vm = getVM(name);
      if (!vm) return json({ error: "not found" }, 404);
      if (vm.state !== "running") return json({ error: "VM must be running to snapshot" }, 400);
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
        const snapDir = path.join(config.vmDir, name, "snapshots", ts);
        await mkdir(snapDir, { recursive: true });
        await vmSnapshot(name, snapDir);
        return json({ name: ts });
      } catch (e: unknown) {
        return json({ error: (e as Error).message }, 400);
      }
    }
  }

  return null;
}
