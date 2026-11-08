import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectEligible, type Job, type Run } from '../src/poller.ts';
import { loadRegistry } from '../src/registry.ts';

const [project] = loadRegistry(readFileSync(new URL('../config/registry.example.yaml', import.meta.url), 'utf8'));
const run = (o: Partial<Run> & { id: number; run_number: number }): Run => ({ workflow_id: 1, event: 'pull_request', head_sha: 'sha' + o.id, head_branch: 'f', status: 'queued',
  pull_requests: [{ number: 7 }], head_repository: { full_name: project.repo }, ...o });
const job = (id: number, run_id: number, o: Partial<Job> = {}): Job => ({ id, run_id, status: 'queued', labels: ['self-hosted', project.unique_label], ...o });
const jobs = (...js: Job[]) => new Map<number, Job[]>(js.map((j) => [j.run_id, js.filter((x) => x.run_id === j.run_id)]));

test('an older queued run of the same PR is superseded: only the newest gets a runner', () => {
  const out = selectEligible(project, [run({ id: 10, run_number: 1 }), run({ id: 11, run_number: 2 })], jobs(job(100, 10), job(101, 11)));
  assert.deepEqual(out.map((c) => c.job.id), [101]);
});

test('different PRs and different workflows do not supersede each other', () => {
  const rs = [run({ id: 10, run_number: 1 }), run({ id: 11, run_number: 2, pull_requests: [{ number: 8 }] }), run({ id: 12, run_number: 3, workflow_id: 2 })];
  const out = selectEligible(project, rs, jobs(job(100, 10), job(101, 11), job(102, 12)));
  assert.deepEqual(out.map((c) => c.job.id).sort(), [100, 101, 102]);
});

test('fork PRs, wrong events and runs without our label are never eligible', () => {
  const rs = [run({ id: 10, run_number: 1, head_repository: { full_name: 'evil/fork' } }), run({ id: 11, run_number: 1, event: 'pull_request_target', pull_requests: [{ number: 9 }] }), run({ id: 12, run_number: 1, pull_requests: [{ number: 10 }] }), run({ id: 13, run_number: 1, pull_requests: [{ number: 11 }], head_repository: null })];
  const out = selectEligible(project, rs, jobs(job(100, 10), job(101, 11), job(102, 12, { labels: ['ubuntu-24.04'] }), job(103, 13)));
  assert.deepEqual(out, []);
});

test('jobs that are not queued are ignored', () => {
  assert.deepEqual(selectEligible(project, [run({ id: 10, run_number: 1 })], jobs(job(100, 10, { status: 'in_progress' }))), []);
});

test('a newer IN-PROGRESS run of the same PR also suppresses an older queued run', () => {
  const rs = [run({ id: 10, run_number: 1 }), run({ id: 11, run_number: 2, status: 'in_progress' })];
  assert.deepEqual(selectEligible(project, rs, jobs(job(100, 10))).map((c) => c.job.id), []);
});

test('only pull_request runs supersede: two manual runs on one branch both stay eligible', () => {
  const p = { ...project, allowed_events: ['pull_request', 'workflow_dispatch'] as typeof project.allowed_events };
  const rs = [run({ id: 10, run_number: 1, event: 'workflow_dispatch', pull_requests: [] }), run({ id: 11, run_number: 2, event: 'workflow_dispatch', pull_requests: [] })];
  assert.deepEqual(selectEligible(p, rs, jobs(job(100, 10), job(101, 11))).map((c) => c.job.id).sort(), [100, 101]);
});

test('a pull_request run without a PR number is refused (identity required)', () => {
  assert.deepEqual(selectEligible(project, [run({ id: 10, run_number: 1, pull_requests: [] })], jobs(job(100, 10))), []);
});

test('push runs are scheduled only from the listed branches; every other branch, a missing branch and an unlisted project are refused', () => {
  const p = { ...project, allowed_events: ['pull_request', 'push'] as typeof project.allowed_events, push_branches: ['develop'] };
  const push = (id: number, head_branch: string | null) => run({ id, run_number: 1, event: 'push', pull_requests: [], head_branch });
  const rs = [push(10, 'develop'), push(11, 'feature/x'), push(12, 'main'), push(13, null), push(14, 'develop-evil')];
  assert.deepEqual(selectEligible(p, rs, jobs(job(100, 10), job(101, 11), job(102, 12), job(103, 13), job(104, 14))).map((c) => c.job.id), [100]);
  assert.deepEqual(selectEligible(project, [push(10, 'develop')], jobs(job(100, 10))), []); // push not allowed for this project at all
});

test('two pushes to develop do not supersede each other (a deploy-like run is never silently dropped)', () => {
  const p = { ...project, allowed_events: ['push'] as typeof project.allowed_events, push_branches: ['develop'] };
  const rs = [run({ id: 10, run_number: 1, event: 'push', pull_requests: [], head_branch: 'develop' }), run({ id: 11, run_number: 2, event: 'push', pull_requests: [], head_branch: 'develop' })];
  assert.deepEqual(selectEligible(p, rs, jobs(job(100, 10), job(101, 11))).map((c) => c.job.id).sort(), [100, 101]);
});
