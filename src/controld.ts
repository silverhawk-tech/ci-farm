import type { StateDb, Reservation } from './state.ts';
import { DEFAULT_GROUP, type Project } from './registry.ts';
import { runAllowed, type Candidate, type Job, type Run } from './poller.ts';
import type { JitRunner } from './jit.ts';
import { runnerName, runnerPrefix } from './jit.ts';

// Orchestrator (plan section 3, "How JIT works"). One tick = reconcile, then start whatever is eligible.
// Order per job: reserve slot -> start slot container -> re-check eligibility -> mint JIT -> deliver. Nothing is minted for a stale job.
// A JIT runner takes ANY eligible job, so after pickup we check the job it actually took and kill it if the rules forbid that job (plan 4a R1).

export interface GithubPort {
  queue(p: Project): Promise<Candidate[]>;
  stillEligible(p: Project, c: Candidate): Promise<boolean>;
  mint(p: Project, name: string): Promise<JitRunner>;
  removeRunner(repo: string, runnerId: number): Promise<void>;
  listRunners(p: Project): Promise<{ id: number; name: string }[]>;
  jobByRunner(p: Project, runnerName: string, reservedJobId: number): Promise<{ job: Job; run: Run } | null>;
}
export interface BrokerPort {
  start(r: { reservationId: string; slot: number; project: string }): Promise<void>;
  deliver(reservationId: string, jit: string): Promise<void>;
  stop(reservationId: string): Promise<void>;
  list(): Promise<{ reservationId: string; running: boolean }[]>;
}
export interface Deps {
  db: StateDb; github: GithubPort; broker: BrokerPort; registry: Project[]; globalMaxSlots: number;
  /** One broker per isolation group. Without it every project must be in the default group and `broker` serves it (unchanged single-broker farm). */
  brokerFor?: (group: string) => BrokerPort | undefined;
  paused?: () => boolean; heldSlots?: () => number[]; log?: (m: string) => void; now?: () => number;
  startTimeoutMs?: number; idleTimeoutMs?: number; maxRunMs?: number; sweepRunners?: boolean;
  diskFreeGb?: () => number; minFreeDiskGb?: number; // disk guard: below the floor no NEW job starts (running ones finish); slots have no disk cap of their own
}
let diskWasLow = false;

