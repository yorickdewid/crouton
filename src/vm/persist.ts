import path from "path";
import { readFile, writeFile } from "fs/promises";
import type { VMConfig } from "../types";

/**
 * Shape of a legacy `crouton.json` written before the id+label split.
 * Used only for the migration path in {@link normalizeConfig}; production
 * code never reads this shape directly.
 */
interface LegacyVMConfig extends Partial<VMConfig> {
  /** Legacy single field that meant both identity and display. */
  name?: string;
}

/**
 * Returns a copy of `cfg` in canonical in-memory form:
 *
 * - `id` is filled from the directory name (`fallbackId`) when missing —
 *   that's exactly what every legacy VM's identity is anyway.
 * - `label` is filled from legacy `name`, then `id`, when missing.
 * - The legacy `name` field is dropped on the way out.
 * - `bootMode` legacy `"unknown"` is rewritten to `"uefi"`.
 * - `tags` are lowercased, trimmed, deduplicated, sorted.
 *
 * Applied on both read and write so callers can stay ignorant of the
 * migration. Idempotent.
 *
 * @param raw - Parsed JSON or in-memory config; may be legacy-shaped.
 * @param fallbackId - Directory name to use as `id` when the file
 *   predates the split. Caller's responsibility to pass the directory
 *   they're reading from.
 */
function normalizeConfig(raw: LegacyVMConfig, fallbackId: string): VMConfig {
  const id = raw.id ?? fallbackId;
  const label = raw.label ?? raw.name ?? id;
  const bootMode = (raw.bootMode as string) === "unknown" ? "uefi" : (raw.bootMode ?? "uefi");
  const tags = Array.isArray(raw.tags)
    ? Array.from(new Set(raw.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))).sort()
    : [];

  return {
    id,
    label,
    cpus: raw.cpus,
    memoryMb: raw.memoryMb,
    bootMode,
    kernelPath: raw.kernelPath,
    disks: raw.disks ?? [],
    autostart: raw.autostart,
    tags,
  };
}

/**
 * Persists per-VM configuration to `<vmDir>/<id>/crouton.json`.
 * Treated as the authoritative config when present.
 */
export interface VMConfigStore {
  /** Reads the persisted config for a VM, or `undefined` if absent. */
  read(id: string): Promise<VMConfig | undefined>;
  /** Writes the config for a VM, overwriting any existing file. */
  write(cfg: VMConfig): Promise<void>;
}

/**
 * Builds a {@link VMConfigStore} rooted at a VM directory.
 * @param vmDir - Root directory containing per-VM folders.
 */
export function createConfigStore(vmDir: string): VMConfigStore {
  const pathFor = (id: string): string => path.join(vmDir, id, "crouton.json");

  return {
    async read(id) {
      try {
        const text = await readFile(pathFor(id), "utf-8");
        return normalizeConfig(JSON.parse(text) as LegacyVMConfig, id);
      } catch {
        return undefined;
      }
    },

    async write(cfg) {
      await writeFile(pathFor(cfg.id), JSON.stringify(normalizeConfig(cfg, cfg.id), null, 2));
    },
  };
}
