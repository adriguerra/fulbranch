/**
 * Bun's built-in SQLite client (TDD §4 Stack Summary — "Bun SQLite built-in").
 *
 * A single process-wide Database instance. Bun's SQLite is synchronous
 * (WAL-mode, fine for our volume) — no connection pool needed.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "@/config";

let _db: Database | null = null;

export function db(): Database {
  if (_db) return _db;

  const path = config().sqlitePath;
  mkdirSync(dirname(path), { recursive: true });

  const d = new Database(path, { create: true });
  // WAL mode: better concurrency for webhook writes overlapping with pipeline updates.
  d.run("PRAGMA journal_mode = WAL;");
  d.run("PRAGMA foreign_keys = ON;");
  d.run("PRAGMA busy_timeout = 5000;");

  _db = d;
  return d;
}

/**
 * Test-only helper: reset the singleton so tests can inject an in-memory DB.
 */
export function __resetDbForTests(next: Database | null): void {
  if (_db && next !== _db) _db.close();
  _db = next;
}
