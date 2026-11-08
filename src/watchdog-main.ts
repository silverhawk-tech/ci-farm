// Runs as ROOT from ci-watchdog.timer (code lives root-owned in /opt/ci-master). Thin wrapper: all decisions are in watchdog.ts.
import { execFile } from 'node:child_process';
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { request } from 'node:http';
import { promisify } from 'node:util';
import { z } from 'zod';
import { brokerCall } from './broker-client.ts';
import { SERVICE_NAMES } from './services.ts';
import { freshState, runWatchdog, type WatchState } from './watchdog.ts';

const run = promisify(execFile);
const SYSTEMCTL = '/usr/bin/systemctl';
const dir = process.env.CI_WATCHDOG_DIR ?? '/var/lib/ci-watchdog';
const reqDir = `${dir}/requests`;
const stateFile = `${dir}/state.json`;
const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// The requests directory must belong to root and not be writable by the group beyond create (0730): otherwise whoever owns it could swap it for a symlink.
const st = lstatSync(reqDir);
if (!st.isDirectory() || st.uid !== 0 || (st.mode & 0o7777 & ~0o730) !== 0) { console.error(`refusing: ${reqDir} must be a directory owned by root with mode 0730 or tighter`); process.exit(1); }

const entry = z.object({ at: z.number().finite(), requested: z.boolean() }).strict();
const stateSchema = z.object({
  bad: z.object({ controld: z.number().int().min(0).max(1000), broker: z.number().int().min(0).max(1000), auditd: z.number().int().min(0).max(1000) }).strict(),
  restarts: z.object({ controld: z.array(entry).max(50), broker: z.array(entry).max(50), auditd: z.array(entry).max(50) }).strict(),
  dockerStarts: z.array(z.number().finite()).max(50).default([]),
}).strict();
let state: WatchState = freshState();
try { state = stateSchema.parse(JSON.parse(readFileSync(stateFile, 'utf8'))); } catch { console.log(new Date().toISOString(), 'no usable state file: starting with a fresh restart history'); }

/** Write-then-rename with fsync: a crash leaves either the old state or the new one, never half of one. */
const persist = async (s: WatchState) => {
  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  const fd = openSync(tmp, 'r'); fsyncSync(fd); closeSync(fd);
  renameSync(tmp, stateFile);
};

/** Reads at most 4 KB of a reply, whatever the other side sends. */
async function boundedJson(res: Response): Promise<unknown> {
  const reader = res.body?.getReader(); let text = ''; let n = 0;
  if (!reader) throw new Error('no body');
  for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > 4096) { await reader.cancel(); throw new Error('reply too large'); } text += new TextDecoder().decode(value); }
  return JSON.parse(text);
}
const health = z.object({ ok: z.boolean(), tickAgeS: z.number().optional() }).passthrough();

// ci-run's rootless Docker: alive = it answers /_ping on its socket; start = its user-level unit, started as ci-run (root never runs docker itself).
const runUid = async () => (await run('/usr/bin/id', ['-u', 'ci-run'])).stdout.trim();
const dockerAlive = async () => {
  const uid = await runUid();
  return withTimeout(new Promise<boolean>((resolve) => {
    const r = request({ socketPath: `/run/user/${uid}/docker.sock`, path: '/_ping', timeout: 5000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    r.on('error', () => resolve(false)); r.on('timeout', () => { r.destroy(); resolve(false); }); r.end();
  }), 8000);
};
const startDocker = async () => {
  const uid = await runUid();
  const why = (e: unknown) => String((e as { stderr?: string }).stderr ?? (e as Error).message).replace(/\s+/g, ' ').trim().slice(0, 150);
  // No user switch here (the unit's sandbox forbids setuid): talk to ci-run's user manager as root, and if that fails start the manager itself,
  // which brings docker.service up through the default.target it is enabled in.
  try { await run(SYSTEMCTL, ['--user', '-M', 'ci-run@.host', 'start', 'docker.service'], { timeout: 60_000 }); return; }
  catch (e1) {
    try { await run(SYSTEMCTL, ['start', `user@${uid}.service`], { timeout: 60_000 }); }
    catch (e2) { throw new Error(`via user manager: ${why(e1)}; via user@${uid}: ${why(e2)}`); }
  }
};

await runWatchdog({
  dockerAlive, startDocker,
  now: () => Date.now(),
  isActive: async (unit) => run(SYSTEMCTL, ['is-active', '--quiet', unit]).then(() => true, () => false),
  // reset-failed first: after systemd's own start limit trips, a plain restart would be refused; the watchdog's hourly budget is the limit that counts then
  restart: async (unit) => { await run(SYSTEMCTL, ['reset-failed', unit]).catch(() => {}); await run(SYSTEMCTL, ['restart', unit]); },
  apiHealth: async () => health.parse(await boundedJson(await fetch('http://127.0.0.1:8787/v1/health', { signal: AbortSignal.timeout(5000) }))),
  brokerAlive: async () => (await withTimeout(brokerCall<{ ok: boolean }>(process.env.CI_BROKER_SOCKET ?? '/run/ci-master/broker.sock', { op: 'list' }), 10_000)).ok === true,
  auditdAlive: async () => (await withTimeout(brokerCall<{ ok: boolean }>(process.env.CI_AUDIT_SOCKET ?? '/run/ci-audit/audit.sock', { op: 'head' }), 10_000)).ok === true,
  // Only the three fixed names are probed: a flood of other files in the directory costs nothing.
  pendingRequests: async () => SERVICE_NAMES.flatMap((svc) => {
    try { const s = lstatSync(`${reqDir}/request-${svc}`); return [{ name: `request-${svc}`, valid: s.isFile() && s.nlink === 1 }]; } catch { return []; }
  }),
  clearRequest: async (name) => unlinkSync(`${reqDir}/${name}`), // unlink never follows a symlink: at worst it removes the symlink itself
  persist,
  log: (m) => console.log(new Date().toISOString(), m),
}, state);
await persist(state);
