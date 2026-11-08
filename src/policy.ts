import type { DatabaseSync } from 'node:sqlite';

// Permissions are DATA (plan 6-perm): a grid of actor x action -> deny | ask | allow (+limits, optional expiry), read fresh on every call.
// What stays in code: the action list, the hard ceilings, and that no action here can edit the grid or approve a request.

export const READ_ACTIONS = ['status', 'runs', 'run_detail', 'queue', 'audit_read', 'resources', 'diagnose'] as const;
export const REVERSIBLE_ACTIONS = ['pause_all', 'resume_all', 'pause_slot', 'resume_slot', 'rerun_failed', 'restart_service'] as const;
export const GATED_ACTIONS = ['cancel_run', 'rerun_all', 'delete_run', 'kill_slot', 'restart_slot', 'register_project'] as const;
export const ACTIONS = [...READ_ACTIONS, ...REVERSIBLE_ACTIONS, ...GATED_ACTIONS] as const;
export type Action = (typeof ACTIONS)[number];
export type Mode = 'deny' | 'ask' | 'allow';
export type Preset = 'cautious' | 'trusted' | 'readonly';
export interface Limits { perRun?: number; perHour?: number }
export interface Actor { name: string; type: 'human' | 'agent' }
export interface Context { superseded?: boolean; deployLane?: boolean }
export interface Decision { decision: Mode; reason: string; limits?: Limits }

const isAction = (a: string): a is Action => (ACTIONS as readonly string[]).includes(a);
const RERUNS: readonly string[] = ['rerun_failed', 'rerun_all'];

const PRESETS: Record<Preset, Record<Action, { mode: Mode; limits?: Limits }>> = (() => {
  const base = (m: Mode) => Object.fromEntries(ACTIONS.map((a) => [a, { mode: m }])) as Record<Action, { mode: Mode; limits?: Limits }>;
  const withReads = (p: Record<Action, { mode: Mode; limits?: Limits }>) => { for (const a of READ_ACTIONS) p[a] = { mode: 'allow' }; return p; };
  const cautious = withReads(base('ask'));
  for (const a of ['pause_all', 'resume_all', 'pause_slot', 'resume_slot'] as const) cautious[a] = { mode: 'allow' };
  cautious.rerun_failed = { mode: 'allow', limits: { perRun: 2, perHour: 6 } }; // the owner's guardrails
  cautious.restart_service = { mode: 'allow', limits: { perHour: 3 } }; // a root watchdog does the restart; hard ceiling 3 per hour in control.ts
  cautious.register_project = { mode: 'deny' };
  const trusted = { ...cautious };
  for (const a of ['cancel_run', 'rerun_all', 'delete_run'] as const) trusted[a] = { mode: 'allow' };
  const readonly = withReads(base('deny'));
  return { cautious, trusted, readonly };
})();

export class Policy {
  private db: DatabaseSync;
  private now: () => number;
  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db; this.now = now;
    db.exec('CREATE TABLE IF NOT EXISTS permission (actor TEXT NOT NULL, action TEXT NOT NULL, mode TEXT NOT NULL, limits TEXT, expires INTEGER, PRIMARY KEY (actor, action))');
  }

  /** Set one cell. Callers must be a human with step-up; this class does not know who calls it, the API layer enforces that. */
  set(actor: string, action: Action, mode: Mode, opts: { limits?: Limits; expires?: number } = {}): void {
    this.db.prepare('INSERT INTO permission (actor, action, mode, limits, expires) VALUES (?,?,?,?,?) ON CONFLICT(actor, action) DO UPDATE SET mode = excluded.mode, limits = excluded.limits, expires = excluded.expires')
      .run(actor, action, mode, opts.limits ? JSON.stringify(opts.limits) : null, opts.expires ?? null);
  }
  applyPreset(actor: string, preset: Preset): void {
    for (const a of ACTIONS) this.set(actor, a, PRESETS[preset][a].mode, { limits: PRESETS[preset][a].limits });
  }
  matrix(actor: string): Record<string, { mode: Mode; limits?: Limits; expires?: number }> {
    const out: Record<string, { mode: Mode; limits?: Limits; expires?: number }> = {};
    for (const r of this.db.prepare('SELECT action, mode, limits, expires FROM permission WHERE actor = ?').all(actor) as { action: string; mode: Mode; limits: string | null; expires: number | null }[])
      out[r.action] = { mode: r.mode, ...(r.limits ? { limits: JSON.parse(r.limits) } : {}), ...(r.expires ? { expires: r.expires } : {}) };
    return out;
  }

  decide(actor: Actor, action: string, ctx: Context = {}): Decision {
    if (!isAction(action)) return { decision: 'deny', reason: 'unknown or never-exposed action' };
    // Hard ceilings: not editable from the grid, apply to everyone (plan 6, 6a).
    if (RERUNS.includes(action) && ctx.superseded) return { decision: 'deny', reason: 'run was superseded by a newer push' };
    if (RERUNS.includes(action) && ctx.deployLane) return { decision: 'deny', reason: 'deploy/migration lanes are never re-run here' };
    if (actor.type === 'human') return { decision: 'allow', reason: 'human', limits: undefined };
    if (actor.type !== 'agent') return { decision: 'deny', reason: 'unknown actor type' };
    const cell = this.matrix(actor.name)[action];
    if (!cell) return { decision: 'deny', reason: 'no permission set for this action' }; // new actions start as Deny
    if (cell.expires !== undefined && this.now() > cell.expires) return { decision: cell.mode === 'deny' ? 'deny' : 'ask', reason: 'temporary permission expired' };
    return { decision: cell.mode, reason: `grid: ${cell.mode}`, limits: cell.limits };
  }
}
