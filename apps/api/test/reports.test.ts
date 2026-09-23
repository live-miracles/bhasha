import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../src/env';
import { createApp } from '../src/index';
import {
    escapeCsvField,
    isRetentionEligible,
    listenerConnectionsToCsv,
    sanitizeEventMetadata,
} from '../src/domain/reports';
import { deviceLabelFromUserAgent } from '../src/domain/deviceLabel';
import { parseListenerReportQuery } from '../src/routes/admin';
import { adminCookie, buildTestEnv, seedPlatformAdmin, testEnv } from './test-env';
import { ListenerRepository } from '../src/db/listenerRepository';

async function request(
    path: string,
    init: RequestInit = {},
    workerEnv: Env = buildTestEnv(),
): Promise<Response> {
    const app = createApp(workerEnv);
    return app.fetch(new Request(`https://bhasha.test${path}`, init));
}

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
    await seedPlatformAdmin(testEnv);
}

interface SeededReportProgram {
    programId: string;
    slug: string;
    hindiStreamId: string;
    tamilStreamId: string;
}

async function insertProgram(input: {
    programId: string;
    slug: string;
    status?: 'draft' | 'live' | 'archived';
    now?: string;
    archivedAt?: string | null;
    aggregateSummaryJson?: string | null;
}): Promise<void> {
    const now = input.now ?? new Date().toISOString();
    await testEnv.DB.prepare(
        `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at,
     updated_at, archived_at, aggregate_summary_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
        .bind(
            input.programId,
            input.slug,
            'Report Program',
            'Main Hall',
            '2026-08-01',
            input.status ?? 'live',
            '',
            now,
            now,
            input.archivedAt ?? null,
            input.aggregateSummaryJson ?? null,
        )
        .run();
}

async function insertStream(input: {
    streamId: string;
    programId: string;
    languageName: string;
    languageCode: string;
    displayOrder: number;
    isActive: number;
}): Promise<void> {
    const now = new Date().toISOString();
    await testEnv.DB.prepare(
        `INSERT INTO language_streams
    (id, program_id, language_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
    )
        .bind(
            input.streamId,
            input.programId,
            input.languageName,
            input.languageCode,
            input.displayOrder,
            input.isActive,
            now,
            now,
        )
        .run();
}

async function insertConnection(input: {
    id: string;
    programId: string;
    streamId: string;
    clientId: string;
    status: string;
    connectedAt?: string | null;
    disconnectedAt?: string | null;
    disconnectReason?: string | null;
    listenerIp?: string;
    userAgent?: string;
    lastSeenAt?: string | null;
    createdAt: string;
}): Promise<void> {
    await testEnv.DB.prepare(
        `INSERT INTO listener_connections
    (id, program_id, language_stream_id, client_id, token_issued_at,
     subscription_status, connected_at, last_seen_at, disconnected_at, disconnect_reason,
     listener_ip, user_agent, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
        .bind(
            input.id,
            input.programId,
            input.streamId,
            input.clientId,
            input.createdAt,
            input.status,
            input.connectedAt ?? null,
            input.lastSeenAt ?? null,
            input.disconnectedAt ?? null,
            input.disconnectReason ?? null,
            input.listenerIp ?? '203.0.113.10',
            input.userAgent ?? 'Test UA',
            input.createdAt,
            input.createdAt,
        )
        .run();
}

async function insertEvent(input: {
    id: string;
    programId: string;
    streamId: string | null;
    eventType: string;
    occurredAt: string;
    metadata?: Record<string, unknown>;
    translatorName?: string | null;
    translatorUserAgent?: string | null;
}): Promise<void> {
    await testEnv.DB.prepare(
        `INSERT INTO stream_events
    (id, program_id, stream_program_id, language_stream_id, event_type,
     occurred_at, metadata_json, translator_name, translator_user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
        .bind(
            input.id,
            input.programId,
            input.streamId ? input.programId : null,
            input.streamId,
            input.eventType,
            input.occurredAt,
            JSON.stringify(input.metadata ?? {}),
            input.translatorName ?? null,
            input.translatorUserAgent ?? null,
        )
        .run();
}

async function seedReportProgram(
    status: 'draft' | 'live' | 'archived' = 'live',
): Promise<SeededReportProgram> {
    const suffix = crypto.randomUUID();
    const programId = `program_report_${suffix}`;
    const slug = `patna-report-${suffix}`;
    const hindiStreamId = `stream_hindi_${suffix}`;
    const tamilStreamId = `stream_tamil_${suffix}`;

    await insertProgram({ programId, slug, status });
    await insertStream({
        streamId: hindiStreamId,
        programId,
        languageName: 'Hindi',
        languageCode: 'hi',
        displayOrder: 1,
        isActive: 1,
    });
    await insertStream({
        streamId: tamilStreamId,
        programId,
        languageName: 'Tamil',
        languageCode: 'ta',
        displayOrder: 2,
        isActive: 0,
    });

    return { programId, slug, hindiStreamId, tamilStreamId };
}

describe('report domain helpers', () => {
    it('escapes CSV fields with commas quotes and newlines', () => {
        expect(escapeCsvField(null)).toBe('');
        expect(escapeCsvField('plain')).toBe('plain');
        expect(escapeCsvField('a,b')).toBe('"a,b"');
        expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
        expect(escapeCsvField('line1\r\nline2')).toBe('"line1\r\nline2"');
        expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    });

    it('neutralizes spreadsheet formula-like CSV fields', () => {
        expect(escapeCsvField('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
        expect(escapeCsvField('+1')).toBe("'+1");
        expect(escapeCsvField('-1')).toBe("'-1");
        expect(escapeCsvField('@cmd')).toBe("'@cmd");
        expect(escapeCsvField('\tTabbed')).toBe("'\tTabbed");
        // Formula char plus a comma must be both neutralized and quoted.
        expect(escapeCsvField('=1,2')).toBe('"\'=1,2"');
    });

    it('sanitizes event metadata to the allowed keys only', () => {
        const sanitized = sanitizeEventMetadata({
            reason: 'client_disconnect',
            translatorId: 'translator_1',
            connectionId: 'listener_connection_1',
            listenerIp: '203.0.113.10',
            userAgent: 'Mobile Safari',
            clientId: 'client_1',
            cloudflareSessionId: 'cf-session',
            trackName: 'track-hi',
            trackMid: '0',
            surprise: { nested: true },
        });

        expect(sanitized).toEqual({
            reason: 'client_disconnect',
            translatorId: 'translator_1',
            connectionId: 'listener_connection_1',
        });
        expect(sanitizeEventMetadata(null)).toEqual({});
        expect(sanitizeEventMetadata({ reason: 5 as unknown as string })).toEqual({});
    });

    it('converts listener connections into RFC4180 CSV with a stable header', () => {
        const csv = listenerConnectionsToCsv([
            {
                id: 'listener_connection_1',
                clientId: 'client_1',
                streamId: 'stream_hi',
                connectedAt: '2026-06-20T12:00:00.000Z',
                disconnectedAt: null,
                disconnectReason: null,
                listenerIp: '203.0.113.10',
                userAgent: 'Mozilla, Safari',
                deviceModel: null,
                deviceModelName: null,
                platform: null,
                platformVersion: null,
                browserFullVersion: null,
                approvalStatus: 'approved',
                approvedAt: '2026-06-20T12:01:00.000Z',
                approvedVia: 'scan',
            },
        ]);

        const lines = csv.split('\r\n');
        expect(lines[0]).toBe(
            'connectionId,clientId,streamId,connectedAt,disconnectedAt,disconnectReason,listenerIp,userAgent,deviceModel,deviceModelName,platform,platformVersion,browserFullVersion,approvalStatus,approvedAt,approvedVia',
        );
        expect(lines[1]).toBe(
            'listener_connection_1,client_1,stream_hi,2026-06-20T12:00:00.000Z,,,203.0.113.10,"Mozilla, Safari",,,,,,approved,2026-06-20T12:01:00.000Z,scan',
        );
    });

    it('surfaces last seen time and device label when listing program connections', async () => {
        await resetDb();
        const { programId, hindiStreamId } = await seedReportProgram();
        const lastSeenAt = '2026-06-21T10:05:00.000Z';
        const userAgent =
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

        await insertConnection({
            id: 'lc_report_slice_1',
            programId,
            streamId: hindiStreamId,
            clientId: 'client_1',
            status: 'connected',
            connectedAt: '2026-06-21T10:00:00.000Z',
            lastSeenAt,
            listenerIp: '203.0.113.22',
            userAgent,
            createdAt: '2026-06-21T10:00:00.000Z',
        });

        const repo = new ListenerRepository(testEnv.DB);
        const connections = await repo.listProgramConnections(programId);
        const row = connections.find((connection) => connection.id === 'lc_report_slice_1');

        expect(row).toBeDefined();
        expect(connections).toHaveLength(1);
        expect(row).toMatchObject({
            id: 'lc_report_slice_1',
            lastSeenAt,
            deviceLabel: deviceLabelFromUserAgent(userAgent),
        });
    });

    it('classifies retention eligibility from archivedAt and processedAt', () => {
        const now = new Date('2026-06-21T00:00:00.000Z');
        const oldArchive = '2026-05-01T00:00:00.000Z';
        const recentArchive = '2026-06-15T00:00:00.000Z';

        expect(
            isRetentionEligible({
                status: 'archived',
                archivedAt: oldArchive,
                retentionProcessedAt: null,
                now,
            }),
        ).toBe(true);

        expect(
            isRetentionEligible({
                status: 'archived',
                archivedAt: recentArchive,
                retentionProcessedAt: null,
                now,
            }),
        ).toBe(false);

        expect(
            isRetentionEligible({
                status: 'archived',
                archivedAt: oldArchive,
                retentionProcessedAt: '2026-06-20T00:00:00.000Z',
                now,
            }),
        ).toBe(false);

        expect(
            isRetentionEligible({
                status: 'live',
                archivedAt: null,
                retentionProcessedAt: null,
                now,
            }),
        ).toBe(false);

        expect(
            isRetentionEligible({
                status: 'draft',
                archivedAt: null,
                retentionProcessedAt: null,
                now,
            }),
        ).toBe(false);
    });
});

describe('admin report summary and event feed routes', () => {
    beforeEach(async () => {
        await resetDb();
    });

    it('requires admin authentication for the summary route', async () => {
        const response = await request('/api/admin/programs/program_missing/report/summary');
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'admin_auth_required' });
    });

    it('does not expose report summaries on public-looking paths', async () => {
        const { slug } = await seedReportProgram();
        const response = await request(`/api/public/programs/${slug}/report/summary`);
        expect(response.status).toBe(404);
    });

    it('returns totals and per-stream counts sourcing active listeners from presence', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId, tamilStreamId } = await seedReportProgram();

        const base = Date.parse('2026-06-20T10:00:00.000Z');
        const at = (offset: number) => new Date(base + offset).toISOString();

        await insertConnection({
            id: 'lc_hi_1',
            programId,
            streamId: hindiStreamId,
            clientId: 'client_hi_1',
            status: 'connected',
            connectedAt: at(0),
            lastSeenAt: new Date().toISOString(),
            createdAt: at(0),
        });
        await insertConnection({
            id: 'lc_hi_2',
            programId,
            streamId: hindiStreamId,
            clientId: 'client_hi_2',
            status: 'disconnected',
            connectedAt: at(1000),
            disconnectedAt: at(2000),
            disconnectReason: 'client_disconnect',
            createdAt: at(1000),
        });
        // Stale connected row: connected with no disconnected_at, but never in
        // the Durable Object presence snapshot. Must NOT inflate activeListeners.
        await insertConnection({
            id: 'lc_hi_stale',
            programId,
            streamId: hindiStreamId,
            clientId: 'client_hi_stale',
            status: 'connected',
            connectedAt: at(3000),
            createdAt: at(3000),
        });
        await insertConnection({
            id: 'lc_ta_1',
            programId,
            streamId: tamilStreamId,
            clientId: 'client_ta_1',
            status: 'connected',
            connectedAt: at(4000),
            createdAt: at(4000),
        });

        await insertConnection({
            id: 'lc_hi_live_extra',
            programId,
            streamId: hindiStreamId,
            clientId: 'client_hi_live_extra',
            status: 'connected',
            connectedAt: at(2500),
            lastSeenAt: new Date().toISOString(),
            createdAt: at(2500),
        });

        await insertEvent({
            id: 'ev_hi_reconnect',
            programId,
            streamId: hindiStreamId,
            eventType: 'listener_reconnected',
            occurredAt: at(5000),
            metadata: { reason: 'reconnected', connectionId: 'lc_hi_1' },
        });
        await insertEvent({
            id: 'ev_hi_failed',
            programId,
            streamId: hindiStreamId,
            eventType: 'connection_failed',
            occurredAt: at(6000),
            metadata: { reason: 'ice_failed', connectionId: 'lc_hi_1' },
        });
        await insertEvent({
            id: 'ev_hi_left_graceful',
            programId,
            streamId: hindiStreamId,
            eventType: 'listener_left',
            occurredAt: at(7000),
            metadata: { reason: 'client_disconnect', connectionId: 'lc_hi_2' },
        });
        await insertEvent({
            id: 'ev_hi_left_dropout',
            programId,
            streamId: hindiStreamId,
            eventType: 'listener_left',
            occurredAt: at(8000),
            metadata: { reason: 'network_loss', connectionId: 'lc_hi_stale' },
        });

        // Live D1 state: two listeners on Hindi within the 240s heartbeat window.
        // The stale D1 row is absent by design.

        const response = await request(`/api/admin/programs/${programId}/report/summary`, {
            headers: { Cookie: cookie },
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            programId: string;
            totals: {
                activeListeners: number;
                totalConnections: number;
                uniqueDevices: number;
                dropouts: number;
                reconnects: number;
            };
            streams: Array<{
                streamId: string;
                languageName: string;
                activeListeners: number;
                totalConnections: number;
                dropouts: number;
                reconnects: number;
            }>;
            generatedAt: string;
            presenceSource: string;
        };

        expect(body.programId).toBe(programId);
        expect(body.presenceSource).toBe('durable_object');
        expect(typeof body.generatedAt).toBe('string');
        expect(body.totals).toEqual({
            activeListeners: 2,
            totalConnections: 5,
            uniqueDevices: 5,
            dropouts: 2,
            reconnects: 1,
        });

        const hindi = body.streams.find((s) => s.streamId === hindiStreamId);
        const tamil = body.streams.find((s) => s.streamId === tamilStreamId);
        expect(hindi).toEqual({
            streamId: hindiStreamId,
            languageName: 'Hindi',
            languageCode: 'hi',
            activeListeners: 2,
            totalConnections: 4,
            dropouts: 2,
            reconnects: 1,
        });
        expect(tamil).toEqual({
            streamId: tamilStreamId,
            languageName: 'Tamil',
            languageCode: 'ta',
            activeListeners: 0,
            totalConnections: 1,
            dropouts: 0,
            reconnects: 0,
        });
    });

    it('summary endpoint honours ?from=&to=', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId, tamilStreamId } = await seedReportProgram();
        const from = '2026-06-24T10:00:00.000Z';
        const to = '2026-06-25T10:00:00.000Z';

        await insertConnection({
            id: 'lc_before_window',
            programId,
            streamId: hindiStreamId,
            clientId: 'client_before_window',
            status: 'connected',
            connectedAt: '2026-06-24T09:59:59.000Z',
            lastSeenAt: new Date().toISOString(),
            createdAt: '2026-06-24T09:59:59.000Z',
        });
        await insertConnection({
            id: 'lc_in_window_hi',
            programId,
            streamId: hindiStreamId,
            clientId: 'client_in_window_hi',
            status: 'connected',
            connectedAt: from,
            lastSeenAt: new Date().toISOString(),
            createdAt: from,
        });
        await insertConnection({
            id: 'lc_in_window_ta',
            programId,
            streamId: tamilStreamId,
            clientId: 'client_in_window_ta',
            status: 'connected',
            connectedAt: '2026-06-25T09:59:59.000Z',
            createdAt: '2026-06-25T09:59:59.000Z',
        });
        await insertConnection({
            id: 'lc_at_exclusive_to',
            programId,
            streamId: tamilStreamId,
            clientId: 'client_at_exclusive_to',
            status: 'connected',
            connectedAt: to,
            createdAt: to,
        });

        await insertEvent({
            id: 'ev_before_reconnect',
            programId,
            streamId: hindiStreamId,
            eventType: 'listener_reconnected',
            occurredAt: '2026-06-24T09:59:59.000Z',
        });
        await insertEvent({
            id: 'ev_in_reconnect',
            programId,
            streamId: hindiStreamId,
            eventType: 'listener_reconnected',
            occurredAt: from,
        });
        await insertEvent({
            id: 'ev_in_dropout',
            programId,
            streamId: tamilStreamId,
            eventType: 'listener_left',
            occurredAt: '2026-06-25T09:59:59.000Z',
            metadata: { reason: 'network_loss' },
        });
        await insertEvent({
            id: 'ev_at_exclusive_to',
            programId,
            streamId: tamilStreamId,
            eventType: 'connection_failed',
            occurredAt: to,
        });

        const noRangeResponse = await request(`/api/admin/programs/${programId}/report/summary`, {
            headers: { Cookie: cookie },
        });
        const noRange = (await noRangeResponse.json()) as {
            totals: {
                activeListeners: number;
                totalConnections: number;
                uniqueDevices: number;
                dropouts: number;
                reconnects: number;
            };
        };

        const response = await request(
            `/api/admin/programs/${programId}/report/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
            { headers: { Cookie: cookie } },
        );

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            totals: {
                activeListeners: number;
                totalConnections: number;
                uniqueDevices: number;
                dropouts: number;
                reconnects: number;
            };
            streams: Array<{
                streamId: string;
                totalConnections: number;
                dropouts: number;
                reconnects: number;
            }>;
        };

        expect(noRange.totals).toEqual({
            activeListeners: 2,
            totalConnections: 4,
            uniqueDevices: 4,
            dropouts: 2,
            reconnects: 2,
        });
        expect(body.totals).toEqual({
            activeListeners: noRange.totals.activeListeners,
            totalConnections: 2,
            uniqueDevices: 2,
            dropouts: 1,
            reconnects: 1,
        });
        expect(
            body.streams.map((stream) => ({
                streamId: stream.streamId,
                totalConnections: stream.totalConnections,
                dropouts: stream.dropouts,
                reconnects: stream.reconnects,
            })),
        ).toEqual([
            {
                streamId: hindiStreamId,
                totalConnections: 1,
                dropouts: 0,
                reconnects: 1,
            },
            {
                streamId: tamilStreamId,
                totalConnections: 1,
                dropouts: 1,
                reconnects: 0,
            },
        ]);
    });

    it('summary totals include uniqueDevices', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId } = await seedReportProgram();

        await insertConnection({
            id: 'lc_device_a_1',
            programId,
            streamId: hindiStreamId,
            clientId: 'device_a',
            status: 'connected',
            connectedAt: '2026-06-24T10:00:00.000Z',
            createdAt: '2026-06-24T10:00:00.000Z',
        });
        await insertConnection({
            id: 'lc_device_a_2',
            programId,
            streamId: hindiStreamId,
            clientId: 'device_a',
            status: 'connected',
            connectedAt: '2026-06-24T10:01:00.000Z',
            createdAt: '2026-06-24T10:01:00.000Z',
        });
        await insertConnection({
            id: 'lc_device_b',
            programId,
            streamId: hindiStreamId,
            clientId: 'device_b',
            status: 'connected',
            connectedAt: '2026-06-24T10:02:00.000Z',
            createdAt: '2026-06-24T10:02:00.000Z',
        });

        const response = await request(`/api/admin/programs/${programId}/report/summary`, {
            headers: { Cookie: cookie },
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            totals: { totalConnections: number; uniqueDevices: number };
        };

        expect(body.totals.totalConnections).toBe(3);
        expect(body.totals.uniqueDevices).toBe(2);
    });

    it('returns recent events newest first with allowlisted metadata only', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId } = await seedReportProgram();

        const base = Date.parse('2026-06-20T10:00:00.000Z');
        const at = (offset: number) => new Date(base + offset).toISOString();

        await insertEvent({
            id: 'ev_oldest',
            programId,
            streamId: hindiStreamId,
            eventType: 'translator_disconnected',
            occurredAt: at(0),
            metadata: { connectionId: 'lc_1', clientId: 'client_1' },
        });
        await insertEvent({
            id: 'ev_middle',
            programId,
            streamId: hindiStreamId,
            eventType: 'listener_reconnected',
            occurredAt: at(1000),
            metadata: { connectionId: 'lc_1', reason: 'reconnected' },
        });
        await insertEvent({
            id: 'ev_newest',
            programId,
            streamId: hindiStreamId,
            eventType: 'connection_failed',
            occurredAt: at(2000),
            metadata: {
                reason: 'ice_failed',
                connectionId: 'lc_1',
                clientId: 'client_secret',
                listenerIp: '203.0.113.55',
                userAgent: 'Secret Browser',
                cloudflareSessionId: 'cf-secret',
                trackName: 'track-secret',
                trackMid: '0',
            },
        });

        const response = await request(`/api/admin/programs/${programId}/events?pageSize=2`, {
            headers: { Cookie: cookie },
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            events: Array<{
                id: string;
                eventType: string;
                occurredAt: string;
                stream: {
                    id: string;
                    languageName: string;
                    languageCode: string;
                } | null;
                metadata: Record<string, unknown>;
            }>;
            total: number;
            page: number;
            pageSize: number;
            totalPages: number;
        };

        expect(body.total).toBe(3);
        expect(body.page).toBe(1);
        expect(body.pageSize).toBe(2);
        expect(body.totalPages).toBe(2);
        expect(body.events.map((event) => event.id)).toEqual(['ev_newest', 'ev_middle']);
        expect(body.events[0]?.stream).toEqual({
            id: hindiStreamId,
            languageName: 'Hindi',
            languageCode: 'hi',
        });
        expect(body.events[0]?.metadata).toEqual({
            reason: 'ice_failed',
            connectionId: 'lc_1',
        });

        const text = JSON.stringify(body);
        expect(text).not.toContain('203.0.113.55');
        expect(text).not.toContain('Secret Browser');
        expect(text).not.toContain('client_secret');
        expect(text).not.toContain('cf-secret');
        expect(text).not.toContain('track-secret');
        expect(text).not.toContain('listenerIp');
        expect(text).not.toContain('userAgent');
    });

    it('events resolve translatorName from translatorId', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId } = await seedReportProgram();
        await insertEvent({
            id: 'ev_translator_named',
            programId,
            streamId: hindiStreamId,
            eventType: 'translator_connected',
            occurredAt: '2026-06-20T10:00:00.000Z',
            metadata: { translatorId: 'translator_named' },
            translatorName: 'Ananya Rao',
        });

        const response = await request(`/api/admin/programs/${programId}/events`, {
            headers: { Cookie: cookie },
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            events: Array<{
                translatorName: string | null;
                translatorDeviceLabel: string | null;
            }>;
        };
        expect(body.events[0]?.translatorName).toBe('Ananya Rao');
        expect(body.events[0]?.translatorDeviceLabel).toBeNull();
    });

    it('events show Deleted translator when translatorId has no matching translator', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId } = await seedReportProgram();
        await insertEvent({
            id: 'ev_deleted_translator',
            programId,
            streamId: hindiStreamId,
            eventType: 'translator_connected',
            occurredAt: '2026-06-20T10:00:00.000Z',
            metadata: { translatorId: 'translator_missing' },
        });

        const response = await request(`/api/admin/programs/${programId}/events`, {
            headers: { Cookie: cookie },
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            events: Array<{
                translatorName: string | null;
                translatorDeviceLabel: string | null;
            }>;
        };
        expect(body.events[0]?.translatorName).toBe('Deleted translator');
        expect(body.events[0]?.translatorDeviceLabel).toBeNull();
    });

    it('events resolve translatorDeviceLabel via publishSessionId to translator session user_agent', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId } = await seedReportProgram();
        const ua =
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
        await insertEvent({
            id: 'ev_translator_device',
            programId,
            streamId: hindiStreamId,
            eventType: 'translator_connected',
            occurredAt: '2026-06-20T10:00:00.000Z',
            metadata: {
                translatorId: 'translator_device',
                publishSessionId: 'publish_session_device',
            },
            translatorName: 'Device Translator',
            translatorUserAgent: ua,
        });

        const response = await request(`/api/admin/programs/${programId}/events`, {
            headers: { Cookie: cookie },
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            events: Array<{
                translatorName: string | null;
                translatorDeviceLabel: string | null;
            }>;
        };
        expect(body.events[0]?.translatorName).toBe('Device Translator');
        expect(body.events[0]?.translatorDeviceLabel).toBe(deviceLabelFromUserAgent(ua));
    });

    it('events never leak raw user_agent or publishSessionId in the JSON', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId } = await seedReportProgram();
        const ua =
            'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001) AppleWebKit/537.36 RawSecretTranslatorUA';
        await insertEvent({
            id: 'ev_translator_private',
            programId,
            streamId: hindiStreamId,
            eventType: 'translator_connected',
            occurredAt: '2026-06-20T10:00:00.000Z',
            metadata: {
                translatorId: 'translator_private',
                publishSessionId: 'publish_session_private',
            },
            translatorName: 'Private Translator',
            translatorUserAgent: ua,
        });

        const response = await request(`/api/admin/programs/${programId}/events`, {
            headers: { Cookie: cookie },
        });

        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain('Private Translator');
        expect(text).not.toContain(ua);
        expect(text).not.toContain('RawSecretTranslatorUA');
        expect(text).not.toContain('publishSessionId');
        expect(text).not.toContain('publish_session_private');
    });

    it('events render listener rows without translatorName or translatorDeviceLabel', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId } = await seedReportProgram();

        await insertEvent({
            id: 'ev_listener_row',
            programId,
            streamId: hindiStreamId,
            eventType: 'listener_joined',
            occurredAt: '2026-06-20T10:00:00.000Z',
            metadata: {
                connectionId: 'lc_listener',
            },
        });

        const response = await request(`/api/admin/programs/${programId}/events`, {
            headers: { Cookie: cookie },
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            events: Array<{
                translatorName: string | null;
                translatorDeviceLabel: string | null;
            }>;
        };
        expect(body.events[0]?.translatorName).toBeNull();
        expect(body.events[0]?.translatorDeviceLabel).toBeNull();
    });

    it('event feed defaults pageSize to 20 and clamps pageSize to a maximum of 100', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId } = await seedReportProgram();
        const base = Date.parse('2026-06-20T10:00:00.000Z');

        for (let index = 0; index < 101; index += 1) {
            await insertEvent({
                id: `ev_clamp_${String(index).padStart(3, '0')}`,
                programId,
                streamId: hindiStreamId,
                eventType: 'connection_failed',
                occurredAt: new Date(base + index * 1000).toISOString(),
                metadata: { connectionId: `lc_${index}` },
            });
        }

        const defaultResponse = await request(`/api/admin/programs/${programId}/events`, {
            headers: { Cookie: cookie },
        });
        expect(defaultResponse.status).toBe(200);
        const defaultBody = (await defaultResponse.json()) as {
            events: unknown[];
            total: number;
            pageSize: number;
            totalPages: number;
        };
        expect(defaultBody.events).toHaveLength(20);
        expect(defaultBody.total).toBe(101);
        expect(defaultBody.pageSize).toBe(20);
        expect(defaultBody.totalPages).toBe(6);

        const response = await request(`/api/admin/programs/${programId}/events?pageSize=5000`, {
            headers: { Cookie: cookie },
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            events: unknown[];
            total: number;
            pageSize: number;
            totalPages: number;
        };
        expect(body.events).toHaveLength(100);
        expect(body.total).toBe(101);
        expect(body.pageSize).toBe(100);
        expect(body.totalPages).toBe(2);
    });

    it('events endpoint filters by eventType and translatorId', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId, tamilStreamId } = await seedReportProgram();

        await insertEvent({
            id: 'ev_translator_a_connected',
            programId,
            streamId: hindiStreamId,
            eventType: 'translator_connected',
            occurredAt: '2026-06-20T10:00:00.000Z',
            metadata: { translatorId: 'translator_a' },
        });
        await insertEvent({
            id: 'ev_translator_a_failed',
            programId,
            streamId: hindiStreamId,
            eventType: 'connection_failed',
            occurredAt: '2026-06-20T10:01:00.000Z',
            metadata: { translatorId: 'translator_a', reason: 'ice_failed' },
        });
        await insertEvent({
            id: 'ev_translator_b_failed',
            programId,
            streamId: tamilStreamId,
            eventType: 'connection_failed',
            occurredAt: '2026-06-20T10:02:00.000Z',
            metadata: { translatorId: 'translator_b', reason: 'ice_failed' },
        });

        const response = await request(
            `/api/admin/programs/${programId}/events?eventType=connection_failed&translatorId=translator_a`,
            { headers: { Cookie: cookie } },
        );

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            events: Array<{
                id: string;
                eventType: string;
                metadata: Record<string, unknown>;
            }>;
            total: number;
            page: number;
            pageSize: number;
            totalPages: number;
        };
        expect(body).toMatchObject({
            total: 1,
            page: 1,
            pageSize: 20,
            totalPages: 1,
        });
        expect(body.events.map((event) => event.id)).toEqual(['ev_translator_a_failed']);
        expect(body.events[0]?.eventType).toBe('connection_failed');
        expect(body.events[0]?.metadata).toEqual({
            reason: 'ice_failed',
            translatorId: 'translator_a',
        });
    });

    it('events endpoint filters by MULTIPLE eventTypes (OR)', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId } = await seedReportProgram();

        await insertEvent({
            id: 'ev_connected',
            programId,
            streamId: hindiStreamId,
            eventType: 'translator_connected',
            occurredAt: '2026-06-20T10:00:00.000Z',
        });
        await insertEvent({
            id: 'ev_disconnected',
            programId,
            streamId: hindiStreamId,
            eventType: 'translator_disconnected',
            occurredAt: '2026-06-20T10:01:00.000Z',
        });
        await insertEvent({
            id: 'ev_audio_started',
            programId,
            streamId: hindiStreamId,
            eventType: 'listener_left',
            occurredAt: '2026-06-20T10:02:00.000Z',
        });

        const response = await request(
            `/api/admin/programs/${programId}/events?eventType=translator_connected&eventType=translator_disconnected`,
            { headers: { Cookie: cookie } },
        );

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            events: Array<{ id: string; eventType: string }>;
            total: number;
        };
        expect(body.total).toBe(2);
        expect(body.events.map((event) => event.id)).toEqual(['ev_disconnected', 'ev_connected']);
        expect(body.events.map((event) => event.eventType)).toEqual([
            'translator_disconnected',
            'translator_connected',
        ]);
    });

    it('events endpoint single eventType still works', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId } = await seedReportProgram();

        await insertEvent({
            id: 'ev_connected_single',
            programId,
            streamId: hindiStreamId,
            eventType: 'translator_connected',
            occurredAt: '2026-06-20T10:00:00.000Z',
        });
        await insertEvent({
            id: 'ev_disconnected_single',
            programId,
            streamId: hindiStreamId,
            eventType: 'translator_disconnected',
            occurredAt: '2026-06-20T10:01:00.000Z',
        });

        const response = await request(
            `/api/admin/programs/${programId}/events?eventType=translator_connected`,
            { headers: { Cookie: cookie } },
        );

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            events: Array<{ id: string; eventType: string }>;
            total: number;
        };
        expect(body.total).toBe(1);
        expect(body.events.map((event) => event.id)).toEqual(['ev_connected_single']);
    });

    it('events endpoint ignores invalid eventType values and returns unfiltered rows', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId } = await seedReportProgram();

        await insertEvent({
            id: 'ev_connected_valid',
            programId,
            streamId: hindiStreamId,
            eventType: 'translator_connected',
            occurredAt: '2026-06-20T10:00:00.000Z',
        });
        await insertEvent({
            id: 'ev_audio_started_valid',
            programId,
            streamId: hindiStreamId,
            eventType: 'listener_left',
            occurredAt: '2026-06-20T10:01:00.000Z',
        });

        const mixedResponse = await request(
            `/api/admin/programs/${programId}/events?eventType=not_real&eventType=audio_started`,
            { headers: { Cookie: cookie } },
        );
        expect(mixedResponse.status).toBe(200);
        const mixedBody = (await mixedResponse.json()) as {
            events: Array<{ id: string }>;
            total: number;
        };
        expect(mixedBody.total).toBe(2);
        expect(mixedBody.events.map((event) => event.id)).toEqual([
            'ev_audio_started_valid',
            'ev_connected_valid',
        ]);

        const invalidOnlyResponse = await request(
            `/api/admin/programs/${programId}/events?eventType=not_real`,
            { headers: { Cookie: cookie } },
        );
        expect(invalidOnlyResponse.status).toBe(200);
        const invalidOnlyBody = (await invalidOnlyResponse.json()) as {
            events: Array<{ id: string }>;
            total: number;
        };
        expect(invalidOnlyBody.total).toBe(2);
        expect(invalidOnlyBody.events.map((event) => event.id)).toEqual([
            'ev_audio_started_valid',
            'ev_connected_valid',
        ]);
    });

    it('events endpoint honours ?from=&to=', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId, tamilStreamId } = await seedReportProgram();
        const from = '2026-06-24T10:00:00.000Z';
        const to = '2026-06-25T10:00:00.000Z';

        await insertEvent({
            id: 'ev_before_window',
            programId,
            streamId: hindiStreamId,
            eventType: 'translator_disconnected',
            occurredAt: '2026-06-24T09:59:59.000Z',
        });
        await insertEvent({
            id: 'ev_from_inclusive',
            programId,
            streamId: hindiStreamId,
            eventType: 'listener_reconnected',
            occurredAt: from,
        });
        await insertEvent({
            id: 'ev_inside_window',
            programId,
            streamId: tamilStreamId,
            eventType: 'connection_failed',
            occurredAt: '2026-06-25T09:59:59.000Z',
            metadata: { reason: 'ice_failed' },
        });
        await insertEvent({
            id: 'ev_to_exclusive',
            programId,
            streamId: tamilStreamId,
            eventType: 'listener_left',
            occurredAt: to,
        });

        const response = await request(
            `/api/admin/programs/${programId}/events?pageSize=10&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
            { headers: { Cookie: cookie } },
        );

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            events: Array<{ id: string; eventType: string }>;
            total: number;
            page: number;
            pageSize: number;
            totalPages: number;
        };
        expect(body.total).toBe(2);
        expect(body.page).toBe(1);
        expect(body.pageSize).toBe(10);
        expect(body.totalPages).toBe(1);
        expect(body.events.map((event) => event.id)).toEqual([
            'ev_inside_window',
            'ev_from_inclusive',
        ]);
    });
});

