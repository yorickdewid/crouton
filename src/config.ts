/**
 * Runtime configuration resolved from environment variables with local defaults.
 */
export interface CroutonConfig {
  /** HTTP port for the Bun server. */
  port: number;
  /** Bind address for the Bun server. */
  host: string;
  /** Root directory containing VM instance data. */
  vmDir: string;
  /** Directory containing firmware images used for VM boot. */
  firmwareDir: string;
  /** Directory containing VM disk images. */
  imageDir: string;
  /** Host bridge interface used for VM networking. */
  bridgeInterface: string;
  /** Filesystem path to the cloud-hypervisor binary. */
  chBinary: string;
  /**
   * Base URL of the croutond orchestrator (e.g. `http://[::1]:7777`).
   * The Bun process talks to it over plain HTTP/JSON for every VM
   * lifecycle operation; see `src/vm/remote-runner.ts`.
   *
   * IPv6 literals must be bracketed per RFC 3986. The default uses the
   * IPv6 loopback so croutond can bind `::1` and avoid dual-stack
   * surprises; flip to `http://127.0.0.1:7777` if you're on a host
   * without IPv6.
   */
  croutondUrl: string;
  /**
   * Optional absolute HTTP(S) base URL used by the web UI for `/api/...`
   * requests (e.g. `https://ops.example.net:3000`). Leave empty to use
   * same-origin requests.
   */
  uiApiBase: string;
  /**
   * Optional absolute WS(S) base URL used by the web UI for `/ws`
   * connections (e.g. `wss://ops.example.net:3000`). Leave empty to use
   * same-origin websocket URL derivation.
   */
  uiWsBase: string;
}

/**
 * Process-wide configuration for Crouton.
 */
export const config: CroutonConfig = {
  port: parseInt(process.env.PORT ?? "3000"),
  host: process.env.HOST ?? "0.0.0.0",
  vmDir: process.env.VM_DIR ?? "/home/eve/vm",
  firmwareDir: process.env.FIRMWARE_DIR ?? "/home/eve/firmware",
  imageDir: process.env.IMAGE_DIR ?? "/home/eve/images",
  bridgeInterface: process.env.BRIDGE_INTF ?? "br0",
  chBinary: process.env.CH_BINARY ?? "./cloud-hypervisor/target/release/cloud-hypervisor",
  croutondUrl: process.env.CROUTOND_URL ?? "http://[::1]:7777",
  uiApiBase: process.env.CROUTON_UI_API_BASE ?? "",
  uiWsBase: process.env.CROUTON_UI_WS_BASE ?? "",
};
