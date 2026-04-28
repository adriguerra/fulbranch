/**
 * Apply SQL migrations in lexicographic filename order.
 *
 * Migrations live in `src/db/migrations/*.sql`. A small `_migrations` table
 * tracks which ones have been applied so re-running at boot is idempotent.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "./client";
import { logger } from "@/utils/logger";

const MIGRATIONS_DIR = new URL("./migrations", import.meta.url).pathname;

export function migrate(): void {
  const log = logger.child({ component: "migrate" });
  const d = db();

  d.run(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const applied = new Set(
    d
      .prepare("SELECT name FROM _migrations")
      .all()
      .map((r) => (r as { name: string }).name),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    log.info("applying migration", { file });
    d.transaction(() => {
      d.run(sql);
      d.prepare("INSERT INTO _migrations (name) VALUES (?)").run(file);
    })();
  }
}
