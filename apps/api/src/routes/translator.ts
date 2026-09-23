import {
    requireTranslatorSession,
    clearTranslatorSessionCookie,
    translatorSessionCookie,
} from '../auth/translatorAuth';
import {
    PublisherOwnershipError,
    PublisherReservationNotFoundError,
    RealtimeStreamRepository,
    StreamAlreadyPublishedError,
} from '../db/realtimeStreamRepository';
import { ProgramNotFoundError, ProgramRepository } from '../db/programRepository';
import { parseEmail } from '../domain/programs';
import {
    TranslatorRepository,
    TranslatorStreamAssignmentNotFoundError,
} from '../db/translatorRepository';
import type { Env } from '../env';
import { json, readJson, type WaitUntilCtx } from '../http';
import {
    isLiveKitConfigured,
    createRoomServiceClient,
    removeParticipantBestEffort,
} from '../livekit/client';
import { mintTranslatorToken, roomNameForStream, translatorIdentity } from '../livekit/tokens';
import { reportAudioActivity } from '../presence/status';
import { ProgramReferenceMismatchError, resolveBrowserProgramReference } from './programResolution';
import type { RoomServiceClient } from 'livekit-server-sdk';

interface TranslatorLoginInput {
    programId?: string;
    programSlug?: string;
    email: string;
    password: string;
}

interface TranslatorRealtimeTokenInput {
    streamId: string;
    reclaim: boolean;
}

interface TranslatorRealtimeStopInput {
    streamId: string;
    publishSessionId: string;
}

interface TranslatorRealtimeAudioActivityInput {
    streamId: string;
    publishSessionId: string;
    active: boolean;
}

interface TranslatorRealtimeHeartbeatInput {
    streamId: string;
    publishSessionId: string;
}

export async function handleTranslatorRoutes(
    request: Request,
    env: Env,
    url: URL,
    ctx: WaitUntilCtx,
    // Defaults to a real RoomServiceClient built from `env`; tests inject a
    // fake directly (see the DI note on handleLiveKitWebhook in
    // livekit/webhook.ts for why -- the same setupFile-eager-import problem
    // rules out `vi.mock` here).
    roomService: RoomServiceClient = createRoomServiceClient(env),
): Promise<Response | null> {
    const translators = new TranslatorRepository(env.DB);
    const programs = new ProgramRepository(env.DB);

    if (request.method === 'POST' && url.pathname === '/api/translator/login') {
        const input = await parseLoginInput(request);
        if (input instanceof Response) {
            return translatorLoginResponse(input);
        }
        if (!input) {
            return translatorLoginResponse(invalidCredentials());
        }

        try {
            const resolvedProgram = await resolveTranslatorLoginProgram(programs, input);
            if (!resolvedProgram) {
                return translatorLoginResponse(programNotFound());
            }

            const translator = await translators.authenticate(
                resolvedProgram.programId,
                input.email,
                input.password,
                env.TRANSLATOR_PASSWORD_PEPPER,
            );
            if (!translator) {
                return translatorLoginResponse(invalidCredentials());
            }

            const userAgent = request.headers.get('User-Agent')?.slice(0, 512) ?? null;

            const { token } = await translators.createSession(
                translator.programId,
                translator.id,
                env.TRANSLATOR_SESSION_SECRET,
                userAgent,
            );
            const assignedStreams = await translators.listAssignedStreams(
                translator.programId,
                translator.id,
            );
            const response = json({
                ok: true,
                translator,
                assignedStreams,
            });
            response.headers.set('set-cookie', translatorSessionCookie(token));
            return translatorLoginResponse(response);
        } catch (_error) {
            return translatorLoginResponse(json({ error: 'database_error' }, { status: 500 }));
        }
    }

    if (request.method === 'GET' && url.pathname === '/api/translator/session') {
        try {
            const auth = await requireTranslatorSession(request, env, translators);
            if (auth instanceof Response) {
                return translatorSessionResponse(auth);
            }

            return translatorSessionResponse(
                json({
                    translator: auth.translator,
                    assignedStreams: auth.assignedStreams,
                }),
            );
        } catch (_error) {
            return translatorSessionResponse(json({ error: 'database_error' }, { status: 500 }));
        }
    }

    if (request.method === 'POST' && url.pathname === '/api/translator/realtime/token') {
        return handleTranslatorRealtimeToken(request, env, translators);
    }

    if (request.method === 'POST' && url.pathname === '/api/translator/realtime/stop') {
        return handleTranslatorRealtimeStop(request, env, translators, roomService);
    }

    if (request.method === 'POST' && url.pathname === '/api/translator/realtime/audio-activity') {
        return handleTranslatorRealtimeAudioActivity(request, env, translators);
    }

    if (request.method === 'POST' && url.pathname === '/api/translator/realtime/heartbeat') {
        return handleTranslatorRealtimeHeartbeat(request, env, translators);
    }

    if (request.method === 'POST' && url.pathname === '/api/translator/logout') {
        return handleTranslatorLogout(request, env, translators, roomService, ctx);
    }

    return null;
}

