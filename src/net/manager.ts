import { stat, readFile } from "fs/promises";
import { $ } from "bun";

/**
 * Host networking operations for VM connectivity: bridge management,
 * TAP allocation, deterministic MAC generation, and ARP-based IP lookup.
 */
export class NetworkManager {
  /**
   * @param bridgeInterface - Host bridge interface that all VM TAPs attach to.
   * @param tapOwner - Linux user that the TAP devices are chowned to. Defaults to $USER.
   */
  constructor(
    private readonly bridgeInterface: string,
    private readonly tapOwner: string = process.env.USER ?? "root",
  ) { }

  /**
   * The configured host bridge interface name.
   */
  get bridge(): string {
    return this.bridgeInterface;
  }

  /**
   * Ensures the configured bridge interface exists and is up.
   * Idempotent.
   */
  async ensureBridge(): Promise<void> {
    if (await this.ifaceExists(this.bridgeInterface)) return;
    await $`sudo ip link add name ${this.bridgeInterface} type bridge`;
    await $`sudo ip link set ${this.bridgeInterface} up`;
  }

  /**
   * Returns the next free `tapN` interface name without creating it.
   */
  async allocateTap(): Promise<string> {
    let index = 0;
    while (true) {
      const name = `tap${index}`;
      if (!await this.ifaceExists(name)) return name;
      index++;
    }
  }

  /**
   * Creates a TAP interface, attaches it to the bridge, and brings it up.
   * @param tap - Name of the TAP interface to create (e.g. from {@link allocateTap}).
   */
  async setupTap(tap: string): Promise<void> {
    await $`sudo ip tuntap add dev ${tap} mode tap user ${this.tapOwner}`;
    await $`sudo ip link set ${tap} master ${this.bridgeInterface}`;
    await $`sudo ip link set ${tap} up`;
  }

  /**
   * Brings a TAP interface down and removes it. Best-effort; errors are swallowed.
   * @param tap - Name of the TAP interface to remove.
   */
  async teardownTap(tap: string): Promise<void> {
    try {
      await $`sudo ip link set ${tap} down`;
      await $`sudo ip tuntap del dev ${tap} mode tap`;
    } catch {
      // teardown is best-effort during cleanup
    }
  }

  /**
   * Generates a deterministic locally-administered MAC from a VM name.
   * Same name always yields the same MAC, so DHCP leases stay stable.
   * @param vmName - VM identifier used as the seed.
   * @returns MAC in `02:xx:xx:xx:xx:xx` form.
   */
  macFor(vmName: string): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(vmName);
    const hex = hasher.digest("hex");
    return `02:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:${hex.slice(6, 8)}:${hex.slice(8, 10)}`;
  }

  /**
   * Resolves the host's view of a MAC address to an IP via `/proc/net/arp`.
   * Only finds neighbours that have recently sent ARP traffic.
   * @param mac - Target MAC address.
   * @returns The IPv4 address as a string, or `undefined` if not in the ARP table.
   */
  async macToIp(mac: string): Promise<string | undefined> {
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
      // /proc/net/arp not readable — return undefined
    }
    return undefined;
  }

  /**
   * Checks whether a network interface exists via sysfs.
   * @param name - Interface name to test.
   */
  private async ifaceExists(name: string): Promise<boolean> {
    return stat(`/sys/class/net/${name}`).then(() => true).catch(() => false);
  }
}
