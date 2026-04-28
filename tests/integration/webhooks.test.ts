/**
 * Integration test for the webhook handlers.
 *
 * Verifies:
 *   - Linear webhook silently drops unlabelled tickets (§6.1 label filter).
 *   - Linear webhook rejects bad signatures.
 *   - Linear webhook ingests a well-formed orchestrator-managed issue.
 *
 * Env vars are set + a fresh in-memory SQLite DB is injected before any
 * orchestrator module is dynamically imported. `fetch` is stubbed so
 * outgoing Slack/Linear/GitHub calls never leave the process.
 */

import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

// ── Test harness: env + fetch stub + in-memory DB ────────────────────────────

const envOverrides: Record<string, string> = {
  GITHUB_PAT: "stub-pat",
  REPO_URL: "https://github.com/acme/target.git",
  GITHUB_WEBHOOK_SECRET: "gh-webhook-secret",
  LINEAR_API_KEY: "stub-linear-key",
  LINEAR_WEBHOOK_SECRET: "linear-webhook-secret",
  SLACK_WEBHOOK_URL: "http://stub.local/slack",
  CLAUDE_CODE_OAUTH_TOKEN: "stub-oat",
  MAX_PARALLEL_AGENTS: "4",
  MAX_REVIEW_CYCLES: "3",
  RECONCILE_INTERVAL_MS: "60000",
  REPO_PATH: "/tmp/orchestrator-test-repo",
  PORT: "0",
  // Point the SQLite file at a unique temp location — writable, and
  // client.ts creates the parent dir automatically.
  SQLITE_PATH: `/tmp/orchestrator-test-${Date.now()}.db`,
};

const originalFetch = globalThis.fetch;

function sign(body: string): string {
  return createHmac("sha256", envOverrides.LINEAR_WEBHOOK_SECRET!).update(body).digest("hex");
}

// Dynamically-imported module refs — populated in beforeAll after env is set.
let handleLinearWebhook: typeof import("../../src/server/webhooks/linear").handleLinearWebhook;
let getIssue: typeof import("../../src/db/repositories/issues").getIssue;
let listAll: typeof import("../../src/db/repositories/issues").listAll;

beforeAll(async () => {
  Object.assign(Bun.env, envOverrides);

  // Stub fetch: return 200 for everything so notifiers don't throw.
  globalThis.fetch = (async () =>
    new Response("{}", { status: 200 })) as unknown as typeof fetch;

  const migrateMod = await import("../../src/db/migrate");
  const issuesMod = await import("../../src/db/repositories/issues");
  const linearMod = await import("../../src/server/webhooks/linear");

  migrateMod.migrate();
  handleLinearWebhook = linearMod.handleLinearWebhook;
  getIssue = issuesMod.getIssue;
  listAll = issuesMod.listAll;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function makeLinearRequest(body: unknown, opts: { sign?: boolean; signature?: string } = {}): Request {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.signature !== undefined) {
    headers["linear-signature"] = opts.signature;
  } else if (opts.sign !== false) {
    headers["linear-signature"] = sign(raw);
  }
  return new Request("http://x.local/webhook/linear", {
    method: "POST",
    headers,
    body: raw,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("POST /webhook/linear", () => {
  test("rejects a request with no signature", async () => {
    const req = makeLinearRequest({ action: "update", type: "Issue", data: {} }, {
      sign: false,
    });
    const res = await handleLinearWebhook(req);
    expect(res.status).toBe(401);
  });

  test("rejects a request with a bad signature", async () => {
    const req = makeLinearRequest(
      { action: "update", type: "Issue", data: {} },
      { signature: "deadbeef".repeat(8) },
    );
    const res = await handleLinearWebhook(req);
    expect(res.status).toBe(401);
  });

  test("silently drops an unlabelled ticket (§6.1 label filter)", async () => {
    const body = {
      action: "update",
      type: "Issue",
      data: {
        id: "uuid-unlabelled",
        identifier: "ENG-200",
        title: "ENG-200: Unlabelled ticket",
        description: "## Context\nHuman-created.\n",
        labels: [], // no orchestrator-managed
      },
    };
    const res = await handleLinearWebhook(makeLinearRequest(body));
    expect(res.status).toBe(200);
    expect(getIssue("ENG-200")).toBeNull();
  });

  test("drops tickets with other labels but not orchestrator-managed", async () => {
    const body = {
      action: "update",
      type: "Issue",
      data: {
        id: "uuid-other",
        identifier: "ENG-201",
        title: "ENG-201: Has other labels",
        description: "whatever",
        labels: [{ id: "l1", name: "bug" }, { id: "l2", name: "p1" }],
      },
    };
    const res = await handleLinearWebhook(makeLinearRequest(body));
    expect(res.status).toBe(200);
    expect(getIssue("ENG-201")).toBeNull();
  });

  test("ingests an orchestrator-managed issue and parses depends_on", async () => {
    const body = {
      action: "update",
      type: "Issue",
      data: {
        id: "uuid-142",
        identifier: "ENG-142",
        title: "ENG-142: Add JWT types",
        description:
          "## Context\nAuth.\n\n## Requirements\nFoo\n\n## Acceptance Criteria\n- [ ] x\n\n## Files Likely Affected\nsrc/a.ts\n\n## Dependencies\ndepends_on: ENG-140, ENG-141",
        labels: [{ id: "ll", name: "orchestrator-managed" }],
      },
    };
    const res = await handleLinearWebhook(makeLinearRequest(body));
    expect(res.status).toBe(200);

    const ingested = getIssue("ENG-142");
    expect(ingested).not.toBeNull();
    expect(ingested!.title).toBe("ENG-142: Add JWT types");
    expect(ingested!.linearUuid).toBe("uuid-142");
    expect(ingested!.dependsOn).toEqual(["ENG-140", "ENG-141"]);
    expect(ingested!.status).toBe("pending");
  });

  test("ingests a no-dependency ticket with empty dependsOn", async () => {
    const body = {
      action: "update",
      type: "Issue",
      data: {
        id: "uuid-142b",
        identifier: "ENG-300",
        title: "ENG-300: No deps",
        description:
          "## Context\nStandalone.\n\n## Requirements\nFoo\n\n## Files Likely Affected\nsrc/b.ts",
        labels: [{ id: "ll", name: "orchestrator-managed" }],
      },
    };
    const res = await handleLinearWebhook(makeLinearRequest(body));
    expect(res.status).toBe(200);

    const ingested = getIssue("ENG-300");
    expect(ingested).not.toBeNull();
    expect(ingested!.dependsOn).toEqual([]);
  });

  test("ignores non-Issue event types", async () => {
    const body = {
      action: "create",
      type: "Comment",
      data: { id: "c", identifier: "", title: "", description: "" },
    };
    const res = await handleLinearWebhook(makeLinearRequest(body));
    expect(res.status).toBe(200);
  });

  test("smoke: multiple ingests accumulate in SQLite", async () => {
    const before = listAll().length;
    const body = {
      action: "update",
      type: "Issue",
      data: {
        id: "uuid-new",
        identifier: "ENG-400",
        title: "ENG-400: Another",
        description: "body without deps section",
        labels: [{ id: "ll", name: "orchestrator-managed" }],
      },
    };
    await handleLinearWebhook(makeLinearRequest(body));
    expect(listAll().length).toBe(before + 1);
  });
});
