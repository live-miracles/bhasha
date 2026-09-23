import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/env';
import { createApp } from '../src/index';
import type { Database } from '../src/db/sqlite';
import * as presenceStatus from '../src/presence/status';
import { adminCookie, buildTestEnv, seedPlatformAdmin, seedProgram, testEnv } from './test-env';

async function request(
    path: string,
    init: RequestInit = {},
    env: Env = buildTestEnv(),
): Promise<Response> {
    const app = createApp(env);
    return app.fetch(new Request(`https://bhasha.test${path}`, init));
}

async function seedProgramAndStreams() {
    const cookie = await adminCookie();
    const suffix = crypto.randomUUID();
    const program = await seedProgram(testEnv, {
        slug: `patna-event-${suffix}`,
        name: 'Patna Event 2026',
    });

    const hindiResponse = await request(`/api/admin/programs/${program.id}/streams`, {
        method: 'POST',
        headers: { Cookie: cookie },
        body: JSON.stringify({
            languageName: 'Hindi',
            languageCode: 'hi',
            displayOrder: 1,
            isActive: true,
        }),
    });
    const hindi = (await hindiResponse.json()) as { id: string };

    const englishResponse = await request(`/api/admin/programs/${program.id}/streams`, {
        method: 'POST',
        headers: { Cookie: cookie },
        body: JSON.stringify({
            languageName: 'English',
            languageCode: 'en',
            displayOrder: 2,
            isActive: true,
        }),
    });
    const english = (await englishResponse.json()) as { id: string };

    return { cookie, program, hindi, english };
}

async function presenceTotal(programId: string): Promise<number> {
    const threshold = new Date(Date.now() - 120_000).toISOString();
    const row = testEnv.DB.prepare(
        `SELECT COUNT(*) as total
     FROM listener_connections
     WHERE program_id = ?
       AND subscription_status = 'connected'
       AND last_seen_at > ?`,
    ).get(programId, threshold) as { total: string | number } | undefined;
    return Number(row?.total ?? 0);
}

async function storedConnection(connectionId: string): Promise<{
    listenerIp: string;
    userAgent: string;
    deviceModel: string | null;
    platform: string | null;
    platformVersion: string | null;
    browserFullVersion: string | null;
    updatedAt: string;
    lastSeenAt: string | null;
}> {
    const row = testEnv.DB.prepare(
        `SELECT listener_ip as listenerIp,
      user_agent as userAgent,
      client_device_model as deviceModel,
      client_platform as platform,
      client_platform_version as platformVersion,
      client_browser_full_version as browserFullVersion,
      updated_at as updatedAt,
      last_seen_at as lastSeenAt
    FROM listener_connections
    WHERE id = ?`,
    ).get(connectionId) as
        | {
              listenerIp: string;
              userAgent: string;
              deviceModel: string | null;
              platform: string | null;
              platformVersion: string | null;
              browserFullVersion: string | null;
              updatedAt: string;
              lastSeenAt: string | null;
          }
        | undefined;
    if (!row) {
        throw new Error('listener connection row was not found');
    }
    return row;
}

/**
 * Wraps `testEnv.DB` so the guarded "mark connected" UPDATE races against a
 * concurrent disconnect: right before that specific UPDATE runs, a separate
 * disconnect UPDATE for the same connection is applied first. This pins the
 * guarded-UPDATE contract (WHERE ... AND subscription_status = 'requested')
 * without needing any Durable Object / presence plumbing.
 */
