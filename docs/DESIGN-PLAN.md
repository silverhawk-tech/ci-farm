> Repo name: **ci-master** (the drafts below call it "ci-farm"; same project). Status: spike done, Phase 3 started.

# Self-hosted CI — Design Plan (draft 2)

Status: DRAFT for the owner. No code written. Nothing installed. Working name: `ci-farm` (final name is an open decision).
Date: 2026-10-29. Author: Claude (Sonnet 5.5). Independent review: round 1 done (Codex gpt-6.1-terra, high, read-only; 13 findings, all accepted and applied in this draft, see section 4a). Round 2 done (Codex, fix diff only: 8 findings plus partial-resolution notes on R1-R12, all accepted and applied; no third round, per the two-round limit). Codex did not have the round-1 text, so its 13-row resolution table was a proxy; the author mapped each original finding to a requirement or edit. The reviewers could not verify GitHub API facts; those stay in section 11.

---

## 1. Goal

A generic, secure, long-term self-hosted CI service for Ubuntu that:

1. Runs GitHub Actions jobs on our own hardware, so we stop spending GitHub-hosted minutes (3,000/month, exhausted until 2026-11-01).
2. Serves ExampleApp first, then other projects, through a project registry rather than hard-coded values.
3. Gives every job its own throw-away environment and its own one-time credential (JIT).
4. Has a control dashboard for people and one set of tools for all our agents (Claude, Codex, Gemini), both going through the same rules.

Non-goals (explicitly out of scope):

- Not a CI engine. GitHub Actions stays the engine; we only supply the runners.
- No change to how ExampleApp deploys. Render stays on its native runtime and `checksPass`. The Docker/GHCR deploy option is a separate topology decision and is NOT part of this plan.
- No Windows/WSL support. Linux only.
- No public repos and no fork-PR workflows on this runner, ever.

---

## 2. What we reuse from Amir's `joggo` (MIT) and what we do not

Verified by reading the repo (untrusted source, read-only, never executed).

| Reuse (ideas and patterns, rewritten for Linux) | Drop |
|---|---|
| One-job-per-slot lifecycle: build, run `--once`, tear down | All PowerShell, WSL, guard, mem-watch, WPF monitor, installer steps |
| Pause as a per-slot flag file the launcher checks before building anything; a pause never kills a running job | Root Docker plus `usermod -aG docker` (docker group is root-equivalent) |
| Separate "slots-status --json" as the single source of slot state | Persistent runner registration and readable `.credentials` in the job volume |
| `build-and-push.yml` / `node-test.yml` reusable workflow patterns (adapted: npm, not pnpm) | Hard-coded user `ghrunner` uid 1001, `example-org` unit names, subnet 10.211 |
| SUPERVISOR.md: invariants, command tiers, diagnosis tests ("never ran" vs "failed") | Pasting a prompt into a session as the control method |
| `ephemeral-slot-spike.sh` approach: test isolation before trusting it | |

Licence: joggo is MIT. GitHub does not allow a private fork of a public repo, so we start a fresh private repo and carry over only what we reuse, keeping the MIT notice and crediting Amir in a `NOTICE`/README line.

Amir's dashboard (`monitor/deploy-monitor.ps1`) is a Windows-only WPF app. It reads runner logs through `wsl.exe` every 15 s and offers: pause/resume (box or slot), `gh run cancel` for queued runs, `gh run rerun --failed`. It has no delete and no kill-running-job. We are not porting it; we build a Linux dashboard that offers the superset below.

---

## 3. Architecture

```
GitHub (outbound HTTPS only from our machine)
   ^   poll queued jobs / mint JIT config / run actions
   |
+--+--------------------------- one Ubuntu machine ----------------------------+
|                                                                               |
|  user ci-control (supervisor)            user ci-run (rootless Docker)        |
|  +----------------------------+          +--------------------------------+   |
|  | controld (daemon)          |  launch  | slot 1: runner container (JIT) |   |
|  |  - project registry        +--------->|   + its own Docker daemon      |   |
|  |  - queue poller            |          | slot 2: ...                    |   |
|  |  - GitHub App key (0400)   |          +--------------------------------+   |
|  |  - JIT minting             |                                               |
|  |  - policy + approvals      |  Unix socket / localhost only                 |
|  |  - audit log (SQLite)      |<---------+--------------+                     |
|  +----------------------------+          |              |                     |
|                                   dashboard (web)   MCP server (thin client)  |
+-------------------------------------------------------------------------------+
                                       people         Claude / Codex / Gemini
```

Key separation: the **GitHub App private key lives only with `ci-control`**. Job containers run as a different Unix user under rootless Docker and never see that key, the daemon socket, or any other job.

### Components

1. **controld (daemon, TypeScript on Node 22).** Same toolchain as ExampleApp, which our agents already know. Responsibilities: project registry, poll GitHub for queued jobs that match our labels, decide whether a slot is free and not paused, mint a JIT config, ask the isolation backend to start one job, record everything.
2. **Isolation backend (swappable interface).** `prepare / run / kill / cleanup`. v1 = rootless Docker. Later options (Incus system containers, Firecracker microVM) plug in without touching the rest.
3. **Launcher broker (separate small process, user `ci-run` side).** controld does not get a general Docker API. It sends the broker a fixed-shape request (project, slot, image digest, resource limits, JIT config); the broker alone talks to the rootless Docker daemon, with launch parameters it fixes itself (no host mounts, no host network, no privileged flags, no docker socket exposed). Per job: fresh container, JIT config delivered so it never appears in a process command line or logs (delivery mechanism verified in the spike, item V9), deleted from disk/tmpfs as soon as the runner has read it; container and volumes destroyed on exit; resource limits (memory, CPU, PIDs, disk, log size) applied and tested including nested containers. Job containers cannot reach the broker, controld, or any socket of `ci-run`.
4. **Control API.** One set of actions, three permission tiers, approvals, audit (section 6).
5. **Dashboard (web, localhost).** Live view plus the actions in section 6. Server-rendered pages plus server-sent events; no heavy frontend stack. **It also shows live CPU and RAM usage** (the owner's requirement, so no other tool is needed): whole machine (CPU %, RAM used/available, swap, disk free) and per slot (CPU %, RAM used against that slot's limit, current job), with a short trend graph (last hours) and a clear warning state near the guard thresholds. Numbers come from the sampler in item 7; the dashboard never gets Docker access to read them.
6. **MCP server (thin client of the control API).** The way all agents see the system (section 7).
7. **Observability and housekeeping.** A small resource sampler (host `/proc` and cgroup counters: CPU, memory, swap, disk, per-slot cgroup `cpu.stat` and `memory.current`, collected by the broker side and exposed read-only) stores a rolling history in SQLite. It feeds the dashboard, the `ci_resources` read tool for agents, the memory/CPU/disk guard, and the real capacity numbers we still need (V6). Also image and cache cleanup, log retention, health endpoint.

### Why polling and not webhooks

