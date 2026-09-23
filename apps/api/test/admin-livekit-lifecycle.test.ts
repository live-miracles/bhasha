import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomServiceClient } from 'livekit-server-sdk';

import { handleAdminRoutes } from '../src/routes/admin';
import { roomNameForStream, translatorIdentity } from '../src/livekit/tokens';
import type { WaitUntilCtx } from '../src/http';
import { adminCookie, buildTestEnv, seedAdmin, seedProgram, testEnv } from './test-env';

// handleAdminRoutes takes its RoomServiceClient as an injectable parameter
// (defaulting to a real one built from `env`) specifically so these tests
// can hand it a fake directly -- see the DI comment on handleLiveKitWebhook
// in livekit/webhook.ts for why `vi.mock`-ing livekit/client.ts does not
// work in this codebase (test-env.ts's own import chain instantiates the
// real module graph during Vitest's setupFiles phase).
function fakeRoomService(): {
    removeParticipant: ReturnType<typeof vi.fn>;
    deleteRoom: ReturnType<typeof vi.fn>;
} {
    return {
        removeParticipant: vi.fn().mockResolvedValue(undefined),
        deleteRoom: vi.fn().mockResolvedValue(undefined),
    };
}

async function adminRoute(
    path: string,
    init: RequestInit,
    roomService: RoomServiceClient,
): Promise<Response> {
    const request = new Request(`https://bhasha.test${path}`, init);
    const response = await handleAdminRoutes(
        request,
        buildTestEnv(),
        new URL(request.url),
        { waitUntil() {} } as WaitUntilCtx,
        roomService,
    );
    if (!response) {
        throw new Error(`admin route returned null for ${path}`);
    }
    return response;
}

async function resetDb(): Promise<void> {
    testEnv.DB.exec('DELETE FROM listener_realtime_cleanup_targets');
    testEnv.DB.exec('DELETE FROM realtime_publish_sessions');
    testEnv.DB.exec('DELETE FROM translator_sessions');
    testEnv.DB.exec('DELETE FROM stream_events');
    testEnv.DB.exec('DELETE FROM listener_connections');
    testEnv.DB.exec('DELETE FROM admin_sessions');
    testEnv.DB.exec('DELETE FROM translator_stream_assignments');
    testEnv.DB.exec('DELETE FROM translators');
    testEnv.DB.exec('DELETE FROM language_streams');
    testEnv.DB.exec('DELETE FROM programs');
}

interface Fixture {
    cookie: string;
    programId: string;
    streamId: string;
    translatorId: string;
}

async function seedProgramWithTranslatorAndStream(
    cookie: string,
    roomService: RoomServiceClient,
): Promise<Fixture> {
    const suffix = crypto.randomUUID();
    const program = await seedProgram(testEnv, {
        slug: `livekit-lifecycle-${suffix}`,
        name: 'LiveKit Lifecycle Event',
    });
    const programId = program.id;

    const streamResponse = await adminRoute(
        `/api/admin/programs/${programId}/streams`,
        {
            method: 'POST',
            headers: { Cookie: cookie },
            body: JSON.stringify({
                languageName: 'Hindi',
                languageCode: 'hi',
                displayOrder: 1,
                isActive: true,
            }),
        },
        roomService,
    );
    expect(streamResponse.status).toBe(201);
    const { id: streamId } = (await streamResponse.json()) as { id: string };

    const translatorResponse = await adminRoute(
        `/api/admin/programs/${programId}/translators`,
        {
            method: 'POST',
            headers: { Cookie: cookie },
            body: JSON.stringify({
                email: `translator-${suffix}@example.com`,
                name: 'Lifecycle translator',
                password: 'translator-pass',
            }),
        },
        roomService,
    );
    expect(translatorResponse.status).toBe(201);
    const { id: translatorId } = (await translatorResponse.json()) as {
        id: string;
    };

    const assignmentResponse = await adminRoute(
        `/api/admin/programs/${programId}/translators/${translatorId}/assignments`,
        {
            method: 'POST',
            headers: { Cookie: cookie },
            body: JSON.stringify({ streamId }),
        },
        roomService,
    );
    expect(assignmentResponse.status).toBe(201);

    return { cookie, programId, streamId, translatorId };
}

