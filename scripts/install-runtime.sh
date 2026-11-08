#!/usr/bin/env bash
# Run as root by the owner. Installs the built code to /opt/ci-master (root-owned), the registry, the socket dir rule and the two systemd services.
# usage: cd <your ci-master checkout> && git show <FULL 40-hex commit>:scripts/install-runtime.sh | sudo CI_SRC=$PWD COMMIT=<FULL 40-hex commit> NODE=<node binary> NODE_SHA256=<its sha256> [RESTART=1] bash
#   CI_SRC, NODE and NODE_SHA256 are remembered in /etc/ci-master/install.conf after the first install; later runs only need COMMIT (and RESTART=1).
#   registry: REGISTRY=<path inside the repo>, default config/registry.example.yaml.  BUILD_IMAGE=1 rebuilds + pins the slot image.   Dry run without root: STAGE_ONLY=1 STAGE_DIR=<new dir> (stages and verifies, installs nothing).
#
# Trust: root never reads the dev-owned checkout as authority. Everything installed is rebuilt from the git objects of the COMMIT you typed:
# commit -> tree -> blobs, each object's SHA-1 recomputed and compared with the id that named it (a tampered or swapped file cannot match).
# zod and yaml come from the npm registry and are checked against the sha512 in the verified package-lock.json. The node binary is copied
# to the staging dir first and its sha256 checked THERE, so nothing can change between the check and the install.
set -euo pipefail
# Settings remembered from a previous install (a root-owned key=value file, read line by line, never sourced). Explicit environment variables win.
CONF=/etc/ci-master/install.conf
if [ -z "${STAGE_ONLY:-}" ] && [ -f "$CONF" ] && [ "$(stat -c %u "$CONF")" = 0 ]; then
  while IFS='=' read -r k v; do case $k in CI_SRC|NODE|NODE_SHA256) [ -n "${!k:-}" ] || export "$k=$v" ;; esac; done < "$CONF"
fi
SRC=${CI_SRC:?set CI_SRC=<path of your ci-master checkout>}
: "${COMMIT:?run as: cd <your checkout> and pipe git show <40-hex commit>:scripts/install-runtime.sh into: sudo CI_SRC=$PWD COMMIT=<40-hex commit> NODE=<node> NODE_SHA256=<sha256> bash}"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "refusing: COMMIT must be the full 40-hex id (a short id can be made ambiguous)" >&2; exit 1; }
NODE=${NODE:?set NODE=<path of the node binary to install, e.g. \$(command -v node)>}
NODE_SHA=${NODE_SHA256:?set NODE_SHA256=<sha256 of that binary: sha256sum it, and compare with the SHASUMS256.txt published on nodejs.org>}

STAGE=${STAGE_DIR:-$(mktemp -d /tmp/ci-stage.XXXXXX)}
mkdir -p "$STAGE"
[ -z "$(ls -A "$STAGE" 2>/dev/null)" ] || { echo "refusing: $STAGE is not empty" >&2; exit 1; }
chmod 0700 "$STAGE"
[ -n "${STAGE_ONLY:-}" ] || trap 'rm -rf "$STAGE"' EXIT
TREE=$STAGE/tree

python3 -I - "$SRC/.git" "$COMMIT" "$TREE" "$STAGE/node_modules" <<'PY'
import base64, hashlib, io, os, re, subprocess, sys, tarfile, urllib.request, json
gitdir, commit, tree_out, nm_out = sys.argv[1:5]
env = {**os.environ, 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_SYSTEM': '/dev/null', 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_NO_LAZY_FETCH': '1', 'GIT_ALLOW_PROTOCOL': '',
       'GIT_CONFIG_COUNT': '2', 'GIT_CONFIG_KEY_0': 'safe.directory', 'GIT_CONFIG_VALUE_0': '*', 'GIT_CONFIG_KEY_1': 'protocol.allow', 'GIT_CONFIG_VALUE_1': 'never'}

def obj(kind, oid):
    data = subprocess.run(['git', '--git-dir', gitdir, 'cat-file', kind, oid], env=env, check=True, capture_output=True).stdout
    if hashlib.sha1(b'%s %d\0' % (kind.encode(), len(data)) + data).hexdigest() != oid:
        sys.exit(f'refusing: {kind} {oid} does not match its own hash')
    return data

