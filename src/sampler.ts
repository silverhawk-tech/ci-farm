import { readFileSync, statfsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

// Machine and per-slot resource history (plan 3.5/3.7): feeds the dashboard, the agents' resources read and, later, the memory guard.
// Host numbers come from /proc (no Docker access needed); per-slot numbers come from the broker's stats call.

export interface CpuTimes { idle: number; total: number }
export interface SlotUsage { reservationId: string; cpuPercent: number; memUsedMb: number; memLimitMb: number }
export interface Sample { ts: number; cpuPercent: number; memUsedMb: number; memTotalMb: number; swapUsedMb: number; diskFreeGb: number; slots: SlotUsage[] }

/** First "cpu " line of /proc/stat -> idle and total jiffies. */
export function parseCpuTimes(stat: string): CpuTimes {
  const f = stat.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = f[3] + (f[4] ?? 0); // idle + iowait
  return { idle, total: f.reduce((a, b) => a + b, 0) };
}
export const cpuPercent = (a: CpuTimes, b: CpuTimes) => (b.total === a.total ? 0 : Math.round((1 - (b.idle - a.idle) / (b.total - a.total)) * 1000) / 10);

/** MemAvailable is what is really usable; "used" = total - available (page cache is not counted as used). */
export function parseMem(meminfo: string): { memUsedMb: number; memTotalMb: number; swapUsedMb: number } {
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1] ?? 0);
  const mb = (x: number) => Math.round(x / 1024);
  return { memTotalMb: mb(kb('MemTotal')), memUsedMb: mb(kb('MemTotal') - kb('MemAvailable')), swapUsedMb: mb(kb('SwapTotal') - kb('SwapFree')) };
}

/** `docker stats` row like "cpu=210.5% mem=1.2GiB / 6GiB" pieces parsed into numbers. */
export function parseSize(s: string): number {
  const m = /^([\d.]+)\s*([KMG]i?B|B)$/i.exec(s.trim());
  if (!m) return 0;
  const n = Number(m[1]), u = m[2].toUpperCase();
  return Math.round(u.startsWith('G') ? n * 1024 : u.startsWith('K') ? n / 1024 : u === 'B' ? n / 1048576 : n);
}

export class Sampler {
  private db: DatabaseSync;
  private prev: CpuTimes;
  private now: () => number;
  private readStat: () => string;
  constructor(db: DatabaseSync, now: () => number = Date.now, readStat: () => string = () => readFileSync('/proc/stat', 'utf8')) {
    this.readStat = readStat; this.db = db; this.now = now; this.prev = parseCpuTimes(this.readStat());
    db.exec('CREATE TABLE IF NOT EXISTS sample (ts INTEGER PRIMARY KEY, data TEXT NOT NULL)');
  }
  /** Take one sample; `slots` comes from the broker. Keeps 24 hours. */
  take(slots: SlotUsage[], diskPath = '/var/lib/ci-control', readMem: () => string = () => readFileSync('/proc/meminfo', 'utf8')): Sample {
    const cur = parseCpuTimes(this.readStat());
    const cpu = cpuPercent(this.prev, cur); this.prev = cur;
    let diskFreeGb = 0;
    try { const s = statfsSync(diskPath); diskFreeGb = Math.round((s.bavail * s.bsize) / 1073741824 * 10) / 10; } catch { /* path missing in tests */ }
    const sample: Sample = { ts: this.now(), cpuPercent: cpu, ...parseMem(readMem()), diskFreeGb, slots };
    this.db.prepare('INSERT OR REPLACE INTO sample (ts, data) VALUES (?, ?)').run(sample.ts, JSON.stringify(sample));
    this.db.prepare('DELETE FROM sample WHERE ts < ?').run(sample.ts - 24 * 3_600_000);
    return sample;
  }
  /** Newest `limit` samples, oldest first, for graphs. */
  history(limit = 360): Sample[] {
    return (this.db.prepare('SELECT data FROM sample ORDER BY ts DESC LIMIT ?').all(limit) as { data: string }[]).map((r) => JSON.parse(r.data) as Sample).reverse();
  }
}
