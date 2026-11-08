import type { DatabaseSync } from 'node:sqlite';

// Approvals (plan 6, R6): bound to the exact action, repo, immutable target and parameters; expiring; single-use.
// Agents can only create requests. Deciding needs a human identity AND a verified step-up, both supplied by the API layer.

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired';
export interface Binding { repo: string; target: Record<string, unknown>; params?: Record<string, unknown> }
export interface Approval { id: number; requester: string; action: string; binding: string; created: number; expires: number; state: ApprovalState; decided_by: string | null; decided_at: number | null }

const canon = (o: unknown): string => JSON.stringify(o, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
const bindingKey = (b: Binding) => canon({ repo: b.repo, target: b.target, params: b.params ?? {} });

export class Approvals {
  private db: DatabaseSync;
  private now: () => number;
  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db; this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS approval (id INTEGER PRIMARY KEY AUTOINCREMENT, requester TEXT NOT NULL, action TEXT NOT NULL, binding TEXT NOT NULL,
      created INTEGER NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL, decided_by TEXT, decided_at INTEGER)`);
  }

  /** Create (or return the existing identical pending) request. Default life: 15 minutes. */
  request(requester: string, action: string, b: Binding, ttlMs = 15 * 60_000): number {
    const key = bindingKey(b), t = this.now();
    const dup = this.db.prepare("SELECT id FROM approval WHERE requester = ? AND action = ? AND binding = ? AND state = 'pending' AND expires > ?").get(requester, action, key, t) as { id: number } | undefined;
    if (dup) return dup.id;
    return Number(this.db.prepare("INSERT INTO approval (requester, action, binding, created, expires, state) VALUES (?,?,?,?,?,'pending')").run(requester, action, key, t, t + ttlMs).lastInsertRowid);
  }

  get(id: number): Approval | undefined { return this.db.prepare('SELECT * FROM approval WHERE id = ?').get(id) as Approval | undefined; }
  list(state?: ApprovalState): Approval[] {
    this.expireOld();
    return (state ? this.db.prepare('SELECT * FROM approval WHERE state = ? ORDER BY id DESC').all(state) : this.db.prepare('SELECT * FROM approval ORDER BY id DESC').all()) as unknown as Approval[];
  }
  private expireOld() { this.db.prepare("UPDATE approval SET state = 'expired' WHERE state IN ('pending','approved') AND expires <= ?").run(this.now()); }

  /** Approving needs `stepUpOk` from a verified second factor; rejecting only stops something, so it does not. */
  decide(id: number, human: string, verdict: 'approve' | 'reject', stepUpOk: boolean): { ok: boolean; reason?: string } {
    if (verdict === 'approve' && !stepUpOk) return { ok: false, reason: 'step-up not verified' };
    this.expireOld();
    const r = this.db.prepare("UPDATE approval SET state = ?, decided_by = ?, decided_at = ? WHERE id = ? AND state = 'pending'").run(verdict === 'approve' ? 'approved' : 'rejected', human, this.now(), id);
    return r.changes === 1 ? { ok: true } : { ok: false, reason: 'not pending (unknown, expired or already decided)' };
  }

  /** Give an approval back ONLY after a definite failure (GitHub refused the call). An uncertain outcome keeps it consumed. */
  release(id: number): void { this.db.prepare("UPDATE approval SET state = 'approved' WHERE id = ? AND state = 'consumed' AND expires > ?").run(id, this.now()); }

  /** Single-use: marks consumed in one statement, only if approved, unexpired, and the action and binding still match exactly. */
  consume(id: number, requester: string, action: string, b: Binding): { ok: boolean; reason?: string } {
    this.expireOld();
    const a = this.get(id);
    if (!a) return { ok: false, reason: 'unknown approval' };
    if (a.requester !== requester) return { ok: false, reason: 'approval was granted to a different requester' };
    if (a.action !== action || a.binding !== bindingKey(b)) return { ok: false, reason: 'approval does not match this action and target' };
    const r = this.db.prepare("UPDATE approval SET state = 'consumed' WHERE id = ? AND state = 'approved' AND expires > ?").run(id, this.now());
    return r.changes === 1 ? { ok: true } : { ok: false, reason: `approval is ${a.state}` };
  }
}
