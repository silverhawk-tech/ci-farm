import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import type { Actor } from './policy.ts';

/** API identities: one token per person or agent. Only the sha256 of a token is stored; the raw token is shown once at creation. */
export class Actors {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec('CREATE TABLE IF NOT EXISTS actor (name TEXT PRIMARY KEY, type TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL)');
  }
  static hash(token: string) { return createHash('sha256').update(token).digest('hex'); }
  /** Creates or rotates the token for a name. Returns the raw token once. */
  issue(name: string, type: Actor['type']): string {
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(name)) throw new Error('bad actor name');
    const existing = this.db.prepare('SELECT type FROM actor WHERE name = ?').get(name) as { type: string } | undefined;
    if (existing && existing.type !== type) throw new Error(`actor ${name} is a ${existing.type}; its type cannot change`);
    const token = 'cim_' + randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO actor (name, type, token_hash, created) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET token_hash = excluded.token_hash, type = excluded.type')
      .run(name, type, Actors.hash(token), Date.now());
    return token;
  }
  type(name: string): Actor['type'] | null { return (this.db.prepare('SELECT type FROM actor WHERE name = ?').get(name) as { type: Actor['type'] } | undefined)?.type ?? null; }
  verify(token: string | undefined): Actor | null {
    if (!token) return null;
    const r = this.db.prepare('SELECT name, type FROM actor WHERE token_hash = ?').get(Actors.hash(token)) as { name: string; type: Actor['type'] } | undefined;
    return r ? { name: r.name, type: r.type } : null;
  }
}
