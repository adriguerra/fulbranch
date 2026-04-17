# Fulbranch

AI-powered development orchestrator: ingest Linear issues, queue work, implement changes via the **GitHub REST API** (no local clone), open draft pull requests, and run LLM review loops with a configurable cap on concurrent work. On each **push** to a branch that matches a tracked task, a signed `POST /webhook/github` handler can run a Claude review and post feedback on the pull request.

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
| `POST /webhook/github` | GitHub **push** events only (`X-GitHub-Event: push`): validates `X-Hub-Signature-256` with `GITHUB_WEBHOOK_SECRET`, resolves the branch from `ref`, loads the task by `branch_name`, and if the task is not `done` or `blocked`, runs the same reviewer as the orchestrator (diff → Claude → structured PR comment). Unknown branches are ignored silently. |

Configure a **repository webhook** on the target repo: content type JSON, **Push** events only, payload URL pointing at your deployed Fulbranch URL with path `/webhook/github`, and the same secret as `GITHUB_WEBHOOK_SECRET`.

## Database

The app uses **SQLite** by default. If `DATABASE_URL` is unset, the database file is created at `./fulbranch.db` in the current working directory.

- The schema lives in [`src/db/schema.sql`](src/db/schema.sql); tables are created on startup.
- **Do not commit** `.env`, `*.db`, or `*.db-journal` files. They are listed in `.gitignore` and may contain secrets or private issue data.

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
