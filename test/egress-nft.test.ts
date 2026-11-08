import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs the real rule file in a throw-away user + network namespace (no root needed). Skipped where unshare or nft is unavailable.
const usable = spawnSync('unshare', ['-rn', 'true']).status === 0 && spawnSync('nft', ['--version']).status === 0;
const rules = readFileSync(new URL('../systemd/ci-egress.nft', import.meta.url), 'utf8');

test('the egress rule file is valid nft and refuses every IPv6 connection of the job user at once', { skip: !usable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-nft-'));
  const file = join(dir, 'egress.nft');
  writeFileSync(file, rules.replaceAll('@UID@', '0')); // inside the namespace the test user is uid 0
  const probe = `
import socket, subprocess
s = socket.socket(socket.AF_INET6); s.bind(("::1", 0)); s.listen(1); port = s.getsockname()[1]
def t():
    c = socket.socket(socket.AF_INET6); c.settimeout(3)
    try: c.connect(("::1", port)); return "connected"
    except Exception as e: return type(e).__name__
print("before", t())
subprocess.run(["nft", "-f", "${file}"], check=True)
print("after", t())`;
  const r = spawnSync('unshare', ['-rn', 'bash', '-c', `ip link set lo up && python3 -c '${probe.replaceAll("'", "'\\''")}'`], { encoding: 'utf8' });
  assert.match(r.stdout, /before connected/, r.stderr);
  assert.match(r.stdout, /after PermissionError/, r.stdout + r.stderr); // refused immediately (admin-prohibited), not a timeout
});