function disconnectBeforeConnectUpdateDb(connectionId: string): Database {
    return new Proxy(testEnv.DB, {
        get(target, property, receiver) {
            if (property !== 'prepare') {
                const value = Reflect.get(target, property, receiver);
                return typeof value === 'function' ? value.bind(target) : value;
            }

            return (sql: string) => {
                const statement = target.prepare(sql);
                if (
                    !sql.includes("SET subscription_status = 'connected'") ||
                    !sql.includes("WHERE id = ? AND subscription_status = 'requested'")
                ) {
                    return statement;
                }

                return new Proxy(statement, {
                    get(statementTarget, statementProperty, statementReceiver) {
                        if (statementProperty !== 'run') {
                            const value = Reflect.get(
                                statementTarget,
                                statementProperty,
                                statementReceiver,
                            );
                            return typeof value === 'function'
                                ? value.bind(statementTarget)
                                : value;
                        }

                        return (...args: unknown[]) => {
                            const timestamp = new Date().toISOString();
                            target
                                .prepare(
                                    `UPDATE listener_connections
                  SET subscription_status = 'disconnected',
                      disconnected_at = ?,
                      disconnect_reason = ?,
                      updated_at = ?
                  WHERE id = ?`,
                                )
                                .run(timestamp, 'client_disconnect', timestamp, connectionId);
                            return statementTarget.run(...args);
                        };
                    },
                });
            };
        },
    }) as Database;
}

