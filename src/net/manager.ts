import { stat, readFile } from "fs/promises";
import { $ } from "bun";

/**
 * Host networking operations for VM connectivity: bridge management,
 * TAP allocation, deterministic MAC generation, and ARP-based IP lookup.
 */
export interface NetworkManager {
  /** Ensures the configured bridge exists and is up. Idempotent. */
  ensureBridge(): Promise<void>;
  /** Returns the next free `tapN` name without creating it. */
  allocateTap(): Promise<string>;
  /** Creates a TAP interface, attaches it to the bridge, and brings it up. */
  setupTap(tap: string): Promise<void>;
  /** Brings a TAP down and removes it. Best-effort; errors are swallowed. */
  teardownTap(tap: string): Promise<void>;
  /** Deterministic locally-administered MAC for a VM name. */
  macFor(vmName: string): string;
  /** Resolves a MAC to an IP via `/proc/net/arp`, or `undefined` if unknown. */
  macToIp(mac: string): Promise<string | undefined>;
}

/**
 * Builds a {@link NetworkManager}.
 * @param bridgeInterface - Host bridge interface that all VM TAPs attach to.
 * @param tapOwner - Linux user the TAP devices are chowned to. Defaults to `$USER`.
 */
export function createNetwork(
  bridgeInterface: string,
  tapOwner: string = process.env.USER ?? "root",
): NetworkManager {
  const ifaceExists = (name: string): Promise<boolean> =>
    stat(`/sys/class/net/${name}`).then(() => true).catch(() => false);

  return {
    async ensureBridge() {
      if (await ifaceExists(bridgeInterface)) return;
      await $`sudo ip link add name ${bridgeInterface} type bridge`;
      await $`sudo ip link set ${bridgeInterface} up`;
    },

    async allocateTap() {
      let index = 0;
      while (true) {
        const name = `tap${index}`;
        if (!await ifaceExists(name)) return name;
        index++;
      }
    },

    async setupTap(tap) {
      await $`sudo ip tuntap add dev ${tap} mode tap user ${tapOwner}`;
      await $`sudo ip link set ${tap} master ${bridgeInterface}`;
      await $`sudo ip link set ${tap} up`;
    },

    async teardownTap(tap) {
      try {
        await $`sudo ip link set ${tap} down`;
        await $`sudo ip tuntap del dev ${tap} mode tap`;
      } catch {
        // teardown is best-effort during cleanup
      }
    },

    macFor(vmName) {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(vmName);
      const hex = hasher.digest("hex");
      return `02:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:${hex.slice(6, 8)}:${hex.slice(8, 10)}`;
    },

    async macToIp(mac) {
      try {
        const text = await readFile("/proc/net/arp", "utf-8");
        const needle = mac.toLowerCase();
        for (const line of text.split("\n").slice(1)) {
          const cols = line.trim().split(/\s+/);
          if (cols.length >= 4 && cols[3].toLowerCase() === needle) {
            return cols[0];
          }
        }
      } catch {
        // /proc/net/arp not readable
      }
      return undefined;
    },
  };
}
