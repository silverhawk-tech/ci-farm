import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Audit } from '../src/audit.ts';
import { Approvals } from '../src/approvals.ts';
import { Control, Pauses, type ActionsPort, type RunInfo } from '../src/control.ts';
import { Policy } from '../src/policy.ts';
import { Reruns } from '../src/reruns.ts';
import { StateDb } from '../src/state.ts';
import { loadRegistry } from '../src/registry.ts';

const registry = loadRegistry(readFileSync(new URL('../config/registry.example.yaml', import.meta.url), 'utf8'));
const claude = { name: 'claude', type: 'agent' as const };
const owner = { name: 'owner', type: 'human' as const };

function world(initial: Partial<RunInfo> = {}, preset: 'cautious' | 'trusted' | 'readonly' = 'cautious') {
  const db = new DatabaseSync(':memory:');
  const calls: string[] = [];
  let info: RunInfo = { head_sha: 'abc', status: 'completed', conclusion: 'failure', workflow_path: '.github/workflows/ci.yml', superseded: false, ...initial };
  const github: ActionsPort = {
    async recentRuns() { return []; }, async runInfo() { return info; },
    async cancel(_r, id) { calls.push(`cancel ${id}`); }, async rerunFailed(_r, id) { calls.push(`rerun-failed ${id}`); },
    async rerunAll(_r, id) { calls.push(`rerun-all ${id}`); }, async deleteRun(_r, id) { calls.push(`delete ${id}`); },
  };
  const policy = new Policy(db); policy.applyPreset('claude', preset);
  const audit = new Audit(db), approvals = new Approvals(db);
  const state = new StateDb(join(mkdtempSync(join(tmpdir(), 'ci-ctl-')), 's.sqlite'));
  const control = new Control({ audit, policy, approvals, reruns: new Reruns(db), pauses: new Pauses(db), state, github, registry });
  return { control, audit, approvals, state, calls, policy, db, setInfo: (i: Partial<RunInfo>) => (info = { ...info, ...i }) };
}
const R = { project: 'myapp', run_id: 7 };

test('re-run failed: allowed for an allow-listed workflow, capped at 2, then refused with a report-to-human message', async () => {
  const w = world();
  assert.equal((await w.control.perform(claude, 'rerun_failed', { ...R, reason: 'network blip' })).status, 'done');
  assert.equal((await w.control.perform(claude, 'rerun_failed', { ...R, reason: 'network blip again' })).status, 'done');
  const third = await w.control.perform(claude, 'rerun_failed', { ...R, reason: 'once more' });
  assert.equal(third.status, 'refused');
  assert.match((third as { reason: string }).reason, /report it to a human/);
  assert.deepEqual(w.calls, ['rerun-failed 7', 'rerun-failed 7']);
});

test('re-run all is capped by the same reservation and also needs the allow-list; a human gets no bypass', async () => {
  const w = world({}, 'trusted');
  w.policy.set('claude', 'rerun_all', 'allow', { limits: { perRun: 99, perHour: 99 } }); // grid cannot raise the ceiling
  for (let i = 0; i < 2; i++) assert.equal((await w.control.perform(claude, 'rerun_all', { ...R, reason: 'x' })).status, 'done');
  assert.equal((await w.control.perform(claude, 'rerun_all', { ...R, reason: 'x' })).status, 'refused');
  const w2 = world();
  w2.setInfo({ workflow_path: '.github/workflows/lint.yml' });
  assert.equal((await w2.control.perform(owner, 'rerun_failed', { ...R, reason: 'x' })).status, 'refused', 'human too: not allow-listed');
  for (let i = 0; i < 2; i++) assert.equal((await w2.control.perform(owner, 'rerun_failed', { ...R, run_id: 8, reason: 'x' })).status, 'refused');
});

test('re-run is refused without a reason, for non-failed runs, other workflows, superseded runs and deploy workflows', async () => {
  const w = world();
  assert.equal((await w.control.perform(claude, 'rerun_failed', R)).status, 'refused');
  w.setInfo({ conclusion: 'success' });
  assert.equal((await w.control.perform(claude, 'rerun_failed', { ...R, reason: 'x' })).status, 'refused');
  w.setInfo({ conclusion: 'failure', workflow_path: '.github/workflows/lint.yml' });
  assert.equal((await w.control.perform(claude, 'rerun_failed', { ...R, reason: 'x' })).status, 'refused');
  w.setInfo({ workflow_path: '.github/workflows/ci.yml', superseded: true });
  assert.equal((await w.control.perform(claude, 'rerun_failed', { ...R, reason: 'x' })).status, 'denied');
  w.setInfo({ superseded: false, workflow_path: '.github/workflows/deploy.yml' });
  assert.equal((await w.control.perform(claude, 'rerun_failed', { ...R, reason: 'x' })).status, 'denied');
  assert.deepEqual(w.calls, []);
});