async function handleTranslatorLogout(
    request: Request,
    env: Env,
    translators: TranslatorRepository,
    roomService: RoomServiceClient,
    _ctx: WaitUntilCtx,
): Promise<Response> {
    try {
        const auth = await requireTranslatorSession(request, env, translators);
        if (auth instanceof Response) {
            return translatorSessionResponse(auth);
        }

        const realtime = new RealtimeStreamRepository(env.DB);
        // Frees the DB publisher-reservation row (if any) for this session, then
        // best-effort kicks the translator's LiveKit room participant so a
        // lingering publish doesn't outlive the session that created it.
        const freed = await translators.revokeSession(
            realtime,
            auth.translator.programId,
            auth.translator.id,
            auth.session.id,
        );
        if (freed) {
            await removeParticipantBestEffort(
                roomService,
                roomNameForStream(auth.translator.programId, freed.streamId),
                translatorIdentity(auth.translator.id),
            );
        }

        const response = json({ ok: true });
        response.headers.set('set-cookie', clearTranslatorSessionCookie());
        return translatorSessionResponse(response);
    } catch (_error) {
        return translatorSessionResponse(json({ error: 'database_error' }, { status: 500 }));
    }
}

async function handleTranslatorRealtimeHeartbeat(
    request: Request,
    env: Env,
    translators: TranslatorRepository,
): Promise<Response> {
    const input = await parseRealtimeHeartbeatInput(request);
    if (input instanceof Response) {
        return translatorRealtimeResponse(input);
    }

    const realtime = new RealtimeStreamRepository(env.DB);
    try {
        const auth = await requireTranslatorSession(request, env, translators);
        if (auth instanceof Response) {
            return translatorRealtimeResponse(auth);
        }

        // Layered security mirrors the audio-activity path: valid translator
        // session, assigned stream, and an owned reservation for this stream.
        await translators.requireAssignedStream(
            auth.translator.programId,
            auth.translator.id,
            input.streamId,
        );

        // Confirm ownership (throws 404-mapped errors when the publish session is
        // unknown or belongs to another translator/stream) before the heartbeat.
        await realtime.requirePublisherReservation({
            publishSessionId: input.publishSessionId,
            translatorId: auth.translator.id,
            streamId: input.streamId,
        });

        const refreshed = await realtime.touchPublisher({
            publishSessionId: input.publishSessionId,
            translatorId: auth.translator.id,
            streamId: input.streamId,
            absoluteExpiresAt: auth.session.absoluteExpiresAt,
        });

        if (!refreshed) {
            // The publisher is no longer in the published state; tell the client to
            // stop heart-beating rather than retry indefinitely.
            return translatorRealtimeResponse(
                json({ error: 'publisher_not_active' }, { status: 409 }),
            );
        }

        return translatorRealtimeResponse(json({ ok: true }));
    } catch (error) {
        return translatorRealtimeResponse(translatorRealtimeErrorResponse(error));
    }
}

