import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackType, type RoomServiceClient, type WebhookReceiver } from 'livekit-server-sdk';

import { handleLiveKitWebhook } from '../src/livekit/webhook';
import { RealtimeStreamRepository } from '../src/db/realtimeStreamRepository';
import * as presenceStatus from '../src/presence/status';
import { buildTestEnv, testEnv } from './test-env';

// A duck-typed stand-in for the real (protobuf-generated) WebhookEvent --
// only the fields webhook.ts actually reads (event/participant.identity/
// participant.metadata/track.sid/track.type/room.name). Deliberately not
// `Partial<WebhookEvent>`: the real class's generated types fight
// `exactOptionalPropertyTypes` for no benefit here.
interface FakeWebhookEvent {
    event: string;
    participant?: { identity: string; metadata: string };
    track?: { sid: string; type: number };
    room?: { name: string };
}

// A duck-typed stand-in for RoomServiceClient, exercising only
// `getParticipant` -- the one method webhook.ts's fallback path calls when a
// track_* event's inline participant metadata is empty (see the real
// LiveKit-server behavior documented on `resolveParticipantMetadata`).
function fakeRoomService(
    getParticipant: (
        room: string,
        identity: string,
    ) => Promise<{ metadata: string; identity: string }>,
): RoomServiceClient {
    return {
        getParticipant: vi.fn().mockImplementation(getParticipant),
    } as unknown as RoomServiceClient;
}

// handleLiveKitWebhook takes its WebhookReceiver as an injectable parameter
// (defaulting to a real one built from `env`) specifically so these tests
// can hand it a fake directly, rather than `vi.mock`-ing livekit/client.ts --
// that doesn't work here, because test-env.ts's own import of src/index.ts
// (itself needed by nearly every test file, including this one, for
// buildTestEnv/testEnv) transitively instantiates the real module graph
// during Vitest's setupFiles phase, before a per-test-file `vi.mock` call
// could ever intercept it. See the DI comment on handleLiveKitWebhook itself.
function fakeReceiver(result: { event: FakeWebhookEvent } | { error: unknown }): WebhookReceiver {
    return {
        receive: vi.fn().mockImplementation(async () => {
            if ('error' in result) {
                throw result.error;
            }
            return result.event;
        }),
    } as unknown as WebhookReceiver;
}

async function postWebhook(
    receiver: WebhookReceiver,
    body = '{}',
    roomService?: RoomServiceClient,
): Promise<Response> {
    return handleLiveKitWebhook(
        new Request('https://bhasha.test/api/livekit/webhook', {
            method: 'POST',
            headers: { authorization: 'Bearer fake' },
            body,
        }),
        buildTestEnv(),
        receiver,
        ...(roomService ? [roomService] : []),
    );
}

function translatorMetadata(
    overrides: Partial<{
        programId: string;
        streamId: string;
        translatorId: string;
        publishSessionId: string;
    }> = {},
): string {
    return JSON.stringify({
        role: 'translator',
        programId: 'program_1',
        streamId: 'stream_1',
        translatorId: 'translator_1',
        publishSessionId: 'publish_1',
        ...overrides,
    });
}

function listenerMetadata(
    overrides: Partial<{
        programId: string;
        streamId: string;
        connectionId: string;
    }> = {},
): string {
    return JSON.stringify({
        role: 'listener',
        programId: 'program_1',
        streamId: 'stream_1',
        connectionId: 'connection_1',
        ...overrides,
    });
}

