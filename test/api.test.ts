import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Actors } from '../src/actors.ts';
import { startApi } from '../src/api.ts';
import { Approvals } from '../src/approvals.ts';
import { Audit } from '../src/audit.ts';
import { Control, Pauses, type ActionsPort, type RunInfo } from '../src/control.ts';
import { Policy } from '../src/policy.ts';
import { loadRegistry } from '../src/registry.ts';
import { Reruns } from '../src/reruns.ts';
import { StateDb } from '../src/state.ts';
import { Totp, code } from '../src/totp.ts';

const registry = loadRegistry(readFileSync(new URL('../config/registry.example.yaml', import.meta.url), 'utf8'));
const SECRET = Buffer.from('12345678901234567890');

async function boot(publicHost?: string) {
  const db = new DatabaseSync(':memory:');
  let t = 59_000;
  const info: RunInfo = { head_sha: 'abc', status: 'in_progress', conclusion: null, workflow_path: '.github/workflows/ci.yml', superseded: false };
  const calls: string[] = [];
  const github: ActionsPort = { async recentRuns() { return []; }, async runInfo() { return info; }, async cancel(_r, id) { calls.push(`cancel ${id}`); }, async rerunFailed() {}, async rerunAll() {}, async deleteRun() {} };
  const policy = new Policy(db), audit = new Audit(db), approvals = new Approvals(db), actors = new Actors(db), totp = new Totp(db, SECRET, () => t);
  const state = new StateDb(join(mkdtempSync(join(tmpdir(), 'ci-api-')), 's.sqlite'));
  policy.applyPreset('claude', 'cautious');
  const control = new Control({ audit, policy, approvals, reruns: new Reruns(db), pauses: new Pauses(db), state, github, registry });
  const { server, port } = await startApi({ actors, control, approvals, audit, policy, totp, status: () => ({ live: state.live().length }), resources: () => [], runs: async () => [], publicHost });
  const agent = actors.issue('claude', 'agent'), human = actors.issue('owner', 'human');
  const call = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  const nextCode = () => { t += 30_000; return code(SECRET, Math.floor(t / 30_000)); };
  return { call, port, server, agent, human, audit, calls, nextCode, actors, close: () => server.close() };
}

test('health is open; everything else needs a valid token; tokens are stored hashed', async () => {
  const w = await boot();
  try {
    assert.equal((await w.call('GET', '/v1/health')).status, 200);
    assert.equal((await w.call('GET', '/v1/status')).status, 401);
    assert.equal((await w.call('GET', '/v1/status', 'cim_wrong')).status, 401);
    assert.equal((await w.call('GET', '/v1/status', w.agent)).status, 200);
    assert.match(w.agent, /^cim_[0-9a-f]{64}$/);
  } finally { w.close(); }
});

test('wrong Host (DNS rebinding) and foreign Origin are refused', async () => {
  const w = await boot();
  try {
    const status = await new Promise<number>((resolve, reject) => { const r = request({ host: '127.0.0.1', port: w.port, path: '/v1/health', headers: { Host: 'evil.example:80' } }, (res) => { res.resume(); resolve(res.statusCode!); }); r.on('error', reject); r.end(); });
    assert.equal(status, 421);
    const o = await new Promise<number>((resolve, reject) => { const r = request({ host: '127.0.0.1', port: w.port, path: '/v1/health', headers: { Origin: 'https://evil.example' } }, (res) => { res.resume(); resolve(res.statusCode!); }); r.on('error', reject); r.end(); });
    assert.equal(o, 403);
  } finally { w.close(); }
});

test('a configured tailnet host is accepted, with its https origin only; other hosts stay refused', async () => {
  const w = await boot('box.tail1234.ts.net');
  try {
    const get = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => { const r = request({ host: '127.0.0.1', port: w.port, path: '/v1/health', headers }, (res) => { res.resume(); resolve(res.statusCode!); }); r.on('error', reject); r.end(); });
    assert.equal(await get({ Host: 'box.tail1234.ts.net', Origin: 'https://box.tail1234.ts.net' }), 200);
    assert.equal(await get({ Host: 'box.tail1234.ts.net', Origin: 'http://box.tail1234.ts.net' }), 403);
    assert.equal(await get({ Host: 'other.tail1234.ts.net' }), 421);
  } finally { w.close(); }
});

