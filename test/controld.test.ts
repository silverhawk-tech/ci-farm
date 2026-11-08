import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick, type BrokerPort, type GithubPort } from '../src/controld.ts';
import { StateDb } from '../src/state.ts';
import { loadRegistry } from '../src/registry.ts';
import type { Candidate } from '../src/poller.ts';

const registry = loadRegistry(readFileSync(new URL('../config/registry.example.yaml', import.meta.url), 'utf8'));
const cand = (jobId: number): Candidate => ({ prNumber: 7, run: { id: jobId, workflow_id: 1, run_number: 1, event: 'pull_request', head_sha: 'abc', head_branch: 'f', status: 'queued', pull_requests: [{ number: 7 }], head_repository: { full_name: registry[0].repo } },
  job: { id: jobId, run_id: jobId, status: 'queued', labels: [registry[0].unique_label] } });

function world(over: Partial<GithubPort> = {}) {
  const log: string[] = [];
  const containers = new Map<string, boolean>();
  let queue: Candidate[] = [];
  const github: GithubPort = {
    async queue() { return queue; }, async stillEligible() { return true; },
    async mint(_p, name) { log.push('mint'); return { runnerId: 42, runnerName: name, encodedJitConfig: 'CFG-CFG-CFG-CFG' }; },
    async removeRunner(_repo, id) { log.push(`remove-runner ${id}`); }, async listRunners() { return []; }, async jobByRunner() { return null; }, ...over,
  };
  const broker: BrokerPort = {
    async start(r) { log.push('start'); containers.set(r.reservationId, true); },
    async deliver() { log.push('deliver'); }, async stop(id) { log.push('stop'); containers.delete(id); },
    async list() { return [...containers].map(([reservationId, running]) => ({ reservationId, running })); },
  };
  const db = new StateDb(join(mkdtempSync(join(tmpdir(), 'ci-ctl-')), 's.sqlite'));
  return { log, containers, db, setQueue: (q: Candidate[]) => (queue = q), deps: { db, github, broker, registry, globalMaxSlots: 2 } };
}

test('happy path: reserve, start, mint, deliver; container exit tears everything down incl. the runner registration', async () => {
  const w = world();
  w.setQueue([cand(1)]);
  await tick(w.deps);
  assert.deepEqual(w.log, ['start', 'mint', 'deliver']);
  assert.equal(w.db.live()[0].state, 'started');
  await tick(w.deps); // same job queued again is not double-started
  assert.deepEqual(w.log, ['start', 'mint', 'deliver']);
  w.containers.clear(); // runner exited
  w.setQueue([]);
  await tick(w.deps);
  assert.equal(w.db.live().length, 0);
  assert.ok(w.log.includes('remove-runner 42'));
});

test('a job superseded after the slot started never gets a JIT config', async () => {
  const w = world({ async stillEligible() { return false; } });
  w.setQueue([cand(1)]);
  await tick(w.deps);
  assert.ok(!w.log.includes('mint') && !w.log.includes('deliver'));
  w.setQueue([]); // GitHub no longer lists the superseded job
  await tick(w.deps);
  assert.equal(w.db.live().length, 0);
  assert.ok(w.log.includes('stop'));
});

test('a broker failure marks the reservation failed and frees the slot on the next tick', async () => {
  const w = world();
  w.deps.broker.start = async () => { throw new Error('docker down'); };
  w.setQueue([cand(1)]);
  await tick(w.deps);
  assert.equal(w.db.live()[0].state, 'failed');
  w.setQueue([]);
  await tick(w.deps);
  assert.equal(w.db.live().length, 0);
});

test('orphan containers with no reservation are removed; pause stops new starts', async () => {
  const w = world();
  w.containers.set('99999999-2222-3333-4444-555555555555', true);
  w.setQueue([cand(1)]);
  await tick({ ...w.deps, paused: () => true });
  assert.equal(w.containers.size, 0);
  assert.equal(w.db.live().length, 0);
});

test('global slot limit is respected across projects', async () => {
  const w = world();
  w.setQueue([cand(1), cand(2), cand(3)]);
  await tick({ ...w.deps, registry: [{ ...registry[0], max_slots: 4 }], globalMaxSlots: 2 });
  assert.equal(w.db.live().length, 2);
});

const owned = (status: string, over: Partial<Candidate['run']> = {}) => async () => ({ job: { ...cand(1).job, status, runner_name: 'x' }, run: { ...cand(1).run, ...over } });

test('a runner that took a disallowed job (wrong event or fork) is killed', async () => {
  const w = world({ jobByRunner: owned('in_progress', { event: 'pull_request_target' }) });
  w.setQueue([cand(1)]);
  await tick(w.deps);
  w.setQueue([]);
  await tick(w.deps);
  assert.equal(w.containers.size, 0);
  assert.equal(w.db.live().length, 0);
});

test('started becomes running when the runner owns an in-progress job; completed job finishes the slot', async () => {
  let status = 'in_progress';
  const w = world({ jobByRunner: async () => (await owned(status)()) });
  w.setQueue([cand(1)]);
  await tick(w.deps);
  await tick(w.deps);
  assert.equal(w.db.live()[0].state, 'running');
  status = 'completed';
  w.setQueue([]);
  await tick(w.deps);
  assert.equal(w.db.live().length, 0);
});

