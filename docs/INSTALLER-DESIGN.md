# Installer 1: the generic one-click installer (`scripts/install-farm.sh`)

Status: design note, written before the code. Tracks issue 1 ("Full Linux installer: clean machine to working ci-master").

## What it does

One root script that takes a clean Ubuntu machine to a running farm for **one private repository**:

1. **Preflight** (strictly read-only: it contains no write of any kind): refuses unless every check passes (see "What it refuses").
2. **Asks** for the things only the owner can supply (see "What it asks"), then waits for your final confirmation.
   Right after the confirmation, as the **first change to the host** (before the state directory, the log file, the log redirection and the private scratch directory under `/tmp`), one small **append-only test** creates a probe file under `/var/lib`, runs `chattr +a`/`-a` on it and deletes it. The exit trap removes exactly that file on every exit path, including signals, so a failed `chattr` leaves nothing behind.
3. **Stages and verifies** the code: the commit you typed is rebuilt from git objects with every SHA-1 recomputed (commit, tree, blobs), exactly like `install-runtime.sh`. The pinned Node tarball is checked against a sha256 written in the script.
4. **Prepares the host**: apt packages (`docker.io rootlesskit slirp4netns uidmap dbus-user-session nftables`), root `dockerd` disabled, user `ci-run` (own subuid range, lingering), rootless Docker for `ci-run`.
5. **Delegates** to the two existing scripts from the *verified* tree, unchanged: `setup-control-user.sh` (user `ci-control`, App key 0400) and `install-runtime.sh` (code, units, tmpfiles, `ci-audit` with append-only file, egress filter, slot image build and pin).
6. **Writes the registry** for the one repository (generated from validated answers, checked by the installed registry parser before it is used) and creates the second factor and the owner's dashboard token.
7. **Starts** the services in boot order and runs the **self-check**.

It reuses the trust model unchanged: root never reads the dev-owned checkout as authority, the commit must be the full 40-hex id, Node is pinned by sha256, npm packages are checked against `package-lock.json` sha512 (by `install-runtime.sh`).

## How it is run

```bash
git clone https://github.com/silverhawk-tech/ci-farm ci-master && cd ci-master
git show <FULL 40-hex commit>:scripts/install-farm.sh | CI_SRC=$PWD COMMIT=<FULL 40-hex commit> bash -s -- --dry-run
git show <FULL 40-hex commit>:scripts/install-farm.sh | sudo CI_SRC=$PWD COMMIT=<FULL 40-hex commit> bash
```

The script text is read by you from `git show` before `sudo` (the same residual as `install-runtime.sh`). Read the script at that commit before you run it.

## What it asks

On `/dev/tty` (stdin is the script itself, so it cannot be used). Each can also be given as an environment variable for a repeat run.

| Question | Variable | Rule |
|---|---|---|
| Repository to serve | `REPO` | `owner/name`, one repository; the installer cannot see whether it is private, `check-app.ts` verifies that afterwards |
| GitHub App id | `APP_ID` | digits |
| Installation id | `INSTALLATION_ID` | digits |
| Path of the downloaded App key | `KEY` | regular file, not a symlink, PEM private key. Only the *path* is typed. The file is read once by `setup-control-user.sh`; deleting your copy stays your job |
| Final confirmation | | you type `install` |

The second factor secret and the owner's dashboard token are generated on the machine and printed **only to the terminal**, once, never to a file or the log. A terminal is therefore required for a real run. The installer's own log (`/var/log/ci-master-install.log`) records commands and results, never the output of those two steps and never any answer to the questions above except `REPO`. In particular the key *path* is not logged: `setup-control-user.sh` no longer echoes it and prints a fixed message if the file vanished, a path containing control characters is refused, and the log pipe additionally replaces the path with `<key path>` in anything a child prints.

## What it refuses (each with a plain message, all reasons listed at once)