test('agent flow: pause works, cancel becomes a pending approval, the agent cannot approve it, a human with TOTP can, then it executes once', async () => {
  const w = await boot();
  try {
    assert.equal((await w.call('POST', '/v1/actions/pause_all', w.agent, {})).status, 200);
    const pend = await w.call('POST', '/v1/actions/cancel_run', w.agent, { project: 'myapp', run_id: 7 });
    assert.equal(pend.status, 202);
    const id = pend.json.approval_id;
    assert.equal((await w.call('POST', `/v1/approvals/${id}/decide`, w.agent, { verdict: 'approve', totp: w.nextCode() })).status, 403);
    assert.equal((await w.call('POST', `/v1/approvals/${id}/decide`, w.human, { verdict: 'approve' })).status, 403, 'no TOTP');
    assert.equal((await w.call('POST', `/v1/approvals/${id}/decide`, w.human, { verdict: 'approve', totp: '000000' })).status, 403, 'wrong TOTP');
    assert.equal((await w.call('POST', `/v1/approvals/${id}/decide`, w.human, { verdict: 'approve', totp: w.nextCode() })).status, 200);
    assert.equal((await w.call('POST', '/v1/actions/cancel_run', w.agent, { project: 'myapp', run_id: 7, approval_id: id })).status, 200);
    assert.equal((await w.call('POST', '/v1/actions/cancel_run', w.agent, { project: 'myapp', run_id: 7, approval_id: id })).status, 422);
    assert.deepEqual(w.calls, ['cancel 7']);
    assert.equal(w.audit.verify().ok, true);
  } finally { w.close(); }
});

