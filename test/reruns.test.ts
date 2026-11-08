import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Reruns } from '../src/reruns.ts';

const lim = { perRun: 2, perHour: 6 };
const mk = (now = () => 1_000_000) => new Reruns(new DatabaseSync(':memory:'), now);

test('at most 2 re-runs per run, then it refuses and says to report', () => {
  const r = mk();
  for (let i = 0; i < 2; i++) { const x = r.reserve('o/r', 7, 'claude', 'flaky network', lim); assert.ok(x.ok); r.finish((x as { id: number }).id, 'ok'); }
  const third = r.reserve('o/r', 7, 'claude', 'again', lim);
  assert.equal(third.ok, false);
  assert.match((third as { reason: string }).reason, /report it to a human/);
});

test('hourly cap counts across runs and lapses after an hour', () => {
  let t = 1_000_000;
  const r = mk(() => t);
  for (let run = 1; run <= 6; run++) { const x = r.reserve('o/r', run, 'claude', 'why', lim) as { id: number }; r.finish(x.id, 'ok'); }
  assert.equal(r.reserve('o/r', 99, 'claude', 'why', lim).ok, false);
  assert.equal(r.reserve('o/r', 99, 'codex', 'why', lim).ok, false, 'the hourly cap is global: another actor cannot add six more');
  t += 3_600_001;
  assert.equal(r.reserve('o/r', 100, 'codex', 'why', lim).ok, true);
});

test('calls GitHub rejected do not consume quota, but in-flight and uncertain ones block and consume', () => {
  const r = mk();
  const a = r.reserve('o/r', 7, 'claude', 'x', lim) as { id: number };
  assert.equal(r.reserve('o/r', 7, 'claude', 'x', lim).ok, false, 'serialised per run while in flight');
  r.finish(a.id, 'rejected');
  const b = r.reserve('o/r', 7, 'claude', 'x', lim) as { id: number; attempt: number };
  assert.equal(b.attempt, 1, 'rejected attempt did not count');
  r.finish(b.id, 'uncertain');
  assert.equal(r.reserve('o/r', 7, 'claude', 'x', lim).ok, false, 'uncertain blocks until reconciled');
});

test('a reason is mandatory; a crash mid-call becomes uncertain', () => {
  const r = mk();
  assert.equal(r.reserve('o/r', 7, 'claude', '  ', lim).ok, false);
  r.reserve('o/r', 8, 'claude', 'x', lim);
  r.markCrashedUncertain();
  assert.equal(r.reserve('o/r', 8, 'claude', 'x', lim).ok, false);
});
