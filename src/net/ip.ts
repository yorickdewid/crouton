import { readFile } from "fs/promises";

// Parse /proc/net/arp to find the IP for a given MAC address.
// Only works for reachable neighbours that have sent ARP traffic.
export async function macToIp(mac: string): Promise<string | undefined> {
  try {
    const text = await readFile("/proc/net/arp", "utf-8");
    const needle = mac.toLowerCase();
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 4 && cols[3].toLowerCase() === needle) {
        return cols[0];
      }
    }
  } catch {}
  return undefined;
}