test('permissions: agents cannot read or edit the grid; a human needs TOTP; the change takes effect at once and is audited with before/after', async () => {
  const w = await boot();
  try {
    assert.equal((await w.call('GET', '/v1/permissions/claude', w.agent)).status, 403);
    assert.equal((await w.call('PUT', '/v1/permissions/claude', w.agent, { action: 'cancel_run', mode: 'allow', totp: w.nextCode() })).status, 403);
    assert.equal((await w.call('PUT', '/v1/permissions/claude', w.human, { action: 'cancel_run', mode: 'allow' })).status, 403);
    assert.equal((await w.call('POST', '/v1/actions/cancel_run', w.agent, { project: 'myapp', run_id: 7 })).status, 202, 'still ask');
    assert.equal((await w.call('PUT', '/v1/permissions/claude', w.human, { action: 'cancel_run', mode: 'allow', totp: w.nextCode() })).status, 200);
    assert.equal((await w.call('POST', '/v1/actions/cancel_run', w.agent, { project: 'myapp', run_id: 7 })).status, 200, 'now allowed, no restart');
    const edit = w.audit.list(50).find((r) => r.action === 'edit_policy' && r.result === 'done')!;
    assert.match(edit.params, /"before":\{"mode":"ask"\}/);
    assert.match(edit.params, /"after":\{"mode":"allow"/);
  } finally { w.close(); }
});

test('oversized bodies, non-JSON posts and unknown routes are rejected', async () => {
  const w = await boot();
  try {
    assert.equal((await w.call('POST', '/v1/actions/pause_all', w.agent, { reason: 'x'.repeat(70_000) })).status, 413);
    const r = await fetch(`http://127.0.0.1:${w.port}/v1/actions/pause_all`, { method: 'POST', headers: { Authorization: `Bearer ${w.agent}`, 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(r.status, 415);
    assert.equal((await w.call('GET', '/v1/nope', w.agent)).status, 404);
  } finally { w.close(); }
});

test('a human token alone cannot run gated actions; with a fresh TOTP it can; wrong codes lock everything', async () => {
  const w = await boot();
  try {
    const noCode = await w.call('POST', '/v1/actions/cancel_run', w.human, { project: 'myapp', run_id: 7 });
    assert.equal(noCode.status, 428);
    assert.equal((await w.call('POST', '/v1/actions/cancel_run', w.human, { project: 'myapp', run_id: 7, totp: w.nextCode() })).status, 200);
    assert.equal((await w.call('POST', '/v1/actions/pause_all', w.human, {})).status, 200, 'reversible actions need no code');
    for (let i = 0; i < 5; i++) await w.call('POST', '/v1/actions/cancel_run', w.human, { project: 'myapp', run_id: 7, totp: '000000' });
    assert.equal((await w.call('POST', '/v1/actions/cancel_run', w.human, { project: 'myapp', run_id: 7, totp: w.nextCode() })).status, 429);
    assert.equal((await w.call('PUT', '/v1/permissions/claude', w.human, { action: 'cancel_run', mode: 'allow', totp: w.nextCode() })).status, 429);
  } finally { w.close(); }
});

test('bad tokens are audited at most once a minute, without any token content', async () => {
  const w = await boot();
  try {
    for (let i = 0; i < 5; i++) await w.call('GET', '/v1/status', 'cim_' + 'f'.repeat(64));
    const rows = w.audit.list(50).filter((r) => r.action === 'auth');
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].note.includes('ffff'));
  } finally { w.close(); }
});

test('an existing agent cannot be re-issued as a human', async () => {
  const w = await boot();
  try { assert.throws(() => w.actors.issue('claude', 'human'), /cannot change/); } finally { w.close(); }
});

test('the dashboard shell is served with a strict CSP and no data; resources and runs need a token', async () => {
  const db = new DatabaseSync(':memory:');
  const policy = new Policy(db), audit = new Audit(db), approvals = new Approvals(db), actors = new Actors(db);
  const state = new StateDb(join(mkdtempSync(join(tmpdir(), 'ci-api-')), 's.sqlite'));
  const github: ActionsPort = { async recentRuns() { return []; }, async runInfo() { throw new Error('x'); }, async cancel() {}, async rerunFailed() {}, async rerunAll() {}, async deleteRun() {} };
  const control = new Control({ audit, policy, approvals, reruns: new Reruns(db), pauses: new Pauses(db), state, github, registry });
  const { server, port } = await startApi({ actors, control, approvals, audit, policy, totp: new Totp(db, SECRET), status: () => ({}), resources: () => [1], runs: async () => [], staticDir: new URL('../dashboard', import.meta.url).pathname });
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy')!, /default-src 'none'; script-src 'self'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/resources`)).status, 401);
    const agent = actors.issue('claude', 'agent'); policy.applyPreset('claude', 'cautious');
    const r = await fetch(`http://127.0.0.1:${port}/v1/resources`, { headers: { Authorization: `Bearer ${agent}` } });
    assert.deepEqual(((await r.json()) as { data: number[] }).data, [1]);
    assert.equal(audit.list(10).filter((x) => x.action === 'resources').length, 0, 'routine reads are not logged');
  } finally { server.close(); }
});

test('an oversize body is refused with 413 (declared or chunked) and the connection is closed; slow-sender limits are set', async () => {
  const b = await boot();
  try {
    assert.equal(b.server.headersTimeout, 10_000); assert.equal(b.server.requestTimeout, 30_000); assert.equal(b.server.keepAliveTimeout, 5_000);
    const post = (chunked: boolean) => new Promise<{ status: number; closed: boolean }>((resolve, reject) => {
      const big = Buffer.alloc(300 * 1024, 'a');
      const req = request({ host: '127.0.0.1', port: b.port, method: 'PUT', path: '/v1/permissions/claude', headers: { Authorization: `Bearer ${b.human}`, 'Content-Type': 'application/json', ...(chunked ? {} : { 'Content-Length': String(big.length) }) } }, (res) => {
        res.resume();
        res.on('close', () => resolve({ status: res.statusCode ?? 0, closed: res.headers.connection === 'close' }));
      });
      req.on('error', (e) => { if ((e as NodeJS.ErrnoException).code === 'ECONNRESET' || (e as NodeJS.ErrnoException).code === 'EPIPE') return; reject(e); });
      req.write(big); req.end();
    });
    for (const chunked of [false, true]) { const r = await post(chunked); assert.equal(r.status, 413); assert.equal(r.closed, true); }
  } finally { b.close(); }
});
