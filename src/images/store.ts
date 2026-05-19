import path from "path";
import { readdir, stat, unlink } from "fs/promises";
import { $ } from "bun";
import { z } from "zod";

/**
 * Metadata about a base image on disk.
 */
export interface ImageInfo {
  /** Filename inside the configured image directory. */
  filename: string;
  /** On-disk size in bytes. */
  sizeBytes: number;
  /** Image format reported by `qemu-img info`, or `"iso"` / `"unknown"`. */
  format: string;
  /** Virtual disk size (qcow2 can be sparse). Absent for ISOs / unknown. */
  virtualSizeBytes?: number;
  /** Last modification time as ISO-8601. */
  modifiedAt: string;
}

/**
 * Zod schema for `POST /api/images`.
 */
export const DownloadImageSchema = z.object({
  /** URL to download from. */
  url: z.url(),
  /**
   * Filename to save under. If omitted, the URL path basename is used
   * (sanitised against the same character set as VM names).
   */
  filename: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "must be a simple filename (no '/' or path traversal)")
    .optional(),
});

/**
 * Resolved download options after schema parsing.
 */
export type DownloadOptions = z.infer<typeof DownloadImageSchema>;

/**
 * Manages disk images available to {@link VMProvisioner}: lists what's
 * on disk, downloads new images from a URL, and deletes images. Inspects
 * each file with `qemu-img info` to surface its format and virtual size.
 */
export interface ImageStore {
  /** Enumerates known images, newest first. */
  list(): Promise<ImageInfo[]>;
  /** Downloads an image from a URL and returns its metadata. */
  download(opts: DownloadOptions): Promise<ImageInfo>;
  /** Removes an image from disk. */
  delete(filename: string): Promise<void>;
}

const FILENAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const IMAGE_EXTS = [".qcow2", ".img", ".raw", ".iso"];

/**
 * Builds an {@link ImageStore} rooted at the given directory.
 */
export function createImageStore(imageDir: string): ImageStore {
  const inspect = async (filename: string): Promise<ImageInfo> => {
    const full = path.join(imageDir, filename);
    const stats = await stat(full);
    const base: ImageInfo = {
      filename,
      sizeBytes: stats.size,
      format: filename.endsWith(".iso") ? "iso" : "unknown",
      modifiedAt: stats.mtime.toISOString(),
    };

    if (filename.endsWith(".iso")) return base;

    try {
      const out = await $`qemu-img info --output=json ${full}`.quiet().text();
      const info = JSON.parse(out) as { format?: string; "virtual-size"?: number };
      if (info.format) base.format = info.format;
      if (typeof info["virtual-size"] === "number") base.virtualSizeBytes = info["virtual-size"];
    } catch {
      // qemu-img missing or file unreadable — leave format as "unknown"
    }
    return base;
  };

  const inferFilename = (url: string): string => {
    try {
      const u = new URL(url);
      const candidate = u.pathname.split("/").filter(Boolean).pop();
      if (candidate && FILENAME_PATTERN.test(candidate) && IMAGE_EXTS.some(e => candidate.endsWith(e))) {
        return candidate;
      }
    } catch {
      // not a parseable URL — fall through
    }
    return `image-${Date.now()}.qcow2`;
  };

  return {
    async list() {
      let entries: string[];
      try {
        entries = await readdir(imageDir);
      } catch {
        return [];
      }
      const candidates = entries.filter(f => IMAGE_EXTS.some(e => f.endsWith(e)));
      const infos = await Promise.all(candidates.map(inspect));
      return infos.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    },

    async download(opts) {
      const filename = opts.filename ?? inferFilename(opts.url);
      const dest = path.join(imageDir, filename);

      if (await Bun.file(dest).exists()) {
        throw new Error(`image '${filename}' already exists`);
      }

      const res = await fetch(opts.url, { redirect: "follow" });
      if (!res.ok) {
        throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
      }
      if (!res.body) {
        throw new Error("download failed: response body was empty");
      }

      try {
        await Bun.write(dest, res);
      } catch (err) {
        await unlink(dest).catch(() => { /* nothing to roll back */ });
        throw err;
      }

      return inspect(filename);
    },

    async delete(filename) {
      if (!FILENAME_PATTERN.test(filename)) {
        throw new Error("invalid filename");
      }
      try {
        await unlink(path.join(imageDir, filename));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`image '${filename}' not found`);
        }
        throw err;
      }
    },
  };
}
