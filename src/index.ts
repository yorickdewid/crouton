import { config } from "./config";
import { handleApi } from "./routes/api";
import { discoverVMs } from "./vm/discover";
import { seedInstances } from "./vm/manager";

const ui = await Bun.file(`${import.meta.dir}/ui/index.html`).text();

const discovered = await discoverVMs();
seedInstances(discovered);
console.log(`discovered ${discovered.length} VM(s): ${discovered.map(v => `${v.name}(${v.state})`).join(", ")}`);

const server = Bun.serve({
  port: config.port,
  hostname: config.host,

  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname.startsWith("/api/")) {
      const res = await handleApi(req, pathname);
      if (res) return res;
    }

    if (pathname === "/" || pathname === "/index.html") {
      return new Response(ui, { headers: { "Content-Type": "text/html" } });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`crouton listening on http://${config.host}:${config.port}`);
