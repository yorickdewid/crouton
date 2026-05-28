import type { BootConfig, VMRuntime } from "../orchestrator/contract";
import type { VMRunner, VMRunnerEvents } from "./runner";

/**
 * Dependencies for {@link createRemoteRunner}.
 */
export interface RemoteRunnerDeps {
  /** Base URL of the croutond orchestrator, e.g. `http://[::1]:7777`. */
  url: string;
  /**
   * Per-request timeout in milliseconds. The 500 ms `WsHub` push tick is
   * timing-sensitive, so we bound every fetch to keep a slow/stuck
   * croutond from piling up pushes. Defaults to 2000.
   */
  timeoutMs?: number;
}

/**
 * Croutond returns `VMRuntime` with `started_at` (snake_case, idiomatic
 * Rust serde). The Bun side wants `startedAt`. This helper normalises
 * both shapes so we're tolerant of either if the wire ever flips.
 */
function fromWire(raw: unknown): VMRuntime {
  const v = raw as Record<string, unknown>;
  return {
    name: String(v.name ?? ""),
    mac: String(v.mac ?? ""),
    tap: String(v.tap ?? ""),
    pid: Number(v.pid ?? 0),
    state: (v.state ?? "running") as VMRuntime["state"],
    startedAt: String(v.started_at ?? v.startedAt ?? ""),
  };
}

/**
 * Builds the remote {@link VMRunner}. Every method is a single `fetch`
 * to croutond bounded by `AbortSignal.timeout`. Errors from croutond
 * (non-2xx) become thrown `Error`s with the message extracted from the
 * `{error}` body when available, falling back to the raw text.
 *
 * No `onExit` is fired: croutond doesn't push lifecycle events today,
 * and a Bun-side poll would be wasteful. {@link VMManager.stopVM}
 * transitions to `"stopped"` itself after `runner.stop` resolves; for
 * out-of-band exits (guest poweroff, croutond restart) the state will
 * drift until the next discovery pass.
 */
export function createRemoteRunner(deps: RemoteRunnerDeps): VMRunner {
  const base = deps.url.replace(/\/+$/, "");
  const timeoutMs = deps.timeoutMs ?? 2000;

  /**
   * Single fetch helper. Throws on non-2xx; returns parsed JSON or
   * `undefined` for 204. Honours the per-call timeout.
   */
  const call = async (method: string, pathSuffix: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`${base}${pathSuffix}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = text;
      try { msg = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* not JSON */ }
      throw new Error(`croutond ${method} ${pathSuffix} → ${res.status}: ${msg || res.statusText}`);
    }
    if (res.status === 204) return undefined;
    const text = await res.text();
    if (!text) return undefined;
    return JSON.parse(text);
  };

  const idPath = (id: string): string => `/vms/${encodeURIComponent(id)}`;

  return {
    async start(config: BootConfig, _events?: VMRunnerEvents): Promise<VMRuntime> {
      const raw = await call("POST", "/vms", config);
      return fromWire(raw);
    },

    /** `DELETE /vms/:id` — croutond shuts the VMM down and returns the slot. */
    async stop(id: string): Promise<void> {
      await call("DELETE", idPath(id));
    },

    reboot: async (id) => { await call("PUT", `${idPath(id)}/reboot`); },
    pause:  async (id) => { await call("PUT", `${idPath(id)}/pause`); },
    resume: async (id) => { await call("PUT", `${idPath(id)}/resume`); },
    snapshot: async (id, destPath) => { await call("PUT", `${idPath(id)}/snapshot`, { destPath }); },

    counters: (id) => call("GET", `${idPath(id)}/counters`),
    info: (id) => call("GET", `${idPath(id)}/info`),

    /**
     * Treat a successful `GET /vms/:id` as "the VMM is alive". Croutond
     * doesn't expose a dedicated ping; a 200 means the slot is up and
     * responsive, a 404 means it isn't tracked, anything else is an error
     * we surface as "not alive" rather than throwing into the caller.
     */
    async ping(id: string): Promise<boolean> {
      try {
        await call("GET", idPath(id));
        return true;
      } catch { return false; }
    },

    async listRunning(): Promise<VMRuntime[]> {
      const data = await call("GET", "/vms") as { vms?: unknown[] } | unknown[];
      const arr = Array.isArray(data) ? data : (data?.vms ?? []);
      return arr.map(fromWire);
    },
  };
}
