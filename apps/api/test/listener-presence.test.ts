import { beforeEach, describe, expect, it } from 'vitest';

import { ListenerInvalidStateError, ListenerRepository } from '../src/db/listenerRepository';
import { deviceLabelFromUserAgent } from '../src/domain/deviceLabel';
import { testEnv } from './test-env';

/**
 * Repository-level tests for D1 listener presence tracking (Slice 2).
 *
 * These exercise `markConnected` last_seen_at seeding, `recordHeartbeat`, and
 * `countActiveListeners` directly against the test D1 instance. They are
 * additive: no route, Durable Object, or frontend wiring is involved.
 */

async function resetDb(): Promise<void> {
    await testEnv.DB.exec('DELETE FROM listener_realtime_cleanup_targets');
    await testEnv.DB.exec('DELETE FROM realtime_publish_sessions');
    await testEnv.DB.exec('DELETE FROM translator_sessions');
    await testEnv.DB.exec('DELETE FROM stream_events');
    await testEnv.DB.exec('DELETE FROM listener_connections');
    await testEnv.DB.exec('DELETE FROM admin_sessions');
    await testEnv.DB.exec('DELETE FROM translator_stream_assignments');
    await testEnv.DB.exec('DELETE FROM translators');
    await testEnv.DB.exec('DELETE FROM language_streams');
    await testEnv.DB.exec('DELETE FROM programs');
}

interface SeededProgram {
    programId: string;
    streamIds: string[];
}

interface RawConnection {
    userAgent: string;
    deviceLabel: string | null;
}

/**
 * Seeds one program with `streamCount` active language streams. Returns the
 * program id and the ordered stream ids so tests can attach listeners to a
 * specific stream.
 */