test('cancel by an agent needs approval: pending, approved by a human with step-up, executed once, bound to the head SHA', async () => {
  const w = world({ status: 'in_progress', conclusion: null });
  const first = await w.control.perform(claude, 'cancel_run', R);
  assert.equal(first.status, 'pending_approval');
  const id = (first as { approval_id: number }).approval_id;
  assert.equal((await w.control.perform({ name: 'codex', type: 'agent' }, 'cancel_run', { ...R, approval_id: id })).status, 'denied', 'another agent has no grid row and cannot ride on it');
  assert.equal((await w.control.perform(claude, 'cancel_run', { ...R, approval_id: id })).status, 'refused', 'not approved yet');
  assert.equal(w.approvals.decide(id, 'owner', 'approve', true).ok, true);
  w.setInfo({ head_sha: 'newer-push' });
  assert.equal((await w.control.perform(claude, 'cancel_run', { ...R, approval_id: id })).status, 'refused', 'target changed since approval');
  w.setInfo({ head_sha: 'abc' });
  assert.equal((await w.control.perform(claude, 'cancel_run', { ...R, approval_id: id })).status, 'done');
  assert.equal((await w.control.perform(claude, 'cancel_run', { ...R, approval_id: id })).status, 'refused', 'single use');
  assert.deepEqual(w.calls, ['cancel 7']);
});

test('a trusted agent can cancel directly; a read-only agent cannot even pause', async () => {
  const t = world({ status: 'in_progress', conclusion: null }, 'trusted');
  assert.equal((await t.control.perform(claude, 'cancel_run', R)).status, 'done');
  const r = world({}, 'readonly');
  assert.equal((await r.control.perform(claude, 'pause_all', {})).status, 'denied');
});

test('humans need a fresh step-up for gated actions; pause and slot holds work and never touch running jobs', async () => {
  const w = world({ status: 'in_progress', conclusion: null });
  assert.equal((await w.control.perform(owner, 'cancel_run', R)).status, 'needs_step_up');
  assert.equal((await w.control.perform(owner, 'cancel_run', R, { stepUp: true })).status, 'done');
  await w.control.perform(claude, 'pause_slot', { slot: 1 });
  const r = w.state.reserve({ project: 'app1', repo: 'o/app1', run_id: 1, job_id: 1, head_sha: 'a', pr_number: 1 }, { projectMaxSlots: 3, globalMaxSlots: 3 }, new Pauses(w.db).heldSlots());
  assert.equal(r!.slot, 2, 'slot 1 is held');
  await w.control.perform(claude, 'resume_slot', { slot: 1 });
  assert.deepEqual(new Pauses(w.db).heldSlots(), []);
});

test('kill_slot works on a running slot, never on one that is still starting; its approval binds the slot repo, run and SHA', async () => {
  const w = world({}, 'trusted');
  const r = w.state.reserve({ project: 'app1', repo: 'o/app1', run_id: 1, job_id: 1, head_sha: 'a', pr_number: 1 }, { projectMaxSlots: 3, globalMaxSlots: 3 })!;
  const ask = await w.control.perform(claude, 'kill_slot', { reservation_id: r.id });
  assert.equal(ask.status, 'refused', 'a reserved (still starting) slot is left to its timeout, and no approval was burnt or created');
  w.state.transition(r.id, 'minted'); w.state.transition(r.id, 'started');
  const pend = await w.control.perform(claude, 'kill_slot', { reservation_id: r.id });
  assert.equal(pend.status, 'pending_approval');
  const bound = JSON.parse(w.approvals.get((pend as { approval_id: number }).approval_id)!.binding);
  assert.deepEqual([bound.repo, bound.target.run_id, bound.target.head_sha], ['o/app1', 1, 'a']);
  w.policy.set('claude', 'kill_slot', 'allow');
  assert.equal((await w.control.perform(claude, 'kill_slot', { reservation_id: r.id })).status, 'done');
  assert.equal(w.state.get(r.id)!.state, 'failed');
});

