import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Audit } from './audit.ts';
import type { Approvals, Binding } from './approvals.ts';
import type { Policy, Actor, Action } from './policy.ts';
import { ACTIONS, GATED_ACTIONS, READ_ACTIONS } from './policy.ts';
import type { Reruns } from './reruns.ts';
import type { StateDb } from './state.ts';
import { SERVICE_NAMES, type Service } from './services.ts';
import { GitHubError } from './github-app.ts';
import type { Project } from './registry.ts';

// The one control layer (plan 6). Dashboard and MCP both call perform(); the server decides. Order:
// validate -> read target -> policy -> preconditions -> approval/step-up -> audit INTENT -> re-read target -> act -> audit result.
// If the intent row cannot be written, nothing happens. Every outcome, including denials, is audited.

export interface RunInfo { head_sha: string; status: string; conclusion: string | null; workflow_path: string; superseded: boolean }
/** Progress of a running workflow: jobs done / total, and the running step. `percent` is an estimate (every job weighs the same, steps within a job weigh the same). */
export interface RunProgress { jobsDone: number; jobsTotal: number; percent: number; current: string | null; jobs: { name: string; status: string; conclusion: string | null }[] }
export interface RunSummary { progress?: RunProgress; title: string | null; branch: string | null; id: number; name: string; status: string; conclusion: string | null; head_sha: string; event: string; pr: number | null; created_at: string; workflow_path: string; superseded: boolean }
export interface ActionsPort {
  recentRuns(repo: string): Promise<RunSummary[]>;
  runInfo(repo: string, runId: number): Promise<RunInfo>;
  cancel(repo: string, runId: number): Promise<void>;
  rerunFailed(repo: string, runId: number): Promise<void>;
  rerunAll(repo: string, runId: number): Promise<void>;
  deleteRun(repo: string, runId: number): Promise<void>;
}

/** Pause flags in the control DB: pause_all stops new starts; a held slot number is never handed out. Running jobs are never touched. */
export class Pauses {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; db.exec('CREATE TABLE IF NOT EXISTS pause (key TEXT PRIMARY KEY)'); }
  setAll(on: boolean) { this.toggle('all', on); }
  setSlot(slot: number, on: boolean) { this.toggle(`slot:${slot}`, on); }
  private toggle(key: string, on: boolean) { if (on) this.db.prepare('INSERT OR IGNORE INTO pause (key) VALUES (?)').run(key); else this.db.prepare('DELETE FROM pause WHERE key = ?').run(key); }
  allPaused(): boolean { return !!this.db.prepare("SELECT 1 FROM pause WHERE key = 'all'").get(); }
  heldSlots(): number[] { return (this.db.prepare("SELECT key FROM pause WHERE key LIKE 'slot:%'").all() as { key: string }[]).map((r) => Number(r.key.slice(5))); }
}

const SENSITIVE_WORKFLOW = /migrat|deploy|release|prod/i;
/** Re-run ceilings no grid cell can raise (the owner: 2 per run, 6 per hour). A grid value can only lower them. */
const HARD_RERUN = { perRun: 2, perHour: 6 };
const run = z.object({ project: z.string().min(1), run_id: z.number().int().positive() });
const slot = z.object({ slot: z.number().int().min(1).max(16) });
const res = z.object({ reservation_id: z.string().regex(/^[0-9a-f-]{36}$/) });
const extra = { reason: z.string().max(500).optional(), approval_id: z.number().int().positive().optional() };
const SCHEMA: Partial<Record<Action, z.ZodObject<z.ZodRawShape>>> = {
  rerun_failed: run.extend(extra), rerun_all: run.extend(extra), cancel_run: run.extend(extra), delete_run: run.extend(extra),
  pause_slot: slot.extend(extra), resume_slot: slot.extend(extra), kill_slot: res.extend(extra), restart_slot: res.extend(extra),
  pause_all: z.object(extra), resume_all: z.object(extra), register_project: z.object(extra),
  restart_service: z.object({ service: z.enum(SERVICE_NAMES), ...extra }),
};
/** Restarts of the controller, broker or receiver: no grid cell can raise this. */
const HARD_RESTARTS_PER_HOUR = 3;
const RERUN = ['rerun_failed', 'rerun_all'];

