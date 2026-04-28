# AI Dev Orchestrator

A backend server that converts Linear tickets into merged GitHub PRs with no manual coding involved. It listens for Linear webhooks, spins up Claude Code CLI agents in isolated git worktrees, runs an automated review loop, and either opens or auto-merges the resulting PR.

## How it works

1. A ticket labelled `orchestrator-managed` lands in **Todo** on Linear.
2. The server ingests it, resolves dependencies via topological sort, and dispatches a developer agent (Claude Code CLI) into a dedicated git worktree.
3. A reviewer agent inspects the diff and returns a `pass`/`fail` verdict. On fail, feedback is injected and the developer agent retries (up to `MAX_REVIEW_CYCLES`).
4. On pass, the PR is pushed to GitHub. With `AUTO_MERGE=true` the server merges it immediately; otherwise it waits for a human.
5. The merged PR unblocks dependent tickets, which are dispatched in the next wave.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Bun.js (TypeScript) |
| Database | Bun built-in SQLite |
| Agents | Claude Code CLI (`@anthropic-ai/claude-code`) |
| Repo isolation | Git worktrees |
| Issue tracking | Linear API + webhooks |
| Source control | GitHub API + `gh` CLI |
| Notifications | Slack Incoming Webhooks |
| Tunnel | ngrok |

## Project layout

```
orchestrator/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── prompts/               developer.md + reviewer.md — agent system prompts
└── src/
    ├── index.ts           boot sequence
    ├── config.ts          env validation
    ├── server/            HTTP server + webhook handlers (Linear, GitHub)
    ├── db/                SQLite client, migrations, repositories
    ├── orchestrator/      dispatcher, topological sort, semaphore
    ├── pipeline/          per-issue pipeline (worktree → dev → review → PR)
    ├── integrations/      linear / github / slack / claude
    ├── repo/              clone + pull target repo on boot
    ├── reconciliation/    5-minute poll loop (catches missed webhooks)
    ├── recovery/          resume interrupted runs on restart
    ├── types/             shared TypeScript types
    └── utils/             logger, retry helper
```

---

## Getting started

### Prerequisites

| Tool | Install |
|---|---|
| Bun ≥ 1.1 | https://bun.sh |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code` |
| GitHub CLI | `brew install gh` / https://cli.github.com |
| ngrok | `brew install ngrok/ngrok/ngrok` / https://ngrok.com |

### Environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in:

| Variable | Description |
|---|---|
| `GITHUB_PAT` | Fine-grained PAT — scopes: Contents R/W, Pull requests R/W, Metadata R |
| `REPO_URL` | HTTPS URL of the repo to manage (`https://github.com/org/repo.git`) |
| `GITHUB_WEBHOOK_SECRET` | Shared secret set on the GitHub webhook |
| `LINEAR_API_KEY` | Linear personal API key |
| `LINEAR_WEBHOOK_SECRET` | Shared secret set on the Linear webhook |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook URL |
| `CLAUDE_CODE_OAUTH_TOKEN` | 1-year token from `claude setup-token` (dev/staging) |
| `ANTHROPIC_API_KEY` | Pay-per-token API key (production — takes precedence over OAuth token) |
| `NGROK_AUTHTOKEN` | ngrok auth token |
| `NGROK_DOMAIN` | Your reserved ngrok domain |

Optional tuning (defaults shown):

```bash
MAX_PARALLEL_AGENTS=4       # concurrent Claude subprocesses
MAX_REVIEW_CYCLES=3         # reviewer iterations before NEEDS ATTENTION PR
AUTO_MERGE=false            # true = merge PR immediately after a clean reviewer pass
AUTO_MERGE_STRATEGY=squash  # squash | merge | rebase
REVIEWER_MODEL=claude-haiku-4-5
LOG_FORMAT=pretty           # pretty (local) | json (production)
```

### Webhook setup

**Linear:** Settings → API → Webhooks → create webhook pointing to `https://<NGROK_DOMAIN>/webhooks/linear`. Select **Issues** events. Set the same secret as `LINEAR_WEBHOOK_SECRET`.

