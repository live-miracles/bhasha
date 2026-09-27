import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Database } from './sqlite';

const DEFAULT_SCHEMA_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'schema.sql',
);

/**
 * Initialize the draft application's database from its one fresh schema file.
 * The database is intentionally disposable until the product is ready for
 * production, so schema changes replace this file and recreate the local DB.
 */
export function runMigrations(
    db: Database,
    schemaPath: string = DEFAULT_SCHEMA_PATH,
): { applied: string[] } {
    db.transaction(() => db.exec(readFileSync(schemaPath, 'utf8')))();
    return { applied: [path.basename(schemaPath)] };
}