/** Thrown for failures BEFORE any mutating call was made: the approval and quota are safe to give back. */
class PreMutation extends Error {}
const definiteRefusal = (e: unknown) => e instanceof PreMutation || (e instanceof GitHubError && e.status >= 400 && e.status < 500);

export type Outcome =
  | { status: 'done'; detail?: unknown } | { status: 'denied'; reason: string } | { status: 'refused'; reason: string }
  | { status: 'pending_approval'; approval_id: number } | { status: 'needs_step_up' };

export interface ControlDeps { audit: Audit; policy: Policy; approvals: Approvals; reruns: Reruns; pauses: Pauses; state: StateDb; github: ActionsPort; registry: Project[]; auditGate?: () => { ok: boolean; reason?: string };
  /** Queues a restart for the root watchdog (which re-checks everything itself). Returns whether a request was already waiting. */
  requestRestart?: (service: Service) => 'queued' | 'already_pending' }
type P = { project?: string; run_id?: number; slot?: number; reservation_id?: string; reason?: string; approval_id?: number; service?: Service };

export class Control {
  private d: ControlDeps;
  constructor(d: ControlDeps) { this.d = d; }

  /** `stepUp` = the API verified a fresh TOTP code for this call. Humans need it for gated actions (a stolen human token alone is not enough). */
  async perform(actor: Actor, action: string, rawParams: unknown, opts: { stepUp?: boolean } = {}): Promise<Outcome> {
    const d = this.d, who = { actor: actor.name, actorType: actor.type };
    const log = (result: string, x: { target?: unknown; note?: string; approver?: string } = {}) => d.audit.append({ ...who, action, params: rawParams, result, ...x });
    const done = (o: Outcome, x: { target?: unknown; note?: string; approver?: string } = {}) => { log(o.status === 'pending_approval' ? 'pending_approval' : o.status, { ...x, note: x.note ?? ('reason' in o ? o.reason : undefined) }); return o; };

    if (!(ACTIONS as readonly string[]).includes(action)) return done({ status: 'denied', reason: 'unknown or never-exposed action' });
    const a = action as Action;
    const parsed = (SCHEMA[a] ?? z.object({}).passthrough()).safeParse(rawParams ?? {});
    if (!parsed.success) return done({ status: 'refused', reason: 'invalid parameters' });
    const p = parsed.data as P;

    const project = p.project ? d.registry.find((x) => x.name === p.project) : undefined;
    if (p.project && !project) return done({ status: 'refused', reason: 'unknown project' });
    let info: RunInfo | undefined;
    if (project && p.run_id) {
      try { info = await d.github.runInfo(project.repo, p.run_id); } catch (e) { return done({ status: 'refused', reason: 'cannot read the run from GitHub' }, { note: (e as Error).message.slice(0, 200) }); }
    }
    const reservation = p.reservation_id ? d.state.get(p.reservation_id) : undefined;
    const dec = d.policy.decide(actor, a, { superseded: info?.superseded, deployLane: info ? SENSITIVE_WORKFLOW.test(info.workflow_path) : false });
    const binding = this.bindingFor(a, p, project, info, reservation);
    if (binding && RERUN.includes(a)) binding.params = { reason: p.reason ?? '' }; // the reason the approver saw is the one that must be used
    const target = binding?.target;
    if (dec.decision === 'deny') return done({ status: 'denied', reason: dec.reason }, { target });

    // Preconditions come BEFORE any approval is consumed, so a request that could never succeed does not burn an approval.
    const why = this.precondition(a, actor, p, project, info, reservation);
    if (why) return done({ status: 'refused', reason: why }, { target });
    if (!binding) return done({ status: 'refused', reason: 'this action needs a concrete target' });

    // Destructive actions need an independent, current audit record (plan section 7). Asking for approval is fine; executing is not.
    const executing = dec.decision === 'allow' || (dec.decision === 'ask' && p.approval_id !== undefined);
    if (executing && (GATED_ACTIONS as readonly string[]).includes(a) && d.auditGate) {
      const g = d.auditGate();
      if (!g.ok) return done({ status: 'refused', reason: g.reason ?? 'audit receiver unavailable' }, { target });
    }

    let approver: string | undefined;
    if (dec.decision === 'ask') {
      if (!p.approval_id) { const id = d.audit.atomically(() => { const n = d.approvals.request(actor.name, a, binding); log('pending_approval', { target, note: `approval #${n}` }); return n; }); return { status: 'pending_approval', approval_id: id }; } // request and its audit row commit together
      const c = d.approvals.consume(p.approval_id, actor.name, a, binding);
      if (!c.ok) return done({ status: 'refused', reason: c.reason ?? 'approval invalid' }, { target });
      approver = `approval#${p.approval_id}`;
    } else if (actor.type === 'human' && (GATED_ACTIONS as readonly string[]).includes(a) && !opts.stepUp) {
      return done({ status: 'needs_step_up' }, { target, note: 'gated action by a human needs a fresh TOTP code' });
    }

    try { log('intent', { target, approver }); } catch { if (p.approval_id && approver) d.approvals.release(p.approval_id); return { status: 'refused', reason: 'audit log unavailable; nothing was done' }; }
    try {
      const out = await this.execute(actor, a, p, project, info, dec.limits, reservation);
      if (approver && out.status !== 'done' && p.approval_id) d.approvals.release(p.approval_id); // definite refusal before any external call
      return done(out, { target, approver });
    } catch (e) {
      const msg = (e as Error).message;
      if (approver && p.approval_id && definiteRefusal(e)) d.approvals.release(p.approval_id); // refused before or by GitHub (typed 4xx): definite. Anything else stays consumed.
      return done({ status: 'refused', reason: 'action failed: ' + msg.slice(0, 200) }, { target, approver });
    }
  }

