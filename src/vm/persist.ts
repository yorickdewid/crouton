import path from "path";
import { readFile, writeFile } from "fs/promises";
import { config } from "../config";
import type { VMConfig } from "../types";

function configPath(name: string): string {
  return path.join(config.vmDir, name, "crouton.json");
}

export async function readVMConfig(name: string): Promise<VMConfig | undefined> {
  try {
    const text = await readFile(configPath(name), "utf-8");
    return JSON.parse(text) as VMConfig;
  } catch {
    return undefined;
  }
}

export async function writeVMConfig(cfg: VMConfig): Promise<void> {
  await writeFile(configPath(cfg.name), JSON.stringify(cfg, null, 2));
}
