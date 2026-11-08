import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RootlessDockerBackend, slotRunArgs, type SlotSpec } from '../src/launcher.ts';

const id = '11111111-2222-3333-4444-555555555555';
const PIN = 'ci-master/slot@sha256:' + 'a'.repeat(64);
const spec: SlotSpec = { reservationId: id, slot: 1, project: 'app1', image: PIN, memory: '6g', cpus: 3, pids: 4096 };

test('slot launch args always carry limits and never grant host access', () => {
  const a = slotRunArgs(spec);
  const joined = a.join(' ');
  for (const flag of ['--memory', '--memory-swap', '--cpus', '--pids-limit']) assert.ok(a.includes(flag), flag);
  assert.ok(!/--network[ =]host|--pid[ =]host|--ipc[ =]host|--userns/.test(joined));
  assert.ok(!a.includes('-v') && !a.includes('--volume') && !/--mount/.test(joined) && !joined.includes('docker.sock'));
  assert.ok(!/JIT|CONFIG|-e /.test(joined), 'no credential in argv or env');
  assert.equal(a[a.indexOf('--name') + 1], `cif-${id}`);
  assert.equal(a.at(-1), PIN);
});

test('malformed specs are refused', () => {
  assert.throws(() => slotRunArgs({ ...spec, reservationId: 'x; rm -rf /' }), /bad reservation id/);
  assert.throws(() => slotRunArgs({ ...spec, image: 'a b' }), /bad image/);
  assert.throws(() => slotRunArgs({ ...spec, image: '--privileged=false' }), /bad image/);
  assert.throws(() => slotRunArgs({ ...spec, image: 'ci-master/slot:dev' }), /bad image/, 'unpinned tag refused unless dev flag');
  const id = 'sha256:' + 'a'.repeat(64);
  assert.doesNotThrow(() => slotRunArgs({ ...spec, image: id }), 'a full local image id is a content hash');
  assert.throws(() => slotRunArgs({ ...spec, image: 'sha256:' + 'a'.repeat(12) }), /bad image/, 'short id refused');
  assert.throws(() => slotRunArgs({ ...spec, image: 'x:sha256:' + 'a'.repeat(64) }), /bad image/, 'tag that merely ends in a hash refused');
  assert.throws(() => slotRunArgs({ ...spec, memory: '999' }), /bad memory/);
  assert.throws(() => slotRunArgs({ ...spec, pids: 10 }), /bad limits/);
});

test('the JIT config is sent on stdin only', async () => {
  const calls: { args: string[]; stdin?: string }[] = [];
  const b = new RootlessDockerBackend(async (args, stdin) => { calls.push({ args, stdin }); return ''; });
  await b.deliverJit(id, 'SECRET-CONFIG');
  assert.equal(calls[0].stdin, 'SECRET-CONFIG');
  assert.ok(!calls[0].args.join(' ').includes('SECRET-CONFIG'));
});

test('list parses labelled containers', async () => {
  const b = new RootlessDockerBackend(async () => `${id} running app1 1\n99999999-2222-3333-4444-555555555555 exited app1 2\n`);
  assert.deepEqual(await b.list(), [{ reservationId: id, running: true, project: 'app1', slot: 1 }, { reservationId: '99999999-2222-3333-4444-555555555555', running: false, project: 'app1', slot: 2 }]);
});

test('stop treats an already-removed container as success but surfaces other failures', async () => {
  await new RootlessDockerBackend(async () => { throw new Error('docker rm failed (1): Error: No such container: x'); }).stop(id);
  await assert.rejects(new RootlessDockerBackend(async () => { throw new Error('docker rm failed (1): device busy'); }).stop(id), /device busy/);
});

test('stats parses docker stats rows for slot containers only', async () => {
  const b = new RootlessDockerBackend(async () => `cif-${id} 210.5% 1.5GiB / 6GiB\nother 1% 1MiB / 2MiB\n`);
  assert.deepEqual(await b.stats(), [{ reservationId: id, cpuPercent: 210.5, memUsedMb: 1536, memLimitMb: 6144 }]);
});
