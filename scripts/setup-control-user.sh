#!/usr/bin/env bash
# Run as root by the owner, BEFORE scripts/install-runtime.sh (which needs the ci-control group). Pipe it from git so root runs exactly the reviewed commit:
#   cd <your checkout> && git show <FULL 40-hex commit>:scripts/setup-control-user.sh | sudo KEY=<path of the downloaded GitHub App .pem> APP_ID=<app id> INSTALLATION_ID=<installation id> bash
# Creates the ci-control user and stores the GitHub App key and ids where only that user can read them. It installs and runs NO code:
# everything that executes next to the key is installed by install-runtime.sh from verified git objects, never from a working checkout.
# Afterwards, as a read-only check once install-runtime.sh has run:
#   sudo -u ci-control /opt/ci-master/bin/node /opt/ci-master/scripts/check-app.ts
set -euo pipefail
KEY=${KEY:?set KEY=<path to the downloaded .pem>}
APP_ID=${APP_ID:?set APP_ID=<GitHub App id>}
INSTALLATION_ID=${INSTALLATION_ID:?set INSTALLATION_ID=<installation id of the App on your account>}
[[ "$APP_ID" =~ ^[0-9]+$ && "$INSTALLATION_ID" =~ ^[0-9]+$ ]] || { echo "refusing: APP_ID and INSTALLATION_ID must be numbers" >&2; exit 1; }
id ci-control >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/ci-control --shell /usr/sbin/nologin ci-control
install -d -m 0700 -o ci-control -g ci-control /var/lib/ci-control/secrets
# The key is read ONCE (a single open, from the path you gave); everything after that checks the root-owned copy, never the original path again.
[ -f "$KEY" ] && [ ! -L "$KEY" ] || { echo "refusing: KEY must be a regular file" >&2; exit 1; }
install -m 0400 -o ci-control -g ci-control "$KEY" /var/lib/ci-control/secrets/github-app.pem 2>/dev/null || { echo "refusing: could not read the key file (it must stay a readable regular file until this step has run)" >&2; exit 1; }   # fixed message: the path never reaches a log
grep -q -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' /var/lib/ci-control/secrets/github-app.pem || { rm -f /var/lib/ci-control/secrets/github-app.pem; echo "refusing: the key file is not a PEM private key" >&2; exit 1; }
printf '{"appId":%s,"installationId":%s}\n' "$APP_ID" "$INSTALLATION_ID" > /var/lib/ci-control/app.json
chown ci-control:ci-control /var/lib/ci-control/app.json; chmod 0600 /var/lib/ci-control/app.json
echo "now delete your downloaded copy of the key yourself (shred -u <the path you gave>)   (this script does not touch it again: a root-run delete of a path you control can be redirected)"
ls -l /var/lib/ci-control/secrets
echo "next: run scripts/install-runtime.sh from a reviewed commit, then the read-only check above"