describe('parseListenerReportQuery', () => {
    it('keeps only supported states and drops invalid entries', () => {
        const params = new URLSearchParams(
            'state=connected&state=bogus&state=failed&state=connected',
        );
        const { filters } = parseListenerReportQuery(params);

        expect(filters.states).toEqual(['connected', 'failed', 'connected']);
    });

    it('parses page and drops invalid values', () => {
        expect(parseListenerReportQuery(new URLSearchParams('page=abc')).page).toBe(1);
        expect(parseListenerReportQuery(new URLSearchParams('page=0')).page).toBe(1);
        expect(parseListenerReportQuery(new URLSearchParams('page=2')).page).toBe(2);
    });

    it('drops unknown device labels', () => {
        const { filters } = parseListenerReportQuery(new URLSearchParams('device=Unknown Device'));
        expect(filters.deviceLabel).toBeUndefined();
    });

    it('drops invalid date bounds and parses bare-date to a UTC boundary', () => {
        const { filters } = parseListenerReportQuery(
            new URLSearchParams('from=not-a-date&to=2026-06-24'),
        );
        expect(filters.createdFrom).toBeUndefined();
        expect(filters.createdTo).toBe('2026-06-25T00:00:00.000Z');
    });

    it('keeps only supported approval statuses and drops invalid entries', () => {
        const { filters } = parseListenerReportQuery(
            new URLSearchParams(
                'approvalStatus=approved&approvalStatus=bogus&approvalStatus=revoked',
            ),
        );
        expect(filters.approvalStatuses).toEqual(['approved', 'revoked']);
    });
});