  private bindingFor(a: Action, p: P, project?: Project, info?: RunInfo, r?: { id: string; repo: string; run_id: number; head_sha: string }): Binding | undefined {
    if (project && info && p.run_id) return { repo: project.repo, target: { run_id: p.run_id, head_sha: info.head_sha }, params: {} };
    if (p.reservation_id && r) return { repo: r.repo, target: { reservation_id: r.id, run_id: r.run_id, head_sha: r.head_sha }, params: {} };
    if (p.slot !== undefined) return { repo: '-', target: { slot: p.slot }, params: {} };
    if (p.service) return { repo: '-', target: { service: p.service }, params: {} };
    if (['pause_all', 'resume_all', 'register_project'].includes(a)) return { repo: '-', target: {}, params: {} };
    return undefined;
  }

  /** State rules checked up front (and again, against a fresh read, right before the GitHub call). */
  private precondition(a: Action, actor: Actor, p: P, project?: Project, info?: RunInfo, r?: { state: string }): string | null {
    if (['rerun_failed', 'rerun_all', 'cancel_run', 'delete_run'].includes(a) && (!project || !info)) return 'run not found';
    if (RERUN.includes(a)) {
      if (!(p.reason ?? '').trim()) return 'a reason is required for a re-run';
      const file = info!.workflow_path.split('/').pop() ?? '';
      if (!project!.rerun_allowed_workflows.includes(file)) return `workflow ${file} is not allow-listed for re-runs`; // every actor, every re-run path
      if (info!.status !== 'completed') return 'run has not finished';
      if (a === 'rerun_failed' && info!.conclusion !== 'failure') return 'only a finished run that failed can be re-run';
    }
    if (a === 'cancel_run' && info!.status === 'completed') return 'run already finished';
    if (a === 'delete_run' && info!.status !== 'completed') return 'only finished runs can be deleted';
    if (a === 'kill_slot' || a === 'restart_slot') { if (!r || !['started', 'running'].includes(r.state)) return 'no such running slot (a slot that is still starting is left to its timeout)'; }
    return null;
  }

