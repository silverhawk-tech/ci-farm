// Local preview of the dashboard with FAKE data (nothing real is touched). Run: node scripts/dev-dashboard.ts  -> prints the URL and a throwaway token.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Actors } from '../src/actors.ts';
import { startApi } from '../src/api.ts';
import { Approvals } from '../src/approvals.ts';
import { Audit } from '../src/audit.ts';
import { Control, Pauses, type ActionsPort } from '../src/control.ts';
import { Policy } from '../src/policy.ts';
import { loadRegistry } from '../src/registry.ts';
import { Reruns } from '../src/reruns.ts';
import { Sampler } from '../src/sampler.ts';
import { StateDb } from '../src/state.ts';
import { Totp } from '../src/totp.ts';

const db = new DatabaseSync(':memory:');
const registry = loadRegistry(readFileSync(new URL('../config/registry.example.yaml', import.meta.url), 'utf8'));
const state = new StateDb(join(mkdtempSync(join(tmpdir(), 'ci-dev-')), 's.sqlite'));
const r = state.reserve({ project: 'myapp', repo: registry[0].repo, run_id: 101, job_id: 1001, head_sha: 'a3f9c21', pr_number: 106 }, { projectMaxSlots: 2, globalMaxSlots: 2 })!;
for (const s of ['minted', 'started', 'running'] as const) state.transition(r.id, s);
const iso = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const runs = [
  { progress: { jobsDone: 1, jobsTotal: 4, percent: 41, current: 'Run npm test', jobs: [{ name: 'changes', status: 'completed', conclusion: 'success' }, { name: 'gates', status: 'in_progress', conclusion: null }, { name: 'content-bank', status: 'queued', conclusion: null }, { name: 'ci-required', status: 'queued', conclusion: null }] }, id: 101, title: 'Docker image and image flow', branch: 'feature/api-docker-image', name: 'CI', status: 'in_progress', conclusion: null, head_sha: 'a3f9c21aa', event: 'pull_request', pr: 106, created_at: iso(7), workflow_path: '.github/workflows/ci.yml', superseded: false },
  { id: 100, title: 'Docker image and image flow', branch: 'feature/api-docker-image', name: 'CI', status: 'completed', conclusion: 'cancelled', head_sha: '9c01b7eaa', event: 'pull_request', pr: 106, created_at: iso(16), workflow_path: '.github/workflows/ci.yml', superseded: true },
  { id: 99, title: 'Fix Modal focus timing', branch: 'fix/modal-focus', name: 'CI', status: 'completed', conclusion: 'failure', head_sha: 'e17d4a0aa', event: 'pull_request', pr: 104, created_at: iso(40), workflow_path: '.github/workflows/ci.yml', superseded: false },
  { id: 98, title: 'Privacy mechanics', branch: 'feature/privacy', name: 'CI', status: 'completed', conclusion: 'success', head_sha: '77ab310aa', event: 'pull_request', pr: 103, created_at: iso(70), workflow_path: '.github/workflows/ci.yml', superseded: false },
  { id: 102, title: 'Dashboard job chips', branch: 'feature/dashboard', name: 'CI', status: 'queued', conclusion: null, head_sha: '51cc8e2aa', event: 'pull_request', pr: 107, created_at: iso(1), workflow_path: '.github/workflows/ci.yml', superseded: false },
];
const github: ActionsPort = { async recentRuns() { return runs; }, async runInfo() { return { head_sha: 'a3f9c21aa', status: 'in_progress', conclusion: null, workflow_path: '.github/workflows/ci.yml', superseded: false }; },
  async cancel() {}, async rerunFailed() {}, async rerunAll() {}, async deleteRun() {} };
const policy = new Policy(db), audit = new Audit(db), approvals = new Approvals(db), actors = new Actors(db);
policy.applyPreset('codex', 'cautious');
const control = new Control({ audit, policy, approvals, reruns: new Reruns(db), pauses: new Pauses(db), state, github, registry });
let t = 0;
const sampler = new Sampler(db, () => Date.now() - (40 - t) * 15_000, () => `cpu ${t * 40} 0 ${t * 20} ${t * 40 + 100} 0`);
for (t = 1; t <= 40; t++) sampler.take([{ reservationId: r.id, cpuPercent: 150 + (t % 7) * 12, memUsedMb: 3800 + t * 9, memLimitMb: 6144 }], '/', () => `MemTotal: 21000000 kB\nMemAvailable: ${9000000 - t * 20000} kB\nSwapTotal: 2000000 kB\nSwapFree: 1900000 kB\n`);
await control.perform({ name: 'codex', type: 'agent' }, 'cancel_run', { project: 'myapp', run_id: 101 });
await control.perform({ name: 'codex', type: 'agent' }, 'pause_slot', { slot: 2 });
const token = actors.issue('owner', 'human');
const { port } = await startApi({ actors, control, approvals, audit, policy, totp: new Totp(db, Buffer.from('12345678901234567890')), port: 8788, staticDir: new URL('../dashboard', import.meta.url).pathname,
  resources: () => sampler.history(), runs: async () => [{ project: 'myapp', repo: registry[0].repo, runs }],
  status: () => ({ auditReceiver: process.env.PREVIEW_AUDIT === 'down' ? { reachable: false, state: 'unknown', lag: 0, error: 'connect ENOENT' } : { reachable: true, state: 'in_sync', lag: 0, lastOk: Date.now(), head: { seq: 61, hash: 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12' }, error: '' }, maxSlots: 2, projects: [], paused: false, heldSlots: new Pauses(db).heldSlots(), slots: state.live().map((x) => ({ id: x.id, project: x.project, slot: x.slot, state: x.state, job_id: x.job_id, since: x.updated_at })) }) });
console.log(`preview http://127.0.0.1:${port}/  token: ${token}`);
