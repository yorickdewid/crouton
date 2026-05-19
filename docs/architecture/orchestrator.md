# Architecture: the `crouton` ↔ `croutond` split

> Status: design, not yet implemented.
> Last revised: 2026-05-19.

## Problem

The Bun process currently spawns Cloud Hypervisor (CH) VMMs as direct
child processes. Two concerns are tangled together:

1. **UI / API surface** — the dashboard, the REST routes, the WebSocket
   push channel. Stateless about live VMs, restart-safe in principle.
2. **VM lifecycle ownership** — process spawning, TAP allocation, MAC
   generation, signal handling, sudo. Needs privilege; killing this
   process kills the VMs.

Putting both into one Bun process means:

- You can't restart Bun without killing every VM.
- Bun runs as root (or with sudo wrappers) for things that don't
  need it.
- Cold-starting a CH VMM on every `start` adds latency that a pool
  could remove.
- Single-host by construction.

## The split

Two processes, each with one job.

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (dashboard)                                        │
└─────────────────────────────┬───────────────────────────────┘
                              │ HTTPS / WebSocket
┌─────────────────────────────▼───────────────────────────────┐
│  crouton  (Bun + TypeScript, unprivileged)                  │
│  - UI, REST API, WS push                                    │
│  - Image management, snapshots dir, vm/<name>/crouton.json  │
│  - Discovery from the filesystem                            │
│  - Stateless about live VMs (asks croutond)                 │
└─────────────────────────────┬───────────────────────────────┘
                              │ HTTP/JSON over TCP (localhost or remote)
┌─────────────────────────────▼───────────────────────────────┐
│  croutond  (Rust, root or CAP_NET_ADMIN)                    │
│  - Pool of pre-spawned CH VMMs                              │
│  - TAP / bridge / MAC allocation                            │
│  - Proxy CH actions back to crouton                         │
│  - Stateless about VM *configuration*                       │
└─────────────────────────────┬───────────────────────────────┘
                              │ Unix socket (vm.sock) per VMM
                              ▼
                       cloud-hypervisor × N
