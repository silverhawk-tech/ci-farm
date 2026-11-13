# ci-master

A self-hosted GitHub Actions CI farm for one Ubuntu machine. Every job runs in a disposable, rootless-Docker slot with its own one-time runner credential. A local dashboard and one tool for AI agents control it, and every action they take is audited.

Private repositories only. No secrets in this repo or in images, and among credentials supplied by ci-master the GitHub App key never reaches a job container: a job gets only its own one-time runner credential and GitHub's job-scoped token, while any secrets a workflow itself requests are delivered into that job by GitHub, so deploy and migration lanes that hold real secrets stay on GitHub-hosted runners.

Status: in real use since 31 October 2026. The one-click installer was tested in a clean Ubuntu Server 26.04 VM (install, self-check, rollback, uninstall); a fresh install with a live GitHub App is not tested yet (see [Status](#status)). Licensed under [Apache-2.0](LICENSE). Security policy and known limits: [SECURITY.md](SECURITY.md).

⭐ Staraware. If this saves you time, star the repo.

## What it looks like

The dashboard (sample data from the built-in preview, not a real run):

![ci-master dashboard](docs/images/dashboard-overview.png)

The same view on a phone, in the compact layout:

<img src="docs/images/dashboard-phone.png" alt="ci-master dashboard on a phone" width="320">

## What it does

- **Runs CI on your own machine instead of GitHub-hosted minutes.** Pull request CI for a full-stack project (lint, tests, build, a real PostgreSQL, browser UI regression, a Docker image smoke test) takes about 15 to 20 minutes and uses none of the monthly free minutes.
- **One disposable slot per job.** A poller watches for queued jobs, reserves a slot, mints a just-in-time runner credential through a GitHub App, runs the job in a throw-away rootless Docker environment, and tears everything down afterwards.
- **Locked-down network.** Slots sit behind an egress filter (nft) that blocks private and local ranges.
- **Several projects, several isolation groups.** A registry (`config/registry.example.yaml`) lists each repository with its own runner label, resource caps, allowed events and lanes. A push-triggered lane can be limited to named branches.
- **Deploy lanes stay on GitHub.** Anything that holds real secrets (database migrations, deploy hooks) is never scheduled on the farm. Builds that need no secrets, such as building and pushing a container image with the job's own token, can run on it.
- **A dashboard** with machine CPU and RAM, per-slot usage, run history with PR titles and branches, per-job chips (`changes`, `gates`, `content-bank`, ...), a progress bar with the current step, approvals, and the audit log. "Clear finished" hides finished runs in your browser only; nothing is deleted on GitHub.
- **One tool for AI agents** (an MCP server plus a CLI), used by Claude Code, Codex and Gemini. Agents can read status and runs, and can do reversible things such as pausing a slot or re-running failed jobs within limits. Whether dangerous actions (cancel a run, re-run all jobs, delete a run, kill a job) need human approval in the dashboard with a second factor depends on the agent's permission preset: **Cautious** (the default) asks for approval, while **Trusted** (or `Allow` cells) lets agents cancel, delete and re-run without asking (`kill_slot` and `restart_slot` still ask by default). There is deliberately no tool to approve, to edit permissions or to read the GitHub App key.
- **A tamper-evident audit log.** Every action except routine successful reads (`status`, `runs`, `resources`; `audit_read` is logged at most once per actor per 5 minutes), including denials, is recorded in a hash chain, and an independent receiver keeps a second copy.
- **A watchdog** restarts a down or stuck service, and agents can request a restart without a password.
- **Optional Telegram notifications.** One message per finished job, with the repository, the pull request, the duration and a link. Successes are silent, failures ring and carry one of a few fixed reasons. It is one-way and uses your own bot (see [Telegram notifications](#telegram-notifications-optional)).

The services: `ci-controld` (poller, control API and dashboard), `ci-broker` (rootless Docker slots), `ci-auditd` (independent audit copy), `ci-egress` (network filter) and `ci-watchdog`.

## What we achieved so far

- Design, an isolation spike and several independent security reviews (findings fixed or explicitly accepted in the design plan).
- A working core: registry, poller, JIT runner minting, slot lifecycle, resource caps, and a state database that is reconciled after a restart.
- The control layer: dashboard, per-agent permissions, human approvals with a second factor, the audit chain and its independent receiver, and the watchdog.
- Multi-project support with isolation groups, and a push-branch guard for lanes that react to pushes.
- Real use: a full-stack project runs its pull request CI on the farm, switched on and off by one repository variable. Its API container image is built, smoke-tested and pushed to a private registry on the farm, then deployed by digest.
- Dashboard improvements: progress bar with the current step, run titles and branches, job chips, clear finished.
- A busy runner is never torn down by the idle timeout. Before this fix a long job could be killed while it was running and GitHub then reported "runner lost communication" about 20 minutes later; the controller now asks GitHub whether the runner is busy and finds the job a runner took across all run statuses.
- Optional one-way Telegram notifications per finished job.
- Over 200 automated tests, and an independent open-source readiness review with every finding handled (see the security review above).

## Telegram notifications (optional)

The farm can send you one Telegram message when a job ends, so you notice failures and repeated problems without watching the dashboard. It is off until you give it a bot, and it never receives commands. No bot or token ships with this repository: you create your own.

**1. Create the bot.** In Telegram open `@BotFather`, send `/newbot`, choose a display name and a username that ends in `bot`. BotFather replies with a token that looks like `1234567890:AAH...`. Treat it as a secret. Then open your new bot and press Start (a bot cannot message you until you have written to it once).

**2. Find your chat ID.** For a private chat it is your own numeric Telegram user ID. Without leaving the token in your shell history:

```bash
read -rs TOKEN; curl -s "https://api.telegram.org/bot$TOKEN/getUpdates" | python3 -c "import sys,json; print([m['message']['chat']['id'] for m in json.load(sys.stdin)['result'] if 'message' in m])"
```

A group chat has a negative ID.

**3. Give the farm the two values.** Add them to `/etc/ci-master/controld.env` (no quotes, no spaces around `=`) and keep the file root-only:

```
TELEGRAM_BOT_TOKEN=<your token>
TELEGRAM_CHAT_ID=<your chat id>
```

```bash
sudo chmod 600 /etc/ci-master/controld.env
sudo systemctl restart ci-controld
```

**4. Test it.** This sends one test message using the values from the file and prints only whether Telegram accepted it:

```bash
sudo bash -c 'set -a; . /etc/ci-master/controld.env; curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" -d chat_id="$TELEGRAM_CHAT_ID" -d text="ci-master: test message" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get(\"ok\"), r.get(\"description\",\"\"))"'
```

`True` means it worked. `chat not found` means a wrong chat ID or you have not pressed Start; `Unauthorized` or `Not Found` means a wrong or cut-off token (a token has a colon in the middle).

**What a message contains.** The repository, the pull request number if there is one, the duration and a link to the job; a failure adds one of a few fixed reasons (for example "no job picked up before the idle timeout"). No job logs and no other text from GitHub or the broker are ever sent. Delete the two lines (or leave them empty) and restart `ci-controld` to turn it off. More details are in [docs/AGENT-TOOLS.md](docs/AGENT-TOOLS.md#telegram-notifications).

## Install

You run the installer yourself, in your own terminal, on the machine that will host the farm. Do not ask an agent to run it: it needs root and prints a secret that is shown only once. Agents come in afterwards, through the limited tools in [docs/AGENT-TOOLS.md](docs/AGENT-TOOLS.md).

**You need:**
- Ubuntu 24.04 or newer on x86_64 with at least 4 CPUs, 8 GiB RAM and 30 GiB free under /var/lib (a 60 GB disk is comfortable).
- One **private** GitHub repository you want CI for.
- A GitHub App installed on that repository, with its App ID, its installation ID and the downloaded `.pem` key file. Expected repository permissions, read from the code and not yet confirmed against a live install: Actions (read and write), Administration (read and write, for runner registration) and Metadata (read). The installer's final check, scripts/check-app.ts, prints the App's actual permissions.

**Steps:**

```bash
git clone https://github.com/silverhawk-tech/ci-farm && cd ci-farm
COMMIT=$(git rev-parse HEAD)
git show $COMMIT:scripts/install-farm.sh | less    # read it first
git show $COMMIT:scripts/install-farm.sh | CI_SRC=$PWD COMMIT=$COMMIT bash -s -- --dry-run    # no root, changes nothing
git show $COMMIT:scripts/install-farm.sh | sudo CI_SRC=$PWD COMMIT=$COMMIT bash    # the real install
```

The real run asks for the repository (`owner/name`), the App ID, the installation ID and the key's file path, then waits for you to type `install`. At the end it prints your second-factor secret and dashboard token once; save them then. To remove everything, run the same command with `--uninstall` (add `--purge` to delete data too).

## Status

This project is experimental. The installer was reviewed by a second AI provider, passes its unit tests and ShellCheck, and was tested in a clean Ubuntu Server 26.04 VM with a fake GitHub App (install, self-check, rollback, uninstall; only the GitHub App check failed, as expected). Not tested yet: a fresh install with a live GitHub App, and other distributions. Start with `--dry-run`. Before a real run, compare the pinned Node checksum in `scripts/install-farm.sh` with the one published at nodejs.org.

## Built with agents

This project is built with AI agents. A manager session splits the work, and implementer sessions (Claude Code, with Codex for some fixes) write each change as a pull request, and a different provider than the author reviews it. A second AI provider reviews the changes independently (Codex, and Gemini on some review rounds). Unit tests and ShellCheck are run on the changes before review. The tool that lets the agents call each other's providers is [ai-delegator](https://github.com/silverhawk-tech/ai-delegator).

## Related tools

- [ai-delegator](https://github.com/silverhawk-tech/ai-delegator): a local MCP server that lets Codex, Claude Code and Antigravity CLI delegate work to one another while the user keeps control of the provider, model and reasoning level.

## Documents

- Design and decisions: [docs/DESIGN-PLAN.md](docs/DESIGN-PLAN.md)
- Installer 1 (design note): [docs/INSTALLER-DESIGN.md](docs/INSTALLER-DESIGN.md)
- Agent tools: [docs/AGENT-TOOLS.md](docs/AGENT-TOOLS.md)
- Security: [SECURITY.md](SECURITY.md) and the latest review, [docs/SECURITY-REVIEW-2026-11-01.md](docs/SECURITY-REVIEW-2026-11-01.md)
- Rules for agents working here: [AGENTS.md](AGENTS.md)
- Attributions: [NOTICE](NOTICE)

## Development

```bash
npm test
```

The dashboard can be previewed with sample data using `npx tsx scripts/dev-dashboard.ts` (it listens on 127.0.0.1:8788 and prints a throw-away token).
