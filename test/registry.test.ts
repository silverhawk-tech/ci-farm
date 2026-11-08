import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadRegistry } from '../src/registry.ts';

const example = readFileSync(new URL('../config/registry.example.yaml', import.meta.url), 'utf8');
const bad = (from: string, to: string) => () => loadRegistry(example.replace(from, to));

test('the example registry is valid', () => {
  const [p] = loadRegistry(example);
  assert.equal(p.name, 'myapp');
  assert.equal(p.resources.cpus, 3);
});
test('a deploy/migration lane on self-hosted is refused', () => {
  assert.throws(bad('migrate-deploy: github-hosted', 'migrate-deploy: self-hosted'), /must stay github-hosted/);
});
test('pull_request_target and other privileged events are refused', () => {
  assert.throws(bad('[pull_request]', '[pull_request_target]'), /invalid registry/);
});
test('org-level runner scope is refused', () => {
  assert.throws(bad('runner_scope: repo', 'runner_scope: org'), /invalid registry/);
});
test('duplicate unique labels across projects are refused', () => {
  const two = example + example.replace('name: myapp', 'name: other').replace('example-org/example-app', 'example-org/other');
  assert.throws(() => loadRegistry(two), /duplicate unique_label/);
});
test('slot count and memory format are bounded', () => {
  assert.throws(bad('max_slots: 1', 'max_slots: 9'), /invalid registry/);
  assert.throws(bad('memory: 6g', 'memory: lots'), /invalid registry/);
});

test('push is refused without a branch list', () => {
  assert.throws(bad('[pull_request]', '[pull_request, push]'), /push_branches/);
  assert.doesNotThrow(() => loadRegistry(example.replace('[pull_request]', '[pull_request, push]').replace('runner_scope: repo', 'push_branches: [develop]\n  runner_scope: repo')));
  assert.throws(bad('runner_scope: repo', 'push_branches: ["bad branch"]\n  runner_scope: repo'), /invalid registry/);
});
