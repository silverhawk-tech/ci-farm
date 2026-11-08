import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { loadRegistry } from '../src/registry.ts';

// Tests for scripts/install-farm.sh. Nothing here runs the installer for real: the pure helpers are sourced, the flows run with --dry-run against a
// fake root, and the mutating steps are exercised with step/put_file replaced by recorders. See docs/INSTALLER-DESIGN.md for what this cannot cover.
const ROOT = new URL('..', import.meta.url).pathname;
const SCRIPT = join(ROOT, 'scripts/install-farm.sh');
const hasPy312 = spawnSync('python3', ['-c', 'import sys; sys.exit(sys.version_info < (3, 12))']).status === 0;
const hasGit = spawnSync('git', ['--version']).status === 0;

const sh = (code: string, env: Record<string, string> = {}) =>
  spawnSync('bash', ['-c', `CI_INSTALLER_SOURCE_ONLY=1 source ${SCRIPT}; set +e; ${code}`], { encoding: 'utf8', env: { ...process.env, ...env } });
const ok = (code: string) => sh(code).status === 0;

test('the script has valid bash syntax and is clean under shellcheck (skipped without shellcheck)', (t) => {
  assert.equal(spawnSync('bash', ['-n', SCRIPT]).status, 0);
  const sc = process.env.SHELLCHECK ?? 'shellcheck';
  if (spawnSync(sc, ['--version']).status !== 0) return t.skip('shellcheck is not installed');
  const r = spawnSync(sc, ['-x', SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('everything runs from functions and the only top-level command is the final main call (safe to pipe through bash)', () => {
  const lines = readFileSync(SCRIPT, 'utf8').split('\n');
  assert.match(lines[lines.length - 2], /^\[ -n "\$\{CI_INSTALLER_SOURCE_ONLY:-\}" \] \|\| main "\$@"$/);
});

test('validators accept the right shapes and reject injection attempts', () => {
  assert.ok(ok('valid_commit 0123456789abcdef0123456789abcdef01234567'));
  for (const bad of ['', 'abc1234', '0123456789ABCDEF0123456789abcdef01234567', '0123456789abcdef0123456789abcdef0123456', '0123456789abcdef0123456789abcdef012345678', 'HEAD', 'main; id']) {
    assert.ok(!ok(`valid_commit '${bad}'`), bad);
  }
  assert.ok(ok('valid_repo silverhawk-tech/ci-farm') && ok('valid_repo a_b/c.d-e'));
  for (const bad of ['', 'noslash', 'a/b/c', 'a/', '/b', '../x', 'a/..', './b', 'a b/c', 'a/b\nc', 'a/b;rm', 'a/$(id)']) assert.ok(!ok(`valid_repo $'${bad.replace(/\n/g, '\\n')}'`), bad);
  assert.ok(ok('valid_number 12345') && !ok("valid_number ''") && !ok('valid_number 12a') && !ok('valid_number -1') && !ok('valid_number 1234567890123456'));
});

test('distribution and version rules: Ubuntu 24.04 or newer only', () => {
  for (const [id, v, want] of [['ubuntu', '24.04', true], ['ubuntu', '26.04', true], ['ubuntu', '24.10', true], ['ubuntu', '22.04', false], ['ubuntu', '9.04', false], ['ubuntu', '', false],
    ['debian', '12', false], ['debian', '13', false], ['fedora', '41', false], ['arch', '', false], ['linuxmint', '22', false]] as const) {
    assert.equal(ok(`distro_supported '${id}' '${v}'`), want, `${id} ${v}`);
  }
  assert.ok(ok('ver_ge 24.04 24.04') && ok('ver_ge 100 24.04') && !ok('ver_ge 23.10 24.04') && !ok('ver_ge x 1') && !ok("ver_ge '' 1"));
});

test('resource and filesystem parsing', () => {
  const d = mkdtempSync(join(tmpdir(), 'ci-inst-'));
  writeFileSync(join(d, 'm8'), 'MemTotal:        8000000 kB\nMemFree: 1 kB\n'); // a typical "8 GB" machine (7.6 GiB) must pass an 8 GiB minimum
  writeFileSync(join(d, 'm4'), 'MemTotal:        4000000 kB\n');
  writeFileSync(join(d, 'bad'), 'nothing here\n');
  assert.equal(sh(`meminfo_gib ${d}/m8`).stdout.trim(), '8');
  assert.equal(sh(`meminfo_gib ${d}/m4`).stdout.trim(), '4');
  assert.equal(sh(`meminfo_gib ${d}/bad`).stdout.trim(), '0');
  for (const fs of ['ext2/ext3', 'ext4', 'xfs', 'btrfs']) assert.ok(ok(`fs_supports_append_only '${fs}'`), fs);
  for (const fs of ['overlayfs', 'tmpfs', 'zfs', 'nfs', '', 'UNKNOWN (0x1)']) assert.ok(!ok(`fs_supports_append_only '${fs}'`), fs);
  rmSync(d, { recursive: true });
});

test('project names derived from a repo satisfy the registry pattern', () => {
  const name = (r: string) => sh(`project_name_from_repo '${r}'`);
  assert.equal(name('acme/My_Cool.Repo').stdout.trim(), 'my-cool-repo');
  assert.equal(name('acme/---x---y').stdout.trim(), 'x-y');
  assert.equal(name('acme/a'.padEnd(80, 'b')).stdout.trim().length, 31);
  assert.notEqual(name('acme/_').status, 0); // nothing usable left
});

test('the generated registry parses with the real registry loader; bad inputs never reach the YAML', () => {
  const label = sh('new_label').stdout.trim();
  assert.match(label, /^ci-farm-[0-9a-f]{8}$/);
  const yaml = sh(`render_registry my-app acme/my-app ${label}`).stdout;
  const [p] = loadRegistry(yaml);
  assert.equal(p.repo, 'acme/my-app');
  assert.equal(p.unique_label, label);
  assert.deepEqual(p.allowed_events, ['pull_request']); // no push, no fork-capable triggers by default
  assert.equal(p.lanes.tests, 'self-hosted');
  assert.equal(Object.keys(p.lanes).length, 1);
  assert.notEqual(sh("render_registry 'a\nb' acme/x ci-farm-12345678").status, 0);
  assert.notEqual(sh("render_registry my-app $'acme/x\\n- name: evil' ci-farm-12345678").status, 0);
  assert.notEqual(sh("render_registry my-app acme/x 'ci-x y'").status, 0);
});

// ---- verified extraction ------------------------------------------------------------------------------------------------------------------
const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
function makeRepo(extra?: (d: string) => void) {
  const d = mkdtempSync(join(tmpdir(), 'ci-repo-'));
  git(d, 'init', '-q');
  for (const p of ['scripts', 'config', 'systemd']) cpSync(join(ROOT, p), join(d, p), { recursive: true });
  extra?.(d);
  git(d, 'add', '-A');
  assert.equal(git(d, 'commit', '-qm', 't').status, 0);
  return { dir: d, commit: git(d, 'rev-parse', 'HEAD').stdout.trim() };
}

test('vextract rebuilds exactly the named paths from verified git objects', { skip: !hasPy312 || !hasGit }, () => {
  const { dir, commit } = makeRepo();
  const out = mkdtempSync(join(tmpdir(), 'ci-out-')) + '/tree';
  const r = sh(`vextract ${dir}/.git ${commit} ${out} scripts/install-runtime.sh config/registry.example.yaml`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(out, 'scripts/install-runtime.sh'), 'utf8'), readFileSync(join(ROOT, 'scripts/install-runtime.sh'), 'utf8'));
  assert.deepEqual(readdirSync(join(out, 'scripts')), ['install-runtime.sh']); // nothing that was not asked for
  assert.notEqual(sh(`vextract ${dir}/.git ${commit} ${out}2 scripts/nope.sh`).status, 0);
});

test('vextract refuses a tampered blob, a swapped tree entry and symlinks', { skip: !hasPy312 || !hasGit }, () => {
  const { dir, commit } = makeRepo();
  const blob = git(dir, 'rev-parse', `${commit}:scripts/setup-control-user.sh`).stdout.trim();
  const loose = join(dir, '.git/objects', blob.slice(0, 2), blob.slice(2));
  chmodSync(join(dir, '.git/objects', blob.slice(0, 2)), 0o755); chmodSync(loose, 0o644); // git writes loose objects 0444; a non-root user cannot overwrite that
  const evil = Buffer.from('#!/bin/sh\necho pwned\n');
  writeFileSync(loose, deflateSync(Buffer.concat([Buffer.from(`blob ${evil.length}\0`), evil])), { mode: 0o644 }); // same name, different content
  const out = mkdtempSync(join(tmpdir(), 'ci-out-')) + '/tree';
  const r = sh(`vextract ${dir}/.git ${commit} ${out} scripts/setup-control-user.sh`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not match its own hash/);

  const sym = makeRepo((d) => symlinkSync('/etc/passwd', join(d, 'scripts/link')));
  const r2 = sh(`vextract ${sym.dir}/.git ${sym.commit} ${out}2 scripts`);
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /symlinks and submodules are not installed/);
});

// ---- dry run against a fake root --------------------------------------------------------------------------------------------------------------
function fakeRoot(over: Record<string, string | null> = {}) {
  const f = mkdtempSync(join(tmpdir(), 'ci-fr-'));
  const files: Record<string, string> = {
    'etc/os-release': 'ID=ubuntu\nVERSION_ID="24.04"\n', 'etc/resolv.conf': 'nameserver 127.0.0.53\n', 'etc/passwd': 'root:x:0:0::/root:/bin/bash\n',
    'sys/fs/cgroup/.fstype': 'cgroup2fs\n', 'proc/sys/user/max_user_namespaces': '1000\n', 'proc/meminfo': 'MemTotal:       16000000 kB\n', 'proc/nproc': '8\n',
    'etc/machine-id': 'test-machine-id\n', 'var/lib/.fstype': 'ext2/ext3\n', 'var/lib/.avail_kb': String(100 * 1048576) + '\n', 'run/systemd/system/.keep': '',
  };
  for (const [k, v] of Object.entries({ ...files, ...over })) {
    if (v === null) continue;
    mkdirSync(join(f, k, '..'), { recursive: true });
    writeFileSync(join(f, k), v);
  }
  return f;
}
const farm = { repo: undefined as undefined | ReturnType<typeof makeRepo> };
function dryRun(args: string[], root: string, env: Record<string, string> = {}) {
  farm.repo ??= makeRepo();
  return spawnSync('bash', ['-s', '--', ...args], {
    input: readFileSync(SCRIPT), encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', CI_FAKE_ROOT: root, CI_SRC: farm.repo.dir, COMMIT: farm.repo.commit, REPO: 'acme/my-app', APP_ID: '123', INSTALLATION_ID: '456', ...env },
  });
}
const skipDry = !hasPy312 || !hasGit;

test('dry run on a healthy fake Ubuntu verifies the commit and prints the whole plan in order', { skip: skipDry }, () => {
  const r = dryRun(['--dry-run'], fakeRoot());
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = r.stdout;
  assert.match(out, /preflight ok/);
  assert.match(out, /verified object by object/);
  const order = ['apt-get update', 'apt-get install', 'systemctl disable --now docker.service docker.socket', 'useradd', 'enable-linger',
    'ln -s /usr/bin/docker /usr/share/docker.io/contrib/docker', 'dockerd-rootless-setuptool.sh install',
    'setup-control-user.sh', 'install-runtime.sh', '/etc/ci-master/registry.yaml', 'init-totp', 'systemctl restart ci-egress.service ci-broker.service ci-auditd.service ci-controld.service',
    'ci-watchdog.timer', 'self-check', 'would: record status=complete and evidence (user ids, file hashes, installed commit) in /var/lib/ci-master-installer/state', 'Dry run complete'];
  let at = 0;
  for (const m of order) { const i = out.indexOf(m, at); assert.ok(i >= at && i !== -1, `missing or out of order: ${m}`); at = i; }
  assert.equal(out.split('would: record status=complete and evidence (user ids, file hashes, installed commit) in /var/lib/ci-master-installer/state').length - 1, 1);
  assert.match(out, /COMMIT=[0-9a-f]{40} /);
  assert.match(out, /BUILD_IMAGE=1/);
  assert.doesNotMatch(out, /BEGIN .*PRIVATE KEY/);
  assert.deepEqual(readdirSync(tmpdir()).filter((n) => n.startsWith('ci-farm-install.')), []); // the private temp dir is removed again
});

test('dry run refuses an unsupported distro and lists every reason at once', { skip: skipDry }, () => {
  const r = dryRun(['--dry-run'], fakeRoot({ 'etc/os-release': 'ID=debian\nVERSION_ID="12"\n', 'proc/meminfo': 'MemTotal: 2000000 kB\n', 'proc/nproc': '2\n', 'sys/fs/cgroup/.fstype': 'tmpfs\n' }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unsupported distribution 'debian 12'/);
  assert.match(r.stderr, /RAM is 2 GiB/);
  assert.match(r.stderr, /2 CPU\(s\)/);
  assert.match(r.stderr, /cgroup v2 is required/);
  assert.match(r.stderr, /nothing was changed/);
  assert.doesNotMatch(r.stdout, /would:/); // never gets to the plan
});

test('dry run refuses old Ubuntu, no systemd, user namespaces off, wrong DNS, small disk, bad filesystem, busy port', { skip: skipDry }, () => {
  const cases: [Record<string, string | null>, RegExp][] = [
    [{ 'etc/os-release': 'ID=ubuntu\nVERSION_ID="22.04"\n' }, /ubuntu 22\.04/],
    [{ 'run/systemd/system/.keep': null }, /systemd is not the running init system/],
    [{ 'proc/sys/user/max_user_namespaces': '0\n' }, /user namespaces are disabled/],
    [{ 'etc/resolv.conf': 'nameserver 192.168.1.1\n' }, /127\.0\.0\.53/],
    [{ 'var/lib/.avail_kb': String(5 * 1048576) }, /5 GiB free/],
    [{ 'var/lib/.fstype': 'overlayfs\n' }, /cannot do chattr \+a/],
    [{ 'run/fake-port-8787': '' }, /port 8787/],
  ];
  for (const [over, re] of cases) {
    const r = dryRun(['--dry-run'], fakeRoot(over));
    assert.equal(r.status, 1, JSON.stringify(over));
    assert.match(r.stderr, re, JSON.stringify(over));
  }
});

// State-file evidence: what an earlier run of this installer would have recorded for a machine it half-installed.
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const me = String(process.getuid?.() ?? 0);
const passwd = (users: Record<string, number>) => 'root:x:0:0::/root:/bin/bash\n' + Object.entries(users).map(([u, id]) => `${u}:x:${id}:${id}::/h/${u}:/usr/sbin/nologin\n`).join('');
const MACHINE = sha('ci-master-installer:test-machine-id');
const state = (status: string, ev: Record<string, string> = {}) => `status=${status}\nmachine=${ev.machine ?? MACHINE}\ncommit=${'a'.repeat(40)}\nrepo=acme/my-app\n` + Object.entries(ev).filter(([k]) => k !== 'machine').map(([k, v]) => `${k}=${v}\n`).join('');
const STATE = 'var/lib/ci-master-installer/state';

test('dry run refuses an existing install; a state file alone never lets it continue over foreign parts', { skip: skipDry }, () => {
  const installed = fakeRoot({ 'opt/ci-master/.commit': 'x', 'etc/passwd': passwd({ 'ci-run': 1001 }) });
  const r = dryRun(['--dry-run'], installed);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already installed here \(found: .*\/opt\/ci-master.*user ci-run/s);

  assert.equal(dryRun(['--dry-run'], fakeRoot({ 'opt/ci-master/.commit': 'x', [STATE]: state('complete', { 'opt.commit': 'x' }) })).status, 1);

  // A stale, copied or forged state file: right status word, no (or wrong) evidence -> refused, nothing is overwritten.
  const forged: Record<string, string | null>[] = [
    { 'opt/ci-master/.commit': 'foreign', [STATE]: state('incomplete') },
    { 'opt/ci-master/.commit': 'foreign', [STATE]: state('uninstalled') },
    { 'opt/ci-master/.commit': 'foreign', [STATE]: state('incomplete', { 'opt.commit': 'something-else' }) },
    { 'etc/passwd': passwd({ 'ci-run': 1001 }), [STATE]: state('incomplete') },
    { 'etc/passwd': passwd({ 'ci-run': 1001 }), [STATE]: state('incomplete', { 'user.ci-run': '1002' }) }, // user was recreated: different uid
    { 'etc/systemd/system/ci-controld.service': 'foreign unit', [STATE]: state('incomplete', { 'file./etc/systemd/system/ci-controld.service': sha('another unit') }) },
    { 'var/lib/ci-control/secrets/.keep': '', [STATE]: state('incomplete', { 'dir./var/lib/ci-control': String(Number(me) + 1) }) },
    { 'run/fake-nft-table': '', [STATE]: state('incomplete') },
    // a state file COPIED from another machine, with otherwise perfect evidence for the parts that exist here
    { 'opt/ci-master/.commit': 'abc', [STATE]: state('incomplete', { 'opt.commit': 'abc', machine: sha('ci-master-installer:another-machine') }) },
    { 'opt/ci-master/.commit': 'abc', [STATE]: `status=incomplete\nopt.commit=abc\n` }, // an old-format file with no machine tag
    { 'etc/ci-master/registry.yaml': '', [STATE]: state('incomplete') },
  ];
  for (const f of forged) {
    const rr = dryRun(['--dry-run'], fakeRoot(f));
    assert.equal(rr.status, 1, JSON.stringify(f));
    assert.match(rr.stderr, /records do not account for/, JSON.stringify(f));
    assert.doesNotMatch(rr.stdout, /would:/);
  }

  // The genuine half-finished run: every existing part matches its recorded evidence.
  const genuine = fakeRoot({
    'opt/ci-master/.commit': 'abc', 'etc/ci-master/registry.yaml': '', 'var/lib/ci-watchdog/requests/.keep': '', 'etc/passwd': passwd({ 'ci-run': 1001, 'ci-control': 998 }),
    'etc/systemd/system/ci-controld.service': 'unit text', 'etc/tmpfiles.d/ci-master.conf': 'd /run/ci-master', 'var/lib/ci-control/secrets/.keep': '', 'run/fake-nft-table': '',
    'etc/systemd/system/ci-egress.service': 'egress unit',
    [STATE]: state('incomplete', { 'opt.commit': 'abc', 'user.ci-run': '1001', 'user.ci-control': '998', 'dir./var/lib/ci-control': me,
      'file./etc/systemd/system/ci-controld.service': sha('unit text'), 'file./etc/tmpfiles.d/ci-master.conf': sha('d /run/ci-master'),
      'file./etc/systemd/system/ci-egress.service': sha('egress unit') }),
  });
  const g = dryRun(['--dry-run'], genuine);
  assert.equal(g.status, 0, g.stderr);

  // After a plain uninstall only users and data dirs are left; their evidence survives in the state file.
  const uninstalled = fakeRoot({ 'etc/passwd': passwd({ 'ci-run': 1001, 'ci-control': 998 }), 'var/lib/ci-control/secrets/.keep': '',
    [STATE]: state('uninstalled', { 'user.ci-run': '1001', 'user.ci-control': '998', 'dir./var/lib/ci-control': me }) });
  assert.equal(dryRun(['--dry-run'], uninstalled).status, 0);
});

test('a resume refuses an active or enabled root Docker whatever the state file says (live checks are never overridden by stored state)', { skip: skipDry }, () => {
  for (const marker of [state('incomplete'), state('incomplete', { root_docker: 'clean' }), state('uninstalled', { root_docker: 'clean' })]) {
    for (const flag of ['run/fake-enabled/docker.service', 'run/fake-active/docker.service', 'run/fake-active/docker.socket']) {
      const rr = dryRun(['--dry-run'], fakeRoot({ [flag]: '', [STATE]: marker }));
      assert.equal(rr.status, 1, `${flag} ${marker}`);
      assert.match(rr.stderr, /root Docker daemon is active or enabled/);
      assert.match(rr.stderr, /systemctl disable --now docker\.service docker\.socket/);
    }
  }
});

test('dry run refuses a busy or running farm and a root Docker daemon', { skip: skipDry }, () => {
  const busy = dryRun(['--dry-run'], fakeRoot({ 'run/fake-containers': '2\n', [STATE]: state('incomplete') }));
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /farm is busy: 2 job container\(s\)/);
  const live = dryRun(['--dry-run'], fakeRoot({ 'run/fake-active/ci-controld.service': '', [STATE]: state('incomplete') }));
  assert.match(live.stderr, /ci-controld\.service is running/);
  const docker = dryRun(['--dry-run'], fakeRoot({ 'run/fake-active/docker.service': '' }));
  assert.match(docker.stderr, /root Docker daemon is active or enabled/);
});

test('dry run refuses bad inputs: short commit, unknown commit, missing checkout, bad repo or ids', { skip: skipDry }, () => {
  const f = () => fakeRoot();
  assert.match(dryRun(['--dry-run'], f(), { COMMIT: 'abc1234' }).stderr, /full 40-hex/);
  assert.match(dryRun(['--dry-run'], f(), { COMMIT: '0'.repeat(40) }).stderr, /is not in .*\.git/);
  assert.match(dryRun(['--dry-run'], f(), { CI_SRC: '' }).stderr, /set CI_SRC/);
  assert.match(dryRun(['--dry-run'], f(), { REPO: 'not a repo' }).stderr, /invalid REPO/);
  assert.match(dryRun(['--dry-run'], f(), { APP_ID: 'abc' }).stderr, /invalid APP_ID/);
  assert.match(dryRun(['--dry-run'], f(), { KEY: '/nonexistent/key.pem' }).stderr, /invalid KEY/);
});

test('CI_FAKE_ROOT is rejected without --dry-run, and flag combinations are checked', { skip: skipDry }, () => {
  const r = dryRun([], fakeRoot());
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only honoured together with --dry-run/);
  assert.match(dryRun(['--purge'], fakeRoot()).stderr, /--purge only goes with --uninstall/);
  assert.match(dryRun(['--bogus'], fakeRoot()).stderr, /unknown argument/);
});

test('uninstall dry run: refuses farms it did not create (or cannot prove it created) and busy farms; plans the removal otherwise', { skip: skipDry }, () => {
  const foreign = dryRun(['--dry-run', '--uninstall'], fakeRoot({ 'opt/ci-master/.commit': 'x' }));
  assert.equal(foreign.status, 1);
  assert.match(foreign.stderr, /was not created by install-farm\.sh/);

  // A forged or copied state file ('complete', but nothing matches) must not make it remove a foreign farm.
  const forgedUninstall: Record<string, string>[] = [{ 'opt/ci-master/.commit': 'x', [STATE]: state('complete') }, { 'opt/ci-master/.commit': 'x', [STATE]: state('complete', { 'opt.commit': 'y' }) },
    { 'etc/passwd': passwd({ 'ci-run': 1001 }), [STATE]: state('complete', { 'user.ci-run': '77' }) },
    { 'opt/ci-master/.commit': 'x', [STATE]: state('complete', { 'opt.commit': 'x', machine: sha('ci-master-installer:another-machine') }) }];
  for (const f of forgedUninstall) {
    const rr = dryRun(['--dry-run', '--uninstall', '--purge'], fakeRoot(f));
    assert.equal(rr.status, 1, JSON.stringify(f));
    assert.match(rr.stderr, /records do not account for/);
    assert.doesNotMatch(rr.stdout, /would:/);
  }

  const busy = dryRun(['--dry-run', '--uninstall'], fakeRoot({ [STATE]: state('complete'), 'run/fake-containers': '1\n' }));
  assert.match(busy.stderr, /busy: 1 job container/);

  const ctl = 'unit text', wd = 'timer text';
  const files = { 'opt/ci-master/.commit': 'abc', 'etc/ci-master/registry.yaml': '', 'etc/systemd/system/ci-controld.service': ctl, 'etc/systemd/system/ci-watchdog.timer': wd,
    'etc/passwd': passwd({ 'ci-run': 1001, 'ci-control': 998, 'ci-audit': 997 }), 'var/lib/ci-audit/audit.jsonl': '', 'var/lib/ci-control/secrets/.keep': '',
    [STATE]: state('complete', { 'opt.commit': 'abc', 'user.ci-run': '1001', 'user.ci-control': '998', 'user.ci-audit': '997', 'dir./var/lib/ci-control': me, 'dir./var/lib/ci-audit': me,
      'file./etc/systemd/system/ci-controld.service': sha(ctl), 'file./etc/systemd/system/ci-watchdog.timer': sha(wd) }) };
  const plain = dryRun(['--dry-run', '--uninstall'], fakeRoot(files));
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /systemctl disable --now ci-watchdog\.timer/);
  assert.match(plain.stdout, /systemctl disable --now ci-controld\.service/);
  assert.match(plain.stdout, /rm -rf \/opt\/ci-master \/etc\/ci-master/);
  assert.match(plain.stdout, /Kept: users/);
  assert.doesNotMatch(plain.stdout, /userdel|shred|chattr/); // data, users and the App key survive a plain uninstall
  assert.ok(plain.stdout.indexOf('ci-watchdog.timer') < plain.stdout.indexOf('ci-controld.service')); // watchdog first, or it restarts what we stop

  const purge = dryRun(['--dry-run', '--uninstall', '--purge'], fakeRoot(files));
  assert.equal(purge.status, 0, purge.stderr);
  assert.match(purge.stdout, /chattr -a \/var\/lib\/ci-audit\/audit\.jsonl/);
  assert.match(purge.stdout, /shred -u/);
  for (const u of ['ci-run', 'ci-control', 'ci-audit']) assert.match(purge.stdout, new RegExp(`userdel -r ${u}`));
  assert.match(purge.stdout, /Packages .* stay installed/);
});

