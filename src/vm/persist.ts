import path from "path";
import { readFile, writeFile } from "fs/promises";
import type { VMConfig } from "../types";

/**
 * Persists per-VM configuration to `<vmDir>/<name>/crouton.json`.
 * Treated as the authoritative config when present.
 */
export interface VMConfigStore {
  /** Reads the persisted config for a VM, or `undefined` if absent. */
  read(name: string): Promise<VMConfig | undefined>;
  /** Writes the config for a VM, overwriting any existing file. */
  write(cfg: VMConfig): Promise<void>;
}

/**
 * Builds a {@link VMConfigStore} rooted at a VM directory.
 * @param vmDir - Root directory containing per-VM folders.
 */
export function createConfigStore(vmDir: string): VMConfigStore {
  const pathFor = (name: string): string => path.join(vmDir, name, "crouton.json");

  return {
    async read(name) {
      try {
        const text = await readFile(pathFor(name), "utf-8");
        return JSON.parse(text) as VMConfig;
      } catch {
        return undefined;
      }
    },

    async write(cfg) {
      await writeFile(pathFor(cfg.name), JSON.stringify(cfg, null, 2));
    },
  };
}