export async function tick(d: Deps): Promise<void> {
  const log = d.log ?? (() => {});
  const now = (d.now ?? Date.now)();
  const inst = d.db.instanceId();
  const projectOf = (r: Reservation) => d.registry.find((p) => p.name === r.project);
  const fail = (r: Reservation, error: string) => { const cur = d.db.get(r.id)!; if (cur.state !== 'failed' && cur.state !== 'torn_down' && cur.state !== 'finished') d.db.transition(r.id, 'failed', { error }); };

  // Routing: a slot lives in the broker of the isolation group STORED on its reservation, so a registry edit (project removed, moved to another group)
  // can never send its teardown to the wrong broker. A project outside the default group is never started without brokerFor.
  const brokerFor = (g: string): BrokerPort | undefined => (d.brokerFor ? d.brokerFor(g) : g === DEFAULT_GROUP ? d.broker : undefined);
  const configured = new Set(d.brokerFor ? d.registry.map((p) => p.isolation_group) : [DEFAULT_GROUP]);
  const groups = [...new Set([...configured, ...d.db.live().map((r) => r.isolation_group)])];

  // 1. Reconcile each live reservation. One bad reservation never aborts the others.
  const containers: { reservationId: string; running: boolean; group: string }[] = [];
  const unavailable = new Set<string>();
  for (const g of groups) {
    try {
      const b = brokerFor(g);
      if (!b) throw new Error(`no broker endpoint for isolation group '${g}'`);
      for (const c of await b.list()) containers.push({ ...c, group: g });
    } catch (e) {
      if (configured.has(g)) throw e; // a configured group failing keeps the whole tick fail-closed, exactly as with the single broker
      unavailable.add(g); // a group only old reservations still name: keep those reservations (container unknown), never tear them down blind
      log(`isolation group '${g}' is unreachable (${(e as Error).message}); its reservations are kept: ${d.db.live().filter((r) => r.isolation_group === g).map((r) => r.id).join(', ')}`);
    }
  }
  const running = new Set(containers.filter((c) => c.running).map((c) => c.reservationId));
  const tornDown = new Set<string>();
  for (const r of d.db.live()) {
    if (unavailable.has(r.isolation_group)) continue;
    try {
      const p = projectOf(r);
      const present = running.has(r.id);
      if (p && present && r.runner_name && (r.state === 'started' || r.state === 'running')) {
        let owned: Awaited<ReturnType<GithubPort['jobByRunner']>> | undefined;
        try { owned = await d.github.jobByRunner(p, r.runner_name, r.job_id); } catch (e) { log(`owner lookup ${r.id}: ${(e as Error).message}`); } // lookup error = unknown, never proof of idleness
        if (owned && !runAllowed(p, owned.run)) fail(r, `runner took a disallowed job ${owned.job.id} (${owned.run.event})`);
        else if (owned && owned.job.status === 'in_progress' && r.state === 'started') d.db.transition(r.id, 'running');
        else if (owned && owned.job.status === 'completed') { if (r.state === 'started') d.db.transition(r.id, 'running'); d.db.transition(r.id, 'finished'); }
        else if (owned === null && r.state === 'started' && now - r.updated_at > (d.idleTimeoutMs ?? 600_000)) fail(r, 'no job picked up before the idle timeout');
        else if (r.state === 'running' && now - r.updated_at > (d.maxRunMs ?? 7_200_000)) fail(r, 'job exceeded the maximum run time');
      }
      const cur0 = d.db.get(r.id)!;
      if (!present && (cur0.state === 'started' || cur0.state === 'running')) {
        if (cur0.state === 'running') d.db.transition(r.id, 'finished');
        else {
          // The container may be gone because a fast job finished between two polls: ask GitHub before calling it a failure.
          let o: Awaited<ReturnType<GithubPort['jobByRunner']>> | undefined;
          try { o = p && r.runner_name ? await d.github.jobByRunner(p, r.runner_name, r.job_id) : undefined; } catch (e) { log(`owner lookup ${r.id}: ${(e as Error).message}`); }
          if (o && p && !runAllowed(p, o.run)) fail(r, `runner took a disallowed job ${o.job.id} (${o.run.event})`);
          else if (o && o.job.status === 'completed') { d.db.transition(r.id, 'running'); d.db.transition(r.id, 'finished'); }
          else fail(r, o === undefined ? 'container exited; job outcome unknown' : 'container exited before a job started');
        }
      } else if ((cur0.state === 'reserved' || cur0.state === 'minted') && now - cur0.updated_at > (d.startTimeoutMs ?? 120_000)) fail(r, 'stuck before start');

      // Teardown: the slot is only released once BOTH the container and the runner registration are confirmed gone; otherwise retry next tick.
      const cur = d.db.get(r.id)!;
      if (cur.state === 'finished' || cur.state === 'failed') {
        let ok = true;
        const b = brokerFor(cur.isolation_group);
        if (!b) { ok = false; log(`stop ${r.id}: no broker endpoint for isolation group '${cur.isolation_group}'`); }
        else await b.stop(r.id).catch((e) => { ok = false; log(`stop ${r.id}: ${e.message}`); });
        if (cur.runner_id) await d.github.removeRunner(cur.repo, cur.runner_id).catch((e) => { ok = false; log(`remove runner ${cur.runner_id}: ${e.message}`); });
        if (ok) { d.db.transition(r.id, 'torn_down'); tornDown.add(r.id); log(`torn down ${r.id} (${cur.state}${cur.error ? ': ' + cur.error : ''})`); }
      }
    } catch (e) { log(`reconcile ${r.id}: ${(e as Error).message}`); }
  }
  // Orphans: containers with no live reservation (e.g. after a crash) are removed.
  const liveIds = new Set(d.db.live().map((r) => r.id));
  for (const c of containers) if (!liveIds.has(c.reservationId) && !tornDown.has(c.reservationId)) await brokerFor(c.group)!.stop(c.reservationId).catch((e) => log(`orphan ${c.reservationId}: ${e.message}`));

  // Runner registrations with no reservation (crash between mint and persist, or failed removal) are removed by name.
  if (d.sweepRunners) {
    const keep = new Set(d.db.live().map((r) => runnerName(inst, r.slot, r.id)));
    const swept = new Set<string>(); // projects may share a repo: sweep each repo once
    for (const p of d.registry) {
      if (swept.has(p.repo.toLowerCase())) continue;
      swept.add(p.repo.toLowerCase());
      for (const run of await d.github.listRunners(p).catch(() => [])) {
        if (run.name.startsWith(runnerPrefix(inst)) && !keep.has(run.name)) await d.github.removeRunner(p.repo, run.id).then(() => log(`removed orphan runner ${run.name}`)).catch((e) => log(`orphan runner ${run.name}: ${e.message}`));
      }
    }
  }

  if (d.paused?.()) return; // pause = no new jobs; running ones finish
  if (d.diskFreeGb) {
    const free = d.diskFreeGb(), low = free < (d.minFreeDiskGb ?? 20);
    if (low !== diskWasLow) log(low ? `disk low (${free.toFixed(1)} GB free): not starting new jobs` : `disk back above the floor (${free.toFixed(1)} GB free): starting jobs again`);
    diskWasLow = low;
    if (low) return;
  }

  // 2. Start eligible jobs. A failure for one project (e.g. repo no longer private) does not stop the others.
  for (const p of d.registry) {
    const pb = brokerFor(p.isolation_group);
    if (!pb) { log(`skip ${p.name}: isolation group '${p.isolation_group}' has no broker`); continue; } // fail closed
    let queue: Candidate[];
    try { queue = await d.github.queue(p); } catch (e) { log(`queue ${p.name}: ${(e as Error).message}`); continue; }
    for (const c of queue) {
      if (d.paused?.()) return; // a pause requested during the queue fetch must still stop new starts
      const r = d.db.reserve({ project: p.name, repo: p.repo, run_id: c.run.id, job_id: c.job.id, head_sha: c.run.head_sha, pr_number: c.prNumber, isolation_group: p.isolation_group }, { projectMaxSlots: p.max_slots, globalMaxSlots: d.globalMaxSlots }, d.heldSlots?.() ?? []);
      if (!r) continue;
      try {
        await pb.start({ reservationId: r.id, slot: r.slot, project: p.name });
        if (!(await d.github.stillEligible(p, c))) { d.db.transition(r.id, 'failed', { error: 'superseded, cancelled or no longer allowed before mint' }); continue; }
        if (d.paused?.()) { d.db.transition(r.id, 'failed', { error: 'paused before mint' }); continue; }
        const jit = await d.github.mint(p, runnerName(inst, r.slot, r.id));
        try { d.db.transition(r.id, 'minted', { runner_name: jit.runnerName, runner_id: jit.runnerId }); }
        catch (e) { d.db.attachRunner(r.id, jit.runnerName, jit.runnerId); throw e; } // slot was failed (e.g. killed) while we minted: teardown now knows the runner and will not finish until it is removed
        if (d.paused?.()) { d.db.transition(r.id, 'failed', { error: 'paused before delivery' }); continue; } // nothing is running yet; teardown removes the runner
        await pb.deliver(r.id, jit.encodedJitConfig);
        d.db.transition(r.id, 'started');
        log(`started ${r.id} slot ${r.slot} for ${p.repo} job ${c.job.id}`);
      } catch (e) {
        fail(r, (e as Error).message.slice(0, 200));
      }
    }
  }
}