// ---- mutating steps with recorders ------------------------------------------------------------------------------------------------------------
function recorded(code: string, env: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'ci-rec-'));
  const r = sh(`
    LOGF=${d}/log
    step() { local d=$1; shift; printf '%s\\n' "$*" >> "$LOGF"; }
    put_file() { printf 'PUT %s %s %s: %s\\n' "$1" "$2" "$3" "$(cat)" >> "$LOGF"; }
    curl() { return 0; }
    existing_install_items() { :; }   # tests must not depend on a farm that happens to exist on the machine running them
    user_exists() { return 1; }
    machine_tag() { echo ${'f'.repeat(64)}; }
    DRY=0 COMMIT=${'a'.repeat(40)} CI_SRC=/src REPO=acme/my-app KEY=/k.pem APP_ID=1 INSTALLATION_ID=2 STAGE=/stage NODE_SHA256_OUT=${'b'.repeat(64)}
    ${code}`, env);
  let log = '';
  try { log = readFileSync(join(d, 'log'), 'utf8'); } catch { /* nothing logged */ }
  return { ...r, log };
}

test('mutating steps: exact commands for packages, delegation, state and start order', () => {
  const r = recorded('install_packages; setup_control_user; run_runtime_installer; start_services; write_state complete');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /^apt-get update$/m);
  assert.match(r.log, /apt-get install -y --no-install-recommends docker\.io rootlesskit slirp4netns uidmap dbus-user-session nftables/);
  assert.match(r.log, /^systemctl disable --now docker\.service docker\.socket$/m);
  assert.match(r.log, /env KEY=\/k\.pem APP_ID=1 INSTALLATION_ID=2 bash \/stage\/tree\/scripts\/setup-control-user\.sh/);
  // install-runtime.sh runs from the VERIFIED staging copy, with the typed commit and the node hash computed from the pinned tarball
  assert.match(r.log, new RegExp(`env CI_SRC=/src COMMIT=${'a'.repeat(40)} NODE=/stage/node NODE_SHA256=${'b'.repeat(64)} BUILD_IMAGE=1 NO_WATCHDOG_START=1 REGISTRY=config/registry\\.example\\.yaml bash /stage/tree/scripts/install-runtime\\.sh`));
  assert.ok(r.log.indexOf('systemctl restart ci-egress.service ci-broker.service ci-auditd.service ci-controld.service') > r.log.indexOf('install-runtime.sh'));
  assert.ok(r.log.indexOf('systemctl enable --now ci-watchdog.timer') > r.log.indexOf('systemctl restart ci-egress.service ci-broker.service ci-auditd.service ci-controld.service'));
  assert.match(r.log, /^systemctl enable --now ci-watchdog\.timer$/m);
  assert.match(r.log, /PUT 0644 root:root \/var\/lib\/ci-master-installer\/state: status=complete\nmachine=f{64}\ncommit=a{40}\nrepo=acme\/my-app/);
  assert.doesNotMatch(r.log, /BEGIN/); // key content never appears in a command
});

