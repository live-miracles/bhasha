import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../src/env';
import { createApp } from '../src/index';
import { roomNameForStream } from '../src/livekit/tokens';
import { adminCookie, buildTestEnv, seedAdmin, testEnv } from './test-env';

// NOTE ON SCOPE (Slice 3): the five SFU-shaped stub endpoints this file used
// to exercise (`ice-servers`, `active-publisher`, `subscribe/session`,
// `subscribe/track`, `subscribe/renegotiate`) are deleted entirely --
// LiveKit's client SDK has its own built-in TURN (no ICE-servers fetch
// needed), and "is there a publisher" is answered by the room's own state /
// the public `/status` endpoint, not a per-listener poll. They are replaced
// by a single `POST /api/listeners/token`, which keeps the same generic
// pre-SFU bookkeeping `subscribe/session` used to do (program/stream
// resolution, access-control, connection existence) and then mints a real
// LiveKit listener token instead of stubbing. The fully-functional
// request/connected/heartbeat/leave/switch/reconnect lifecycle is covered in
// listeners.test.ts and listenerAccess.test.ts.

type ProgramStreamGraph = {
    program: { id: string; slug: string };
    hindi: { id: string };
};

type TokenResponseBody = {
    connectionId: string;
    token: string;
    url: string;
    roomName: string;
};

async function request(
    path: string,
    init: RequestInit = {},
    env: Env = buildTestEnv(),
): Promise<Response> {
    const app = createApp(env);
    return app.fetch(new Request(`https://bhasha.test${path}`, init));
}

async function adminReport(programId: string): Promise<{
    connections: unknown[];
}> {
    const cookie = await adminCookie();
    const report = await request(`/api/admin/programs/${programId}/listener-report`, {
        headers: { Cookie: cookie },
    });
    expect(report.status).toBe(200);
    return (await report.json()) as { connections: unknown[] };
}