async function handleTranslatorRealtimeAudioActivity(
    request: Request,
    env: Env,
    translators: TranslatorRepository,
): Promise<Response> {
    const input = await parseRealtimeAudioActivityInput(request);
    if (input instanceof Response) {
        return translatorRealtimeResponse(input);
    }

    const realtime = new RealtimeStreamRepository(env.DB);
    try {
        const auth = await requireTranslatorSession(request, env, translators);
        if (auth instanceof Response) {
            return translatorRealtimeResponse(auth);
        }

        // Layered security: valid translator session, assigned stream, and an owned
        // active published reservation matching the publishSessionId.
        await translators.requireAssignedStream(
            auth.translator.programId,
            auth.translator.id,
            input.streamId,
        );

        const reservation = await realtime.requirePublisherReservation({
            publishSessionId: input.publishSessionId,
            translatorId: auth.translator.id,
            streamId: input.streamId,
        });
        if (reservation.state !== 'published') {
            throw new PublisherReservationNotFoundError();
        }

        // TODO(follow-up, not slice-3): audio-activity is currently self-reported
        // by the translator's browser mic meter (measures local mic level, not
        // what actually reaches LiveKit). A more robust signal would be
        // LiveKit-native audio-energy detection, but it's unconfirmed whether
        // LiveKit exposes this via a stateless webhook (like
        // participant_joined/track_published) or only via a live room connection
        // (client RoomEvent, or a server-side agent joining the room) -- verify
        // against current LiveKit docs before switching. Revisit only if the
        // self-reported signal proves unreliable in practice.
        await reportAudioActivity(env, auth.translator.programId, {
            streamId: input.streamId,
            publishSessionId: input.publishSessionId,
            active: input.active,
        });

        return translatorRealtimeResponse(
            json({ ok: true, state: input.active ? 'live' : 'silent' }),
        );
    } catch (error) {
        return translatorRealtimeResponse(translatorRealtimeErrorResponse(error));
    }
}

// Single LiveKit endpoint replacing the old three-step SFU handshake
// (`/session` + `/publish` + `/track`). Keeps every piece of generic
// bookkeeping the old `/session` did BEFORE talking to the SFU
// (translator-session auth, assigned-stream check, and reserving the
// single-publisher-per-stream slot in `realtime_publish_sessions`), then --
// exactly where the old code would have created an SFU session -- attaches
// the reservation to this stream's deterministic LiveKit room name (there is
// no separate "create SFU session" round-trip with LiveKit; the room name is
// a pure function of programId+streamId) and mints a publish-only token.
// `track_published`'s webhook (see livekit/webhook.ts) is what later flips
// the reservation to "published" once audio is actually flowing -- this
// endpoint only gets it to "reserved, room known".
async function handleTranslatorRealtimeToken(
    request: Request,
    env: Env,
    translators: TranslatorRepository,
): Promise<Response> {
    const input = await parseRealtimeTokenInput(request);
    if (input instanceof Response) {
        return translatorRealtimeResponse(input);
    }

    if (!isLiveKitConfigured(env)) {
        return translatorRealtimeResponse(
            json({ error: 'realtime_not_configured' }, { status: 503 }),
        );
    }

    const realtime = new RealtimeStreamRepository(env.DB);
    try {
        const auth = await requireTranslatorSession(request, env, translators);
        if (auth instanceof Response) {
            return translatorRealtimeResponse(auth);
        }

        await translators.requireAssignedStream(
            auth.translator.programId,
            auth.translator.id,
            input.streamId,
        );

        const reservation = await reservePublisherForTranslator({
            realtime,
            programId: auth.translator.programId,
            streamId: input.streamId,
            translatorId: auth.translator.id,
            sessionId: auth.session.id,
            reclaim: input.reclaim,
        });

        const roomName = roomNameForStream(auth.translator.programId, input.streamId);
        // There is no separate SFU-session-creation step with LiveKit -- the
        // room name is known up front, so attach it to the reservation right
        // away rather than waiting for a round-trip the way the old
        // Cloudflare-Realtime flow needed. markPublisherTrackLive's guard (state
        // = 'reserved' AND cloudflare_session_id IS NOT NULL) requires this
        // column to be set before the track_published webhook can flip the
        // reservation to "published".
        await realtime.attachPublisherSession({
            publishSessionId: reservation.id,
            translatorId: auth.translator.id,
            streamId: input.streamId,
            cloudflareSessionId: roomName,
        });

        const minted = await mintTranslatorToken(env, {
            translatorId: auth.translator.id,
            publishSessionId: reservation.id,
            programId: auth.translator.programId,
            streamId: input.streamId,
        });

        return translatorRealtimeResponse(
            json({
                publishSessionId: reservation.id,
                token: minted.token,
                url: minted.url,
                roomName: minted.roomName,
            }),
        );
    } catch (error) {
        return translatorRealtimeResponse(translatorRealtimeErrorResponse(error));
    }
}

