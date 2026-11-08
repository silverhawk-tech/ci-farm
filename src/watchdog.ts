import { SERVICES, SERVICE_NAMES, type Service } from './services.ts';

// Root watchdog logic (plan section 8). Runs every 30 s as a oneshot from a systemd timer. Two jobs:
//  1. keep the controller, broker and audit receiver healthy: restart one that is down, or alive but stuck (3 bad checks in a row);
//  2. carry out restart requests that agents queue through the control API (an empty file named request-<service>).
// It is the only thing with the power to restart services, so it trusts nothing it reads from the requests directory: names must match
// exactly, contents are never read, and every service has a hard restart budget per hour however the restart came about.

export const BAD_CHECKS_BEFORE_RESTART = 3;
export const MAX_TICK_AGE_S = 300;
export const RESTARTS_PER_HOUR = 6;      // all causes together
export const REQUESTED_PER_HOUR = 3;     // agent requests only (control.ts also caps these)
const HOUR = 3_600_000;

export interface WatchState { bad: Record<Service, number>; restarts: Record<Service, { at: number; requested: boolean }[]>; dockerStarts: number[] }
export const freshState = (): WatchState => ({ bad: { controld: 0, broker: 0, auditd: 0 }, restarts: { controld: [], broker: [], auditd: [] }, dockerStarts: [] });

export interface WatchdogDeps {
  now(): number;
  isActive(unit: string): Promise<boolean>;
  restart(unit: string): Promise<void>;
  /** Controller health: throws or returns ok:false when unreachable. */
  apiHealth(): Promise<{ ok: boolean; tickAgeS?: number }>;
  brokerAlive(): Promise<boolean>;
  auditdAlive(): Promise<boolean>;
  /** ci-run's rootless Docker daemon answers on its socket. It is not an agent-restartable service: the watchdog alone starts it. */
  dockerAlive(): Promise<boolean>;
  startDocker(): Promise<void>;
  /** Only the three fixed request names are ever probed (never a directory listing); `valid` = a regular, single-link file. */
  pendingRequests(): Promise<{ name: string; valid: boolean }[]>;
  clearRequest(name: string): Promise<void>;
  /** Durable write of the restart history. Called BEFORE every restart; if it throws, nothing is restarted. */
  persist(st: WatchState): Promise<void>;
  log(m: string): void;
}

const REQUEST_NAME = /^request-(controld|broker|auditd)$/;

export async function runWatchdog(d: WatchdogDeps, st: WatchState): Promise<WatchState> {
  const now = d.now();
  for (const s of SERVICE_NAMES) st.restarts[s] = (st.restarts[s] ?? []).filter((r) => now - r.at < HOUR);
  const doRestart = async (s: Service, why: string, requested: boolean): Promise<void> => {
    const recent = st.restarts[s];
    const requestedAll = SERVICE_NAMES.reduce((n, x) => n + st.restarts[x].filter((r) => r.requested).length, 0); // agent requests: one budget across all services
    if (recent.length >= RESTARTS_PER_HOUR || (requested && requestedAll >= REQUESTED_PER_HOUR)) { d.log(`${s}: NOT restarted (${why}): restart budget for this hour is used up, a human must look`); return; }
    recent.push({ at: now, requested });
    try { await d.persist(st); } catch (e) { recent.pop(); d.log(`${s}: NOT restarted: could not record it first (${(e as Error).message.slice(0, 80)})`); return; } // fail closed: no record, no restart
    st.bad[s] = 0;
    d.log(`${s}: restarting (${why})`);
    try { await d.restart(SERVICES[s]); } catch (e) { d.log(`${s}: restart failed: ${(e as Error).message.slice(0, 120)}`); }
  };

  // 1. agent requests (cleared first, so one request is never acted on twice)
  for (const { name, valid } of await d.pendingRequests()) {
    const m = REQUEST_NAME.exec(name);
    if (!m) continue;
    await d.clearRequest(name).catch(() => {});
    if (!valid) { d.log(`${m[1]}: request ignored (not a plain file)`); continue; }
    await doRestart(m[1] as Service, 'requested by an agent', true);
  }

  // 2. the Docker daemon the slots run in. When it is down the broker and controller fail because of IT, not because they are stuck:
  // starting it is the fix, and their failed checks this round must not count towards restarting them (that would only burn their budgets).
  let dockerDown = false;
  if (!(await d.dockerAlive().catch(() => false))) {
    dockerDown = true;
    st.dockerStarts = (st.dockerStarts ?? []).filter((t) => now - t < HOUR);
    if (st.dockerStarts.length >= RESTARTS_PER_HOUR) d.log('docker: NOT started: start budget for this hour is used up, a human must look');
    else {
      st.dockerStarts.push(now);
      let recorded = true;
      try { await d.persist(st); } catch (e) { st.dockerStarts.pop(); recorded = false; d.log(`docker: NOT started: could not record it first (${(e as Error).message.slice(0, 80)})`); }
      if (recorded) { d.log("docker: ci-run's rootless Docker is down, starting it"); try { await d.startDocker(); } catch (e) { d.log(`docker: start failed: ${(e as Error).message.slice(0, 400)}`); } }
    }
  }

  // 3. health
  const check = async (s: Service, healthy: () => Promise<boolean>): Promise<void> => {
    if (!(await d.isActive(SERVICES[s]).catch(() => false))) { await doRestart(s, 'service is not running', false); return; }
    const ok = await healthy().catch(() => false);
    st.bad[s] = ok ? 0 : dockerDown ? st.bad[s] : st.bad[s] + 1;
    if (st.bad[s] >= BAD_CHECKS_BEFORE_RESTART) await doRestart(s, `stuck: ${st.bad[s]} failed health checks in a row`, false);
  };
  await check('auditd', () => d.auditdAlive());
  await check('broker', () => d.brokerAlive());
  // a missing or nonsensical tickAgeS is NOT healthy; the controller can lie about itself, so this catches stuck, not malicious
  await check('controld', async () => { const h = await d.apiHealth(); return h.ok === true && Number.isFinite(h.tickAgeS) && (h.tickAgeS as number) >= 0 && (h.tickAgeS as number) <= MAX_TICK_AGE_S; });
  return st;
}