```

### Why HTTP over TCP

A Unix socket would be simpler and is how CH itself works, but TCP keeps
the door open for a future multi-host setup where crouton lives on one
machine and croutond on each compute node. Wire protocol is identical,
only the URL changes.

For single-host now: bind `127.0.0.1:<port>`, no auth.
For multi-host later: bind a routable address, mTLS.

### Pool semantics

croutond pre-spawns N (default 4–8) CH processes at startup. Each is a
plain `cloud-hypervisor --api-socket=…` with no VM loaded. They sit
idle.

When Bun calls `POST /vms`:
1. croutond allocates an idle VMM from the pool.
2. PUT `/vm.create` on its socket with the full config.
3. PUT `/vm.boot`.
4. Track `{vmName → poolSlot → socket → pid → tap}`.

When Bun calls `DELETE /vms/:name`:
1. PUT `/vm.shutdown` (or SIGTERM as fallback).
2. PUT `/vm.delete` on the socket — VMM is empty again.
3. Return the slot to the pool, tear down its TAP.

The pool can grow on demand if all slots are occupied; cap at a config
limit. Idle slots above the floor can be reaped after some grace period.

## State ownership

| Concern                          | Owner       |
|----------------------------------|-------------|
| `vm/<name>/crouton.json` config  | crouton     |
| Disk images, snapshots dir       | crouton     |
| UI preferences, theme, etc.      | crouton     |
| Discovery (which VMs exist)      | crouton     |
| Which VM is currently running    | croutond    |
| TAP / bridge / MAC allocation    | croutond    |
| Pool slot allocation             | croutond    |
| Proxying CH HTTP actions         | croutond    |
| Persisted state                  | *crouton only* |

croutond writes no files. If it restarts, its in-memory state is gone
and so are its VMs. Bun reconciles by reading `crouton.json` files and
calling `POST /vms` for VMs that should be running again.

## Wire protocol (sketch)

See `src/orchestrator/contract.ts` for the source-of-truth TypeScript
shapes. Endpoint summary:

| Method | Path                          | Purpose                                |
|--------|-------------------------------|----------------------------------------|
| GET    | `/health`                     | Liveness probe; reports pool stats.    |
| GET    | `/vms`                        | List currently-running VMs.            |
| GET    | `/vms/:name`                  | Detail for one running VM.             |
| POST   | `/vms`                        | Boot a VM from a full config.          |
| DELETE | `/vms/:name`                  | Shutdown + return VMM to pool.         |
| PUT    | `/vms/:name/reboot`           | Proxy `/vm.reboot`.                    |
| PUT    | `/vms/:name/pause`            | Proxy `/vm.pause`.                     |
| PUT    | `/vms/:name/resume`           | Proxy `/vm.resume`.                    |
| PUT    | `/vms/:name/snapshot`         | Proxy `/vm.snapshot` (body: dest path).|
| GET    | `/vms/:name/counters`         | Proxy `/vm.counters`.                  |

### `POST /vms` request body (the "boot this config" call)

```json
{
  "name":        "fedora",
  "cpus":        4,
  "memoryMb":    4096,
  "bootMode":    "uefi",
  "disks":       ["/home/eve/vm/fedora/disk0.qcow2"],
  "kernelPath":  null,
  "initrdPath":  null,
  "firmwarePath": "/home/eve/firmware/CLOUDHV.fd",
  "snapshotPath": null
}
```

All paths are absolute and resolved by Bun before sending. croutond
treats them as opaque strings to hand to CH.

Response:

```json
{
  "name":  "fedora",
  "mac":   "02:ab:cd:ef:12:34",
  "tap":   "tap3",
  "pid":   18472,
  "state": "running"
}
```

## Failure semantics

| Event                           | Effect                                       |
|---------------------------------|----------------------------------------------|
| Bun crashes / restarts          | No VM impact. Bun reconciles on startup.     |
| croutond crashes                | All its VMs die. systemd `Restart=on-failure` brings it back; Bun's discovery + an autostart pass restore wanted state. |
| Single CH VMM crashes           | croutond marks slot dead, removes it from pool, optionally spawns a replacement. The affected VM goes to `error` state in Bun. |
| Network blip Bun↔croutond       | Bun shows `wsLive=false` for state pushes; cached state remains. Actions block until reconnect. |

## Bun-side refactor needed before croutond exists

Extract a `VMRunner` interface from `VMManager`:

```ts
interface VMRunner {
  start(config: VMConfig): Promise<VMRuntime>;
  stop(name: string): Promise<void>;
  reboot(name: string): Promise<void>;
  pause(name: string): Promise<void>;
  resume(name: string): Promise<void>;
  snapshot(name: string, destPath: string): Promise<void>;
  counters(name: string): Promise<unknown>;
  listRunning(): Promise<VMRuntime[]>;
}
```

Implementations:
- `LocalVMRunner` — current logic (`Bun.spawn`, NetworkManager, CH HTTP client).
- `RemoteVMRunner` — calls croutond over HTTP using the contract.

`VMManager` keeps its in-memory map of VMs, but its `startVM` /
`stopVM` / `deleteVM` methods delegate to a `VMRunner` for the
process-level work.

`NetworkManager` moves *into* `LocalVMRunner`. Once `RemoteVMRunner`
is the only implementation, the module disappears from Bun.

## Roadmap

1. **Now (done):** memory + this doc + `src/orchestrator/contract.ts`.
2. **Bun refactor:** extract `VMRunner` interface, keep `LocalVMRunner`
   as the only implementation. No behaviour change.
3. **First croutond:** minimal Rust binary with the pool, the wire
   endpoints, and no proxying yet. Bun stays on `LocalVMRunner`.
4. **Wire it up:** `RemoteVMRunner` implementation in Bun + integration
   smoke test.
5. **Flip the default:** make `RemoteVMRunner` the default runner.
   `LocalVMRunner` removed; `NetworkManager` removed from Bun.
6. **Polish:** snapshot restore, pool growth/reap policy, optional
   mTLS for remote.

## Open questions

- Rust crate layout: single binary `croutond` vs. library + thin
  daemon. Defer until coding starts.
- Caching pool state across croutond restarts — probably not, accept
  that restart kills VMs.
- Auth: none on localhost. For remote, mTLS with client certs issued
  by crouton.
- How does Bun discover croutond? Configured URL in `croutond.url`
  env / config field. Single-host default: `http://127.0.0.1:7777`.
