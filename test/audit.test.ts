import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Audit, redact } from '../src/audit.ts';

const ev = (n: number) => ({ actor: 'claude', actorType: 'agent' as const, action: 'pause', target: { n }, result: 'ok' });

test('a clean chain verifies; head is exportable', () => {
  const a = new Audit(new DatabaseSync(':memory:'));
  for (let i = 0; i < 5; i++) a.append(ev(i));
  assert.deepEqual(a.verify(), { ok: true, rows: 5 });
  assert.equal(a.head()?.seq, 5);
});

test('editing a row in the middle breaks the chain at that row', () => {
  const db = new DatabaseSync(':memory:');
  const a = new Audit(db);
  for (let i = 0; i < 5; i++) a.append(ev(i));
  db.prepare("UPDATE audit SET result = 'denied' WHERE seq = 3").run();
  assert.deepEqual(a.verify(), { ok: false, brokenAt: 3 });
});

test('deleting a middle row breaks the chain; truncating the end is caught by a saved checkpoint', () => {
  const db = new DatabaseSync(':memory:');
  const a = new Audit(db);
  for (let i = 0; i < 5; i++) a.append(ev(i));
  const checkpoint = a.head()!;
  db.prepare('DELETE FROM audit WHERE seq = 2').run();
  assert.equal(a.verify().ok, false);
  const db2 = new DatabaseSync(':memory:');
  const b = new Audit(db2);
  for (let i = 0; i < 5; i++) b.append(ev(i));
  db2.prepare('DELETE FROM audit WHERE seq = 5').run();
  assert.equal(b.verify().ok, true, 'chain itself cannot see a shortened end');
  assert.ok(b.head()!.seq < checkpoint.seq, 'but the exported checkpoint can');
});

test('credentials never reach the log, by key name or by value shape', () => {
  const a = new Audit(new DatabaseSync(':memory:'));
  a.append({ actor: 'x', actorType: 'system', action: 'mint', params: { encoded_jit_config: 'abc', note: 'ghs_' + 'A'.repeat(36), blob: 'B'.repeat(250), ok: 'fine' }, result: 'ok', note: 'token ghp_' + 'C'.repeat(36) });
  const row = a.list(1)[0];
  assert.ok(!/ghs_|ghp_|B{20}|abc/.test(row.params + row.note));
  assert.match(row.params, /"ok":"fine"/);
  assert.deepEqual(redact({ Authorization: 'Bearer x' }), { Authorization: '[redacted]' });
});
