import { config } from "./config";
import { createCloudHypervisor } from "./api/ch";
import { createNetwork } from "./net/manager";
import { createConfigStore } from "./vm/persist";
import { createProvisioner } from "./vm/create";
import { createDiscoverer } from "./vm/discover";
import { VMManager } from "./vm/manager";
import { WsHub } from "./server/ws";
import { createApiRouter } from "./routes/api";

const chApi = createCloudHypervisor(config.vmDir);
const net = createNetwork(config.bridgeInterface);
const configStore = createConfigStore(config.vmDir);
const provisioner = createProvisioner({
  imageDir: config.imageDir,
  vmDir: config.vmDir,
  configStore,
});
const discoverer = createDiscoverer({ vmDir: config.vmDir, configStore, chApi, net });

const seed = await discoverer.discover();
console.log(`discovered ${seed.length} VM(s): ${seed.map(v => `${v.name}(${v.state})`).join(", ")}`);

const vmManager = new VMManager({
  seed,
  net,
  vmDir: config.vmDir,
  chBinary: config.chBinary,
  firmwareDir: config.firmwareDir,
});

const wsHub = new WsHub({ vmManager, chApi, net });
const handleApi = createApiRouter({
  vmManager, chApi, provisioner, configStore, net, wsHub, vmDir: config.vmDir,
});

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
