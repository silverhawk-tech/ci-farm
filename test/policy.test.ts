import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ACTIONS, Policy } from '../src/policy.ts';

const agent = { name: 'claude', type: 'agent' as const };
const human = { name: 'owner', type: 'human' as const };
const mk = (now = () => 1000) => new Policy(new DatabaseSync(':memory:'), now);

test('an agent with no grid rows is denied everything; new actions start as deny', () => {
  const p = mk();
  for (const a of ACTIONS) assert.equal(p.decide(agent, a).decision, 'deny');
});

test('cautious preset: reads allowed, pause allowed, re-run failed capped, cancel asks, register denied', () => {
  const p = mk();
  p.applyPreset('claude', 'cautious');
  assert.equal(p.decide(agent, 'status').decision, 'allow');
  assert.equal(p.decide(agent, 'pause_all').decision, 'allow');
  assert.deepEqual(p.decide(agent, 'rerun_failed'), { decision: 'allow', reason: 'grid: allow', limits: { perRun: 2, perHour: 6 } });
  assert.equal(p.decide(agent, 'cancel_run').decision, 'ask');
  assert.equal(p.decide(agent, 'register_project').decision, 'deny');
});

test('presets are per agent; changing one cell takes effect on the next call with no restart', () => {
  const p = mk();
  p.applyPreset('claude', 'cautious');
  p.applyPreset('codex', 'readonly');
  assert.equal(p.decide({ name: 'codex', type: 'agent' }, 'pause_all').decision, 'deny');
  p.set('codex', 'pause_all', 'allow');
  assert.equal(p.decide({ name: 'codex', type: 'agent' }, 'pause_all').decision, 'allow');
  p.set('claude', 'cancel_run', 'allow');
  assert.equal(p.decide(agent, 'cancel_run').decision, 'allow');
});

test('a temporary Allow falls back to Ask after it expires', () => {
  let t = 1000;
  const p = mk(() => t);
  p.applyPreset('claude', 'cautious');
  p.set('claude', 'cancel_run', 'allow', { expires: 2000 });
  assert.equal(p.decide(agent, 'cancel_run').decision, 'allow');
  t = 3000;
  assert.equal(p.decide(agent, 'cancel_run').decision, 'ask');
});

test('hard ceilings apply to everyone, even a human or a fully-trusted agent', () => {
  const p = mk();
  p.applyPreset('claude', 'trusted');
  for (const who of [agent, human]) {
    assert.equal(p.decide(who, 'rerun_failed', { superseded: true }).decision, 'deny');
    assert.equal(p.decide(who, 'rerun_all', { deployLane: true }).decision, 'deny');
  }
});

test('never-exposed or invented actions are denied for every actor', () => {
  const p = mk();
  p.applyPreset('claude', 'trusted');
  for (const a of ['edit_policy', 'approve', 'read_key', 'disable_audit', 'rm -rf']) {
    assert.equal(p.decide(agent, a).decision, 'deny');
    assert.equal(p.decide(human, a).decision, 'deny');
  }
});