async function createTranslatorSession(params: {
    programId: string;
    translatorId: string;
}): Promise<string> {
    const sessionId = `translator_session_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const expiry = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    testEnv.DB.prepare(
        `INSERT INTO translator_sessions
      (id, session_hash, program_id, translator_id,
       absolute_expires_at, expires_at, last_seen_at, created_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        sessionId,
        `hash_${crypto.randomUUID()}`,
        params.programId,
        params.translatorId,
        expiry,
        expiry,
        now,
        now,
        'test-agent',
    );
    return sessionId;
}

async function createPublishReservation(params: {
    programId: string;
    streamId: string;
    translatorId: string;
    translatorSessionId: string;
}): Promise<string> {
    const publishSessionId = `realtime_publish_session_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const expiry = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    testEnv.DB.prepare(
        `INSERT INTO realtime_publish_sessions
      (id, program_id, language_stream_id, translator_id,
       translator_session_id, cloudflare_session_id, state,
       expires_at, closed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'published', ?, NULL, ?, ?)`,
    ).run(
        publishSessionId,
        params.programId,
        params.streamId,
        params.translatorId,
        params.translatorSessionId,
        roomNameForStream(params.programId, params.streamId),
        expiry,
        now,
        now,
    );
    return publishSessionId;
}

describe('admin routes LiveKit room-service lifecycle', () => {
    beforeEach(async () => {
        await resetDb();
        await seedAdmin(testEnv);
    });

    it("kicks the translator's LiveKit room participant when revoking a single session with an active publisher", async () => {
        const cookie = await adminCookie();
        const roomService = fakeRoomService();
        const { programId, streamId, translatorId } = await seedProgramWithTranslatorAndStream(
            cookie,
            roomService as unknown as RoomServiceClient,
        );
        const sessionId = await createTranslatorSession({
            programId,
            translatorId,
        });
        await createPublishReservation({
            programId,
            streamId,
            translatorId,
            translatorSessionId: sessionId,
        });

        const response = await adminRoute(
            `/api/admin/programs/${programId}/translators/${translatorId}/sessions/${sessionId}`,
            { method: 'DELETE', headers: { Cookie: cookie } },
            roomService as unknown as RoomServiceClient,
        );

        expect(response.status).toBe(200);
        expect(roomService.removeParticipant).toHaveBeenCalledWith(
            roomNameForStream(programId, streamId),
            translatorIdentity(translatorId),
        );
    });

    it('does not kick when revoking a session with no active publisher', async () => {
        const cookie = await adminCookie();
        const roomService = fakeRoomService();
        const { programId, translatorId } = await seedProgramWithTranslatorAndStream(
            cookie,
            roomService as unknown as RoomServiceClient,
        );
        const sessionId = await createTranslatorSession({
            programId,
            translatorId,
        });

        const response = await adminRoute(
            `/api/admin/programs/${programId}/translators/${translatorId}/sessions/${sessionId}`,
            { method: 'DELETE', headers: { Cookie: cookie } },
            roomService as unknown as RoomServiceClient,
        );

        expect(response.status).toBe(200);
        expect(roomService.removeParticipant).not.toHaveBeenCalled();
    });

    it("kicks the translator's room participant for every freed stream when revoking all sessions", async () => {
        const cookie = await adminCookie();
        const roomService = fakeRoomService();
        const { programId, streamId, translatorId } = await seedProgramWithTranslatorAndStream(
            cookie,
            roomService as unknown as RoomServiceClient,
        );
        const sessionId = await createTranslatorSession({
            programId,
            translatorId,
        });
        await createPublishReservation({
            programId,
            streamId,
            translatorId,
            translatorSessionId: sessionId,
        });

        const response = await adminRoute(
            `/api/admin/programs/${programId}/translators/${translatorId}/sessions`,
            { method: 'DELETE', headers: { Cookie: cookie } },
            roomService as unknown as RoomServiceClient,
        );

        expect(response.status).toBe(200);
        expect(roomService.removeParticipant).toHaveBeenCalledWith(
            roomNameForStream(programId, streamId),
            translatorIdentity(translatorId),
        );
    });

    it("kicks the active publisher's room participant on kick-publisher", async () => {
        const cookie = await adminCookie();
        const roomService = fakeRoomService();
        const { programId, streamId, translatorId } = await seedProgramWithTranslatorAndStream(
            cookie,
            roomService as unknown as RoomServiceClient,
        );
        const sessionId = await createTranslatorSession({
            programId,
            translatorId,
        });
        await createPublishReservation({
            programId,
            streamId,
            translatorId,
            translatorSessionId: sessionId,
        });

        const response = await adminRoute(
            `/api/admin/programs/${programId}/streams/${streamId}/kick-publisher`,
            {
                method: 'POST',
                headers: { Cookie: cookie },
                body: JSON.stringify({ signOut: false }),
            },
            roomService as unknown as RoomServiceClient,
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ freed: true });
        expect(roomService.removeParticipant).toHaveBeenCalledWith(
            roomNameForStream(programId, streamId),
            translatorIdentity(translatorId),
        );
    });

    it('does not call removeParticipant when kick-publisher frees nothing', async () => {
        const cookie = await adminCookie();
        const roomService = fakeRoomService();
        const { programId, streamId } = await seedProgramWithTranslatorAndStream(
            cookie,
            roomService as unknown as RoomServiceClient,
        );

        const response = await adminRoute(
            `/api/admin/programs/${programId}/streams/${streamId}/kick-publisher`,
            { method: 'POST', headers: { Cookie: cookie } },
            roomService as unknown as RoomServiceClient,
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ freed: false });
        expect(roomService.removeParticipant).not.toHaveBeenCalled();
    });

    it("tears down the stream's room on stream delete", async () => {
        const cookie = await adminCookie();
        const roomService = fakeRoomService();
        const { programId, streamId } = await seedProgramWithTranslatorAndStream(
            cookie,
            roomService as unknown as RoomServiceClient,
        );

        const response = await adminRoute(
            `/api/admin/programs/${programId}/streams/${streamId}`,
            { method: 'DELETE', headers: { Cookie: cookie } },
            roomService as unknown as RoomServiceClient,
        );

        expect(response.status).toBe(204);
        expect(roomService.deleteRoom).toHaveBeenCalledWith(roomNameForStream(programId, streamId));
    });

    it('does not call the room service on stream create (implicit room creation)', async () => {
        const cookie = await adminCookie();
        const roomService = fakeRoomService();
        await seedProgramWithTranslatorAndStream(
            cookie,
            roomService as unknown as RoomServiceClient,
        );

        expect(roomService.deleteRoom).not.toHaveBeenCalled();
        expect(roomService.removeParticipant).not.toHaveBeenCalled();
    });

    it("tears down every stream's room when a live program is archived", async () => {
        const cookie = await adminCookie();
        const roomService = fakeRoomService();
        const { programId, streamId } = await seedProgramWithTranslatorAndStream(
            cookie,
            roomService as unknown as RoomServiceClient,
        );
        testEnv.DB.prepare(`UPDATE programs SET status = 'live' WHERE id = ?`).run(programId);

        const response = await adminRoute(
            `/api/admin/programs/${programId}/archive`,
            { method: 'POST', headers: { Cookie: cookie } },
            roomService as unknown as RoomServiceClient,
        );

        expect(response.status).toBe(200);
        expect(roomService.deleteRoom).toHaveBeenCalledWith(roomNameForStream(programId, streamId));
    });

    it("tears down every stream's room when a live program transitions to draft via PATCH", async () => {
        const cookie = await adminCookie();
        const roomService = fakeRoomService();
        const { programId, streamId } = await seedProgramWithTranslatorAndStream(
            cookie,
            roomService as unknown as RoomServiceClient,
        );
        testEnv.DB.prepare(`UPDATE programs SET status = 'live' WHERE id = ?`).run(programId);

        const response = await adminRoute(
            `/api/admin/programs/${programId}`,
            {
                method: 'PATCH',
                headers: { Cookie: cookie },
                body: JSON.stringify({ status: 'draft' }),
            },
            roomService as unknown as RoomServiceClient,
        );

        expect(response.status).toBe(200);
        expect(roomService.deleteRoom).toHaveBeenCalledWith(roomNameForStream(programId, streamId));
    });

    it('does not tear down rooms when PATCH does not leave the live status', async () => {
        const cookie = await adminCookie();
        const roomService = fakeRoomService();
        const { programId } = await seedProgramWithTranslatorAndStream(
            cookie,
            roomService as unknown as RoomServiceClient,
        );

        const response = await adminRoute(
            `/api/admin/programs/${programId}`,
            {
                method: 'PATCH',
                headers: { Cookie: cookie },
                body: JSON.stringify({ name: 'Renamed Event' }),
            },
            roomService as unknown as RoomServiceClient,
        );

        expect(response.status).toBe(200);
        expect(roomService.deleteRoom).not.toHaveBeenCalled();
    });

    it("tears down every stream's room when a live program is soft-deleted", async () => {
        const cookie = await adminCookie();
        const roomService = fakeRoomService();
        const { programId, streamId } = await seedProgramWithTranslatorAndStream(
            cookie,
            roomService as unknown as RoomServiceClient,
        );
        testEnv.DB.prepare(`UPDATE programs SET status = 'live' WHERE id = ?`).run(programId);

        const response = await adminRoute(
            `/api/admin/programs/${programId}`,
            { method: 'DELETE', headers: { Cookie: cookie } },
            roomService as unknown as RoomServiceClient,
        );

        expect(response.status).toBe(200);
        expect(roomService.deleteRoom).toHaveBeenCalledWith(roomNameForStream(programId, streamId));
    });

    it('does not call the room service on program restore (implicit room creation)', async () => {
        const cookie = await adminCookie();
        const roomService = fakeRoomService();
        const { programId } = await seedProgramWithTranslatorAndStream(
            cookie,
            roomService as unknown as RoomServiceClient,
        );
        testEnv.DB.prepare(`UPDATE programs SET status = 'live' WHERE id = ?`).run(programId);
        await adminRoute(
            `/api/admin/programs/${programId}`,
            { method: 'DELETE', headers: { Cookie: cookie } },
            roomService as unknown as RoomServiceClient,
        );
        roomService.deleteRoom.mockClear();

        const response = await adminRoute(
            `/api/admin/programs/${programId}/restore`,
            { method: 'POST', headers: { Cookie: cookie } },
            roomService as unknown as RoomServiceClient,
        );

        expect(response.status).toBe(200);
        expect(roomService.deleteRoom).not.toHaveBeenCalled();
    });

    it('swallows a rejecting removeParticipant call on kick-publisher and still succeeds', async () => {
        const cookie = await adminCookie();
        const roomService = fakeRoomService();
        roomService.removeParticipant.mockRejectedValue(new Error('room not found'));
        const { programId, streamId, translatorId } = await seedProgramWithTranslatorAndStream(
            cookie,
            roomService as unknown as RoomServiceClient,
        );
        const sessionId = await createTranslatorSession({
            programId,
            translatorId,
        });
        await createPublishReservation({
            programId,
            streamId,
            translatorId,
            translatorSessionId: sessionId,
        });

        const kick = await adminRoute(
            `/api/admin/programs/${programId}/streams/${streamId}/kick-publisher`,
            { method: 'POST', headers: { Cookie: cookie } },
            roomService as unknown as RoomServiceClient,
        );
        expect(kick.status).toBe(200);
        expect(await kick.json()).toEqual({ freed: true });
        expect(roomService.removeParticipant).toHaveBeenCalled();
    });

    it('swallows a rejecting deleteRoom call on stream delete and still succeeds', async () => {
        const cookie = await adminCookie();
        const roomService = fakeRoomService();
        roomService.deleteRoom.mockRejectedValue(new Error('room not found'));
        // A fresh stream with no publish history -- deleteStream() locks a
        // stream that has real stream_events/listener_connections history
        // (unrelated business rule, not a LiveKit concern), so this isolates
        // the deleteRoom-rejects-but-delete-still-succeeds behavior this test
        // actually cares about.
        const { programId, streamId } = await seedProgramWithTranslatorAndStream(
            cookie,
            roomService as unknown as RoomServiceClient,
        );

        const deleteStream = await adminRoute(
            `/api/admin/programs/${programId}/streams/${streamId}`,
            { method: 'DELETE', headers: { Cookie: cookie } },
            roomService as unknown as RoomServiceClient,
        );
        expect(deleteStream.status).toBe(204);
        expect(roomService.deleteRoom).toHaveBeenCalled();
    });
});
