import path from "path";
import { readFile, writeFile } from "fs/promises";
import type { VMConfig } from "../types";

/**
 * Persists per-VM configuration to `<vmDir>/<name>/crouton.json`.
 * Treated as the authoritative config when present.
 */
export class VMConfigStore {
  /**
   * @param vmDir - Root directory containing per-VM folders.
   */
  constructor(private readonly vmDir: string) { }

  /**
   * Reads the persisted config for a VM, if one exists.
   * @param name - VM name.
   * @returns Parsed config, or `undefined` if no config file exists or it's unreadable.
   */
  async read(name: string): Promise<VMConfig | undefined> {
    try {
      const text = await readFile(this.pathFor(name), "utf-8");
      return JSON.parse(text) as VMConfig;
    } catch {
      return undefined;
    }
  }

  /**
   * Writes the config for a VM, overwriting any existing file.
   * @param cfg - Config to persist; `cfg.name` determines the file location.
   */
  async write(cfg: VMConfig): Promise<void> {
    await writeFile(this.pathFor(cfg.name), JSON.stringify(cfg, null, 2));
  }

  /**
   * Resolves the file path that holds the config for a given VM.
   */
  private pathFor(name: string): string {
    return path.join(this.vmDir, name, "crouton.json");
  }
}