async function seedProgram(streamCount = 1): Promise<SeededProgram> {
    const suffix = crypto.randomUUID();
    const now = new Date().toISOString();
    const programId = `program_presence_${suffix}`;
    const slug = `presence-program-${suffix}`;

    testEnv.DB.prepare(
        `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(programId, slug, 'Presence Event', 'Hall', '2026-08-01', 'live', '', now, now);

    const streamIds: string[] = [];
    for (let index = 0; index < streamCount; index += 1) {
        const streamId = `stream_${index}_${suffix}`;
        streamIds.push(streamId);
        testEnv.DB.prepare(
            `INSERT INTO language_streams
      (id, program_id, language_name, language_code, display_order, is_active,
       is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(streamId, programId, `Lang ${index}`, `l${index}`, index, 1, 0, null, null, now, now);
    }

    return { programId, streamIds };
}

/**
 * Creates a `requested` listener connection on a stream and returns its id, so
 * a test can drive it through markConnected/recordHeartbeat.
 */
async function seedRequestedListener(
    repository: ListenerRepository,
    program: SeededProgram,
    streamIndex = 0,
): Promise<string> {
    const streamId = program.streamIds[streamIndex];
    if (!streamId) {
        throw new Error(`no seeded stream at index ${streamIndex}`);
    }
    const connection = await repository.createRequestedConnection({
        programId: program.programId,
        streamId,
        clientId: `client_${crypto.randomUUID()}`,
        listenerIp: '203.0.113.1',
        userAgent: 'presence-test',
    });
    return connection.id;
}

/** Reads the raw last_seen_at column for a connection. */
async function readLastSeenAt(connectionId: string): Promise<string | null> {
    const row = testEnv.DB.prepare(
        'SELECT last_seen_at as lastSeenAt FROM listener_connections WHERE id = ?',
    ).get(connectionId) as { lastSeenAt: string | null } | undefined;
    return row?.lastSeenAt ?? null;
}

/** Force-sets last_seen_at to a fixed timestamp, simulating clock advancement. */
async function setLastSeenAt(connectionId: string, isoTimestamp: string): Promise<void> {
    testEnv.DB.prepare('UPDATE listener_connections SET last_seen_at = ? WHERE id = ?').run(
        isoTimestamp,
        connectionId,
    );
}

async function insertConnectionWithoutDeviceLabel(
    programId: string,
    streamId: string,
    userAgent: string,
    createdAt: string,
): Promise<string> {
    const id = `legacy_connection_${crypto.randomUUID()}`;
    testEnv.DB.prepare(
        `INSERT INTO listener_connections
    (id, program_id, language_stream_id, client_id, token_issued_at,
     subscription_status, connected_at, disconnected_at, disconnect_reason,
     switch_from_connection_id, reconnect_of_connection_id, listener_ip,
     user_agent, device_label, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        id,
        programId,
        streamId,
        `client_${id}`,
        createdAt,
        'requested',
        null,
        null,
        null,
        null,
        null,
        '203.0.113.1',
        userAgent,
        null,
        createdAt,
        createdAt,
    );

    return id;
}

async function listRawConnections(programId: string): Promise<RawConnection[]> {
    const results = testEnv.DB.prepare(
        `SELECT user_agent as userAgent, device_label as deviceLabel
      FROM listener_connections
      WHERE program_id = ?`,
    ).all(programId) as Array<{ userAgent: string; deviceLabel: string | null }>;

    return results.map((row) => ({
        userAgent: row.userAgent,
        deviceLabel: row.deviceLabel,
    }));
}

function assertStoredDeviceLabelConsistency(
    rows: ReadonlyArray<RawConnection>,
    expectedNonNullCount: number,
) {
    const nonNullRows = rows.filter((row) => row.deviceLabel !== null);
    expect(nonNullRows).toHaveLength(expectedNonNullCount);
    for (const row of nonNullRows) {
        expect(row.deviceLabel).toBe(deviceLabelFromUserAgent(row.userAgent));
    }
}

describe('ListenerRepository presence tracking', () => {
    let repository: ListenerRepository;

    beforeEach(async () => {
        await resetDb();
        repository = new ListenerRepository(testEnv.DB);
    });

    describe('markConnected last_seen_at seeding', () => {
        it('seeds a non-null last_seen_at when a listener connects (no heartbeat yet)', async () => {
            const program = await seedProgram();
            const connectionId = await seedRequestedListener(repository, program);

            const { changed } = await repository.markConnected(connectionId);

            expect(changed).toBe(true);
            const lastSeenAt = await readLastSeenAt(connectionId);
            expect(lastSeenAt).not.toBeNull();
        });

        it('counts a just-connected listener that has not yet sent a heartbeat', async () => {
            const program = await seedProgram();
            const connectionId = await seedRequestedListener(repository, program);

            await repository.markConnected(connectionId);

            // A wide window so the freshly-seeded last_seen_at is always in-window.
            const result = await repository.countActiveListeners(program.programId, 3600);
            expect(result.total).toBe(1);
        });
    });

    describe('recordHeartbeat', () => {
        it('advances last_seen_at on a connected listener', async () => {
            const program = await seedProgram();
            const connectionId = await seedRequestedListener(repository, program);
            await repository.markConnected(connectionId);

            // Push the seeded last_seen_at into the past so the heartbeat must move it.
            const past = new Date(Date.now() - 60_000).toISOString();
            await setLastSeenAt(connectionId, past);

            await repository.recordHeartbeat(connectionId);

            const after = await readLastSeenAt(connectionId);
            expect(after).not.toBeNull();
            expect((after as string) > past).toBe(true);
        });

        it('throws ListenerInvalidStateError when heartbeating a non-connected listener', async () => {
            const program = await seedProgram();
            const connectionId = await seedRequestedListener(repository, program);
            // Still `requested` — never connected.

            await expect(repository.recordHeartbeat(connectionId)).rejects.toBeInstanceOf(
                ListenerInvalidStateError,
            );
        });

        it('throws ListenerInvalidStateError when the connection does not exist', async () => {
            await expect(
                repository.recordHeartbeat('listener_connection_missing'),
            ).rejects.toBeInstanceOf(ListenerInvalidStateError);
        });
    });

    describe('countActiveListeners', () => {
        it('counts only listeners whose last_seen_at is within the window', async () => {
            const program = await seedProgram();
            const fresh = await seedRequestedListener(repository, program);
            const stale = await seedRequestedListener(repository, program);
            await repository.markConnected(fresh);
            await repository.markConnected(stale);

            // `fresh` keeps its recent seeded last_seen_at; `stale` is pushed well
            // outside a 30s window.
            await setLastSeenAt(stale, new Date(Date.now() - 120_000).toISOString());

            const result = await repository.countActiveListeners(program.programId, 30);

            expect(result.total).toBe(1);
        });

        it('groups counts per language stream', async () => {
            const program = await seedProgram(2);
            const [streamA, streamB] = program.streamIds;

            const a1 = await seedRequestedListener(repository, program, 0);
            const a2 = await seedRequestedListener(repository, program, 0);
            const b1 = await seedRequestedListener(repository, program, 1);
            await repository.markConnected(a1);
            await repository.markConnected(a2);
            await repository.markConnected(b1);

            const result = await repository.countActiveListeners(program.programId, 3600);

            expect(result.total).toBe(3);
            const byStream = new Map(result.streams.map((row) => [row.streamId, row.count]));
            expect(byStream.get(streamA as string)).toBe(2);
            expect(byStream.get(streamB as string)).toBe(1);
        });

        it('excludes rows with a null last_seen_at', async () => {
            const program = await seedProgram();
            const connectionId = await seedRequestedListener(repository, program);
            await repository.markConnected(connectionId);
            // Null out last_seen_at to simulate a legacy/never-seeded row.
            await setLastSeenAt(connectionId, null as unknown as string);

            const result = await repository.countActiveListeners(program.programId, 3600);

            expect(result.total).toBe(0);
        });

        it('excludes non-connected listeners regardless of last_seen_at', async () => {
            const program = await seedProgram();
            const connectionId = await seedRequestedListener(repository, program);
            await repository.markConnected(connectionId);
            // Recent last_seen_at, but the connection is disconnected.
            await repository.disconnectConnection(connectionId, 'client_disconnect');
            await setLastSeenAt(connectionId, new Date().toISOString());

            const result = await repository.countActiveListeners(program.programId, 3600);

            expect(result.total).toBe(0);
        });

        it('returns an empty result for a program with no active listeners', async () => {
            const program = await seedProgram();

            const result = await repository.countActiveListeners(program.programId, 3600);

            expect(result.total).toBe(0);
            expect(result.streams).toEqual([]);
        });
    });

    describe('device label persistence and backfill', () => {
        it('stores a derived device label on requested connection creation', async () => {
            const program = await seedProgram();
            const streamId = program.streamIds[0];
            if (!streamId) {
                throw new Error('stream id missing');
            }

            const userAgent =
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36';
            const connection = await repository.createRequestedConnection({
                programId: program.programId,
                streamId,
                clientId: `client_${crypto.randomUUID()}`,
                listenerIp: '203.0.113.11',
                userAgent,
            });

            const row = testEnv.DB.prepare(
                `SELECT device_label as deviceLabel
        FROM listener_connections
        WHERE id = ?`,
            ).get(connection.id) as { deviceLabel: string | null } | undefined;

            expect(row?.deviceLabel).toBe(deviceLabelFromUserAgent(userAgent));
        });

        it('backfills device labels in bounded batches', async () => {
            const program = await seedProgram();
            const streamId = program.streamIds[0];
            if (!streamId) {
                throw new Error('stream id missing');
            }

            const baseTime = Date.parse('2026-06-24T00:00:00.000Z');
            const userAgents = [
                'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1',
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
                'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/120.0 Mobile/15E148 Safari/605.1.15',
            ];

            for (const [index, userAgent] of userAgents.entries()) {
                await insertConnectionWithoutDeviceLabel(
                    program.programId,
                    streamId,
                    userAgent,
                    new Date(baseTime + index).toISOString(),
                );
            }

            const first = await repository.backfillDeviceLabels(2);
            expect(first).toEqual({ updated: 2, remaining: 3 });
            const afterFirst = await listRawConnections(program.programId);
            assertStoredDeviceLabelConsistency(afterFirst, 2);

            const second = await repository.backfillDeviceLabels(2);
            expect(second).toEqual({ updated: 2, remaining: 1 });
            assertStoredDeviceLabelConsistency(await listRawConnections(program.programId), 4);

            const third = await repository.backfillDeviceLabels(2);
            expect(third).toEqual({ updated: 1, remaining: 0 });
            assertStoredDeviceLabelConsistency(await listRawConnections(program.programId), 5);

            const fourth = await repository.backfillDeviceLabels(2);
            expect(fourth).toEqual({ updated: 0, remaining: 0 });
            assertStoredDeviceLabelConsistency(await listRawConnections(program.programId), 5);
        });
    });
});