  private async execute(actor: Actor, a: Action, p: P, project: Project | undefined, info: RunInfo | undefined, limits: { perRun?: number; perHour?: number } | undefined,
    reservation: { id: string } | undefined): Promise<Outcome> {
    const d = this.d;
    // Fresh read right before the mutation: the head SHA and run state must still be what was judged and approved.
    const unchanged = async (): Promise<string | null> => {
      let fresh: RunInfo;
      try { fresh = await d.github.runInfo(project!.repo, p.run_id!); } catch (e) { throw new PreMutation(`cannot re-read the run: ${(e as Error).message}`); }
      if (fresh.head_sha !== info!.head_sha) return 'the run changed (new head SHA) since it was checked';
      if (RERUN.includes(a) && fresh.superseded) return 'run was superseded by a newer push';
      return this.precondition(a, actor, p, project, fresh);
    };
    switch (a) {
      case 'pause_all': d.pauses.setAll(true); return { status: 'done' };
      case 'resume_all': d.pauses.setAll(false); return { status: 'done' };
      case 'pause_slot': d.pauses.setSlot(p.slot!, true); return { status: 'done' };
      case 'resume_slot': d.pauses.setSlot(p.slot!, false); return { status: 'done' };
      case 'kill_slot': case 'restart_slot': {
        const r = d.state.get(reservation!.id);
        if (!r || !['started', 'running'].includes(r.state)) return { status: 'refused', reason: 'slot is no longer running' };
        d.state.transition(r.id, 'failed', { error: `${a} by ${actor.name}` }); // the next tick stops the container and removes the runner
        return { status: 'done', detail: 'slot marked failed; teardown happens on the next tick' };
      }
      case 'cancel_run': { const x = await unchanged(); if (x) return { status: 'refused', reason: x }; await d.github.cancel(project!.repo, p.run_id!); return { status: 'done' }; }
      case 'delete_run': { const x = await unchanged(); if (x) return { status: 'refused', reason: x }; await d.github.deleteRun(project!.repo, p.run_id!); return { status: 'done' }; }
      case 'rerun_failed': case 'rerun_all': {
        const x = await unchanged(); if (x) return { status: 'refused', reason: x };
        // One atomic reservation for every re-run path and every actor; grid limits can only lower the ceiling.
        const lim = { perRun: Math.min(limits?.perRun ?? HARD_RERUN.perRun, HARD_RERUN.perRun), perHour: Math.min(limits?.perHour ?? HARD_RERUN.perHour, HARD_RERUN.perHour) };
        const slot = d.reruns.reserve(project!.repo, p.run_id!, actor.name, p.reason ?? '', lim);
        if (!slot.ok) return { status: 'refused', reason: slot.reason };
        try { await (a === 'rerun_failed' ? d.github.rerunFailed : d.github.rerunAll)(project!.repo, p.run_id!); d.reruns.finish(slot.id, 'ok'); }
        catch (e) { d.reruns.finish(slot.id, e instanceof GitHubError && e.status >= 400 && e.status < 500 ? 'rejected' : 'uncertain'); throw e; }
        return { status: 'done', detail: { attempt: slot.attempt } };
      }
      case 'restart_service': {
        if (!d.requestRestart) return { status: 'refused', reason: 'restart requests are not available on this install' };
        const lim = Math.min(limits?.perHour ?? HARD_RESTARTS_PER_HOUR, HARD_RESTARTS_PER_HOUR);
        if (d.audit.countDoneSince('restart_service', Date.now() - 3_600_000) >= lim) return { status: 'refused', reason: `restart limit reached (${lim} per hour): something is wrong that restarting does not fix, tell a human` };
        return { status: 'done', detail: d.requestRestart(p.service!) === 'queued' ? 'restart queued; the watchdog acts within about a minute' : 'a restart request was already waiting' };
      }
      default: return { status: 'refused', reason: 'not implemented yet' };
    }
  }

  /** Read tier: policy-checked and audited like everything else. The caller supplies the data source. */
  private lastAuditRead = new Map<string, number>();
  async read<T>(actor: Actor, action: (typeof READ_ACTIONS)[number], fetch: () => Promise<T> | T): Promise<{ status: 'done'; data: T } | { status: 'denied'; reason: string }> {
    const dec = this.d.policy.decide(actor, action);
    const log = (result: string) => this.d.audit.append({ actor: actor.name, actorType: actor.type, action, result });
    if (dec.decision !== 'allow') { log('denied'); return { status: 'denied', reason: dec.reason }; }
    const data = await fetch();
    if (action === 'audit_read' && Date.now() - (this.lastAuditRead.get(actor.name) ?? 0) > 300_000) { this.lastAuditRead.set(actor.name, Date.now()); log('done'); } // logged once per actor per 5 min: the open dashboard polls it every few seconds. Routine reads (status, runs, resources) are not logged: the dashboard polls every few seconds. Denials always are.
    return { status: 'done', data };
  }
}
