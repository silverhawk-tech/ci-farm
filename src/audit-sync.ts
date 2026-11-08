import { z } from 'zod';
import type { Audit } from './audit.ts';

// Controller side of the audit receiver (plan section 7): streams local rows to the receiver, reports its head as a heartbeat, and answers
// one question for the rest of the code: may a destructive action run right now? Only if an independent record exists and is current.
// The receiver's replies are never trusted by shape: each one is validated, and every claim about its head is cross-checked against our
// own chain, so a wrong or fake listener on the socket closes the gate instead of opening it.

export type ReceiverState = 'unknown' | 'in_sync' | 'lagging' | 'tampered';
export interface ReceiverStatus { reachable: boolean; state: ReceiverState; lag: number; lastOk: number; refusals: number; error: string; head?: { seq: number; hash: string } | null }
type Call = (req: object) => Promise<unknown>;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const head = z.object({ seq: z.number().int().positive(), hash: hex64 }).strict().nullable();
const headReply = z.object({ ok: z.literal(true), head, broken: z.string() }).strict();
const appendReply = z.object({ ok: z.boolean(), error: z.string().max(300).optional(), head }).strict();
const beatReply = z.object({ ok: z.literal(true), state: z.enum(['in_sync', 'lagging', 'tampered']), lag: z.number().int().nonnegative(), head }).strict();

class BadReply extends Error {}
const parse = <T>(schema: z.ZodType<T>, v: unknown): T => { const r = schema.safeParse(v); if (!r.success) throw new BadReply('receiver sent an invalid reply'); return r.data; };

export class AuditSync {
  status: ReceiverStatus = { reachable: false, state: 'unknown', lag: 0, lastOk: 0, refusals: 0, error: 'not synced yet' };
  private audit: Audit;
  private call: Call;
  private now: () => number;
  private maxLag: number;
  private staleMs: number;
  private inflight: Promise<void> | null = null;

  constructor(audit: Audit, call: Call, opts: { now?: () => number; maxLag?: number; staleMs?: number } = {}) {
    this.audit = audit; this.call = call; this.now = opts.now ?? Date.now; this.maxLag = opts.maxLag ?? 5; this.staleMs = opts.staleMs ?? 90_000;
  }

  /** One round: send what the receiver is missing, then a heartbeat. Single flight (a slow round is never overlapped by the next one).
   *  Never throws; an unreachable or lying receiver just shows in `status`. */
  syncOnce(): Promise<void> {
    if (!this.inflight) this.inflight = this.round().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private tamper(error: string, refused = false): void {
    this.status = { ...this.status, reachable: true, state: 'tampered', lastOk: this.now(), refusals: this.status.refusals + (refused ? 1 : 0), error };
  }

  private async round(): Promise<void> {
    try {
      const h = parse(headReply, await this.call({ op: 'head' }));
      let seq = h.head?.seq ?? 0;
      const mine = this.audit.head();
      // The receiver's own head must be a point on OUR chain; if not, the two histories have diverged.
      if (h.broken) return this.tamper(`receiver file is broken: ${h.broken.slice(0, 80)}`);
      if (h.head && (h.head.seq > (mine?.seq ?? 0) || this.audit.hashAt(h.head.seq) !== h.head.hash)) return this.tamper('receiver holds history that is not in the local chain');
      for (let batch = 0; batch < 100; batch++) { // bounded: a flood of new rows ends the round as 'lagging', never an endless loop
        const rows = this.audit.rowsAfter(seq, 50);
        if (!rows.length) break;
        const r = parse(appendReply, await this.call({ op: 'append', rows }));
        if (!r.ok) return this.tamper(r.error ?? 'receiver refused rows', true); // a row that does not continue its chain: the histories disagree
        const last = rows[rows.length - 1];
        if (!r.head || r.head.seq !== last.seq || r.head.hash !== last.hash) throw new BadReply('receiver acknowledged rows it did not store');
        seq = r.head.seq;
      }
      const sent = this.audit.head();
      const hb = parse(beatReply, await this.call({ op: 'heartbeat', head: sent }));
      if (hb.state !== 'tampered') {
        // Its claims must be consistent with what we just sent and with our chain; an inconsistent reply is a broken receiver, not "in sync".
        const behind = (sent?.seq ?? 0) - (hb.head?.seq ?? 0);
        const same = (sent === null && hb.head === null) || (sent !== null && hb.head !== null && sent.seq === hb.head.seq && sent.hash === hb.head.hash);
        if (hb.head && this.audit.hashAt(hb.head.seq) !== hb.head.hash) return this.tamper('receiver head is not on the local chain');
        if (hb.state === 'in_sync' ? !same || hb.lag !== 0 : same || behind <= 0 || hb.lag !== behind) throw new BadReply('receiver sent an inconsistent reply');
      }
      this.status = { reachable: true, state: hb.state, lag: hb.lag, head: hb.head, lastOk: this.now(), refusals: this.status.refusals, error: hb.state === 'tampered' ? 'local and receiver chains disagree' : '' };
    } catch (e) {
      this.status = { ...this.status, reachable: false, error: (e as Error).message.slice(0, 120) };
    }
  }

  tampered(): boolean { return this.status.state === 'tampered'; }

  /** Destructive actions need an independent, current record. */
  gate(): { ok: boolean; reason?: string } {
    const s = this.status;
    if (s.state === 'tampered') return { ok: false, reason: 'audit receiver reports the chains disagree' };
    if (!s.reachable || this.now() - s.lastOk > this.staleMs) return { ok: false, reason: 'audit receiver unreachable' };
    if (s.lag > this.maxLag) return { ok: false, reason: `audit receiver is ${s.lag} rows behind` };
    return { ok: true };
  }
}
