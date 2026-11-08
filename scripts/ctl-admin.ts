// Local admin tool. Run as ci-control (sudo -u ci-control ...): it is the only way to create tokens or the second factor, so agents cannot.
//   ctl-admin.ts init-totp | issue <name> <human|agent> | preset <agent> <cautious|trusted|readonly> | actors
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Actors } from '../src/actors.ts';
import { ACTIONS, Policy, type Action, type Mode, type Preset } from '../src/policy.ts';
import { generateSecret, otpauthUri, toBase32 } from '../src/totp.ts';

const dir = process.env.CI_CONTROL_DIR ?? '/var/lib/ci-control';
const db = new DatabaseSync(`${dir}/control.sqlite`);
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'init-totp') {
  const f = `${dir}/secrets/totp.secret`;
  if (existsSync(f)) { console.error('a TOTP secret already exists; delete it deliberately to rotate'); process.exit(1); }
  mkdirSync(`${dir}/secrets`, { recursive: true, mode: 0o700 });
  const s = generateSecret();
  writeFileSync(f, s.toString('hex'), { mode: 0o400 });
  console.log('Add this to your authenticator app (shown once):\n  ' + otpauthUri(s, 'ci-master') + '\n  manual key: ' + toBase32(s));
} else if (cmd === 'issue' && a && (b === 'human' || b === 'agent')) {
  console.log(`token for ${a} (${b}), shown once:\n${new Actors(db).issue(a, b)}`);
  if (b === 'agent') { new Policy(db).applyPreset(a, 'cautious'); console.log('agent starts on the cautious preset'); }
} else if (cmd === 'preset' && a && ['cautious', 'trusted', 'readonly'].includes(b)) {
  if (new Actors(db).type(a) !== 'agent') { console.error(`${a} is not an existing agent`); process.exit(1); }
  new Policy(db).applyPreset(a, b as Preset); console.log(`${a}: ${b}`);
} else if (cmd === 'set' && a && b && process.argv[5]) {
  // set <agent> <action> <deny|ask|allow>: one grid cell, for actions added after an agent's preset was applied
  const [agent, action, mode] = [a, b, process.argv[5]];
  if (new Actors(db).type(agent) !== 'agent' || !(ACTIONS as readonly string[]).includes(action) || !['deny', 'ask', 'allow'].includes(mode)) { console.error('need an existing agent, a known action and deny|ask|allow'); process.exit(1); }
  new Policy(db).set(agent, action as Action, mode as Mode, action === 'restart_service' && mode === 'allow' ? { limits: { perHour: 3 } } : {}); console.log(`${agent}: ${action} = ${mode}`);
} else if (cmd === 'unlock-totp') {
  db.exec('CREATE TABLE IF NOT EXISTS totp_fail (at INTEGER NOT NULL)');
  db.exec('DELETE FROM totp_fail'); console.log('TOTP lockout cleared'); // local OS access only: an agent holding just an API token cannot do this
} else if (cmd === 'actors') {
  console.log((db.prepare('SELECT name, type, created FROM actor').all() as { name: string; type: string; created: number }[]).map((r) => `${r.name} ${r.type} ${new Date(r.created).toISOString()}`).join('\n') || '(none)');
} else { console.error('usage: ctl-admin.ts init-totp | issue <name> <human|agent> | preset <agent> <cautious|trusted|readonly> | set <agent> <action> <deny|ask|allow> | actors | unlock-totp'); process.exit(2); }