Webhooks need an inbound endpoint, which would break the outbound-only rule. controld polls GitHub per registered repo every ~15-30 s and starts a runner only when a matching job is waiting. Polling uses the queued-runs list, then the jobs list of each queued run (to see each job's labels and status), with conditional requests (ETag), which may reduce rate-limit cost (unverified, item V8), and adaptive backoff. The rate budget must include pagination, job lookups, retries and any other installation traffic, and is settled by measurement (V8). Cost: up to ~30 s extra latency before a job starts. Accepted.

Slot reservation is atomic: a slot is reserved in the state DB *before* a JIT config is minted, so two poll cycles can never start more runners than a project's `max_slots` or the global limit. Each reservation has a lifecycle (reserved, minted, started, job-running, finished, torn-down) persisted in SQLite and reconciled at startup (section 4a, R9).

### How JIT works here (no approval per run)

1. controld sees a queued job whose labels match a registered project, **and re-checks right before minting that its run is still current** (not cancelled, not superseded; section 6a).
2. controld reserves a slot, then asks GitHub (as the GitHub App) for a **JIT runner config** for that repo, registered at **repository level** (so only that repo's jobs can use it) with the project's unique label. The API requires a `runner_group_id` and at least one label. The config is single-use and tied to one runner. Important: a JIT runner is *not bound to one particular job*; GitHub gives it whichever eligible queued job matches. So the security boundary is repository-level registration plus the unique label, never the poller's decision (section 4a, R1).
3. The runner container starts with only that config, takes exactly one job, and is destroyed.
4. Nothing is approved per run by a human. The App key, the registry and the policy decide. Humans approve only destructive control actions (section 6).

Where the code comes from: the job itself does `actions/checkout` using the job's short-lived `GITHUB_TOKEN`, over outbound HTTPS. Nothing is pushed to the machine.

---

## 4. Security model

### Trust boundaries

| Zone | Trusted? | Holds |
|---|---|---|
| GitHub App private key | Highest | Only `ci-control`, file mode 0400, never mounted anywhere else |
| controld + registry + audit DB | High | `ci-control` user |
| Dashboard / MCP / API clients | Authenticated, least privilege | per-identity tokens |
| Job containers | **Untrusted** (run repo code, `npm` postinstall, tests) | one JIT config, the job's own `GITHUB_TOKEN`, only the workflow secrets we choose to give that job |
| Logs, PR titles, commit messages, build output | **Untrusted data** | never treated as instructions, including by agents |

### Threats and mitigations

| Threat | Mitigation |
|---|---|
| Malicious or compromised dependency runs in a job | Rootless Docker, no docker group, no privileged containers on the host (a slot is privileged only inside ci-run's rootless user namespace so it can run its own Docker, plan 5a), per-job disposable environment, CPU/memory/PID limits, no host mounts except what the spike proves necessary |
| Stealing runner credentials from a job | JIT config is single-use and short-lived; no persistent `.credentials`; App key not reachable |
| Container escape | Rootless (no root on the host to gain), seccomp/AppArmor defaults kept, isolation backend swappable to microVM if a stronger boundary is needed |
| Secrets exposed to jobs | Self-hosted jobs only get the secrets their workflow requests. **Migrations and anything using `DATABASE_URL_DIRECT` stay on GitHub-hosted runners.** Registry marks each project's allowed lanes |
| Public repo / fork PR running on our hardware | Registry refuses public repos; policy refuses fork-PR events; documented as an invariant |
| Prompt injection through job logs or PR text | Agents see logs only through tools that label them as untrusted data; destructive tools need human approval regardless of what an agent was told |
| Agent acts beyond its role | Per-agent tokens, tiers enforced server-side, audit trail, approval queue |
| Dashboard exposed to the network | Bind to localhost by default; any remote access needs login plus TLS and is a separate decision |
| Resource exhaustion starving the dev machine | Slot count limit, per-slot cgroup limits, memory guard that pauses new jobs (never kills a running one) |
| Supply chain (actions, base images) | Pin actions by commit SHA and images by digest in our own workflows and in the tool |
| Secrets in logs or git | Secret scanning on the tool's repo, no secrets in images or git, log redaction in the audit log |

## 4a. Requirements added by independent review round 1 (binding)

Source: Codex review, 13 findings, all accepted. R-numbers are referenced from other sections.

| # | Requirement |
|---|---|
| R1 | **Runner boundary is GitHub's, not ours.** A JIT runner takes any eligible queued job, so the poller's "event/lane" checks are scheduling hints only. The real boundary: **repository-level registration** (a repo-level runner can only ever take that repo's jobs) plus a unique label used only as a **routing selector** (anyone who can read or edit the repo's workflows can see it, so it is not a secret and not an authorization boundary). Assume any workflow author in a registered repo can execute code on the runner. A dedicated runner group per project needs a GitHub *organization*; a personal repository is a personal-account repo, so we use the default group id and rely on repo scope plus label (confirm in the dry run, V10). If we later move to an org, add one runner group per project. Branch protection/CODEOWNERS on `.github/workflows` for registered repos. Documented plainly: anyone who can push a workflow to a registered repo can run code on this machine. |
| R2 | **Threat model stated honestly:** rootless Docker is a meaningful but not a strong boundary against a hostile job. It is acceptable for our own private repos only. Jobs get no route to host loopback, LAN or other host services, enforced by the job network's configuration (host loopback disabled, egress filtered by firewall rules), not by convention, and proven by test (section 5). Mutually untrusted tenants would require microVMs (isolation backend is swappable for that reason). |
| R3 | **Control-to-runner boundary is the launcher broker** (section 3): fixed launch parameters, no general Docker API for controld, no job access to any socket; tested across Unix users and from inside a job. Requests reach the broker only over a Unix socket with peer-credential checks (only the `ci-control` uid); containers are named by reservation id, which is the job-to-container mapping. |
| R4 | **Job-held credentials are assumed stealable.** Workflows on this runner request minimal `GITHUB_TOKEN` permissions; sensitive secrets and privileged environments never reach these jobs; egress limited where practical; documented that job code can read everything deliberately given to its job. |
| R5 | **Identity:** see section 7, including the honest limit that all agents share one OS account today. |
| R6 | **Dashboard/API safety:** bind 127.0.0.1 only, authenticated sessions, CSRF tokens, Origin and Host header validation (blocks DNS-rebinding), no cross-origin access. Approvals are bound, expiring and single-use (section 6). |
| R7 | **Security review before exposure:** independent review gate (Phase 6b) before any real repo or credential is attached, not after cut-over. |
| R8 | **Scheduling contract:** queued runs, then each run's jobs (labels, status), atomic slot reservation before minting, pagination, per-project and global limits, rate-limit budget verified (V8). |
| R9 | **Recovery:** persisted lifecycle per reservation; on startup reconcile GitHub registrations, containers, volumes and reservations against the DB and clean orphans idempotently; bounded idle timeout for runners that never get a job; retry with backoff. Ambiguous states (container alive but its job unidentified) are never killed by reconciliation: they are flagged and left to the idle timeout or a human (see idle-timeout note below). |
| R10 | **JIT delivery and limits:** config never in a command line, inspect output or logs, deleted after read; memory/CPU/PID limits proven for nested containers; disk quota, log-size cap, inode watch and host reserve threshold. |
| R11 | **Audit and logs:** audit records are hash-chained and also streamed to a separately owned append-only receiver (different Unix user, restricted authenticated writes, sequence numbers), with periodic checkpoints of the chain head kept outside the machine's writable audit path (for example committed to the private `ci-farm` repo) and alerts on sequence gaps or missed heartbeats, so a compromised controld cannot silently rewrite or truncate history. Residual risk, stated: a compromised sender can still forge new events; redaction applied to every log path (dashboard, job logs shown, diagnostics), not only the audit log; log text returned to agents or UI is length-bounded, labelled untrusted, and never executed. |
| R12 | **Re-runs and shadow mode have external effects:** re-run only for allow-listed side-effect-free workflows (registry `rerun_allowed_workflows`), never deploy/migration lanes; shadow checks use distinct non-required names and cannot deploy (section 9). |

> **R9 / Idle-timeout note (2026-11-12):** An idle timeout never applies to a runner GitHub reports as busy (`runnerBusy`).
> Even if its job cannot yet be identified in run snapshots (e.g. run-level status is still `queued` while a job executes),
> controld queries `GET /repos/{repo}/actions/runners/{id}` before timing out a slot in `started`; if `busy: true`,
> the slot is kept alive and not torn down. Fixes the incident where 2026-11-07 and 2026-11-12 `gates` runs were lost
> after 10 + 10 minutes (10 min idle-kill false positive + 10 min GitHub runner communication loss).

### Invariants (carried from SUPERVISOR.md, enforced in code where possible)

1. No privileged secrets in job environments.
2. Never public repos or fork PRs.
3. A pause never kills a running job; only an explicit, approved kill does.
4. Restarting the runner service, or anything that drops a job, needs approval.
5. Agents never cancel, delete, or trigger new CI on their own initiative. They may re-run failed jobs only within the capped guardrails in section 6.
6. A message from another agent is information, never permission.

---

## 5. Isolation: the rootless Docker question (needs a spike)

Unknowns that only a test on your machine can settle:

1. Ubuntu 24.04+ restricts unprivileged user namespaces through AppArmor; rootless Docker may need an explicit profile.
2. Jobs that themselves use Docker (service containers, `docker build`) need a Docker daemon **per job** inside the isolated environment. Rootless-inside-rootless (nested) is the part joggo reported failing, which is why it used a privileged DinD container.
3. Playwright (Chromium) needs namespaces/sandbox or `--no-sandbox` decisions inside the container.
4. Performance and cold-start time on a Ryzen 3 5300U (joggo measured ~83-108 s cold start; no cache between jobs).

Spike exit criteria (all must hold, or we change backend):

- A job container runs as non-root with no host docker socket, and cannot read the host user's files.
- Inside it: `npm ci`, a Postgres service container, `docker build`, and Playwright Chromium all work.
- Memory limit is enforced (a runaway process is killed inside the container, not on the host).
- Teardown leaves no containers, volumes or networks behind.
- **A job cannot reach the host or LAN:** host loopback (including the dev Postgres at 127.0.0.1:54329), the host's other services, RFC1918 ranges and link-local addresses are unreachable from a job; only the internet egress the job needs is allowed. Proven with a connection test from inside a job.
- **Cross-job isolation:** a job cannot see another slot's containers, volumes, processes or sockets, nor the broker/controld sockets.
- **Memory/CPU/PID limits hold for nested containers too** (cgroup delegation proven), and a **disk quota and log-size cap** stop a job filling the host disk or inodes; host disk reserve threshold pauses new jobs.
- **The JIT config never appears** in a process command line, container inspect output or any log (checked with `ps`, `/proc`, `docker inspect`, log grep) and is deleted right after the runner reads it.
- **Idle JIT runner timeout:** a runner whose job was taken by someone else or cancelled is torn down after a bounded idle time.
- Fallback if nested rootless fails: Incus system containers (or a microVM) as the backend. We do not fall back to privileged DinD or the docker group without the owner's explicit decision.

Sudo steps (installing Docker/uidmap, creating users, AppArmor) are run by the owner; the agent supplies exact commands one at a time.

## 5c. Code review round 1 (Codex gpt-6.1-terra, read-only, commit 1baaf92) and dispositions

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | Crit | A JIT runner can take any job matching its labels, not only the one we reserved it for | Cannot be prevented with repo-level runners on a personal account (no runner groups, V10). Mitigated in depth: private-only repos, registry allows only own-repo events (no forks, no pull_request_target), repo settings keep fork PR workflows off, AND after pickup the job the runner actually took is identified by runner_name and the slot is killed if its run is not allowed (`runAllowed`). Residual: a short window between pickup and kill. Open for Phase 6b: GitHub-side enforcement (org + runner groups) if we ever move to an organization. |
| 2 | Crit | Root installer copies dev-controlled code/node, then ci-control runs it beside the key | Installers now refuse a dirty tree or HEAD != pushed origin/main, and pin the Node binary by sha256. Residual: the pushed commit and the Node binary are still the trust root; Phase 6b should move Node to a root-owned verified install. |
| 3 | High | JIT config in the slot's env (readable via /proc/1/environ by a job running as root) | Accepted for the testbed, to be MEASURED in the end-to-end run (V9): the config is single-use and the runner is removed after one job. If it leaks and is reusable, switch delivery. |
| 4 | High | Broker does not enforce limits | Fixed: broker keeps its own global/project/slot/reservation limits, start requests serialised. |
| 5 | High | `--privileged` on slots | Decision stands (plan 5a): privileged only inside ci-run's rootless user namespace so each slot can run its own Docker; requirement text corrected. Backend swap (Incus/microVM) remains the path to remove it. |
| 6 | High | Failed cleanup released the slot | Fixed: slot released only after container AND runner registration are confirmed gone; retried each tick; "already gone" counts as success. |
| 7 | High | Wrong job ownership, no idle timeout, crash between mint and persist | Fixed: ownership via runner_name; disallowed job kills slot; idle timeout (10 min); orphan runner registrations swept by name (cif-*). |
| 8 | High | Currentness: only 50 queued runs, in-progress newer runs ignored | Fixed: queued + in_progress runs, pagination to 500 then fail closed, repo checked again right before mint. |
| 9 | High | Public repos not refused | Fixed: GET /repos must say private=true on every poll and before mint, else the project is skipped. |
| 10 | Med | Concurrent reconcilers | Fixed: single-instance pid lock; per-reservation errors no longer abort the tick. |
| 11 | Med | Socket trusts group membership, not peer UID | Node cannot read SO_PEERCRED. ci-run is no longer in ci-control (registry is world-readable, holds no secrets), so the socket group is only controld's user. Residual accepted. |
| 12 | Med | Broker framing allows concurrent ops per connection | Fixed: one request per connection, 8 connections max. |
| 13 | Med | Supersede grouping for push/branch runs | Fixed: only pull_request runs supersede; PR without PR number refused. |
| 14 | Med | Image mutable and could look like an option | Fixed: image must be digest-pinned (dev flag CI_ALLOW_UNPINNED_IMAGE=1) and cannot start with '-'. |

### Round 2 (fix diff only, last round) and dispositions
- C1 root installer sources a script from the dev-owned checkout before verifying it: inherent (root runs what the owner tells it to). Mitigation: the installer is piped from `git show <commit>:path` (content-addressed) and refuses unless the checked-out HEAD is that same commit with a clean tree. Dependencies in node_modules (zod, yaml, no install scripts) are copied from the lockfile-installed tree: residual until Phase 6b (root-owned verified install).
- H1 owner lookup: now paginated; a lookup ERROR is "unknown" (never idleness). Residual: pre-detection window.
  R9 idle timeout fix: an idle timeout never applies to a runner GitHub reports as busy (`runnerBusy`).
  Before failing an idle slot in started, controld queries the runner status directly, preventing false-positive
  kills (cite incident: 2026-11-07 and 2026-11-12 gates runs lost after 10 + 10 minutes).
- H2 started + completed between polls: now finishes through running. H3: runner removal uses the repo stored on the reservation, no longer depends on the registry. Added max run time (2 h) for running slots.
- H4 timed-out start: broker skips a queued start whose client socket is gone. H5: pid file replaced by an atomic SQLite lease (BEGIN IMMEDIATE, 60 s, renewed each tick).
- M1 installer verifies ci-run left ci-control and tells the owner to restart its login. M2 runner sweep paginated and scoped by a per-installation id in runner names (cif-<instance>-...). M3 one list of the newest 500 runs of all statuses is one consistent snapshot (the unavoidable race between the last check and GitHub's pickup remains and is covered by the post-pickup check).
- Not changed: 5 (privileged inside userns, accepted), 11 (no SO_PEERCRED in Node, mitigated by group membership), 14 digest shape (Docker rejects malformed digests; pinned by tag@sha256 on build).
- Codex's E2E verdict was "not safely" because privileged isolation and JIT exposure are unverified. Those are exactly what the testbed run measures; the testbed holds no real code or secrets. Accepted by design for the throwaway repo only.

Not yet implemented but required before real repos (Codex list, all already in the phases): persistent egress filter, disk and inode limits, host resource guard, isolation and JIT-exposure tests, control API + dashboard + MCP + approvals + audit trail, workflow onboarding controls.

## 5d. Phase 4 code review round 1 (Codex gpt-6.1-terra, read-only, commit 0171910) and dispositions

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | Crit | A shared-account agent that reads a human token acts as a human without TOTP | Fixed in code: a human token alone can only do read and reversible actions; every gated action by a human now needs a FRESH TOTP code (API checks it, one use). Honest limit stays: if an agent also reads the authenticator or the browser session, nothing on one OS account stops it (plan 7). The human token is meant to live only in the browser, never on disk. |
| 2 | High | TOTP brute force | Fixed: 5 wrong codes in 5 minutes locks every TOTP check (even the right code) for the window; shared by approve, policy edit and gated actions; persisted in the DB. |
| 3 | High | Re-run guardrail bypasses (rerun_all, human path, grid limits raising caps) | Fixed: one atomic reservation for rerun_failed AND rerun_all, every actor; allow-list required on every path; grid limits can only LOWER the hard ceiling (2 per run, 6 per hour). Deploy lanes: the allow-list is the authority, the filename regex is only an extra. |
| 4 | High | Superseded detection gaps | Fixed: PR head SHA must equal the run's SHA; newer runs searched over 5 pages; no PR identity or own run not found = treated as superseded (fail closed). |
| 5 | High | Approval usable by another agent | Fixed: consume matches the requester; approver id recorded in the execution row. |
| 6 | High | Audit failure leaves unlogged effects | Fixed: an 'attempt' row is written BEFORE any action (and before approve/policy changes); if it cannot be written nothing happens and a consumed approval is given back. Result rows follow. |
| 7 | High | Kill races an in-flight start | Fixed: kill/restart only apply to started or running slots; a runner minted for a slot that was failed meanwhile is removed at once. |
| 8 | High | No independent audit receiver | Accepted for now, listed as REQUIRED before exposure beyond this machine and before Phase 6b: separate-owner append-only receiver, off-machine checkpoints, gap alerts (R11). Today the chain detects edits and mid-chain deletes only. |
| 9 | Med | Incomplete approval binding | Fixed: slot actions bind the reservation's repo, run id and head SHA; slot-number and global actions have explicit bindings. |
| 10 | Med | Approval burnt by an impossible request | Fixed: preconditions run before consume; GitHub 4xx refusal gives the approval back; an uncertain outcome keeps it consumed. |
| 11 | Med | Stale target at mutation time | Fixed: the run is re-read immediately before cancel, delete and re-run; SHA, state and currentness must still hold. The remaining race inside GitHub is unavoidable and stated. |
| 12 | Med | cim_ tokens not redacted | Fixed. |
| 13 | Med | Pause acknowledged while a tick keeps starting jobs | Fixed: pause is re-checked before every reservation. |
| 14 | Med | Held slots can allocate slot numbers beyond the configured count | Fixed. |
| 15 | Med | Actor type silently changed | Fixed: a name's type cannot change; presets only for existing agents. |
| 16 | Low | Failed auth and some outcomes not audited | Fixed: failed authentication is audited once a minute (no token content); needs-step-up is audited. |


### Phase 4 round 2 (fix diff only, last round) and dispositions
- 1 (High) error-text matching could refund an approval: fixed, a typed `GitHubError.status` 4xx (or a failure before any mutating call) is a definite refusal; everything else keeps the approval consumed and the re-run quota used.
- 2 (High) a stolen human token can lock the human out of step-up: accepted as a denial of service only (fail-safe, no bypass). Remedy is local: `ctl-admin.ts unlock-totp` as ci-control, which an agent holding just an API token cannot run. A hardware/origin-bound factor (WebAuthn) remains the real fix.
- 3 (High) hourly cap was per actor: fixed, the 6 per hour cap is global across actors.
- 4 approval lost on a failed pre-mutation re-read: fixed (PreMutation boundary releases it). 5 cancel/delete currentness: head SHA and run state are checked on a fresh read; a "superseded" check is deliberately NOT applied to cancel or delete (cancelling or deleting a superseded run is harmless and wanted). 6 approval request and its audit row are not one transaction and a TOTP code can be consumed before the intent row: accepted (low impact: a dangling pending request expires; a burnt code is re-entered).
- 7 post-mint cleanup could be forgotten: fixed, the runner is attached to the failed reservation so teardown removes it and cannot finish without it. 8 pause during start: re-checked before mint and before delivery; a slot that already took a job is never killed by a pause.
- 9 failed-auth flush and lockout audit: fixed (timer flush, lockout rows). 10 empty project: fixed. 11 wording: 'attempt' is now 'intent'. Re-run approvals also bind the reason the approver saw.
- Not re-reviewed after this round (limit reached). Still open before any exposure beyond this machine: independent audit receiver (R11), WebAuthn step-up.


## 6. Control layer: actions, tiers, approvals

One API. The dashboard and the MCP server both call it. The server decides; clients cannot bypass.

| Tier | Actions | Who may do it |
|---|---|---|
| **Read** | status, slots, runs, run detail, jobs, queue, audit log, resource usage, diagnose ("never ran" vs "failed") | humans and any authenticated agent |
| **Reversible** | pause/resume all, pause/resume one slot, set a slot count within limits, **re-run failed jobs of a run** (guardrails below) | humans; agents if their token allows it |
| **Gated** | cancel run, force-cancel, re-run the whole run (all jobs), delete a finished run, kill a running job's container, restart a slot, register/deregister a project | humans via dashboard confirmation; **agents only create a pending request** that a human approves |
| **Never exposed** | read/export the App key, change policy or tiers, disable the audit log | nobody through the API (local admin only) |

Notes:

- **Agent re-run guardrails (decided by the owner):** agents may re-run only the *failed jobs* of a run, at most 2 automatic re-runs per run, and a global hourly cap (default 6). If the same run fails again after its second re-run, the tool refuses further re-runs and tells the agent to report to a human. Each re-run is audited with the agent identity and the reason the agent gave. Repeated failures of the same job are flagged as suspected flakiness, which per the repo's CI rules is fixed, not retried.
- "Pause one specific run" is not a GitHub feature. Honest options: hold the slot before the run starts, or cancel and re-run later.
- Delete uses GitHub's delete-run endpoint and only works on finished runs; force-cancel exists for stuck runs. Exact permission names to be confirmed against GitHub docs when building (open item V2).
- The credential for cancel/delete/re-run (Actions: write) is **separate** from the credential for minting runner configs, and neither is inside any job container.
- Every call writes an audit row: who (person or named agent), action, target, result, timestamp, and for gated actions who approved.
- Gated action flow: agent calls tool, API returns `pending approval #42`, dashboard shows it with context, human approves or rejects, result is returned to whoever polls the request.
- **Approval binding (R6):** an approval is bound to the exact action, repository, immutable target (run id plus head SHA), parameters and an expiry (default 15 min); it is single-use; at execution the daemon re-reads the target's state and refuses if it changed (for example the run finished or was superseded). The approve endpoint is a different credential class that agent tokens can never use, and approving needs a step-up the agents do not hold: WebAuthn (origin-bound passkey) preferred, TOTP only as a fallback with each code consumed once. The confirmation shows the exact action details and is consumed once. Out of scope unless OS or device isolation is added: an agent that controls the human's own browser or desktop session could approve after the human authenticates.
- **Re-run guardrails enforced atomically:** re-runs are serialized per run; the intent is persisted before the GitHub call and its result after, and an uncertain outcome (crash, timeout) is reconciled against GitHub before any retry; the per-run counter and hourly cap are checked in one DB transaction (calls GitHub rejects do not consume quota; uncertain outcomes do until reconciled); attempt number, head SHA and workflow are re-checked immediately before the call; changes to an allow-listed workflow file go through protected review (CODEOWNERS); re-runs are refused for workflows not in the project's `rerun_allowed_workflows`, for deploy/migration lanes, and for superseded runs (section 6a).

---

## 6-perm. Permissions are data, edited in the dashboard (the owner 2026-10-29)

Replaces the fixed agent tier list: the tiers are only the DEFAULT preset. A Settings > Permissions page holds a matrix of agent (Claude, Codex, Gemini, any new one) x action (view logs, pause/resume, re-run failed, full re-run, cancel, kill, delete, restart runner, register project...). Each cell is Deny / Ask me (creates a pending approval) / Allow, with optional limits (re-runs per run and per hour, allowed workflows, expiry such as "Allow for 24h"). Stored in the controld database, enforced server-side on every call, read fresh each request, so a change needs no code change or restart. Presets: Cautious (default), Trusted, Read-only.

Rules that stay in code (not editable from the page):
- Agents can never edit permissions, approve requests, or read the GitHub App key or approval secrets; no MCP tool exists for these.
- Changing a permission needs the same step-up (WebAuthn, TOTP fallback) as an approval, and is written to the audit chain with who/what/before/after.
- Hard ceiling: actions on superseded runs and on no_supersede/deploy lanes stay refused; isolation, egress filter and audit settings are not on the page at all.
- A permission is per agent token; the honest identity limit (all agents share one OS account) still applies.

## 6a. Superseded runs: a new push to a PR cancels the older CI (the owner's requirement)

Today `ci.yml` runs only on `pull_request` and declares `concurrency: group: ci-pr-<PR number>, cancel-in-progress: true`, so GitHub itself cancels the older run of the same PR when a newer push arrives (verified by reading the workflow). GitHub decides; our service must follow, never fight it.

Rules:

1. **Never start a runner for a run that is no longer current.** Immediately before minting a JIT config the poller re-reads the run; if it is cancelled, completed, or superseded, it releases the reservation and does nothing. **Superseded** is defined by workflow + PR number + head SHA: the run's head SHA is no longer the PR's current head, or a newer run of the same workflow exists in the same concurrency group. A re-run attempt of the same SHA (same run, higher `run_attempt`) is *not* a newer run. This check narrows the race but cannot close it: the run can be cancelled, or another run taken, right after the check; rules 3 and 4 handle that.
2. **If several queued runs exist for the same PR, only the newest is eligible.** Older ones are skipped (GitHub will cancel them anyway); this closes the race where we would spend a slot on a run that is about to be cancelled.
3. **A running job whose run gets cancelled is torn down.** Teardown is based on the job the runner **actually took**, never on the run it was launched for: a JIT runner is not bound to one job, so a runner started for run A may execute run B. Every runner gets a unique name per reservation; GitHub's job objects name the runner that executes them, and the broker keeps the mapping container (named by reservation id) to runner name to actual job and run. Only a container proven to host a job of a cancelled run is touched. GitHub sends the cancel to the runner and the runner ends the job; if the container is still alive after a grace period (default 60 s) the broker force-stops it. Force-stop is **best effort**: it can interrupt cleanup steps and leave external side effects, so it never applies to lanes marked `no_supersede`, and incomplete cleanup is recorded in the audit. Ambiguous states (job not yet identified) are left alone until the idle timeout, never killed. It is a policy action driven by the workflow's own cancel rule, not an agent decision, so it needs no approval and is audited as `system: supersede-teardown`. It is unrelated to "pause", which never kills a job.
4. **Idle JIT runners are removed.** A runner started for a job that was cancelled before pickup is torn down within the idle timeout, and its GitHub registration is cleaned up (reconcile loop, R9).
5. **Agents and the dashboard never re-run a superseded run.** Agent re-run tools refuse a run that is superseded (definition in rule 1) or whose cancellation came from concurrency, and point to the newest run instead. The only exception is a human: an approved, gated `ci_rerun_all` on a superseded run, shown with a warning.
6. **Reporting is truthful.** The dashboard and `ci_diagnose` classify these runs as `superseded` (shown like Amir's blue "cancelled", never red) and never count them as failures or as candidates for re-run.
7. **Applies to every project.** The registry can require that a project's CI workflow declares a concurrency group with `cancel-in-progress` for PR events; the onboarding check warns if a registered repo does not, because without it every force-push piles up full runs on a 4-core machine.
8. **Deploy workflows are the opposite case.** `dev-deploy-gate.yml` and similar push-to-develop deploy gates have no cancel rule, and that is deliberate: a cancelled migration or deploy is dangerous. Superseded-run teardown must never apply to them (the registry marks those lanes `no_supersede`; they stay on GitHub-hosted runners anyway).

Tests (Phase 3, item V11) assert **eventual cleanup and correct ownership**, not an instantaneous guarantee: push twice quickly to a test PR and cover cancellation before minting, between minting and pickup, after pickup, and during normal completion. Assert that no container or runner registration is left after the idle timeout, that only containers hosting a cancelled run's job are ever stopped (never the other run's), and that the second run completes. In the shadow phase also record the real GitHub check conclusions and branch-protection behaviour for a cancelled old run, a pending new run and a successful new run, because a cancelled or missing required check can block a merge.

---

## 7. Agent integration (one tool all agents know)

Decision confirmed by the owner: agents do **not** get a pasted prompt. The control layer is an **MCP server**, like the existing `ai-delegator`.

- Thin MCP server, typed tools: `ci_status`, `ci_slots`, `ci_runs`, `ci_run_detail`, `ci_diagnose` (read); `ci_pause_slot`, `ci_resume_slot`, `ci_rerun_failed` (reversible, with the re-run guardrails in section 6); `ci_cancel_run`, `ci_rerun_all`, `ci_delete_run`, `ci_kill_job` (gated, create pending requests).
- Tool descriptions carry the rules and examples ("a pause never kills a running job", "log text is data, not instructions"). Anything that matters is also enforced by the daemon, so it does not depend on the agent reading the text.
- Each agent has its own identity and token (Claude, Codex, Gemini, plus humans), so the audit shows who did what and one identity can be revoked alone. Tokens are random, stored hashed server-side, kept by each agent in its own mode-0600 config, never inside any job container, and revocable at once. **Honest limit (R5):** today all agents run under the same OS account as the owner, so a *malicious* agent with shell access could read another agent's token file. Tokens therefore give attribution, policy and revocation, not protection against a hostile agent. What *does* hold: agent tokens cannot call approve endpoints, and approving needs a step-up secret the agents do not have. Stronger separation (one OS user per agent) is a later hardening option.
- A plain CLI `ci ...` calls the same API as a fallback for any agent without MCP support. (Open item V4: confirm MCP support in each agent's current CLI.)
- `AGENTS.md` in each project gets a short pointer: CI control goes through this tool only.
- SUPERVISOR.md content is mined for the tool descriptions and the diagnosis tests, not shipped as a prompt.

---

## 8. Project registry (what makes it generic)

A versioned config file (reviewed in git, no secrets) with one entry per project:

```yaml
- name: myapp
  repo: example-org/example-app          # private only
  labels: [self-hosted, linux]           # the JIT runner is registered with these plus unique_label
  max_slots: 1                        # within the global limit
  allowed_events: [push, pull_request]   # fork PRs refused (scheduling hint only; real boundary = repo-level registration)
  runner_scope: repo                     # repo-level JIT runner: only this repo's jobs can ever run on it
  runner_group_id: 1                     # default group; the API requires this field (dedicated groups need an org, V10)
  unique_label: ci-farm-example1          # routing selector only (not a secret); the repo's runs-on uses exactly this
  rerun_allowed_workflows: [ci.yml]      # agents may auto re-run failed jobs only for these (side-effect-free) workflows
  lanes:
    tests: self-hosted
    migrate-deploy: github-hosted     # never on this box
  resources: { memory: 6g, cpus: 3, pids: 4096 }
```

Adding a project = one entry plus one workflow label change in that repo. No code edits.

---

## 9. ExampleApp specifics

- Today every workflow uses `runs-on: ubuntu-24.04`. The move changes `ci.yml` (and any lane we choose) to `runs-on: [self-hosted, linux, <the project's unique_label>]` (for example `ci-farm-example1`). That is a change in ExampleApp's CI topology and needs the owner's approval and the repo's normal PR flow (full local prepush suite first, one push).
- `dev-deploy-gate.yml` / `prod-deploy-gate.yml` (migrations, `DATABASE_URL_DIRECT`) stay on GitHub-hosted runners.
- Render keeps deploying on `checksPass`; checks from self-hosted runners report to GitHub the same way. To be proven in shadow mode, not assumed (open item V5).
- **Shadow mode must be unambiguous (R12):** shadow jobs run with distinct check names that are *not* required checks, can never deploy or publish, and are removed once the cut-over is decided. Before cut-over we verify how Render and branch protection treat two checks for the same commit.
- **Superseded runs (user requirement):** `ci.yml` already has `concurrency: group: ci-pr-<PR number>, cancel-in-progress: true`, so a newer push cancels the older run of the same PR. The CI service must honour that end to end (section 6a).
- Capacity: 6 GB per active runner (Amir's figure, to be measured) on ~21 GB RAM with the dev PC also in use means **1 slot while working, 2 when idle** as the starting point. A ~20-minute full run is expected to be slower than hosted on a 4-core laptop CPU; measured in shadow mode.
- Playwright is Chromium only today, matching the image we must supply.
- Until 2026-11-01 the local prepush suite remains the interim; this project does not block ExampleApp delivery.

---

## 10. Phases and exit criteria

| Phase | Work | Exit criteria |
|---|---|---|
| 0. Decisions | Done 2026-10-29 (section 12) | Closed |
| 1. Plan review | Independent review by a different provider (Codex, read-only), max two rounds. Round 1 done (13 findings applied); round 2 reviews only the fix diff | Findings fixed or rejected with reasons |
| 2. Spike | Rootless Docker / nested Docker / Playwright / Postgres / memory limits on this machine (sudo by the owner) | Section 5 criteria pass, or backend decision made |
| 3. Repo + core | New private repo; registry; poller; JIT minting (needs GitHub App, installed only on a throwaway private test repo and never on ExampleApp before Phase 6b); launcher; isolation interface; tool's own tests | A test repo job runs end to end on a JIT runner, then everything is destroyed |
| 4. Control + audit | API, tiers, approvals, audit log | Tier rules proven by tests; denied actions logged |
| 5. Dashboard | Web UI for all actions in section 6, plus live and historical CPU/RAM (machine and per slot) | Every action usable and logged; resource numbers match `htop`/`free` within a few percent |
| 6. Agent tools | MCP server + CLI + `AGENTS.md` pointer | Each agent can read, and is blocked from gated actions without approval |
| 6b. Security review gate | Independent security review of the built tool (code + deployed config) **before** any real repo or credential is attached | No open high findings; tier, approval, isolation and supersede tests all pass |
| 7. Shadow on ExampleApp | Run the same checks on both hosted and self-hosted (after 2026-11-01 budget), compare results and timing. Shadow jobs use distinct, non-required check names and can never deploy (section 9) | Equal results, acceptable duration, Render still deploys correctly, no ambiguity in required checks |
| 8. Cut over | Switch chosen lanes; keep hosted fallback label | the owner approves |
| 9. Ongoing review | Re-review after any material change; periodic base-image and dependency refresh | No open high findings |

Working method: Sonnet at `high` for design and security-critical code with independent cross-provider review of those parts; Haiku `mechanic` only for fully specified boilerplate, with its diff read before use. Push-once discipline applies to every repo we push to.

---

## 11. Verification items (claims not yet confirmed)

| # | Claim | How to settle |
|---|---|---|
| V1 | GitHub App can mint JIT runner configs for a private repo with the permissions we plan to grant. **Partly confirmed 2026-10-29 from docs:** `POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig`, body `name`, `runner_group_id`, `labels` (all required), returns `encoded_jit_config`, requires repo admin. The docs page does not name the App permission; still to confirm | GitHub App permissions reference plus a dry run in Phase 3 |
| V2 | Exact App permissions for cancel / force-cancel / re-run / delete run. **Paths confirmed:** `POST .../actions/runs/{id}/cancel`, `.../force-cancel`, `.../rerun-failed-jobs`, `.../rerun`, `DELETE .../actions/runs/{id}`, `GET .../actions/runs?status=queued`. Permission names (expected: Actions write) not on those pages | GitHub App permissions reference |
| V3 | Rootless nested Docker is feasible on this machine | Phase 2 spike |
| V4 | Claude Code, Codex and Gemini all support MCP stdio servers in the versions installed | Check each CLI |
| V5 | Render `checksPass` works with checks reported by self-hosted runners | Shadow run |
| V6 | Real RAM per active runner and real CI duration on this CPU | Measure in spike and shadow run |
| V7 | GitHub forbids a private fork of a public repo (so we copy, not fork) | Confirm in docs |
| V8 | App rate limits are enough for the polling plan. **Partly confirmed:** installation tokens get 5,000 requests/hour (more with over 20 repos), so one project polled every 20 s with a few job lookups is far inside it, and many projects need budgeting. Whether ETag/304 requests are free is not stated in the rate-limit page; measure `x-ratelimit-used` in Phase 3 | Measurement in Phase 3 |
| V9 | The runner can read its JIT config in a way that avoids the process command line (for example an environment input), and exact delivery is leak-free | Runner source/docs plus spike check |
| V10 | `generate-jitconfig` accepts a runner group id and custom labels as the plan assumes; expiry of an unused JIT runner; cleanup API for stale registrations | GitHub docs plus dry run |
| V11 | GitHub's exact concurrency behaviour (cancel-in-progress of running and pending runs), that a cancelled run's job on a JIT runner receives the cancel and ends, that job objects reliably name the runner that executed them, and how required checks and Render treat a cancelled old run plus a new run | Phase 3 tests with two quick pushes (cancel before mint, before pickup, after pickup, at completion), then shadow phase |

---

## 12. Decisions (closed by the owner, 2026-10-29)

1. **Repo:** `ci-farm`, private, under the owner's account.
2. **Machine:** this dev PC for now (spike and first runs); the design stays machine-independent so a dedicated box can replace it.
3. **Language:** TypeScript on Node 22.
4. **Dashboard:** small local web page (localhost only; remote access is a separate later decision).
5. **Agent permissions:** read + reversible (pause/resume + re-run of failed jobs under the section 6 guardrails). Everything else (cancel, full re-run, delete, kill, restart, register project) creates a pending request approved by the owner in the dashboard.
6. **ExampleApp lane change** (section 9): not approved yet; decided later, in Phase 8.

the owner-only actions later: creating the GitHub App in the GitHub web UI (walkthrough provided), running the `sudo` steps in the spike, approving gated actions and the final cut-over.

## 5e. Phase 6b whole-system review (Codex, 2026-10-30, commit b7bdbf2)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | Crit | Installer checks the dev checkout is clean/at HEAD, then root copies mutable files from it (TOCTOU); same for units and node_modules | Fixed (07f6c1a): root rebuilds everything from the typed FULL commit's git objects, recomputing every SHA-1 down commit -> tree -> blobs, refuses symlinks/submodules; zod/yaml fetched from npm and checked against the verified lockfile's sha512; node binary hashed in the staging dir. Dry run (STAGE_ONLY=1) matches the checkout byte for byte; a tampered blob is refused (tested). Residual: the script text itself comes from `git show` run by the user before sudo. `setup-control-user.sh` (one-time, already run) keeps the old pattern. |
| 2 | High | `trusted` preset / any Allow cell lets an agent run cancel, rerun_all, delete directly, against the plan's "agents only create a pending request" | ACCEPTED by the owner (2026-10-30): agents handle cancel/re-run-all/delete themselves. Applied the `trusted` preset to claude, codex and gemini (`ctl-admin.ts preset <agent> trusted`). Still Ask: kill_slot, restart_slot; still Deny: register_project; hard ceilings unchanged (2 per run / 6 per hour re-runs, never superseded or deploy-lane runs). Verified live: cancel executes directly, kill_slot creates a pending request, register_project is refused. Every call is in the audit chain; the grid stays editable in the dashboard (TOTP). New agents still start on `cautious`. |
| 3 | Med | A job that finishes between polls is logged `failed: container exited before a job started` and skips the post-pickup allow check | Fixed: when the container is gone, GitHub is asked first; a completed job becomes finished, a disallowed one fails with that reason, an unknown outcome says so. Test added. |
| 6 (r2) | Med | Approval request and its pending audit row not atomic | Fixed: `Audit.atomically`, rollback test. |
| 2 (r2) | - | Stolen human token can lock out TOTP | Accepted (fail-safe denial of service, noted in 5d). |

Round-2 table: 9 FIXED, 2 PARTLY (above). Exposure verdict from the reviewer: not yet safe to attach a real repo until the Critical/High items are resolved and the standing Phase 6b gates (audit receiver, persistent egress rule, disk guard, pinned slot image) are met.

## 7. Audit receiver design (R11) — DRAFT, not built

**Problem.** The audit chain lives in `control.sqlite`, writable by `ci-control`. A compromised controller (or anything that becomes it) can rewrite the whole chain and recompute every hash; `verify()` would still say "intact". Today only edits and mid-chain deletes are caught, and only against that same database.

**Goal.** Keep a second copy of every audit row that the controller can append to but can never alter, truncate or read back as authority, so history written before a compromise stays trustworthy.

**Components.**
1. `ci-auditd`: a small daemon (Node, no dependencies) run by a new system user `ci-audit` that owns nothing else. Listens on a Unix socket `/run/ci-audit/audit.sock` (group `ci-control` may connect, same pattern as the broker). Writes to `/var/lib/ci-audit/audit.jsonl`, directory 0700 `ci-audit`, file marked append-only (`chattr +a`, set by the root installer), so even a compromised `ci-audit` cannot rewrite or truncate it without root.
2. The receiver validates every row before appending: `seq` = last + 1, `prev_hash` = its own last hash, and the row's hash recomputes with the same function as `audit.ts`. Anything else is refused and counted. It never trusts the sender's claim about its head.
3. The controller streams rows after they commit locally: a sender loop asks the receiver for its head, then sends every local row beyond it, in order, one request per connection (same framing rules as the broker). A heartbeat every 30 s carries the local head so a silent period is distinguishable from an outage.
4. The receiver records a heartbeat line on every state change and at least every 5 minutes, and each refusal as its own line, so a gap, a rewind attempt or a long silence is visible in the receiver's log, not only in the controller's.

**Failure policy.**
- Receiver down or behind: reads, pause/resume and Ask-requests carry on and queue (rows are in the database; the sender resumes from the receiver's head). Gated actions that change GitHub (cancel, delete, re-run all, kill, restart) are refused while the receiver is unreachable or more than 5 rows behind. "No independent record, no destructive action."
- Dashboard shows a banner: receiver head vs local head, lag, last heartbeat age, refusals. Red when unreachable for over 2 minutes or any refusal.
- On a hash mismatch between receiver and local chain (same seq, different hash, or local shorter than receiver) the controller flags `AUDIT TAMPERED`, stops starting jobs (like pause) and tells the human.

**Off-machine anchor.** The receiver writes a checkpoint line (seq, hash, time) every hour. Automatic export to somewhere outside the machine needs a credential for an external service, which is a new secret; for now the dashboard shows the latest anchor (seq + short hash) for you to save somewhere private, and a "verify anchor" call checks it against the receiver. A GitHub-hosted anchor can be added later if you want it.

**What it does NOT solve (stated).** A compromised controller can still append forged rows going forward (they chain correctly), root or anyone with sudo can still delete the file, and the machine itself is the trust base. A process that replaced the receiver's socket could lie consistently (echo the hashes it is sent): the protocol validates every reply and cross-checks every head against the local chain, but cannot beat a perfect liar, so the defence there is ownership: `/run/ci-audit` is `ci-audit:ci-control 2750`, only `ci-audit` can create the socket, `ci-control` and `dev` cannot. It makes silent rewriting of past history, and silent truncation, impossible without root, and makes any attempt visible.

**Install.** Root installer adds the `ci-audit` user, `/var/lib/ci-audit`, `chattr +a`, the tmpfiles entry for the socket, and `ci-auditd.service` (`Before=ci-controld.service`, controller `Wants` it, not `Requires`, so the failure policy above is what protects, not a hard start order). Same verified-staging installer as everything else.

**Tests.** Receiver unit tests: accepts a valid continuing chain, refuses gaps, rewinds, wrong prev_hash, wrong hash, oversized frames, second frame on one connection. Controller tests: sender resumes after an outage without duplicates; gated actions refused when the receiver is down or lagging; tamper flag when local and receiver chains disagree. Then Codex review of the finished code (max 2 rounds), like the rest.

**Decisions for the owner.**
1. Gated actions refused while the receiver is down (recommended) or allowed with a warning?
2. Off-machine anchor: manual for now (recommended), or GitHub-committed later?
3. Is the append-only attribute (`chattr +a`, ext4 only) acceptable? `findmnt -no FSTYPE /var/lib` shows the filesystem type.

**Review dispositions (Codex, 2026-10-30, commit 0959a85).** (1) High, replies were trusted by shape: fixed, every reply is strictly validated, the receiver's head must lie on the local chain, acknowledged rows must match what was sent, in_sync must equal the local head, lag must equal the difference; any inconsistency closes the gate (hostile-receiver tests). (2) Medium, overlapping rounds could look like tampering: fixed, single-flight; a round is also capped at 100 batches. (3) Medium, power cut mid-append bricked the receiver: fixed, a torn final line is terminated and a `recovered` record naming its byte length is appended; junk anywhere else is still tampering. (4) Low, observability and doc drift: socket path and heartbeat wording aligned; dashboard shows the receiver head and lag.

## 8. Watchdog and agent-triggered restarts (2026-10-30)

**Goal (the owner).** If a service is down or stuck, it comes back without anyone typing an admin password, and agents can ask for a restart themselves, without general admin rights.

**Why not sudo for agents.** Agents run as `dev`. A sudo or polkit rule for `systemctl` would also let them stop `ci-egress` (removing the firewall rule that keeps jobs off the LAN) or stop the receiver. So agents get no privileged path at all; they get one audited API action.

**Pieces.**
1. `ci-watchdog.timer` -> `ci-watchdog.service` (root, oneshot, every 30 s, code root-owned in /opt/ci-master, logic in `src/watchdog.ts`). Per service (controller, broker, audit receiver): not running -> restart; running but 3 failed health checks in a row -> restart. Health: controller `/v1/health` must answer AND its tick loop must have run in the last 300 s (`tickAgeS`), broker and receiver must answer on their sockets.
2. Agent action `restart_service` (service = controld | broker | auditd, plus a reason). It does not restart anything itself: the controller writes an empty file `request-<service>` into `/var/lib/ci-watchdog/requests` (root:ci-control 0730: the controller can create files there, not replace or read the directory). The watchdog matches names exactly, never reads contents, deletes the request first, then restarts. `ci-egress` is not in the list.
3. Limits: agent requests 3 per hour (control.ts, read from the audit log so it survives restarts, and again in the watchdog); all causes together 6 per hour per service. Past the budget the watchdog logs "a human must look" and stops, so a crash loop cannot be hidden by restarting forever. The action is in the grid (cautious and trusted presets: Allow, 3 per hour; read-only: Deny) and is not blocked by the audit-receiver gate, because the receiver may be the thing that is down.
4. `Restart=always` on broker and controller (systemd's own first line of defence); the watchdog covers stuck-but-alive and agent requests.

**What stays manual on purpose.** Installing new code (root, verified commit), changing the firewall service, registering repos, changing permissions (TOTP). If agents could trigger installs, anything an agent writes would run with the controller's rights.

**Existing agents** keep their current grid, which has no row for the new action (new actions start as Deny): grant it with `ctl-admin.ts set <agent> restart_service allow`.

**Review dispositions (Codex, 2026-10-30, commit a5ef2c3).** (1) Critical, restart budget could reset after a crash of the root watchdog: fixed, the restart is persisted (write, fsync, rename) BEFORE `systemctl restart` and nothing restarts if persisting fails; state is schema-validated; health replies are read with a 4 KB cap and validated; the socket client caps replies at 4 MB. (2) High, `Restart=always` outside the budget: fixed, every service has `StartLimitIntervalSec=600 / StartLimitBurst=10`; when systemd gives up the watchdog revives it (after `reset-failed`) within its 6-per-hour budget. (3) High, failed ticks reported healthy: fixed, `lastTick` moves only after a successful tick and a missing, non-finite or negative `tickAgeS` counts as unhealthy. Stated limit: a compromised controller can spoof its own health endpoint; this catches stuck, not malicious. (4) Medium, directory flooding: fixed, only the three fixed request paths are probed (never a directory listing) and must be plain single-link files. (5) Medium, request files bypass the API's limit and audit: the root-side budget is now ONE shared 3-per-hour for requests across all services; direct file creation by a compromised controller is still not attributed in the audit chain (the watchdog's journal records every action), which is accepted. (6) Low, root job hardening: added kernel/cgroup/namespace/address-family restrictions; `ProtectSystem` was left off because it cannot be tested without root and a wrong guess would silently disable recovery; verify the first run in the journal.
