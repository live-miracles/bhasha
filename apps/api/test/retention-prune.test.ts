import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RetentionRepository } from '../src/db/retentionRepository';
import type { Database } from '../src/db/sqlite';
import { testEnv } from './test-env';

/**
 * The better-sqlite3 port of RetentionRepository's chunked-delete loops
 * prepares each chunk-delete statement ONCE and then calls `.run()` on it
 * repeatedly until a batch returns 0 changes (see `deleteInChunks` /
 * `deleteDailyAccessInChunks` in src/db/retentionRepository.ts) -- unlike the
 * old D1 code, which re-prepared the statement on every loop iteration. So
 * counting `db.prepare()` calls no longer proves multiple chunks ran; this
 * wraps `db` so every `.run()` call on a prepared statement is tallied by its
 * originating SQL text instead.
 */
function countRunCallsBySql(db: Database): {
    db: Database;
    runCallCounts: () => Map<string, number>;
} {
    const counts = new Map<string, number>();
    const wrapped = new Proxy(db, {
        get(target, property, receiver) {
            if (property !== 'prepare') {
                const value = Reflect.get(target, property, receiver);
                return typeof value === 'function' ? value.bind(target) : value;
            }

            return (sql: string) => {
                const statement = target.prepare(sql);
                return new Proxy(statement, {
                    get(stmtTarget, stmtProperty, stmtReceiver) {
                        if (stmtProperty !== 'run') {
                            const value = Reflect.get(stmtTarget, stmtProperty, stmtReceiver);
                            return typeof value === 'function' ? value.bind(stmtTarget) : value;
                        }

                        return (...args: unknown[]) => {
                            counts.set(sql, (counts.get(sql) ?? 0) + 1);
                            return (stmtTarget.run as (...a: unknown[]) => unknown)(...args);
                        };
                    },
                });
            };
        },
    }) as Database;

    return { db: wrapped, runCallCounts: () => counts };
}

type ForeignKeyRow = {
    table: string;
    from: string;
    to: string;
};

type D1PragmaTableRow = {
    name: string;
    sql: string | null;
};

const CASCADE_TABLES_IN_ORDER = [
    'listener_access',
    'volunteer_sessions',
    'volunteer_login_attempts',
    'volunteer_accounts',
    'listener_realtime_cleanup_targets',
    'realtime_publish_sessions',
    'translator_sessions',
    'translator_stream_assignments',
    'stream_events',
    'listener_connections',
    'program_readiness_checks',
    'translators',
    'language_streams',
    'programs',
] as const;

const CASCADE_CHILD_TABLES = CASCADE_TABLES_IN_ORDER.filter((table) => table !== 'programs');

async function resetDb(): Promise<void> {
    await testEnv.DB.exec('DELETE FROM listener_access');
    await testEnv.DB.exec('DELETE FROM volunteer_sessions');
    await testEnv.DB.exec('DELETE FROM volunteer_login_attempts');
    await testEnv.DB.exec('DELETE FROM volunteer_accounts');
    await testEnv.DB.exec('DELETE FROM listener_realtime_cleanup_targets');
    await testEnv.DB.exec('DELETE FROM realtime_publish_sessions');
    await testEnv.DB.exec('DELETE FROM translator_sessions');
    await testEnv.DB.exec('DELETE FROM stream_events');
    await testEnv.DB.exec('DELETE FROM listener_connections');
    await testEnv.DB.exec('DELETE FROM admin_sessions');
    await testEnv.DB.exec('DELETE FROM translator_stream_assignments');
    await testEnv.DB.exec('DELETE FROM translators');
    await testEnv.DB.exec('DELETE FROM language_streams');
    await testEnv.DB.exec('DELETE FROM program_readiness_checks');
    await testEnv.DB.exec('DELETE FROM programs');
}

