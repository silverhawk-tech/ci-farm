import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProgress } from '../src/github-port.ts';

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
