import { requireUserAuth } from '../auth/adminAuth';
import { requireProgramAccess } from '../auth/programAccess';
import { requireTranslatorSession } from '../auth/translatorAuth';
import { ProgramRepository } from '../db/programRepository';
import type { Env } from '../env';
import { json } from '../http';
import { isEnglish, type TranscriptEvent, type TranscriptHub } from '../transcript/hub';
import { SCRIBE_MODEL_ID, type ScribeTokenMinter } from '../transcript/scribeToken';

export interface TranscriptDeps {
    hub: TranscriptHub;
    // Undefined when ELEVENLABS_API_KEY is not configured: transcription is then switched off.
    mintScribeToken: ScribeTokenMinter | undefined;
}

const MAX_TEXT_LENGTH = 2000;
const KEEPALIVE_MS = 20_000;

// The audio is captured and sent to ElevenLabs by the browser, in this format.
const SCRIBE_SESSION = {
    modelId: SCRIBE_MODEL_ID,
    sampleRate: 16_000,
    audioFormat: 'pcm_16000',
    commitStrategy: 'vad',
    vadSilenceThresholdSecs: 0.8,
    languageCode: 'en',
} as const;

const ADMIN_PATH = /^\/api\/admin\/transcript\/([^/]+)\/(session|events)$/;
const TRANSLATOR_PATH = '/api/translator/transcript/stream';

export async function handleTranscriptRoutes(
    request: Request,
    env: Env,
    url: URL,
    deps: TranscriptDeps,
): Promise<Response | null> {
    const adminMatch = url.pathname.match(ADMIN_PATH);
    if (adminMatch && request.method === 'POST') {
        const [, rawSlug, action] = adminMatch;
        return handleSourceConsole(request, env, deps, decodeURIComponent(rawSlug ?? ''), action);
    }
    if (request.method === 'GET' && url.pathname === TRANSLATOR_PATH) {
        return handleTranslatorStream(request, env, url, deps);
    }
    return null;
}

async function handleSourceConsole(
    request: Request,
    env: Env,
    deps: TranscriptDeps,
    slug: string,
    action: string | undefined,
): Promise<Response> {
    const auth = await requireUserAuth(request, env);
    if (auth instanceof Response) {
        return auth;
    }
    const programs = new ProgramRepository(env.DB);
    const found = await programs.getProgramBySlug(slug);
    if (!found) {
        return json({ error: 'program_not_found' }, { status: 404 });
    }
    const access = await requireProgramAccess(programs, found.id, auth);
    if (access instanceof Response) {
        return access;
    }

    if (action === 'session') {
        if (!deps.mintScribeToken) {
            return json({ error: 'transcription_not_configured' }, { status: 503 });
        }
        try {
            const token = await deps.mintScribeToken();
            return json(
                { token, ...SCRIBE_SESSION, translationEnabled: deps.hub.translationEnabled },
                { headers: { 'cache-control': 'no-store' } },
            );
        } catch (error) {
            console.error(
                JSON.stringify({
                    level: 'error',
                    message: 'scribe_token_failed',
                    error: error instanceof Error ? error.message : String(error),
                }),
            );
            return json({ error: 'transcription_provider_unavailable' }, { status: 502 });
        }
    }

    const body = await readBody(request);
    const sourceId = body?.sourceId;
    if (!body || typeof sourceId !== 'string' || sourceId.length === 0 || sourceId.length > 64) {
        return json({ error: 'invalid_request' }, { status: 400 });
    }
    if (body.type === 'state' && typeof body.active === 'boolean') {
        const primary = deps.hub.setActive(found.id, sourceId, body.active);
        return json({ ok: true, primary: body.active && primary });
    }
    if ((body.type === 'partial' || body.type === 'segment') && typeof body.text === 'string') {
        const text = body.text.trim().slice(0, MAX_TEXT_LENGTH);
        if (!text) {
            return json({ ok: true, primary: deps.hub.isPrimarySource(found.id, sourceId) });
        }
        // A console that is standing by is not an error: it keeps transcribing and takes over
        // if the primary stops, so the answer is simply "not primary".
        const relayed =
            body.type === 'segment'
                ? deps.hub.publishSegment(found.id, sourceId, text) !== null
                : deps.hub.publishPartial(found.id, sourceId, text);
        return json({ ok: true, primary: relayed });
    }
    return json({ error: 'invalid_request' }, { status: 400 });
}

async function readBody(
    request: Request,
): Promise<{ type?: unknown; text?: unknown; active?: unknown; sourceId?: unknown } | null> {
    try {
        const body: unknown = await request.json();
        return body !== null && typeof body === 'object' ? body : null;
    } catch {
        return null;
    }
}

// Server-sent events for one translator: the hall transcript plus its translation into the
// language of the stream the translator is assigned to.
async function handleTranslatorStream(
    request: Request,
    env: Env,
    url: URL,
    deps: TranscriptDeps,
): Promise<Response> {
    const auth = await requireTranslatorSession(request, env);
    if (auth instanceof Response) {
        return auth;
    }
    const streamId = url.searchParams.get('streamId') ?? '';
    const stream = auth.assignedStreams.find((candidate) => candidate.id === streamId);
    if (!stream) {
        return json({ error: 'stream_not_assigned' }, { status: 403 });
    }

    const encoder = new TextEncoder();
    let cleanup: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            const write = (chunk: string) => controller.enqueue(encoder.encode(chunk));
            const send = (event: TranscriptEvent) =>
                write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

            write(
                `event: config\ndata: ${JSON.stringify({
                    type: 'config',
                    translationEnabled:
                        deps.hub.translationEnabled && !isEnglish(stream.languageCode),
                })}\n\n`,
            );
            const unsubscribe = deps.hub.subscribe({
                programId: auth.translator.programId,
                languageCode: stream.languageCode,
                languageName: stream.languageName,
                send,
            });
            const keepAlive = setInterval(() => write(': keepalive\n\n'), KEEPALIVE_MS);

            cleanup = () => {
                clearInterval(keepAlive);
                unsubscribe();
            };
            request.signal.addEventListener('abort', () => {
                cleanup?.();
                try {
                    controller.close();
                } catch {
                    // Already closed.
                }
            });
        },
        cancel() {
            cleanup?.();
        },
    });

    return new Response(body, {
        headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store, no-transform',
            'x-accel-buffering': 'no',
        },
    });
}