test('the exit trap stops watchdog and controld first, removes and confirms slot containers, then stops broker and egress (or leaves egress up if unconfirmed)', () => {
  const run = (units: number, rc: number, slotsOk = 1) => recorded(`
    systemctl() { printf 'systemctl %s\\n' "$*" >> "$LOGF"; }
    stop_slot_containers() { printf 'stop_slot_containers\\n' >> "$LOGF"; [ ${slotsOk} = 1 ]; }
    ( UNITS_INSTALLED=${units}; (exit ${rc}); on_exit )`);
  const failed = run(1, 3, 1);
  assert.equal(failed.status, 3);
  const order = [
    'systemctl stop ci-watchdog.timer ci-watchdog.service',
    'systemctl stop ci-controld.service',
    'stop_slot_containers',
    'systemctl stop ci-broker.service ci-auditd.service',
    'systemctl stop ci-egress.service',
    'systemctl disable ci-egress.service ci-broker.service ci-auditd.service ci-controld.service ci-watchdog.timer',
  ];
  let at = 0;
  for (const step of order) { const i = failed.log.indexOf(step, at); assert.ok(i >= at && i !== -1, `missing or out of order: ${step} in:\n${failed.log}`); at = i; }
  assert.equal(run(0, 3).log, '');
  assert.equal(run(1, 0).log, '');

  // If slot container removal cannot be confirmed, ci-egress.service stays running so untrusted jobs are not left on an open network.
  const unconfirmed = run(1, 3, 0);
  assert.equal(unconfirmed.status, 3);
  assert.match(unconfirmed.log, /systemctl stop ci-watchdog\.timer/);
  assert.match(unconfirmed.log, /systemctl stop ci-controld\.service/);
  assert.match(unconfirmed.log, /systemctl stop ci-broker\.service ci-auditd\.service/);
  assert.doesNotMatch(unconfirmed.log, /systemctl stop[^\n]*ci-egress\.service/);
  assert.match(unconfirmed.stderr, /leaving ci-egress\.service running.*sudo systemctl stop ci-egress\.service/);

  // stop_slot_containers uses the launcher's label (ci-master=1) and name prefix (cif-), removes with rm -fv, and re-queries to confirm none remain.
  const clean = recorded(`
    user_exists() { return 0; }; id() { echo 1001; }
    runuser() {
      shift 4
      printf '%s\\n' "$*" >> "$LOGF"
      case "$*" in
        *"ps -aq --filter label=ci-master=1") [ -e "$LOGF.rm" ] || echo c1 ;;
        *"ps -aq --filter name=^/cif-")       [ -e "$LOGF.rm" ] || echo c2 ;;
        *"rm -fv c1 c2")                      : > "$LOGF.rm" ;;
      esac
      return 0
    }
    stop_slot_containers`);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.log, /docker rm -fv c1 c2/);

  const stuck = recorded(`
    user_exists() { return 0; }; id() { echo 1001; }
    runuser() { shift 4; case "$*" in *"ps -aq"*) echo c1 ;; *"rm -fv"*) return 0 ;; esac; }
    stop_slot_containers`);
  assert.notEqual(stuck.status, 0);
});