async function reservePublisherForTranslator(input: {
    realtime: RealtimeStreamRepository;
    programId: string;
    streamId: string;
    translatorId: string;
    sessionId: string;
    reclaim: boolean;
}) {
    try {
        return await input.realtime.reservePublisher({
            programId: input.programId,
            streamId: input.streamId,
            translatorId: input.translatorId,
            sessionId: input.sessionId,
        });
    } catch (error) {
        if (!(error instanceof StreamAlreadyPublishedError) || !input.reclaim) {
            throw error;
        }

        const blocking = await input.realtime.getBlockingPublisher(input.programId, input.streamId);
        if (!blocking || blocking.translatorId !== input.translatorId) {
            throw error;
        }

        // No LiveKit removeParticipant call here -- the reclaiming translator is
        // the same identity (`translator:${translatorId}`) that will immediately
        // re-mint a token for the same room, so there's no stray participant to
        // kick; just free the DB reservation the old session held so a reclaim
        // can proceed.
        await input.realtime.clearPublisher({
            publishSessionId: blocking.id,
            translatorId: blocking.translatorId,
            streamId: blocking.streamId,
            cleanupFailed: false,
        });

        return input.realtime.reservePublisher({
            programId: input.programId,
            streamId: input.streamId,
            translatorId: input.translatorId,
            sessionId: input.sessionId,
        });
    }
}

async function handleTranslatorRealtimeStop(
    request: Request,
    env: Env,
    translators: TranslatorRepository,
    roomService: RoomServiceClient,
): Promise<Response> {
    const input = await parseRealtimeStopInput(request);
    if (input instanceof Response) {
        return translatorRealtimeResponse(input);
    }

    const realtime = new RealtimeStreamRepository(env.DB);
    try {
        const auth = await requireTranslatorSession(request, env, translators);
        if (auth instanceof Response) {
            return translatorRealtimeResponse(auth);
        }

        await translators.requireAssignedStream(
            auth.translator.programId,
            auth.translator.id,
            input.streamId,
        );

        // Ownership check only (kept for the same 404-mapped error contract).
        await realtime.requirePublisherReservation({
            publishSessionId: input.publishSessionId,
            translatorId: auth.translator.id,
            streamId: input.streamId,
        });

        await removeParticipantBestEffort(
            roomService,
            roomNameForStream(auth.translator.programId, input.streamId),
            translatorIdentity(auth.translator.id),
        );

        await realtime.clearPublisher({
            publishSessionId: input.publishSessionId,
            translatorId: auth.translator.id,
            streamId: input.streamId,
            cleanupFailed: false,
        });

        return translatorRealtimeResponse(json({ ok: true, cleanup: 'closed' }));
    } catch (error) {
        return translatorRealtimeResponse(translatorRealtimeErrorResponse(error));
    }
}

async function parseLoginInput(request: Request): Promise<TranslatorLoginInput | Response | null> {
    let body: unknown;
    try {
        body = await readJson(request);
    } catch (_error) {
        return json({ error: 'invalid_json' }, { status: 400 });
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }

    const programId = readTrimmedString(body, 'programId');
    const programSlug = readTrimmedString(body, 'programSlug');
    const email = readLoginEmail(body);
    const password = readPassword(body);
    if ((!programId && !programSlug) || !email || !password) {
        return null;
    }

    return {
        ...(programId ? { programId } : {}),
        ...(programSlug ? { programSlug } : {}),
        email,
        password,
    };
}

// Login normalizes the email through the same parseEmail used at create time so
// casing/trimming can never diverge. A malformed email is not a 400 on login;
// it simply falls through to invalid_translator_credentials.
function readLoginEmail(body: object): string | null {
    const value = (body as Record<string, unknown>).email;
    try {
        return parseEmail(value);
    } catch (_error) {
        return null;
    }
}

