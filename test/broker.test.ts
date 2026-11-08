import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { startBroker } from '../src/broker.ts';
import { brokerCall } from '../src/broker-client.ts';
import { loadRegistry } from '../src/registry.ts';
import type { IsolationBackend, SlotSpec } from '../src/launcher.ts';

const registry = loadRegistry(readFileSync(new URL('../config/registry.example.yaml', import.meta.url), 'utf8'));
const id = '11111111-2222-3333-4444-555555555555';
const PIN = 'ci-master/slot@sha256:' + 'a'.repeat(64);

async function setup(globalMaxSlots = 2) {
  const calls: { op: string; arg?: unknown }[] = [];
  const live: { reservationId: string; running: boolean; project: string; slot: number }[] = [];
  const backend: IsolationBackend = {
    async start(s: SlotSpec) { calls.push({ op: 'start', arg: s }); live.push({ reservationId: s.reservationId, running: true, project: s.project, slot: s.slot }); },
    async deliverJit(r, j) { calls.push({ op: 'deliver', arg: [r, j] }); },
    async stop(r) { calls.push({ op: 'stop', arg: r }); },
    async list() { return [...live]; }, async stats() { return [{ reservationId: id, cpuPercent: 12.5, memUsedMb: 100, memLimitMb: 6144 }]; },
  };
  const socketPath = join(mkdtempSync(join(tmpdir(), 'ci-broker-')), 'b.sock');
  const server = await startBroker({ socketPath, backend, registry, image: PIN, globalMaxSlots });
  return { calls, live, socketPath, close: () => server.close() };
}

test('start uses image and limits from the broker registry, not from the request', async () => {
  const b = await setup();
  try {
    const r = await brokerCall(b.socketPath, { op: 'start', reservationId: id, slot: 1, project: 'myapp' });
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(b.calls[0].arg, { reservationId: id, slot: 1, project: 'myapp', image: PIN, memory: '6g', cpus: 3, pids: 4096 });
    // a caller cannot smuggle its own limits or image: unknown fields are rejected
    const bad = await brokerCall<{ ok: boolean; error?: string }>(b.socketPath, { op: 'start', reservationId: id, slot: 1, project: 'myapp', memory: '64g', image: 'evil' });
    assert.equal(bad.ok, false);
    assert.equal(b.calls.length, 1);
  } finally { b.close(); }
});

test('unknown project, bad ids and unknown ops are refused', async () => {
  const b = await setup();
  try {
    assert.equal((await brokerCall<{ ok: boolean; error?: string }>(b.socketPath, { op: 'start', reservationId: id, slot: 1, project: 'nope' })).error, 'unknown project');
    assert.equal((await brokerCall<{ ok: boolean }>(b.socketPath, { op: 'stop', reservationId: 'x; rm -rf /' })).ok, false);
    assert.equal((await brokerCall<{ ok: boolean }>(b.socketPath, { op: 'exec', cmd: 'sh' })).ok, false);
    assert.equal(b.calls.length, 0);
  } finally { b.close(); }
});

test('deliver passes the JIT config to the backend only; list and stop work', async () => {
  const b = await setup();
  try {
    assert.deepEqual(await brokerCall(b.socketPath, { op: 'deliver', reservationId: id, jit: 'A'.repeat(200) }), { ok: true });
    assert.deepEqual(b.calls[0].arg, [id, 'A'.repeat(200)]);
    assert.deepEqual(await brokerCall(b.socketPath, { op: 'stop', reservationId: id }), { ok: true });
    assert.deepEqual(await brokerCall(b.socketPath, { op: 'list' }), { ok: true, containers: [] });
  } finally { b.close(); }
});

test('the socket is group-accessible only, not world-accessible', async () => {
  const b = await setup();
  try { assert.equal(statSync(b.socketPath).mode & 0o007, 0); } finally { b.close(); }
});

test('the broker enforces its own limits: project max, global max, one container per slot and reservation', async () => {
  const b = await setup(3);
  const other = '22222222-2222-3333-4444-555555555555';
  try {
    assert.deepEqual(await brokerCall(b.socketPath, { op: 'start', reservationId: id, slot: 1, project: 'myapp' }), { ok: true });
    // registry max_slots for exampleapp is 1: a second container is refused even with a fresh id and slot
    assert.equal((await brokerCall<{ error?: string }>(b.socketPath, { op: 'start', reservationId: other, slot: 2, project: 'myapp' })).error, 'project slot limit');
    assert.equal(b.calls.length, 1);
  } finally { b.close(); }
});

test('concurrent start requests cannot overshoot the limit', async () => {
  const b = await setup(3);
  try {
    const ids = ['a', 'b', 'c', 'd'].map((c) => c.repeat(8) + '-2222-3333-4444-555555555555');
    const rs = await Promise.all(ids.map((reservationId, i) => brokerCall<{ ok: boolean }>(b.socketPath, { op: 'start', reservationId, slot: i + 1, project: 'myapp' })));
    assert.equal(rs.filter((r) => r.ok).length, 1);
    assert.equal(b.calls.length, 1);
  } finally { b.close(); }
});

test('an unpinned image is refused at startup', async () => {
  await assert.rejects(async () => startBroker({ socketPath: '/tmp/never.sock', backend: {} as IsolationBackend, registry, image: 'ci-master/slot:dev' }), /digest-pinned/);
});

test('a start queued behind a slow one is skipped if its client has already given up', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const backend: IsolationBackend = {
    async start(sp: SlotSpec) { calls.push(sp.reservationId); await gate; },
    async deliverJit() {}, async stop() {}, async list() { return []; }, async stats() { return []; },
  };
  const socketPath = join(mkdtempSync(join(tmpdir(), 'ci-broker-')), 'b.sock');
  const reg = registry.map((p) => ({ ...p, max_slots: 4 }));
  const server = await startBroker({ socketPath, backend, registry: reg, image: PIN, globalMaxSlots: 4 });
  const { connect } = await import('node:net');
  try {
    const first = brokerCall(socketPath, { op: 'start', reservationId: id, slot: 1, project: 'myapp' });
    await new Promise((r) => setTimeout(r, 50));
    const s = connect(socketPath);
    s.write(JSON.stringify({ op: 'start', reservationId: '33333333-2222-3333-4444-555555555555', slot: 2, project: 'myapp' }) + '\n');
    await new Promise((r) => setTimeout(r, 50));
    s.destroy(); // client gives up while queued
    await new Promise((r) => setTimeout(r, 50));
    release();
    await first;
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(calls, [id], 'the abandoned start never ran');
  } finally { server.close(); }
});

test('stats op returns per-slot usage', async () => {
  const b = await setup();
  try { assert.deepEqual(await brokerCall(b.socketPath, { op: 'stats' }), { ok: true, stats: [{ reservationId: id, cpuPercent: 12.5, memUsedMb: 100, memLimitMb: 6144 }] }); } finally { b.close(); }
});
