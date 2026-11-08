import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry, servedBy } from '../src/registry.ts';
import { selectEligible, type Candidate, type Job, type Run } from '../src/poller.ts';
import { tick, type BrokerPort, type GithubPort } from '../src/controld.ts';
import { DatabaseSync } from 'node:sqlite';
import { StateDb } from '../src/state.ts';

const example = readFileSync(new URL('../config/registry.example.yaml', import.meta.url), 'utf8');
const second = (over: Record<string, string> = {}) => {
  let t = example.replace('name: myapp', 'name: app-dev').replace('unique_label: ci-farm-example1', 'unique_label: ci-farm-example2')
    .replace('allowed_events: [pull_request]', 'allowed_events: [push]\n  push_branches: [develop]');
  for (const [k, v] of Object.entries(over)) t = t.replace(k, v);
  return t;
};
const two = (over: Record<string, string> = {}) => example + second(over);

test('several projects may share one repo; names and unique labels stay unique', () => {
  const [a, b] = loadRegistry(two());
  assert.equal(a.repo, b.repo);
  assert.deepEqual([a.name, b.name], ['myapp', 'app-dev']);
  assert.throws(() => loadRegistry(two({ 'name: app-dev': 'name: myapp' })), /duplicate name/);
  assert.throws(() => loadRegistry(two({ 'ci-farm-example2': 'ci-farm-example1' })), /duplicate unique_label/);
});

test('isolation_group defaults to farm and is validated', () => {
  const [a, b] = loadRegistry(two({ 'max_slots: 1': 'max_slots: 1\n  isolation_group: dev' }));
  assert.equal(a.isolation_group, 'farm');
  assert.equal(b.isolation_group, 'dev');
  assert.throws(() => loadRegistry(example.replace('max_slots: 1', 'max_slots: 1\n  isolation_group: Bad_Group')), /invalid registry/);
});

test('servedBy gives a broker only its own group', () => {
  const ps = loadRegistry(two()).map((p, i) => ({ ...p, isolation_group: i === 0 ? 'farm' : 'dev' }));
  assert.deepEqual(servedBy(ps, 'farm').map((p) => p.name), ['myapp']);
  assert.deepEqual(servedBy(ps, 'dev').map((p) => p.name), ['app-dev']);
});

const [pr, push] = loadRegistry(two());
const run = (id: number, o: Partial<Run> = {}): Run => ({ id, workflow_id: 1, run_number: id, event: 'pull_request', head_sha: 's' + id, head_branch: 'f', status: 'queued',
  pull_requests: [{ number: id }], head_repository: { full_name: pr.repo }, ...o });
const job = (id: number, run_id: number, label: string): Job => ({ id, run_id, status: 'queued', labels: ['self-hosted', label] });

test('two projects on one repo each schedule only the jobs that carry their own label and event', () => {
  const runs = [run(10), run(11, { event: 'push', pull_requests: [], head_branch: 'develop' })];
  const jobs = new Map<number, Job[]>([[10, [job(100, 10, pr.unique_label), job(101, 10, push.unique_label)]], [11, [job(110, 11, push.unique_label), job(111, 11, pr.unique_label)]]]);
  assert.deepEqual(selectEligible(pr, runs, jobs).map((c) => c.job.id), [100]); // the PR project never takes the push run (event) nor the other label
  assert.deepEqual(selectEligible(push, runs, jobs).map((c) => c.job.id), [110]); // the push project never takes the PR run
});

// --- controld routing ---
function fakeBroker(name: string, log: string[]) {
  const containers = new Map<string, boolean>();
  const b: BrokerPort = {
    async start(r) { log.push(`${name}:start:${r.project}`); containers.set(r.reservationId, true); },
    async deliver() { log.push(`${name}:deliver`); },
    async stop(id) { log.push(`${name}:stop`); containers.delete(id); },
    async list() { return [...containers].map(([reservationId, running]) => ({ reservationId, running })); },
  };
  return { b, containers };
}
const cand = (p: typeof pr, jobId: number): Candidate => ({ prNumber: p === pr ? jobId : null, run: run(jobId, p === pr ? {} : { event: 'push', pull_requests: [], head_branch: 'develop' }), job: job(jobId, jobId, p.unique_label) });
function world() {
  const log: string[] = [];
  const farm = fakeBroker('farm', log), dev = fakeBroker('dev', log);
  const registry = [pr, { ...push, isolation_group: 'dev' }];
  const removed: number[] = [];
  let queue = new Map<string, Candidate[]>();
  const github: GithubPort = {
    async queue(p) { return queue.get(p.name) ?? []; }, async stillEligible() { return true; },
    async mint(_p, name) { log.push('mint'); return { runnerId: 42, runnerName: name, encodedJitConfig: 'CFG-CFG-CFG-CFG' }; },
    async removeRunner(_repo, id) { removed.push(id); }, async listRunners() { return []; }, async jobByRunner() { return null; },
  };
  const db = new StateDb(join(mkdtempSync(join(tmpdir(), 'ci-mp-')), 's.sqlite'));
  const brokerFor = (g: string) => (g === 'dev' ? dev.b : farm.b);
  return { log, removed, farm, dev, db, registry, setQueue: (q: Record<string, Candidate[]>) => (queue = new Map(Object.entries(q))), deps: { db, github, broker: farm.b, brokerFor, registry, globalMaxSlots: 2 } };
}