async function resolveTranslatorLoginProgram(
    programs: ProgramRepository,
    input: TranslatorLoginInput,
): Promise<{ programId: string } | null> {
    try {
        return await resolveBrowserProgramReference(programs, input);
    } catch (error) {
        if (
            error instanceof ProgramNotFoundError ||
            error instanceof ProgramReferenceMismatchError
        ) {
            return null;
        }
        throw error;
    }
}

async function parseRealtimeTokenInput(
    request: Request,
): Promise<TranslatorRealtimeTokenInput | Response> {
    const body = await readRequestObject(request);
    if (body instanceof Response) {
        return body;
    }

    const streamId = readTrimmedString(body, 'streamId');
    if (!streamId) {
        return invalidRealtimeRequest();
    }

    return { streamId, reclaim: body.reclaim === true };
}

async function parseRealtimeStopInput(
    request: Request,
): Promise<TranslatorRealtimeStopInput | Response> {
    const body = await readRequestObject(request);
    if (body instanceof Response) {
        return body;
    }

    const streamId = readTrimmedString(body, 'streamId');
    const publishSessionId = readTrimmedString(body, 'publishSessionId');
    if (!streamId || !publishSessionId) {
        return invalidRealtimeRequest();
    }

    return { streamId, publishSessionId };
}

async function parseRealtimeAudioActivityInput(
    request: Request,
): Promise<TranslatorRealtimeAudioActivityInput | Response> {
    const body = await readRequestObject(request);
    if (body instanceof Response) {
        return body;
    }

    const streamId = readTrimmedString(body, 'streamId');
    const publishSessionId = readTrimmedString(body, 'publishSessionId');
    const active = body.active;
    if (!streamId || !publishSessionId || typeof active !== 'boolean') {
        return invalidRealtimeRequest();
    }

    return { streamId, publishSessionId, active };
}

async function parseRealtimeHeartbeatInput(
    request: Request,
): Promise<TranslatorRealtimeHeartbeatInput | Response> {
    const body = await readRequestObject(request);
    if (body instanceof Response) {
        return body;
    }

    const streamId = readTrimmedString(body, 'streamId');
    const publishSessionId = readTrimmedString(body, 'publishSessionId');
    if (!streamId || !publishSessionId) {
        return invalidRealtimeRequest();
    }

    return { streamId, publishSessionId };
}

async function readRequestObject(request: Request): Promise<Record<string, unknown> | Response> {
    let body: unknown;
    try {
        body = await readJson(request);
    } catch (_error) {
        return json({ error: 'invalid_json' }, { status: 400 });
    }

    if (!isRecord(body)) {
        return invalidRealtimeRequest();
    }

    return body;
}

function readTrimmedString(body: object, key: string): string | null {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readPassword(body: object): string | null {
    const value = (body as Record<string, unknown>).password;
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidCredentials(): Response {
    return json({ error: 'invalid_translator_credentials' }, { status: 401 });
}

function programNotFound(): Response {
    return json({ error: 'program_not_found' }, { status: 404 });
}

function invalidRealtimeRequest(): Response {
    return json({ error: 'invalid_request' }, { status: 400 });
}

function translatorRealtimeErrorResponse(error: unknown): Response {
    if (error instanceof TranslatorStreamAssignmentNotFoundError) {
        return json({ error: 'stream_not_assigned' }, { status: 403 });
    }

    if (error instanceof StreamAlreadyPublishedError) {
        return json({ error: 'stream_already_published' }, { status: 409 });
    }

    if (
        error instanceof PublisherReservationNotFoundError ||
        error instanceof PublisherOwnershipError
    ) {
        return json({ error: 'publisher_session_not_found' }, { status: 404 });
    }

    return json({ error: 'database_error' }, { status: 500 });
}

function translatorLoginResponse(response: Response): Response {
    response.headers.set('cache-control', 'no-store');
    return response;
}

function translatorSessionResponse(response: Response): Response {
    response.headers.set('cache-control', 'no-store');
    response.headers.set('vary', 'Cookie');
    return response;
}

function translatorRealtimeResponse(response: Response): Response {
    response.headers.set('cache-control', 'no-store');
    response.headers.set('vary', 'Cookie');
    return response;
}