describe('listener lifecycle', () => {
    beforeEach(async () => {
        testEnv.DB.exec('DELETE FROM stream_events');
        testEnv.DB.exec('DELETE FROM listener_connections');
        testEnv.DB.exec('DELETE FROM admin_sessions');
        testEnv.DB.exec('DELETE FROM translator_stream_assignments');
        testEnv.DB.exec('DELETE FROM translators');
        testEnv.DB.exec('DELETE FROM language_streams');
        testEnv.DB.exec('DELETE FROM programs');
        await seedPlatformAdmin(testEnv);
    });

    it('requests, connects, reports, and disconnects a listener', async () => {
        const { cookie, program, hindi } = await seedProgramAndStreams();

        const requested = await request('/api/listeners/request', {
            method: 'POST',
            headers: {
                'cf-connecting-ip': '203.0.113.9',
                'user-agent': 'Test Mobile Browser',
            },
            body: JSON.stringify({
                programId: program.id,
                streamId: hindi.id,
                clientId: 'client_1',
            }),
        });

        expect(requested.status).toBe(201);
        const connection = (await requested.json()) as { connectionId: string };
        expect(await presenceTotal(program.id)).toBe(0);

        const connected = await request('/api/listeners/connected', {
            method: 'POST',
            body: JSON.stringify({ connectionId: connection.connectionId }),
        });
        expect(connected.status).toBe(200);
        expect(await presenceTotal(program.id)).toBe(1);

        const report = await request(`/api/admin/programs/${program.id}/listener-report`, {
            headers: { Cookie: cookie },
        });
        expect(await report.json()).toMatchObject({
            connections: [
                {
                    id: connection.connectionId,
                    subscriptionStatus: 'connected',
                    listenerIp: '203.0.113.9',
                    userAgent: 'Test Mobile Browser',
                    disconnectReason: null,
                },
            ],
        });

        const leave = await request('/api/listeners/leave', {
            method: 'POST',
            body: JSON.stringify({
                connectionId: connection.connectionId,
                reason: 'client_disconnect',
            }),
        });

        expect(leave.status).toBe(200);
        expect(await presenceTotal(program.id)).toBe(0);

        const updatedReport = await request(`/api/admin/programs/${program.id}/listener-report`, {
            headers: { Cookie: cookie },
        });
        expect(await updatedReport.json()).toMatchObject({
            connections: [
                {
                    id: connection.connectionId,
                    subscriptionStatus: 'disconnected',
                    disconnectReason: 'client_disconnect',
                },
            ],
        });
    });

    it('does not join presence when connect loses a disconnect race', async () => {
        const { program, hindi } = await seedProgramAndStreams();

        const requested = await request('/api/listeners/request', {
            method: 'POST',
            headers: {
                'cf-connecting-ip': '203.0.113.9',
                'user-agent': 'Test Mobile Browser',
            },
            body: JSON.stringify({
                programId: program.id,
                streamId: hindi.id,
                clientId: 'client_1',
            }),
        });
        const connection = (await requested.json()) as { connectionId: string };

        const raceEnv = buildTestEnv({
            DB: disconnectBeforeConnectUpdateDb(connection.connectionId),
        });
        const connected = await request(
            '/api/listeners/connected',
            {
                method: 'POST',
                body: JSON.stringify({ connectionId: connection.connectionId }),
            },
            raceEnv,
        );

        expect(connected.status).toBe(409);
        expect(await connected.json()).toEqual({
            error: 'listener_invalid_state',
        });
        expect(await presenceTotal(program.id)).toBe(0);

        const row = testEnv.DB.prepare(
            `SELECT subscription_status as subscriptionStatus
      FROM listener_connections
      WHERE id = ?`,
        ).get(connection.connectionId) as { subscriptionStatus: string } | undefined;
        expect(row?.subscriptionStatus).toBe('disconnected');
    });

    it('does not notify presence directly -- listener join/leave is webhook-driven only', async () => {
        const { program, hindi } = await seedProgramAndStreams();

        // Slice 3: routes/listeners.ts never calls into presence/status.ts at
        // all any more (PRESENCE_LIVE_COUNT is irrelevant here) -- listener
        // join/leave presence comes exclusively from livekit/webhook.ts's
        // handling of LiveKit's participant_joined/participant_left events. This
        // spies on the module directly to prove a full
        // request -> connected -> leave transition never triggers a presence
        // write from these DB-lifecycle routes.
        const joinSpy = vi.spyOn(presenceStatus, 'presenceJoin');
        const heartbeatSpy = vi.spyOn(presenceStatus, 'presenceHeartbeat');
        const leaveSpy = vi.spyOn(presenceStatus, 'presenceLeave');

        try {
            const requested = await request('/api/listeners/request', {
                method: 'POST',
                headers: {
                    'cf-connecting-ip': '203.0.113.9',
                    'user-agent': 'Test Mobile Browser',
                },
                body: JSON.stringify({
                    programId: program.id,
                    streamId: hindi.id,
                    clientId: 'client_1',
                }),
            });
            const connection = (await requested.json()) as { connectionId: string };

            const connected = await request('/api/listeners/connected', {
                method: 'POST',
                body: JSON.stringify({ connectionId: connection.connectionId }),
            });
            expect(connected.status).toBe(200);

            const leave = await request('/api/listeners/leave', {
                method: 'POST',
                body: JSON.stringify({
                    connectionId: connection.connectionId,
                    reason: 'client_disconnect',
                }),
            });
            expect(leave.status).toBe(200);

            expect(joinSpy).not.toHaveBeenCalled();
            expect(heartbeatSpy).not.toHaveBeenCalled();
            expect(leaveSpy).not.toHaveBeenCalled();

            const row = testEnv.DB.prepare(
                `SELECT subscription_status as subscriptionStatus
        FROM listener_connections
        WHERE id = ?`,
            ).get(connection.connectionId) as { subscriptionStatus: string } | undefined;
            expect(row?.subscriptionStatus).toBe('disconnected');
        } finally {
            joinSpy.mockRestore();
            heartbeatSpy.mockRestore();
            leaveSpy.mockRestore();
        }
    });

    it('refreshes connected listener heartbeat without updating listener telemetry', async () => {
        const { program, hindi } = await seedProgramAndStreams();

        const requested = await request('/api/listeners/request', {
            method: 'POST',
            headers: {
                'cf-connecting-ip': '203.0.113.9',
                'user-agent': 'Initial Mobile Browser',
            },
            body: JSON.stringify({
                programId: program.id,
                streamId: hindi.id,
                clientId: 'client_heartbeat',
            }),
        });
        const connection = (await requested.json()) as { connectionId: string };

        const connected = await request('/api/listeners/connected', {
            method: 'POST',
            body: JSON.stringify({ connectionId: connection.connectionId }),
        });
        expect(connected.status).toBe(200);
        expect(await presenceTotal(program.id)).toBe(1);

        const beforeHeartbeat = await storedConnection(connection.connectionId);
        // better-sqlite3 is fast enough that two sequential writes can land in
        // the same ISO-millisecond timestamp, which would make a bare
        // `not.toEqual(beforeHeartbeat.updatedAt)` assertion flaky. A short delay
        // guarantees the heartbeat's timestamp write lands in a later
        // millisecond, keeping this a reliable "did it actually get touched?"
        // signal.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const heartbeat = await request('/api/listeners/heartbeat', {
            method: 'POST',
            headers: {
                'cf-connecting-ip': '198.51.100.99',
                'user-agent': 'Heartbeat Should Not Persist',
            },
            body: JSON.stringify({ connectionId: connection.connectionId }),
        });

        expect(heartbeat.status).toBe(200);
        expect(await heartbeat.json()).toEqual({ ok: true });
        expect(await presenceTotal(program.id)).toBe(1);

        const afterHeartbeat = await storedConnection(connection.connectionId);
        expect(afterHeartbeat.updatedAt).not.toEqual(beforeHeartbeat.updatedAt);
        expect(afterHeartbeat.lastSeenAt).not.toEqual(beforeHeartbeat.lastSeenAt);
        expect({
            listenerIp: afterHeartbeat.listenerIp,
            userAgent: afterHeartbeat.userAgent,
        }).toEqual({
            listenerIp: beforeHeartbeat.listenerIp,
            userAgent: beforeHeartbeat.userAgent,
        });
    });

    it('refreshes connected listener heartbeat timestamps in the database', async () => {
        const { program, hindi } = await seedProgramAndStreams();

        const requested = await request('/api/listeners/request', {
            method: 'POST',
            headers: {
                'cf-connecting-ip': '203.0.113.9',
                'user-agent': 'Initial Mobile Browser',
            },
            body: JSON.stringify({
                programId: program.id,
                streamId: hindi.id,
                clientId: 'client_heartbeat_restore',
            }),
        });
        const connection = (await requested.json()) as { connectionId: string };

        const connected = await request('/api/listeners/connected', {
            method: 'POST',
            body: JSON.stringify({ connectionId: connection.connectionId }),
        });
        expect(connected.status).toBe(200);
        expect(await presenceTotal(program.id)).toBe(1);

        const heartbeat = await request('/api/listeners/heartbeat', {
            method: 'POST',
            body: JSON.stringify({ connectionId: connection.connectionId }),
        });

        expect(heartbeat.status).toBe(200);
        expect(await heartbeat.json()).toEqual({ ok: true });
        expect(await presenceTotal(program.id)).toBe(1);

        const afterHeartbeat = await storedConnection(connection.connectionId);
        expect(afterHeartbeat.listenerIp).toBe('203.0.113.9');
        expect(afterHeartbeat.userAgent).toBe('Initial Mobile Browser');
    });

    it('captures client hint device details without clearing them on later heartbeats', async () => {
        const { program, hindi } = await seedProgramAndStreams();

        const requested = await request('/api/listeners/request', {
            method: 'POST',
            headers: {
                'cf-connecting-ip': '203.0.113.9',
                'user-agent': 'Initial Mobile Browser',
            },
            body: JSON.stringify({
                programId: program.id,
                streamId: hindi.id,
                clientId: 'client_hints',
            }),
        });
        const connection = (await requested.json()) as { connectionId: string };

        expect(await storedConnection(connection.connectionId)).toMatchObject({
            deviceModel: null,
            platform: null,
            platformVersion: null,
            browserFullVersion: null,
        });

        const connected = await request('/api/listeners/connected', {
            method: 'POST',
            headers: {
                'sec-ch-ua-model': '"Pixel 8 Pro"',
                'sec-ch-ua-platform': '"Android"',
                'sec-ch-ua-platform-version': '"15.0.0"',
                'sec-ch-ua-full-version-list':
                    '"Chromium";v="125.0.6422.141", "Google Chrome";v="125.0.6422.141"',
            },
            body: JSON.stringify({ connectionId: connection.connectionId }),
        });
        expect(connected.status).toBe(200);

        expect(await storedConnection(connection.connectionId)).toMatchObject({
            deviceModel: 'Pixel 8 Pro',
            platform: 'Android',
            platformVersion: '15.0.0',
            browserFullVersion: '"Chromium";v="125.0.6422.141", "Google Chrome";v="125.0.6422.141"',
        });

        const heartbeat = await request('/api/listeners/heartbeat', {
            method: 'POST',
            headers: {
                'sec-ch-ua-model': '',
                'sec-ch-ua-platform': '""',
                'sec-ch-ua-platform-version': '  ',
            },
            body: JSON.stringify({ connectionId: connection.connectionId }),
        });
        expect(heartbeat.status).toBe(200);

        expect(await storedConnection(connection.connectionId)).toMatchObject({
            deviceModel: 'Pixel 8 Pro',
            platform: 'Android',
            platformVersion: '15.0.0',
            browserFullVersion: '"Chromium";v="125.0.6422.141", "Google Chrome";v="125.0.6422.141"',
        });
    });

    it('rejects heartbeat for unknown and non-connected listeners without incrementing presence', async () => {
        const { program, hindi } = await seedProgramAndStreams();

        const unknown = await request('/api/listeners/heartbeat', {
            method: 'POST',
            body: JSON.stringify({ connectionId: 'listener_connection_missing' }),
        });
        expect(unknown.status).toBe(409);
        expect(await unknown.json()).toEqual({
            error: 'listener_invalid_state',
        });
        expect(await presenceTotal(program.id)).toBe(0);

        const requested = await request('/api/listeners/request', {
            method: 'POST',
            body: JSON.stringify({
                programId: program.id,
                streamId: hindi.id,
                clientId: 'client_requested',
            }),
        });
        const requestedConnection = (await requested.json()) as {
            connectionId: string;
        };

        const requestedHeartbeat = await request('/api/listeners/heartbeat', {
            method: 'POST',
            body: JSON.stringify({ connectionId: requestedConnection.connectionId }),
        });
        expect(requestedHeartbeat.status).toBe(409);
        expect(await requestedHeartbeat.json()).toEqual({
            error: 'listener_invalid_state',
        });
        expect(await presenceTotal(program.id)).toBe(0);

        const timestamp = new Date().toISOString();
        testEnv.DB.prepare(
            `UPDATE listener_connections
      SET subscription_status = 'disconnected',
          disconnected_at = ?,
          disconnect_reason = ?,
          updated_at = ?
      WHERE id = ?`,
        ).run(timestamp, 'client_disconnect', timestamp, requestedConnection.connectionId);

        const disconnectedHeartbeat = await request('/api/listeners/heartbeat', {
            method: 'POST',
            body: JSON.stringify({ connectionId: requestedConnection.connectionId }),
        });
        expect(disconnectedHeartbeat.status).toBe(409);
        expect(await disconnectedHeartbeat.json()).toEqual({
            error: 'listener_invalid_state',
        });
        expect(await presenceTotal(program.id)).toBe(0);

        const failed = await request('/api/listeners/request', {
            method: 'POST',
            body: JSON.stringify({
                programId: program.id,
                streamId: hindi.id,
                clientId: 'client_failed',
            }),
        });
        const failedConnection = (await failed.json()) as { connectionId: string };
        const failedAt = new Date().toISOString();
        testEnv.DB.prepare(
            `UPDATE listener_connections
      SET subscription_status = 'failed',
          disconnected_at = ?,
          disconnect_reason = ?,
          updated_at = ?
      WHERE id = ?`,
        ).run(failedAt, 'realtime_error', failedAt, failedConnection.connectionId);

        const failedHeartbeat = await request('/api/listeners/heartbeat', {
            method: 'POST',
            body: JSON.stringify({ connectionId: failedConnection.connectionId }),
        });
        expect(failedHeartbeat.status).toBe(409);
        expect(await failedHeartbeat.json()).toEqual({
            error: 'listener_invalid_state',
        });
        expect(await presenceTotal(program.id)).toBe(0);
    });

    it('switches language by closing the old connection exactly once', async () => {
        const { cookie, program, hindi, english } = await seedProgramAndStreams();

        const requested = await request('/api/listeners/request', {
            method: 'POST',
            headers: {
                'cf-connecting-ip': '203.0.113.9',
                'user-agent': 'Test Mobile Browser',
            },
            body: JSON.stringify({
                programId: program.id,
                streamId: hindi.id,
                clientId: 'client_1',
            }),
        });
        const first = (await requested.json()) as { connectionId: string };
        await request('/api/listeners/connected', {
            method: 'POST',
            body: JSON.stringify({ connectionId: first.connectionId }),
        });
        expect(await presenceTotal(program.id)).toBe(1);

        const switchPayload = {
            fromConnectionId: first.connectionId,
            programId: program.id,
            streamId: english.id,
            clientId: 'client_1',
        };
        const switched = await request('/api/listeners/switch', {
            method: 'POST',
            headers: {
                'cf-connecting-ip': '203.0.113.9',
                'user-agent': 'Test Mobile Browser',
            },
            body: JSON.stringify(switchPayload),
        });

        expect(switched.status).toBe(201);
        const replacement = (await switched.json()) as { connectionId: string };
        expect(await presenceTotal(program.id)).toBe(0);

        const retriedSwitch = await request('/api/listeners/switch', {
            method: 'POST',
            headers: {
                'cf-connecting-ip': '203.0.113.9',
                'user-agent': 'Test Mobile Browser',
            },
            body: JSON.stringify(switchPayload),
        });
        expect(retriedSwitch.status).toBe(201);
        expect(await retriedSwitch.json()).toEqual({
            connectionId: replacement.connectionId,
        });

        await request('/api/listeners/leave', {
            method: 'POST',
            body: JSON.stringify({
                connectionId: first.connectionId,
                reason: 'client_disconnect',
            }),
        });

        const report = await request(`/api/admin/programs/${program.id}/listener-report`, {
            headers: { Cookie: cookie },
        });
        const body = (await report.json()) as {
            connections: Array<{
                id: string;
                disconnectReason: string | null;
            }>;
        };
        const oldRows = body.connections.filter((row) => row.id === first.connectionId);
        expect(oldRows).toHaveLength(1);
        expect(oldRows[0]?.disconnectReason).toBe('language_switch');

        const results = testEnv.DB.prepare(
            `SELECT event_type as eventType FROM stream_events
      WHERE program_id = ? AND language_stream_id = ?`,
        ).all(program.id, hindi.id) as Array<{ eventType: string }>;
        expect(results.filter((event) => event.eventType === 'listener_switched')).toHaveLength(1);

        const successorCount = testEnv.DB.prepare(
            `SELECT COUNT(*) as count FROM listener_connections
      WHERE switch_from_connection_id = ?`,
        ).get(first.connectionId) as { count: number } | undefined;
        expect(successorCount?.count).toBe(1);

        const now = new Date().toISOString();
        expect(() =>
            testEnv.DB.prepare(
                `INSERT INTO listener_connections
        (id, program_id, language_stream_id, client_id, token_issued_at,
         subscription_status, listener_ip, user_agent, switch_from_connection_id,
         created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
                `listener_connection_${crypto.randomUUID()}`,
                program.id,
                english.id,
                'client_1',
                now,
                'requested',
                '203.0.113.9',
                'Test Mobile Browser',
                first.connectionId,
                now,
                now,
            ),
        ).toThrow(/UNIQUE|constraint/i);
    });

    it('recovers a retried switch after the old connection was disconnected without a successor', async () => {
        const { program, hindi, english } = await seedProgramAndStreams();

        const requested = await request('/api/listeners/request', {
            method: 'POST',
            headers: {
                'cf-connecting-ip': '203.0.113.9',
                'user-agent': 'Test Mobile Browser',
            },
            body: JSON.stringify({
                programId: program.id,
                streamId: hindi.id,
                clientId: 'client_1',
            }),
        });
        const first = (await requested.json()) as { connectionId: string };
        await request('/api/listeners/connected', {
            method: 'POST',
            body: JSON.stringify({ connectionId: first.connectionId }),
        });
        expect(await presenceTotal(program.id)).toBe(1);

        const timestamp = new Date().toISOString();
        testEnv.DB.prepare(
            `UPDATE listener_connections
      SET subscription_status = 'disconnected',
          disconnected_at = ?,
          disconnect_reason = ?,
          updated_at = ?
      WHERE id = ?`,
        ).run(timestamp, 'language_switch', timestamp, first.connectionId);

        const retriedSwitch = await request('/api/listeners/switch', {
            method: 'POST',
            headers: {
                'cf-connecting-ip': '203.0.113.9',
                'user-agent': 'Test Mobile Browser',
            },
            body: JSON.stringify({
                fromConnectionId: first.connectionId,
                programId: program.id,
                streamId: english.id,
                clientId: 'client_1',
            }),
        });

        expect(retriedSwitch.status).toBe(201);
        expect(await presenceTotal(program.id)).toBe(0);

        const successorCount = testEnv.DB.prepare(
            `SELECT COUNT(*) as count FROM listener_connections
      WHERE switch_from_connection_id = ?`,
        ).get(first.connectionId) as { count: number } | undefined;
        expect(successorCount?.count).toBe(1);
    });

    it('keeps a retried switch invalid when the old disconnect reason is unrelated', async () => {
        const { program, hindi, english } = await seedProgramAndStreams();

        const requested = await request('/api/listeners/request', {
            method: 'POST',
            headers: {
                'cf-connecting-ip': '203.0.113.9',
                'user-agent': 'Test Mobile Browser',
            },
            body: JSON.stringify({
                programId: program.id,
                streamId: hindi.id,
                clientId: 'client_1',
            }),
        });
        const first = (await requested.json()) as { connectionId: string };
        await request('/api/listeners/connected', {
            method: 'POST',
            body: JSON.stringify({ connectionId: first.connectionId }),
        });

        const timestamp = new Date().toISOString();
        testEnv.DB.prepare(
            `UPDATE listener_connections
      SET subscription_status = 'disconnected',
          disconnected_at = ?,
          disconnect_reason = ?,
          updated_at = ?
      WHERE id = ?`,
        ).run(timestamp, 'client_disconnect', timestamp, first.connectionId);

        const retriedSwitch = await request('/api/listeners/switch', {
            method: 'POST',
            headers: {
                'cf-connecting-ip': '203.0.113.9',
                'user-agent': 'Test Mobile Browser',
            },
            body: JSON.stringify({
                fromConnectionId: first.connectionId,
                programId: program.id,
                streamId: english.id,
                clientId: 'client_1',
            }),
        });

        expect(retriedSwitch.status).toBe(409);
        expect(await retriedSwitch.json()).toEqual({
            error: 'listener_invalid_state',
        });
        expect(await presenceTotal(program.id)).toBe(0);

        const successorCount = testEnv.DB.prepare(
            `SELECT COUNT(*) as count FROM listener_connections
      WHERE switch_from_connection_id = ?`,
        ).get(first.connectionId) as { count: number } | undefined;
        expect(successorCount?.count).toBe(0);
    });

    it('does not persist client-controlled forwarding headers as listener IP', async () => {
        const { cookie, program, hindi } = await seedProgramAndStreams();

        const requested = await request('/api/listeners/request', {
            method: 'POST',
            headers: {
                'x-forwarded-for': '198.51.100.10',
                'user-agent': 'Test Mobile Browser',
            },
            body: JSON.stringify({
                programId: program.id,
                streamId: hindi.id,
                clientId: 'client_1',
            }),
        });

        expect(requested.status).toBe(201);
        const connection = (await requested.json()) as { connectionId: string };
        expect(await presenceTotal(program.id)).toBe(0);

        const report = await request(`/api/admin/programs/${program.id}/listener-report`, {
            headers: { Cookie: cookie },
        });

        expect(await report.json()).toMatchObject({
            connections: [
                {
                    id: connection.connectionId,
                    subscriptionStatus: 'requested',
                    listenerIp: '0.0.0.0',
                },
            ],
        });
    });

    it('reconnects by closing the old connection and requesting a replacement', async () => {
        const { cookie, program, hindi } = await seedProgramAndStreams();

        const requested = await request('/api/listeners/request', {
            method: 'POST',
            headers: {
                'cf-connecting-ip': '203.0.113.9',
                'user-agent': 'Test Mobile Browser',
            },
            body: JSON.stringify({
                programId: program.id,
                streamId: hindi.id,
                clientId: 'client_1',
            }),
        });
        const first = (await requested.json()) as { connectionId: string };

        await request('/api/listeners/connected', {
            method: 'POST',
            body: JSON.stringify({ connectionId: first.connectionId }),
        });
        expect(await presenceTotal(program.id)).toBe(1);

        const reconnectPayload = {
            reconnectOfConnectionId: first.connectionId,
            programId: program.id,
            streamId: hindi.id,
            clientId: 'client_1',
        };
        const reconnected = await request('/api/listeners/reconnect', {
            method: 'POST',
            headers: {
                'cf-connecting-ip': '203.0.113.10',
                'user-agent': 'Reconnect Browser',
            },
            body: JSON.stringify(reconnectPayload),
        });

        expect(reconnected.status).toBe(201);
        const next = (await reconnected.json()) as { connectionId: string };
        expect(await presenceTotal(program.id)).toBe(0);

        const retriedReconnect = await request('/api/listeners/reconnect', {
            method: 'POST',
            headers: {
                'cf-connecting-ip': '203.0.113.10',
                'user-agent': 'Reconnect Browser',
            },
            body: JSON.stringify(reconnectPayload),
        });
        expect(retriedReconnect.status).toBe(201);
        expect(await retriedReconnect.json()).toEqual({
            connectionId: next.connectionId,
        });

        const linked = testEnv.DB.prepare(
            `SELECT reconnect_of_connection_id as reconnectOfConnectionId
      FROM listener_connections
      WHERE id = ?`,
        ).get(next.connectionId) as { reconnectOfConnectionId: string | null } | undefined;
        expect(linked?.reconnectOfConnectionId).toBe(first.connectionId);

        const report = await request(`/api/admin/programs/${program.id}/listener-report`, {
            headers: { Cookie: cookie },
        });
        const reportBody = (await report.json()) as {
            total: number;
            connections: Array<{
                id: string;
                subscriptionStatus: string;
                disconnectReason: string | null;
                listenerIp: string;
                userAgent: string;
            }>;
        };
        expect(reportBody.total).toBe(2);
        expect(reportBody.connections).toHaveLength(2);
        expect(reportBody.connections.find((row) => row.id === first.connectionId)).toMatchObject({
            subscriptionStatus: 'disconnected',
            disconnectReason: 'reconnected',
        });
        expect(reportBody.connections.find((row) => row.id === next.connectionId)).toMatchObject({
            subscriptionStatus: 'requested',
            listenerIp: '203.0.113.10',
            userAgent: 'Reconnect Browser',
        });

        const successorCount = testEnv.DB.prepare(
            `SELECT COUNT(*) as count FROM listener_connections
      WHERE reconnect_of_connection_id = ?`,
        ).get(first.connectionId) as { count: number } | undefined;
        expect(successorCount?.count).toBe(1);
    });

    it('recovers a retried reconnect after the old connection was disconnected without a successor', async () => {
        const { program, hindi } = await seedProgramAndStreams();

        const requested = await request('/api/listeners/request', {
            method: 'POST',
            headers: {
                'cf-connecting-ip': '203.0.113.9',
                'user-agent': 'Test Mobile Browser',
            },
            body: JSON.stringify({
                programId: program.id,
                streamId: hindi.id,
                clientId: 'client_1',
            }),
        });
        const first = (await requested.json()) as { connectionId: string };
        await request('/api/listeners/connected', {
            method: 'POST',
            body: JSON.stringify({ connectionId: first.connectionId }),
        });
        expect(await presenceTotal(program.id)).toBe(1);

        const timestamp = new Date().toISOString();
        testEnv.DB.prepare(
            `UPDATE listener_connections
      SET subscription_status = 'disconnected',
          disconnected_at = ?,
          disconnect_reason = ?,
          updated_at = ?
      WHERE id = ?`,
        ).run(timestamp, 'reconnected', timestamp, first.connectionId);

        const retriedReconnect = await request('/api/listeners/reconnect', {
            method: 'POST',
            headers: {
                'cf-connecting-ip': '203.0.113.10',
                'user-agent': 'Reconnect Browser',
            },
            body: JSON.stringify({
                reconnectOfConnectionId: first.connectionId,
                programId: program.id,
                streamId: hindi.id,
                clientId: 'client_1',
            }),
        });

        expect(retriedReconnect.status).toBe(201);
        expect(await presenceTotal(program.id)).toBe(0);

        const successorCount = testEnv.DB.prepare(
            `SELECT COUNT(*) as count FROM listener_connections
      WHERE reconnect_of_connection_id = ?`,
        ).get(first.connectionId) as { count: number } | undefined;
        expect(successorCount?.count).toBe(1);
    });
});
