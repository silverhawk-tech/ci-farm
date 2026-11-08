import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateDb, type ReserveRequest } from '../src/state.ts';

const file = () => join(mkdtempSync(join(tmpdir(), 'ci-state-')), 's.sqlite');
const job = (n: number, project = 'app1'): ReserveRequest => ({ project, repo: `o/${project}`, run_id: 1, job_id: n, head_sha: 'abc', pr_number: 7 });
const lim = (p: number, g: number) => ({ projectMaxSlots: p, globalMaxSlots: g });

test('per-project and global limits hold, and slots are reused lowest-first after teardown', () => {
  const db = new StateDb(file());
  const a = db.reserve(job(1), lim(2, 3))!;
  const b = db.reserve(job(2), lim(2, 3))!;
  assert.deepEqual([a.slot, b.slot], [1, 2]);
  assert.equal(db.reserve(job(3), lim(2, 3)), null, 'project limit 2');
  assert.ok(db.reserve(job(4, 'other'), lim(2, 3)), 'other project still fits');
  assert.equal(db.reserve(job(5, 'third'), lim(2, 3)), null, 'global limit 3');
  db.transition(a.id, 'failed', { error: 'x' });
  assert.equal(db.reserve(job(6), lim(2, 3)), null, 'failed still holds its slot until torn down');
  db.transition(a.id, 'torn_down');
  assert.equal(db.reserve(job(6), lim(2, 3))!.slot, 1);
});

test('the same job cannot be reserved twice', () => {
  const db = new StateDb(file());
  assert.ok(db.reserve(job(1), lim(2, 4)));
  assert.equal(db.reserve(job(1), lim(2, 4)), null);
});

test('only legal lifecycle transitions are allowed', () => {
  const db = new StateDb(file());
  const r = db.reserve(job(1), lim(1, 1))!;
  assert.throws(() => db.transition(r.id, 'running'), /illegal transition reserved -> running/);
  for (const s of ['minted', 'started', 'running', 'finished', 'torn_down'] as const) db.transition(r.id, s);
  assert.throws(() => db.transition(r.id, 'minted'), /illegal transition/);
});

test('two connections to the same file cannot overshoot the limit; state survives reopen', () => {
  const f = file();
  const one = new StateDb(f), two = new StateDb(f);
  assert.ok(one.reserve(job(1), lim(1, 1)));
  assert.equal(two.reserve(job(2), lim(1, 1)), null);
  one.close();
  assert.equal(new StateDb(f).live().length, 1);
});

test('the lease is exclusive, renewable by its owner, and lapses', () => {
  const f = file();
  let t = 1000;
  const a = new StateDb(f, () => t), b = new StateDb(f, () => t);
  assert.equal(a.acquireLease('A', 60_000), true);
  assert.equal(b.acquireLease('B', 60_000), false);
  assert.equal(a.acquireLease('A', 60_000), true, 'owner renews');
  t += 61_000;
  assert.equal(b.acquireLease('B', 60_000), true, 'lapsed lease can be taken');
  assert.equal(a.acquireLease('A', 60_000), false);
});

test('a clean shutdown releases the lease at once, and only the owner can', () => {
  const f = file();
  const a = new StateDb(f, () => 1000), b = new StateDb(f, () => 1000);
  assert.equal(a.acquireLease('A', 60_000), true);
  b.releaseLease('B');
  assert.equal(b.acquireLease('B', 60_000), false, 'a non-owner cannot release it');
  a.releaseLease('A');
  assert.equal(b.acquireLease('B', 60_000), true);
});

test('the instance id is created once and stable', () => {
  const f = file();
  const id = new StateDb(f).instanceId();
  assert.match(id, /^[0-9a-f]{6}$/);
  assert.equal(new StateDb(f).instanceId(), id);
});

test('held slots never push a reservation beyond the configured slot count', () => {
  const db = new StateDb(file());
  assert.equal(db.reserve(job(1), lim(2, 2), [1, 2]), null);
  assert.equal(db.reserve(job(2), lim(2, 2), [1])!.slot, 2);
});
