// Small CLI over the same API (fallback when an agent has no MCP). Usage: cictl.ts status|runs|resources|approvals|audit|pause|resume|rerun <project> <run_id> <reason...>
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const token = readFileSync(process.env.CI_TOKEN_FILE ?? `${homedir()}/.config/ci-master/${process.env.CI_AGENT ?? 'claude'}.token`, 'utf8').trim();
const url = process.env.CI_API_URL ?? 'http://127.0.0.1:8787';
const [cmd, a, b, ...rest] = process.argv.slice(2);
const call = async (m: string, p: string, body?: unknown) => {
  const r = await fetch(url + p, { method: m, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  console.log(r.status, JSON.stringify(await r.json().catch(() => ({})), null, 1));
};
const routes: Record<string, () => Promise<void>> = {
  status: () => call('GET', '/v1/status'), runs: () => call('GET', '/v1/runs'), resources: () => call('GET', '/v1/resources'), approvals: () => call('GET', '/v1/approvals'), audit: () => call('GET', '/v1/audit?limit=30'),
  pause: () => call('POST', '/v1/actions/pause_all', {}), resume: () => call('POST', '/v1/actions/resume_all', {}),
  rerun: () => call('POST', '/v1/actions/rerun_failed', { project: a, run_id: Number(b), reason: rest.join(' ') }),
};
if (!routes[cmd]) { console.error('usage: cictl.ts status|runs|resources|approvals|audit|pause|resume|rerun <project> <run_id> <reason>'); process.exit(2); }
await routes[cmd]();