async function seedProgram(input?: { deletedAt?: string }): Promise<{
    programId: string;
    streamId: string;
    translatorId: string;
}> {
    const now = new Date().toISOString();
    const programId = `program_retention_prune_${crypto.randomUUID()}`;
    const streamId = `stream_retention_prune_${crypto.randomUUID()}`;
    const translatorId = `translator_retention_prune_${crypto.randomUUID()}`;
    const connectionId = `connection_retention_prune_${crypto.randomUUID()}`;
    const deletedAt = input?.deletedAt ?? '2025-01-01T00:00:00.000Z';

    await testEnv.DB.prepare(
        `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        programId,
        programId,
        'Program for retention prune',
        'Main Hall',
        '2026-08-01',
        'live',
        'retention test',
        now,
        now,
        deletedAt,
    );

    await testEnv.DB.prepare(
        `INSERT INTO volunteer_accounts
    (program_id, login_id, password_hash, password_updated_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(programId, `${programId}@example.com`, 'sha256:volunteer-placeholder', now, now, now);

    await testEnv.DB.prepare(
        `INSERT INTO volunteer_sessions
    (id, session_hash, program_id, absolute_expires_at, expires_at, last_seen_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        `volunteer_session_${crypto.randomUUID()}`,
        `volunteer_hash_${crypto.randomUUID()}`,
        programId,
        now,
        now,
        now,
        now,
    );

    await testEnv.DB.prepare(
        `INSERT INTO volunteer_login_attempts
    (program_id, ip_hash, window_start, attempt_count, locked_until)
    VALUES (?, ?, ?, ?, ?)`,
    ).run(programId, `ip_hash_${crypto.randomUUID()}`, now, 1, null);

    await testEnv.DB.prepare(
        `INSERT INTO listener_access
    (id, program_id, client_id, short_code, claim_secret_hash, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(
        `listener_access_${crypto.randomUUID()}`,
        programId,
        `client_${crypto.randomUUID()}`,
        'ABC123',
        `claim_hash_${crypto.randomUUID()}`,
        now,
    );

    await testEnv.DB.prepare(
        `INSERT INTO language_streams
    (id, program_id, language_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
    ).run(streamId, programId, 'Hindi', 'hi', 1, 1, now, now);

    await testEnv.DB.prepare(
        `INSERT INTO translators
    (id, program_id, name, email, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        translatorId,
        programId,
        'Hindi translator',
        `${translatorId}@example.com`,
        'sha256:placeholder',
        now,
        now,
    );

    await testEnv.DB.prepare(
        `INSERT INTO translator_stream_assignments
    (program_id, translator_id, language_stream_id, created_at)
    VALUES (?, ?, ?, ?)`,
    ).run(programId, translatorId, streamId, now);

    await testEnv.DB.prepare(
        `INSERT INTO listener_connections
    (id, program_id, language_stream_id, client_id, token_issued_at,
     subscription_status, listener_ip, user_agent, created_at, updated_at,
     connected_at, last_seen_at, disconnected_at, disconnect_reason,
     switch_from_connection_id, reconnect_of_connection_id,
     cloudflare_session_id, cloudflare_track_mid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
    ).run(
        connectionId,
        programId,
        streamId,
        'client-retention-prune',
        now,
        'connected',
        '203.0.113.10',
        'connection',
        now,
        now,
    );

    await testEnv.DB.prepare(
        `INSERT INTO stream_events
    (id, program_id, stream_program_id, language_stream_id, event_type, occurred_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, '{}')`,
    ).run(
        `event_${crypto.randomUUID()}`,
        programId,
        programId,
        streamId,
        'listener_subscribed',
        now,
    );

    await testEnv.DB.prepare(
        `INSERT INTO program_readiness_checks
    (program_id, realtime_smoke_tested_at, mobile_field_tested_at, updated_at)
    VALUES (?, ?, ?, ?)`,
    ).run(programId, now, now, now);

    await testEnv.DB.prepare(
        `INSERT INTO translator_sessions
    (id, session_hash, program_id, translator_id, absolute_expires_at,
     expires_at, last_seen_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        `translator_session_${crypto.randomUUID()}`,
        `hash-${crypto.randomUUID()}`,
        programId,
        translatorId,
        now,
        now,
        now,
        now,
    );

    await testEnv.DB.prepare(
        `INSERT INTO realtime_publish_sessions
    (id, program_id, language_stream_id, translator_id, state, expires_at,
     closed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'published', ?, NULL, ?, ?)`,
    ).run(
        `publish_session_${crypto.randomUUID()}`,
        programId,
        streamId,
        translatorId,
        now,
        now,
        now,
    );

    await testEnv.DB.prepare(
        `INSERT INTO listener_realtime_cleanup_targets
    (connection_id, cloudflare_session_id, cloudflare_track_mid, cleanup_state, created_at, updated_at, closed_at)
    VALUES (?, ?, ?, 'pending', ?, ?, NULL)`,
    ).run(connectionId, 'session-prune', 'track-prune', now, now);

    return { programId, streamId, translatorId };
}

async function seedStreamEvents(input: {
    programId: string;
    streamId: string;
    count: number;
}): Promise<void> {
    const now = new Date().toISOString();
    const statement = testEnv.DB.prepare(
        `INSERT INTO stream_events
    (id, program_id, stream_program_id, language_stream_id, event_type, occurred_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, '{}')`,
    );

    for (let index = 0; index < input.count; index += 1) {
        await statement.run(
            `event_bulk_${input.programId}_${index}`,
            input.programId,
            input.programId,
            input.streamId,
            'listener_subscribed',
            now,
        );
    }
}

async function countForProgram(table: string, programId: string): Promise<number> {
    if (table === 'programs') {
        const row = (await testEnv.DB.prepare(
            'SELECT COUNT(*) as count FROM programs WHERE id = ?',
        ).get(programId)) as { count: number } | undefined;
        return row?.count ?? 0;
    }

    if (table === 'listener_realtime_cleanup_targets') {
        const row = (await testEnv.DB.prepare(
            `SELECT COUNT(*) as count
      FROM listener_realtime_cleanup_targets
      WHERE connection_id IN (SELECT id FROM listener_connections WHERE program_id = ?)`,
        ).get(programId)) as { count: number } | undefined;
        return row?.count ?? 0;
    }

    const row = (await testEnv.DB.prepare(
        `SELECT COUNT(*) as count FROM ${table} WHERE program_id = ?`,
    ).get(programId)) as { count: number } | undefined;
    return row?.count ?? 0;
}

async function programFkTablesFromPragma(): Promise<string[]> {
    const tables = testEnv.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name: string }>;

    const result: string[] = [];
    for (const table of tables) {
        const foreignKeys = testEnv.DB.prepare(
            `PRAGMA foreign_key_list(${table.name})`,
        ).all() as ForeignKeyRow[];

        const referencesProgramsByProgramId = foreignKeys.some(
            (fk) => fk.table === 'programs' && fk.from === 'program_id' && fk.to === 'id',
        );
        if (referencesProgramsByProgramId) {
            result.push(table.name);
        }
    }
    return result;
}

async function programFkTablesFallbackFromSchema(): Promise<string[]> {
    const tables = testEnv.DB.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all() as D1PragmaTableRow[];

    const result = tables
        .filter((row) => {
            const definition = (row.sql ?? '').toLowerCase();
            return /\bprogram_id\b/.test(definition);
        })
        .map((row) => row.name)
        .filter((name) => name !== 'sqlite_sequence')
        .sort();

    return result;
}

function isD1AuthError(error: unknown): boolean {
    if (error instanceof Error) {
        return error.message.includes('SQLITE_AUTH');
    }
    return false;
}

describe('retention prune behavior', () => {
    beforeEach(async () => {
        await resetDb();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('guards that every program-scoped table is covered by the prune scope', async () => {
        // Reality ⊆ prune-scope: enumerate every table with a program_id column that
        // FKs to programs, and assert EACH is covered by the prune's table set. A
        // FUTURE migration that adds a 10th program-scoped table without extending
        // the prune must FAIL this test rather than silently orphan rows.
        const programScopedTables = (
            await programFkTablesFromPragma().catch(async (error) => {
                if (!isD1AuthError(error)) {
                    throw error;
                }
                return programFkTablesFallbackFromSchema();
            })
        ).sort();

        // The prune deletes these tables directly by program_id...
        const pruneCovered = new Set<string>(
            CASCADE_CHILD_TABLES.filter((table) => table !== 'listener_realtime_cleanup_targets'),
        );
        // ...and listener_realtime_cleanup_targets transitively via the
        // connection_id subquery, so treat it as covered too.
        pruneCovered.add('listener_realtime_cleanup_targets');

        const uncovered = programScopedTables.filter((table) => !pruneCovered.has(table));
        expect(uncovered).toEqual([]);
        expect(CASCADE_TABLES_IN_ORDER).toContain('listener_realtime_cleanup_targets');
    });

    it('cascade-prunes all tables for a single program', async () => {
        const { programId, streamId } = await seedProgram();
        await seedStreamEvents({ programId, streamId, count: 1 });
        const createdAt = '2026-05-01T00:00:00.000Z';
        for (const [suffix, status] of [
            ['approved', 'approved'],
            ['revoked', 'revoked'],
            ['superseded', 'superseded'],
        ] as const) {
            await testEnv.DB.prepare(
                `INSERT INTO listener_access
        (id, program_id, client_id, short_code, claim_secret_hash, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ).run(
                `${programId}_access_${suffix}`,
                programId,
                `${programId}_history_client`,
                suffix.slice(0, 6).toUpperCase(),
                `${programId}_claim_${suffix}`,
                status,
                createdAt,
            );
        }
        expect(await countForProgram('listener_access', programId)).toBe(4);
        const pruneBefore = new Date('2026-06-01T00:00:00.000Z').toISOString();

        const retention = new RetentionRepository(testEnv.DB);
        await retention.pruneProgram(programId, pruneBefore);

        for (const table of CASCADE_TABLES_IN_ORDER) {
            const count = await countForProgram(table, programId);
            expect(count).toBe(0);
        }
    });

    it('leaves children untouched when the program is not eligible (restore-race guard)', async () => {
        // Program was restored before the prune ran: deleted_at IS NULL. The
        // eligibility gate must short-circuit BEFORE deleting any child rows.
        const { programId } = await seedProgram();
        await testEnv.DB.prepare('UPDATE programs SET deleted_at = NULL WHERE id = ?').run(
            programId,
        );
        const pruneBefore = new Date('2026-06-01T00:00:00.000Z').toISOString();

        const retention = new RetentionRepository(testEnv.DB);
        const result = await retention.pruneProgram(programId, pruneBefore);

        expect(result).toBe(false);
        // Every child table — and the program — must still be present.
        for (const table of CASCADE_TABLES_IN_ORDER) {
            const count = await countForProgram(table, programId);
            expect(count).toBeGreaterThan(0);
        }
    });

    it('deletes the programs row LAST so a crash mid-cascade leaves it for retry', async () => {
        // Prove ordering: spy on prepare and confirm the programs DELETE is the
        // last destructive statement issued, after all child deletes.
        const { programId, streamId } = await seedProgram();
        await seedStreamEvents({ programId, streamId, count: 1 });
        const pruneBefore = new Date('2026-06-01T00:00:00.000Z').toISOString();

        const prepareSpy = vi.spyOn(testEnv.DB, 'prepare');
        const retention = new RetentionRepository(testEnv.DB);
        await retention.pruneProgram(programId, pruneBefore);

        const deleteSqls = prepareSpy.mock.calls
            .map(([sql]) => sql)
            .filter((sql) => /^\s*DELETE FROM/i.test(sql));
        const programsDeleteIndex = deleteSqls.findIndex((sql) =>
            /DELETE FROM programs\b/i.test(sql),
        );
        expect(programsDeleteIndex).toBeGreaterThanOrEqual(0);
        // No child DELETE may appear AFTER the programs DELETE.
        const afterProgramsDelete = deleteSqls.slice(programsDeleteIndex + 1);
        expect(afterProgramsDelete.some((sql) => !/DELETE FROM programs\b/i.test(sql))).toBe(false);

        for (const table of CASCADE_TABLES_IN_ORDER) {
            expect(await countForProgram(table, programId)).toBe(0);
        }
    });

    it('uses chunked deletes for high-volume stream_events rows', async () => {
        const { programId, streamId } = await seedProgram();
        // 620 rows > the 500-row chunk size, so a correct chunked delete must run
        // at least two batches (500 + 120). A single unbounded delete would run
        // exactly one — this assertion fails in that case, proving chunking.
        await seedStreamEvents({ programId, streamId, count: 620 });
        const pruneBefore = new Date('2026-06-01T00:00:00.000Z').toISOString();

        // Count how many times the stream_events chunk-delete statement's
        // `.run()` is invoked (the statement itself is prepared once; see
        // countRunCallsBySql above).
        const isStreamEventChunkDelete = (sql: string): boolean =>
            /DELETE FROM stream_events\b/i.test(sql) &&
            /LIMIT/i.test(sql) &&
            /SELECT id FROM stream_events/i.test(sql);
        const { db: countingDb, runCallCounts } = countRunCallsBySql(testEnv.DB);

        const retention = new RetentionRepository(countingDb);
        await retention.pruneProgram(programId, pruneBefore);

        let streamEventChunkRunCalls = 0;
        for (const [sql, count] of runCallCounts()) {
            if (isStreamEventChunkDelete(sql)) {
                streamEventChunkRunCalls += count;
            }
        }
        // First iteration deletes 500, second deletes 120, third returns 0 and
        // terminates — so >= 2 run() calls that actually changed rows plus the
        // terminating call. Assert >= 2 to prove more than a single unbounded
        // delete ran.
        expect(streamEventChunkRunCalls).toBeGreaterThanOrEqual(2);

        const streamEventCount = await countForProgram('stream_events', programId);
        expect(streamEventCount).toBe(0);
    });

    it('daily-prunes only stale pending and superseded listener access rows', async () => {
        const programId = `program_daily_access_${crypto.randomUUID()}`;
        const old = '2026-08-25T11:59:59.999Z';
        const boundary = '2026-08-25T12:00:00.000Z';
        const recent = '2026-08-25T12:00:00.001Z';
        const rows = [
            ['old_pending', 'pending', old],
            ['old_superseded', 'superseded', old],
            ['boundary_pending', 'pending', boundary],
            ['recent_pending', 'pending', recent],
            ['old_approved', 'approved', old],
            ['old_revoked', 'revoked', old],
        ] as const;

        for (const [suffix, status, createdAt] of rows) {
            await testEnv.DB.prepare(
                `INSERT INTO listener_access
        (id, program_id, client_id, short_code, claim_secret_hash, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ).run(
                `${programId}_${suffix}`,
                programId,
                `client_${suffix}`,
                suffix.slice(0, 6).toUpperCase(),
                `claim_${suffix}`,
                status,
                createdAt,
            );
        }

        const retention = new RetentionRepository(testEnv.DB);
        await retention.pruneDailyAccessData(new Date('2026-08-26T12:00:00.000Z'));

        const results = testEnv.DB.prepare(
            'SELECT id FROM listener_access WHERE program_id = ? ORDER BY id',
        ).all(programId) as { id: string }[];
        expect(results.map((row) => row.id)).toEqual([
            `${programId}_boundary_pending`,
            `${programId}_old_approved`,
            `${programId}_old_revoked`,
            `${programId}_recent_pending`,
        ]);
    });

    it('daily-prunes eligible access rows in bounded chunks', async () => {
        const programId = `program_daily_chunked_${crypto.randomUUID()}`;
        const stale = '2026-08-25T11:59:59.999Z';
        const expired = '2026-08-26T11:59:59.999Z';

        for (let index = 0; index < 5; index += 1) {
            await testEnv.DB.prepare(
                `INSERT INTO listener_access
        (id, program_id, client_id, short_code, claim_secret_hash, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
            ).run(
                `${programId}_access_${index}`,
                programId,
                `client_${index}`,
                `CHNK${index}`,
                `claim_${index}`,
                stale,
            );
            await testEnv.DB.prepare(
                `INSERT INTO volunteer_sessions
        (id, session_hash, program_id, absolute_expires_at, expires_at, last_seen_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ).run(
                `${programId}_session_${index}`,
                `${programId}_hash_${index}`,
                programId,
                expired,
                expired,
                stale,
                stale,
            );
            await testEnv.DB.prepare(
                `INSERT INTO volunteer_login_attempts
        (program_id, ip_hash, window_start, attempt_count, locked_until)
        VALUES (?, ?, ?, 1, NULL)`,
            ).run(programId, `ip_${index}`, stale);
        }

        const { db: countingDb, runCallCounts } = countRunCallsBySql(testEnv.DB);
        const retention = new RetentionRepository(countingDb);
        await retention.pruneDailyAccessData(new Date('2026-08-26T12:00:00.000Z'), {
            chunkSize: 2,
        });

        for (const table of ['listener_access', 'volunteer_sessions', 'volunteer_login_attempts']) {
            expect(await countForProgram(table, programId)).toBe(0);
            let chunkRunCalls = 0;
            for (const [sql, count] of runCallCounts()) {
                if (
                    new RegExp(`DELETE FROM ${table}\\b`, 'i').test(sql) &&
                    /SELECT rowid/i.test(sql) &&
                    /LIMIT 2/i.test(sql)
                ) {
                    chunkRunCalls += count;
                }
            }
            expect(chunkRunCalls).toBeGreaterThanOrEqual(3);
        }
    });

    it('daily-prunes volunteer sessions expired by idle or absolute expiry', async () => {
        const programId = `program_daily_sessions_${crypto.randomUUID()}`;
        const past = '2026-08-26T11:59:59.999Z';
        const boundary = '2026-08-26T12:00:00.000Z';
        const future = '2026-08-26T12:00:00.001Z';
        const rows = [
            ['idle_expired', past, future],
            ['absolute_expired', future, past],
            ['future', future, future],
            ['boundary', boundary, boundary],
        ] as const;

        for (const [suffix, expiresAt, absoluteExpiresAt] of rows) {
            await testEnv.DB.prepare(
                `INSERT INTO volunteer_sessions
        (id, session_hash, program_id, absolute_expires_at, expires_at, last_seen_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ).run(
                `${programId}_${suffix}`,
                `hash_${programId}_${suffix}`,
                programId,
                absoluteExpiresAt,
                expiresAt,
                boundary,
                boundary,
            );
        }

        const retention = new RetentionRepository(testEnv.DB);
        await retention.pruneDailyAccessData(new Date('2026-08-26T12:00:00.000Z'));

        const results = testEnv.DB.prepare(
            'SELECT id FROM volunteer_sessions WHERE program_id = ? ORDER BY id',
        ).all(programId) as { id: string }[];
        expect(results.map((row) => row.id)).toEqual([`${programId}_future`]);
    });

    it('daily-prunes stale unlocked or expired-lock volunteer login attempts', async () => {
        const programId = `program_daily_attempts_${crypto.randomUUID()}`;
        const oldWindow = '2026-08-25T11:59:59.999Z';
        const boundaryWindow = '2026-08-25T12:00:00.000Z';
        const recentWindow = '2026-08-25T12:00:00.001Z';
        const expiredLock = '2026-08-26T11:59:59.999Z';
        const boundaryLock = '2026-08-26T12:00:00.000Z';
        const futureLock = '2026-08-26T12:00:00.001Z';
        const rows = [
            ['old_unlocked', oldWindow, null],
            ['old_expired_lock', oldWindow, expiredLock],
            ['old_boundary_lock', oldWindow, boundaryLock],
            ['old_future_lock', oldWindow, futureLock],
            ['recent_unlocked', recentWindow, null],
            ['boundary_unlocked', boundaryWindow, null],
        ] as const;

        for (const [ipHash, windowStart, lockedUntil] of rows) {
            await testEnv.DB.prepare(
                `INSERT INTO volunteer_login_attempts
        (program_id, ip_hash, window_start, attempt_count, locked_until)
        VALUES (?, ?, ?, 1, ?)`,
            ).run(programId, ipHash, windowStart, lockedUntil);
        }

        const retention = new RetentionRepository(testEnv.DB);
        await retention.pruneDailyAccessData(new Date('2026-08-26T12:00:00.000Z'));

        const results = testEnv.DB.prepare(
            'SELECT ip_hash as ipHash FROM volunteer_login_attempts WHERE program_id = ? ORDER BY ip_hash',
        ).all(programId) as { ipHash: string }[];
        expect(results.map((row) => row.ipHash)).toEqual([
            'boundary_unlocked',
            'old_future_lock',
            'recent_unlocked',
        ]);
    });
});