test('init_secrets sends the second factor and token to the terminal only, never through the logged stdout', () => {
  const body = sh('declare -f init_secrets').stdout;
  assert.equal((body.match(/> ?\/dev\/tty/g) ?? []).length, 2); // declare -f normalises spacing
  assert.match(body, /init-totp > ?\/dev\/tty/);
  assert.match(body, /issue owner human > ?\/dev\/tty/);
  assert.doesNotMatch(body, /tee|\| *cat|echo.*secret/i);
});

test('the uninstall never touches anything outside the farm paths it created', () => {
  const body = sh('declare -f do_uninstall').stdout;
  const rms = [...body.matchAll(/rm -rf ([^"\n]+)/g)].map((m) => m[1]);
  for (const line of rms) for (const p of line.split(' ').map((x) => x.replace(/;$/, '')).filter((x) => x.startsWith('/'))) {
    assert.match(p, /^\/(opt\/ci-master|etc\/ci-master|etc\/tmpfiles\.d\/ci-(master|audit)\.conf|var\/lib\/ci-(watchdog|audit)|run\/ci-(master|audit))$/, p);
  }
});

// ---- review round 1: read-only preflight, probe cleanup, key path stays out of the log ---------------------------------------------------------
test('the preflight function itself cannot write: no probe, no mktemp, no install, no rm, no chattr, no redirection into files', () => {
  const body = sh('declare -f preflight').stdout;
  assert.ok(body.length > 500);
  assert.doesNotMatch(body, /(^|[;&|{(]\s*|\n\s*)(chattr|mktemp|rm|mv|cp|install|tee|touch|useradd|apt-get|systemctl (enable|disable|start|stop|restart))\s/);
  assert.doesNotMatch(body, />\s*\/(?!dev\/null)/); // only /dev/null may be a redirection target
});

test('the chattr probe is its own step after the confirmation and on_exit removes exactly that file on every exit path', () => {
  const order = sh('declare -f do_install').stdout;
  assert.ok(order.indexOf('collect_answers') < order.indexOf('append_only_probe'));
  assert.ok(order.indexOf('append_only_probe') < order.indexOf('install_packages'));
  assert.ok(order.indexOf('append_only_probe') < order.indexOf('write_state incomplete'));
  const r = recorded(`chattr() { printf 'chattr %s\\n' "$*" >> "$LOGF"; }; rm() { printf 'rm %s\\n' "$*" >> "$LOGF"; }; ( PROBE=/var/lib/.ci-append-probe.X1; (exit 5); on_exit )`);
  assert.equal(r.status, 5);
  assert.match(r.log, /^chattr -a \/var\/lib\/\.ci-append-probe\.X1$/m);
  assert.match(r.log, /^rm -f \/var\/lib\/\.ci-append-probe\.X1$/m);
  const none = recorded(`chattr() { printf 'chattr %s\\n' "$*" >> "$LOGF"; }; ( PROBE=; (exit 0); on_exit )`);
  assert.equal(none.log, '');
  const main = sh('declare -f main').stdout;
  assert.match(main, /trap 'exit 130' INT TERM HUP/); // a signal ends the run through the EXIT trap
});

test('dry run does not create, change or remove anything (fake root, checkout and temp dir are identical before and after)', { skip: skipDry }, () => {
  const snap = (dir: string) => spawnSync('bash', ['-c', `cd ${dir} && find . -path ./.git -prune -o -printf '%p %y %m %s %T@\\n' | sort`], { encoding: 'utf8' }).stdout;
  const fr = fakeRoot();
  farm.repo ??= makeRepo();
  const before = [snap(fr), snap(farm.repo.dir), readdirSync(tmpdir()).filter((n) => n.startsWith('ci-farm-install.')).sort().join()];
  const r = dryRun(['--dry-run'], fr);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([snap(fr), snap(farm.repo.dir), readdirSync(tmpdir()).filter((n) => n.startsWith('ci-farm-install.')).sort().join()], before);
  assert.match(r.stdout, /would: test chattr \+a on a temporary probe file/);
});

test('a key path is never echoed into the log: control characters are refused and the delegated script does not print KEY', () => {
  const d = mkdtempSync(join(tmpdir(), 'ci-key-'));
  const pem = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n';
  writeFileSync(join(d, 'ok.pem'), pem);
  writeFileSync(join(d, 'evil\nname.pem'), pem);
  assert.ok(ok(`valid_key_file '${d}/ok.pem'`));
  assert.notEqual(sh(`valid_key_file "${d}/evil"$'\\n'"name.pem"`).status, 0);
  assert.notEqual(sh(`valid_key_file "${d}/ok.pem"$'\\x1b[2J'`).status, 0);
  const ctl = readFileSync(join(ROOT, 'scripts/setup-control-user.sh'), 'utf8');
  assert.doesNotMatch(ctl, /echo[^\n]*\$KEY|printf[^\n]*\$KEY/); // the only place that could print it
  assert.equal(sh('declare -f setup_control_user').stdout.includes('tee'), false);
  rmSync(d, { recursive: true });
});

test('the state file carries status, machine tag, informational commit/repo and nothing else when no farm part exists', () => {
  const r = recorded('write_state incomplete');
  const body = r.log.replace(/^PUT \S+ \S+ \S+: /, '');
  assert.deepEqual(body.trim().split('\n').map((l) => l.split('=')[0]), ['status', 'machine', 'commit', 'repo']);
});

// ---- review round 2 ------------------------------------------------------------------------------------------------------------------------
test('the append-only probe is the first host change: before the state dir, the log file and the tee; a failed chattr leaves nothing behind', () => {
  const body = sh('declare -f do_install').stdout;
  const at = (needle: string) => { const i = body.indexOf(needle); assert.ok(i !== -1, needle); return i; };
  assert.ok(at('collect_answers') < at('append_only_probe'));
  assert.ok(at('append_only_probe') < at('install -d -m 0755 "$STATE_DIR"'));
  assert.ok(at('append_only_probe') < at('tee -a'));
  assert.ok(at('append_only_probe') < at('mktemp -d'));
  const d = mkdtempSync(join(tmpdir(), 'ci-probe-'));
  const r = sh(`PROBE_DIR=${d}; DRY=0; chattr() { return 1; }; ( trap on_exit EXIT; append_only_probe )`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /chattr \+a does not work/);
  assert.deepEqual(readdirSync(d), []); // the probe file is gone again
  const ok2 = sh(`PROBE_DIR=${d}; DRY=0; chattr() { return 0; }; ( trap on_exit EXIT; append_only_probe )`);
  assert.equal(ok2.status, 0, ok2.stderr);
  assert.deepEqual(readdirSync(d), []);
  rmSync(d, { recursive: true });
});

test('the key path is redacted from everything the log sees, including a child error after the file vanished', () => {
  const key = '/home/ubuntu/Downloads/my app.private-key.pem';
  const r = sh(`KEY='${key}'; printf 'install: cannot stat %s: No such file\\nshred -u %s ok\\n' "'${key}'" '${key}' | redact_key`);
  assert.doesNotMatch(r.stdout, /Downloads|private-key/);
  assert.match(r.stdout, /<key path>/);
  assert.equal(sh("KEY=''; printf 'plain line\\n' | redact_key").stdout, 'plain line\n'); // no key set: pass-through, no infinite loop
  assert.equal(sh("KEY='a.c'; printf 'abc a.c\\n' | redact_key").stdout, 'abc <key path>\n'); // literal match, not a regex

  // failure path of the delegated script: stub install fails with the real-looking message that names the path
  const bin = mkdtempSync(join(tmpdir(), 'ci-bin-'));
  const stub = (n: string, body: string) => { writeFileSync(join(bin, n), `#!/bin/bash\n${body}\n`, { mode: 0o755 }); };
  stub('id', 'exit 0'); stub('useradd', 'exit 0');
  stub('install', 'for a; do last=$a; done; if [ "$1" = -m ] && [ "$2" = 0400 ]; then echo "install: cannot stat \'$KEY\': No such file or directory" >&2; exit 1; fi; exit 0');
  const keyFile = join(bin, 'secret-name.pem');
  writeFileSync(keyFile, '-----BEGIN PRIVATE KEY-----\n');
  const run = spawnSync('bash', [join(ROOT, 'scripts/setup-control-user.sh')], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, KEY: keyFile, APP_ID: '1', INSTALLATION_ID: '2' } });
  assert.notEqual(run.status, 0);
  assert.doesNotMatch(run.stdout + run.stderr, /secret-name/); // the child prints a fixed message, never the path
  assert.match(run.stderr, /could not read the key file/);
  rmSync(bin, { recursive: true });
});

test('record_evidence writes only what the live machine shows (users with ids, installed commit, file hashes), nothing from the old state', () => {
  const r = recorded(`
    existing_install_items() { printf '%s\\n' 'user ci-run' /opt/ci-master /var/lib/ci-control /etc/systemd/system/ci-broker.service /etc/ci-master; }
    user_uid() { echo 1001; }; opt_commit() { echo abc; }; owner_uid() { echo 998; }; sha_of() { echo deadbeef; }
    STATUS=incomplete; record_evidence`);
  const body = r.log.replace(/^PUT \S+ \S+ \S+: /, '').trim().split('\n');
  assert.deepEqual(body, ['status=incomplete', `machine=${'f'.repeat(64)}`, `commit=${'a'.repeat(40)}`, 'repo=acme/my-app', 'user.ci-run=1001', 'opt.commit=abc', 'dir./var/lib/ci-control=998', 'file./etc/systemd/system/ci-broker.service=deadbeef']);
});

test('a run that was refused never writes evidence: the exit trap records only after the attribution gate (EVIDENCE_OK)', () => {
  const refused = recorded('( EVIDENCE_OK=0; (exit 1); on_exit )');
  assert.equal(refused.log, '');
  const passed = recorded('existing_install_items() { :; }; ( EVIDENCE_OK=1; STATUS=incomplete; (exit 1); on_exit )');
  assert.match(passed.log, /^PUT 0644 root:root \/var\/lib\/ci-master-installer\/state: status=incomplete/m);
});

test('a missing or empty /etc/machine-id never counts as a match: install refuses to start, and resume/uninstall refuse with otherwise perfect evidence', { skip: skipDry }, () => {
  for (const id of [null, '', '\n']) {
    const r = dryRun(['--dry-run'], fakeRoot({ 'etc/machine-id': id }));
    assert.equal(r.status, 1, JSON.stringify(id));
    assert.match(r.stderr, /\/etc\/machine-id is missing or empty/);
  }
  // a state file from a machine that also had no id (tag = hash of the empty id) must not match one that has none
  const emptyTag = sha('ci-master-installer:');
  for (const id of [null, '']) {
    const f = { 'etc/machine-id': id, 'opt/ci-master/.commit': 'abc', [STATE]: state('complete', { 'opt.commit': 'abc', machine: emptyTag }) };
    const u = dryRun(['--dry-run', '--uninstall'], fakeRoot(f));
    assert.equal(u.status, 1, JSON.stringify(id));
    assert.match(u.stderr, /records do not account for/);
    const blank = dryRun(['--dry-run', '--uninstall'], fakeRoot({ ...f, [STATE]: `status=complete\nmachine=\nopt.commit=abc\n` }));
    assert.equal(blank.status, 1);
  }
  const fr = fakeRoot({ 'etc/machine-id': null });
  assert.equal(sh(`FR=${fr}; machine_tag`).stdout, '');
  assert.ok(!ok(`FR=${fr}; item_attributed /opt/ci-master`));
});

// ---- review round 3: git trust boundary, registry stdin validation, watchdog order, registry keep, node path, prerequisites --------------------
test('every git object read environment sets GIT_NO_LAZY_FETCH=1, GIT_ALLOW_PROTOCOL=, GIT_NO_REPLACE_OBJECTS=1, safe.directory=* and protocol.allow=never', { skip: skipDry }, () => {
  const pre = sh('declare -f preflight').stdout;
  for (const needle of [
    'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_SYSTEM=/dev/null', 'GIT_NO_REPLACE_OBJECTS=1', 'GIT_NO_LAZY_FETCH=1', "GIT_ALLOW_PROTOCOL=(?:''|\"\")?\\s",
    'GIT_CONFIG_COUNT=2', 'GIT_CONFIG_KEY_0=safe\\.directory', "GIT_CONFIG_VALUE_0='?\\*'?", 'GIT_CONFIG_KEY_1=protocol\\.allow', 'GIT_CONFIG_VALUE_1=never',
  ]) {
    assert.match(pre, new RegExp(needle), `preflight missing ${needle}`);
  }
  const runtime = readFileSync(join(ROOT, 'scripts/install-runtime.sh'), 'utf8');
  for (const [label, src] of [['install-farm.sh vextract', sh('declare -f vextract').stdout], ['install-runtime.sh', runtime]] as const) {
    for (const [k, v] of [
      ['GIT_CONFIG_GLOBAL', '/dev/null'], ['GIT_CONFIG_SYSTEM', '/dev/null'], ['GIT_NO_REPLACE_OBJECTS', '1'], ['GIT_NO_LAZY_FETCH', '1'], ['GIT_ALLOW_PROTOCOL', ''],
      ['GIT_CONFIG_COUNT', '2'], ['GIT_CONFIG_KEY_0', 'safe.directory'], ['GIT_CONFIG_VALUE_0', '*'], ['GIT_CONFIG_KEY_1', 'protocol.allow'], ['GIT_CONFIG_VALUE_1', 'never'],
    ]) {
      assert.ok(src.includes(`'${k}': '${v}'`), `${label} missing ${k}=${v}`);
    }
  }
  // A promisor remote with protocol.ssh.allow=always and core.sshCommand in .git/config cannot trigger a lazy fetch when an object is missing.
  const { dir } = makeRepo();
  const marker = join(dir, 'pwned');
  git(dir, 'config', 'core.repositoryformatversion', '1');
  git(dir, 'config', 'extensions.partialclone', 'origin');
  git(dir, 'config', 'remote.origin.url', 'ssh://127.0.0.1/repo');
  git(dir, 'config', 'remote.origin.promisor', 'true');
  git(dir, 'config', 'protocol.ssh.allow', 'always');
  git(dir, 'config', 'core.sshCommand', `touch ${marker}`);
  const out = mkdtempSync(join(tmpdir(), 'ci-out-')) + '/tree';
  const r = sh(`vextract ${dir}/.git ${'deadbeef'.repeat(5)} ${out} .`);
  assert.notEqual(r.status, 0);
  assert.equal(readdirSync(dir).includes('pwned'), false);
});

test('write_registry passes the candidate registry on stdin to nobody instead of a path inside the 0700 $STAGE directory', () => {
  const body = sh('declare -f write_registry').stdout;
  assert.match(body, /readFileSync\(0, 'utf8'\)/);
  assert.match(body, /< ?"\$tmp"/);
  assert.doesNotMatch(body, /process\.argv\[1\]/);

  const stage = mkdtempSync(join(tmpdir(), 'ci-stage-'));
  chmodSync(stage, 0o700);
  const dest = join(stage, 'installed-registry.yaml');
  const r = sh(`
    STAGE=${stage}; DRY=0; REPO=acme/my-app
    runuser() {
      shift 3
      for a in "$@"; do [[ "$a" == ${stage}* ]] && { echo "cannot traverse 0700 STAGE" >&2; return 1; }; done
      "${process.execPath}" --input-type=module -e "import {loadRegistry} from '${ROOT}/src/registry.ts'; import {readFileSync} from 'node:fs'; const r = loadRegistry(readFileSync(0, 'utf8')); console.log('registry ok:', r.length, 'project(s)')"
    }
    install() { cp "$7" "${dest}"; }
    cd() { :; }
    write_registry
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /registry ok: 1 project\(s\)/);
  assert.equal(loadRegistry(readFileSync(dest, 'utf8'))[0].repo, 'acme/my-app');
  rmSync(stage, { recursive: true });
});

test('install-runtime.sh: validates candidate REGISTRY in $STAGE as nobody before any live file or install.conf is changed, keeps existing registry when REGISTRY is unset, saves installed node path, and honours NO_WATCHDOG_START=1', () => {
  const runtime = readFileSync(join(ROOT, 'scripts/install-runtime.sh'), 'utf8');
  assert.match(runtime, /if \[ "\$\{NO_WATCHDOG_START:-\}" = 1 \]; then\s+systemctl enable ci-watchdog\.timer >\/dev\/null\s+else\s+systemctl enable --now ci-watchdog\.timer >\/dev\/null\s+fi/);
  assert.match(runtime, /if \[ -n "\$\{REGISTRY:-\}" \] \|\| \[ ! -f \/etc\/ci-master\/registry\.yaml \]; then/);
  assert.match(runtime, /keeping existing \/etc\/ci-master\/registry\.yaml/);
  assert.match(runtime, /runuser -u nobody -- "\$STAGE\/node" --input-type=module -e/);
  assert.match(runtime, /readFileSync\(0, 'utf8'\)/);
  assert.match(runtime, /INSTALLED_NODE=\/opt\/ci-master\/bin\/node/);
  assert.match(runtime, /INSTALLED_NODE_SHA=\$\(sha256sum "\$INSTALLED_NODE" \| cut -d' ' -f1\)/);
  assert.match(runtime, /printf 'CI_SRC=%s\\nNODE=%s\\nNODE_SHA256=%s\\n' "\$SRC" "\$INSTALLED_NODE" "\$INSTALLED_NODE_SHA" > \/etc\/ci-master\/install\.conf/);
  assert.doesNotMatch(runtime, /printf 'CI_SRC=%s\\nNODE=%s\\nNODE_SHA256=%s\\n' "\$SRC" "\$NODE"/);

  // Candidate registry is validated from $STAGE as nobody BEFORE any live file under /opt/ci-master or /etc/ci-master is touched.
  const runuserPos = runtime.indexOf('runuser -u nobody -- "$STAGE/node"');
  const validatePos = runtime.indexOf("loadRegistry(readFileSync(0, 'utf8'))");
  assert.ok(runuserPos !== -1 && validatePos !== -1 && runuserPos < validatePos);
  for (const liveWrite of [
    'install -d -m 0755 /opt/ci-master',
    'install -m 0755 "$STAGE/node" /opt/ci-master/bin/node',
    'cp -r "$STAGE/node_modules/zod"',
    '> /opt/ci-master/.commit',
    '> /etc/ci-master/install.conf',
    'install -m 0644 "$REG" /etc/ci-master/registry.yaml',
  ]) {
    const pos = runtime.indexOf(liveWrite);
    assert.ok(pos !== -1 && runuserPos < pos && validatePos < pos, `registry validation as nobody must precede ${liveWrite}`);
  }

  // Executing the pre-install block runs the validator via `runuser -u nobody` with stdin, grants minimum o+rX/o+x on $STAGE (never o+w), and aborts on invalid YAML before reaching the first install command.
  const stage = mkdtempSync(join(tmpdir(), 'ci-rt-stage-'));
  chmodSync(stage, 0o700);
  mkdirSync(join(stage, 'tree/src'), { recursive: true, mode: 0o700 });
  mkdirSync(join(stage, 'node_modules'), { recursive: true, mode: 0o700 });
  cpSync(join(ROOT, 'src/registry.ts'), join(stage, 'tree/src/registry.ts'));
  chmodSync(join(stage, 'tree/src/registry.ts'), 0o600);
  cpSync(join(ROOT, 'package.json'), join(stage, 'tree/package.json'));
  chmodSync(join(stage, 'tree/package.json'), 0o600);
  for (const dep of ['yaml', 'zod']) cpSync(join(ROOT, 'node_modules', dep), join(stage, 'node_modules', dep), { recursive: true });
  writeFileSync(join(stage, 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o700 });
  writeFileSync(join(stage, 'tree/bad.yaml'), '- name: BAD_UPPER\n', { mode: 0o600 });
  cpSync(join(ROOT, 'config/registry.example.yaml'), join(stage, 'tree/ok.yaml'));
  chmodSync(join(stage, 'tree/ok.yaml'), 0o600);
  const snippet = runtime.slice(runtime.indexOf('if [ -n "${REGISTRY:-}" ]'), runtime.indexOf('install -m 0755 "$STAGE/node" /opt/ci-master/bin/node'));
  const runSnippet = (reg: string) => spawnSync('bash', ['-c', `
    set -euo pipefail
    STAGE=${stage}; TREE=$STAGE/tree; COMMIT=${'a'.repeat(40)}; REGISTRY=${reg}
    runuser() {
      [ "$1" = -u ] && [ "$2" = nobody ] && [ "$3" = -- ] || { echo "BAD_RUNUSER: $*" >&2; exit 98; }
      shift 3
      echo "RUNUSER_NOBODY: $1" >&2
      "$@"
    }
    install() { echo INSTALLED_LIVE >&2; exit 99; }
    ${snippet}
  `], { encoding: 'utf8' });
  const badRun = runSnippet('bad.yaml');
  assert.notEqual(badRun.status, 0);
  assert.match(badRun.stderr, /RUNUSER_NOBODY:/);
  assert.doesNotMatch(badRun.stderr, /INSTALLED_LIVE/);
  assert.match(badRun.stderr, /did not pass the staged registry parser/);
  assert.equal(statSync(stage).mode & 0o777, 0o701); // traverse-only for other on $STAGE
  assert.equal(statSync(join(stage, 'tree')).mode & 0o003, 0o001); // traverse, no write for other on $TREE
  assert.equal(statSync(join(stage, 'node')).mode & 0o007, 0o005); // r-x for other on staged node
  assert.equal(statSync(join(stage, 'tree/package.json')).mode & 0o006, 0o004); // r-- for other
  assert.equal(statSync(join(stage, 'tree/src/registry.ts')).mode & 0o006, 0o004); // r-- for other
  assert.equal(statSync(join(stage, 'node_modules/yaml/package.json')).mode & 0o006, 0o004);
  assert.equal(statSync(join(stage, 'node_modules/zod/package.json')).mode & 0o006, 0o004);
  assert.equal(statSync(join(stage, 'tree/bad.yaml')).mode & 0o077, 0); // candidate registry stayed 0600 (root opened fd 0)
  const goodRun = runSnippet('ok.yaml');
  assert.equal(goodRun.status, 99);
  assert.match(goodRun.stdout, /registry ok: 1 project\(s\)/);
  assert.ok(goodRun.stderr.indexOf('RUNUSER_NOBODY:') !== -1 && goodRun.stderr.indexOf('RUNUSER_NOBODY:') < goodRun.stderr.indexOf('INSTALLED_LIVE'));
  rmSync(stage, { recursive: true });

  const doInstall = sh('declare -f do_install').stdout;
  assert.ok(doInstall.indexOf('write_registry') < doInstall.indexOf('start_services'));
  assert.ok(doInstall.indexOf('init_secrets') < doInstall.indexOf('start_services'));
  const startBody = sh('declare -f start_services').stdout;
  assert.ok(startBody.indexOf('systemctl restart ci-egress.service') < startBody.indexOf('systemctl enable --now ci-watchdog.timer'));

  // NO_WATCHDOG_START suppresses the standalone "to run the new code: sudo systemctl restart ..." hint when invoked from install-farm.sh.
  assert.match(runtime, /elif \[ -z "\$\{NO_WATCHDOG_START:-\}" \]; then\s+echo "to run the new code: sudo systemctl restart ci-egress ci-broker ci-auditd ci-controld/);
  const tail = runtime.slice(runtime.indexOf('if [ -n "${RESTART:-}" ]; then'));
  const standAlone = spawnSync('bash', ['-c', `set -euo pipefail; ${tail}`], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  assert.equal(standAlone.status, 0);
  assert.match(standAlone.stdout, /to run the new code: sudo systemctl restart ci-egress ci-broker ci-auditd ci-controld/);
  const delegated = spawnSync('bash', ['-c', `set -euo pipefail; NO_WATCHDOG_START=1; ${tail}`], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  assert.equal(delegated.status, 0);
  assert.equal(delegated.stdout, '');
});

test('prerequisites: xz-utils, curl and ca-certificates are installed after confirmation and before fetch_node, and preflight reports when any are missing', { skip: skipDry }, () => {
  const doInstall = sh('declare -f do_install').stdout;
  assert.ok(doInstall.indexOf('collect_answers') < doInstall.indexOf('install_prereqs'));
  assert.ok(doInstall.indexOf('install_prereqs') < doInstall.indexOf('fetch_node'));
  assert.ok(doInstall.indexOf('fetch_node') < doInstall.indexOf('install_packages'));

  const prereq = recorded('install_prereqs');
  assert.equal(prereq.status, 0);
  assert.equal(prereq.log.trim(), 'apt-get update\nenv DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xz-utils curl ca-certificates');

  const r = dryRun(['--dry-run'], fakeRoot({ 'run/fake-no-ca-certs': '' }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /missing download prerequisite\(s\): .*ca-certificates/);
  assert.ok(r.stdout.indexOf('apt-get install -y --no-install-recommends xz-utils curl ca-certificates') < r.stdout.indexOf('nodejs.org/dist/'));
});

test('prepare_rootless_docker links /usr/bin/docker into /usr/share/docker.io/contrib before dockerd-rootless-setuptool.sh, guarded on executable source and missing target', { skip: skipDry }, () => {
  const post = sh('declare -f post_package_checks').stdout;
  assert.match(post, /\[ -x \/usr\/share\/docker\.io\/contrib\/dockerd-rootless-setuptool\.sh \]/);

  const body = sh('declare -f prepare_rootless_docker').stdout;
  const guardPos = body.indexOf('[ -x /usr/bin/docker ] && [ ! -e /usr/share/docker.io/contrib/docker ]');
  const linkPos = body.indexOf('ln -s /usr/bin/docker /usr/share/docker.io/contrib/docker');
  const setupPos = body.indexOf('dockerd-rootless-setuptool.sh install');
  assert.ok(guardPos !== -1 && linkPos !== -1 && setupPos !== -1, body);
  assert.ok(guardPos < linkPos && linkPos < setupPos);
  assert.match(body, /PATH=\/usr\/share\/docker\.io\/contrib:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin/);

  const dry = dryRun(['--dry-run'], fakeRoot());
  assert.equal(dry.status, 0, dry.stderr);
  const dryLink = dry.stdout.indexOf('ln -s /usr/bin/docker /usr/share/docker.io/contrib/docker');
  const drySetup = dry.stdout.indexOf('dockerd-rootless-setuptool.sh install');
  assert.ok(dryLink !== -1 && drySetup !== -1 && dryLink < drySetup);
});

test('uninstall --purge stops user@<uid>.service, waits for ci-run processes, force-kills stragglers, and refuses if any survive before userdel', { skip: skipDry }, () => {
  const body = sh('declare -f do_uninstall').stdout;
  const order = [
    'loginctl terminate-user ci-run',
    'loginctl disable-linger ci-run',
    'systemctl stop "user@$uid.service"',
    'pgrep -u ci-run',
    'pkill -KILL -u ci-run',
    'userdel -r "$u"',
  ];
  let at = 0;
  for (const needle of order) {
    const i = body.indexOf(needle, at);
    assert.ok(i >= at && i !== -1, `missing or out of order: ${needle} in:\n${body}`);
    at = i;
  }

  const ctl = 'unit text', wd = 'timer text';
  const files = {
    'opt/ci-master/.commit': 'abc', 'etc/ci-master/registry.yaml': '', 'etc/systemd/system/ci-controld.service': ctl, 'etc/systemd/system/ci-watchdog.timer': wd,
    'etc/passwd': passwd({ 'ci-run': 1001, 'ci-control': 998, 'ci-audit': 997 }), 'var/lib/ci-audit/audit.jsonl': '', 'var/lib/ci-control/secrets/.keep': '',
    [STATE]: state('complete', {
      'opt.commit': 'abc', 'user.ci-run': '1001', 'user.ci-control': '998', 'user.ci-audit': '997', 'dir./var/lib/ci-control': me, 'dir./var/lib/ci-audit': me,
      'file./etc/systemd/system/ci-controld.service': sha(ctl), 'file./etc/systemd/system/ci-watchdog.timer': sha(wd),
    }),
  };
  const purge = dryRun(['--dry-run', '--uninstall', '--purge'], fakeRoot(files));
  assert.equal(purge.status, 0, purge.stderr);
  const dryOrder = ['loginctl terminate-user ci-run', 'loginctl disable-linger ci-run', 'systemctl stop user@1001.service', 'userdel -r ci-run'];
  let dryAt = 0;
  for (const m of dryOrder) {
    const i = purge.stdout.indexOf(m, dryAt);
    assert.ok(i >= dryAt && i !== -1, `missing or out of order in dry-run: ${m}`);
    dryAt = i;
  }

  const baseEnv = `
    set -e
    PURGE=1 ASSUME_YES=1
    state_status() { echo complete; }
    unattributed_items() { :; }
    running_job_containers() { echo 0; }
    user_exists() { [ "$1" = ci-run ]; }
    id() { [ "\${2:-}" = ci-run ] && echo 1001 || echo 0; }
    sleep() { :; }
  `;

  // Straggler survives the 30s grace poll, gets SIGKILLed, then exits before userdel runs.
  const killed = recorded(`
    ${baseEnv}
    pgrep() { [ ! -e "$LOGF.killed" ]; }
    step() {
      local d=$1; shift
      printf '%s\\n' "$*" >> "$LOGF"
      [ "$1" = pkill ] && : > "$LOGF.killed"
      return 0
    }
    do_uninstall
  `);
  assert.equal(killed.status, 0, killed.stderr);
  const killedOrder = [
    'loginctl terminate-user ci-run',
    'loginctl disable-linger ci-run',
    'systemctl stop user@1001.service',
    'pkill -KILL -u ci-run',
    'userdel -r ci-run',
  ];
  let kAt = 0;
  for (const m of killedOrder) {
    const i = killed.log.indexOf(m, kAt);
    assert.ok(i >= kAt && i !== -1, `missing or out of order: ${m} in:\n${killed.log}`);
    kAt = i;
  }

  // Last process exits between pgrep and pkill (pkill returns 1 = nothing matched) under set -e -> continues to userdel.
  const exitedRace = recorded(`
    ${baseEnv}
    pgrep() { [ ! -e "$LOGF.gone" ]; }
    pkill() { : > "$LOGF.gone"; return 1; }
    step() {
      local d=$1; shift
      printf '%s\\n' "$*" >> "$LOGF"
      if [ "$1" = pkill ]; then "$@"; fi
    }
    do_uninstall
  `);
  assert.equal(exitedRace.status, 0, exitedRace.stderr);
  assert.match(exitedRace.log, /pkill -KILL -u ci-run[\s\S]*userdel -r ci-run/);

  // pkill returning >1 (e.g. 2) still aborts before userdel.
  const pkillErr = recorded(`
    ${baseEnv}
    pgrep() { [ ! -e "$LOGF.gone" ]; }
    pkill() { : > "$LOGF.gone"; return 2; }
    step() {
      local d=$1; shift
      printf '%s\\n' "$*" >> "$LOGF"
      if [ "$1" = pkill ]; then "$@"; fi
    }
    do_uninstall
  `);
  assert.equal(pkillErr.status, 2);
  assert.doesNotMatch(pkillErr.log, /userdel -r ci-run/);

  // Process still alive after SIGKILL -> aborts with reboot guidance before userdel.
  const stuck = recorded(`
    ${baseEnv}
    pgrep() { return 0; }
    do_uninstall
  `);
  assert.notEqual(stuck.status, 0);
  assert.match(stuck.stderr, /reboot/i);
  assert.doesNotMatch(stuck.log, /userdel -r ci-run/);
});

test('uninstall cleanup: resets failed state of ci-* units after daemon-reload (tolerant of unloaded units) and removes /usr/share/docker.io/contrib/docker only if it is a symlink to /usr/bin/docker', { skip: skipDry }, () => {
  const body = sh('declare -f do_uninstall').stdout;
  const bodyOrder = [
    'rm -f "/etc/systemd/system/$u.service" "/etc/systemd/system/$u.timer"',
    'systemctl daemon-reload',
    'systemctl reset-failed ci-egress ci-broker ci-auditd ci-controld ci-watchdog.service ci-watchdog.timer || true',
    'nft delete table inet ci_farm',
    'rm -rf /opt/ci-master',
    '[ -L "$(fr /usr/share/docker.io/contrib/docker)" ] && [ "$(readlink "$(fr /usr/share/docker.io/contrib/docker)")" = /usr/bin/docker ]',
    'rm -f /usr/share/docker.io/contrib/docker',
  ];
  let bAt = 0;
  for (const m of bodyOrder) {
    const i = body.indexOf(m, bAt);
    assert.ok(i >= bAt && i !== -1, `missing or out of order: ${m} in:\n${body}`);
    bAt = i;
  }

  // Tolerant of unloaded units when systemctl reset-failed returns non-zero under the real step() with set -e.
  const unloaded = sh(`
    set -e
    DRY=0 PURGE=0 ASSUME_YES=1
    state_status() { echo complete; }
    unattributed_items() { :; }
    running_job_containers() { echo 0; }
    id() { echo 0; }
    put_file() { cat >/dev/null; }
    sh() { return 0; }
    rm() { return 0; }
    systemctl() { [ "$1" = reset-failed ] && return 1; return 0; }
    do_uninstall
  `);
  assert.equal(unloaded.status, 0, unloaded.stderr);
  assert.match(unloaded.stdout, /uninstalled\./);

  // Control: an unguarded failing step in the same set -e setup really aborts do_uninstall.
  const unguarded = sh(`
    set -e
    DRY=0 PURGE=0 ASSUME_YES=1
    state_status() { echo complete; }
    unattributed_items() { :; }
    running_job_containers() { echo 0; }
    id() { echo 0; }
    put_file() { cat >/dev/null; }
    sh() { return 0; }
    rm() { return 0; }
    systemctl() { [ "$1" = daemon-reload ] && return 1; return 0; }
    do_uninstall
  `);
  assert.notEqual(unguarded.status, 0);
  assert.doesNotMatch(unguarded.stdout, /uninstalled\./);

  // Guard on /usr/share/docker.io/contrib/docker: missing, regular file, symlink to wrong target vs symlink to /usr/bin/docker.
  const runWithContrib = (setup: (contribDir: string) => void) => {
    const fr = mkdtempSync(join(tmpdir(), 'ci-uninst-fr-'));
    const contribDir = join(fr, 'usr/share/docker.io/contrib');
    mkdirSync(contribDir, { recursive: true });
    setup(contribDir);
    const res = recorded(`
      FR=${fr} PURGE=0 ASSUME_YES=1
      state_status() { echo complete; }
      unattributed_items() { :; }
      running_job_containers() { echo 0; }
      id() { echo 0; }
      do_uninstall
    `);
    return { fr, contribDir, res };
  };

  // 1. Missing: not removed.
  const missing = runWithContrib(() => {});
  assert.equal(missing.res.status, 0, missing.res.stderr);
  assert.doesNotMatch(missing.res.log, /\/usr\/share\/docker\.io\/contrib\/docker/);
  rmSync(missing.fr, { recursive: true });

  // 2. Regular file: never deleted.
  const regular = runWithContrib((d) => writeFileSync(join(d, 'docker'), '#!/bin/sh\n', { mode: 0o755 }));
  assert.equal(regular.res.status, 0, regular.res.stderr);
  assert.doesNotMatch(regular.res.log, /\/usr\/share\/docker\.io\/contrib\/docker/);
  assert.equal(statSync(join(regular.contribDir, 'docker')).isFile(), true);
  rmSync(regular.fr, { recursive: true });

  // 3. Symlink to another path: not removed.
  const wrongLink = runWithContrib((d) => symlinkSync('/usr/local/bin/docker', join(d, 'docker')));
  assert.equal(wrongLink.res.status, 0, wrongLink.res.stderr);
  assert.doesNotMatch(wrongLink.res.log, /\/usr\/share\/docker\.io\/contrib\/docker/);
  rmSync(wrongLink.fr, { recursive: true });

  // 4. Symlink to /usr/bin/docker: removed as one step, after unit removal, daemon-reload, and reset-failed.
  const rightLink = runWithContrib((d) => symlinkSync('/usr/bin/docker', join(d, 'docker')));
  assert.equal(rightLink.res.status, 0, rightLink.res.stderr);
  const logOrder = [
    'rm -f /etc/systemd/system/ci-watchdog.service /etc/systemd/system/ci-watchdog.timer',
    'systemctl daemon-reload',
    'systemctl reset-failed ci-egress ci-broker ci-auditd ci-controld ci-watchdog.service ci-watchdog.timer',
    'rm -f /usr/share/docker.io/contrib/docker',
  ];
  let lAt = 0;
  for (const m of logOrder) {
    const i = rightLink.res.log.indexOf(m, lAt);
    assert.ok(i >= lAt && i !== -1, `missing or out of order: ${m} in:\n${rightLink.res.log}`);
    lAt = i;
  }
  assert.equal(rightLink.res.log.split('rm -f /usr/share/docker.io/contrib/docker').length - 1, 1);
  assert.equal(rightLink.res.log.split('systemctl reset-failed ci-egress ci-broker ci-auditd ci-controld ci-watchdog.service ci-watchdog.timer').length - 1, 1);
  rmSync(rightLink.fr, { recursive: true });
});

