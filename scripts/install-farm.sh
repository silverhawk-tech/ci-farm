#!/usr/bin/env bash
# One-click installer for a ci-master CI farm on a clean Ubuntu machine (installer 1, see docs/INSTALLER-DESIGN.md). Run as root by the owner.
#   cd <your clone of ci-master>
#   git show <FULL 40-hex commit>:scripts/install-farm.sh | CI_SRC=$PWD COMMIT=<FULL 40-hex commit> bash -s -- --dry-run     # no root, no changes
#   git show <FULL 40-hex commit>:scripts/install-farm.sh | sudo CI_SRC=$PWD COMMIT=<FULL 40-hex commit> bash                   # the real run
#   git show <FULL 40-hex commit>:scripts/install-farm.sh | sudo CI_SRC=$PWD COMMIT=<FULL 40-hex commit> bash -s -- --uninstall [--purge]
# Optional answers as environment variables (otherwise asked on the terminal): REPO=<owner/name> APP_ID INSTALLATION_ID KEY=<path of the App .pem> ASSUME_YES=1
#
# Trust: root never reads the dev-owned checkout as authority. The commit you typed is rebuilt from its git objects with every SHA-1 recomputed
# (commit -> tree -> blobs); the two existing scripts (setup-control-user.sh, install-runtime.sh) are then run FROM THAT VERIFIED COPY, and
# install-runtime.sh verifies and installs the rest (npm packages against package-lock sha512, the pinned Node binary by sha256).
# The script itself is only as trustworthy as the `git show` you ran before sudo: read it at that commit first.
#
# Everything below is function definitions; the only command that runs is the last line. That matters because this file is read from stdin
# when piped: nothing a child process does to stdin can swallow part of the script.

PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
set -euo pipefail

# ---- pinned inputs (change them deliberately, in a reviewed commit) -------------------------------------------------------------------------
NODE_VERSION=v22.23.4
# sha256 of node-v22.23.4-linux-x64.tar.xz, copied from https://nodejs.org/dist/v22.23.4/SHASUMS256.txt. Compare it yourself before you trust it.
NODE_TARBALL_SHA256=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
MIN_RAM_GIB=8
MIN_CPUS=4
MIN_FREE_GIB=30
API_PORT=8787
UNITS=(ci-egress.service ci-broker.service ci-auditd.service ci-controld.service ci-watchdog.timer)
PACKAGES=(docker.io rootlesskit slirp4netns uidmap dbus-user-session nftables xz-utils curl ca-certificates git python3)
STATE_DIR=/var/lib/ci-master-installer
LOG_FILE=/var/log/ci-master-install.log

DRY=0
MODE=install
PURGE=0
FR=""                 # fake root for read-only probes; only ever set together with --dry-run (tests)
STAGE=""
FAILS=()
UNITS_INSTALLED=0
PHASE_DONE=0
STATUS=incomplete     # what the state file will say at exit (incomplete | complete | uninstalled)
EVIDENCE_OK=0         # set once this run is allowed to record evidence (after the attribution gate)
PROBE_DIR=/var/lib    # where the chattr probe goes (tests point it elsewhere after sourcing; never read from the environment)

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'refusing: %s\n' "$*" >&2; exit 1; }
fail() { FAILS+=("$*"); }
fr()   { printf '%s%s' "$FR" "$1"; }

