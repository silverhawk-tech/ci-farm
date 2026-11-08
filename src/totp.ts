import type { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes } from 'node:crypto';

// Step-up for approvals and permission changes (plan 6): TOTP fallback, each code usable once. WebAuthn is the preferred upgrade.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const generateSecret = () => randomBytes(20);
export const toBase32 = (b: Buffer) => { let bits = '', out = ''; for (const x of b) bits += x.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; };
export const otpauthUri = (secret: Buffer, account: string) => `otpauth://totp/ci-master:${encodeURIComponent(account)}?secret=${toBase32(secret)}&issuer=ci-master`;

/** RFC 6238, HMAC-SHA1, 6 digits, 30 s step. */
export function code(secret: Buffer, step: number): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(msg).digest();
  const o = h[19] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export class Totp {
  private db: DatabaseSync;
  private secret: Buffer;
  private now: () => number;
  constructor(db: DatabaseSync, secret: Buffer, now: () => number = Date.now) {
    this.db = db; this.secret = secret; this.now = now;
    db.exec('CREATE TABLE IF NOT EXISTS totp_used (step INTEGER PRIMARY KEY)');
    db.exec('CREATE TABLE IF NOT EXISTS totp_fail (at INTEGER NOT NULL)');
  }
  /** Accepts the current step and one either side (clock drift). A step that was already accepted is refused, so a code works once. */
  static readonly MAX_FAILS = 5;
  static readonly WINDOW_MS = 5 * 60_000;
  /** True while too many recent wrong codes have been seen: nothing is checked (and nothing is revealed) until the window passes. */
  locked(): boolean {
    const t = this.now();
    return (this.db.prepare('SELECT COUNT(*) AS n FROM totp_fail WHERE at > ?').get(t - Totp.WINDOW_MS) as { n: number }).n >= Totp.MAX_FAILS;
  }
  verify(input: string): boolean {
    if (this.locked()) return false;
    const ok = this.check(input);
    if (!ok) { this.db.prepare('INSERT INTO totp_fail (at) VALUES (?)').run(this.now()); this.db.prepare('DELETE FROM totp_fail WHERE at < ?').run(this.now() - 24 * 3_600_000); }
    return ok;
  }
  private check(input: string): boolean {
    if (!/^\d{6}$/.test(input)) return false;
    const cur = Math.floor(this.now() / 30_000);
    for (const step of [cur, cur - 1, cur + 1]) {
      if (code(this.secret, step) !== input) continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const used = this.db.prepare('SELECT 1 FROM totp_used WHERE step = ?').get(step);
        if (!used) this.db.prepare('INSERT INTO totp_used (step) VALUES (?)').run(step);
        this.db.exec('COMMIT');
        return !used;
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
    return false;
  }
}
