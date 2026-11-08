import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Approvals } from '../src/approvals.ts';
import { Totp, code, toBase32 } from '../src/totp.ts';

const b = { repo: 'o/r', target: { run_id: 7, head_sha: 'abc' }, params: {} };
const mk = (now = () => 1000) => new Approvals(new DatabaseSync(':memory:'), now);

test('request, approve with step-up, consume once', () => {
  const a = mk();
  const id = a.request('codex', 'cancel_run', b);
  assert.equal(a.decide(id, 'owner', 'approve', true).ok, true);
  assert.equal(a.consume(id, 'codex', 'cancel_run', b).ok, true);
  assert.equal(a.consume(id, 'codex', 'cancel_run', b).ok, false, 'single use');
});

test('without a verified step-up nothing is approved', () => {
  const a = mk();
  const id = a.request('codex', 'cancel_run', b);
  assert.equal(a.decide(id, 'owner', 'approve', false).ok, false);
  assert.equal(a.get(id)!.state, 'pending');
});

test('an approval is bound: different run, head SHA, action or params do not match', () => {
  const a = mk();
  const id = a.request('codex', 'cancel_run', b);
  a.decide(id, 'owner', 'approve', true);
  assert.equal(a.consume(id, 'codex', 'cancel_run', { ...b, target: { run_id: 8, head_sha: 'abc' } }).ok, false);
  assert.equal(a.consume(id, 'codex', 'cancel_run', { ...b, target: { run_id: 7, head_sha: 'def' } }).ok, false);
  assert.equal(a.consume(id, 'codex', 'delete_run', b).ok, false);
  assert.equal(a.consume(id, 'claude', 'cancel_run', b).ok, false, 'another agent cannot use it');
  assert.equal(a.consume(id, 'codex', 'cancel_run', { ...b, params: { force: true } }).ok, false);
  assert.equal(a.consume(id, 'codex', 'cancel_run', { repo: 'o/r', target: { head_sha: 'abc', run_id: 7 } }).ok, true, 'key order does not matter');
});

test('approvals expire; a pending request cannot be approved late, an approved one cannot be used late', () => {
  let t = 1000;
  const a = mk(() => t);
  const late = a.request('codex', 'cancel_run', b, 60_000);
  t += 61_000;
  assert.equal(a.decide(late, 'owner', 'approve', true).ok, false);
  const id = a.request('codex', 'cancel_run', { ...b, target: { run_id: 9, head_sha: 'x' } }, 60_000);
  a.decide(id, 'owner', 'approve', true);
  t += 61_000;
  assert.equal(a.consume(id, 'codex', 'cancel_run', { ...b, target: { run_id: 9, head_sha: 'x' } }).ok, false);
});

test('an identical pending request is not duplicated; a rejected one cannot be consumed', () => {
  const a = mk();
  const id = a.request('codex', 'cancel_run', b);
  assert.equal(a.request('codex', 'cancel_run', b), id);
  a.decide(id, 'owner', 'reject', true);
  assert.equal(a.consume(id, 'codex', 'cancel_run', b).ok, false);
});

test('TOTP matches the RFC 6238 test vector, accepts drift of one step, and each code works once', () => {
  const secret = Buffer.from('12345678901234567890');
  assert.equal(code(secret, Math.floor(59 / 30)), '287082');
  assert.equal(toBase32(Buffer.from('foobar')), 'MZXW6YTBOI');
  let t = 59_000;
  const totp = new Totp(new DatabaseSync(':memory:'), secret, () => t);
  assert.equal(totp.verify('287082'), true);
  assert.equal(totp.verify('287082'), false, 'replay refused');
  assert.equal(totp.verify('000000'), false);
  t = 89_000; // next step; previous step's code is still within drift but already used
  assert.equal(totp.verify('287082'), false);
});

test('an approval can be given back after a definite failure, but only while valid', () => {
  const a = mk();
  const id = a.request('codex', 'cancel_run', b);
  a.decide(id, 'owner', 'approve', true);
  assert.equal(a.consume(id, 'codex', 'cancel_run', b).ok, true);
  a.release(id);
  assert.equal(a.consume(id, 'codex', 'cancel_run', b).ok, true, 'usable again after release');
});

test('too many wrong TOTP codes lock verification, even for the right code, until the window passes', () => {
  const secret = Buffer.from('12345678901234567890');
  let t = 59_000;
  const totp = new Totp(new DatabaseSync(':memory:'), secret, () => t);
  for (let i = 0; i < 5; i++) assert.equal(totp.verify('111111'), false);
  assert.equal(totp.verify('287082'), false, 'locked: the correct code is refused too');
  t += 6 * 60_000;
  assert.equal(totp.verify(code(secret, Math.floor(t / 30_000))), true, 'works again after the window');
});

test('rejecting needs no second factor, approving still does', () => {
  const a = new Approvals(new DatabaseSync(':memory:'));
  const b = { repo: 'o/r', target: { run: 1 } };
  const id = a.request('claude', 'cancel_run', b);
  assert.equal(a.decide(id, 'owner', 'approve', false).ok, false);
  assert.equal(a.decide(id, 'owner', 'reject', false).ok, true);
  assert.equal(a.consume(id, 'claude', 'cancel_run', b).ok, false, 'a rejected request can never be consumed');
});