describe('admin listener report route', () => {
    beforeEach(async () => {
        await resetDb();
    });

    it('returns paginated envelope data with total counts', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId } = await seedReportProgram();

        const baseMs = Date.parse('2026-06-20T12:00:00.000Z');
        for (let index = 0; index < 105; index += 1) {
            const createdAt = new Date(baseMs - index * 1000).toISOString();
            await insertConnection({
                id: `lc_connected_${index}`,
                programId,
                streamId: hindiStreamId,
                clientId: `client_connected_${index}`,
                status: 'connected',
                connectedAt: createdAt,
                disconnectedAt: null,
                disconnectReason: null,
                listenerIp: '203.0.113.10',
                userAgent: 'Chrome on Android',
                createdAt,
            });
        }

        const response = await request(
            `/api/admin/programs/${programId}/listener-report?state=connected&page=2`,
            { headers: { Cookie: cookie } },
        );

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            connections: Array<Record<string, unknown>>;
            total: number;
            page: number;
            pageSize: number;
            totalPages: number;
        };

        expect(body.total).toBe(105);
        expect(body.page).toBe(2);
        expect(body.pageSize).toBe(100);
        expect(body.totalPages).toBe(2);
        expect(body.connections).toHaveLength(5);
    });

    it('clamps invalid page and ignores bad from bounds', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId } = await seedReportProgram();
        await insertConnection({
            id: 'lc_connected_1',
            programId,
            streamId: hindiStreamId,
            clientId: 'client_connected_1',
            status: 'connected',
            connectedAt: '2026-06-20T12:00:00.000Z',
            disconnectedAt: null,
            disconnectReason: null,
            listenerIp: '203.0.113.10',
            userAgent: 'Chrome on Android',
            createdAt: '2026-06-20T12:00:00.000Z',
        });

        const response = await request(
            `/api/admin/programs/${programId}/listener-report?page=0&from=not-a-date`,
            { headers: { Cookie: cookie } },
        );

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            total: number;
            page: number;
            pageSize: number;
            totalPages: number;
        };
        expect(body.total).toBe(1);
        expect(body.page).toBe(1);
    });

    it('returns 404 for a missing program', async () => {
        const cookie = await adminCookie();
        const response = await request('/api/admin/programs/program_missing/listener-report', {
            headers: { Cookie: cookie },
        });

        expect(response.status).toBe(404);
    });
});