test('a slot nobody picked up is torn down after the idle timeout', async () => {
  const w = world();
  w.setQueue([cand(1)]);
  await tick(w.deps);
  w.setQueue([]);
  await tick({ ...w.deps, now: () => Date.now() + 700_000 });
  assert.equal(w.db.live().length, 0);
});

test('if the container cannot be removed the slot stays occupied and teardown is retried', async () => {
  const w = world();
  w.setQueue([cand(1)]);
  await tick(w.deps);
  w.containers.clear();
  w.setQueue([]);
  let fails = 1;
  const stop = w.deps.broker.stop;
  w.deps.broker.stop = async (id) => { if (fails-- > 0) throw new Error('docker busy'); return stop(id); };
  await tick(w.deps);
  assert.equal(w.db.live().length, 1, 'slot still held');
  await tick(w.deps);
  assert.equal(w.db.live().length, 0);
});

test('orphan runner registrations are removed, live reservations keep theirs', async () => {
  const w = world();
  const inst = w.db.instanceId();
  w.deps.github.listRunners = async () => [{ id: 7, name: `cif-${inst}-1-deadbeef` }, { id: 8, name: 'someone-elses-runner' }, { id: 9, name: 'cif-zzzzzz-1-deadbeef' }];
  await tick({ ...w.deps, sweepRunners: true });
  assert.ok(w.log.includes('remove-runner 7'));
  assert.ok(!w.log.includes('remove-runner 8'));
  assert.ok(!w.log.includes('remove-runner 9'), 'another installation with the same prefix is left alone');
});

test('a failed owner lookup is not treated as idleness', async () => {
  const w = world({ async jobByRunner() { throw new Error('GitHub 502'); } });
  w.setQueue([cand(1)]);
  await tick(w.deps);
  w.setQueue([]);
  await tick({ ...w.deps, now: () => Date.now() + 700_000 });
  assert.equal(w.db.live()[0].state, 'started', 'kept: lookup error is unknown, not idle');
});

test('a job that started and completed between polls finishes the slot instead of leaving it stuck', async () => {
  const w = world({ jobByRunner: owned('completed') });
  w.setQueue([cand(1)]);
  await tick(w.deps);
  w.setQueue([]);
  await tick(w.deps);
  assert.equal(w.db.live().length, 0);
});

test('a runner registration is removed using the stored repo even if the project left the registry', async () => {
  const w = world();
  w.setQueue([cand(1)]);
  await tick(w.deps);
  w.containers.clear();
  w.setQueue([]);
  await tick({ ...w.deps, registry: [] });
  assert.ok(w.log.includes('remove-runner 42'));
  assert.equal(w.db.live().length, 0);
});

test('a running job over the maximum run time is killed', async () => {
  const w = world({ jobByRunner: owned('in_progress') });
  w.setQueue([cand(1)]);
  await tick(w.deps);
  await tick(w.deps);
  w.setQueue([]);
  await tick({ ...w.deps, now: () => Date.now() + 8_000_000 });
  assert.equal(w.db.live().length, 0);
});

test('a slot killed while its runner was being minted does not leave the runner behind (teardown removes it)', async () => {
  const w = world();
  w.deps.github.mint = async (_p, name) => { w.db.transition(w.db.live()[0].id, 'failed', { error: 'killed' }); return { runnerId: 55, runnerName: name, encodedJitConfig: 'CFG-CFG-CFG-CFG' }; };
  w.setQueue([cand(1)]);
  await tick(w.deps);
  assert.ok(!w.log.includes('deliver'));
  w.setQueue([]);
  await tick(w.deps);
  assert.ok(w.log.includes('remove-runner 55'), 'teardown knows the runner and removes it');
  assert.equal(w.db.live().length, 0);
});

test('a pause requested while the queue was being fetched still stops new starts', async () => {
  const w = world();
  let paused = false;
  w.deps.github.queue = async () => { paused = true; return [cand(1)]; };
  await tick({ ...w.deps, paused: () => paused });
  assert.ok(!w.log.includes('start'));
  assert.equal(w.db.live().length, 0);
});

test('a pause that arrives just before mint or delivery stops the start and cleans up', async () => {
  const w = world();
  let calls = 0;
  w.setQueue([cand(1)]);
  await tick({ ...w.deps, paused: () => ++calls > 2 }); // not paused for the queue and reserve checks, paused at the pre-mint check
  assert.ok(!w.log.includes('mint'));
  w.setQueue([]);
  await tick(w.deps);
  assert.equal(w.db.live().length, 0);
});

test('a fast job that completed between polls is recorded as finished, not as a failed start', async () => {
  const lines: string[] = [];
  const w = world({ jobByRunner: owned('completed') });
  w.setQueue([cand(1)]);
  await tick({ ...w.deps, log: (m: string) => lines.push(m) });
  w.containers.clear(); // the container is already gone at the next poll
  w.setQueue([]);
  await tick({ ...w.deps, log: (m: string) => lines.push(m) });
  assert.ok(lines.some((l) => /torn down .* \(finished\)/.test(l)), lines.join('\n'));
  assert.ok(!lines.some((l) => /failed/.test(l)));
});

test('disk guard: below the floor no new job starts, and it resumes once there is room', async () => {
  const w = world();
  let free = 5;
  const deps = { ...w.deps, diskFreeGb: () => free, minFreeDiskGb: 20 };
  w.setQueue([cand(1)]);
  await tick(deps);
  assert.ok(!w.log.includes('start'), 'nothing starts on a nearly full disk');
  free = 50;
  await tick(deps);
  assert.ok(w.log.includes('start'));
});
