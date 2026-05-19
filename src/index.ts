import { config } from "./config";
import { handleApi } from "./routes/api";
import { discoverVMs } from "./vm/discover";
import { VMManager } from "./vm/manager";
import { WsHub } from "./server/ws";

const discovered = await discoverVMs();
const vmManager = new VMManager(discovered);
const wsHub = new WsHub(vmManager);

const ui = await Bun.file(`${import.meta.dir}/ui/index.html`).text();


const server = Bun.serve({
  port: config.port,
  hostname: config.host,

  async fetch(req, server) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/ws") {
      if (server.upgrade(req)) return undefined as unknown as Response;
      return new Response("expected websocket", { status: 400 });
    }

    if (pathname.startsWith("/api/")) {
      const res = await handleApi(req, pathname, vmManager);
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
    message() { /* server doesn't need client messages today */ },
  },
});

wsHub.startRefreshLoop();
console.log(`Crouton listening on http://${config.host}:${config.port}`);
