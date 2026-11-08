import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintJit, runnerName, deleteRunner } from '../src/jit.ts';

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const real = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return handler(url, init); }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('mintJit sends the required fields to the repo-level endpoint and returns the config', async () => {
  const s = stubFetch(() => new Response(JSON.stringify({ runner: { id: 9, name: 'cif-1-abcd1234' }, encoded_jit_config: 'SECRET' }), { status: 201 }));
  try {
    const r = await mintJit('tok', 'o/r', { name: 'cif-1-abcd1234', labels: ['self-hosted', 'ci-test-0001'], runnerGroupId: 1 });
    assert.deepEqual(r, { runnerId: 9, runnerName: 'cif-1-abcd1234', encodedJitConfig: 'SECRET' });
    assert.equal(s.calls[0].url, 'https://api.github.com/repos/o/r/actions/runners/generate-jitconfig');
    const body = JSON.parse(String(s.calls[0].init.body));
    assert.deepEqual([body.name, body.runner_group_id, body.labels], ['cif-1-abcd1234', 1, ['self-hosted', 'ci-test-0001']]);
  } finally { s.restore(); }
});

test('a failed mint throws without echoing the token', async () => {
  const s = stubFetch(() => new Response('{"message":"Resource not accessible by integration"}', { status: 403 }));
  try {
    await assert.rejects(mintJit('tok-secret', 'o/r', { name: 'n', labels: ['x'], runnerGroupId: 1 }), (e: Error) => /403/.test(e.message) && !e.message.includes('tok-secret'));
  } finally { s.restore(); }
});

test('deleteRunner treats 404 as already gone and other failures as errors', async () => {
  let status = 404;
  const s = stubFetch(() => new Response(null, { status }));
  try {
    await deleteRunner('t', 'o/r', 9);
    status = 204; await deleteRunner('t', 'o/r', 9);
    status = 500; await assert.rejects(deleteRunner('t', 'o/r', 9), /500/);
  } finally { s.restore(); }
});

test('runner names embed slot and reservation prefix', () => {
  assert.equal(runnerName('abc123', 2, '1234567890abcdef'), 'cif-abc123-2-12345678');
});
