import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { Audit } from '../src/audit.ts';
import { AuditStore, startAuditd } from '../src/auditd.ts';
import { brokerCall } from '../src/broker-client.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'ci-auditd-'));
function chain(n: number, tag = 'a') {
  const a = new Audit(new DatabaseSync(':memory:'), () => 1000);
  for (let i = 0; i < n; i++) a.append({ actor: tag, actorType: 'agent', action: 'x', result: 'done', note: `n${i}` });
  return a;
}

test('a valid continuing chain is accepted and survives a restart (reload verifies the file)', () => {
  const f = join(dir(), 'audit.jsonl'), a = chain(5);
  const s = new AuditStore(f);
  assert.equal(s.append(a.rowsAfter(0, 50)).ok, true);
  assert.equal(s.head?.seq, 5);
  const again = new AuditStore(f);
  assert.equal(again.broken, '');
  assert.deepEqual({ ...again.head }, { ...a.head() });
});

test('gaps, rewinds, wrong prev_hash and wrong hashes are refused and counted; nothing after the bad row is written', () => {
  const f = join(dir(), 'audit.jsonl'), a = chain(4);
  const rows = a.rowsAfter(0, 50);
  const s = new AuditStore(f);
  assert.equal(s.append([rows[0]]).ok, true);
  assert.equal(s.append([rows[2]]).ok, false, 'gap');
  assert.equal(s.append([rows[0]]).ok, false, 'rewind / duplicate');
  assert.equal(s.append([{ ...rows[1], prev_hash: 'f'.repeat(64) }]).ok, false, 'wrong prev_hash');
  assert.equal(s.append([{ ...rows[1], note: 'edited' }]).ok, false, 'row changed after hashing');
  const partial = s.append([rows[1], { ...rows[2], note: 'edited' }, rows[3]]);
  assert.equal(partial.ok, false);
  assert.equal(s.head?.seq, 2, 'the valid prefix is kept, the rest is not');
  assert.equal(s.refusals, 5);
});

test('heartbeat: behind is lagging, shorter or a different hash at the same seq is tampering', () => {
  const s = new AuditStore(join(dir(), 'audit.jsonl')), a = chain(3);
  assert.equal(s.heartbeat(null).state, 'in_sync');
  assert.deepEqual({ ...s.heartbeat(a.head()) }, { state: 'lagging', lag: 3, head: null });
  s.append(a.rowsAfter(0, 50));
  assert.equal(s.heartbeat(a.head()).state, 'in_sync');
  assert.equal(s.heartbeat({ seq: 2, hash: 'a'.repeat(64) }).state, 'tampered', 'sender is shorter than the receiver');
  assert.equal(s.heartbeat({ seq: 3, hash: 'b'.repeat(64) }).state, 'tampered', 'same seq, different hash');
  assert.equal(s.heartbeat(null).state, 'tampered', 'sender claims to be empty but the receiver holds rows');
});

test('an edited receiver file makes the receiver refuse to vouch for anything', () => {
  const f = join(dir(), 'audit.jsonl'), a = chain(3);
  const s = new AuditStore(f); s.append(a.rowsAfter(0, 50));
  writeFileSync(f, readFileSync(f, 'utf8').replace('"note":"n1"', '"note":"nX"'));
  const t = new AuditStore(f);
  assert.match(t.broken, /chain broken at seq 2/);
  assert.equal(t.append(chain(1).rowsAfter(0, 5)).ok, false);
  assert.equal(t.heartbeat(a.head()).state, 'tampered');
});

test('over the socket: append, head, heartbeat and anchor work; junk, oversize and a second request per connection do not', async () => {
  const d = dir(), sock = join(d, 'a.sock'), a = chain(3);
  const store = new AuditStore(join(d, 'audit.jsonl'));
  const server = await startAuditd({ socketPath: sock, store });
  try {
    assert.equal((await brokerCall<{ ok: boolean }>(sock, { op: 'append', rows: a.rowsAfter(0, 50) })).ok, true);
    assert.equal((await brokerCall<{ head: { seq: number } }>(sock, { op: 'head' })).head.seq, 3);
    assert.equal((await brokerCall<{ state: string }>(sock, { op: 'heartbeat', head: a.head() })).state, 'in_sync');
    assert.equal((await brokerCall<{ anchor: { seq: number } }>(sock, { op: 'anchor' })).anchor.seq, 3);
    assert.equal((await brokerCall<{ ok: boolean }>(sock, { op: 'nope' })).ok, false);
    assert.equal((await brokerCall<{ ok: boolean }>(sock, { op: 'append', rows: [{ seq: 4 }] })).ok, false, 'schema violations are refused');
    assert.equal(store.head?.seq, 3);
    // two requests on one connection: only the first is answered or executed
    const out = await new Promise<string>((resolve) => {
      const c = connect(sock); let buf = '';
      c.on('connect', () => c.write(JSON.stringify({ op: 'head' }) + '\n' + JSON.stringify({ op: 'append', rows: a.rowsAfter(2, 5) }) + '\n'));
      c.on('data', (x) => (buf += x)); c.on('close', () => resolve(buf));
    });
    assert.equal(out.trim().split('\n').length, 1);
    assert.equal(store.head?.seq, 3);
    // oversize frame is dropped
    await new Promise<void>((resolve) => { const c = connect(sock); c.on('connect', () => c.write('x'.repeat(1_100_000))); c.on('close', () => resolve()); c.on('error', () => resolve()); });
  } finally { server.close(); }
});

test('a torn final line (power cut mid-append) is recovered in an append-only way; the same junk mid-file is tampering', () => {
  const f = join(dir(), 'audit.jsonl'), a = chain(4);
  const rows = a.rowsAfter(0, 50);
  new AuditStore(f).append(rows.slice(0, 3));
  appendFileSync(f, '{"t":"row","seq":4,"ts":10'); // the write was cut short, no newline
  const s = new AuditStore(f);
  assert.equal(s.broken, '');
  assert.equal(s.head?.seq, 3, 'the torn row is simply not held; the sender will resend it');
  assert.equal(s.append([rows[3]]).ok, true);
  const again = new AuditStore(f);
  assert.equal(again.broken, '');
  assert.equal(again.head?.seq, 4);
  assert.match(readFileSync(f, 'utf8'), /"t":"recovered"/);
  // junk followed by anything other than the matching recovery record is not forgiven
  const g = join(dir(), 'audit.jsonl');
  new AuditStore(g).append(rows.slice(0, 2));
  appendFileSync(g, 'garbage\n');
  assert.match(new AuditStore(g).broken, /unreadable/);
});
