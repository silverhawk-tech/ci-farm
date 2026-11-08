# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting for this repository (Security tab, "Report a vulnerability"). Include what you found, how to reproduce it, and what an attacker gains. You should get a first answer within a few days.

## What ci-master protects, and what it does not

ci-master runs untrusted pull request code on your own machine. The design goals, in order:

1. A job must not reach your network (LAN, router, link-local, Tailscale ranges, host loopback) or anything with secrets.
2. A job must not be able to take control of the controller, the audit receiver or the GitHub App key.
3. Every action of an agent or a person except routine successful reads (`status`, `runs`, `resources`, and throttled `audit_read`; denials are always logged) is recorded, and whether an agent needs human approval with a second factor for destructive actions depends on its permission preset (**Cautious** asks; **Trusted** or `Allow` cells let agents cancel, delete and re-run without asking, while humans always need a fresh second factor for gated actions).
4. No secret lives in this repository or in an image, and among credentials supplied by ci-master the GitHub App key never reaches a job container: a job container gets only its own one-time runner credential and GitHub's job-scoped token (both useless once the job ends), while any secrets a workflow itself requests are delivered into that job by GitHub, so deploy and migration lanes that hold real secrets must stay on GitHub-hosted runners.

Read [docs/DESIGN-PLAN.md](docs/DESIGN-PLAN.md) for the model and [docs/SECURITY-REVIEW-2026-11-01.md](docs/SECURITY-REVIEW-2026-11-01.md) for the latest independent review and what was done about each finding.

## Known limits (stated on purpose)

- **Use private repositories only.** A pull request from a stranger is code you run. Never register a public repository.
- **Agents and the owner share one OS user.** Per-agent tokens give separate audit trails and permission grids, not a hard boundary between agents.
- **The audit log is tamper-evident, not tamper-proof against a compromised controller.** The independent receiver keeps its own append-only copy and detects edits, deletions and truncation of past rows. A controller that is already compromised can still append false rows from then on. Keep the anchor (sequence number and hash, shown in the dashboard) somewhere off the machine.
- **A runner can take any job that matches its labels.** A just-in-time runner is not bound to the job it was started for. Secrets must therefore come only from a GitHub environment restricted to the right branch, and lanes that hold real secrets (database migrations, deploys) must stay on GitHub-hosted runners.
- **The one-time runner credential is visible to the job that owns it** (it is in the slot's process environment). It is single use, belongs to that job's own runner, and ends with the job.
- **Job network is IPv4 only and filtered by address range**, not by destination name. A job can reach any public IPv4 host. If you need a strict allow-list, put a domain-based proxy in front of the slot.
- **Pinned slot image.** The slot base image is pinned by digest and its packages by a snapshot id (except the `ca-certificates` bootstrap, which comes from the signed live archive); bump both deliberately.
- **No IPv6 for jobs.** All IPv6 from the job user is refused, so a job that needs an IPv6-only host will fail.
- **No per-slot disk or inode quota yet.** A job can fill the host's disk; the controller only stops new starts when free space is low.

## Supported versions

Only the latest commit on the default branch is supported.
