import { describe, expect, it } from 'vitest';

import { openDatabase } from '../src/db/sqlite';
import { runMigrations } from '../src/db/migrate';

describe('fresh database schema', () => {
    it('creates the complete draft-mode schema from the single baseline file', () => {
        const db = openDatabase(':memory:');
        const result = runMigrations(db);
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .all()
            .map((row) => (row as { name: string }).name);

        expect(result.applied).toEqual(['schema.sql']);
        expect(tables).toEqual(
            expect.arrayContaining([
                'admin_sessions',
                'language_streams',
                'listener_access',
                'listener_connections',
                'listener_realtime_cleanup_targets',
                'programs',
                'realtime_publish_sessions',
                'stream_events',
                'translator_sessions',
                'translator_stream_assignments',
                'translators',
                'users',
                'approver_accounts',
                'approver_login_attempts',
                'approver_sessions',
            ]),
        );

        const columns = db.prepare('PRAGMA table_info(programs)').all() as Array<{
            name: string;
        }>;
        expect(columns.map((column) => column.name)).toEqual(
            expect.arrayContaining(['start_date', 'end_date']),
        );
        expect(columns.map((column) => column.name)).not.toContain('admin_notes');
        db.close();
    });
});
