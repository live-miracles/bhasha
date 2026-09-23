/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { testEnv } from './test-env';

import migration from '../migrations/0001_initial.sql?raw';
import migration2 from '../migrations/0002_realtime_control_plane.sql?raw';

const migrationFiles = import.meta.glob('../migrations/*.sql', {
    eager: true,
    import: 'default',
    query: '?raw',
}) as Record<string, string>;
const listenerCleanupMigrationPath = '../migrations/0003_listener_realtime_cleanup_targets.sql';
const migration3 = migrationFiles[listenerCleanupMigrationPath] ?? '';
const programScopedTranslatorIdsMigrationPath =
    '../migrations/0004_program_scoped_translator_ids.sql';
const migration4 = migrationFiles[programScopedTranslatorIdsMigrationPath] ?? '';
const retentionMigrationPath = '../migrations/0005_retention.sql';
const migration5 = migrationFiles[retentionMigrationPath] ?? '';
const programReadinessMigrationPath = '../migrations/0006_program_readiness.sql';
const migration6 = migrationFiles[programReadinessMigrationPath] ?? '';
const listenerAccessControlMigrationPath = '../migrations/0021_listener_access_control.sql';
const migration21 = migrationFiles[listenerAccessControlMigrationPath] ?? '';

type ProgramGraph = {
    p1: string;
    p2: string;
    p1Stream: string;
    p2Stream: string;
    p1Translator: string;
    now: string;
};

async function execute(sql: string, ...bindings: Array<number | string | null>): Promise<void> {
    await testEnv.DB.prepare(sql)
        .bind(...bindings)
        .run();
}

async function countRows(sql: string, ...bindings: Array<number | string>): Promise<number> {
    const row = (await testEnv.DB.prepare(sql)
        .bind(...bindings)
        .get()) as { count: number } | undefined;
    return row?.count ?? 0;
}

async function executeMigrationSql(sql: string): Promise<void> {
    for (const statement of sql
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)) {
        await testEnv.DB.prepare(statement).run();
    }
}

