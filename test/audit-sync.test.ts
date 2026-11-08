import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Audit } from '../src/audit.ts';
import { AuditStore } from '../src/auditd.ts';
import { AuditSync } from '../src/audit-sync.ts';

const mk = (tag = 'a') => new Audit(new DatabaseSync(':memory:'), () => 1000);
const add = (a: Audit, n: number, tag = 'a') => { for (let i = 0; i < n; i++) a.append({ actor: tag, actorType: 'agent', action: 'x', result: 'done', note: `${tag}${i}` }); };
const storeCall = (s: AuditStore) => async (req: object): Promise<Record<string, unknown>> => {
  const r = req as { op: string; rows?: never; head?: never };
  if (r.op === 'head') return { ok: true, head: s.head, broken: s.broken };
  if (r.op === 'append') return { ...s.append((req as { rows: never[] }).rows) };
  if (r.op === 'heartbeat') return { ok: true, ...s.heartbeat((req as { head: never }).head) };
  throw new Error('unknown op');
};

test('sync sends everything, then only the new rows; the gate opens when current', async () => {
  const a = mk(), s = new AuditStore(join(mkdtempSync(join(tmpdir(), 'ci-sync-')), 'a.jsonl'));
  add(a, 120);
  const sync = new AuditSync(a, storeCall(s));
  assert.equal(sync.gate().ok, false, 'nothing synced yet: no independent record');
  await sync.syncOnce();
  assert.equal(s.head?.seq, 120);
  assert.equal(sync.status.state, 'in_sync');
  assert.equal(sync.gate().ok, true);
  add(a, 3);
  await sync.syncOnce();
  assert.equal(s.head?.seq, 123);
  assert.equal(s.refusals, 0, 'no duplicates were re-sent');
});

test('an unreachable receiver closes the gate at once, a stalled sync loop closes it after the staleness window, and it recovers when the receiver returns', async () => {
  const a = mk(), s = new AuditStore(join(mkdtempSync(join(tmpdir(), 'ci-sync-')), 'a.jsonl'));
  add(a, 2);
  let t = 1_000_000, down = false;
  const call = storeCall(s);
  const sync = new AuditSync(a, async (r) => { if (down) throw new Error('connect ENOENT'); return call(r); }, { now: () => t });
  await sync.syncOnce();
  assert.equal(sync.gate().ok, true);
  t += 120_000; // the sync loop stopped running: the last good round is too old
  assert.deepEqual(sync.gate(), { ok: false, reason: 'audit receiver unreachable' });
  down = true; await sync.syncOnce();
  assert.deepEqual(sync.gate(), { ok: false, reason: 'audit receiver unreachable' });
  down = false; add(a, 1); await sync.syncOnce();
  assert.equal(sync.gate().ok, true);
  assert.equal(s.head?.seq, 3);
});

test('a receiver that acknowledges but never advances closes the gate and does not loop', async () => {
  const a = mk(), s = new AuditStore(join(mkdtempSync(join(tmpdir(), 'ci-sync-')), 'a.jsonl'));
  add(a, 10);
  const call = storeCall(s);
  const sync = new AuditSync(a, async (r) => ((r as { op: string }).op === 'append' ? { ok: true, head: s.head } : call(r))); // appends silently go nowhere
  await sync.syncOnce();
  assert.equal(sync.status.reachable, false, 'an ok that does not advance is treated as a broken receiver, not retried forever');
  assert.equal(sync.gate().ok, false);
});

test('two histories that disagree are flagged as tampering and close the gate', async () => {
  const real = mk(), other = mk(), s = new AuditStore(join(mkdtempSync(join(tmpdir(), 'ci-sync-')), 'a.jsonl'));
  add(real, 4, 'real'); await new AuditSync(real, storeCall(s)).syncOnce(); // the receiver holds the real history
  add(other, 6, 'forged'); // the controller's database was rewritten with a different, longer history
  const sync = new AuditSync(other, storeCall(s));
  await sync.syncOnce();
  assert.equal(sync.tampered(), true);
  assert.equal(sync.gate().ok, false);
  assert.equal(s.head?.seq, 4, 'the receiver kept the real history untouched');
  assert.equal(s.refusals, 0, 'caught by the head cross-check before any row was sent');
});

test('a backlog bigger than one round leaves the receiver more than 5 rows behind: the gate closes until it catches up', async () => {
  const a = mk(), s = new AuditStore(join(mkdtempSync(join(tmpdir(), 'ci-sync-')), 'a.jsonl'));
  add(a, 5100); // one round sends at most 100 batches of 50
  const sync = new AuditSync(a, storeCall(s));
  await sync.syncOnce();
  assert.equal(sync.status.lag, 100);
  assert.match(sync.gate().reason ?? '', /100 rows behind/);
  await sync.syncOnce();
  assert.equal(sync.gate().ok, true);
  assert.equal(s.head?.seq, 5100);
});

test('hostile or broken receivers never open the gate: wrong shapes, fake in_sync, acknowledged-but-unstored rows, foreign history', async () => {
  const a = mk(), real = new AuditStore(join(mkdtempSync(join(tmpdir(), 'ci-sync-')), 'a.jsonl'));
  add(a, 3);
  const bad: Array<[string, (r: object) => Promise<unknown>]> = [
    ['not an object', async () => 'ok'],
    ['ok:false head reply', async () => ({ ok: false, head: null, broken: '' })],
    ['extra keys', async (r) => ({ ...(await storeCall(real)(r)), extra: 1 })],
    ['acknowledges rows it did not store', async (r) => ((r as { op: string }).op === 'head' ? { ok: true, head: null, broken: '' } : (r as { op: string }).op === 'append' ? { ok: true, head: { seq: 2, hash: a.hashAt(2)! } } : { ok: true, state: 'in_sync', lag: 0, head: a.head() })],
    ['in_sync with lag', async (r) => { const o = await storeCall(real)(r) as Record<string, unknown>; return (r as { op: string }).op === 'heartbeat' ? { ...o, state: 'in_sync', lag: 3 } : o; }],
  ];
  for (const [name, call] of bad) {
    const sync = new AuditSync(a, call as never);
    await sync.syncOnce();
    assert.equal(sync.gate().ok, false, name);
  }
  const foreign = mk(); add(foreign, 3, 'forged'); // a receiver that already holds some other history
  const fs = new AuditStore(join(mkdtempSync(join(tmpdir(), 'ci-sync-')), 'a.jsonl')); fs.append(foreign.rowsAfter(0, 50));
  const sync = new AuditSync(a, storeCall(fs));
  await sync.syncOnce();
  assert.equal(sync.tampered(), true);
});

test('overlapping rounds are one round (a slow receiver cannot make the controller look tampered)', async () => {
  const a = mk(), s = new AuditStore(join(mkdtempSync(join(tmpdir(), 'ci-sync-')), 'a.jsonl'));
  add(a, 3);
  const call = storeCall(s); let calls = 0;
  const sync = new AuditSync(a, async (r) => { calls++; await new Promise((x) => setTimeout(x, 20)); return call(r); });
  await Promise.all([sync.syncOnce(), sync.syncOnce(), sync.syncOnce()]);
  assert.equal(calls, 3, 'head, append, heartbeat once, not three times over');
  assert.equal(sync.status.state, 'in_sync');
  assert.equal(s.refusals, 0);
});
