import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeGithubPort, runProgress } from '../src/github-port.ts';
import { loadRegistry } from '../src/registry.ts';

const registry = loadRegistry(readFileSync(new URL('../config/registry.example.yaml', import.meta.url), 'utf8'));
const project = registry[0];

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const real = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return handler(url, init); }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function makePortDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ci-gh-port-'));
  mkdirSync(join(dir, 'secrets'));
  writeFileSync(join(dir, 'app.json'), JSON.stringify({ appId: 123, installationId: 456 }));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(join(dir, 'secrets', 'github-app.pem'), privateKey.export({ type: 'pkcs1', format: 'pem' }));
  return dir;
}

const step = (name: string, status: string) => ({ name, status });

test('no jobs yet: no progress', () => {
  assert.equal(runProgress([]), undefined);
});

test('finished jobs count fully, the running job counts its finished steps, queued jobs count zero', () => {
  const p = runProgress([
    { name: 'changes', status: 'completed' },
    { name: 'gates', status: 'in_progress', steps: [step('a', 'completed'), step('b', 'completed'), step('npm test', 'in_progress'), step('d', 'queued')] },
    { name: 'ci-required', status: 'queued', steps: [] },
  ])!;
  assert.deepEqual({ done: p.jobsDone, total: p.jobsTotal, current: p.current }, { done: 1, total: 3, current: 'npm test' });
  assert.equal(p.percent, Math.floor(((1 + 0.5 + 0) / 3) * 100)); // 50
});

test('a run is never shown as 100% while it is still running', () => {
  const p = runProgress([{ name: 'gates', status: 'in_progress', steps: [step('a', 'completed'), step('b', 'completed')] }])!;
  assert.equal(p.percent, 99);
});

test('a running job with no steps reported yet counts zero', () => {
  const p = runProgress([{ name: 'gates', status: 'in_progress', steps: [] }])!;
  assert.equal(p.percent, 0);
});

test('progress lists every job with its status and conclusion for the dashboard chips', () => {
  const p = runProgress([{ name: 'changes', status: 'completed', conclusion: 'success' }, { name: 'gates', status: 'in_progress', steps: [] }, { name: 'content-bank', status: 'queued' }])!;
  assert.deepEqual(p.jobs, [{ name: 'changes', status: 'completed', conclusion: 'success' }, { name: 'gates', status: 'in_progress', conclusion: null }, { name: 'content-bank', status: 'queued', conclusion: null }]);
});

test('runner took a different job than reserved while its run-level status is queued: jobByRunner finds it', async () => {
  const dir = makePortDir();
  const port = makeGithubPort(dir);
  const s = stubFetch(async (url) => {
    if (url.includes('/access_tokens')) {
      return new Response(JSON.stringify({ token: 'fake-token' }));
    }
    // Reserved job lookup: took a different runner
    if (url.includes('/actions/jobs/101')) {
      return new Response(JSON.stringify({ id: 101, run_id: 50, status: 'queued', runner_name: 'other-runner', labels: [] }));
    }
    // Fallback scan: recent runs of all statuses
    if (url.includes('/actions/runs?') || url.endsWith('/actions/runs')) {
      return new Response(JSON.stringify({
        workflow_runs: [
          {
            id: 51,
            workflow_id: 1,
            run_number: 2,
            event: 'pull_request',
            head_sha: 'sha51',
            head_branch: 'feat',
            status: 'queued', // run-level status is queued!
            pull_requests: [{ number: 10 }],
            head_repository: { full_name: project.repo },
          },
        ],
      }));
    }
    // Jobs of run 51
    if (url.includes('/actions/runs/51/jobs')) {
      return new Response(JSON.stringify({
        jobs: [
          {
            id: 202,
            run_id: 51,
            status: 'in_progress',
            runner_name: 'my-runner',
            labels: ['self-hosted', project.unique_label],
          },
        ],
      }));
    }
    return new Response('Not Found', { status: 404 });
  });

  try {
    const res = await port.jobByRunner(project, 'my-runner', 101);
    assert.ok(res !== null, 'expected job to be found even when run-level status is queued');
    assert.equal(res.job.id, 202);
    assert.equal(res.job.runner_name, 'my-runner');
    assert.equal(res.run.id, 51);
    assert.equal(res.run.status, 'queued');
  } finally {
    s.restore();
  }
});

test('runnerBusy returns true when busy, false when idle, null on 404, throws on other error', async () => {
  const dir = makePortDir();
  const port = makeGithubPort(dir);
  let runnerStatus = 200;
  let runnerBody: any = { id: 77, busy: true };
  const s = stubFetch(async (url) => {
    if (url.includes('/access_tokens')) return new Response(JSON.stringify({ token: 'fake-token' }));
    if (url.includes('/actions/runners/77')) return new Response(JSON.stringify(runnerBody), { status: runnerStatus });
    return new Response('Not Found', { status: 404 });
  });

  try {
    // 1. busy: true
    runnerStatus = 200;
    runnerBody = { id: 77, busy: true };
    assert.equal(await port.runnerBusy(project.repo, 77), true);

    // 2. busy: false
    runnerStatus = 200;
    runnerBody = { id: 77, busy: false };
    assert.equal(await port.runnerBusy(project.repo, 77), false);

    // 3. 404 not found -> null
    runnerStatus = 404;
    runnerBody = { message: 'Not Found' };
    assert.equal(await port.runnerBusy(project.repo, 77), null);

    // 4. 500 error -> throws
    runnerStatus = 500;
    runnerBody = { message: 'Internal Server Error' };
    await assert.rejects(() => port.runnerBusy(project.repo, 77), (err: Error) => /500/.test(err.message));
  } finally {
    s.restore();
  }
});
