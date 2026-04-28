# Integration Setup Guide

## GitHub

**`GITHUB_PAT`**

Go to [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens) → Generate new token (fine-grained) → select the target repo → grant:
- Contents: Read and write
- Pull requests: Read and write
- Metadata: Read (auto-selected)

If your org uses SAML SSO, open the token page after creation → "Configure SSO" → authorise the org.

**`REPO_URL`**

HTTPS URL of the repo the orchestrator will work against. Must match the repo the PAT has access to.

```
REPO_URL=https://github.com/your-org/your-repo.git
```

**`GITHUB_WEBHOOK_SECRET`**

Generate a random secret:

```bash
openssl rand -hex 20
```

Then go to Repo → Settings → Webhooks → Add webhook:
- Payload URL: `https://<NGROK_DOMAIN>/webhooks/github`
- Content type: `application/json`
- Secret: paste your secret
- Events: **Pull requests** only

Set the same value as `GITHUB_WEBHOOK_SECRET` in `.env`.

---

## Linear

**`LINEAR_API_KEY`**

Go to [linear.app](https://linear.app) → Settings → API → Personal API keys → Create key. Copy it immediately — it is only shown once.

**`LINEAR_WEBHOOK_SECRET`**

Generate a random secret (same method as above). Then go to Settings → API → Webhooks → New webhook:
- URL: `https://<NGROK_DOMAIN>/webhooks/linear`
- Secret: paste your secret
- Data change events: **Issues** only

Set the same value as `LINEAR_WEBHOOK_SECRET` in `.env`.

**Label**

Create an `orchestrator-managed` label in Linear: Team Settings → Labels → Add label. Any ticket without this label is ignored by the orchestrator.

---

## Slack

**`SLACK_WEBHOOK_URL`**

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch
2. Features → **Incoming Webhooks** → toggle on
3. Click **Add New Webhook to Workspace** → pick a channel → Allow
4. Copy the webhook URL — it looks like `https://hooks.slack.com/services/T.../B.../...`

---

## ngrok

**`NGROK_AUTHTOKEN`**

Sign in at [dashboard.ngrok.com](https://dashboard.ngrok.com) → Your Authtoken (left sidebar) → copy.

Run once to save the token locally:

```bash
ngrok config add-authtoken <your-token>
```

**`NGROK_DOMAIN`**

Dashboard → Cloud Edge → Domains — your reserved static domain (free accounts get one). Use the hostname only, no `https://`.

```
NGROK_DOMAIN=your-name.ngrok-free.app
```

Start the tunnel:

```bash
ngrok http --url=<NGROK_DOMAIN> 3000
```
