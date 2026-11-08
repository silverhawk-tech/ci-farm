// MCP stdio server for agents. Configure in each agent CLI as:  node /opt/ci-master/scripts/ci-mcp.ts   (env CI_TOKEN_FILE, optional CI_API_URL)
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { handle } from '../src/mcp.ts';

const tokenFile = process.env.CI_TOKEN_FILE ?? `${homedir()}/.config/ci-master/${process.env.CI_AGENT ?? 'claude'}.token`;
const env = { apiUrl: process.env.CI_API_URL ?? 'http://127.0.0.1:8787', token: readFileSync(tokenFile, 'utf8').trim() };
const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return void process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); }
  const out = await handle(env, msg);
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
});
