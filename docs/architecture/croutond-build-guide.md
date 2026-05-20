# croutond build guide

> Sibling of `orchestrator.md`. That file is the *spec*; this is the
> *implementation plan* for the Rust daemon. Aimed at someone who already
> knows Rust and just needs the map.

## 1. The shape of the daemon

Five internal concerns:

- **Pool** — keeps N pre-spawned CH processes alive and idle, hands them
  out, takes them back.
- **Network** — ensures the bridge exists, allocates TAPs and MACs, tears
  them down.
- **CH client** — HTTP-over-Unix-socket wrapper to talk to each spawned CH.
- **HTTP server** — implements the wire contract that crouton calls.
- **Registry** — `HashMap<vm_name, BoundSlot>` mapping which pool slot is
  currently hosting which VM.

No persistence, no config files, no UI. Everything else is the caller's
problem.

## 2. State model

```rust
struct PoolSlot {
    pid: u32,
    socket: PathBuf,          // /var/run/croutond/slot-<id>/vmm.sock
    state: SlotState,         // Idle | Bound(VMName) | Dead
}

struct BoundVM {
    slot_id: SlotId,
    name: String,
    tap: String,
    mac: MacAddr,
    started_at: Instant,
    // hold the BootConfig too, for diagnostics
}
```

Two indexes:
- `slots: Vec<PoolSlot>` — physical slots, indexable.
- `bound: HashMap<String, SlotId>` — `vm_name → slot`.

Wrap both in a single `Mutex` or per-field `RwLock`. A single mutex is
fine for the throughput here — Bun-driven, not high-frequency.

## 3. The "boot a VM" flow (POST /vms)

This is the orchestration core. Walk through it once and most of the
daemon falls out:

1. Validate `BootConfig`. Reject if `name` is already in `bound`.
2. **Allocate slot**: take an `Idle` slot from `slots`. If none and pool
   is below max, spawn one inline; else 503.
