import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

// Lifecycle of one slot reservation (plan section 3, R9). A slot stays occupied until torn_down.
export type State = 'reserved' | 'minted' | 'started' | 'running' | 'finished' | 'failed' | 'torn_down';
const NEXT: Record<State, State[]> = {
  reserved: ['minted', 'failed'],
  minted: ['started', 'failed'],
  started: ['running', 'failed'],
  running: ['finished', 'failed'],
  finished: ['torn_down'],
  failed: ['torn_down'],
  torn_down: [],
};

export interface Reservation {
  id: string; project: string; repo: string; slot: number; state: State;
  run_id: number; job_id: number; head_sha: string; pr_number: number | null;
  runner_name: string | null; runner_id: number | null; error: string | null; created_at: number; updated_at: number;
  /** The broker group that holds this slot's container, fixed at reservation time: teardown goes there even if the registry changed since. */
  isolation_group: string;
}
export interface ReserveRequest { project: string; repo: string; run_id: number; job_id: number; head_sha: string; pr_number: number | null; isolation_group?: string }
export interface Limits { projectMaxSlots: number; globalMaxSlots: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, repo TEXT NOT NULL, slot INTEGER NOT NULL, state TEXT NOT NULL,
  run_id INTEGER NOT NULL, job_id INTEGER NOT NULL, head_sha TEXT NOT NULL, pr_number INTEGER,
  runner_name TEXT, runner_id INTEGER, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  isolation_group TEXT NOT NULL DEFAULT 'farm'
);
-- one live reservation per slot and per job: the database, not the poller, prevents double starts
CREATE UNIQUE INDEX IF NOT EXISTS one_live_per_slot ON reservations(slot) WHERE state != 'torn_down';
CREATE UNIQUE INDEX IF NOT EXISTS one_live_per_job ON reservations(repo, job_id) WHERE state != 'torn_down';
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reservation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, reservation_id TEXT NOT NULL, at INTEGER NOT NULL, from_state TEXT, to_state TEXT NOT NULL, note TEXT
);`;

export class StateDb {
  private db: DatabaseSync;
  private now: () => number;
  constructor(path: string, now: () => number = Date.now) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    // State files from before isolation groups lack the column; every reservation they hold lives in the original single broker, 'farm'.
    const cols = this.db.prepare('PRAGMA table_info(reservations)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'isolation_group')) this.db.exec("ALTER TABLE reservations ADD COLUMN isolation_group TEXT NOT NULL DEFAULT 'farm'");
  }

  /** Atomically reserve the lowest free slot, or return null when a limit is reached or the job is already reserved. */
  reserve(req: ReserveRequest, limits: Limits, held: number[] = []): Reservation | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const live = this.db.prepare("SELECT project, slot FROM reservations WHERE state != 'torn_down'").all() as { project: string; slot: number }[];
      const dup = this.db.prepare("SELECT 1 FROM reservations WHERE repo = ? AND job_id = ? AND state != 'torn_down'").get(req.repo, req.job_id);
      if (dup || live.length >= limits.globalMaxSlots || live.filter((r) => r.project === req.project).length >= limits.projectMaxSlots) {
        this.db.exec('ROLLBACK');
        return null;
      }
      const used = new Set([...live.map((r) => r.slot), ...held]); // held slots (paused by a human or agent) are never handed out
      let slot = 1;
      while (used.has(slot)) slot++;
      if (slot > limits.globalMaxSlots) { this.db.exec('ROLLBACK'); return null; } // every configured slot is busy or held
      const t = this.now();
      const id = randomUUID();
      this.db.prepare('INSERT INTO reservations (id, project, repo, slot, state, run_id, job_id, head_sha, pr_number, created_at, updated_at, isolation_group) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, req.project, req.repo, slot, 'reserved', req.run_id, req.job_id, req.head_sha, req.pr_number, t, t, req.isolation_group ?? 'farm');
      this.db.prepare('INSERT INTO reservation_events (reservation_id, at, from_state, to_state) VALUES (?,?,NULL,?)').run(id, t, 'reserved');
      this.db.exec('COMMIT');
      return this.get(id)!;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  transition(id: string, to: State, patch: { runner_name?: string; runner_id?: number; error?: string } = {}): Reservation {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cur = this.get(id);
      if (!cur) throw new Error(`unknown reservation ${id}`);
      if (!NEXT[cur.state].includes(to)) throw new Error(`illegal transition ${cur.state} -> ${to}`);
      const t = this.now();
      this.db.prepare('UPDATE reservations SET state = ?, runner_name = COALESCE(?, runner_name), runner_id = COALESCE(?, runner_id), error = COALESCE(?, error), updated_at = ? WHERE id = ?')
        .run(to, patch.runner_name ?? null, patch.runner_id ?? null, patch.error ?? null, t, id);
      this.db.prepare('INSERT INTO reservation_events (reservation_id, at, from_state, to_state, note) VALUES (?,?,?,?,?)').run(id, t, cur.state, to, patch.error ?? null);
      this.db.exec('COMMIT');
      return this.get(id)!;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Atomic single-instance lease (BEGIN IMMEDIATE): two controlds can never both hold it. Renew every tick; it lapses after ttlMs. */
  acquireLease(owner: string, ttlMs: number): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const t = this.now();
      const cur = this.db.prepare('SELECT owner, expires FROM lease WHERE id = 1').get() as { owner: string; expires: number } | undefined;
      const ok = !cur || cur.owner === owner || cur.expires < t;
      if (ok) this.db.prepare('INSERT INTO lease (id, owner, expires) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires = excluded.expires').run(owner, t + ttlMs);
      this.db.exec('COMMIT');
      return ok;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** Give the lease up on clean shutdown so a restart does not wait out the 60 s. Only the owner can. */
  releaseLease(owner: string): void {
    this.db.prepare('UPDATE lease SET expires = 0 WHERE id = 1 AND owner = ?').run(owner);
  }

  /** Random id of this installation, created once. Runner names carry it so we only ever delete our own registrations. */
  instanceId(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'instance'").get() as { value: string } | undefined;
    if (row) return row.value;
    const v = randomUUID().slice(0, 6);
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('instance', ?)").run(v);
    return (this.db.prepare("SELECT value FROM meta WHERE key = 'instance'").get() as { value: string }).value;
  }

  /** Record a runner registration on a reservation without a state change, so teardown can still find and remove it. */
  attachRunner(id: string, name: string, runnerId: number): void {
    this.db.prepare('UPDATE reservations SET runner_name = ?, runner_id = ? WHERE id = ?').run(name, runnerId, id);
  }

  get(id: string): Reservation | undefined {
    return this.db.prepare('SELECT * FROM reservations WHERE id = ?').get(id) as Reservation | undefined;
  }

  /** Everything that still owns a slot. At startup the launcher must reconcile each of these against reality (running containers, GitHub runners). */
  live(): Reservation[] {
    return this.db.prepare("SELECT * FROM reservations WHERE state != 'torn_down' ORDER BY slot").all() as unknown as Reservation[];
  }

  close() { this.db.close(); }
}