describe('admin listener CSV export route', () => {
    beforeEach(async () => {
        await resetDb();
    });

    it('requires admin authentication', async () => {
        const response = await request('/api/admin/programs/program_missing/listener-report.csv');
        expect(response.status).toBe(401);
    });

    it('returns an escaped CSV with the report header, slug filename, and notes', async () => {
        const cookie = await adminCookie();
        const { programId, slug, hindiStreamId } = await seedReportProgram();

        await insertConnection({
            id: 'lc_csv_1',
            programId,
            streamId: hindiStreamId,
            clientId: 'client_csv_1',
            status: 'connected',
            connectedAt: '2026-06-20T12:00:00.000Z',
            disconnectedAt: null,
            disconnectReason: null,
            listenerIp: '203.0.113.10',
            userAgent: 'Mozilla, Safari',
            createdAt: '2026-06-20T12:00:00.000Z',
        });
        await insertConnection({
            id: 'lc_csv_2',
            programId,
            streamId: hindiStreamId,
            clientId: 'client_csv_2',
            status: 'disconnected',
            connectedAt: '2026-06-20T12:05:00.000Z',
            disconnectedAt: '2026-06-20T12:10:00.000Z',
            disconnectReason: "=cmd|' /C calc'!A1",
            listenerIp: '203.0.113.11',
            userAgent: 'Quote "Browser"',
            createdAt: '2026-06-20T12:05:00.000Z',
        });

        const response = await request(`/api/admin/programs/${programId}/listener-report.csv`, {
            headers: { Cookie: cookie },
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/^text\/csv/);
        expect(response.headers.get('content-disposition')).toContain(
            `${slug}-listener-report.csv`,
        );
        expect(response.headers.get('x-report-notes')).toContain('disconnectedAt');

        const text = await response.text();
        const lines = text.split('\r\n');
        expect(lines[0]).toBe(
            'connectionId,clientId,streamId,connectedAt,disconnectedAt,disconnectReason,listenerIp,userAgent,deviceModel,deviceModelName,platform,platformVersion,browserFullVersion,approvalStatus,approvedAt,approvedVia',
        );
        // Comma in user agent must be quoted.
        expect(text).toContain('"Mozilla, Safari"');
        // Formula-like disconnect reason must be neutralized with a leading quote.
        expect(text).toContain("'=cmd|' /C calc'!A1");
        expect(text).not.toContain(',=cmd|');
        // Interior quotes doubled.
        expect(text).toContain('"Quote ""Browser"""');
    });

    it('filters CSV rows by failed subscription state', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId } = await seedReportProgram();

        await insertConnection({
            id: 'lc_failed_1',
            programId,
            streamId: hindiStreamId,
            clientId: 'client_csv_failed',
            status: 'failed',
            connectedAt: '2026-06-20T12:00:00.000Z',
            disconnectedAt: '2026-06-20T12:01:00.000Z',
            disconnectReason: 'failed',
            listenerIp: '203.0.113.10',
            userAgent: 'Chrome on Android',
            createdAt: '2026-06-20T12:00:00.000Z',
        });
        await insertConnection({
            id: 'lc_connected_1',
            programId,
            streamId: hindiStreamId,
            clientId: 'client_csv_connected',
            status: 'connected',
            connectedAt: '2026-06-20T12:00:00.000Z',
            disconnectedAt: null,
            disconnectReason: null,
            listenerIp: '203.0.113.11',
            userAgent: 'Chrome on Android',
            createdAt: '2026-06-20T12:00:00.000Z',
        });

        const response = await request(
            `/api/admin/programs/${programId}/listener-report.csv?state=failed`,
            { headers: { Cookie: cookie } },
        );

        expect(response.status).toBe(200);
        const lines = (await response.text()).split('\r\n').filter(Boolean);
        const rows = lines.slice(1);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toContain('lc_failed_1');
        expect(rows[0]).not.toContain('lc_connected_1');
    });

    it('exports all matching rows to CSV even when page is supplied', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId } = await seedReportProgram();
        const baseMs = Date.parse('2026-06-20T12:00:00.000Z');

        for (let index = 0; index < 101; index += 1) {
            await insertConnection({
                id: `lc_failed_${index}`,
                programId,
                streamId: hindiStreamId,
                clientId: `client_failed_${index}`,
                status: 'failed',
                connectedAt: new Date(baseMs - index * 1000).toISOString(),
                disconnectedAt: '2026-06-20T12:10:00.000Z',
                disconnectReason: 'failed',
                listenerIp: '203.0.113.10',
                userAgent: 'Chrome on Android',
                createdAt: new Date(baseMs - index * 1000).toISOString(),
            });
        }

        const response = await request(
            `/api/admin/programs/${programId}/listener-report.csv?state=failed&page=2`,
            { headers: { Cookie: cookie } },
        );

        expect(response.status).toBe(200);
        const rows = (await response.text()).split('\r\n').filter(Boolean);
        expect(rows).toHaveLength(102);
    });

    it('returns program_not_found for a missing program', async () => {
        const cookie = await adminCookie();
        const response = await request('/api/admin/programs/program_missing/listener-report.csv', {
            headers: { Cookie: cookie },
        });
        expect(response.status).toBe(404);
    });
});