test('invented or never-exposed actions and malformed params are refused and audited; the audit chain stays valid and holds no secrets', async () => {
  const w = world();
  for (const a of ['edit_policy', 'approve', 'read_key']) assert.equal((await w.control.perform(claude, a, {})).status, 'denied');
  assert.equal((await w.control.perform(claude, 'rerun_failed', { project: 'myapp', run_id: 'seven' })).status, 'refused');
  await w.control.perform(claude, 'pause_all', { token: 'ghs_' + 'A'.repeat(36) });
  assert.equal(w.audit.verify().ok, true);
  assert.ok(!w.audit.list(10).some((r) => /ghs_A/.test(r.params)));
});

test('reads are policy-checked and audited', async () => {
  const w = world({}, 'readonly');
  assert.deepEqual(await w.control.read(claude, 'status', () => ({ slots: 1 })), { status: 'done', data: { slots: 1 } });
  w.policy.set('claude', 'status', 'deny');
  assert.equal((await w.control.read(claude, 'status', () => 1)).status, 'denied');
});

test('an approval is not burnt by a request that could never succeed, and is given back when GitHub refuses', async () => {
  const w = world({ status: 'completed', conclusion: 'success' });
  const pend = await w.control.perform(claude, 'cancel_run', R);
  assert.equal(pend.status, 'refused', 'a finished run cannot be cancelled; no approval was even requested');
  w.setInfo({ status: 'in_progress', conclusion: null });
  const ask = await w.control.perform(claude, 'cancel_run', R) as { approval_id: number };
  w.approvals.decide(ask.approval_id, 'owner', 'approve', true);
  w.setInfo({ head_sha: 'newer' });
  assert.equal((await w.control.perform(claude, 'cancel_run', { ...R, approval_id: ask.approval_id })).status, 'refused', 'head SHA no longer matches the approval');
  w.setInfo({ head_sha: 'abc' });
  assert.equal((await w.control.perform(claude, 'cancel_run', { ...R, approval_id: ask.approval_id })).status, 'done', 'still usable: it was never consumed by the failed attempts');
});

test('if the audit intent row cannot be written, nothing is done', async () => {
  const w = world({}, 'trusted');
  w.db.exec('DROP TABLE audit');
  const out = await w.control.perform(claude, 'pause_all', {});
  assert.deepEqual(out, { status: 'refused', reason: 'audit log unavailable; nothing was done' });
  assert.equal(new Pauses(w.db).allPaused(), false, 'and nothing was paused');
});

test('a GitHub 500 for run id 404 keeps the approval consumed (only a typed 4xx is a definite refusal); an empty project does not throw', async () => {
  const { GitHubError } = await import('../src/github-app.ts');
  const w = world({ status: 'in_progress', conclusion: null });
  const ask = await w.control.perform(claude, 'cancel_run', { project: 'myapp', run_id: 404 }) as { approval_id: number };
  w.approvals.decide(ask.approval_id, 'owner', 'approve', true);
  const gh = (w.control as unknown as { d: { github: ActionsPort } }).d.github;
  gh.cancel = async () => { throw new GitHubError(500, 'GitHub POST /repos/o/r/actions/runs/404/cancel -> 500'); };
  assert.equal((await w.control.perform(claude, 'cancel_run', { project: 'myapp', run_id: 404, approval_id: ask.approval_id })).status, 'refused');
  assert.equal((await w.control.perform(claude, 'cancel_run', { project: 'myapp', run_id: 404, approval_id: ask.approval_id })).status, 'refused', 'still consumed after an uncertain outcome');
  gh.cancel = async () => { throw new GitHubError(422, 'unprocessable'); };
  const ask2 = await w.control.perform(claude, 'cancel_run', { project: 'myapp', run_id: 405 }) as { approval_id: number };
  w.approvals.decide(ask2.approval_id, 'owner', 'approve', true);
  await w.control.perform(claude, 'cancel_run', { project: 'myapp', run_id: 405, approval_id: ask2.approval_id });
  assert.equal(w.approvals.get(ask2.approval_id)!.state, 'approved', 'a definite 4xx gives it back');
  assert.equal((await w.control.perform(claude, 'cancel_run', { project: '', run_id: 1 })).status, 'refused');
});

