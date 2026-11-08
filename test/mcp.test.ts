import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, toolNames } from '../src/mcp.ts';

function env() {
  const calls: { url: string; method: string; body?: string; auth?: string }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => { calls.push({ url, method: String(init.method), body: init.body as string | undefined, auth: (init.headers as Record<string, string>).Authorization }); return new Response(JSON.stringify({ status: 'done' }), { status: 200 }); }) as typeof fetch;
  return { calls, e: { apiUrl: 'http://127.0.0.1:8787', token: 'cim_secret_token', fetchFn } };
}
const rpc = (method: string, params?: unknown, id: number | undefined = 1) => ({ jsonrpc: '2.0', id, method, params });

test('initialize and tools/list work; there is no tool to approve, edit permissions, issue tokens or read keys', async () => {
  const { e } = env();
  assert.equal((await handle(e, rpc('initialize', {})))!.result.serverInfo.name, 'ci-master');
  const list = (await handle(e, rpc('tools/list')))!.result.tools as { name: string; inputSchema: unknown }[];
  assert.ok(list.length >= 10 && list.every((t) => t.inputSchema));
  for (const bad of [/approv(e|al)_?(decide|grant)/i, /permission/i, /policy/i, /token/i, /key/i, /totp/i]) assert.ok(!toolNames().some((n) => bad.test(n) && n !== 'ci_pending_approvals'), String(bad));
  assert.equal(await handle(e, { jsonrpc: '2.0', method: 'notifications/initialized' }), null, 'notifications get no reply');
});

test('tool calls map to the right API request with the bearer token, and results are labelled untrusted', async () => {
  const { e, calls } = env();
  const out = (await handle(e, rpc('tools/call', { name: 'ci_rerun_failed', arguments: { project: 'myapp', run_id: 7, reason: 'network blip' } })))!;
  assert.deepEqual([calls[0].method, calls[0].url, calls[0].auth], ['POST', 'http://127.0.0.1:8787/v1/actions/rerun_failed', 'Bearer cim_secret_token']);
  assert.deepEqual(JSON.parse(calls[0].body!), { project: 'myapp', run_id: 7, reason: 'network blip' });
  assert.match(out.result.content[0].text, /untrusted/);
  assert.ok(!out.result.content[0].text.includes('cim_secret_token'), 'the token is never echoed');
  await handle(e, rpc('tools/call', { name: 'ci_request_action', arguments: { action: 'cancel_run', project: 'myapp', run_id: 7 } }));
  assert.equal(calls[1].url, 'http://127.0.0.1:8787/v1/actions/cancel_run');
});

test('invalid arguments, unknown tools and unknown methods are refused without calling the API', async () => {
  const { e, calls } = env();
  assert.equal((await handle(e, rpc('tools/call', { name: 'ci_rerun_failed', arguments: { project: 'x', run_id: 'seven' } })))!.result.isError, true);
  assert.equal((await handle(e, rpc('tools/call', { name: 'ci_approve', arguments: {} })))!.error.code, -32602);
  assert.equal((await handle(e, rpc('tools/call', { name: 'ci_request_action', arguments: { action: 'edit_policy' } })))!.result.isError, true);
  assert.equal((await handle(e, rpc('bogus')))!.error.code, -32601);
  assert.equal(calls.length, 0);
});

test('an unreachable API becomes a tool error, not a crash', async () => {
  const e = { apiUrl: 'http://127.0.0.1:1', token: 't', fetchFn: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch };
  const out = (await handle(e, rpc('tools/call', { name: 'ci_status', arguments: {} })))!;
  assert.equal(out.result.isError, true);
});
