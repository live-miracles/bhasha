import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/index';
import type { TranscriptDeps } from '../src/routes/transcript';
import { TranscriptHub } from '../src/transcript/hub';
import type { TextTranslator } from '../src/transcript/translate';
import { adminCookie, buildTestEnv, seedAdmin, seedProgram, seedUser, testEnv } from './test-env';

function resetDb(): void {
    for (const table of [
        'translator_sessions',
        'translator_login_attempts',
        'admin_sessions',
        'translator_stream_assignments',
        'translators',
        'language_streams',
        'programs',
    ]) {
        testEnv.DB.exec(`DELETE FROM ${table}`);
    }
}

const translator: TextTranslator = {
    translate: async (r) => `[${r.targetLanguageCode}] ${r.text}`,
};

function build(overrides: Partial<TranscriptDeps> = {}) {
    const deps: TranscriptDeps = {
        hub: new TranscriptHub({ translator }),
        mintScribeToken: vi.fn(async () => 'sutkn_test'),
        ...overrides,
    };
    const app = createApp(buildTestEnv(), deps);
    const call = (path: string, init: RequestInit = {}) =>
        app.fetch(new Request(`https://bhasha.test${path}`, init));
    return { deps, call };
}

async function addStream(
    call: ReturnType<typeof build>['call'],
    cookie: string,
    programId: string,
    languageName: string,
    languageCode: string,
): Promise<string> {
    const response = await call(`/api/admin/programs/${programId}/streams`, {
        method: 'POST',
        headers: { Cookie: cookie },
        body: JSON.stringify({
            languageName,
            languageCode,
            displayOrder: 1,
            isActive: true,
            translatorPassword: 'hand-set-password',
        }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
}

async function translatorCookie(
    call: ReturnType<typeof build>['call'],
    slug: string,
    streamId: string,
): Promise<string> {
    const response = await call('/api/translator/login', {
        method: 'POST',
        body: JSON.stringify({ programSlug: slug, streamId, password: 'hand-set-password' }),
    });
    expect(response.status).toBe(200);
    return response.headers.get('set-cookie')!.split(';')[0]!;
}

async function readEvents(response: Response, count: number): Promise<string[]> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while ((text.match(/\n\n/g) ?? []).length < count) {
        const { value, done } = await reader.read();
        if (done) {
            break;
        }
        text += decoder.decode(value);
    }
    void reader.cancel();
    return text
        .split('\n\n')
        .filter((block) => block.startsWith('event:'))
        .map((block) => block.split('\n')[0]!.slice('event: '.length));
}

describe('source console endpoints', () => {
    beforeEach(async () => {
        resetDb();
        await seedAdmin(testEnv);
    });

    it('requires an admin session', async () => {
        const program = await seedProgram(testEnv, { slug: 'needs-auth' });
        const { call } = build();

        const response = await call(`/api/admin/transcript/${program.slug}/session`, {
            method: 'POST',
        });

        expect(response.status).toBe(401);
    });

    it("keeps another user's program out of reach", async () => {
        const ownerId = await seedUser(testEnv, 'owner_user');
        const program = await seedProgram(testEnv, { slug: 'not-yours', createdBy: ownerId });
        await seedUser(testEnv);
        const { call } = build();
        const login = await call('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({ username: 'user_test', password: testEnv.TEST_PASSWORD }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

        const response = await call(`/api/admin/transcript/${program.slug}/session`, {
            method: 'POST',
            headers: { Cookie: cookie },
        });

        expect(response.status).toBe(404);
    });

    it('hands the console a single-use token and the audio format to send', async () => {
        const program = await seedProgram(testEnv, { slug: 'console' });
        const { call, deps } = build();

        const response = await call(`/api/admin/transcript/${program.slug}/session`, {
            method: 'POST',
            headers: { Cookie: await adminCookie() },
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toMatchObject({
            token: 'sutkn_test',
            modelId: 'scribe_v2_realtime',
            sampleRate: 16000,
            audioFormat: 'pcm_16000',
            commitStrategy: 'vad',
            languageCode: 'en',
            translationEnabled: true,
        });
        expect(deps.mintScribeToken).toHaveBeenCalledOnce();
    });

    it('says transcription is not configured when there is no ElevenLabs key', async () => {
        const program = await seedProgram(testEnv, { slug: 'no-key' });
        const { call } = build({ mintScribeToken: undefined });

        const response = await call(`/api/admin/transcript/${program.slug}/session`, {
            method: 'POST',
            headers: { Cookie: await adminCookie() },
        });

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'transcription_not_configured' });
    });

    it('reports a provider failure as a bad gateway without leaking details', async () => {
        const program = await seedProgram(testEnv, { slug: 'provider-down' });
        const { call } = build({
            mintScribeToken: async () => {
                throw new Error('secret detail');
            },
        });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const response = await call(`/api/admin/transcript/${program.slug}/session`, {
            method: 'POST',
            headers: { Cookie: await adminCookie() },
        });

        expect(response.status).toBe(502);
        expect(JSON.stringify(await response.json())).not.toContain('secret detail');
    });

    it('rejects malformed events and trims oversized text', async () => {
        const program = await seedProgram(testEnv, { slug: 'events' });
        const { call, deps } = build();
        const cookie = await adminCookie();
        const post = (body: unknown) =>
            call(`/api/admin/transcript/${program.slug}/events`, {
                method: 'POST',
                headers: { Cookie: cookie },
                body: JSON.stringify(body),
            });
        const spy = vi.spyOn(deps.hub, 'publishSegment');

        const sourceId = 'console-a';
        expect((await post({ sourceId, type: 'nope' })).status).toBe(400);
        expect((await post({ sourceId, type: 'segment', text: 42 })).status).toBe(400);
        expect((await post({ type: 'segment', text: 'no console id' })).status).toBe(400);
        expect((await post({ sourceId, type: 'segment', text: '   ' })).status).toBe(200);
        expect(spy).not.toHaveBeenCalled();

        expect((await post({ sourceId, type: 'segment', text: 'x'.repeat(5000) })).status).toBe(
            200,
        );
        expect(spy.mock.calls[0]![2]).toHaveLength(2000);
    });
});

describe('two source consoles at once', () => {
    beforeEach(async () => {
        resetDb();
        await seedAdmin(testEnv);
    });

    it('answers both normally; only the first is relayed and the second is told it stands by', async () => {
        const program = await seedProgram(testEnv, { slug: 'two-consoles' });
        const { call, deps } = build();
        const cookie = await adminCookie();
        const post = async (body: unknown) => {
            const response = await call(`/api/admin/transcript/${program.slug}/events`, {
                method: 'POST',
                headers: { Cookie: cookie },
                body: JSON.stringify(body),
            });
            expect(response.status).toBe(200);
            return (await response.json()) as { ok: true; primary: boolean };
        };

        expect(await post({ sourceId: 'a', type: 'state', active: true })).toEqual({
            ok: true,
            primary: true,
        });
        expect(await post({ sourceId: 'b', type: 'state', active: true })).toEqual({
            ok: true,
            primary: false,
        });
        expect((await post({ sourceId: 'a', type: 'segment', text: 'hello' })).primary).toBe(true);
        expect((await post({ sourceId: 'b', type: 'segment', text: 'hello' })).primary).toBe(false);

        // The first console goes away: the second is promoted and its text now flows.
        await post({ sourceId: 'a', type: 'state', active: false });
        expect((await post({ sourceId: 'b', type: 'segment', text: 'again' })).primary).toBe(true);
        expect(deps.hub.isPrimarySource(program.id, 'b')).toBe(true);
    });
});

describe('translator transcript stream', () => {
    beforeEach(async () => {
        resetDb();
        await seedAdmin(testEnv);
    });

    it('requires a translator session', async () => {
        const { call } = build();

        const response = await call('/api/translator/transcript/stream?streamId=x');

        expect(response.status).toBe(401);
    });

    it('refuses a stream the translator is not assigned to', async () => {
        const admin = await adminCookie();
        const program = await seedProgram(testEnv, { slug: 'assigned' });
        const { call } = build();
        const mine = await addStream(call, admin, program.id, 'Hindi', 'hi');
        const cookie = await translatorCookie(call, program.slug, mine);

        const response = await call('/api/translator/transcript/stream?streamId=someone-else', {
            headers: { Cookie: cookie },
        });

        expect(response.status).toBe(403);
    });

    it('streams the hall transcript and its translation into the translator language', async () => {
        const admin = await adminCookie();
        const program = await seedProgram(testEnv, { slug: 'live' });
        const { call, deps } = build();
        const streamId = await addStream(call, admin, program.id, 'Hindi', 'hi');
        const cookie = await translatorCookie(call, program.slug, streamId);

        const response = await call(`/api/translator/transcript/stream?streamId=${streamId}`, {
            headers: { Cookie: cookie },
        });
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        expect(response.headers.get('cache-control')).toContain('no-store');

        const post = (body: unknown) =>
            call(`/api/admin/transcript/${program.slug}/events`, {
                method: 'POST',
                headers: { Cookie: admin },
                body: JSON.stringify(body),
            });
        const events = readEvents(response, 5);
        await vi.waitFor(() => expect(deps.hub.subscriberCount(program.id)).toBe(1));
        const sourceId = 'console-a';
        await post({ sourceId, type: 'state', active: true });
        await post({ sourceId, type: 'partial', text: 'Good mor' });
        await post({ sourceId, type: 'segment', text: 'Good morning' });

        expect(await events).toEqual([
            'config',
            'source_state',
            'source_state',
            'partial',
            'segment',
        ]);
    });

    it('stops listening to the hub when the translator disconnects', async () => {
        const admin = await adminCookie();
        const program = await seedProgram(testEnv, { slug: 'disconnect' });
        const { call, deps } = build();
        const streamId = await addStream(call, admin, program.id, 'Hindi', 'hi');
        const cookie = await translatorCookie(call, program.slug, streamId);
        const controller = new AbortController();

        await call(`/api/translator/transcript/stream?streamId=${streamId}`, {
            headers: { Cookie: cookie },
            signal: controller.signal,
        });
        expect(deps.hub.subscriberCount(program.id)).toBe(1);
        controller.abort();

        await vi.waitFor(() => expect(deps.hub.subscriberCount(program.id)).toBe(0));
    });
});