async function seedProgramGraph(): Promise<ProgramGraph> {
    const suffix = crypto.randomUUID();
    const now = '2026-06-19T00:00:00.000Z';
    const p1 = `program-${suffix}-one`;
    const p2 = `program-${suffix}-two`;
    const p1Stream = `stream-${suffix}-one`;
    const p2Stream = `stream-${suffix}-two`;
    const p1Translator = `translator-${suffix}-one`;

    await execute(
        `INSERT INTO programs (
      id, slug, name, venue, event_date, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        p1,
        `program-${suffix}-one`,
        'Program One',
        'Main Hall',
        '2026-06-19',
        'draft',
        now,
        now,
    );
    await execute(
        `INSERT INTO programs (
      id, slug, name, venue, event_date, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        p2,
        `program-${suffix}-two`,
        'Program Two',
        'Second Hall',
        '2026-06-20',
        'draft',
        now,
        now,
    );
    await execute(
        `INSERT INTO language_streams (
      id, program_id, language_name, language_code, display_order, is_active,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        p1Stream,
        p1,
        'Hindi',
        'hi',
        1,
        1,
        now,
        now,
    );
    await execute(
        `INSERT INTO language_streams (
      id, program_id, language_name, language_code, display_order, is_active,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        p2Stream,
        p2,
        'English',
        'en',
        1,
        1,
        now,
        now,
    );
    await execute(
        `INSERT INTO translators (
      id, program_id, name, password_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
        p1Translator,
        p1,
        'Translator One',
        'hash',
        now,
        now,
    );

    return { p1, p2, p1Stream, p2Stream, p1Translator, now };
}

type LegacyTranslatorMigrationScratch = {
    programs: string;
    languageStreams: string;
    translators: string;
    translatorStreamAssignments: string;
    translatorSessions: string;
    realtimePublishSessions: string;
};

function createLegacyTranslatorMigrationScratch(): LegacyTranslatorMigrationScratch {
    const suffix = crypto.randomUUID().replaceAll('-', '_');
    return {
        programs: `programs_legacy_${suffix}`,
        languageStreams: `language_streams_legacy_${suffix}`,
        translators: `translators_legacy_${suffix}`,
        translatorStreamAssignments: `translator_stream_assignments_legacy_${suffix}`,
        translatorSessions: `translator_sessions_legacy_${suffix}`,
        realtimePublishSessions: `realtime_publish_sessions_legacy_${suffix}`,
    };
}

function rewriteMigration4ForScratch(scratch: LegacyTranslatorMigrationScratch): string {
    const d1CompatibleMigration = migration4.replace(
        /^\s*PRAGMA\s+foreign_keys\s*=\s*(?:ON|OFF|TRUE|FALSE|0|1)\s*;\s*$/gim,
        '',
    );

    return d1CompatibleMigration
        .replaceAll('realtime_publish_sessions', scratch.realtimePublishSessions)
        .replaceAll('translator_stream_assignments', scratch.translatorStreamAssignments)
        .replaceAll('translator_sessions', scratch.translatorSessions)
        .replaceAll('language_streams', scratch.languageStreams)
        .replaceAll('translators', scratch.translators)
        .replaceAll('programs', scratch.programs);
}

async function createLegacyTranslatorMigrationSchema(
    scratch: LegacyTranslatorMigrationScratch,
): Promise<void> {
    await executeMigrationSql(`
CREATE TABLE ${scratch.programs} (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  venue TEXT NOT NULL,
  event_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'live', 'archived')),
  admin_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ${scratch.languageStreams} (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  language_name TEXT NOT NULL,
  language_code TEXT NOT NULL,
  display_order INTEGER NOT NULL,
  is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
  is_live INTEGER NOT NULL DEFAULT 0 CHECK (is_live IN (0, 1)),
  cloudflare_session_id TEXT,
  current_track_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (program_id, id),
  FOREIGN KEY (program_id) REFERENCES ${scratch.programs}(id) ON DELETE CASCADE
);

CREATE TABLE ${scratch.translators} (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (program_id, id),
  FOREIGN KEY (program_id) REFERENCES ${scratch.programs}(id) ON DELETE CASCADE
);

CREATE TABLE ${scratch.translatorStreamAssignments} (
  program_id TEXT NOT NULL,
  translator_id TEXT NOT NULL,
  language_stream_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (program_id, translator_id, language_stream_id),
  FOREIGN KEY (program_id) REFERENCES ${scratch.programs}(id) ON DELETE CASCADE,
  FOREIGN KEY (program_id, translator_id) REFERENCES ${scratch.translators}(program_id, id) ON DELETE CASCADE,
  FOREIGN KEY (program_id, language_stream_id) REFERENCES ${scratch.languageStreams}(program_id, id) ON DELETE CASCADE
);

CREATE TABLE ${scratch.translatorSessions} (
  id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL UNIQUE,
  program_id TEXT NOT NULL,
  translator_id TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (program_id, translator_id) REFERENCES ${scratch.translators}(program_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_${scratch.translatorSessions}_translator_expiry
ON ${scratch.translatorSessions}(program_id, translator_id, expires_at);

CREATE TABLE ${scratch.realtimePublishSessions} (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  language_stream_id TEXT NOT NULL,
  translator_id TEXT NOT NULL,
  cloudflare_session_id TEXT,
  published_track_name TEXT,
  published_track_mid TEXT,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'published', 'closing', 'closed', 'failed')),
  expires_at TEXT NOT NULL,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (program_id, language_stream_id) REFERENCES ${scratch.languageStreams}(program_id, id) ON DELETE CASCADE,
  FOREIGN KEY (program_id, translator_id) REFERENCES ${scratch.translators}(program_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_${scratch.realtimePublishSessions}_one_active_stream
ON ${scratch.realtimePublishSessions}(program_id, language_stream_id)
WHERE state IN ('reserved', 'published', 'closing');

CREATE INDEX idx_${scratch.realtimePublishSessions}_expiry
ON ${scratch.realtimePublishSessions}(state, expires_at);
`);
}

async function dropLegacyTranslatorMigrationScratch(
    scratch: LegacyTranslatorMigrationScratch,
): Promise<void> {
    await executeMigrationSql(`
PRAGMA defer_foreign_keys = true;
DROP TABLE IF EXISTS ${scratch.realtimePublishSessions};
DROP TABLE IF EXISTS ${scratch.realtimePublishSessions}_0004_backup;
DROP TABLE IF EXISTS ${scratch.translatorSessions};
DROP TABLE IF EXISTS ${scratch.translatorSessions}_0004_backup;
DROP TABLE IF EXISTS ${scratch.translatorStreamAssignments};
DROP TABLE IF EXISTS ${scratch.translatorStreamAssignments}_0004_backup;
DROP TABLE IF EXISTS ${scratch.translators};
DROP TABLE IF EXISTS ${scratch.translators}_program_scoped_ids;
DROP TABLE IF EXISTS ${scratch.translators}_0004_new;
DROP TABLE IF EXISTS ${scratch.languageStreams};
DROP TABLE IF EXISTS ${scratch.programs};
PRAGMA defer_foreign_keys = false;
`);
}

describe('initial D1 schema', () => {
    it('creates the core tables', () => {
        for (const tableName of [
            'programs',
            'language_streams',
            'translators',
            'translator_stream_assignments',
            'listener_connections',
            'stream_events',
            'admin_sessions',
        ]) {
            expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${tableName}`);
        }
    });

    it('stores report fields for listener connections', () => {
        for (const column of [
            'listener_ip TEXT NOT NULL',
            'user_agent TEXT NOT NULL',
            'subscription_status TEXT NOT NULL',
            'connected_at TEXT',
            'disconnected_at TEXT',
            'disconnect_reason TEXT',
        ]) {
            expect(migration).toContain(column);
        }
    });

    it('declares unique replacement successor links for listener connections', () => {
        for (const index of [
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_listener_connections_unique_switch_successor
ON listener_connections(switch_from_connection_id)
WHERE switch_from_connection_id IS NOT NULL`,
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_listener_connections_unique_reconnect_successor
ON listener_connections(reconnect_of_connection_id)
WHERE reconnect_of_connection_id IS NOT NULL`,
        ]) {
            expect(migration).toContain(index);
        }
    });

    it('stores live state fields for language streams', () => {
        for (const column of [
            'is_active INTEGER NOT NULL CHECK (is_active IN (0, 1))',
            'is_live INTEGER NOT NULL DEFAULT 0 CHECK (is_live IN (0, 1))',
            'cloudflare_session_id TEXT',
            'current_track_id TEXT',
        ]) {
            expect(migration).toContain(column);
        }
    });

    it('declares program-scoped foreign keys for cross-program integrity', () => {
        const languageStreamForeignKey =
            'FOREIGN KEY (program_id, language_stream_id) REFERENCES language_streams(program_id, id)';
        const cascadingLanguageStreamForeignKey = `${languageStreamForeignKey} ON DELETE CASCADE`;
        const nullableStreamEventForeignKey =
            'FOREIGN KEY (stream_program_id, language_stream_id) REFERENCES language_streams(program_id, id) ON DELETE SET NULL';

        expect(migration.split('UNIQUE (program_id, id)')).toHaveLength(2);
        expect(migration.split(languageStreamForeignKey)).toHaveLength(3);
        expect(migration.split(cascadingLanguageStreamForeignKey)).toHaveLength(3);

        for (const fragment of [
            'id TEXT NOT NULL,\n  program_id TEXT NOT NULL',
            'PRIMARY KEY (program_id, id)',
            'program_id TEXT NOT NULL,\n  translator_id TEXT NOT NULL',
            'PRIMARY KEY (program_id, translator_id, language_stream_id)',
            'FOREIGN KEY (program_id, translator_id) REFERENCES translators(program_id, id) ON DELETE CASCADE',
            'stream_program_id TEXT',
            nullableStreamEventForeignKey,
        ]) {
            expect(migration).toContain(fragment);
        }
    });

    it('rejects assigning a translator to a stream in another program', async () => {
        const graph = await seedProgramGraph();

        await execute(
            `INSERT INTO translator_stream_assignments (
        program_id, translator_id, language_stream_id, created_at
      ) VALUES (?, ?, ?, ?)`,
            graph.p1,
            graph.p1Translator,
            graph.p1Stream,
            graph.now,
        );

        await expect(
            execute(
                `INSERT INTO translator_stream_assignments (
          program_id, translator_id, language_stream_id, created_at
        ) VALUES (?, ?, ?, ?)`,
                graph.p1,
                graph.p1Translator,
                graph.p2Stream,
                graph.now,
            ),
        ).rejects.toThrow(/FOREIGN KEY|constraint|D1_ERROR/);

        await expect(
            execute(
                `INSERT INTO translator_stream_assignments (
          program_id, translator_id, language_stream_id, created_at
        ) VALUES (?, ?, ?, ?)`,
                graph.p2,
                graph.p1Translator,
                graph.p2Stream,
                graph.now,
            ),
        ).rejects.toThrow(/FOREIGN KEY|constraint|D1_ERROR/);
    });

    it('scopes translator ids to a program', async () => {
        const graph = await seedProgramGraph();

        await execute(
            `INSERT INTO translators (
        id, program_id, name, password_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
            graph.p1Translator,
            graph.p2,
            'Translator Two',
            'hash',
            graph.now,
            graph.now,
        );

        await expect(
            execute(
                `INSERT INTO translators (
          id, program_id, name, password_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
                graph.p1Translator,
                graph.p1,
                'Duplicate Translator One',
                'hash',
                graph.now,
                graph.now,
            ),
        ).rejects.toThrow(/UNIQUE|constraint|D1_ERROR/);
    });

    it('rejects listener connections for streams in another program', async () => {
        const graph = await seedProgramGraph();

        await execute(
            `INSERT INTO listener_connections (
        id, program_id, language_stream_id, client_id, token_issued_at,
        subscription_status, listener_ip, user_agent, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            `listener-${graph.p1}-valid`,
            graph.p1,
            graph.p1Stream,
            'client-one',
            graph.now,
            'requested',
            '203.0.113.10',
            'Test UA',
            graph.now,
            graph.now,
        );

        await expect(
            execute(
                `INSERT INTO listener_connections (
          id, program_id, language_stream_id, client_id, token_issued_at,
          subscription_status, listener_ip, user_agent, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                `listener-${graph.p1}-invalid`,
                graph.p1,
                graph.p2Stream,
                'client-two',
                graph.now,
                'requested',
                '203.0.113.11',
                'Test UA',
                graph.now,
                graph.now,
            ),
        ).rejects.toThrow(/FOREIGN KEY|constraint|D1_ERROR/);
    });

    it('rejects stream events for streams in another program', async () => {
        const graph = await seedProgramGraph();

        await execute(
            `INSERT INTO stream_events (
        id, program_id, stream_program_id, language_stream_id, event_type,
        occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
            `event-${graph.p1}-valid`,
            graph.p1,
            graph.p1,
            graph.p1Stream,
            'listener_joined',
            graph.now,
        );

        await expect(
            execute(
                `INSERT INTO stream_events (
          id, program_id, stream_program_id, language_stream_id, event_type,
          occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
                `event-${graph.p1}-invalid`,
                graph.p1,
                graph.p1,
                graph.p2Stream,
                'listener_joined',
                graph.now,
            ),
        ).rejects.toThrow(/FOREIGN KEY|constraint|D1_ERROR/);

        await expect(
            execute(
                `INSERT INTO stream_events (
          id, program_id, stream_program_id, language_stream_id, event_type,
          occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
                `event-${graph.p1}-invalid-stream-program`,
                graph.p1,
                graph.p2,
                graph.p2Stream,
                'listener_joined',
                graph.now,
            ),
        ).rejects.toThrow(/FOREIGN KEY|constraint|D1_ERROR/);
    });

    it('preserves stream events and clears the stream reference when a stream is deleted', async () => {
        const graph = await seedProgramGraph();
        const eventId = `event-${graph.p1}-deleted-stream`;

        await execute(
            `INSERT INTO stream_events (
        id, program_id, stream_program_id, language_stream_id, event_type,
        occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
            eventId,
            graph.p1,
            graph.p1,
            graph.p1Stream,
            'listener_joined',
            graph.now,
        );

        await execute('DELETE FROM language_streams WHERE id = ?', graph.p1Stream);

        const event = (await testEnv.DB.prepare(
            `SELECT program_id, stream_program_id, language_stream_id
      FROM stream_events
      WHERE id = ?`,
        )
            .bind(eventId)
            .get()) as
            | {
                  program_id: string;
                  stream_program_id: string | null;
                  language_stream_id: string | null;
              }
            | undefined;

        expect(event).toEqual({
            program_id: graph.p1,
            stream_program_id: null,
            language_stream_id: null,
        });
    });
});

describe('realtime control-plane D1 schema', () => {
    it('adds realtime control-plane tables and columns', () => {
        for (const fragment of [
            'ALTER TABLE listener_connections ADD COLUMN cloudflare_track_mid TEXT',
            'CREATE TABLE IF NOT EXISTS translator_sessions',
            'absolute_expires_at TEXT NOT NULL',
            'last_seen_at TEXT NOT NULL',
            'CREATE TABLE IF NOT EXISTS realtime_publish_sessions',
            "state TEXT NOT NULL CHECK (state IN ('reserved', 'published', 'closing', 'closed', 'failed'))",
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_realtime_publish_sessions_one_active_stream',
        ]) {
            expect(migration2).toContain(fragment);
        }
    });

    it('moves listener realtime cleanup targets into a forward migration', () => {
        expect(migrationFiles).toHaveProperty(listenerCleanupMigrationPath);
        expect(migration2).not.toContain('listener_realtime_cleanup_targets');
        for (const fragment of [
            'CREATE TABLE IF NOT EXISTS listener_realtime_cleanup_targets',
            "cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('pending','closed'))",
            'PRIMARY KEY (connection_id, cloudflare_session_id, cloudflare_track_mid)',
            'FOREIGN KEY (connection_id) REFERENCES listener_connections(id) ON DELETE CASCADE',
        ]) {
            expect(migration3).toContain(fragment);
        }
    });

    it('creates listener realtime cleanup targets after listener_connections already exists', async () => {
        const scratchTable = `listener_realtime_cleanup_targets_upgrade_${crypto
            .randomUUID()
            .replaceAll('-', '_')}`;
        const scratchMigration = migration3.replaceAll(
            'listener_realtime_cleanup_targets',
            scratchTable,
        );

        try {
            await executeMigrationSql(scratchMigration);
            const columns = (await testEnv.DB.prepare(
                `PRAGMA table_info(${scratchTable})`,
            ).all()) as Array<{
                name: string;
                type: string;
                notnull: number;
                pk: number;
            }>;
            expect(columns).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        name: 'connection_id',
                        type: 'TEXT',
                        notnull: 1,
                        pk: 1,
                    }),
                    expect.objectContaining({
                        name: 'cleanup_state',
                        type: 'TEXT',
                        notnull: 1,
                    }),
                    expect.objectContaining({
                        name: 'closed_at',
                        type: 'TEXT',
                        notnull: 0,
                    }),
                ]),
            );

            const foreignKeys = (await testEnv.DB.prepare(
                `PRAGMA foreign_key_list(${scratchTable})`,
            ).all()) as Array<{
                table: string;
                from: string;
                to: string;
                on_delete: string;
            }>;
            expect(foreignKeys).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        table: 'listener_connections',
                        from: 'connection_id',
                        to: 'id',
                        on_delete: 'CASCADE',
                    }),
                ]),
            );
        } finally {
            await testEnv.DB.exec(`DROP TABLE IF EXISTS ${scratchTable}`);
        }
    });

    it('backfills legacy listener realtime cleanup events from stream events', async () => {
        const graph = await seedProgramGraph();
        const now = '2026-06-19T00:00:00.000Z';
        const connectionId = `listener-${graph.p1}-legacy-cleanup`;
        const scratchTable = `listener_realtime_cleanup_targets_backfill_${crypto
            .randomUUID()
            .replaceAll('-', '_')}`;
        const scratchMigration = migration3.replaceAll(
            'listener_realtime_cleanup_targets',
            scratchTable,
        );

        await execute(
            `INSERT INTO listener_connections (
        id, program_id, language_stream_id, client_id, token_issued_at,
        subscription_status, listener_ip, user_agent, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            connectionId,
            graph.p1,
            graph.p1Stream,
            'listener-one',
            now,
            'requested',
            '203.0.113.10',
            'Test UA',
            now,
            now,
        );
        await execute(
            `INSERT INTO stream_events (
        id, program_id, stream_program_id, language_stream_id, event_type,
        occurred_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            `event-${graph.p1}-legacy-cleanup`,
            graph.p1,
            graph.p1,
            graph.p1Stream,
            'connection_failed',
            now,
            JSON.stringify({
                connectionId,
                reason: 'realtime_track_cleanup_failed',
                cloudflareSessionId: 'cf-listener-session',
                trackMid: '1',
            }),
        );

        try {
            await executeMigrationSql(scratchMigration);
            const results = (await testEnv.DB.prepare(
                `SELECT connection_id as connectionId,
          cloudflare_session_id as cloudflareSessionId,
          cloudflare_track_mid as cloudflareTrackMid,
          cleanup_state as cleanupState
        FROM ${scratchTable}
        WHERE connection_id = ?`,
            )
                .bind(connectionId)
                .all()) as Array<{
                connectionId: string;
                cloudflareSessionId: string;
                cloudflareTrackMid: string;
                cleanupState: string;
            }>;

            expect(results).toEqual([
                {
                    connectionId,
                    cloudflareSessionId: 'cf-listener-session',
                    cloudflareTrackMid: '1',
                    cleanupState: 'pending',
                },
            ]);
        } finally {
            await testEnv.DB.exec(`DROP TABLE IF EXISTS ${scratchTable}`);
        }
    });

    it('applies the listener realtime track column to D1', async () => {
        const results = (await testEnv.DB.prepare(
            'PRAGMA table_info(listener_connections)',
        ).all()) as Array<{ name: string; type: string }>;

        expect(results).toContainEqual(
            expect.objectContaining({
                name: 'cloudflare_track_mid',
                type: 'TEXT',
            }),
        );
    });

    it('enforces unique listener realtime cleanup targets and valid states', async () => {
        const graph = await seedProgramGraph();
        const now = '2026-06-19T00:00:00.000Z';
        const connectionId = `listener-${graph.p1}-cleanup`;

        await execute(
            `INSERT INTO listener_connections (
        id, program_id, language_stream_id, client_id, token_issued_at,
        subscription_status, listener_ip, user_agent, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            connectionId,
            graph.p1,
            graph.p1Stream,
            'listener-one',
            now,
            'requested',
            '203.0.113.10',
            'Test UA',
            now,
            now,
        );

        await execute(
            `INSERT INTO listener_realtime_cleanup_targets (
        connection_id, cloudflare_session_id, cloudflare_track_mid,
        cleanup_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
            connectionId,
            'cf-session-one',
            '0',
            'pending',
            now,
            now,
        );

        await expect(
            execute(
                `INSERT INTO listener_realtime_cleanup_targets (
          connection_id, cloudflare_session_id, cloudflare_track_mid,
          cleanup_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
                connectionId,
                'cf-session-one',
                '0',
                'pending',
                now,
                now,
            ),
        ).rejects.toThrow(/UNIQUE|constraint|D1_ERROR/);

        await expect(
            execute(
                `INSERT INTO listener_realtime_cleanup_targets (
          connection_id, cloudflare_session_id, cloudflare_track_mid,
          cleanup_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
                connectionId,
                'cf-session-one',
                '1',
                'failed',
                now,
                now,
            ),
        ).rejects.toThrow(/CHECK|constraint|D1_ERROR/);
    });

    it('enforces one active publisher reservation per stream', async () => {
        const graph = await seedProgramGraph();
        const now = '2026-06-19T00:00:00.000Z';
        await execute(
            `INSERT INTO realtime_publish_sessions (
        id, program_id, language_stream_id, translator_id, cloudflare_session_id,
        state, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            `pub-${graph.p1}-one`,
            graph.p1,
            graph.p1Stream,
            graph.p1Translator,
            'cf-session-one',
            'reserved',
            '2026-06-19T00:02:00.000Z',
            now,
            now,
        );
        await expect(
            execute(
                `INSERT INTO realtime_publish_sessions (
          id, program_id, language_stream_id, translator_id, cloudflare_session_id,
          state, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                `pub-${graph.p1}-two`,
                graph.p1,
                graph.p1Stream,
                graph.p1Translator,
                'cf-session-two',
                'published',
                '2026-06-19T08:00:00.000Z',
                now,
                now,
            ),
        ).rejects.toThrow(/UNIQUE|constraint|D1_ERROR/);
    });
});

describe('retention D1 schema', () => {
    it('declares the retention migration file', () => {
        expect(migrationFiles).toHaveProperty(retentionMigrationPath);
    });

    it('adds archive and retention columns to programs', () => {
        for (const fragment of [
            'ALTER TABLE programs ADD COLUMN archived_at TEXT',
            'ALTER TABLE programs ADD COLUMN retention_processed_at TEXT',
            'ALTER TABLE programs ADD COLUMN aggregate_summary_json TEXT',
        ]) {
            expect(migration5).toContain(fragment);
        }
    });

    it('applies the retention columns to D1', async () => {
        const results = (await testEnv.DB.prepare('PRAGMA table_info(programs)').all()) as Array<{
            name: string;
            type: string;
        }>;
        const columnNames = results.map((column) => column.name);
        expect(columnNames).toEqual(
            expect.arrayContaining([
                'archived_at',
                'retention_processed_at',
                'aggregate_summary_json',
            ]),
        );
    });
});

describe('program readiness D1 schema', () => {
    it('declares the program readiness migration file', () => {
        expect(migrationFiles).toHaveProperty(programReadinessMigrationPath);
    });

    it('creates the program readiness checks table with a cascading program reference', () => {
        for (const fragment of [
            'CREATE TABLE IF NOT EXISTS program_readiness_checks',
            'program_id TEXT PRIMARY KEY',
            'realtime_smoke_tested_at TEXT',
            'mobile_field_tested_at TEXT',
            'updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
            'FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE',
        ]) {
            expect(migration6).toContain(fragment);
        }
    });

    it('applies the program readiness table to D1', async () => {
        const results = (await testEnv.DB.prepare(
            'PRAGMA table_info(program_readiness_checks)',
        ).all()) as Array<{ name: string; type: string; pk: number }>;
        const byName = new Map(results.map((column) => [column.name, column]));

        expect(byName.get('program_id')).toMatchObject({ type: 'TEXT', pk: 1 });
        expect(byName.get('realtime_smoke_tested_at')).toMatchObject({
            type: 'TEXT',
        });
        expect(byName.get('mobile_field_tested_at')).toMatchObject({
            type: 'TEXT',
        });
        expect(byName.get('updated_at')).toMatchObject({ type: 'TEXT' });
    });

    it('keeps at most one readiness row per program and cascades on delete', async () => {
        const graph = await seedProgramGraph();

        await execute(
            `INSERT INTO program_readiness_checks (
        program_id, realtime_smoke_tested_at, updated_at
      ) VALUES (?, ?, ?)`,
            graph.p1,
            graph.now,
            graph.now,
        );

        await expect(
            execute(
                `INSERT INTO program_readiness_checks (
          program_id, mobile_field_tested_at, updated_at
        ) VALUES (?, ?, ?)`,
                graph.p1,
                graph.now,
                graph.now,
            ),
        ).rejects.toThrow(/UNIQUE|PRIMARY|constraint|D1_ERROR/);

        await execute('DELETE FROM programs WHERE id = ?', graph.p1);
        expect(
            await countRows(
                `SELECT COUNT(*) as count FROM program_readiness_checks WHERE program_id = ?`,
                graph.p1,
            ),
        ).toBe(0);
    });
});

describe('program-scoped translator id D1 migration', () => {
    it('rebuilds translators without a global id primary key', () => {
        expect(migrationFiles).toHaveProperty(programScopedTranslatorIdsMigrationPath);
        expect(migration4).toMatch(/PRAGMA\s+defer_foreign_keys\s*=\s*true/i);
        expect(migration4).not.toMatch(/PRAGMA\s+foreign_keys/i);
        expect(migration4).toContain('DROP TABLE translators');
        expect(migration4).toContain('PRIMARY KEY (program_id, id)');
        const translatorsRebuild = migration4.slice(
            migration4.indexOf('CREATE TABLE translators_0004_new'),
            migration4.indexOf('INSERT INTO translators_0004_new'),
        );
        expect(translatorsRebuild).not.toContain('id TEXT PRIMARY KEY');
        for (const indexName of [
            'idx_translator_sessions_translator_expiry',
            'idx_realtime_publish_sessions_one_active_stream',
            'idx_realtime_publish_sessions_expiry',
        ]) {
            expect(migration4).toContain(indexName);
        }
    });

    it('preserves dependent translator rows while migrating legacy schemas', async () => {
        const scratch = createLegacyTranslatorMigrationScratch();
        const now = '2026-06-19T00:00:00.000Z';
        const p1 = `program-${crypto.randomUUID()}`;
        const p2 = `program-${crypto.randomUUID()}`;
        const p1Stream = `stream-${crypto.randomUUID()}`;
        const p2Stream = `stream-${crypto.randomUUID()}`;
        const translatorId = 'shared-translator';

        try {
            await createLegacyTranslatorMigrationSchema(scratch);

            await execute(
                `INSERT INTO ${scratch.programs} (
          id, slug, name, venue, event_date, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                p1,
                `${p1}-slug`,
                'Program One',
                'Main Hall',
                '2026-06-19',
                'draft',
                now,
                now,
            );
            await execute(
                `INSERT INTO ${scratch.programs} (
          id, slug, name, venue, event_date, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                p2,
                `${p2}-slug`,
                'Program Two',
                'Second Hall',
                '2026-06-20',
                'draft',
                now,
                now,
            );
            await execute(
                `INSERT INTO ${scratch.languageStreams} (
          id, program_id, language_name, language_code, display_order, is_active,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                p1Stream,
                p1,
                'Hindi',
                'hi',
                1,
                1,
                now,
                now,
            );
            await execute(
                `INSERT INTO ${scratch.languageStreams} (
          id, program_id, language_name, language_code, display_order, is_active,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                p2Stream,
                p2,
                'English',
                'en',
                1,
                1,
                now,
                now,
            );
            await execute(
                `INSERT INTO ${scratch.translators} (
          id, program_id, name, password_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
                translatorId,
                p1,
                'Translator One',
                'hash-one',
                now,
                now,
            );
            await execute(
                `INSERT INTO ${scratch.translatorStreamAssignments} (
          program_id, translator_id, language_stream_id, created_at
        ) VALUES (?, ?, ?, ?)`,
                p1,
                translatorId,
                p1Stream,
                now,
            );
            await execute(
                `INSERT INTO ${scratch.translatorSessions} (
          id, session_hash, program_id, translator_id, absolute_expires_at,
          expires_at, last_seen_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                `session-${crypto.randomUUID()}`,
                `session-hash-${crypto.randomUUID()}`,
                p1,
                translatorId,
                '2026-06-20T00:00:00.000Z',
                '2026-06-19T01:00:00.000Z',
                now,
                now,
            );
            await execute(
                `INSERT INTO ${scratch.realtimePublishSessions} (
          id, program_id, language_stream_id, translator_id, cloudflare_session_id,
          published_track_name, published_track_mid, state, expires_at, created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                `publish-${crypto.randomUUID()}`,
                p1,
                p1Stream,
                translatorId,
                'cf-session-one',
                'track-one',
                '0',
                'published',
                '2026-06-19T01:00:00.000Z',
                now,
                now,
            );

            await executeMigrationSql(rewriteMigration4ForScratch(scratch));

            expect(
                await countRows(
                    `SELECT COUNT(*) as count FROM ${scratch.translatorStreamAssignments}
          WHERE program_id = ? AND translator_id = ?`,
                    p1,
                    translatorId,
                ),
            ).toBe(1);
            expect(
                await countRows(
                    `SELECT COUNT(*) as count FROM ${scratch.translatorSessions}
          WHERE program_id = ? AND translator_id = ?`,
                    p1,
                    translatorId,
                ),
            ).toBe(1);
            expect(
                await countRows(
                    `SELECT COUNT(*) as count FROM ${scratch.realtimePublishSessions}
          WHERE program_id = ? AND translator_id = ?`,
                    p1,
                    translatorId,
                ),
            ).toBe(1);

            await execute(
                `INSERT INTO ${scratch.translators} (
          id, program_id, name, password_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
                translatorId,
                p2,
                'Translator Two',
                'hash-two',
                now,
                now,
            );
            await expect(
                execute(
                    `INSERT INTO ${scratch.translators} (
            id, program_id, name, password_hash, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
                    translatorId,
                    p1,
                    'Duplicate Translator One',
                    'hash-one',
                    now,
                    now,
                ),
            ).rejects.toThrow(/UNIQUE|constraint|D1_ERROR/);

            await execute(
                `DELETE FROM ${scratch.translators}
        WHERE program_id = ? AND id = ?`,
                p1,
                translatorId,
            );

            expect(
                await countRows(
                    `SELECT COUNT(*) as count FROM ${scratch.translatorStreamAssignments}
          WHERE program_id = ? AND translator_id = ?`,
                    p1,
                    translatorId,
                ),
            ).toBe(0);
            expect(
                await countRows(
                    `SELECT COUNT(*) as count FROM ${scratch.translatorSessions}
          WHERE program_id = ? AND translator_id = ?`,
                    p1,
                    translatorId,
                ),
            ).toBe(0);
            expect(
                await countRows(
                    `SELECT COUNT(*) as count FROM ${scratch.realtimePublishSessions}
          WHERE program_id = ? AND translator_id = ?`,
                    p1,
                    translatorId,
                ),
            ).toBe(0);
            expect(
                await countRows(
                    `SELECT COUNT(*) as count FROM ${scratch.translators}
          WHERE program_id = ? AND id = ?`,
                    p2,
                    translatorId,
                ),
            ).toBe(1);
        } finally {
            await dropLegacyTranslatorMigrationScratch(scratch);
        }
    });
});

describe('translator email D1 schema', () => {
    const translatorEmailMigrationPath = '../migrations/0007_translator_email.sql';
    const migration7 = migrationFiles[translatorEmailMigrationPath] ?? '';

    it('declares the translator email migration file', () => {
        expect(migrationFiles).toHaveProperty(translatorEmailMigrationPath);
    });

    it('adds an email column and a per-program unique index', () => {
        expect(migration7).toContain('ALTER TABLE translators ADD COLUMN email TEXT');
        expect(migration7).toContain(
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_translators_program_email',
        );
    });

    it('applies the email column to D1 as nullable TEXT', async () => {
        const results = (await testEnv.DB.prepare(
            'PRAGMA table_info(translators)',
        ).all()) as Array<{ name: string; type: string; notnull: number }>;
        const byName = new Map(results.map((column) => [column.name, column]));
        expect(byName.get('email')).toMatchObject({ type: 'TEXT', notnull: 0 });
    });

    it('creates a unique index over (program_id, email)', async () => {
        const indexes = (await testEnv.DB.prepare(
            'PRAGMA index_list(translators)',
        ).all()) as Array<{ name: string; unique: number }>;
        const emailIndex = indexes.find((index) => index.name === 'idx_translators_program_email');
        expect(emailIndex).toMatchObject({ unique: 1 });

        const columns = (await testEnv.DB.prepare(
            'PRAGMA index_info(idx_translators_program_email)',
        ).all()) as Array<{ name: string }>;
        expect(columns.map((column) => column.name)).toEqual(['program_id', 'email']);
    });

    it('rejects two translators with the same email in one program', async () => {
        const graph = await seedProgramGraph();
        await execute(
            `INSERT INTO translators (
        id, program_id, name, email, password_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            'translator-email-a',
            graph.p1,
            'Email A',
            'dup@example.com',
            'sha256:a',
            graph.now,
            graph.now,
        );

        await expect(
            execute(
                `INSERT INTO translators (
          id, program_id, name, email, password_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                'translator-email-b',
                graph.p1,
                'Email B',
                'dup@example.com',
                'sha256:b',
                graph.now,
                graph.now,
            ),
        ).rejects.toThrow(/UNIQUE|constraint|D1_ERROR/);
    });
});

describe('stream native name D1 schema', () => {
    const streamNativeNameMigrationPath = '../migrations/0008_stream_native_name.sql';
    const migration8 = migrationFiles[streamNativeNameMigrationPath] ?? '';

    it('declares the stream native name migration file', () => {
        expect(migrationFiles).toHaveProperty(streamNativeNameMigrationPath);
    });

    it('adds a native_name column to language_streams', () => {
        expect(migration8).toContain(
            "ALTER TABLE language_streams ADD COLUMN native_name TEXT NOT NULL DEFAULT ''",
        );
    });

    it('applies the native_name column to D1 as NOT NULL TEXT defaulting to empty', async () => {
        const results = (await testEnv.DB.prepare(
            'PRAGMA table_info(language_streams)',
        ).all()) as Array<{
            name: string;
            type: string;
            notnull: number;
            dflt_value: string;
        }>;
        const columnNames = results.map((column) => column.name);
        expect(columnNames).toEqual(expect.arrayContaining(['native_name']));

        const byName = new Map(results.map((column) => [column.name, column]));
        expect(byName.get('native_name')).toMatchObject({
            type: 'TEXT',
            notnull: 1,
        });
    });

    it('backfills existing rows with an empty native name', async () => {
        const graph = await seedProgramGraph();
        const row = (await testEnv.DB.prepare(
            'SELECT native_name as nativeName FROM language_streams WHERE id = ?',
        )
            .bind(graph.p1Stream)
            .get()) as { nativeName: string } | undefined;
        expect(row?.nativeName).toBe('');
    });
});

describe('stream native name backfill D1 schema', () => {
    const backfillMigrationPath = '../migrations/0009_backfill_native_name.sql';
    const migration9 = migrationFiles[backfillMigrationPath] ?? '';

    it('declares the native name backfill migration file', () => {
        expect(migrationFiles).toHaveProperty(backfillMigrationPath);
    });

    it('maps language codes to their registry native names', () => {
        for (const fragment of [
            "WHEN 'hi' THEN 'हिन्दी'",
            "WHEN 'bn' THEN 'বাংলা'",
            "WHEN 'en' THEN 'English'",
            "WHERE native_name = '' OR native_name IS NULL",
        ]) {
            expect(migration9).toContain(fragment);
        }
    });

    it('backfills empty native_name rows from language_code', async () => {
        const graph = await seedProgramGraph();
        // Migrations auto-apply on an empty table at setup, so re-run the backfill
        // statement after seeding legacy rows to verify it derives native script.
        const updateSql = migration9.slice(migration9.indexOf('UPDATE'));
        await testEnv.DB.prepare(updateSql).run();

        const hindi = (await testEnv.DB.prepare(
            'SELECT native_name as nativeName FROM language_streams WHERE id = ?',
        )
            .bind(graph.p1Stream)
            .get()) as { nativeName: string } | undefined;
        expect(hindi?.nativeName).toBe('हिन्दी');

        const english = (await testEnv.DB.prepare(
            'SELECT native_name as nativeName FROM language_streams WHERE id = ?',
        )
            .bind(graph.p2Stream)
            .get()) as { nativeName: string } | undefined;
        expect(english?.nativeName).toBe('English');
    });
});

describe('listener device label D1 schema', () => {
    const listenerDeviceLabelMigrationPath = '../migrations/0013_listener_device_label.sql';
    const listenerClientHintsMigrationPath = '../migrations/0014_listener_client_hints.sql';

    it('declares the device label backfill migration file', () => {
        expect(migrationFiles).toHaveProperty(listenerDeviceLabelMigrationPath);
    });

    it('declares nullable listener client hint columns', () => {
        expect(migrationFiles).toHaveProperty(listenerClientHintsMigrationPath);
        expect(migrationFiles[listenerClientHintsMigrationPath]).toContain(
            'ALTER TABLE listener_connections ADD COLUMN client_device_model TEXT;',
        );
        expect(migrationFiles[listenerClientHintsMigrationPath]).toContain(
            'ALTER TABLE listener_connections ADD COLUMN client_platform TEXT;',
        );
        expect(migrationFiles[listenerClientHintsMigrationPath]).toContain(
            'ALTER TABLE listener_connections ADD COLUMN client_platform_version TEXT;',
        );
        expect(migrationFiles[listenerClientHintsMigrationPath]).toContain(
            'ALTER TABLE listener_connections ADD COLUMN client_browser_full_version TEXT;',
        );
    });
});

describe('listener access control D1 schema', () => {
    it('declares the listener access control migration file', () => {
        expect(migrationFiles).toHaveProperty(listenerAccessControlMigrationPath);
    });

    it('declares the program flag and listener access tables and indexes', () => {
        for (const fragment of [
            'ALTER TABLE programs ADD COLUMN access_control_enabled INTEGER NOT NULL DEFAULT 0',
            'CHECK (access_control_enabled IN (0, 1))',
            'CREATE TABLE volunteer_accounts',
            'CREATE TABLE volunteer_sessions',
            'CREATE TABLE volunteer_login_attempts',
            'CREATE TABLE listener_access',
            'CREATE INDEX idx_volunteer_sessions_program ON volunteer_sessions(program_id)',
            'CREATE UNIQUE INDEX idx_listener_access_program_code ON listener_access(program_id, short_code)',
            'CREATE UNIQUE INDEX idx_listener_access_token ON listener_access(access_token_hash)',
            'CREATE INDEX idx_listener_access_client ON listener_access(program_id, client_id, created_at)',
            'CREATE INDEX idx_listener_access_status ON listener_access(program_id, status)',
            'CREATE INDEX idx_listener_access_approved_at ON listener_access(program_id, approved_at)',
        ]) {
            expect(migration21).toContain(fragment);
        }
    });

    it('applies the listener access control schema to D1', async () => {
        const programColumns = (await testEnv.DB.prepare(
            'PRAGMA table_info(programs)',
        ).all()) as Array<{
            name: string;
            type: string;
            notnull: number;
            dflt_value: string | null;
        }>;
        expect(
            programColumns.find((column) => column.name === 'access_control_enabled'),
        ).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });

        const tables = (await testEnv.DB.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table'",
        ).all()) as Array<{ name: string }>;
        expect(tables.map((row) => row.name)).toEqual(
            expect.arrayContaining([
                'volunteer_accounts',
                'volunteer_sessions',
                'volunteer_login_attempts',
                'listener_access',
            ]),
        );

        const expectedColumns = {
            volunteer_accounts: [
                'program_id',
                'login_id',
                'password_hash',
                'password_updated_at',
                'created_at',
                'updated_at',
            ],
            volunteer_sessions: [
                'id',
                'session_hash',
                'program_id',
                'absolute_expires_at',
                'expires_at',
                'last_seen_at',
                'created_at',
            ],
            volunteer_login_attempts: [
                'program_id',
                'ip_hash',
                'window_start',
                'attempt_count',
                'locked_until',
            ],
            listener_access: [
                'id',
                'program_id',
                'client_id',
                'short_code',
                'claim_secret_hash',
                'status',
                'access_token_hash',
                'created_at',
                'approved_at',
                'approved_via',
                'revoked_at',
                'superseded_at',
            ],
        } as const;
        for (const [table, columns] of Object.entries(expectedColumns)) {
            const tableInfo = (await testEnv.DB.prepare(
                `PRAGMA table_info(${table})`,
            ).all()) as Array<{ name: string }>;
            expect(tableInfo.map((column) => column.name)).toEqual(
                expect.arrayContaining(Array.from(columns)),
            );
        }

        const indexes = (await testEnv.DB.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index'",
        ).all()) as Array<{ name: string }>;
        expect(indexes.map((row) => row.name)).toEqual(
            expect.arrayContaining([
                'idx_volunteer_sessions_program',
                'idx_listener_access_program_code',
                'idx_listener_access_token',
                'idx_listener_access_client',
                'idx_listener_access_status',
                'idx_listener_access_approved_at',
            ]),
        );

        const tokenIndex = (await testEnv.DB.prepare('SELECT sql FROM sqlite_master WHERE name = ?')
            .bind('idx_listener_access_token')
            .get()) as { sql: string | null } | undefined;
        expect(tokenIndex?.sql).toContain('WHERE access_token_hash IS NOT NULL');
    });

    it('enforces listener access CHECK and NOT NULL constraints', async () => {
        const graph = await seedProgramGraph();

        await expect(
            execute(
                `INSERT INTO listener_access
        (id, program_id, client_id, short_code, claim_secret_hash, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
                `access-${crypto.randomUUID()}`,
                graph.p1,
                'client-invalid-status',
                'STAT01',
                'claim-invalid-status',
                'invalid',
                graph.now,
            ),
        ).rejects.toThrow(/CHECK|constraint|D1_ERROR/);

        await expect(
            execute(
                `INSERT INTO listener_access
        (id, program_id, client_id, short_code, claim_secret_hash, status, created_at, approved_via)
        VALUES (?, ?, ?, ?, ?, 'approved', ?, ?)`,
                `access-${crypto.randomUUID()}`,
                graph.p1,
                'client-invalid-approved-via',
                'VIA001',
                'claim-invalid-approved-via',
                graph.now,
                'invalid',
            ),
        ).rejects.toThrow(/CHECK|constraint|D1_ERROR/);

        await expect(
            execute(
                `INSERT INTO listener_access
        (id, program_id, client_id, short_code, claim_secret_hash, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
                `access-${crypto.randomUUID()}`,
                graph.p1,
                'client-null-claim',
                'NULL01',
                null,
                graph.now,
            ),
        ).rejects.toThrow(/NOT NULL|constraint|D1_ERROR/);
    });

    it('enforces the programs access-control flag CHECK constraint', async () => {
        const suffix = crypto.randomUUID();
        const now = '2026-08-26T12:00:00.000Z';

        await expect(
            execute(
                `INSERT INTO programs
        (id, slug, name, venue, event_date, status, created_at, updated_at, access_control_enabled)
        VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, 2)`,
                `program-invalid-access-${suffix}`,
                `program-invalid-access-${suffix}`,
                'Invalid access flag program',
                'Main Hall',
                '2026-08-26',
                now,
                now,
            ),
        ).rejects.toThrow(/CHECK|constraint|D1_ERROR/);
    });

    it('enforces volunteer session hashes and listener short codes as unique', async () => {
        const graph = await seedProgramGraph();
        const sessionHash = `session-hash-${crypto.randomUUID()}`;

        await execute(
            `INSERT INTO volunteer_sessions
      (id, session_hash, program_id, absolute_expires_at, expires_at, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
            `session-${crypto.randomUUID()}`,
            sessionHash,
            graph.p1,
            graph.now,
            graph.now,
            graph.now,
            graph.now,
        );
        await expect(
            execute(
                `INSERT INTO volunteer_sessions
        (id, session_hash, program_id, absolute_expires_at, expires_at, last_seen_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
                `session-${crypto.randomUUID()}`,
                sessionHash,
                graph.p1,
                graph.now,
                graph.now,
                graph.now,
                graph.now,
            ),
        ).rejects.toThrow(/UNIQUE|constraint|D1_ERROR/);

        const shortCode = 'UNIQ01';
        await execute(
            `INSERT INTO listener_access
      (id, program_id, client_id, short_code, claim_secret_hash, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
            `access-${crypto.randomUUID()}`,
            graph.p1,
            'client-unique-one',
            shortCode,
            'claim-unique-one',
            graph.now,
        );
        await expect(
            execute(
                `INSERT INTO listener_access
        (id, program_id, client_id, short_code, claim_secret_hash, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
                `access-${crypto.randomUUID()}`,
                graph.p1,
                'client-unique-two',
                shortCode,
                'claim-unique-two',
                graph.now,
            ),
        ).rejects.toThrow(/UNIQUE|constraint|D1_ERROR/);
    });
});
