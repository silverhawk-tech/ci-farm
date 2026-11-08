import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshState, runWatchdog, type WatchdogDeps } from '../src/watchdog.ts';

function world(over: Partial<WatchdogDeps> = {}, requests: string[] = [], invalid: string[] = []) {
  const log: string[] = [], restarted: string[] = [], cleared: string[] = [], saved: number[] = [];
  let t = 10_000_000;
  const d: WatchdogDeps = {
    now: () => t, isActive: async () => true, restart: async (u) => void restarted.push(u),
    apiHealth: async () => ({ ok: true, tickAgeS: 3 }), brokerAlive: async () => true, auditdAlive: async () => true, dockerAlive: async () => true, startDocker: async () => void restarted.push('docker'),
    pendingRequests: async () => requests.map((name) => ({ name, valid: !invalid.includes(name) })), clearRequest: async (n) => void cleared.push(n),
    persist: async (st) => void saved.push(Object.values(st.restarts).flat().length), log: (m) => log.push(m), ...over,
  };
  return { d, log, restarted, cleared, saved, advance: (ms: number) => (t += ms) };
}

test('healthy services are left alone', async () => {
  const w = world();
  await runWatchdog(w.d, freshState());
  assert.deepEqual(w.restarted, []);
});

test('a service that is not running is restarted at once', async () => {
  const w = world({ isActive: async (u) => u !== 'ci-broker.service' });
  await runWatchdog(w.d, freshState());
  assert.deepEqual(w.restarted, ['ci-broker.service']);
});

test('a stuck service (alive but unhealthy) is restarted only after 3 bad checks in a row; one good check resets the count', async () => {
  let bad = true;
  const w = world({ apiHealth: async () => ({ ok: !bad, tickAgeS: 5 }) });
  const st = freshState();
  await runWatchdog(w.d, st); await runWatchdog(w.d, st);
  assert.deepEqual(w.restarted, []);
  bad = false; await runWatchdog(w.d, st);
  bad = true; await runWatchdog(w.d, st); await runWatchdog(w.d, st);
  assert.deepEqual(w.restarted, [], 'the good check reset the streak');
  await runWatchdog(w.d, st);
  assert.deepEqual(w.restarted, ['ci-controld.service']);
});

test('a controller whose tick loop stopped (old tickAgeS) counts as stuck even though the API answers', async () => {
  const w = world({ apiHealth: async () => ({ ok: true, tickAgeS: 900 }) });
  const st = freshState();
  for (let i = 0; i < 3; i++) await runWatchdog(w.d, st);
  assert.deepEqual(w.restarted, ['ci-controld.service']);
});

test('an agent request restarts the named service once and is cleared; unexpected names (including the firewall service) are ignored', async () => {
  const w = world({}, ['request-auditd', 'request-egress', 'request-../x', 'junk']);
  await runWatchdog(w.d, freshState());
  assert.deepEqual(w.restarted, ['ci-auditd.service']);
  assert.deepEqual(w.cleared, ['request-auditd'], 'only the exact, allow-listed name is touched');
});

test('a request that is not a plain file (symlink, directory, hard link) is cleared but never acted on', async () => {
  const w = world({}, ['request-broker'], ['request-broker']);
  await runWatchdog(w.d, freshState());
  assert.deepEqual(w.restarted, []);
  assert.deepEqual(w.cleared, ['request-broker']);
});

test('the restart is recorded durably BEFORE it happens, and if recording fails nothing is restarted (fail closed)', async () => {
  const order: string[] = [];
  const w = world({ persist: async () => void order.push('saved'), restart: async () => void order.push('restart') }, ['request-controld']);
  await runWatchdog(w.d, freshState());
  assert.deepEqual(order, ['saved', 'restart']);
  const f = world({ persist: async () => { throw new Error('ENOSPC'); }, isActive: async () => false });
  const st = freshState();
  await runWatchdog(f.d, st);
  assert.deepEqual(f.restarted, [], 'no record, no restart');
  assert.equal(st.restarts.broker.length, 0, 'and the failed attempt does not eat the budget');
  assert.ok(f.log.some((l) => /could not record it first/.test(l)));
});

test('agent requests share ONE budget of 3 per hour across all services', async () => {
  const w = world({}, ['request-auditd', 'request-broker', 'request-controld']);
  const st = freshState();
  await runWatchdog(w.d, st); // 3 requests, one per service: all allowed
  await runWatchdog(w.d, st); // the same 3 again: the shared budget is spent
  assert.equal(w.restarted.length, 3);
});

test('a controller that answers without a valid tickAgeS is not healthy', async () => {
  for (const bad of [undefined, NaN, -5]) {
    const w = world({ apiHealth: async () => ({ ok: true, tickAgeS: bad as number }) });
    const st = freshState();
    for (let i = 0; i < 3; i++) await runWatchdog(w.d, st);
    assert.deepEqual(w.restarted, ['ci-controld.service'], String(bad));
  }
});

test('restarts have an hourly budget: requests stop at 3, everything at 6, then a human must look; the budget refills after an hour', async () => {
  const w = world({}, ['request-broker']);
  const st = freshState();
  for (let i = 0; i < 5; i++) await runWatchdog(w.d, st);
  assert.equal(w.restarted.length, 3, 'agent requests are capped at 3 per hour');
  assert.ok(w.log.some((l) => /budget for this hour is used up/.test(l)));
  w.advance(3_700_000);
  await runWatchdog(w.d, st);
  assert.equal(w.restarted.length, 4);
});

test('a failing restart or a throwing health check never crashes the watchdog', async () => {
  const w = world({ restart: async () => { throw new Error('boom'); }, brokerAlive: async () => { throw new Error('socket gone'); }, isActive: async () => false }, ['request-controld']);
  await assert.doesNotReject(() => runWatchdog(w.d, freshState()));
  assert.ok(w.log.some((l) => /restart failed/.test(l)));
});

test('a down Docker daemon is started, and the broker/controller failing because of it are NOT counted as stuck', async () => {
  const w = world({ dockerAlive: async () => false, brokerAlive: async () => false, apiHealth: async () => ({ ok: false }) });
  const st = freshState();
  for (let i = 0; i < 5; i++) await runWatchdog(w.d, st);
  assert.equal(w.restarted.filter((r) => r === 'docker').length, 5, 'started each round it stays down (within budget)');
  assert.deepEqual(w.restarted.filter((r) => r !== 'docker'), [], 'no restart storm on the services that merely depend on it');
});

test('Docker starts have their own hourly budget, recorded before the start; a failed record means no start', async () => {
  const w = world({ dockerAlive: async () => false });
  const st = freshState();
  for (let i = 0; i < 8; i++) await runWatchdog(w.d, st);
  assert.equal(w.restarted.filter((r) => r === 'docker').length, 6);
  assert.ok(w.log.some((m) => /docker: NOT started.*human must look/.test(m)));
  const v = world({ dockerAlive: async () => false, persist: async () => { throw new Error('disk full'); } });
  await runWatchdog(v.d, freshState());
  assert.deepEqual(v.restarted, [], 'fail closed');
});
