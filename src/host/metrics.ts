import { readFile, statfs } from "fs/promises";
import { cpus } from "os";

/**
 * A single sample of host-side resource metrics.
 */
export interface HostMetricsSnapshot {
  /** Logical CPU count (static). */
  cpus: number;
  /** Overall host CPU utilization in [0, 1] over the interval since the last sample. */
  cpuUsage: number;
  /** Total memory in MB (static). */
  memTotalMb: number;
  /** Currently-used memory in MB (`MemTotal - MemAvailable`). */
  memUsedMb: number;
  /** Linux 1-, 5-, 15-minute load averages. */
  loadAvg: [number, number, number];
  /** Total bytes on the filesystem holding the VM directory. */
  diskTotalBytes: number;
  /** Free bytes on the same filesystem. */
  diskFreeBytes: number;
}

/**
 * Read-side wrapper for `/proc/{stat,meminfo,loadavg}` and a `statfs` of the VM dir.
 * The implementation is stateful: CPU% requires the previous reading to compute a delta.
 */
export interface HostMetrics {
  /** Collects a single snapshot. Subsequent calls use the previous CPU reading as a baseline. */
  collect(): Promise<HostMetricsSnapshot>;
}

/**
 * Builds a {@link HostMetrics}.
 * @param diskPath - Filesystem path used to query disk space (typically the VM directory).
 */
export function createHostMetrics(diskPath: string): HostMetrics {
  let prevCpu: { idle: number; total: number } | null = null;
  const cpuCount = cpus().length;

  const readCpuTimes = async () => {
    const text = await readFile("/proc/stat", "utf-8");
    // First line: "cpu  user nice system idle iowait irq softirq steal guest guest_nice"
    const fields = text.split("\n", 1)[0].split(/\s+/).slice(1).map(Number);
    const idle = (fields[3] ?? 0) + (fields[4] ?? 0); // idle + iowait
    const total = fields.reduce((a, b) => a + b, 0);
    return { idle, total };
  };

  return {
    async collect() {
      const cur = await readCpuTimes();
      let cpuUsage = 0;
      if (prevCpu) {
        const idleDelta = cur.idle - prevCpu.idle;
        const totalDelta = cur.total - prevCpu.total;
        cpuUsage = totalDelta > 0 ? Math.max(0, Math.min(1, 1 - idleDelta / totalDelta)) : 0;
      }
      prevCpu = cur;

      const memText = await readFile("/proc/meminfo", "utf-8");
      const memTotalKb = Number(memText.match(/MemTotal:\s+(\d+)/)?.[1] ?? 0);
      const memAvailKb = Number(memText.match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0);
      const memTotalMb = Math.round(memTotalKb / 1024);
      const memUsedMb = Math.round((memTotalKb - memAvailKb) / 1024);

      const loadText = await readFile("/proc/loadavg", "utf-8");
      const loadParts = loadText.split(/\s+/).slice(0, 3).map(Number);
      const loadAvg: [number, number, number] = [loadParts[0] ?? 0, loadParts[1] ?? 0, loadParts[2] ?? 0];

      let diskTotalBytes = 0, diskFreeBytes = 0;
      try {
        const stat = await statfs(diskPath);
        diskTotalBytes = Number(stat.blocks) * Number(stat.bsize);
        diskFreeBytes = Number(stat.bavail) * Number(stat.bsize);
      } catch {
        // statfs unavailable or path missing — leave at zero
      }

      return {
        cpus: cpuCount,
        cpuUsage,
        memTotalMb,
        memUsedMb,
        loadAvg,
        diskTotalBytes,
        diskFreeBytes,
      };
    },
  };
}
