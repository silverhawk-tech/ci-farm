// Appends one row per finished slot job (reservation) to docs/usage-log.csv, from the controller's 24h resource samples.
// Usage: node scripts/usage-log.ts [csv path]   (run it at least once a day; already-logged reservations are skipped)
// Peaks and averages are for the slot (cpu 100 = one core); host_* are the whole machine while that job ran.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Sample } from '../src/sampler.ts';

export const HEADER = 'reservation,start,minutes,slot_cpu_peak,slot_cpu_avg,slot_mem_peak_mb,slot_mem_avg_mb,host_mem_peak_mb,host_swap_peak_mb,host_cpu_peak';
const round = (n: number) => Math.round(n * 10) / 10;
const peak = (a: number[]) => Math.max(...a);
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

/** Group samples by slot reservation. A reservation still present in the newest sample is still running and is left out. */
export function summarize(samples: Sample[]): string[] {
  const last = samples.at(-1);
  const running = new Set(last?.slots.map((s) => s.reservationId));
  const by = new Map<string, { s: Sample; u: Sample['slots'][number] }[]>();
  for (const s of samples) for (const u of s.slots) by.set(u.reservationId, [...(by.get(u.reservationId) ?? []), { s, u }]);
  return [...by].filter(([id]) => !running.has(id)).map(([id, rows]) => {
    const t = rows.map((r) => r.s.ts);
    return [id, new Date(t[0]).toISOString(), round((t.at(-1)! - t[0]) / 60000),
      round(peak(rows.map((r) => r.u.cpuPercent))), round(avg(rows.map((r) => r.u.cpuPercent))),
      peak(rows.map((r) => r.u.memUsedMb)), Math.round(avg(rows.map((r) => r.u.memUsedMb))),
      peak(rows.map((r) => r.s.memUsedMb)), peak(rows.map((r) => r.s.swapUsedMb)), round(peak(rows.map((r) => r.s.cpuPercent)))].join(',');
  });
}

/** Rows whose reservation id is not in the file yet. */
export const fresh = (rows: string[], existing: string) => rows.filter((r) => !existing.includes(r.split(',')[0]));

if (process.argv[1]?.endsWith('usage-log.ts')) {
  const token = readFileSync(process.env.CI_TOKEN_FILE ?? `${homedir()}/.config/ci-master/${process.env.CI_AGENT ?? 'claude'}.token`, 'utf8').trim();
  const r = await fetch((process.env.CI_API_URL ?? 'http://127.0.0.1:8787') + '/v1/resources', { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) { console.error('resources read failed', r.status); process.exit(1); }
  const samples = ((await r.json()) as { data: Sample[] }).data;
  const file = process.argv[2] ?? new URL('../docs/usage-log.csv', import.meta.url).pathname;
  if (!existsSync(file)) appendFileSync(file, HEADER + '\n');
  const rows = fresh(summarize(samples), readFileSync(file, 'utf8'));
  if (rows.length) appendFileSync(file, rows.join('\n') + '\n');
  console.log(`${rows.length} new job(s) logged to ${file}`);
}
