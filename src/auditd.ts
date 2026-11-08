import { createServer, type Server } from 'node:net';
import { appendFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { hashOf, ZERO, type AuditRow } from './audit.ts';

// Independent audit receiver (plan section 7). Runs as its own user (ci-audit), keeps a second copy of every audit row in an append-only
// file (chattr +a, set by the root installer) and validates each row itself: seq = last + 1, prev_hash = its own last hash, hash recomputes.
// The controller can therefore only ever APPEND; it cannot rewrite or shorten history the receiver already holds. A compromised controller
// can still append forged rows going forward, and root can still delete the file: that is stated in the plan, not hidden.

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const str = (n: number) => z.string().max(n);
const row = z.object({
  seq: z.number().int().positive(), ts: z.number().int().nonnegative(), actor: str(200), actorType: z.enum(['human', 'agent', 'system']), action: str(100),
  target: str(8192), params: str(8192), result: str(100), approver: str(200), note: str(2000), prev_hash: hex64, hash: hex64,
}).strict();
const head = z.object({ seq: z.number().int().positive(), hash: hex64 }).strict().nullable();
const request = z.discriminatedUnion('op', [
  z.object({ op: z.literal('head') }).strict(),
  z.object({ op: z.literal('append'), rows: z.array(row).min(1).max(50) }).strict(),
  z.object({ op: z.literal('heartbeat'), head }).strict(),
  z.object({ op: z.literal('anchor') }).strict(),
]);

export type SyncState = 'in_sync' | 'lagging' | 'tampered';
type Head = { seq: number; hash: string } | null;

export class AuditStore {
  head: Head = null;
  broken = '';
  refusals = 0;
  private file: string;
  private now: () => number;
  private lastHbLogged = 0;
  private lastState: SyncState | '' = '';

  constructor(file: string, now: () => number = Date.now) {
    this.file = file; this.now = now;
    if (existsSync(file)) this.loadAndVerify(); // an existing file that does not verify means the receiver itself must not vouch for anything
  }

  /** Verifies the whole file. A torn final line (power cut mid-append) is the one tolerated defect: the file is append-only, so it cannot be
   *  trimmed; instead the line is terminated and a `recovered` record naming its byte length is appended. A junk line anywhere else, or one
   *  without that matching record, still means the file was edited. */
  private loadAndVerify(): void {
    const text = readFileSync(this.file, 'utf8');
    const endsClean = text === '' || text.endsWith('\n');
    let prev = ZERO, seq = 0, junk: number | null = null;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let o: { t?: string; torn_bytes?: number } & Partial<AuditRow>;
      try { o = JSON.parse(line); } catch {
        if (junk !== null) { this.broken = `unreadable lines after seq ${seq}`; return; }
        junk = Buffer.byteLength(line); continue;
      }
      if (junk !== null) {
        if (o.t === 'recovered' && o.torn_bytes === junk) { junk = null; continue; }
        this.broken = `unreadable line after seq ${seq}`; return;
      }
      if (o.t !== 'row') continue; // heartbeat, refusal, checkpoint and recovered lines
      const r = o as AuditRow;
      if (r.seq !== seq + 1 || r.prev_hash !== prev || hashOf(prev, r) !== r.hash) { this.broken = `chain broken at seq ${r.seq}`; return; }
      prev = r.hash; seq = r.seq;
    }
    this.head = seq ? { seq, hash: prev } : null;
    if (!endsClean) { // torn tail: finish the line, and say so in the file itself
      appendFileSync(this.file, '\n');
      if (junk !== null) { this.write('recovered', { ts: this.now(), torn_bytes: junk }); junk = null; }
    }
    if (junk !== null) this.broken = `unreadable line after seq ${seq}`;
  }

  private write(t: string, o: object): void { appendFileSync(this.file, JSON.stringify({ t, ...o }) + '\n', { mode: 0o600 }); }

  /** Appends the longest valid prefix. The first row that does not continue the chain stops the batch and is counted as a refusal. */
  append(rows: AuditRow[]): { ok: boolean; error?: string; head: Head } {
    if (this.broken) return { ok: false, error: `receiver file is broken: ${this.broken}`, head: this.head };
    for (const r of rows) {
      const seq = (this.head?.seq ?? 0) + 1, prev = this.head?.hash ?? ZERO;
      const why = r.seq !== seq ? `expected seq ${seq}, got ${r.seq}` : r.prev_hash !== prev ? 'prev_hash does not continue the chain' : hashOf(prev, r) !== r.hash ? 'hash does not match the row' : '';
      if (why) { this.refusals++; this.write('refused', { ts: this.now(), seq: r.seq, why }); return { ok: false, error: why, head: this.head }; }
      this.write('row', r);
      this.head = { seq: r.seq, hash: r.hash };
    }
    return { ok: true, head: this.head };
  }

  /** Compares the sender's head with ours. Behind is normal (lagging); shorter than us, or a different hash at the same seq, is tampering. */
  heartbeat(sender: Head): { state: SyncState; lag: number; head: Head } {
    const mine = this.head;
    let state: SyncState, lag = 0;
    if (this.broken) state = 'tampered';
    else if (!sender) state = mine ? 'tampered' : 'in_sync';
    else if (!mine) { state = 'lagging'; lag = sender.seq; }
    else if (sender.seq < mine.seq) state = 'tampered';
    else if (sender.seq === mine.seq) state = sender.hash === mine.hash ? 'in_sync' : 'tampered';
    else { state = 'lagging'; lag = sender.seq - mine.seq; }
    const t = this.now();
    if (state !== this.lastState || t - this.lastHbLogged >= 300_000) { this.write('heartbeat', { ts: t, state, sender, head: mine }); this.lastHbLogged = t; this.lastState = state; }
    return { state, lag, head: mine };
  }

  /** The checkpoint to keep somewhere outside this machine. */
  anchor(): { seq: number; hash: string; ts: number } | null { return this.head ? { ...this.head, ts: this.now() } : null; }
  checkpoint(): void { this.write('checkpoint', { ts: this.now(), head: this.head }); }
}