3. **Allocate network**: pick a free `tapN`, derive MAC from name
   (sha256 prefix, matching Bun's `NetworkManager.macFor`), create the
   TAP, attach to bridge, bring up.
4. **Configure CH**: `PUT slot.socket /api/v1/vm.create` with the
   disks/cpus/memory/boot config translated from `BootConfig`. The TAP
   and MAC go in the `net` array.
5. **Boot CH**: `PUT slot.socket /api/v1/vm.boot`.
6. Mark slot `Bound(name)`, insert `BoundVM` into registry, respond
   with `VMRuntime { name, mac, tap, pid: slot.pid, state: "running",
   started_at }`.

**Reverse flow (DELETE /vms/:name)**:

1. Look up slot.
2. `PUT /vm.shutdown`, poll `/vm.info` up to ~10s for the VM to stop.
3. `PUT /vm.delete` to wipe the VM out of the VMM. The CH process itself
   stays alive.
4. Teardown TAP, free MAC.
5. Slot goes back to `Idle`.

If you ever need to *kill* the CH process (after a crash or hung
shutdown), spawn a replacement to keep the pool at floor.

## 4. The pool

Two parameters: `pool_floor` (default 4) and `pool_max` (default 16).

- On startup: spawn `pool_floor` empty CH processes. Each is
  `cloud-hypervisor --api-socket=<unique-path>` with no other args — it
  just sits idle waiting for `/vm.create`.
- On allocate: pop an `Idle` slot. If none and bound count < max, spawn
  one more on demand.
- On free: slot returns to `Idle`. If pool is over floor and the slot
  has served many VMs, optionally recycle to avoid memory drift in
  long-lived CH processes. MVP: don't recycle.
- On CH crash: detect via `child.wait()` returning. Mark slot `Dead`,
  drop the binding, log, push the affected VM into error state. Spawn
  a replacement.

## 5. Network setup

Two options:

- **Shell out to `ip`** — same as the existing Bun code does today.
- **`rtnetlink` crate** — pure Rust, no `sudo` if you have
  `CAP_NET_ADMIN`. Better long-term: avoids `ip` fork per VM and gives
  atomic operations.

MVP can shell out. Switch to `rtnetlink` once the daemon stabilises.

MAC derivation: sha256 of name, `02:` prefix, first 5 octets — same
algorithm as Bun's `NetworkManager.macFor`. Keeps MACs stable across
restarts and means crouton and croutond compute the same MAC
independently.

## 6. CH client (Unix socket HTTP)

CH speaks HTTP/1.1 over a Unix socket. In Rust:

- `hyperlocal` + `hyper` — straightforward.
- `reqwest` doesn't do Unix sockets out of the box; use `hyper`
  directly.

The methods to wrap are listed in the existing `src/api/ch.ts` — same
endpoints (`vmm.ping`, `vm.create`, `vm.boot`, `vm.shutdown`,
`vm.delete`, `vm.reboot`, `vm.pause`, `vm.resume`, `vm.counters`,
`vm.snapshot`).

## 7. HTTP server endpoints

Mirror `src/orchestrator/contract.ts` exactly. Non-obvious ones:

- **GET /health**: liveness + pool counts.
- **GET /vms**: project the registry to `VMRuntime[]`.
- **GET /vms/:name/counters**: proxy CH's `/vm.counters`, body
  passthrough.
- **PUT /vms/:name/snapshot**: proxy CH's `/vm.snapshot` with the
  destination URL the caller specified.
- **PUT /vms/:name/{reboot,pause,resume}**: proxy. 200 on success.

Use `axum` — tokio-native and ergonomic. Wrap shared state in
`Arc<Mutex<Daemon>>` and pass as the state extractor.

## 8. Concurrency model

- One tokio runtime.
- One task per HTTP request (axum default).
- The mutex over `Daemon` state serializes the allocate/free moments
  (fast — slot grab + HTTP call). The CH `vm.boot` calls don't need to
  hold the mutex; release it before the HTTP call out to CH and
  re-acquire only to commit the binding.
- Pool restocker: separate background task that watches a
  `tokio::sync::Notify` and spawns replacements when the pool dips.

## 9. Failure semantics

| Event | Behaviour |
|---|---|
| `vm.create` fails after slot allocate | Free TAP, free MAC, return slot to `Idle`, propagate the error. |
| CH crash on a bound slot | Background `child.wait()` task marks slot `Dead`, drops binding, logs, kicks the restocker. |
| Croutond itself dies | Pool dies with it. `Restart=on-failure` in systemd; Bun reconciles via its `autostart` pass on the next start. |
| Two concurrent `POST /vms` with same name | Reject the second one — registry check happens under the mutex. |
| Shutdown of croutond | SIGTERM children gracefully; optionally `vm.shutdown` each bound VM with a 5s budget, then SIGTERM. |

## 10. Crate picks

- `tokio` — runtime.
- `axum` + `tower-http` — HTTP server.
- `hyper` + `hyperlocal` — Unix-socket HTTP client to CH.
- `serde` + `serde_json` — wire types.
- `clap` — CLI (port, pool size, ch binary path, bridge name).
- `tracing` + `tracing-subscriber` — logging.
- `rtnetlink` — eventually, for native TAP/bridge.
- `nix` — signals and process control.

Skip on day one: `sqlx`, `redis`, anything heavy. Croutond has no
persistent state.

## 11. MVP vs full

If shipping fast and adding the pool later:

**MVP** (no pool):
- Spawn CH on `POST /vms`, kill it on `DELETE /vms/:name`. One process
  per VM.
- Wire contract identical; Bun can't tell the difference.
- Roughly half the daemon code.

**Pool** (real thing):
- Adds `slots`, the restocker, and `vm.create`/`vm.delete` lifecycle on
  a persistent CH instead of process spawn.
- Latency win: boot ~5× faster because no fork/exec/CH-startup.

Recommended: MVP first, validate end-to-end against Bun, then add the
pool as a behaviour change inside the existing endpoints. Bun does not
change at all when you swap.

## 12. The contract is the test

The TypeScript types in `src/orchestrator/contract.ts` are the spec.
When done, the Rust types should serialize/deserialize to the same
JSON. Easiest validation: write a small Bun script that exercises every
endpoint and asserts the shapes. That's also reusable when
`RemoteVMRunner` lands.
