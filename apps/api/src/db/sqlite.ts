import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

// Re-exported so the rest of the codebase can `import type { Database } from
// "./sqlite"` instead of reaching into the `better-sqlite3` package directly.
export type Database = BetterSqlite3.Database;

const DEFAULT_DATABASE_PATH = './data/bhasha.sqlite';

/**
 * Open a better-sqlite3 database file (or `:memory:` for tests) and apply the
 * pragmas the app relies on:
 *
 * - `journal_mode = WAL`: allows concurrent readers alongside a writer, which
 *   matters once the Node process is serving many simultaneous requests
 *   against a single on-disk file (D1 gave us this behavior for free).
 * - `foreign_keys = ON`: D1 enables foreign-key enforcement by default;
 *   better-sqlite3 does NOT. The repositories rely on FK-violation errors
 *   being thrown (see `isForeignKeyConstraint`/`isReferenceConstraintError`
 *   in db/*.ts), and every `ON DELETE CASCADE` in the migrations depends on
 *   this pragma being on. Forgetting it silently turns cascades into no-ops.
 */
export function openDatabase(databasePath?: string): Database {
    const path = databasePath ?? process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH;

    if (path !== ':memory:') {
        const dir = dirname(path);
        if (dir && dir !== '.') {
            mkdirSync(dir, { recursive: true });
        }
    }

    const db = new BetterSqlite3(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
}