async function readProgramRow(programId: string): Promise<{
    status: string;
    archivedAt: string | null;
    retentionProcessedAt: string | null;
    aggregateSummaryJson: string | null;
}> {
    const row = (await testEnv.DB.prepare(
        `SELECT status,
      archived_at as archivedAt,
      retention_processed_at as retentionProcessedAt,
      aggregate_summary_json as aggregateSummaryJson
    FROM programs WHERE id = ?`,
    )
        .bind(programId)
        .get()) as
        | {
              status: string;
              archivedAt: string | null;
              retentionProcessedAt: string | null;
              aggregateSummaryJson: string | null;
          }
        | undefined;
    if (!row) {
        throw new Error('program not found');
    }
    return row;
}

describe('admin archive snapshot and retention', () => {
    beforeEach(async () => {
        await resetDb();
    });

    it('captures an aggregate summary snapshot and archived_at on archive', async () => {
        const cookie = await adminCookie();
        const { programId, hindiStreamId } = await seedReportProgram();

        await insertConnection({
            id: 'lc_arch_1',
            programId,
            streamId: hindiStreamId,
            clientId: 'client_arch_1',
            status: 'connected',
            connectedAt: '2026-06-20T12:00:00.000Z',
            lastSeenAt: new Date().toISOString(),
            createdAt: '2026-06-20T12:00:00.000Z',
        });

        const archiveResponse = await request(`/api/admin/programs/${programId}/archive`, {
            method: 'POST',
            headers: { Cookie: cookie },
        });
        expect(archiveResponse.status).toBe(200);

        const row = await readProgramRow(programId);
        expect(row.status).toBe('archived');
        expect(row.archivedAt).not.toBeNull();
        expect(row.aggregateSummaryJson).not.toBeNull();

        // Archived summaries come from the captured snapshot, not live presence.
        const summaryResponse = await request(`/api/admin/programs/${programId}/report/summary`, {
            headers: { Cookie: cookie },
        });
        expect(summaryResponse.status).toBe(200);
        const summary = (await summaryResponse.json()) as {
            presenceSource: string;
            totals: { activeListeners: number; totalConnections: number };
        };
        expect(summary.presenceSource).toBe('archived_snapshot');
        expect(summary.totals.activeListeners).toBeGreaterThan(0);
        expect(summary.totals.totalConnections).toBe(1);
    });

    it('defaults legacy archived summary uniqueDevices to zero', async () => {
        const cookie = await adminCookie();
        const suffix = crypto.randomUUID();
        const programId = `program_legacy_snapshot_${suffix}`;
        const slug = `legacy-snapshot-${suffix}`;

        await insertProgram({
            programId,
            slug,
            status: 'archived',
            archivedAt: '2026-06-20T12:00:00.000Z',
            aggregateSummaryJson: JSON.stringify({
                totals: {
                    activeListeners: 0,
                    totalConnections: 7,
                    dropouts: 1,
                    reconnects: 2,
                },
                streams: [],
            }),
        });

        const response = await request(`/api/admin/programs/${programId}/report/summary`, {
            headers: { Cookie: cookie },
        });

        expect(response.status).toBe(200);
        const summary = (await response.json()) as {
            presenceSource: string;
            totals: { uniqueDevices: unknown };
        };
        expect(summary.presenceSource).toBe('archived_snapshot');
        expect(summary.totals.uniqueDevices).toBe(0);
        expect(typeof summary.totals.uniqueDevices).toBe('number');
    });

    it('preserves archived summary uniqueDevices when present', async () => {
        const cookie = await adminCookie();
        const suffix = crypto.randomUUID();
        const programId = `program_current_snapshot_${suffix}`;
        const slug = `current-snapshot-${suffix}`;

        await insertProgram({
            programId,
            slug,
            status: 'archived',
            archivedAt: '2026-06-20T12:00:00.000Z',
            aggregateSummaryJson: JSON.stringify({
                totals: {
                    activeListeners: 0,
                    totalConnections: 7,
                    uniqueDevices: 4,
                    dropouts: 1,
                    reconnects: 2,
                },
                streams: [],
            }),
        });

        const response = await request(`/api/admin/programs/${programId}/report/summary`, {
            headers: { Cookie: cookie },
        });

        expect(response.status).toBe(200);
        const summary = (await response.json()) as {
            totals: { uniqueDevices: unknown };
        };
        expect(summary.totals.uniqueDevices).toBe(4);
        expect(typeof summary.totals.uniqueDevices).toBe('number');
    });

    it('anonymizes telemetry for programs archived at least 30 days ago', async () => {
        const cookie = await adminCookie();
        const suffix = crypto.randomUUID();
        const programId = `program_retention_${suffix}`;
        const slug = `patna-retention-${suffix}`;
        const streamId = `stream_retention_${suffix}`;
        const archivedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

        await insertProgram({
            programId,
            slug,
            status: 'archived',
            archivedAt,
        });
        await insertStream({
            streamId,
            programId,
            languageName: 'Hindi',
            languageCode: 'hi',
            displayOrder: 1,
            isActive: 1,
        });
        await insertConnection({
            id: 'lc_ret_1',
            programId,
            streamId,
            clientId: 'client_ret_1',
            status: 'disconnected',
            connectedAt: '2026-05-01T12:00:00.000Z',
            disconnectedAt: '2026-05-01T12:30:00.000Z',
            disconnectReason: 'network_loss',
            listenerIp: '203.0.113.10',
            userAgent: 'Mobile Safari',
            createdAt: '2026-05-01T12:00:00.000Z',
        });
        await insertConnection({
            id: 'lc_ret_2',
            programId,
            streamId,
            clientId: 'client_ret_2',
            status: 'disconnected',
            connectedAt: '2026-05-01T12:05:00.000Z',
            disconnectedAt: '2026-05-01T12:35:00.000Z',
            disconnectReason: 'client_disconnect',
            listenerIp: '203.0.113.11',
            userAgent: 'Android Chrome',
            createdAt: '2026-05-01T12:05:00.000Z',
        });
        await insertEvent({
            id: 'ev_ret_drop',
            programId,
            streamId,
            eventType: 'connection_failed',
            occurredAt: '2026-05-01T12:40:00.000Z',
            metadata: { reason: 'ice_failed', connectionId: 'lc_ret_1' },
        });
        await insertEvent({
            id: 'ev_ret_reconnect',
            programId,
            streamId,
            eventType: 'listener_reconnected',
            occurredAt: '2026-05-01T12:45:00.000Z',
            metadata: { reason: 'reconnected', connectionId: 'lc_ret_2' },
        });

        const response = await request(`/api/admin/programs/${programId}/retention/run`, {
            method: 'POST',
            headers: { Cookie: cookie },
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            programId: string;
            processed: boolean;
            anonymizedConnections: number;
            retentionProcessedAt: string | null;
        };
        expect(body.programId).toBe(programId);
        expect(body.processed).toBe(true);
        expect(body.anonymizedConnections).toBe(2);
        expect(body.retentionProcessedAt).not.toBeNull();

        const rows = (await testEnv.DB.prepare(
            `SELECT listener_ip as listenerIp, user_agent as userAgent
      FROM listener_connections WHERE program_id = ? ORDER BY id ASC`,
        )
            .bind(programId)
            .all()) as Array<{ listenerIp: string; userAgent: string }>;
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.listenerIp).toBe('[redacted]');
            expect(row.userAgent).toBe('[redacted]');
        }

        // Counts, dropouts, and reconnects survive anonymization.
        const summaryResponse = await request(`/api/admin/programs/${programId}/report/summary`, {
            headers: { Cookie: cookie },
        });
        const summary = (await summaryResponse.json()) as {
            totals: {
                totalConnections: number;
                dropouts: number;
                reconnects: number;
            };
        };
        expect(summary.totals.totalConnections).toBe(2);
        expect(summary.totals.dropouts).toBe(1);
        expect(summary.totals.reconnects).toBe(1);

        // Second run is idempotent.
        const second = await request(`/api/admin/programs/${programId}/retention/run`, {
            method: 'POST',
            headers: { Cookie: cookie },
        });
        const secondBody = (await second.json()) as {
            processed: boolean;
            anonymizedConnections: number;
        };
        expect(secondBody.processed).toBe(false);
        expect(secondBody.anonymizedConnections).toBe(0);
    });

    it('does not anonymize programs archived less than 30 days ago', async () => {
        const cookie = await adminCookie();
        const suffix = crypto.randomUUID();
        const programId = `program_recent_${suffix}`;
        const archivedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
        await insertProgram({
            programId,
            slug: `patna-recent-${suffix}`,
            status: 'archived',
            archivedAt,
        });

        const response = await request(`/api/admin/programs/${programId}/retention/run`, {
            method: 'POST',
            headers: { Cookie: cookie },
        });
        const body = (await response.json()) as {
            processed: boolean;
            anonymizedConnections: number;
        };
        expect(body.processed).toBe(false);
        expect(body.anonymizedConnections).toBe(0);

        const row = await readProgramRow(programId);
        expect(row.retentionProcessedAt).toBeNull();
    });

    it('does not anonymize non-archived programs', async () => {
        const cookie = await adminCookie();
        const { programId } = await seedReportProgram('live');

        const response = await request(`/api/admin/programs/${programId}/retention/run`, {
            method: 'POST',
            headers: { Cookie: cookie },
        });
        const body = (await response.json()) as {
            processed: boolean;
            anonymizedConnections: number;
        };
        expect(body.processed).toBe(false);
        expect(body.anonymizedConnections).toBe(0);
    });

    it('requires admin authentication for retention', async () => {
        const response = await request('/api/admin/programs/program_missing/retention/run', {
            method: 'POST',
        });
        expect(response.status).toBe(401);
    });
});
