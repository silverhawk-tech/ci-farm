import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fresh, summarize } from '../scripts/usage-log.ts';
import type { Sample } from '../src/sampler.ts';

const s = (ts: number, host: number, slots: { id: string; cpu: number; mem: number }[]): Sample => ({
  ts, cpuPercent: host, memUsedMb: 7000 + host, memTotalMb: 22000, swapUsedMb: 1400, diskFreeGb: 300,
  slots: slots.map((x) => ({ reservationId: x.id, cpuPercent: x.cpu, memUsedMb: x.mem, memLimitMb: 8192 })),
});

test('one row per finished reservation, with peaks and averages; a running one is left out', () => {
  const rows = summarize([
    s(0, 10, [{ id: 'a', cpu: 100, mem: 500 }]), s(60000, 30, [{ id: 'a', cpu: 300, mem: 1500 }]),
    s(120000, 5, []), s(180000, 8, [{ id: 'b', cpu: 50, mem: 100 }]),
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].split(',').slice(0, 1).concat(rows[0].split(',').slice(2)), ['a', '1', '300', '200', '1500', '1000', '7030', '1400', '30']);
});

test('reservations already in the file are skipped', () => {
  assert.deepEqual(fresh(['a,x', 'b,y'], 'header\na,x\n'), ['b,y']);
});
