import { config } from "./config";
import { createNetwork } from "./net/manager";
import { createConfigStore } from "./vm/persist";
import { createProvisioner } from "./vm/create";
import { createDiscoverer } from "./vm/discover";
import { createSnapshotStore } from "./vm/snapshots";
import { createHostMetrics } from "./host/metrics";
import { createImageStore } from "./images/store";
import { createRemoteRunner } from "./vm/remote-runner";
import { VMManager } from "./vm/manager";
import { WsHub } from "./server/ws";
import { createApiRouter } from "./routes/api";

// `net` is no longer used by the runner — croutond owns TAP/bridge.
// It stays for discovery (MAC derivation, ARP-based IP lookup).
const net = createNetwork(config.bridgeInterface);
const configStore = createConfigStore(config.vmDir);
const provisioner = createProvisioner({ imageDir: config.imageDir, vmDir: config.vmDir, configStore });
const snapshots = createSnapshotStore(config.vmDir);
const hostMetrics = createHostMetrics(config.vmDir);
const images = createImageStore(config.imageDir);

const runner = createRemoteRunner({ url: config.croutondUrl });
const discoverer = createDiscoverer({ vmDir: config.vmDir, configStore, runner, net });

console.log(`croutond at ${config.croutondUrl}`);

const seed = await discoverer.discover();
console.log(`discovered ${seed.length} VM(s): ${seed.map(v => `${v.label}(${v.state})`).join(", ")}`);

const vmManager = new VMManager({
  seed,
  runner,
  vmDir: config.vmDir,
  firmwareDir: config.firmwareDir,
});

const wsHub = new WsHub({ vmManager, net, snapshots, hostMetrics });
const handleApi = createApiRouter({
  vmManager, provisioner, configStore, net, wsHub, snapshots, images, vmDir: config.vmDir,
});

// Auto-start VMs flagged with `autostart: true` in their crouton.json.
// Discovery already determined which ones are stopped vs already running.
const autostartTargets = seed.filter(vm => vm.state === "stopped" && vm.config.autostart);
if (autostartTargets.length > 0) {
  console.log(`autostarting ${autostartTargets.length} VM(s): ${autostartTargets.map(v => v.label).join(", ")}`);
  for (const vm of autostartTargets) {
    try {
      await vmManager.startVM(vm.config);
    } catch (e) {
      console.error(`failed to autostart ${vm.label}:`, (e as Error).message);
    }
  }
}

const ui = await Bun.file(`${import.meta.dir}/ui/index.html`).text();

const server = Bun.serve({
  port: config.port,
  hostname: config.host,

  async fetch(req, server) {
    const { pathname } = new URL(req.url);

    if (pathname === "/ws") {
      if (server.upgrade(req)) return undefined as unknown as Response;
      return new Response("expected websocket", { status: 400 });
    }

    if (pathname.startsWith("/api/")) {
      const res = await handleApi(req, pathname);
      if (res) return res;
    }

    if (pathname === "/" || pathname === "/index.html") {
      return new Response(ui, { headers: { "Content-Type": "text/html" } });
    }

    return new Response("not found", { status: 404 });
  },

  websocket: {
    open(ws) { wsHub.addClient(ws); },
    close(ws) { wsHub.removeClient(ws); },
    message() { /* server doesn't consume client messages today */ },
  },
});

wsHub.startRefreshLoop();
console.log(`Crouton listening on http://${config.host}:${config.port}`);