test('an approval for a re-run is bound to the reason the approver saw', async () => {
  const w = world({}, 'cautious');
  w.policy.set('claude', 'rerun_all', 'ask');
  const ask = await w.control.perform(claude, 'rerun_all', { ...R, reason: 'flaky network' }) as { approval_id: number };
  w.approvals.decide(ask.approval_id, 'owner', 'approve', true);
  assert.equal((await w.control.perform(claude, 'rerun_all', { ...R, reason: 'something else entirely', approval_id: ask.approval_id })).status, 'refused');
  assert.equal((await w.control.perform(claude, 'rerun_all', { ...R, reason: 'flaky network', approval_id: ask.approval_id })).status, 'done');
});

test('an approval request never exists without its audit row: if the audit write fails, the request is rolled back', async () => {
  const w = world({ status: 'in_progress', conclusion: null });
  const real = w.audit.append.bind(w.audit);
  w.audit.append = (e) => { if (e.result === 'pending_approval') throw new Error('disk full'); return real(e); };
  await assert.rejects(() => w.control.perform(claude, 'cancel_run', R), /disk full/);
  assert.equal(w.approvals.list('pending').length, 0);
});

test('audit gate: with the receiver down, destructive actions are refused before any approval is used; asking and reversible actions still work', async () => {
  const w = world({ status: 'in_progress', conclusion: null }, 'trusted');
  (w.control as unknown as { d: { auditGate: () => { ok: boolean; reason: string } } }).d.auditGate = () => ({ ok: false, reason: 'audit receiver unreachable' });
  const direct = await w.control.perform(claude, 'cancel_run', R);
  assert.deepEqual(direct, { status: 'refused', reason: 'audit receiver unreachable' });
  assert.deepEqual(w.calls, []);
  assert.equal((await w.control.perform(claude, 'pause_all', {})).status, 'done', 'reversible actions are not gated');
  w.policy.set('claude', 'cancel_run', 'ask');
  const asked = await w.control.perform(claude, 'cancel_run', R);
  assert.equal(asked.status, 'pending_approval', 'asking is allowed');
  const id = (asked as { approval_id: number }).approval_id;
  w.approvals.decide(id, 'owner', 'approve', true);
  assert.equal((await w.control.perform(claude, 'cancel_run', { ...R, approval_id: id })).status, 'refused');
  assert.equal(w.approvals.get(id)?.state, 'approved', 'the approval was not consumed by the refused attempt');
  assert.deepEqual(w.calls, []);
});

test('restart_service: agents queue a restart for the watchdog (no password, no approval); unknown services are refused; 3 per hour at most', async () => {
  const w = world();
  const queued: string[] = [];
  (w.control as unknown as { d: { requestRestart: (s: string) => string } }).d.requestRestart = (s) => (queued.includes(s) ? 'already_pending' : (queued.push(s), 'queued'));
  const ok = await w.control.perform(claude, 'restart_service', { service: 'auditd', reason: 'receiver is down' });
  assert.equal(ok.status, 'done');
  assert.deepEqual(queued, ['auditd']);
  assert.equal((await w.control.perform(claude, 'restart_service', { service: 'egress', reason: 'x' })).status, 'refused', 'the firewall service is not restartable this way');
  assert.equal((await w.control.perform(claude, 'restart_service', { service: 'broker; rm -rf /', reason: 'x' })).status, 'refused');
  await w.control.perform(claude, 'restart_service', { service: 'broker', reason: 'stuck' });
  await w.control.perform(claude, 'restart_service', { service: 'controld', reason: 'stuck' });
  const fourth = await w.control.perform(claude, 'restart_service', { service: 'controld', reason: 'again' });
  assert.equal(fourth.status, 'refused');
  assert.match((fourth as { reason: string }).reason, /3 per hour/);
  assert.equal(queued.length, 3);
});

test('restart_service is not available to a read-only agent and is not blocked by the audit gate (the receiver itself may be what is down)', async () => {
  const ro = world({}, 'readonly');
  assert.equal((await ro.control.perform(claude, 'restart_service', { service: 'auditd', reason: 'x' })).status, 'denied');
  const w = world();
  (w.control as unknown as { d: { auditGate: () => object; requestRestart: () => string } }).d.auditGate = () => ({ ok: false, reason: 'audit receiver unreachable' });
  (w.control as unknown as { d: { requestRestart: () => string } }).d.requestRestart = () => 'queued';
  assert.equal((await w.control.perform(claude, 'restart_service', { service: 'auditd', reason: 'receiver is down' })).status, 'done');
});
