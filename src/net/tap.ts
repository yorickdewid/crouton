import { stat } from "fs/promises";
import { $ } from "bun";
import { config } from "../config";

async function ifaceExists(name: string): Promise<boolean> {
  return stat(`/sys/class/net/${name}`).then(() => true).catch(() => false);
}

export async function allocateTap(): Promise<string> {
  let index = 0;
  while (true) {
    const name = `tap${index}`;
    if (!await ifaceExists(name)) return name;
    index++;
  }
}

export async function ensureBridge(): Promise<void> {
  const br = config.bridgeInterface;
  if (!await ifaceExists(br)) {
    await $`sudo ip link add name ${br} type bridge`;
    await $`sudo ip link set ${br} up`;
  }
}

export async function setupTap(tap: string): Promise<void> {
  const br = config.bridgeInterface;
  const owner = process.env.USER ?? "eve";
  await $`sudo ip tuntap add dev ${tap} mode tap user ${owner}`;
  await $`sudo ip link set ${tap} master ${br}`;
  await $`sudo ip link set ${tap} up`;
}

export async function teardownTap(tap: string): Promise<void> {
  try {
    await $`sudo ip link set ${tap} down`;
    await $`sudo ip tuntap del dev ${tap} mode tap`;
  } catch {
    // best effort
  }
}

export function deterministicMac(vmName: string): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(vmName);
  const hex = hash.digest("hex");
  return `02:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:${hex.slice(6, 8)}:${hex.slice(8, 10)}`;
}