def safe_name(n):
    if not n or n in (b'.', b'..') or b'/' in n or b'\0' in n or n.lower() == b'.git':
        sys.exit(f'refusing: unsafe path component {n!r}')
    return n.decode()

def walk(tree_id, dest):
    os.makedirs(dest, mode=0o755, exist_ok=False)
    data, i = obj('tree', tree_id), 0
    while i < len(data):
        sp = data.index(b' ', i); nul = data.index(b'\0', sp)
        mode, name, oid = data[i:sp], safe_name(data[sp + 1:nul]), data[nul + 1:nul + 21].hex()
        i = nul + 21
        path = os.path.join(dest, name)
        if mode == b'40000': walk(oid, path)
        elif mode in (b'100644', b'100755'):
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755 if mode == b'100755' else 0o644)
            with os.fdopen(fd, 'wb') as f: f.write(obj('blob', oid))
        else: sys.exit(f'refusing: {name} has mode {mode!r} (symlinks and submodules are not installed)')

head = obj('commit', commit)
m = re.match(rb'tree ([0-9a-f]{40})\n', head)
if not m: sys.exit('refusing: malformed commit object')
walk(m.group(1).decode(), tree_out)

# Production dependencies only (no dev), straight from the registry, verified against the lockfile's sha512.
lock = json.load(open(os.path.join(tree_out, 'package-lock.json')))
os.makedirs(nm_out, mode=0o755)
for key, pkg in lock['packages'].items():
    if not key.startswith('node_modules/') or key.count('node_modules/') != 1 or pkg.get('dev'): continue
    name = key[len('node_modules/'):]
    url, integ = pkg['resolved'], pkg['integrity']
    if not url.startswith('https://registry.npmjs.org/') or not integ.startswith('sha512-'): sys.exit(f'refusing: {name} has an unexpected source')
    blob = urllib.request.urlopen(url, timeout=60).read()
    if base64.b64encode(hashlib.sha512(blob).digest()).decode() != integ[7:]: sys.exit(f'refusing: {name} does not match the lockfile hash')
    dest = os.path.join(nm_out, name)
    with tarfile.open(fileobj=io.BytesIO(blob)) as t:
        for mem in t.getmembers():
            parts = mem.name.split('/', 1)
            if len(parts) < 2 or not parts[1]: continue
            mem.name = parts[1]
            t.extract(mem, dest, filter='data')
print('staged and verified:', len(os.listdir(os.path.join(tree_out, 'src'))), 'src files; deps:', sorted(os.listdir(nm_out)))
PY

install -m 0755 "$NODE" "$STAGE/node"
[ "$(sha256sum "$STAGE/node" | cut -d' ' -f1)" = "$NODE_SHA" ] || { echo "refusing: node binary hash does not match the pinned one" >&2; exit 1; }
if [ -n "${STAGE_ONLY:-}" ]; then echo "STAGE_ONLY: staged in $STAGE, nothing installed"; exit 0; fi

echo "installing commit ${COMMIT:0:8}"
if [ -n "${REGISTRY:-}" ] || [ ! -f /etc/ci-master/registry.yaml ]; then
  REG=$TREE/${REGISTRY:-config/registry.example.yaml}
  [ -f "$REG" ] || { echo "refusing: registry $REG is not in commit ${COMMIT:0:8}; set REGISTRY=<path inside the repo> (start from config/registry.example.yaml)" >&2; exit 1; }
  chmod o+x "$STAGE" "$TREE"
  chmod -R o+rX "$STAGE/node" "$TREE/package.json" "$TREE/src" "$STAGE/node_modules"
  (cd "$TREE" && runuser -u nobody -- "$STAGE/node" --input-type=module -e \
    "import {loadRegistry} from '$TREE/src/registry.ts'; import {readFileSync} from 'node:fs'; const r = loadRegistry(readFileSync(0, 'utf8')); console.log('registry ok:', r.length, 'project(s)')") <"$REG" \
    || { echo "refusing: registry $REG did not pass the staged registry parser" >&2; exit 1; }