export interface AuditdOptions { socketPath: string; store: AuditStore; socketMode?: number }

export function startAuditd(o: AuditdOptions): Promise<Server> {
  let chain: Promise<unknown> = Promise.resolve(); // one request at a time: appends can never interleave
  const serial = <T>(f: () => T): Promise<T> => { const r = chain.then(f, f); chain = r.catch(() => {}); return r; };
  const handle = async (raw: string): Promise<unknown> => {
    const parsed = request.safeParse(JSON.parse(raw));
    if (!parsed.success) return { ok: false, error: 'bad request' };
    const r = parsed.data;
    return serial(() => {
      switch (r.op) {
        case 'head': return { ok: true, head: o.store.head, broken: o.store.broken };
        case 'append': return o.store.append(r.rows as AuditRow[]);
        case 'heartbeat': return { ok: true, ...o.store.heartbeat(r.head) };
        case 'anchor': return { ok: true, anchor: o.store.anchor(), refusals: o.store.refusals };
      }
    });
  };
  const server = createServer((sock) => {
    let buf = '', done = false;
    sock.setTimeout(30_000, () => sock.destroy());
    sock.on('data', (d) => {
      if (done) return;
      buf += d;
      if (buf.length > 1_000_000) return void sock.destroy();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      done = true; sock.pause(); // exactly one request per connection
      handle(buf.slice(0, nl)).catch(() => ({ ok: false, error: 'bad request' })).then((res) => sock.end(JSON.stringify(res) + '\n'));
    });
    sock.on('error', () => {});
  });
  server.maxConnections = 8;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.socketPath, () => { chmodSync(o.socketPath, o.socketMode ?? 0o660); resolve(server); });
  });
}