// Seeds a "reserved" reservation with a room name already attached (the
// state POST /api/translator/realtime/token leaves things in -- see
// routes/translator.ts's handleTranslatorRealtimeToken).
async function seedReservedPublisher(input: {
    programId: string;
    streamId: string;
    translatorId: string;
    publishSessionId: string;
}): Promise<void> {
    const now = new Date().toISOString();
    testEnv.DB.prepare(
        `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, 'Webhook Test', 'Hall', '2026-08-01', 'live', '', ?, ?)`,
    ).run(input.programId, `slug_${input.programId}`, now, now);
    testEnv.DB.prepare(
        `INSERT INTO language_streams
    (id, program_id, language_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, 'Hindi', 'hi', 1, 1, 0, NULL, NULL, ?, ?)`,
    ).run(input.streamId, input.programId, now, now);
    testEnv.DB.prepare(
        `INSERT INTO translators
    (id, program_id, name, password_hash, created_at, updated_at)
    VALUES (?, ?, 'Translator', 'sha256:unused', ?, ?)`,
    ).run(input.translatorId, input.programId, now, now);
    testEnv.DB.prepare(
        `INSERT INTO realtime_publish_sessions
    (id, program_id, language_stream_id, translator_id, cloudflare_session_id,
     state, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
    ).run(
        input.publishSessionId,
        input.programId,
        input.streamId,
        input.translatorId,
        `program-${input.programId}-stream-${input.streamId}`,
        new Date(Date.now() + 60_000).toISOString(),
        now,
        now,
    );
}

async function publisherState(publishSessionId: string): Promise<string> {
    const row = testEnv.DB.prepare(`SELECT state FROM realtime_publish_sessions WHERE id = ?`).get(
        publishSessionId,
    ) as { state: string } | undefined;
    if (!row) {
        throw new Error('publisher row missing');
    }
    return row.state;
}

function resetDb(): void {
    testEnv.DB.exec('DELETE FROM listener_realtime_cleanup_targets');
    testEnv.DB.exec('DELETE FROM stream_events');
    testEnv.DB.exec('DELETE FROM listener_connections');
    testEnv.DB.exec('DELETE FROM realtime_publish_sessions');
    testEnv.DB.exec('DELETE FROM translator_sessions');
    testEnv.DB.exec('DELETE FROM translator_stream_assignments');
    testEnv.DB.exec('DELETE FROM translators');
    testEnv.DB.exec('DELETE FROM language_streams');
    testEnv.DB.exec('DELETE FROM programs');
}

describe('handleLiveKitWebhook', () => {
    beforeEach(() => {
        resetDb();
        presenceStatus.__resetPresenceForTests();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns 401 when the webhook signature is rejected', async () => {
        const response = await postWebhook(fakeReceiver({ error: new Error('invalid signature') }));

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
            error: 'invalid_webhook_signature',
        });
    });

    it('joins presence for a listener participant_joined event', async () => {
        const response = await postWebhook(
            fakeReceiver({
                event: {
                    event: 'participant_joined',
                    participant: {
                        identity: 'listener:connection_1',
                        metadata: listenerMetadata({ programId: 'program_join' }),
                    },
                },
            }),
        );

        expect(response.status).toBe(200);
        const snapshot = await presenceStatus.readPresenceStatusSnapshot(
            buildTestEnv(),
            'program_join',
        );
        expect(snapshot.total).toBe(1);
        expect(snapshot.streams.stream_1).toBe(1);
    });

    it('does not touch presence for a translator participant_joined event', async () => {
        const joinSpy = vi.spyOn(presenceStatus, 'presenceJoin');

        const response = await postWebhook(
            fakeReceiver({
                event: {
                    event: 'participant_joined',
                    participant: {
                        identity: 'translator:translator_1',
                        metadata: translatorMetadata(),
                    },
                },
            }),
        );

        expect(response.status).toBe(200);
        expect(joinSpy).not.toHaveBeenCalled();
    });

    it('ignores an event whose signed identity does not match its claimed metadata', async () => {
        // Defense-in-depth: identity is derived from the token's signed `sub`
        // claim (immutable post-connect, per the `canUpdateOwnMetadata` grant
        // left unset in tokens.ts) and should always agree with metadata's
        // claimed role/id. A mismatch is treated as untrustworthy and ignored
        // rather than acted on, regardless of which role it claims.
        const joinSpy = vi.spyOn(presenceStatus, 'presenceJoin');

        const response = await postWebhook(
            fakeReceiver({
                event: {
                    event: 'participant_joined',
                    participant: {
                        identity: 'listener:some-other-connection',
                        metadata: listenerMetadata({ connectionId: 'connection_1' }),
                    },
                },
            }),
        );

        expect(response.status).toBe(200);
        expect(joinSpy).not.toHaveBeenCalled();
    });

    it('leaves presence for a listener participant_left event', async () => {
        presenceStatus.presenceJoin('program_leave', 'connection_1', 'stream_1');

        const response = await postWebhook(
            fakeReceiver({
                event: {
                    event: 'participant_left',
                    participant: {
                        identity: 'listener:connection_1',
                        metadata: listenerMetadata({ programId: 'program_leave' }),
                    },
                },
            }),
        );

        expect(response.status).toBe(200);
        const snapshot = await presenceStatus.readPresenceStatusSnapshot(
            buildTestEnv(),
            'program_leave',
        );
        expect(snapshot.total).toBe(0);
    });

    it('closes the publisher reservation on a translator participant_left event', async () => {
        await seedReservedPublisher({
            programId: 'program_2',
            streamId: 'stream_2',
            translatorId: 'translator_2',
            publishSessionId: 'publish_2',
        });

        const response = await postWebhook(
            fakeReceiver({
                event: {
                    event: 'participant_left',
                    participant: {
                        identity: 'translator:translator_2',
                        metadata: translatorMetadata({
                            programId: 'program_2',
                            streamId: 'stream_2',
                            translatorId: 'translator_2',
                            publishSessionId: 'publish_2',
                        }),
                    },
                },
            }),
        );

        expect(response.status).toBe(200);
        expect(await publisherState('publish_2')).toBe('closed');
    });

    it('is idempotent when the reservation is already closed', async () => {
        await seedReservedPublisher({
            programId: 'program_3',
            streamId: 'stream_3',
            translatorId: 'translator_3',
            publishSessionId: 'publish_3',
        });
        const realtime = new RealtimeStreamRepository(testEnv.DB);
        await realtime.clearPublisher({
            publishSessionId: 'publish_3',
            translatorId: 'translator_3',
            streamId: 'stream_3',
            cleanupFailed: false,
        });

        const response = await postWebhook(
            fakeReceiver({
                event: {
                    event: 'participant_left',
                    participant: {
                        identity: 'translator:translator_3',
                        metadata: translatorMetadata({
                            programId: 'program_3',
                            streamId: 'stream_3',
                            translatorId: 'translator_3',
                            publishSessionId: 'publish_3',
                        }),
                    },
                },
            }),
        );

        // Never surfaces PublisherReservationNotFoundError/already-closed as a
        // webhook failure -- benign, logged at info level, response still ok.
        expect(response.status).toBe(200);
        expect(await publisherState('publish_3')).toBe('closed');
    });

    it('confirms an audio track_published event as a live publisher', async () => {
        await seedReservedPublisher({
            programId: 'program_4',
            streamId: 'stream_4',
            translatorId: 'translator_4',
            publishSessionId: 'publish_4',
        });

        const response = await postWebhook(
            fakeReceiver({
                event: {
                    event: 'track_published',
                    participant: {
                        identity: 'translator:translator_4',
                        metadata: translatorMetadata({
                            programId: 'program_4',
                            streamId: 'stream_4',
                            translatorId: 'translator_4',
                            publishSessionId: 'publish_4',
                        }),
                    },
                    track: { sid: 'TR_audio1', type: TrackType.AUDIO },
                },
            }),
        );

        expect(response.status).toBe(200);
        expect(await publisherState('publish_4')).toBe('published');
    });

    it("confirms track_published via a RoomServiceClient refetch when LiveKit's inline participant metadata is empty", async () => {
        // Regression test for a real behavior discovered by testing against a
        // live LiveKit server (not just this suite's own fixtures): LiveKit's
        // track_published/track_unpublished webhook payloads carry a PARTIAL
        // participant snapshot with metadata always empty (confirmed empirically
        // -- participant_joined/participant_left DO carry full metadata, track_*
        // events do not). Every other test in this file supplies inline
        // metadata on a track_* event, which is NOT what a real LiveKit server
        // sends -- this is the one that matches reality and would have caught
        // the original bug (a stream could never leave "reserved"/"offline" via
        // a real webhook).
        await seedReservedPublisher({
            programId: 'program_4b',
            streamId: 'stream_4b',
            translatorId: 'translator_4b',
            publishSessionId: 'publish_4b',
        });
        const roomService = fakeRoomService(async (room, identity) => {
            expect(room).toBe('program-program_4b-stream-stream_4b');
            expect(identity).toBe('translator:translator_4b');
            return {
                identity,
                metadata: translatorMetadata({
                    programId: 'program_4b',
                    streamId: 'stream_4b',
                    translatorId: 'translator_4b',
                    publishSessionId: 'publish_4b',
                }),
            };
        });

        const response = await postWebhook(
            fakeReceiver({
                event: {
                    event: 'track_published',
                    room: { name: 'program-program_4b-stream-stream_4b' },
                    participant: { identity: 'translator:translator_4b', metadata: '' },
                    track: { sid: 'TR_audio1', type: TrackType.AUDIO },
                },
            }),
            '{}',
            roomService,
        );

        expect(response.status).toBe(200);
        expect(await publisherState('publish_4b')).toBe('published');
    });

    it('does not refetch via RoomServiceClient when inline metadata is present but invalid', async () => {
        // A present-but-malformed/mismatched inline metadata is a different,
        // already-logged failure mode -- refetching would just return the same
        // rejected value, so the fallback must not fire here.
        await seedReservedPublisher({
            programId: 'program_4c',
            streamId: 'stream_4c',
            translatorId: 'translator_4c',
            publishSessionId: 'publish_4c',
        });
        const getParticipant = vi.fn();
        const roomService = fakeRoomService(getParticipant);

        const response = await postWebhook(
            fakeReceiver({
                event: {
                    event: 'track_published',
                    room: { name: 'program-program_4c-stream-stream_4c' },
                    participant: {
                        identity: 'translator:translator_4c',
                        metadata: 'not-json{',
                    },
                    track: { sid: 'TR_audio1', type: TrackType.AUDIO },
                },
            }),
            '{}',
            roomService,
        );

        expect(response.status).toBe(200);
        expect(getParticipant).not.toHaveBeenCalled();
        expect(await publisherState('publish_4c')).toBe('reserved');
    });

    it('no-ops without throwing when the RoomServiceClient refetch itself fails', async () => {
        // E.g. the participant already left by the time this webhook is
        // processed -- LiveKit's getParticipant rejects. Must not surface as a
        // webhook failure, and must leave the reservation exactly as-is.
        await seedReservedPublisher({
            programId: 'program_4d',
            streamId: 'stream_4d',
            translatorId: 'translator_4d',
            publishSessionId: 'publish_4d',
        });
        const roomService = fakeRoomService(async () => {
            throw new Error('participant not found');
        });

        const response = await postWebhook(
            fakeReceiver({
                event: {
                    event: 'track_published',
                    room: { name: 'program-program_4d-stream-stream_4d' },
                    participant: { identity: 'translator:translator_4d', metadata: '' },
                    track: { sid: 'TR_audio1', type: TrackType.AUDIO },
                },
            }),
            '{}',
            roomService,
        );

        expect(response.status).toBe(200);
        expect(await publisherState('publish_4d')).toBe('reserved');
    });

    it('ignores a non-audio track_published event', async () => {
        await seedReservedPublisher({
            programId: 'program_5',
            streamId: 'stream_5',
            translatorId: 'translator_5',
            publishSessionId: 'publish_5',
        });

        const response = await postWebhook(
            fakeReceiver({
                event: {
                    event: 'track_published',
                    participant: {
                        identity: 'translator:translator_5',
                        metadata: translatorMetadata({
                            programId: 'program_5',
                            streamId: 'stream_5',
                            translatorId: 'translator_5',
                            publishSessionId: 'publish_5',
                        }),
                    },
                    track: { sid: 'TR_video1', type: TrackType.VIDEO },
                },
            }),
        );

        expect(response.status).toBe(200);
        expect(await publisherState('publish_5')).toBe('reserved');
    });

    it('ignores track_published for a listener participant', async () => {
        // No reservation exists at all -- this must not throw despite the
        // metadata not matching a translator shape.
        const response = await postWebhook(
            fakeReceiver({
                event: {
                    event: 'track_published',
                    participant: {
                        identity: 'listener:connection_1',
                        metadata: listenerMetadata(),
                    },
                    track: { sid: 'TR_audio1', type: TrackType.AUDIO },
                },
            }),
        );

        expect(response.status).toBe(200);
    });

    it('closes the publisher reservation on an audio track_unpublished event, independent of participant_left', async () => {
        await seedReservedPublisher({
            programId: 'program_6',
            streamId: 'stream_6',
            translatorId: 'translator_6',
            publishSessionId: 'publish_6',
        });
        const realtime = new RealtimeStreamRepository(testEnv.DB);
        await realtime.markPublisherTrackLive({
            publishSessionId: 'publish_6',
            translatorId: 'translator_6',
            streamId: 'stream_6',
            trackName: 'TR_audio1',
            trackMid: 'livekit',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        expect(await publisherState('publish_6')).toBe('published');

        const response = await postWebhook(
            fakeReceiver({
                event: {
                    event: 'track_unpublished',
                    participant: {
                        identity: 'translator:translator_6',
                        metadata: translatorMetadata({
                            programId: 'program_6',
                            streamId: 'stream_6',
                            translatorId: 'translator_6',
                            publishSessionId: 'publish_6',
                        }),
                    },
                    track: { sid: 'TR_audio1', type: TrackType.AUDIO },
                },
            }),
        );

        expect(response.status).toBe(200);
        expect(await publisherState('publish_6')).toBe('closed');
    });

    it('no-ops on malformed participant metadata without throwing', async () => {
        const response = await postWebhook(
            fakeReceiver({
                event: {
                    event: 'participant_joined',
                    participant: {
                        identity: 'listener:x',
                        metadata: 'not-json{',
                    },
                },
            }),
        );

        expect(response.status).toBe(200);
    });

    it('no-ops on metadata missing a recognized role without throwing', async () => {
        const response = await postWebhook(
            fakeReceiver({
                event: {
                    event: 'participant_joined',
                    participant: {
                        identity: 'mystery:x',
                        metadata: JSON.stringify({ role: 'unknown' }),
                    },
                },
            }),
        );

        expect(response.status).toBe(200);
    });

    it('no-ops on an unrecognized event type', async () => {
        const response = await postWebhook(fakeReceiver({ event: { event: 'room_started' } }));

        expect(response.status).toBe(200);
    });

    it('swallows a dispatch-time presence error and still responds ok', async () => {
        vi.spyOn(presenceStatus, 'presenceJoin').mockImplementationOnce(() => {
            throw new Error('presence unavailable');
        });

        const response = await postWebhook(
            fakeReceiver({
                event: {
                    event: 'participant_joined',
                    participant: {
                        identity: 'listener:connection_err',
                        metadata: listenerMetadata({ programId: 'program_err' }),
                    },
                },
            }),
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
    });
});