else
  REG=""
fi
install -d -m 0755 /opt/ci-master/bin /opt/ci-master/src /opt/ci-master/scripts /opt/ci-master/dashboard /opt/ci-master/node_modules
install -m 0755 "$STAGE/node" /opt/ci-master/bin/node
rm -f /opt/ci-master/src/*.ts /opt/ci-master/scripts/*.ts /opt/ci-master/dashboard/*
install -m 0644 "$TREE"/src/*.ts /opt/ci-master/src/
install -m 0644 "$TREE"/scripts/*.ts /opt/ci-master/scripts/
install -m 0644 "$TREE"/dashboard/* /opt/ci-master/dashboard/
rm -rf /opt/ci-master/node_modules/zod /opt/ci-master/node_modules/yaml
cp -r "$STAGE/node_modules/zod" "$STAGE/node_modules/yaml" /opt/ci-master/node_modules/
chown -R root:root /opt/ci-master
echo '{"type":"module"}' > /opt/ci-master/package.json
echo "$COMMIT" > /opt/ci-master/.commit   # which commit is installed (informational; shown at the end)
install -d -m 0755 /etc/ci-master
INSTALLED_NODE=/opt/ci-master/bin/node
INSTALLED_NODE_SHA=$(sha256sum "$INSTALLED_NODE" | cut -d' ' -f1)
printf 'CI_SRC=%s\nNODE=%s\nNODE_SHA256=%s\n' "$SRC" "$INSTALLED_NODE" "$INSTALLED_NODE_SHA" > /etc/ci-master/install.conf; chmod 0644 /etc/ci-master/install.conf
# The registry holds no secrets (routing and limits only), so it is world-readable: ci-run needs no membership in ci-control,
# which keeps the socket group (ci-control) limited to the controld user.
if [ -n "$REG" ]; then
  install -m 0644 "$REG" /etc/ci-master/registry.yaml
else
  echo "keeping existing /etc/ci-master/registry.yaml (set REGISTRY=<path inside the repo> to replace it)"
fi
if id -nG ci-run | tr ' ' '\n' | grep -qx ci-control; then gpasswd -d ci-run ci-control; echo 'NOTE: ci-run was in group ci-control; restart the broker'; fi
if id -nG ci-run | tr ' ' '\n' | grep -qx ci-control; then echo 'ERROR: ci-run is still in ci-control' >&2; exit 1; fi
# socket dir: owned by ci-run (creates the socket), group ci-control (may connect); setgid so the socket inherits group ci-control. tmpfiles keeps it across reboots.
echo 'd /run/ci-master 2750 ci-run ci-control -' > /etc/tmpfiles.d/ci-master.conf
systemd-tmpfiles --create /etc/tmpfiles.d/ci-master.conf
# audit receiver: its own user, a data dir only it can use, and an append-only file (chattr +a) so it cannot be rewritten or truncated without root
id ci-audit >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/ci-audit --no-create-home --shell /usr/sbin/nologin ci-audit
install -d -m 0700 -o ci-audit -g ci-audit /var/lib/ci-audit
[ -e /var/lib/ci-audit/audit.jsonl ] || install -m 0600 -o ci-audit -g ci-audit /dev/null /var/lib/ci-audit/audit.jsonl
chattr +a /var/lib/ci-audit/audit.jsonl || { echo "ERROR: this filesystem does not support append-only files (chattr +a); the audit receiver needs it" >&2; exit 1; }
echo 'd /run/ci-audit 2750 ci-audit ci-control -' > /etc/tmpfiles.d/ci-audit.conf
systemd-tmpfiles --create /etc/tmpfiles.d/ci-audit.conf
# watchdog: state dir owned by root; the requests dir is root-owned too (0730: ci-control may only CREATE files in it, never replace the dir)
install -d -m 0755 -o root -g root /var/lib/ci-watchdog
install -d -m 0730 -o root -g ci-control /var/lib/ci-watchdog/requests
# systemd services (enabled at boot; restarting them is up to you, see the last line)
[ -e /var/lib/systemd/linger/ci-run ] || { echo "ERROR: lingering is not enabled for ci-run (loginctl enable-linger ci-run)" >&2; exit 1; }
UID_RUN=$(id -u ci-run)
# ci-run's rootless Docker must start at boot (lingering starts the user manager; this makes the daemon part of it) and run now. Idempotent.
runuser -u ci-run -- env XDG_RUNTIME_DIR=/run/user/$UID_RUN systemctl --user enable --now docker.service >/dev/null \
  || { echo "ERROR: could not enable ci-run's rootless docker.service (is the user manager running? loginctl enable-linger ci-run)" >&2; exit 1; }
sed "s/@UID@/$UID_RUN/g" "$TREE/systemd/ci-egress.nft" > "$STAGE/egress.nft"
/usr/sbin/nft -c -f "$STAGE/egress.nft"   # syntax check BEFORE the live file is replaced, so a bad rule can never be what the next boot loads
install -m 0644 "$STAGE/egress.nft" /etc/ci-master/egress.nft
for u in ci-egress ci-broker ci-auditd ci-controld; do
  sed "s/@UID@/$UID_RUN/g" "$TREE/systemd/$u.service" > "/etc/systemd/system/$u.service"
  chmod 0644 "/etc/systemd/system/$u.service"
done
install -m 0644 "$TREE/systemd/ci-watchdog.service" /etc/systemd/system/ci-watchdog.service
install -m 0644 "$TREE/systemd/ci-watchdog.timer" /etc/systemd/system/ci-watchdog.timer
# BUILD_IMAGE=1: build the slot image from the VERIFIED tree (not the dev checkout), as ci-run, and pin its content hash for the broker.
if [ -n "${BUILD_IMAGE:-}" ]; then
  B=$(mktemp -d /tmp/ci-image.XXXXXX); trap 'rm -rf "$STAGE" "$B"' EXIT
  cp -r "$TREE/image/." "$B/"; chown -R ci-run:ci-run "$B"
  DENV=(env "XDG_RUNTIME_DIR=/run/user/$UID_RUN" "DOCKER_HOST=unix:///run/user/$UID_RUN/docker.sock")
  runuser -u ci-run -- "${DENV[@]}" docker build -t ci-master/slot:dev "$B"
  IMG=$(runuser -u ci-run -- "${DENV[@]}" docker image inspect --format '{{.Id}}' ci-master/slot:dev)
  [[ "$IMG" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "ERROR: unexpected image id: $IMG" >&2; exit 1; }
  echo "CI_SLOT_IMAGE=$IMG" > /etc/ci-master/slot-image.env; chmod 0644 /etc/ci-master/slot-image.env
  echo "slot image built and pinned: $IMG"
fi
systemctl daemon-reload
systemctl enable ci-egress.service ci-broker.service ci-auditd.service ci-controld.service >/dev/null
if [ "${NO_WATCHDOG_START:-}" = 1 ]; then
  systemctl enable ci-watchdog.timer >/dev/null
else
  systemctl enable --now ci-watchdog.timer >/dev/null
fi
echo "installed commit ${COMMIT:0:12}. registry: $(grep -c '^- name' /etc/ci-master/registry.yaml) project(s); socket dir: $(ls -ld /run/ci-master | cut -d' ' -f1,3,4)"
if [ -n "${RESTART:-}" ]; then
  # one-shot mode: restart in boot order, then check everything. usage: ... | sudo COMMIT=<sha> RESTART=1 bash
  systemctl restart ci-egress ci-broker ci-auditd ci-controld
  sleep 8
  bad=0; for u in ci-egress ci-broker ci-auditd ci-controld ci-watchdog.timer; do st=$(systemctl is-active $u || true); echo "$u: $st"; [ "$st" = active ] || bad=1; done
  echo "controller health: $(curl -s -m 5 http://127.0.0.1:8787/v1/health || echo unreachable)"
  [ $bad = 0 ] && echo "ALL GOOD" || { echo "SOMETHING IS NOT ACTIVE: see journalctl -b -u <unit> -n 30" >&2; exit 1; }
elif [ -z "${NO_WATCHDOG_START:-}" ]; then
  echo "to run the new code: sudo systemctl restart ci-egress ci-broker ci-auditd ci-controld   (or rerun this installer with RESTART=1)"
fi