# ---- pure helpers (unit-tested) -------------------------------------------------------------------------------------------------------------
valid_commit()  { [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]]; }
valid_repo()    { [[ "${1:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] && [[ "${1#*/}" != "." && "${1#*/}" != ".." && "${1%%/*}" != "." && "${1%%/*}" != ".." ]]; }
valid_number()  { [[ "${1:-}" =~ ^[0-9]{1,15}$ ]]; }

# ver_ge A B: "24.04" >= "24.04" (numeric major.minor compare)
ver_ge() {
  local a=${1:-} b=${2:-}
  [[ "$a" =~ ^[0-9]+(\.[0-9]+)?$ && "$b" =~ ^[0-9]+(\.[0-9]+)?$ ]] || return 1
  local am=${a%%.*} an=0 bm=${b%%.*} bn=0
  [[ "$a" == *.* ]] && an=${a#*.}
  [[ "$b" == *.* ]] && bn=${b#*.}
  (( 10#$am > 10#$bm || (10#$am == 10#$bm && 10#$an >= 10#$bn) ))
}

# distro_supported ID VERSION_ID: Ubuntu 24.04 or newer only (the only combination the spike and the pinned slot image were tested on).
distro_supported() { [ "${1:-}" = ubuntu ] && ver_ge "${2:-}" 24.04; }

# meminfo_gib FILE: MemTotal in GiB, rounded to the nearest (an "8 GB" machine reports about 7.7 GiB)
meminfo_gib() { awk '/^MemTotal:/ { print int(($2 + 524288) / 1048576); found = 1 } END { if (!found) print 0 }' "$1"; }

# Filesystems that accept chattr +a. Anything else (overlayfs, tmpfs, zfs, nfs, ...) is refused.
fs_supports_append_only() { case "${1:-}" in ext2/ext3|ext4|xfs|btrfs) return 0 ;; *) return 1 ;; esac; }

# project_name_from_repo owner/Some_Repo.name -> some-repo-name (must satisfy the registry's name pattern)
project_name_from_repo() {
  local n=${1#*/}
  n=$(printf '%s' "$n" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n-' '-' | sed -E 's/-+/-/g; s/^-+//; s/-+$//')
  n=${n:0:31}; n=${n%-}
  [[ "$n" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || return 1
  printf '%s\n' "$n"
}

# new_label: ci-farm-<8 random hex>; a routing selector, not a secret.
new_label() { printf 'ci-farm-%s\n' "$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"; }

# render_registry NAME REPO LABEL: the one-project registry. Inputs are re-validated here so a bad value can never reach the YAML.
render_registry() {
  local name=$1 repo=$2 label=$3
  [[ "$name" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || return 1
  valid_repo "$repo" || return 1
  [[ "$label" =~ ^ci-[a-z0-9-]{4,40}$ ]] || return 1
  cat <<EOF
# Written by scripts/install-farm.sh. No secrets here, only routing and limits. Add more projects by editing this file (see config/registry.example.yaml).
- name: $name
  repo: $repo
  labels: [self-hosted, linux]
  max_slots: 1
  allowed_events: [pull_request]
  runner_scope: repo
  runner_group_id: 1
  unique_label: $label
  rerun_allowed_workflows: []
  lanes:
    tests: self-hosted
  resources: { memory: 6g, cpus: 3, pids: 4096 }
EOF
}

# ---- execution wrappers (tests replace these) -----------------------------------------------------------------------------------------------
# step DESCRIPTION CMD ARGS...: run a mutating command, or only print it in --dry-run.
step() {
  local desc=$1; shift
  if [ "$DRY" = 1 ]; then
    printf 'would: %s\n' "$desc"; printf '   $'; printf ' %q' "$@"; printf '\n'
  else
    printf '==> %s\n' "$desc"
    "$@"
  fi
}
# put_file MODE OWNER:GROUP PATH < content: write a file atomically with the right mode, or only say so in --dry-run.
put_file() {
  local mode=$1 owner=$2 path=$3
  if [ "$DRY" = 1 ]; then
    printf 'would: write %s (%s %s)\n' "$path" "$mode" "$owner"; cat >/dev/null
  else
    local tmp; tmp=$(mktemp "$path.XXXXXX")
    cat >"$tmp"; chmod "$mode" "$tmp"; chown "$owner" "$tmp"; mv -f "$tmp" "$path"
  fi
}

# ---- read-only probes (honour the fake root in --dry-run tests) -----------------------------------------------------------------------------
# os_field ID: value of a KEY=value line of os-release, quotes stripped (parsed, never sourced)
os_field() { sed -n "s/^$1=//p" "$(fr /etc/os-release)" 2>/dev/null | head -1 | tr -d "\"'"; }
user_exists() { grep -q "^$1:" "$(fr /etc/passwd)" 2>/dev/null; }
unit_active() {
  if [ -n "$FR" ]; then [ -e "$FR/run/fake-active/$1" ]; else systemctl is-active --quiet "$1" 2>/dev/null; fi
}
unit_enabled() {
  if [ -n "$FR" ]; then [ -e "$FR/run/fake-enabled/$1" ]; else systemctl is-enabled --quiet "$1" 2>/dev/null; fi
}
cgroup_fstype() { if [ -n "$FR" ]; then cat "$FR/sys/fs/cgroup/.fstype" 2>/dev/null || true; else stat -fc %T /sys/fs/cgroup 2>/dev/null || true; fi; }
var_lib_fstype() { if [ -n "$FR" ]; then cat "$FR/var/lib/.fstype" 2>/dev/null || true; else stat -fc %T /var/lib 2>/dev/null || true; fi; }
free_gib_var_lib() {
  if [ -n "$FR" ]; then echo $(( $(cat "$FR/var/lib/.avail_kb" 2>/dev/null || echo 0) / 1048576 ))
  else echo $(( $(df -Pk /var/lib | awk 'NR==2 { print $4 }') / 1048576 )); fi
}
cpu_count() { if [ -n "$FR" ]; then cat "$FR/proc/nproc" 2>/dev/null || echo 0; else nproc; fi; }
port_in_use() {
  if [ -n "$FR" ]; then [ -e "$FR/run/fake-port-$1" ]; else [ -n "$(ss -ltnH "sport = :$1" 2>/dev/null)" ]; fi
}
running_job_containers() {
  if [ -n "$FR" ]; then cat "$FR/run/fake-containers" 2>/dev/null || echo 0; return; fi
  user_exists ci-run || { echo 0; return; }
  local u; u=$(id -u ci-run)
  [ -S "/run/user/$u/docker.sock" ] || { echo 0; return; }
  runuser -u ci-run -- env "DOCKER_HOST=unix:///run/user/$u/docker.sock" docker ps -q 2>/dev/null | wc -l
}
state_status() { grep -s '^status=' "$(fr "$STATE_DIR/state")" | tail -1 | cut -d= -f2 || true; }
# state_get KEY: value of an exact KEY=value line of the state file (keys contain dots and slashes, so no regex)
state_get() { awk -v k="$1" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { print v }' "$(fr "$STATE_DIR/state")" 2>/dev/null; }
user_uid()  { awk -F: -v u="$1" '$1 == u { print $3 }' "$(fr /etc/passwd)" 2>/dev/null | head -1; }
owner_uid() { stat -c %u "$(fr "$1")" 2>/dev/null; }
sha_of()    { sha256sum "$(fr "$1")" 2>/dev/null | cut -d' ' -f1; }
opt_commit() { cat "$(fr /opt/ci-master/.commit)" 2>/dev/null || echo none; }
# machine_tag: ties a state file to the machine it was written on, so a state file copied from another machine proves nothing here.
# Prints NOTHING when /etc/machine-id is missing or empty; callers treat an empty tag as "cannot attribute" (never as a match), and a real
# install refuses to start without a machine id, so it cannot create a state file that could not be checked later.
machine_tag() {
  local id; id=$(cat "$(fr /etc/machine-id)" 2>/dev/null || true)
  [ -n "$id" ] || return 0
  printf 'ci-master-installer:%s' "$id" | sha256sum | cut -d' ' -f1
}

# item_attributed ITEM: does the state file's EVIDENCE match the live item? The status word is never trusted on its own: the file must carry this
# machine's tag and, per part, the uid / commit / hash / owner recorded when the part was created. Checked: machine tag, user uids, the installed commit
# (/opt/ci-master/.commit), unit and tmpfiles sha256, data-dir owners. NOT checked (informational only): the commit= and repo= lines. The file is
# root-owned, so this defends against a stale or COPIED file (another machine, an older install), not against someone who can already write as root.
item_attributed() {
  local it=$1 rec
  local tag; tag=$(machine_tag)
  { [ -n "$tag" ] && [ "$(state_get machine)" = "$tag" ]; } || return 1
  case $it in
    "user "*)         rec=$(state_get "user.${it#user }"); [ -n "$rec" ] && [ "$rec" = "$(user_uid "${it#user }")" ] ;;
    /opt/ci-master)   rec=$(state_get opt.commit); [ -n "$rec" ] && [ "$rec" = "$(opt_commit)" ] ;;
    /etc/ci-master|/var/lib/ci-watchdog) item_attributed /opt/ci-master ;;   # created by install-runtime.sh in the same run as /opt/ci-master
    /var/lib/ci-control|/var/lib/ci-audit) rec=$(state_get "dir.$it"); [ -n "$rec" ] && [ "$rec" = "$(owner_uid "$it")" ] ;;
    "nft table"*)     [ -n "$(state_get "file./etc/systemd/system/ci-egress.service")" ] && item_attributed /etc/systemd/system/ci-egress.service ;;
    /etc/systemd/system/*|/etc/tmpfiles.d/*) rec=$(state_get "file.$it"); [ -n "$rec" ] && [ "$rec" = "$(sha_of "$it")" ] ;;
    *) return 1 ;;
  esac
}
# unattributed_items: every existing farm part the evidence does not account for, comma separated
unattributed_items() {
  local it out=""
  while IFS= read -r it; do
    [ -n "$it" ] || continue
    item_attributed "$it" || out+="$it, "
  done < <(existing_install_items)
  printf '%s' "${out%, }"
}
# record_evidence: rewrite the state file from the LIVE machine. Called at exit of every run that passed its attribution gate, so everything present
# now was either accounted for at the start of this run or created by it.
record_evidence() {
  if [ "$DRY" = 1 ]; then say "would: record status=$STATUS and evidence (user ids, file hashes, installed commit) in $STATE_DIR/state"; return 0; fi
  local it
  {
    printf 'status=%s\nmachine=%s\ncommit=%s\nrepo=%s\n' "$STATUS" "$(machine_tag)" "${COMMIT:-}" "${REPO:-}"   # commit/repo: informational, never checked
    while IFS= read -r it; do
      case $it in
        "user "*) printf 'user.%s=%s\n' "${it#user }" "$(user_uid "${it#user }")" ;;
        /opt/ci-master) printf 'opt.commit=%s\n' "$(opt_commit)" ;;
        /var/lib/ci-control|/var/lib/ci-audit) printf 'dir.%s=%s\n' "$it" "$(owner_uid "$it")" ;;
        /etc/systemd/system/*|/etc/tmpfiles.d/*) printf 'file.%s=%s\n' "$it" "$(sha_of "$it")" ;;
        *) : ;;
      esac
    done < <(existing_install_items)
  } | put_file 0644 root:root "$STATE_DIR/state"
}

existing_install_items() {
  local p u
  for p in /opt/ci-master /etc/ci-master /var/lib/ci-control /var/lib/ci-audit /var/lib/ci-watchdog /etc/tmpfiles.d/ci-master.conf /etc/tmpfiles.d/ci-audit.conf; do
    [ -e "$(fr "$p")" ] && printf '%s\n' "$p"
  done
  for u in ci-egress ci-broker ci-auditd ci-controld ci-watchdog; do
    for p in "/etc/systemd/system/$u.service" "/etc/systemd/system/$u.timer"; do [ -e "$(fr "$p")" ] && printf '%s\n' "$p"; done
  done
  for u in ci-run ci-control ci-audit; do user_exists "$u" && printf 'user %s\n' "$u"; done
  if [ -z "$FR" ] && command -v nft >/dev/null 2>&1 && nft list table inet ci_farm >/dev/null 2>&1; then echo 'nft table inet ci_farm'; fi
  [ -n "$FR" ] && [ -e "$FR/run/fake-nft-table" ] && echo 'nft table inet ci_farm'
  true
}

# ---- preflight: read-only, collects every reason before it refuses --------------------------------------------------------------------------
preflight() {
  say "preflight (read-only):"
  [ "$(uname -m)" = x86_64 ] || [ -n "$FR" ] || fail "CPU is $(uname -m); only x86_64 is supported (the pinned slot image runner is x86_64)"
  if [ "$DRY" = 0 ] && [ "$(id -u)" != 0 ]; then fail "not root: run through sudo"; fi

  local id ver
  id=$(os_field ID); ver=$(os_field VERSION_ID)
  distro_supported "$id" "$ver" || fail "unsupported distribution '${id:-unknown} ${ver:-}': only Ubuntu 24.04 or newer is validated"
  [ -d "$(fr /run/systemd/system)" ] || fail "systemd is not the running init system"
  [ "$(cgroup_fstype)" = cgroup2fs ] || fail "cgroup v2 is required (found '$(cgroup_fstype)')"
  [ -n "$(machine_tag)" ] || fail "/etc/machine-id is missing or empty (systemd creates it; the installer's records are tied to it)"
  [ "$(cat "$(fr /proc/sys/user/max_user_namespaces)" 2>/dev/null || echo 0)" -gt 0 ] || fail "unprivileged user namespaces are disabled (max_user_namespaces)"
  grep -qF '127.0.0.53' "$(fr /etc/resolv.conf)" 2>/dev/null || fail "/etc/resolv.conf does not use the systemd-resolved stub 127.0.0.53: the egress filter blocks LAN DNS servers, so jobs would have no DNS"

  local ram; ram=$(meminfo_gib "$(fr /proc/meminfo)")
  [ "$ram" -ge "$MIN_RAM_GIB" ] || fail "RAM is ${ram} GiB; at least ${MIN_RAM_GIB} GiB needed (a slot is capped at 6 GiB)"
  local cpus; cpus=$(cpu_count)
  [ "$cpus" -ge "$MIN_CPUS" ] || fail "${cpus} CPU(s); at least ${MIN_CPUS} needed (a slot is limited to 3 CPUs)"
  local free; free=$(free_gib_var_lib)
  [ "$free" -ge "$MIN_FREE_GIB" ] || fail "${free} GiB free in /var/lib; at least ${MIN_FREE_GIB} GiB needed (slot image and each slot's inner Docker data)"
  fs_supports_append_only "$(var_lib_fstype)" || fail "/var/lib is on '$(var_lib_fstype)', which cannot do chattr +a (the audit receiver needs an append-only file)"
  port_in_use "$API_PORT" && fail "port $API_PORT on loopback is already in use (the controller needs it)"

  # Existing install / busy farm. A half-finished or uninstalled earlier run of THIS installer may be continued, but only over parts it can prove are its own.
  local st items; st=$(state_status); items=$(existing_install_items)
  if [ -n "$items" ]; then
    if [ "$st" != incomplete ] && [ "$st" != uninstalled ]; then
      fail "ci-master is already installed here (found: $(printf '%s' "$items" | tr '\n' ' ')). Update with scripts/install-runtime.sh; this installer is for clean machines"
    else
      # A resume is allowed only for parts that the state file's evidence matches against the live machine; the status word alone proves nothing.
      local foreign; foreign=$(unattributed_items)
      [ -z "$foreign" ] || fail "existing parts that this installer's records do not account for (stale, copied or forged state file, or edited since): $foreign. They are not touched"
    fi
  fi
  if [ "$MODE" = install ]; then
    local u
    for u in "${UNITS[@]}"; do unit_active "$u" && fail "$u is running: the farm is live; stop it deliberately first"; done
    local n; n=$(running_job_containers)
    [ "$n" -eq 0 ] || fail "the farm is busy: $n job container(s) running in ci-run's Docker"
  fi
  # Checked live on EVERY run, resumed or not: no stored marker may override it, because the install step switches this daemon off.
  if unit_active docker.service || unit_active docker.socket || unit_enabled docker.service || unit_enabled docker.socket; then
    fail "the root Docker daemon is active or enabled; the farm needs it off, and this installer will not switch off a daemon something else may use. If nothing else uses it (e.g. an earlier run of this installer stopped between installing docker.io and switching it off), run: systemctl disable --now docker.service docker.socket"
  fi

  # Inputs
  valid_commit "${COMMIT:-}" || fail "COMMIT must be the full 40-hex commit id (a short id can be made ambiguous)"
  if [ -n "${CI_SRC:-}" ]; then
    { [ -d "$CI_SRC/.git" ] && [ ! -L "$CI_SRC" ]; } || fail "CI_SRC=$CI_SRC is not a git checkout (a .git directory is needed; symlinks are refused)"
    valid_commit "${COMMIT:-}" && [ -d "$CI_SRC/.git" ] && { GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL='' GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*' GIT_CONFIG_KEY_1=protocol.allow GIT_CONFIG_VALUE_1=never git --git-dir "$CI_SRC/.git" cat-file -e "$COMMIT^{commit}" 2>/dev/null || fail "commit ${COMMIT:0:12} is not in $CI_SRC/.git (git fetch it first)"; }
  else
    fail "set CI_SRC=<path of your ci-master clone>"
  fi
  command -v git >/dev/null 2>&1 || fail "git is missing"
  python3_ok || fail "python3 >= 3.12 is required (the tarfile 'data' filter used by install-runtime.sh)"
  local miss=()
  command -v xz >/dev/null 2>&1 || miss+=("xz-utils (xz)")
  command -v curl >/dev/null 2>&1 || miss+=("curl")
  if [ -n "$FR" ]; then
    [ ! -e "$FR/run/fake-no-ca-certs" ] || miss+=("ca-certificates")
  else
    [ -s /etc/ssl/certs/ca-certificates.crt ] || miss+=("ca-certificates")
  fi
  if [ "${#miss[@]}" -gt 0 ]; then
    say "  missing download prerequisite(s): ${miss[*]} (the real run installs xz-utils curl ca-certificates before fetch_node)"
  fi
  if [ "$DRY" = 0 ] && [ "$MODE" = install ]; then
    if [ "${#miss[@]}" -eq 0 ]; then
      local h
      for h in github.com registry.npmjs.org nodejs.org; do
        curl -fsS -m 15 -o /dev/null --proto '=https' "https://$h/" 2>/dev/null || fail "cannot reach https://$h/"
      done
    fi
    { : </dev/tty; } 2>/dev/null || fail "no terminal: the second-factor secret and your dashboard token are shown once, on the terminal only"
  fi
}

# The one real test of chattr +a. It writes (a probe file), so it is NOT part of the read-only preflight: it runs after the confirmation, before any
# other change, and on_exit removes exactly this file on every exit path (success, failure, signal).
PROBE=""
append_only_probe() {
  if [ "$DRY" = 1 ]; then say "would: test chattr +a on a temporary probe file under /var/lib (removed again at once, also on failure or a signal)"; return 0; fi
  PROBE=$(mktemp "$PROBE_DIR/.ci-append-probe.XXXXXX")
  chattr +a "$PROBE" 2>/dev/null || die "chattr +a does not work under $PROBE_DIR (the audit receiver needs an append-only file)"
  chattr -a "$PROBE"; rm -f "$PROBE"; PROBE=""
}

# After the apt step: things that can only be checked once the packages are there.
post_package_checks() {
  [ -x /usr/sbin/nft ] || die "/usr/sbin/nft is missing after installing nftables"
  [ -x /usr/share/docker.io/contrib/dockerd-rootless-setuptool.sh ] || die "dockerd-rootless-setuptool.sh not found under /usr/share/docker.io/contrib (docker.io package layout changed?)"
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
    grep -rqs rootlesskit /etc/apparmor.d/ || die "AppArmor restricts unprivileged user namespaces and no rootlesskit profile is installed in /etc/apparmor.d"
  fi
}

# ---- answers ---------------------------------------------------------------------------------------------------------------------------------
ask() { # ask VAR "question" validator
  local var=$1 q=$2 check=$3 val=${!1:-}
  if [ -z "$val" ]; then
    if [ "$DRY" = 1 ]; then return 0; fi
    [ -r /dev/tty ] || die "$var is not set and there is no terminal to ask on"
    printf '%s ' "$q" >/dev/tty; IFS= read -r val </dev/tty
  fi
  "$check" "$val" || die "invalid $var"
  printf -v "$var" '%s' "$val"
}
python3_ok() { command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; sys.exit(sys.version_info < (3, 12))' 2>/dev/null; }
valid_key_file() { [[ "$1" != *[[:cntrl:]]* ]] && [ -f "$1" ] && [ ! -L "$1" ] && grep -q -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' "$1" 2>/dev/null; }
# redact_key: log filter. Whatever a child prints, the key's path never reaches the log (literal match, not a regex).
redact_key() { K="${KEY:-}" awk 'BEGIN { k = ENVIRON["K"] } { if (k != "") { while ((i = index($0, k)) > 0) $0 = substr($0, 1, i - 1) "<key path>" substr($0, i + length(k)) } print }'; }

collect_answers() {
  ask REPO "GitHub repository to serve (owner/name, PRIVATE):" valid_repo
  ask APP_ID "GitHub App id (digits):" valid_number
  ask INSTALLATION_ID "Installation id (digits):" valid_number
  ask KEY "Path of the downloaded GitHub App .pem (only the path is typed; the key is read once):" valid_key_file
  if [ "$DRY" = 1 ]; then
    : "${REPO:=<owner/name>}"; : "${APP_ID:=<app id>}"; : "${INSTALLATION_ID:=<installation id>}"; : "${KEY:=<path of the .pem>}"
  fi
  say ""
  say "About to install ci-master commit ${COMMIT:0:12} for repository ${REPO}."
  say "It will install packages, create users ci-run/ci-control/ci-audit, enable system services and build the slot image (several minutes)."
  if [ "$DRY" = 0 ] && [ "${ASSUME_YES:-}" != 1 ]; then
    local a; printf "Type 'install' to continue: " >/dev/tty; IFS= read -r a </dev/tty
    [ "$a" = install ] || die "not confirmed"
  fi
}

# ---- verified staging ------------------------------------------------------------------------------------------------------------------------
# vextract GITDIR COMMIT OUT PATH...: rebuild the named paths ('.' = everything) from git objects, recomputing every SHA-1 on the way.
vextract() {
  python3 -I - "$@" <<'PY'
import hashlib, os, subprocess, sys, re
gitdir, commit, out, *wants = sys.argv[1:]
env = {**os.environ, 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_SYSTEM': '/dev/null', 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_NO_LAZY_FETCH': '1', 'GIT_ALLOW_PROTOCOL': '',
       'GIT_CONFIG_COUNT': '2', 'GIT_CONFIG_KEY_0': 'safe.directory', 'GIT_CONFIG_VALUE_0': '*', 'GIT_CONFIG_KEY_1': 'protocol.allow', 'GIT_CONFIG_VALUE_1': 'never'}
def obj(kind, oid):
    data = subprocess.run(['git', '--git-dir', gitdir, 'cat-file', kind, oid], env=env, check=True, capture_output=True).stdout
    if hashlib.sha1(b'%s %d\0' % (kind.encode(), len(data)) + data).hexdigest() != oid:
        sys.exit(f'refusing: {kind} {oid} does not match its own hash')
    return data
def safe(n):
    if not n or n in (b'.', b'..') or b'/' in n or b'\0' in n or n.lower() == b'.git':
        sys.exit(f'refusing: unsafe path component {n!r}')
    return n.decode()
everything = '.' in wants
def inside(rel): return everything or any(rel == w or rel.startswith(w + '/') for w in wants)
def above(rel): return any(w.startswith(rel + '/') for w in wants)
def walk(tree, dest, prefix):
    os.makedirs(dest, mode=0o755, exist_ok=True)
    data, i = obj('tree', tree), 0
    while i < len(data):
        sp = data.index(b' ', i); nul = data.index(b'\0', sp)
        mode, name, oid = data[i:sp], safe(data[sp + 1:nul]), data[nul + 1:nul + 21].hex()
        i = nul + 21
        rel = prefix + name
        path = os.path.join(dest, name)
        if mode == b'40000':
            if inside(rel) or above(rel): walk(oid, path, rel + '/')
        elif mode in (b'100644', b'100755'):
            if inside(rel):
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755 if mode == b'100755' else 0o644)
                with os.fdopen(fd, 'wb') as f: f.write(obj('blob', oid))
        elif inside(rel):
            sys.exit(f'refusing: {rel} has mode {mode!r} (symlinks and submodules are not installed)')
head = obj('commit', commit)
m = re.match(rb'tree ([0-9a-f]{40})\n', head)
if not m: sys.exit('refusing: malformed commit object')
walk(m.group(1).decode(), out, '')
for w in wants:
    if w != '.' and not os.path.exists(os.path.join(out, w)): sys.exit(f'refusing: {w} is not in commit {commit[:12]}')
PY
}

stage_tree() {
  if [ "$DRY" = 1 ]; then
    vextract "$CI_SRC/.git" "$COMMIT" "$STAGE/tree" .
    say "commit ${COMMIT:0:12} verified object by object into $STAGE/tree ($(find "$STAGE/tree" -type f | wc -l) files)"
  else
    vextract "$CI_SRC/.git" "$COMMIT" "$STAGE/tree" scripts/install-runtime.sh scripts/setup-control-user.sh config/registry.example.yaml
    say "installer scripts for ${COMMIT:0:12} verified object by object"
  fi
  local f
  for f in scripts/install-runtime.sh scripts/setup-control-user.sh config/registry.example.yaml; do [ -f "$STAGE/tree/$f" ] || die "$f is not in commit ${COMMIT:0:12}"; done
}

NODE_SHA256_OUT=""
fetch_node() {
  local url="https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
  if [ "$DRY" = 1 ]; then
    say "would: download $url, require sha256 $NODE_TARBALL_SHA256, extract bin/node, pass its own sha256 on to install-runtime.sh"
    NODE_SHA256_OUT="<sha256 of the extracted node binary>"; return 0
  fi
  say "==> downloading Node $NODE_VERSION"
  { command -v curl >/dev/null 2>&1 && command -v xz >/dev/null 2>&1; } || die "curl and xz are required to download and extract Node"
  curl -fsSL --proto '=https' --tlsv1.2 -m 300 -o "$STAGE/node.tar.xz" "$url"
  [ "$(sha256sum "$STAGE/node.tar.xz" | cut -d' ' -f1)" = "$NODE_TARBALL_SHA256" ] || die "the Node tarball does not match the pinned sha256"
  tar -xJf "$STAGE/node.tar.xz" -C "$STAGE" --strip-components=2 "node-$NODE_VERSION-linux-x64/bin/node"
  rm -f "$STAGE/node.tar.xz"
  chmod 0755 "$STAGE/node"
  NODE_SHA256_OUT=$(sha256sum "$STAGE/node" | cut -d' ' -f1)
}

# ---- host preparation (all mutations go through step/put_file) ------------------------------------------------------------------------------
write_state() { STATUS=$1; EVIDENCE_OK=1; record_evidence; }

install_prereqs() {
  step "refresh apt package lists" apt-get update
  step "install download prerequisites (xz-utils curl ca-certificates)" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xz-utils curl ca-certificates
}

install_packages() {
  step "refresh apt package lists" apt-get update
  step "install packages (${PACKAGES[*]})" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${PACKAGES[@]}"
  # The package enables the ROOT daemon; the farm uses ci-run's rootless daemon only (preflight proved nothing else used the root one).
  step "switch the root Docker daemon off" systemctl disable --now docker.service docker.socket
}

create_run_user() {
  if user_exists ci-run; then say "ci-run exists"; else
    step "create user ci-run (normal user, so it gets a subuid/subgid range)" useradd --create-home --shell /usr/sbin/nologin ci-run
  fi
  if [ "$DRY" = 0 ]; then
    { grep -q '^ci-run:' /etc/subuid && grep -q '^ci-run:' /etc/subgid; } || die "ci-run has no subuid/subgid range (check /etc/login.defs SUB_UID_COUNT, or add one with usermod --add-subuids/--add-subgids)"
  fi
  step "enable lingering for ci-run" loginctl enable-linger ci-run
}

prepare_rootless_docker() {
  local u; u=$(id -u ci-run 2>/dev/null || echo '<ci-run uid>')
  step "start the user manager of ci-run" systemctl start "user@$u.service"
  if [ "$DRY" = 0 ]; then
    local n; for n in $(seq 1 30); do [ -S "/run/user/$u/bus" ] && break; sleep 1; done
    [ -S "/run/user/$u/bus" ] || die "the user bus of ci-run did not come up (/run/user/$u/bus); is dbus-user-session installed?"
  fi
  if [ "$DRY" = 0 ] && [ -e "/home/ci-run/.config/systemd/user/docker.service" ]; then say "rootless Docker already set up for ci-run"; return 0; fi
  if [ "$DRY" = 1 ] || { [ -x /usr/bin/docker ] && [ ! -e /usr/share/docker.io/contrib/docker ]; }; then
    step "link /usr/bin/docker into /usr/share/docker.io/contrib for dockerd-rootless-setuptool.sh" ln -s /usr/bin/docker /usr/share/docker.io/contrib/docker
  fi
  step "set up rootless Docker for ci-run" runuser -u ci-run -- env "XDG_RUNTIME_DIR=/run/user/$u" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$u/bus" \
    "PATH=/usr/share/docker.io/contrib:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" dockerd-rootless-setuptool.sh install
}

setup_control_user() {
  step "create ci-control and store the GitHub App key (setup-control-user.sh from the verified tree)" \
    env "KEY=$KEY" "APP_ID=$APP_ID" "INSTALLATION_ID=$INSTALLATION_ID" bash "$STAGE/tree/scripts/setup-control-user.sh"
}

run_runtime_installer() {
  # install-runtime.sh overwrites /etc/ci-master/registry.yaml; a registry from an earlier run of this installer is kept (its label is already in use).
  if [ "$DRY" = 0 ] && [ -f /etc/ci-master/registry.yaml ] && ! grep -q 'example-org/example-app' /etc/ci-master/registry.yaml; then
    cp /etc/ci-master/registry.yaml "$STAGE/registry.prev"
  fi
  UNITS_INSTALLED=1
  # REGISTRY points at the example file of the same commit only so the delegated script's existence check passes; it is replaced below,
  # BEFORE anything is started (RESTART is unset and NO_WATCHDOG_START=1 skips starting ci-watchdog.timer until start_services runs last).
  step "install code, units, audit receiver, egress filter and build+pin the slot image (install-runtime.sh from the verified tree)" \
    env "CI_SRC=$CI_SRC" "COMMIT=$COMMIT" "NODE=$STAGE/node" "NODE_SHA256=$NODE_SHA256_OUT" BUILD_IMAGE=1 NO_WATCHDOG_START=1 REGISTRY=config/registry.example.yaml \
    bash "$STAGE/tree/scripts/install-runtime.sh"
}

write_registry() {
  local name label
  name=$(project_name_from_repo "${REPO#<}") || die "cannot derive a project name from $REPO"
  label=$(new_label)
  if [ "$DRY" = 1 ]; then
    say "would: write /etc/ci-master/registry.yaml with project '$name' for $REPO and a random unique label ci-farm-<8 hex>, validated by the installed registry parser first"
    return 0
  fi
  local tmp; tmp=$(mktemp "$STAGE/registry.XXXXXX")
  if [ -f "$STAGE/registry.prev" ]; then
    cp "$STAGE/registry.prev" "$tmp"; say "keeping the registry (and label) from the earlier run"
  else
    render_registry "$name" "$REPO" "$label" >"$tmp"
  fi
  (cd /opt/ci-master && runuser -u nobody -- /opt/ci-master/bin/node --input-type=module -e \
    "import {loadRegistry} from '/opt/ci-master/src/registry.ts'; import {readFileSync} from 'node:fs'; const r = loadRegistry(readFileSync(0, 'utf8')); console.log('registry ok:', r.length, 'project(s)')") <"$tmp" \
    || die "the generated registry did not pass the installed registry parser"
  install -m 0644 -o root -g root "$tmp" /etc/ci-master/registry.yaml
  say "registry written to /etc/ci-master/registry.yaml (the repository's runs-on must use the unique_label in it)"
}

init_secrets() {
  local node=/opt/ci-master/bin/node cs=/opt/ci-master/scripts/ctl-admin.ts
  if [ "$DRY" = 1 ]; then
    say "would: as ci-control run ctl-admin.ts init-totp and 'issue owner human'; their output goes to the terminal ONLY (never the log), shown once"
    return 0
  fi
  # Output of these two commands is the second-factor secret and a bearer token: straight to /dev/tty, bypassing the log.
  if [ -e /var/lib/ci-control/secrets/totp.secret ]; then say "second factor already initialised (kept)"; else
    say "==> second factor (shown once, on this terminal only; add it to your authenticator app now)"
    runuser -u ci-control -- "$node" "$cs" init-totp >/dev/tty
  fi
  if runuser -u ci-control -- "$node" "$cs" actors 2>/dev/null | grep -q '^owner human '; then say "dashboard token for 'owner' already issued (kept)"; else
    say "==> your dashboard token (shown once, on this terminal only)"
    runuser -u ci-control -- "$node" "$cs" issue owner human >/dev/tty
  fi
}

start_services() {
  step "reload systemd" systemctl daemon-reload
  step "start the services in boot order" systemctl restart ci-egress.service ci-broker.service ci-auditd.service ci-controld.service
  if [ "$DRY" = 0 ]; then
    local n; for n in $(seq 1 30); do curl -fs -m 3 "http://127.0.0.1:$API_PORT/v1/health" >/dev/null 2>&1 && break; sleep 2; done
  fi
  step "enable and start the watchdog timer" systemctl enable --now ci-watchdog.timer
}

# ---- self-check ------------------------------------------------------------------------------------------------------------------------------
CHECK_BAD=0
check() { # check "what" command...
  local what=$1; shift
  if "$@" >/dev/null 2>&1; then printf '  ok   %s\n' "$what"; else printf '  FAIL %s\n' "$what"; CHECK_BAD=1; fi
}
health_ok() { curl -fs -m 5 "http://127.0.0.1:$API_PORT/v1/health" | grep -q '"ok":true'; }
audit_append_only() { lsattr /var/lib/ci-audit/audit.jsonl | cut -d' ' -f1 | grep -q a; }
key_mode_ok() { [ "$(stat -c '%a %U' /var/lib/ci-control/secrets/github-app.pem)" = "400 ci-control" ] && [ "$(stat -c '%a' /var/lib/ci-control/secrets)" = 700 ]; }
pin_ok() {
  local img u; img=$(sed -n 's/^CI_SLOT_IMAGE=//p' /etc/ci-master/slot-image.env); u=$(id -u ci-run)
  [[ "$img" =~ ^sha256:[0-9a-f]{64}$ ]] && runuser -u ci-run -- env "DOCKER_HOST=unix:///run/user/$u/docker.sock" docker image inspect "$img"
}
run_not_in_control() { ! id -nG ci-run | tr ' ' '\n' | grep -qx ci-control; }
root_docker_off() { ! systemctl is-active --quiet docker.service && ! systemctl is-enabled --quiet docker.service; }
app_installed() { runuser -u ci-control -- /opt/ci-master/bin/node /opt/ci-master/scripts/check-app.ts; }
egress_loaded() { nft list table inet ci_farm; }

self_check() {
  if [ "$DRY" = 1 ]; then
    say "would: self-check units, /v1/health, audit append-only flag, egress table, pinned image, ci-run not in ci-control, key mode 0400, root Docker off, check-app.ts"
    return 0
  fi
  say "self-check:"
  local u
  for u in "${UNITS[@]}"; do check "$u is active" systemctl is-active --quiet "$u"; done
  check "controller health answers" health_ok
  check "audit file is append-only" audit_append_only
  check "egress table ci_farm is loaded" egress_loaded
  check "slot image is pinned and present in ci-run's Docker" pin_ok
  check "ci-run is not in group ci-control" run_not_in_control
  check "GitHub App key is 0400 ci-control in a 0700 directory" key_mode_ok
  check "root Docker daemon is off" root_docker_off
  check "GitHub App is installed on exactly the registry's private repository (check-app.ts)" app_installed
  [ "$CHECK_BAD" = 0 ] || { say "SOMETHING FAILED: see journalctl -b -u <unit> -n 30"; return 1; }
  say "ALL GOOD"
}

# ---- install / uninstall flows ---------------------------------------------------------------------------------------------------------------
# stop_slot_containers: stop and remove every slot container (label ci-master=1 or name cif-*, see src/launcher.ts) and confirm none remain.
stop_slot_containers() {
  user_exists ci-run || return 0
  local u sock by_label by_name ids left_l left_n
  u=$(id -u ci-run 2>/dev/null) || return 1
  sock="/run/user/$u/docker.sock"
  by_label=$(runuser -u ci-run -- env "DOCKER_HOST=unix://$sock" docker ps -aq --filter label=ci-master=1 2>/dev/null) || return 1
  by_name=$(runuser -u ci-run -- env "DOCKER_HOST=unix://$sock" docker ps -aq --filter 'name=^/cif-' 2>/dev/null) || return 1
  ids=$(printf '%s\n%s\n' "$by_label" "$by_name" | awk 'NF && !seen[$0]++')
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    runuser -u ci-run -- env "DOCKER_HOST=unix://$sock" docker rm -fv $ids >/dev/null 2>&1 || return 1
  fi
  left_l=$(runuser -u ci-run -- env "DOCKER_HOST=unix://$sock" docker ps -aq --filter label=ci-master=1 2>/dev/null) || return 1
  left_n=$(runuser -u ci-run -- env "DOCKER_HOST=unix://$sock" docker ps -aq --filter 'name=^/cif-' 2>/dev/null) || return 1
  [ -z "$left_l$left_n" ]
}

on_exit() {
  local rc=$?
  if [ "$rc" != 0 ] && [ "$UNITS_INSTALLED" = 1 ] && [ "$DRY" = 0 ] && [ "$PHASE_DONE" = 0 ]; then
    warn "failed after the units were installed: stopping the timer and services and disabling them so a half-configured farm does not run (re-run the installer to continue)"
    systemctl stop ci-watchdog.timer ci-watchdog.service >/dev/null 2>&1 || true
    systemctl stop ci-controld.service >/dev/null 2>&1 || true
    if stop_slot_containers; then
      systemctl stop ci-broker.service ci-auditd.service >/dev/null 2>&1 || true
      systemctl stop ci-egress.service >/dev/null 2>&1 || true
    else
      systemctl stop ci-broker.service ci-auditd.service >/dev/null 2>&1 || true
      warn "could not confirm all slot containers are gone; leaving ci-egress.service running so the firewall stays up (stop it by hand once containers are gone: sudo systemctl stop ci-egress.service)"
    fi
    systemctl disable ci-egress.service ci-broker.service ci-auditd.service ci-controld.service ci-watchdog.timer >/dev/null 2>&1 || true
  fi
  if [ -n "$PROBE" ]; then chattr -a "$PROBE" 2>/dev/null || true; rm -f "$PROBE"; fi
  if [ "$EVIDENCE_OK" = 1 ] && [ "$DRY" = 0 ]; then record_evidence || true; fi
  [ -z "$STAGE" ] || rm -rf "$STAGE"
  exit "$rc"
}

do_install() {
  preflight
  if [ "${#FAILS[@]}" -gt 0 ]; then
    printf 'preflight FAILED, nothing was changed:\n' >&2; printf '  - %s\n' "${FAILS[@]}" >&2; exit 1
  fi
  say "preflight ok"
  collect_answers
  append_only_probe          # the first change to the host (a probe file, removed at once and by the exit trap)
  STAGE=$(mktemp -d /tmp/ci-farm-install.XXXXXX); chmod 0700 "$STAGE"   # private scratch dir, removed on exit
  if [ "$DRY" = 0 ]; then
    install -d -m 0755 "$STATE_DIR"; install -m 0600 /dev/null "$LOG_FILE" 2>/dev/null || true
    exec > >(redact_key | tee -a "$LOG_FILE") 2>&1
  fi
  stage_tree
  install_prereqs
  fetch_node
  write_state incomplete
  install_packages
  [ "$DRY" = 1 ] || post_package_checks
  create_run_user
  prepare_rootless_docker
  setup_control_user
  run_runtime_installer
  write_registry
  init_secrets
  start_services
  self_check
  PHASE_DONE=1
  write_state complete
  say ""
  if [ "$DRY" = 1 ]; then say "Dry run complete: nothing was changed."; return 0; fi
  say "Installed. Not automated, do these by hand:"
  say "  1. In the repository's workflow, make runs-on use the unique_label from /etc/ci-master/registry.yaml, then run one workflow (the testbed job)."
  say "  2. Reboot once and confirm the five units come back (systemctl is-active ci-egress ci-broker ci-auditd ci-controld ci-watchdog.timer)."
  say "  3. Delete your downloaded copy of the App key yourself: shred -u <path>."
  say "Dashboard: http://127.0.0.1:$API_PORT/ (loopback only; log in with the token shown above)."
}

do_uninstall() {
  local fails=() st; st=$(state_status)
  [ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || fails+=("not root")
  if [ "$st" = complete ] || [ "$st" = incomplete ] || { [ "$st" = uninstalled ] && [ "$PURGE" = 1 ]; }; then
    local foreign; foreign=$(unattributed_items)
    [ -z "$foreign" ] || fails+=("parts that this installer's records do not account for (stale, copied or forged state file, or edited since): $foreign. They will not be removed by it")
  else
    fails+=("no usable installer state in $STATE_DIR: this farm was not created by install-farm.sh, so it will not be removed by it")
  fi
  local n; n=$(running_job_containers)
  [ "$n" -eq 0 ] || fails+=("the farm is busy: $n job container(s) running")
  if [ "${#fails[@]}" -gt 0 ]; then printf 'uninstall refused, nothing was changed:\n' >&2; printf '  - %s\n' "${fails[@]}" >&2; exit 1; fi
  if [ "$DRY" = 0 ] && [ "${ASSUME_YES:-}" != 1 ]; then
    local want=uninstall a; [ "$PURGE" = 1 ] && want=$(hostname)
    printf "Type '%s' to continue: " "$want" >/dev/tty; IFS= read -r a </dev/tty
    [ "$a" = "$want" ] || die "not confirmed"
  fi
  local u f
  STATUS=$st; EVIDENCE_OK=1
  for u in ci-watchdog.timer ci-controld.service ci-broker.service ci-auditd.service ci-egress.service; do
    if [ -e "$(fr "/etc/systemd/system/$u")" ]; then step "stop and disable $u" systemctl disable --now "$u"; fi
  done
  for u in ci-egress ci-broker ci-auditd ci-controld ci-watchdog; do step "remove unit $u" rm -f "/etc/systemd/system/$u.service" "/etc/systemd/system/$u.timer"; done
  step "reload systemd" systemctl daemon-reload
  step "reset failed state of farm units" systemctl reset-failed ci-egress ci-broker ci-auditd ci-controld ci-watchdog.service ci-watchdog.timer || true
  step "remove the egress table if it is still loaded" sh -c 'nft delete table inet ci_farm 2>/dev/null || true'
  step "remove code, config, tmpfiles rules and watchdog state" rm -rf /opt/ci-master /etc/ci-master /etc/tmpfiles.d/ci-master.conf /etc/tmpfiles.d/ci-audit.conf /var/lib/ci-watchdog /run/ci-master
  if [ -L "$(fr /usr/share/docker.io/contrib/docker)" ] && [ "$(readlink "$(fr /usr/share/docker.io/contrib/docker)")" = /usr/bin/docker ]; then
    step "remove /usr/share/docker.io/contrib/docker symlink" rm -f /usr/share/docker.io/contrib/docker
  fi
  if [ "$PURGE" = 1 ]; then
    f=/var/lib/ci-audit/audit.jsonl
    if [ -e "$(fr "$f")" ]; then step "remove the append-only flag from the audit file" chattr -a "$f"; fi
    if [ -d "$(fr /var/lib/ci-control/secrets)" ]; then step "shred the GitHub App key and other secrets" find /var/lib/ci-control/secrets -type f -exec shred -u {} +; fi
    if user_exists ci-run; then
      step "end ci-run's sessions and lingering" loginctl terminate-user ci-run
      step "disable lingering for ci-run" loginctl disable-linger ci-run
      local uid; if [ -n "$FR" ]; then uid=$(user_uid ci-run); else uid=$(id -u ci-run 2>/dev/null || true); fi; : "${uid:=<ci-run uid>}"
      step "stop the user manager of ci-run" systemctl stop "user@$uid.service"
      if [ "$DRY" = 0 ]; then
        local _; for _ in $(seq 1 30); do pgrep -u ci-run >/dev/null 2>&1 || break; sleep 1; done
        if pgrep -u ci-run >/dev/null 2>&1; then
          local rc=0; step "kill remaining processes of ci-run" pkill -KILL -u ci-run || rc=$?
          [ "$rc" -le 1 ] || return "$rc"
          for _ in $(seq 1 5); do pgrep -u ci-run >/dev/null 2>&1 || break; sleep 1; done
          ! pgrep -u ci-run >/dev/null 2>&1 || die "processes of ci-run are still running; reboot the machine and re-run --uninstall --purge"
        fi
      fi
    fi
    for u in ci-run ci-control ci-audit; do
      if user_exists "$u"; then step "delete user $u and its home" userdel -r "$u"; fi
    done
    EVIDENCE_OK=0   # the state directory is about to go; do not recreate it at exit
    step "remove audit data, runtime dirs and installer state" rm -rf /var/lib/ci-audit /run/ci-audit "$STATE_DIR"
    say "purged. Packages (docker.io, rootlesskit, ...) stay installed."
  else
    STATUS=uninstalled; record_evidence
    say "uninstalled. Kept: users ci-run/ci-control/ci-audit, the audit file, the GitHub App key, Docker data, apt packages. Use --uninstall --purge to remove users and data."
  fi
}

usage() { sed -n '2,7p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null || echo "usage: install-farm.sh [--dry-run] [--uninstall [--purge]]"; }

main() {
  exec </dev/null            # nothing run below may read the rest of a piped script
  cd /
  local a
  for a in "$@"; do
    case $a in
      --dry-run) DRY=1 ;;
      --uninstall) MODE=uninstall ;;
      --purge) PURGE=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument '$a'" ;;
    esac
  done
  [ "$PURGE" = 0 ] || [ "$MODE" = uninstall ] || die "--purge only goes with --uninstall"
  if [ -n "${CI_FAKE_ROOT:-}" ]; then
    [ "$DRY" = 1 ] || die "CI_FAKE_ROOT is only honoured together with --dry-run"
    FR=${CI_FAKE_ROOT%/}
  fi
  trap on_exit EXIT
  trap 'exit 130' INT TERM HUP     # signals end the run through the EXIT trap, so the probe and the stage dir are cleaned up
  [ "$DRY" = 0 ] || say "DRY RUN: nothing is changed and nothing is downloaded."
  if [ "$MODE" = uninstall ]; then do_uninstall; else do_install; fi
}

[ -n "${CI_INSTALLER_SOURCE_ONLY:-}" ] || main "$@"
