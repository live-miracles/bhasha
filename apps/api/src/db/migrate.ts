import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Database } from "./sqlite";

// apps/api/src/db/migrate.ts -> apps/api/migrations
const DEFAULT_MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations"
);

/**
 * Apply every `.sql` file under `migrationsDir`, in filename-sorted order,
 * that has not already been recorded in the `_migrations` tracking table.
 * Each file runs inside a single `db.transaction()` so a mid-file failure
 * never leaves a migration partially applied.
 *
 * D1 tracks applied migrations for you; better-sqlite3 has no such concept,
 * hence this small hand-rolled runner. The 21 existing migration files are
 * plain, portable SQLite (no D1-only syntax) and are reused byte-for-byte.
 */
export function runMigrations(
  db: Database,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR
): { applied: string[] } {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`
  );

  const alreadyApplied = new Set(
    db
      .prepare("SELECT filename FROM _migrations")
      .all()
      .map((row) => (row as { filename: string }).filename)
  );

  const filenames = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  const applied: string[] = [];

  for (const filename of filenames) {
    if (alreadyApplied.has(filename)) {
      continue;
    }

    const sql = readFileSync(path.join(migrationsDir, filename), "utf8");
    const applyOne = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)"
      ).run(filename, new Date().toISOString());
    });
    applyOne();
    applied.push(filename);
  }

  return { applied };
}
