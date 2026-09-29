import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Database } from './sqlite';

const DEFAULT_SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

/**
 * Initialize the draft application's database from its one fresh schema file.
 * The database is intentionally disposable until the product is ready for
 * production, so schema changes replace this file and recreate the local DB.
 */
export function runMigrations(
    db: Database,
    schemaPath: string = DEFAULT_SCHEMA_PATH,
): { applied: string[] } {
    const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get();
    if (hasTables) {
        // Keep security tables present for databases created before they were
        // added to schema.sql. This is intentionally idempotent.
        db.exec(`
            CREATE TABLE IF NOT EXISTS admin_login_attempts (
              bucket TEXT PRIMARY KEY,
              window_start TEXT NOT NULL,
              attempt_count INTEGER NOT NULL DEFAULT 0,
              locked_until TEXT
            )
        `);
        db.exec(`
            CREATE TABLE IF NOT EXISTS translator_login_attempts (
              bucket TEXT PRIMARY KEY,
              window_start TEXT NOT NULL,
              attempt_count INTEGER NOT NULL DEFAULT 0,
              locked_until TEXT
            )
        `);
        return { applied: [] };
    }

    db.transaction(() => db.exec(readFileSync(schemaPath, 'utf8')))();
    return { applied: [path.basename(schemaPath)] };
}
