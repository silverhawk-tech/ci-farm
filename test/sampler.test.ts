import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Sampler, cpuPercent, parseCpuTimes, parseMem, parseSize } from '../src/sampler.ts';

test('CPU percent from two /proc/stat readings', () => {
  const a = parseCpuTimes('cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 1 1 1');
  const b = parseCpuTimes('cpu  200 0 200 800 100 0 0 0 0 0\ncpu0 1 1 1 1');
  assert.equal(cpuPercent(a, b), 66.7);
  assert.equal(cpuPercent(a, a), 0);
});

test('memory uses MemAvailable, not MemFree (cache is not "used")', () => {
  const m = parseMem('MemTotal:       20480000 kB\nMemFree:          100000 kB\nMemAvailable:   10240000 kB\nSwapTotal:       2048000 kB\nSwapFree:        1024000 kB\n');
  assert.deepEqual(m, { memTotalMb: 20000, memUsedMb: 10000, swapUsedMb: 1000 });
});

test('docker size strings', () => {
  assert.equal(parseSize('1.5GiB'), 1536);
  assert.equal(parseSize('512MiB'), 512);
  assert.equal(parseSize('2048KiB'), 2);
  assert.equal(parseSize('nonsense'), 0);
});

test('samples are stored, returned oldest first, and pruned after 24 hours', () => {
  let t = 1_000_000_000_000;
  const stats = ['cpu 0 0 0 100 0', 'cpu 50 0 0 150 0', 'cpu 100 0 0 200 0'];
  let i = 0;
  const s = new Sampler(new DatabaseSync(':memory:'), () => t, () => stats[Math.min(i++, 2)]);
  const mem = () => 'MemTotal: 1024 kB\nMemAvailable: 512 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n';
  const first = s.take([], '/nonexistent', mem);
  assert.equal(first.cpuPercent, 50);
  t += 60_000; s.take([{ reservationId: 'r', cpuPercent: 100, memUsedMb: 5, memLimitMb: 6144 }], '/nonexistent', mem);
  assert.deepEqual(s.history().map((x) => x.ts), [1_000_000_000_000, 1_000_000_060_000]);
  t += 25 * 3_600_000; s.take([], '/nonexistent', mem);
  assert.equal(s.history().length, 1);
});
