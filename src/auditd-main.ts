// Runs as ci-audit (its own user, owns nothing else). Receives audit rows from controld on a group-restricted Unix socket and keeps them in an append-only file.
import { rmSync } from 'node:fs';
import { AuditStore, startAuditd } from './auditd.ts';
import { brokerCall } from './broker-client.ts';

const file = process.env.CI_AUDIT_FILE ?? '/var/lib/ci-audit/audit.jsonl';
const socketPath = process.env.CI_AUDIT_SOCKET ?? '/run/ci-audit/audit.sock';
const alive = await brokerCall(socketPath, { op: 'head' }).then(() => true, () => false);
if (alive) { console.error(`another audit receiver already listens on ${socketPath}; exiting`); process.exit(1); }
rmSync(socketPath, { force: true });
const store = new AuditStore(file);
if (store.broken) console.error(`WARNING: ${file} does not verify (${store.broken}); the receiver will refuse appends and report tampering`);
await startAuditd({ socketPath, store });
setInterval(() => store.checkpoint(), 3_600_000).unref(); // hourly checkpoint line, also the anchor shown on the dashboard
store.checkpoint();
console.log(`audit receiver listening on ${socketPath}; head ${store.head ? store.head.seq : 'empty'}`);
