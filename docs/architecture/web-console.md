# Web console

> Forward-looking design. Not implemented yet. Sibling of
> `orchestrator.md` and `croutond-build-guide.md`.

A browser-based serial / virtio-console attachment to running VMs. The
goal: click a VM, get a working terminal in a modal, with full keyboard
input and ANSI rendering.

## Architecture in one picture

```
xterm.js (browser)
   │  WS (binary frames)
   ▼
crouton (Bun)  ──── WS proxy (1 client × N subscribers fan-out)
   │  WS
   ▼
croutond  ─── reads / writes  ───►  CH serial socket (unix domain)
                                          │
                                          ▼
                                     guest getty
```

Three layers, each owning one concern:

- **CH** writes/reads bytes on a UDS — that's the only thing it knows
  about the console.
- **croutond** owns the socket and turns it into a WebSocket endpoint
  with a small replay buffer and multi-subscriber fan-out.
- **crouton** proxies the WS through to the browser so the browser
  only ever knows about Bun.

Until croutond exists, Bun does its job locally inside `LocalVMRunner`.
Same interface, no proxy hop.

## 1. CH side

Cloud Hypervisor lets you pick the transport for serial and
virtio-console: `tty`, `pty`, `file`, or `socket=<path>`. The console
work needs `socket` — a UDS the host can read and write to.

New flags for spawning, replacing today's defaults in
`LocalRunner.buildChArgs`:

| Boot mode | Today                                          | For console                                                           |
|-----------|------------------------------------------------|-----------------------------------------------------------------------|
| UEFI      | `--serial tty --console off`                   | `--serial socket=<vmDir>/console.sock --console off`                  |
| Direct    | `--cmdline "console=hvc0 …"` (no explicit console flag) | Same `--cmdline` + `--console socket=<vmDir>/console.sock`            |

CH creates the socket when it starts and accepts client connections.
Guest needs a getty on `ttyS0` (UEFI) or `hvc0` (direct) — most
cloud-init images enable this by default.

## 2. Server side (eventually croutond)

The endpoint:

- `GET /vms/:name/console` — HTTP upgrade to WebSocket.
- Opens the per-VM serial socket once, on first subscriber.
- Maintains a **ring buffer** of ~64 KB of recent bytes. New
  subscribers get the buffer immediately so they see a meaningful
  screen instead of a blank terminal.
- **Multi-subscriber fan-out**: one socket reader, N WS writers. Any
  subscriber's keystrokes go up to CH; CH output goes to all
  subscribers. The VM has no idea more than one watcher exists.
- WS frames are binary (no JSON wrapping).

State machine per VM:

```
no subscribers ──first connect──► reader spawned, ring buffer active
reader active  ──last disconnect──► reader idle until next connect
VM stops       ──► reader closed, all subscribers receive close
```

Don't tear down the reader on every disconnect immediately — keep it
warm for a few seconds in case the user is just refreshing the modal.

## 3. Browser side

`xterm.js` is the standard. ~200 KB; handles ANSI escapes, color,
cursor positioning, mouse, copy-paste, scrollback.

```js
import { Terminal } from "https://esm.sh/@xterm/xterm";
import { FitAddon } from "https://esm.sh/@xterm/addon-fit";

const term = new Terminal({
  fontFamily: "'Berkeley Mono', ui-monospace, monospace",
  theme: { background: "#1a1a1a", foreground: "#f5f5f5" },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(containerEl);
fit.fit();

const ws = new WebSocket(`/api/vms/${name}/console`);
ws.binaryType = "arraybuffer";
ws.onmessage = e => term.write(new Uint8Array(e.data));
term.onData(d => ws.send(d));
```

UI fit: a console button on running VMs, modal opens with the terminal
filling most of the viewport. Pin the terminal's theme to the current
dashboard theme. Use the existing `--accent` color for the cursor.

## 4. The Bun proxy (when croutond exists)

Bun keeps a single browser-facing endpoint at
`/api/vms/:name/console`. On WS upgrade it opens its own WS to
`croutond:/vms/:name/console` and pipes both ways:

```ts
ws.onmessage = e => croutondWs.send(e.data);
croutondWs.onmessage = e => ws.send(e.data);
```

Bun does **not** maintain the ring buffer or fan-out — that's the
node-local concern croutond owns. Bun is dumb glue. This also means
multiple browsers on the same VM each get their own Bun WS but share
croutond's single socket reader.

For single-host before croutond ships: same endpoint shape, but Bun
opens the CH serial socket directly inside `LocalVMRunner` and does
the fan-out itself.

## 5. Failure modes

| Event                                      | Behaviour                                                      |
|--------------------------------------------|----------------------------------------------------------------|
| VM not running                             | 404 / immediate close. UI shows "VM is stopped — start first". |
| Guest has no getty on serial / hvc0        | Terminal stays blank. Guest-image issue, not console.          |
| CH crash during a session                  | WS closes with code `1011`. Modal shows "console lost".        |
| Croutond restart                           | Same; UI reconnects automatically a few seconds later.         |
| Browser tab closed                         | WS closes; reader stays warm briefly in case of reconnect.     |
| Resize                                     | Serial doesn't carry terminal dimensions. xterm.js renders at its own size; the guest may not honor escape sequences for window size. Pragmatic default: pin to 80×24 in the VM, let xterm.js scroll. |
| Existing VMs launched with `--serial tty`  | Console won't attach until the VM is restarted with the new flags. Document this; bake the new flags into the runner so all new boots use sockets. |

## 6. Security

Serial console is full shell access. The browser → Bun WS is
unauthenticated today. **Before exposing this endpoint outside
localhost**, we need auth — at minimum a token check on the WS
upgrade. Worth scoping the console work alongside Bun-side auth.

## 7. Build sequence

A clean order that minimises rework:

1. **CH flag change**: swap `--serial tty` to `--serial socket=…` (UEFI)
   and add `--console socket=…` for direct-boot in
   `LocalRunner.buildChArgs`. Validate with `socat - UNIX-CONNECT:…`
   from the host — you should see the boot log and a login prompt.
2. **Bun WS endpoint**: `/api/vms/:name/console`, ring buffer,
   fan-out, raw byte piping straight to the CH socket inside
   `LocalVMRunner`.
3. **UI**: xterm.js modal, "console" button on running VMs.
4. **Auth**: token-gated WS upgrade. Required before any non-loopback
   exposure.
5. **When croutond ships**: move the socket reader + fan-out into
   croutond. Bun becomes a WS proxy. The UI doesn't change.

## 8. Stretch ideas (don't build yet)

- **Terminal recording**: tee the ring buffer to a file with timestamps
  (asciinema format). Useful for "what happened to this VM at 3am".
- **Copy/paste safety**: warn on pasting multi-line input — common
  footgun in real terminals too.
- **Mobile keyboard**: xterm.js works on mobile but needs a soft
  keyboard helper for Ctrl, Esc, Tab.
- **WebSerial / WebSocket-over-WebRTC** for sub-100ms typing latency
  on remote hosts. Overkill until someone complains.
