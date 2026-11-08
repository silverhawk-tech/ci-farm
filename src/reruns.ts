import type { DatabaseSync } from 'node:sqlite';

// Re-run guardrails (plan 6): per-run cap and a GLOBAL hourly cap (all actors together) enforced in ONE transaction, serialised per run.
// The intent row is written BEFORE the GitHub call and its result after; an uncertain outcome keeps consuming quota until a human reconciles it.
export type RerunResult = 'ok' | 'rejected' | 'uncertain';
export interface RerunLimits { perRun: number; perHour: number }

export class Reruns {
  private db: DatabaseSync;
  private now: () => number;
  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db; this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS rerun (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, run_id INTEGER NOT NULL, actor TEXT NOT NULL,
      reason TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL)`); // state: intent | ok | rejected | uncertain
  }

  /** Reserve one re-run, or explain why not. Calls GitHub later rejects do not consume quota (finish with 'rejected'). */
  reserve(repo: string, runId: number, actor: string, reason: string, lim: RerunLimits): { ok: true; id: number; attempt: number } | { ok: false; reason: string } {
    if (!reason.trim()) return { ok: false, reason: 'a reason is required' };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const t = this.now();
      const open = this.db.prepare("SELECT 1 FROM rerun WHERE repo = ? AND run_id = ? AND state IN ('intent','uncertain')").get(repo, runId);
      const perRun = (this.db.prepare("SELECT COUNT(*) AS n FROM rerun WHERE repo = ? AND run_id = ? AND state != 'rejected'").get(repo, runId) as { n: number }).n;
      const perHour = (this.db.prepare("SELECT COUNT(*) AS n FROM rerun WHERE at > ? AND state != 'rejected'").get(t - 3_600_000) as { n: number }).n;
      const refuse = open ? 'another re-run of this run is in flight or unresolved'
        : perRun >= lim.perRun ? `this run was already re-run ${perRun} time(s); report it to a human (suspected flaky: fix it, do not retry)`
        : perHour >= lim.perHour ? `hourly re-run cap (${lim.perHour}) reached` : null;
      if (refuse) { this.db.exec('ROLLBACK'); return { ok: false, reason: refuse }; }
      const id = Number(this.db.prepare("INSERT INTO rerun (repo, run_id, actor, reason, at, state) VALUES (?,?,?,?,?,'intent')").run(repo, runId, actor, reason, t).lastInsertRowid);
      this.db.exec('COMMIT');
      return { ok: true, id, attempt: perRun + 1 };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  finish(id: number, result: RerunResult) { this.db.prepare('UPDATE rerun SET state = ? WHERE id = ?').run(result, id); }
  /** Startup reconciliation: anything still 'intent' crashed mid-call and is now uncertain. */
  markCrashedUncertain() { this.db.prepare("UPDATE rerun SET state = 'uncertain' WHERE state = 'intent'").run(); }
}
