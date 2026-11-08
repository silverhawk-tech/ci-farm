// Runs as ci-control. Polls GitHub and drives the slots through the broker. Logs state changes only, never credentials.
import { existsSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { brokerCall } from './broker-client.ts';
import { makeActionsPort, makeGithubPort } from './github-port.ts';
import { Actors } from './actors.ts';
import { startApi } from './api.ts';
import { Approvals } from './approvals.ts';
import { Audit } from './audit.ts';
import { AuditSync } from './audit-sync.ts';
import { Control, Pauses } from './control.ts';
import { Policy } from './policy.ts';
import { Reruns } from './reruns.ts';
import { Totp } from './totp.ts';
import { Sampler } from './sampler.ts';
import { DEFAULT_GROUP, loadRegistry } from './registry.ts';
import { StateDb } from './state.ts';
import { tick, type BrokerPort } from './controld.ts';

const dir = process.env.CI_CONTROL_DIR ?? '/var/lib/ci-control';


const sock = process.env.CI_BROKER_SOCKET ?? '/run/ci-master/broker.sock';
const callAt = async <T = { ok: boolean; error?: string }>(socket: string, req: object) => {
  const r = await brokerCall<T & { ok: boolean; error?: string }>(socket, req);
  if (!r.ok) throw new Error(`broker: ${r.error}`);
  return r;
};
const call = <T = { ok: boolean; error?: string }>(req: object) => callAt<T>(sock, req);
const brokerAt = (socket: string): BrokerPort => ({
  start: async (r) => void (await callAt(socket, { op: 'start', ...r })),
  deliver: async (reservationId, jit) => void (await callAt(socket, { op: 'deliver', reservationId, jit })),
  stop: async (reservationId) => void (await callAt(socket, { op: 'stop', reservationId })),
  list: async () => (await callAt<{ containers: { reservationId: string; running: boolean }[] }>(socket, { op: 'list' })).containers,
});
const broker = brokerAt(sock);
const state = new StateDb(`${dir}/state.sqlite`);
const cdb = new DatabaseSync(`${dir}/control.sqlite`);
cdb.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
const pauses = new Pauses(cdb);
const audit = new Audit(cdb);
// Independent receiver (plan section 7): a second, append-only copy of the audit chain. Gated actions need it reachable and current,
// and a disagreement between the two chains stops new jobs like a pause.
const sync = new AuditSync(audit, (req) => brokerCall<Record<string, unknown>>(process.env.CI_AUDIT_SOCKET ?? '/run/ci-audit/audit.sock', req));
await sync.syncOnce(); setInterval(() => void sync.syncOnce(), 10_000).unref();
const registry = loadRegistry(readFileSync(process.env.CI_REGISTRY ?? '/etc/ci-master/registry.yaml', 'utf8'));
// One broker per isolation group. The default group uses CI_BROKER_SOCKET as always; any other group needs CI_BROKER_SOCKET_<GROUP> (upper case,
// '-' -> '_'). A group in the registry without a socket stops the start-up: its projects must never fall back to another group's broker.
// Groups that only old reservations still name resolve the same way (so their containers can still be cleaned up) or are reported unreachable.
const brokers = new Map<string, BrokerPort>();
const brokerOf = (g: string): BrokerPort | undefined => {
  if (!brokers.has(g)) {
    const socket = g === DEFAULT_GROUP ? sock : process.env[`CI_BROKER_SOCKET_${g.toUpperCase().replace(/-/g, '_')}`];
    if (socket) brokers.set(g, g === DEFAULT_GROUP ? broker : brokerAt(socket));
  }
  return brokers.get(g);
};
for (const g of new Set(registry.map((p) => p.isolation_group))) {
  if (!brokerOf(g)) throw new Error(`isolation group '${g}' has no broker socket (set CI_BROKER_SOCKET_${g.toUpperCase().replace(/-/g, '_')})`);
}
const deps = {
  db: state,
  github: makeGithubPort(dir),
  broker,
  brokerFor: brokerOf,
  registry,
  globalMaxSlots: Number(process.env.CI_GLOBAL_MAX_SLOTS ?? 2),
  paused: () => pauses.allPaused() || existsSync(`${dir}/paused`) || sync.tampered(),
  heldSlots: () => pauses.heldSlots(),
  log: (m: string) => console.log(new Date().toISOString(), m),
  diskFreeGb: () => { const f = statfsSync(dir); return (f.bavail * f.bsize) / 1073741824; },
  minFreeDiskGb: Number(process.env.CI_MIN_FREE_DISK_GB ?? 20),
};
// Single instance: an atomic lease in the state DB (renewed every tick, lapses after 60 s). Two controlds can never both hold it.
const me = randomUUID();
const LEASE_MS = 60_000;
if (!deps.db.acquireLease(me, LEASE_MS)) { console.error('another controld holds the lease; exiting'); process.exit(1); }
// Control API on 127.0.0.1 (plan R6). Needs `ctl-admin init-totp` first; without the second factor it stays off and says so.
const reruns = new Reruns(cdb);
reruns.markCrashedUncertain();
const totpFile = `${dir}/secrets/totp.secret`;
if (existsSync(totpFile)) {
  const policy = new Policy(cdb), approvals = new Approvals(cdb);
  const actionsPort = makeActionsPort(dir);
  const control = new Control({ audit, policy, approvals, reruns, pauses, state, github: actionsPort, registry, auditGate: () => sync.gate(),
    // A request is just an empty file the root watchdog looks for; it re-validates the name itself and ignores the contents.
    requestRestart: (svc) => { try { writeFileSync(`${process.env.CI_RESTART_DIR ?? '/var/lib/ci-watchdog/requests'}/request-${svc}`, '', { flag: 'wx', mode: 0o640 }); return 'queued'; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'already_pending'; throw e; } } });
  const sampler = new Sampler(cdb);
  const sampleOnce = async () => { try { sampler.take(((await call<{ stats: { reservationId: string; cpuPercent: number; memUsedMb: number; memLimitMb: number }[] }>({ op: 'stats' })).stats)); } catch (e) { sampler.take([]); } };
  await sampleOnce(); setInterval(sampleOnce, 15_000).unref();
  const { port } = await startApi({ health: () => ({ tickAgeS: Math.round((Date.now() - lastTick) / 1000) }), actors: new Actors(cdb), control, approvals, audit, policy, totp: new Totp(cdb, Buffer.from(readFileSync(totpFile, 'utf8').trim(), 'hex')), port: Number(process.env.CI_API_PORT ?? 8787),
    resources: () => sampler.history(),
    // projects may share a repo: list each repo's runs once
    runs: async () => Promise.all(registry.filter((p, i) => registry.findIndex((q) => q.repo.toLowerCase() === p.repo.toLowerCase()) === i).map(async (p) => ({ project: p.name, repo: p.repo, runs: await actionsPort.recentRuns(p.repo).catch(() => []) }))),
    staticDir: process.env.CI_DASHBOARD_DIR ?? '/opt/ci-master/dashboard',
    publicHost: /^[a-z0-9.-]+\.ts\.net$/.test(process.env.CI_PUBLIC_HOST ?? '') ? process.env.CI_PUBLIC_HOST : undefined, // tailnet names only
    status: () => ({ auditReceiver: sync.status, maxSlots: deps.globalMaxSlots, projects: registry.map((p) => ({ name: p.name, repo: p.repo, resources: p.resources })), paused: pauses.allPaused(), heldSlots: pauses.heldSlots(), slots: state.live().map((r) => ({ id: r.id, project: r.project, slot: r.slot, state: r.state, job_id: r.job_id, since: r.updated_at })) }) });
  console.log(`control API on http://127.0.0.1:${port}`);
} else console.log('control API is OFF: run ctl-admin.ts init-totp first');
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { deps.db.releaseLease(me); process.exit(0); }); // clean stop: restart needs no 60 s wait
let lastTick = Date.now(); // a stuck tick loop shows up as a growing tickAgeS on /v1/health
const every = Number(process.env.CI_POLL_SECONDS ?? 15) * 1000;
let busy = false, n = 0;
const run = async () => {
  if (busy) return;
  busy = true;
  if (!deps.db.acquireLease(me, LEASE_MS)) { console.error('lost the controld lease; exiting'); process.exit(1); }
  // lastTick moves only on a SUCCESSFUL tick: a loop that fails every cycle shows up as stuck on /v1/health
  try { await tick({ ...deps, sweepRunners: n++ % 20 === 0 }); lastTick = Date.now(); } catch (e) { console.error(new Date().toISOString(), 'tick failed:', (e as Error).message.slice(0, 300)); }
  busy = false;
};
console.log('controld started, polling every', every / 1000, 's', deps.paused() ? '(paused)' : '');
if (process.argv.includes('--once')) await run(); else { await run(); setInterval(run, every); }