**GitHub:** Repo → Settings → Webhooks → add webhook pointing to `https://<NGROK_DOMAIN>/webhooks/github`. Content type `application/json`. Select **Pull requests** events. Set the same secret as `GITHUB_WEBHOOK_SECRET`.

---

## Running locally

Add these path overrides to your `.env` (they point to local subdirectories instead of the Docker container paths):

```bash
REPO_PATH=./repo
WORKTREES_DIR=./worktrees
SQLITE_PATH=./data/orchestrator.db
```

**Terminal 1 — ngrok tunnel:**

```bash
ngrok http --url=<your-ngrok-domain> 3000
```

**Terminal 2 — server:**

```bash
bun install
bun run dev       # watch mode — restarts on file change
# or
bun run start     # single run, no watch
```

`bun run dev` / `bun run start` automatically runs `mkdir -p data repo worktrees` before starting, so no manual directory setup is needed. The repo is cloned on first boot and pulled on subsequent starts.

---

## Running with Docker

```bash
# First run (or after config changes)
bun run docker:build

# Start (no rebuild)
bun run docker:up

# Stop
bun run docker:down

# Wipe DB + cloned repo + worktrees and rebuild from scratch
bun run docker:fresh
```

Bind-mounted volumes (persist across restarts):

| Host | Container | Contents |
|---|---|---|
| `./data` | `/data` | SQLite database |
| `./repo` | `/repo` | Cloned target repository |
| `./worktrees` | `/worktrees` | Per-issue git worktrees |

> `data/`, `repo/`, and `worktrees/` are gitignored. Docker creates them automatically via the bind-mount definition; locally they are created by the `setup` script.

---

## Webhook endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhooks/linear` | Linear issue create/update events |
| `POST` | `/webhooks/github` | GitHub PR closed+merged events |
| `GET` | `/health` | Liveness probe — returns `{"ok":true}` |

---

## Labelling tickets

The orchestrator only picks up tickets that have the **`orchestrator-managed`** label. Any ticket without this label is silently ignored, regardless of its state.

To create the label in Linear: Team Settings → Labels → add `orchestrator-managed`.

For ticket dependencies, use Linear's native **blocking relations** (the "blocks" field on a ticket). The orchestrator reads these directly from the Linear API — no metadata in the ticket body is needed.

---

## Troubleshooting

**Server exits immediately on first boot**
Make sure `REPO_URL`, `GITHUB_PAT`, and at least one of `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` are set in `.env`.

**Tickets are not being picked up**
- Confirm the ticket has the `orchestrator-managed` label.
- Confirm the ticket is in **Todo** (not Backlog, In Progress, or Done).
- Check `GET /health` responds — if ngrok is not running, webhooks never arrive.
- The reconciliation loop runs every minute (`RECONCILE_INTERVAL_MS`), so tickets are also picked up on the next poll even if a webhook was missed.

**`claude` exited with code 1 / auth error**
The OAuth token generated by `claude setup-token` is tied to your Claude Pro plan's rolling 5-hour limit. Switch to `ANTHROPIC_API_KEY` (a pay-per-token API key from console.anthropic.com) for sustained throughput.

**`gh pr merge` fails (auto-merge)**
Branch protection rules on the target repo can block `--admin` merges. Either disable the rule, grant the PAT bypass rights, or set `AUTO_MERGE=false` and merge manually.

**Tickets stuck in `In Progress` after a crash**
On restart the recovery module re-queues any `running` or `reviewing` tickets automatically. If a ticket is permanently stuck, move it back to **Todo** in Linear — the reconciler will reset it to `pending` within one poll interval.

---

## Linear workflow states

The orchestrator maps to exactly four Linear states:

| Linear state | Meaning |
|---|---|
| **Backlog** | Safe setup column — tickets here are ignored until moved to Todo |
| **Todo** | Ready to be picked up and dispatched |
| **In Progress** | Agent is actively working |
| **In Review** | PR is open, waiting for merge |
| **Done** | PR merged |

---

## Tests

```bash
bun test                  # all tests
bun run test:unit         # unit tests (topo-sort, semaphore)
bun run typecheck         # TypeScript type check
```
