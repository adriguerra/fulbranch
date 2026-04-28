/**
 * `events` repository — append-only audit trail.
 *
 * Event types are defined in types/pipeline.ts (EventType union).
 * The TDD lists canonical event types in §2.5; we extend them modestly
 * for webhook/dispatch bookkeeping.
 */

import { db } from "@/db/client";
import type { Event, EventType } from "@/types/pipeline";
import { logger } from "@/utils/logger";

interface EventRow {
  id: number;
  issue_id: string | null;
  event_type: string;
  detail: string | null;
  created_at: string;
}

function rowToEvent(row: EventRow): Event {
  return {
    id: row.id,
    issueId: row.issue_id,
    eventType: row.event_type as EventType,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

export interface AppendEventInput {
  issueId?: string | null;
  eventType: EventType;
  detail?: string | null;
}

export function appendEvent(input: AppendEventInput): Event {
  const row = db()
    .prepare(
      `INSERT INTO events (issue_id, event_type, detail)
       VALUES (?, ?, ?)
       RETURNING *`,
    )
    .get(input.issueId ?? null, input.eventType, input.detail ?? null) as EventRow;

  logger.info("event", {
    issueId: input.issueId ?? null,
    eventType: input.eventType,
    detail: input.detail ?? null,
  });

  return rowToEvent(row);
}

export function listForIssue(issueId: string, limit = 100): Event[] {
  const rows = db()
    .prepare("SELECT * FROM events WHERE issue_id = ? ORDER BY id DESC LIMIT ?")
    .all(issueId, limit) as EventRow[];
  return rows.map(rowToEvent);
}
