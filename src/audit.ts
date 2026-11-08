import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

// Tamper-evident audit log (plan 4a R11): every row's hash covers the previous row's hash, so editing or deleting a row in the middle
// breaks the chain. Truncating the END is only detectable against a checkpoint kept elsewhere (head() is meant to be exported).
// Residual, stated: a compromised writer can still append forged rows; an off-machine receiver and checkpoints come later.

export interface AuditEvent {
  actor: string; actorType: 'human' | 'agent' | 'system'; action: string;
  target?: unknown; params?: unknown; result: string; approver?: string; note?: string;
}
export interface AuditRow extends Required<Omit<AuditEvent, 'target' | 'params'>> { seq: number; ts: number; target: string; params: string; prev_hash: string; hash: string }

const SECRET_KEY = /jit|token|secret|key|password|credential|authorization/i;
const SECRET_VALUE = [/cim_[0-9a-f]{16,}/g, /gh[pousr]_[A-Za-z0-9]{20,}/g, /[A-Za-z0-9+/=_-]{200,}/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----/g];

/** Redact anything that looks like a credential, by key name or by value shape, before it can reach any log. */
export function redact(v: unknown): unknown {
  if (typeof v === 'string') return SECRET_VALUE.reduce((s, re) => s.replace(re, '[redacted]'), v);
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redact(x)]));
  return v;
}

/** Runs fn in a transaction: BEGIN IMMEDIATE normally, a SAVEPOINT when the caller already holds one (so audit rows can join a caller's transaction). */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) {
    db.exec('SAVEPOINT nested');
    try { const r = fn(); db.exec('RELEASE nested'); return r; } catch (e) { db.exec('ROLLBACK TO nested'); db.exec('RELEASE nested'); throw e; }
  }
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const ZERO = '0'.repeat(64);
const canon = (o: unknown) => JSON.stringify(o);
export const hashOf = (prev: string, r: { seq: number; ts: number; actor: string; actorType: string; action: string; target: string; params: string; result: string; approver: string; note: string }) =>
  createHash('sha256').update(prev + canon([r.seq, r.ts, r.actor, r.actorType, r.action, r.target, r.params, r.result, r.approver, r.note])).digest('hex');

export class Audit {
  private db: DatabaseSync;
  private now: () => number;
  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db; this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS audit (
      seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT NOT NULL, actorType TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
      params TEXT NOT NULL, result TEXT NOT NULL, approver TEXT NOT NULL, note TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)`);
  }

  /** Run `fn` and its audit rows in one transaction (all committed or none), for state changes that must never exist without their audit row. */
  atomically<T>(fn: () => T): T { return tx(this.db, fn); }

  append(e: AuditEvent): { seq: number; hash: string } {
    return tx(this.db, () => {
      const last = this.db.prepare('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string } | undefined;
      const seq = (last?.seq ?? 0) + 1, prev = last?.hash ?? ZERO;
      const row = { seq, ts: this.now(), actor: e.actor, actorType: e.actorType, action: e.action, target: canon(redact(e.target ?? null)), params: canon(redact(e.params ?? null)),
        result: e.result, approver: e.approver ?? '', note: String(redact(e.note ?? '')) };
      const hash = hashOf(prev, row);
      this.db.prepare('INSERT INTO audit (seq, ts, actor, actorType, action, target, params, result, approver, note, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(row.seq, row.ts, row.actor, row.actorType, row.action, row.target, row.params, row.result, row.approver, row.note, prev, hash);
      return { seq, hash };
    });
  }

  /** Walks the whole chain. Returns the first broken sequence number, if any. */
  verify(): { ok: true; rows: number } | { ok: false; brokenAt: number } {
    let prev = ZERO, expectSeq = 1;
    for (const r of this.db.prepare('SELECT * FROM audit ORDER BY seq').all() as unknown as AuditRow[]) {
      if (r.seq !== expectSeq || r.prev_hash !== prev || hashOf(prev, r) !== r.hash) return { ok: false, brokenAt: r.seq };
      prev = r.hash; expectSeq++;
    }
    return { ok: true, rows: expectSeq - 1 };
  }

  /** The chain head: export this off-machine on a schedule; a later shorter chain or a different hash at the same seq proves tampering. */
  head(): { seq: number; hash: string } | null {
    return (this.db.prepare('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string } | undefined) ?? null;
  }

  /** How many times `action` finished with result 'done' since `sinceTs` (a ceiling that survives restarts, because it is read from the log). */
  countDoneSince(action: string, sinceTs: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = ? AND result = 'done' AND ts >= ?").get(action, sinceTs) as { n: number }).n;
  }

  /** The hash we hold for one sequence number, to check the receiver's claim about its own head against our history. */
  hashAt(seq: number): string | undefined {
    return (this.db.prepare('SELECT hash FROM audit WHERE seq = ?').get(seq) as { hash: string } | undefined)?.hash;
  }

  /** Rows with seq > `seq`, oldest first: what the receiver sync still has to send. */
  rowsAfter(seq: number, limit = 50): AuditRow[] {
    return this.db.prepare('SELECT * FROM audit WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(seq, limit) as unknown as AuditRow[];
  }

  list(limit = 100, beforeSeq = Number.MAX_SAFE_INTEGER): AuditRow[] {
    return this.db.prepare('SELECT * FROM audit WHERE seq < ? ORDER BY seq DESC LIMIT ?').all(beforeSeq, limit) as unknown as AuditRow[];
  }
}
