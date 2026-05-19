import { config } from "./config";
import { CloudHypervisor } from "./api/ch";
import { NetworkManager } from "./net/manager";
import { VMConfigStore } from "./vm/persist";
import { VMProvisioner } from "./vm/create";
import { VMDiscoverer } from "./vm/discover";
import { VMManager } from "./vm/manager";
import { WsHub } from "./server/ws";
import { ApiRouter } from "./routes/api";

const chApi = new CloudHypervisor(config.vmDir);
const net = new NetworkManager(config.bridgeInterface);
const configStore = new VMConfigStore(config.vmDir);
const provisioner = new VMProvisioner(config.imageDir, config.vmDir, configStore);
const discoverer = new VMDiscoverer(config.vmDir, configStore, chApi, net);

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
const router = new ApiRouter({
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
      const res = await router.handle(req, pathname);
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