test('each project starts, delivers and tears down in the broker of its own isolation group', async () => {
  const w = world();
  w.setQueue({ [pr.name]: [cand(pr, 1)], [push.name]: [cand(push, 2)] });
  await tick(w.deps);
  assert.deepEqual(w.log.filter((l) => !l.startsWith('mint')), ['farm:start:myapp', 'farm:deliver', 'dev:start:app-dev', 'dev:deliver']);
  assert.equal(w.farm.containers.size, 1);
  assert.equal(w.dev.containers.size, 1);
  w.dev.containers.clear(); // the dev runner exits
  w.setQueue({});
  w.log.length = 0;
  await tick(w.deps);
  assert.deepEqual(w.log, ['dev:stop']); // only the dev broker is asked; the farm slot keeps running
  assert.equal(w.farm.containers.size, 1);
});

test('orphan containers are removed through the broker that listed them', async () => {
  const w = world();
  w.dev.containers.set('99999999-2222-3333-4444-555555555555', true);
  await tick(w.deps);
  assert.deepEqual(w.log, ['dev:stop']);
  assert.equal(w.dev.containers.size, 0);
});

// A killed slot of the dev project, with the dev broker still holding its container.
async function failedDevSlot() {
  const w = world();
  w.setQueue({ [push.name]: [cand(push, 2)] });
  await tick(w.deps);
  const r = w.db.live()[0];
  assert.equal(r.isolation_group, 'dev'); // stored on the reservation
  assert.equal(w.dev.containers.size, 1);
  w.db.transition(r.id, 'failed', { error: 'killed' });
  w.setQueue({}); // GitHub no longer lists the job, so nothing new starts after the teardown
  w.log.length = 0;
  return w;
}

test('teardown goes through the group STORED on the reservation when its project and group left the registry', async () => {
  const w = await failedDevSlot();
  await tick({ ...w.deps, registry: [pr] }); // app-dev and the dev group are gone from the registry; the dev endpoint still resolves
  assert.deepEqual(w.log, ['dev:stop']);
  assert.equal(w.dev.containers.size, 0, 'the container is really gone');
  assert.equal(w.db.live().length, 0);
});

test('teardown goes through the stored group even when the project moved to another group', async () => {
  const w = await failedDevSlot();
  await tick({ ...w.deps, registry: [pr, { ...push, isolation_group: 'farm' }] });
  assert.deepEqual(w.log, ['dev:stop']);
  assert.equal(w.dev.containers.size, 0);
});

test('if the stored group has no reachable broker the reservation is kept: not torn down, its runner not removed, and it is logged', async () => {
  for (const brokerFor of [(g: string) => (g === 'dev' ? undefined : undefined), (g: string) => (g === 'dev' ? { ...fakeBroker('x', []).b, list: async () => { throw new Error('socket gone'); } } : undefined)]) {
    const w = await failedDevSlot();
    const logs: string[] = [];
    const farm = w.farm.b;
    await tick({ ...w.deps, registry: [pr], brokerFor: (g) => (g === 'farm' ? farm : brokerFor(g)), log: (m: string) => logs.push(m) });
    assert.equal(w.db.live().length, 1);
    assert.equal(w.db.live()[0].state, 'failed');
    assert.deepEqual(w.removed, [], 'the GitHub runner registration is kept until the container is confirmed gone');
    assert.equal(w.dev.containers.size, 1, 'the container is still there');
    assert.ok(logs.some((l) => /isolation group 'dev' is unreachable/.test(l) && l.includes(w.db.live()[0].id)));
    // once the endpoint is back the next tick finishes the teardown
    await tick({ ...w.deps, registry: [pr] });
    assert.equal(w.db.live().length, 0);
    assert.equal(w.dev.containers.size, 0);
  }
});

test('reservations store their isolation group; a state file from before groups migrates to farm without losing rows', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ci-mig-')), 's.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE reservations (id TEXT PRIMARY KEY, project TEXT NOT NULL, repo TEXT NOT NULL, slot INTEGER NOT NULL, state TEXT NOT NULL,
    run_id INTEGER NOT NULL, job_id INTEGER NOT NULL, head_sha TEXT NOT NULL, pr_number INTEGER, runner_name TEXT, runner_id INTEGER, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  old.prepare("INSERT INTO reservations VALUES ('11111111-1111-1111-1111-111111111111','myapp','o/r',1,'started',1,1,'a',7,'n',9,NULL,1,1)").run();
  old.close();
  const db = new StateDb(path);
  assert.equal(db.live()[0].isolation_group, 'farm');
  const r = db.reserve({ project: 'app-dev', repo: 'o/r', run_id: 2, job_id: 2, head_sha: 'b', pr_number: null, isolation_group: 'dev' }, { projectMaxSlots: 2, globalMaxSlots: 3 })!;
  assert.equal(r.isolation_group, 'dev');
  assert.equal(db.reserve({ project: 'x', repo: 'o/r', run_id: 3, job_id: 3, head_sha: 'c', pr_number: null }, { projectMaxSlots: 2, globalMaxSlots: 3 })!.isolation_group, 'farm'); // default
  assert.deepEqual(new StateDb(path).live().map((x) => x.isolation_group).sort(), ['dev', 'farm', 'farm']); // reopening is a no-op
});

test('without per-group brokers a project outside the default group is never started (fail closed); the default group still runs', async () => {
  const w = world();
  w.setQueue({ [pr.name]: [cand(pr, 1)], [push.name]: [cand(push, 2)] });
  const { brokerFor: _unused, ...single } = w.deps;
  const logs: string[] = [];
  await tick({ ...single, log: (m: string) => logs.push(m) });
  assert.deepEqual(w.log.filter((l) => l.includes('start')), ['farm:start:myapp']);
  assert.equal(w.dev.containers.size, 0);
  assert.ok(logs.some((l) => /skip app-dev: isolation group 'dev' has no broker/.test(l)));
});
