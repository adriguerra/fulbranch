# Fulbranch

AI-powered development orchestrator: ingest Linear issues, queue work, implement changes via the **GitHub REST API** (no local clone), open draft pull requests, and run LLM review loops with a configurable cap on concurrent work.

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
| `LINEAR_WEBHOOK_SECRET` | Signing secret from your Linear webhook settings |
| `LINEAR_READY_STATE_ID` | Linear workflow state id that means “ready to implement” |
| `LINEAR_API_KEY` | Optional today; reserved for future Linear API use |
| `OPENAI_API_KEY` | Used for implementation (`gpt-4o`) |
| `ANTHROPIC_API_KEY` | Used for code review |
| `DATABASE_URL` | SQLite database path (see below) |
| `MAX_OPEN_PRS` | Max tasks in `in_progress` or `review` (default `3`) |
| `PORT` | HTTP port for the webhook server (default `3000`) |

Optional:

- `GITHUB_DEFAULT_BRANCH` — base branch for PRs (default `main`)
- `GITHUB_CONTEXT_PATHS` — comma-separated file paths in the repo to pass as codebase context to the implementer (default `README.md`)

See [.env.example](.env.example) for the full list.

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

Expose `POST /webhook/linear` to the internet (for example via a tunnel) so Linear can deliver webhooks. Use `GET /health` for a simple health check.

## Contributing

Issues and pull requests are welcome. Please avoid committing real tokens, webhook payloads, or production database files.