- not root (real run), or a non-x86_64 CPU (the slot image's runner is pinned for x86_64);
- anything but **Ubuntu 24.04 or newer** (other Debian-family and non-systemd distros are refused until someone validates them; the issue lists non-systemd as out of scope);
- systemd not PID 1, cgroup v1, user namespaces disabled, `/usr/sbin/nft` missing after the package step;
- AppArmor restricting unprivileged user namespaces with no `rootlesskit` profile installed;
- under 8 GiB RAM (rounded: an "8 GB" machine passes), under 4 CPUs (a slot is limited to 3), or under 30 GiB free in `/var/lib`;
- `/etc/resolv.conf` not using the systemd-resolved stub `127.0.0.53` (the egress filter blocks LAN DNS servers, so jobs would have no DNS);
- a missing or empty `/etc/machine-id` (the installer's records are tied to it; an empty id would make every copied state file match);
- no terminal (the two secrets below are shown there once);
- a filesystem under `/var/lib` that cannot do `chattr +a` (the audit receiver needs it);
- port 8787 already in use on loopback;
- **an existing install**: any of `/opt/ci-master`, `/etc/ci-master`, a `ci-*` unit, the users `ci-run`/`ci-control`/`ci-audit`, `/var/lib/ci-control`, `/var/lib/ci-audit`, or the `ci_farm` nft table. Those mean "update with `install-runtime.sh`", not "install". One exception: a half-finished earlier run of this same installer (see idempotency);
- **a busy farm**: `ci-controld`/`ci-broker` active, or any container running in `ci-run`'s Docker. Nothing is stopped for you;
- a **running root Docker** (`docker.service`/`docker.socket` active or enabled): the farm needs the root daemon off, and the installer will not switch off a daemon something else may depend on;
- no route to `github.com`, `registry.npmjs.org`, `nodejs.org`;
- a `COMMIT` that is not the full 40-hex id or is not in `$CI_SRC/.git`.

## Idempotent and re-runnable

`/var/lib/ci-master-installer/state` (outside `/etc/ci-master`, so a plain uninstall does not erase it) holds `status=incomplete|complete|uninstalled`, a **machine tag** (a hash of `/etc/machine-id`), the commit and repo lines (informational only, never checked) and **evidence** about what this installer created: the uid of each user (`user.ci-run=1001`), the commit in `/opt/ci-master/.commit` (`opt.commit`), the owner of `/var/lib/ci-control` and `/var/lib/ci-audit` (`dir.<path>`), and the sha256 of each unit file and tmpfiles rule (`file.<path>`). It is rewritten from the *live* machine at the exit of every run that passed its gate.

The state file is **never trusted on its word**. The word `incomplete` or `uninstalled` only makes a resume *possible*: the file must carry this machine's tag, and every existing farm part (users, `/opt/ci-master`, units, tmpfiles rules, data dirs, the nft table) must match its recorded evidence against the live machine, or the run is refused and lists the parts it cannot account for. What is checked: the machine tag, user uids, the installed commit (`/opt/ci-master/.commit`), the sha256 of unit and tmpfiles files, the owner of the data dirs. A state file left over from an older install, copied from another machine, or made stale by a recreated user, an edited unit or a foreign `/opt/ci-master` fails that match, so the installer never writes over, and `--uninstall` never removes, something it cannot prove it created. With no machine id the tag is empty, which never counts as a match, so the installer refuses to start without one. **Limits, stated plainly:** the state file is root-owned, so this defends against a stale or copied file, not against someone who can already write as root; and a different install of the *same* commit on the *same* machine that has no record here is not claimed as ours (its parts are unaccounted for and refused), but one whose parts happen to match the recorded evidence is indistinguishable from ours. `complete`, or existing parts with no usable state, is refused as an existing install. Every other safety condition (running units, running job containers, an active or enabled root Docker, port 8787) is a live check on every run and no stored value can skip it. The cost of this strictness: a run killed with SIGKILL before it recorded evidence cannot be resumed or uninstalled by the installer; clean up by hand.

Every step is written to be repeated: packages (apt is idempotent), users (`id` before `useradd`), linger, rootless setup (checks the unit), delegated scripts (already idempotent), the pin (rebuilt). A registry written by an earlier run is kept, label included, because the repository's workflow may already use it. If a run stopped between installing `docker.io` (which enables the root daemon) and switching it off, the resume refuses and prints the one command to run deliberately. The second-factor secret is created only if absent (`ctl-admin.ts` itself refuses to rotate), so a resumed run never replaces it. A `complete` state is an existing install and is refused.

If the run fails after the units were installed, an exit trap **disables** the `ci-*` units again so a reboot never starts a half-configured farm.

## `--dry-run`

No root, no writes outside a private temp dir, no network: runs the whole preflight, verifies the commit's objects (hash chain) into the temp dir, and prints every step it would run. Needs the same environment variables; answers it cannot prompt for are shown as `<placeholder>`. Unit tests may point the read-only probes at a fake root with `CI_FAKE_ROOT`; that variable is honoured **only with `--dry-run`** and is rejected otherwise.

## Self-check (end of a real run)

Prints a line per check and ends with `ALL GOOD` or exits 1: five units active, `/v1/health` ok, audit file has the `a` attribute, `ci_farm` table loaded, the pinned image exists in `ci-run`'s Docker, `ci-run` is not in `ci-control`, key file 0400 `ci-control`, root Docker off, and `check-app.ts` (App installed on exactly the registry's repository, private only).

## How it is undone

`install-farm.sh --uninstall` (same `git show | sudo` way). It only acts when the installer state says `complete` or `incomplete` (`uninstalled` for `--purge`) **and** every existing farm part matches the recorded evidence (see Idempotent), so it cannot be pointed at a farm it did not create, or talked into it by a forged state file; it also refuses while jobs run. It stops and disables the units and the timer, removes unit files, `/opt/ci-master`, `/etc/ci-master`, the tmpfiles rules and the nft table, and **keeps** the audit file, the users, the GitHub App key, apt packages and Docker data (the state becomes `uninstalled`, so a fresh install may follow). `--uninstall --purge` additionally (after typing the hostname) removes the three users and their data, including `chattr -a` on the audit file and `shred` of the App key.

## Not in this version

The testbed job end to end, the watchdog recovery test and the reboot-order test from issue 1 need a real GitHub repository, a reboot or a running farm; the installer prints them as manual steps. Creating the GitHub App (web UI), agent MCP registration and Tailscale are done by you outside this installer.

## What is verified and what is not

Verified in a sandbox (`test/install-farm.test.ts`, part of `npm test`): bash syntax and shellcheck; every validator and parser; the verified-extraction helper against a real git repository, including a tampered blob and a symlink; the whole preflight and the printed plan in `--dry-run` against a fake root (supported and unsupported distros, resources, existing install, resume, busy farm, root Docker); the exact commands of the mutating steps through recorders; the exit trap; that the generated registry parses with the real `src/registry.ts`; that the two secrets go to the terminal only.

Verified in a VM (2026-11-08) on Ubuntu Server 26.04.1 LTS (VMware VM, 4 CPUs, 9 GB RAM, 60 GB disk, from the public clone at `github.com/silverhawk-tech/ci-farm`, commit `8b09c2d` then `1241adb`):
- `--dry-run` passed preflight; a 40 GB VM disk failed the 30 GiB free `/var/lib` check, correctly.
- A real run with fake GitHub App credentials ran through `apt-get` prerequisites and packages, user `ci-run` (`useradd`, `loginctl`), rootless Docker (`dockerd-rootless-setuptool.sh` on Ubuntu 26.04.1 LTS), the delegated runtime install from the staged copy (including the Node tarball download and `chattr +a`), slot image build and pin, registry generation, second factor and dashboard token, unit start (including the live `ci_farm` egress filter) and the self-check: 12 of 13 checks passed (including `/v1/health`); the only failure was the GitHub App check (`check-app.ts`), expected with fake credentials.
- Failure rollback stopped the timer and services as designed, and `--uninstall --purge` removed `ci-run`, `/etc/ci-master` and `/opt/ci-master`.
- Real-install bug found and fixed: Ubuntu's `docker.io` puts the `docker` CLI in `/usr/bin` so `dockerd-rootless-setuptool.sh` failed on `$BIN/docker version` (installer now links `/usr/bin/docker` into `/usr/share/docker.io/contrib/docker`).
- Real-install bug found and fixed: uninstall could not delete `ci-run` while its `systemd --user` manager still ran (uninstall now stops `user@UID.service` and waits).

**Not verified**: a live GitHub App (`check-app.ts` with real credentials) and registration of a real runner and a job end to end; GitHub App permissions (`Actions` read/write, `Administration` read/write, `Metadata` read are inferred from the code only); behaviour after a reboot.
