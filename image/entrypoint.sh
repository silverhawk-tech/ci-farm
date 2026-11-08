#!/usr/bin/env bash
# 1) start the slot's own Docker daemon  2) wait for the single-use JIT config  3) run exactly one job  4) exit
set -euo pipefail
dockerd >/var/log/dockerd.log 2>&1 &
for i in $(seq 1 90); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || { echo "slot: inner docker did not start" >&2; tail -20 /var/log/dockerd.log >&2; exit 1; }
echo "slot: inner docker ready"
for i in $(seq 1 600); do [ -s /run/ci/jit ] && break; sleep 1; done
[ -s /run/ci/jit ] || { echo "slot: no JIT config arrived, exiting" >&2; exit 1; }
cfg=$(cat /run/ci/jit); rm -f /run/ci/jit
export ACTIONS_RUNNER_INPUT_JITCONFIG="$cfg"; unset cfg
exec /runner/run.sh
