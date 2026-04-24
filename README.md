# Mainark

AI-powered development orchestrator: ingest Linear issues, queue work, implement changes via the **GitHub REST API** (no local clone), open draft pull requests, and run LLM review loops with a configurable cap on concurrent work. On **push**, Mainark can run an automated Claude review on the PR; on **submitted PR reviews** or **new PR thread comments**, it can pull human/bot feedback from GitHub and re-run the implementer against that thread so fixes are driven from real review discussion (for tasks stored in Mainark's DB).

## License

This project is open source under the [MIT License](LICENSE).

## Requirements

- Node.js 20+ (recommended)
- Accounts and tokens for GitHub, Linear, OpenAI, and Anthropic as described below

## Configuration

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

| Variable | Purpose |
| -------- | ------- |
| `GITHUB_TOKEN` | Fine-grained or classic PAT with repo contents and pull requests |
| `GITHUB_OWNER` | User or organization that owns the target repository |
| `GITHUB_REPO` | Repository name |
| `GITHUB_WEBHOOK_SECRET` | Secret for `X-Hub-Signature-256` on `POST /webhook/github` (create a GitHub repo webhook; use the same secret) |
| `LINEAR_WEBHOOK_SECRET` | Signing secret from your Linear webhook settings |
| `LINEAR_READY_STATE_ID` | Linear workflow state id that means “ready to implement” |
| `LINEAR_API_KEY` | Optional today; reserved for future Linear API use |
| `OPENAI_API_KEY` | Used for implementation (`gpt-4o`) |
| `ANTHROPIC_API_KEY` | Used for code review |
| `DATABASE_URL` | SQLite database path (see below) |
| `MAX_OPEN_PRS` | Max tasks in `in_progress` or `review` (default `3`) |
| `MAX_REVIEW_RETRIES` | After this many “needs work” outcomes, the task is marked `blocked` (default `2`) |
| `PORT` | HTTP port for the webhook server (default `3000`) |

Optional:

- `GITHUB_DEFAULT_BRANCH` — base branch for PRs (default `main`)
- `GITHUB_CONTEXT_PATHS` — comma-separated paths (files or directories) passed as codebase context to the implementer; directories are read recursively up to 200 files (default `README.md`)

See [.env.example](.env.example) for the full list.

## Webhooks

| Endpoint | Purpose |
| -------- | ------- |
| `GET /health` | Liveness; includes a small `openTasks` count |
| `POST /webhook/linear` | Linear issues: HMAC on raw body (`Linear-Signature`), enqueues work when an issue hits the “ready to implement” state |
| `POST /webhook/github` | Validates `X-Hub-Signature-256` with `GITHUB_WEBHOOK_SECRET`. Handles: **`push`** — branch → task by `branch_name`, runs Claude PR review (unless `done`/`blocked`). **`pull_request_review`** (`action: submitted`) — resolves task by PR number / head branch, runs the **implementer** if status is `in_progress`, **`fixing`**, or `review`. **`issue_comment`** (`action: created`, PR only) — same implementer trigger for new thread comments. Ignores untracked branches/PRs. |

Configure a **repository webhook** on the target repo: content type JSON, payload URL `…/webhook/github`, secret `GITHUB_WEBHOOK_SECRET`, and enable at least **Push**, **Pull request reviews**, and **Issue comments** (same endpoint handles all three).

## Database

The app uses **SQLite** by default. If `DATABASE_URL` is unset, the database file is created at `./mainark.db` in the current working directory.

- The schema lives in [`src/db/schema.sql`](src/db/schema.sql); tables are created on startup. Existing databases get new columns via lightweight **migrations** on startup (`latest_review_json`, `review_issue_hashes`, `repeat_count`).
- **Do not commit** `.env`, `*.db`, or `*.db-journal` files. They are listed in `.gitignore` and may contain secrets or private issue data.

**Task lifecycle (high level):** `pending` → `in_progress` (first implementation) → `review` → on failed review → **`fixing`** (address structured issues + optional GitHub thread) → `review` → … → `done` or **`blocked`** (max retries, or **repeat detection**: same issue fingerprint twice). The reviewer stores canonical JSON in `latest_review_json` (pass/needs_work, summary, typed issues with file + instruction). The implementer uses that JSON as the primary fix list when present; legacy `review_feedback` text and unstructured GitHub aggregation remain as fallback when no structured review exists.

PostgreSQL can be supported later by swapping the database layer; the schema is intentionally simple.

## Development

```bash
npm install
npm run build
npm run dev
```

Production:

```bash
npm run build
npm start
```

Expose `POST /webhook/linear` and (for push-triggered PR reviews) `POST /webhook/github` to the internet—for example via a tunnel such as ngrok—so Linear and GitHub can reach your server. Use `GET /health` for a simple health check.

## Contributing

Issues and pull requests are welcome. Please avoid committing real tokens, webhook payloads, or production database files.