async function seedProgramAndStreams(): Promise<ProgramStreamGraph> {
    const suffix = crypto.randomUUID();
    const now = new Date().toISOString();
    const programId = `program_${suffix}`;
    const programSlug = `patna-event-${suffix}`;
    const streamId = `stream_${suffix}_hi`;

    testEnv.DB.prepare(
        `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        programId,
        programSlug,
        'Patna Event 2026',
        'Main Hall',
        '2026-08-01',
        'live',
        '',
        now,
        now,
    );

    testEnv.DB.prepare(
        `INSERT INTO language_streams
    (id, program_id, language_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(streamId, programId, 'Hindi', 'hi', 1, 1, 0, null, null, now, now);

    return {
        program: { id: programId, slug: programSlug },
        hindi: { id: streamId },
    };
}

async function seedDisconnectedListener(): Promise<{ connectionId: string }> {
    const { program, hindi } = await seedProgramAndStreams();
    const suffix = crypto.randomUUID();
    const now = new Date().toISOString();
    const connectionId = `listener_connection_${suffix}`;

    testEnv.DB.prepare(
        `INSERT INTO listener_connections
    (id, program_id, language_stream_id, client_id, token_issued_at,
     subscription_status, disconnected_at, disconnect_reason, listener_ip,
     user_agent, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'disconnected', ?, ?, ?, ?, ?, ?)`,
    ).run(
        connectionId,
        program.id,
        hindi.id,
        'listener-1',
        now,
        now,
        'client_disconnect',
        '203.0.113.10',
        'Mobile Safari',
        now,
        now,
    );

    return { connectionId };
}

async function listenerConnectionProgram(connectionId: string): Promise<{
    programId: string;
    streamId: string;
    clientId: string;
}> {
    const row = testEnv.DB.prepare(
        `SELECT program_id as programId,
      language_stream_id as streamId,
      client_id as clientId
    FROM listener_connections
    WHERE id = ?`,
    ).get(connectionId) as { programId: string; streamId: string; clientId: string } | undefined;

    if (!row) {
        throw new Error(`listener connection ${connectionId} not found`);
    }
    return row;
}

function expectValidToken(
    body: TokenResponseBody,
    expected: { connectionId: string; programId: string; streamId: string },
): void {
    expect(body.connectionId).toBe(expected.connectionId);
    expect(body.roomName).toBe(roomNameForStream(expected.programId, expected.streamId));
    expect(body.url).toBe('ws://localhost:7880');
    // A real JWT (signed via the devkey/secret test credentials in
    // test/test-env.ts) -- three base64url segments.
    expect(body.token.split('.')).toHaveLength(3);
}

describe('listener realtime connection request', () => {
    beforeEach(async () => {
        testEnv.DB.exec('DELETE FROM listener_realtime_cleanup_targets');
        testEnv.DB.exec('DELETE FROM stream_events');
        testEnv.DB.exec('DELETE FROM listener_connections');
        testEnv.DB.exec('DELETE FROM realtime_publish_sessions');
        testEnv.DB.exec('DELETE FROM admin_sessions');
        testEnv.DB.exec('DELETE FROM translator_sessions');
        testEnv.DB.exec('DELETE FROM translator_stream_assignments');
        testEnv.DB.exec('DELETE FROM translators');
        testEnv.DB.exec('DELETE FROM language_streams');
        testEnv.DB.exec('DELETE FROM programs');
        await seedAdmin(testEnv);
    });

    it('uses the approved listener error contract', async () => {
        const missing = await request('/api/listeners/connected', {
            method: 'POST',
            body: JSON.stringify({ connectionId: 'listener_connection_missing' }),
        });
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({
            error: 'listener_connection_not_found',
        });

        const graph = await seedDisconnectedListener();
        const invalid = await request('/api/listeners/connected', {
            method: 'POST',
            body: JSON.stringify({ connectionId: graph.connectionId }),
        });
        expect(invalid.status).toBe(409);
        expect(await invalid.json()).toEqual({ error: 'listener_invalid_state' });
    });

    it('creates requested listener connections from programSlug while keeping programId compatibility explicit', async () => {
        const { program, hindi } = await seedProgramAndStreams();

        const bySlug = await request('/api/listeners/request', {
            method: 'POST',
            headers: {
                'cf-connecting-ip': '203.0.113.10',
                'user-agent': 'Mobile Safari',
            },
            body: JSON.stringify({
                programSlug: program.slug,
                streamId: hindi.id,
                clientId: 'listener-by-slug',
            }),
        });

        expect(bySlug.status).toBe(201);
        const slugBody = (await bySlug.json()) as { connectionId: string };
        await expect(listenerConnectionProgram(slugBody.connectionId)).resolves.toEqual({
            programId: program.id,
            streamId: hindi.id,
            clientId: 'listener-by-slug',
        });

        const compatibility = await request('/api/listeners/request', {
            method: 'POST',
            body: JSON.stringify({
                programId: program.id,
                streamId: hindi.id,
                clientId: 'listener-by-program-id',
            }),
        });

        expect(compatibility.status).toBe(201);
        const compatibilityBody = (await compatibility.json()) as {
            connectionId: string;
        };
        await expect(listenerConnectionProgram(compatibilityBody.connectionId)).resolves.toEqual({
            programId: program.id,
            streamId: hindi.id,
            clientId: 'listener-by-program-id',
        });
    });

    it('rejects requested listener connections when programSlug and programId refer to different programs', async () => {
        const { program, hindi } = await seedProgramAndStreams();
        const other = await seedProgramAndStreams();

        const response = await request('/api/listeners/request', {
            method: 'POST',
            body: JSON.stringify({
                programSlug: program.slug,
                programId: other.program.id,
                streamId: hindi.id,
                clientId: 'listener-conflicting-program-reference',
            }),
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            error: 'program_reference_mismatch',
        });
    });
});

describe('listener realtime token', () => {
    beforeEach(async () => {
        testEnv.DB.exec('DELETE FROM listener_realtime_cleanup_targets');
        testEnv.DB.exec('DELETE FROM stream_events');
        testEnv.DB.exec('DELETE FROM listener_connections');
        testEnv.DB.exec('DELETE FROM realtime_publish_sessions');
        testEnv.DB.exec('DELETE FROM admin_sessions');
        testEnv.DB.exec('DELETE FROM translator_sessions');
        testEnv.DB.exec('DELETE FROM translator_stream_assignments');
        testEnv.DB.exec('DELETE FROM translators');
        testEnv.DB.exec('DELETE FROM language_streams');
        testEnv.DB.exec('DELETE FROM programs');
        await seedAdmin(testEnv);
    });

    async function requestConnection(
        program: ProgramStreamGraph['program'],
        hindi: ProgramStreamGraph['hindi'],
        clientId: string,
    ): Promise<string> {
        const response = await request('/api/listeners/request', {
            method: 'POST',
            body: JSON.stringify({
                programId: program.id,
                streamId: hindi.id,
                clientId,
            }),
        });
        expect(response.status).toBe(201);
        const body = (await response.json()) as { connectionId: string };
        return body.connectionId;
    }

    it('mints a subscribe-only LiveKit token for an existing connection', async () => {
        const { program, hindi } = await seedProgramAndStreams();
        const connectionId = await requestConnection(program, hindi, 'listener-token-1');

        const response = await request('/api/listeners/token', {
            method: 'POST',
            body: JSON.stringify({
                programId: program.id,
                streamId: hindi.id,
                connectionId,
            }),
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as TokenResponseBody;
        expectValidToken(body, {
            connectionId,
            programId: program.id,
            streamId: hindi.id,
        });
    });

    it('requires an existing connectionId to belong to the program before minting', async () => {
        const { program, hindi } = await seedProgramAndStreams();
        const connectionId = await requestConnection(program, hindi, 'listener-existing-request');

        const missingConnection = await request('/api/listeners/token', {
            method: 'POST',
            body: JSON.stringify({
                programId: program.id,
                streamId: hindi.id,
                connectionId: 'listener_connection_missing',
            }),
        });
        expect(missingConnection.status).toBe(404);
        expect(await missingConnection.json()).toEqual({
            error: 'listener_connection_not_found',
        });

        const knownConnection = await request('/api/listeners/token', {
            method: 'POST',
            body: JSON.stringify({
                programId: program.id,
                streamId: hindi.id,
                connectionId,
            }),
        });
        expect(knownConnection.status).toBe(200);
    });

    it('rejects a token request when programSlug and programId refer to different programs', async () => {
        const { program, hindi } = await seedProgramAndStreams();
        const other = await seedProgramAndStreams();
        const connectionId = await requestConnection(
            program,
            hindi,
            'listener-subscribe-conflicting-program-reference',
        );

        const response = await request('/api/listeners/token', {
            method: 'POST',
            body: JSON.stringify({
                programSlug: program.slug,
                programId: other.program.id,
                streamId: hindi.id,
                connectionId,
            }),
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            error: 'program_reference_mismatch',
        });
        // The mismatch is caught before minting -- the connection created above
        // as setup is the only row that exists.
        const report = await adminReport(program.id);
        expect(report.connections).toHaveLength(1);
    });

    it('rejects a connectionId that belongs to a different program', async () => {
        const { program, hindi } = await seedProgramAndStreams();
        const other = await seedProgramAndStreams();
        const connectionId = await requestConnection(program, hindi, 'listener-cross-program');

        const response = await request('/api/listeners/token', {
            method: 'POST',
            body: JSON.stringify({
                programId: other.program.id,
                streamId: other.hindi.id,
                connectionId,
            }),
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'program_mismatch' });
    });

    it('rejects a connectionId that belongs to a different stream in the same program', async () => {
        // A connection requested for one stream must not be usable to mint a
        // token scoped to a DIFFERENT stream in the same program -- otherwise a
        // listener could token-hop streams with one connectionId, and the
        // webhook-driven presence/live-count would attribute them to the wrong
        // stream while the DB row (used for admin reporting) still says the
        // original one.
        const { program, hindi } = await seedProgramAndStreams();
        const suffix = crypto.randomUUID();
        const now = new Date().toISOString();
        const englishStreamId = `stream_${suffix}_en`;
        testEnv.DB.prepare(
            `INSERT INTO language_streams
      (id, program_id, language_name, language_code, display_order, is_active,
       is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(englishStreamId, program.id, 'English', 'en', 2, 1, 0, null, null, now, now);

        const connectionId = await requestConnection(program, hindi, 'listener-stream-hop');

        const response = await request('/api/listeners/token', {
            method: 'POST',
            body: JSON.stringify({
                programId: program.id,
                streamId: englishStreamId,
                connectionId,
            }),
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'stream_mismatch' });
    });

    it('rejects minting a token for a connection that is already disconnected', async () => {
        const { connectionId } = await seedDisconnectedListener();
        const { programId, streamId } = await listenerConnectionProgram(connectionId);

        const response = await request('/api/listeners/token', {
            method: 'POST',
            body: JSON.stringify({ programId, streamId, connectionId }),
        });

        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: 'listener_invalid_state' });
    });

    it('returns validation_error for a missing streamId or connectionId', async () => {
        const { program } = await seedProgramAndStreams();

        const missingStream = await request('/api/listeners/token', {
            method: 'POST',
            body: JSON.stringify({ programId: program.id, connectionId: 'x' }),
        });
        expect(missingStream.status).toBe(400);

        const missingConnectionId = await request('/api/listeners/token', {
            method: 'POST',
            body: JSON.stringify({ programId: program.id, streamId: 'some-stream' }),
        });
        expect(missingConnectionId.status).toBe(400);
    });

    it('returns realtime_not_configured when LiveKit env vars are not set', async () => {
        const { program, hindi } = await seedProgramAndStreams();
        const connectionId = await requestConnection(program, hindi, 'listener-unconfigured');
        const unconfiguredEnv = buildTestEnv({
            LIVEKIT_URL: undefined,
            LIVEKIT_API_KEY: undefined,
            LIVEKIT_API_SECRET: undefined,
        });

        const response = await request(
            '/api/listeners/token',
            {
                method: 'POST',
                body: JSON.stringify({
                    programId: program.id,
                    streamId: hindi.id,
                    connectionId,
                }),
            },
            unconfiguredEnv,
        );

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'realtime_not_configured' });
    });
});
