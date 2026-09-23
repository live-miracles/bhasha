import { expect, test, type Page } from '@playwright/test';

declare global {
    interface Window {
        __listenerMediaRequests?: number;
        __translatorAudioRequests?: number;
        __translatorVideoRequests?: number;
    }
}

const program = {
    id: 'program_1',
    slug: 'patna-event-2026',
    name: 'Patna Event 2026',
    venue: 'Main Hall',
    eventDate: '2026-07-01',
    status: 'draft',
    adminNotes: 'Doors at 6',
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
};

test('full MVP event flow keeps listeners receive-only and operators informed', async ({
    browser,
}) => {
    const admin = await browser.newPage();
    const translator = await browser.newPage();
    const listener = await browser.newPage();

    try {
        await installAdminMocks(admin);
        await installTranslatorMocks(translator);
        await installListenerMocks(listener);

        await admin.goto('/manage');
        await admin.getByLabel('Username').fill('admin');
        await admin.getByLabel('Management password').fill('admin-secret');
        await admin.getByRole('button', { name: 'Log in' }).click();
        await admin
            .getByRole('textbox', { name: 'Program name', exact: true })
            .fill('Patna Event 2026');
        await admin.getByLabel('Program slug').fill('patna-event-2026');
        await admin.getByLabel('Program venue').fill('Main Hall');
        await admin.getByLabel('Program date').fill('2026-07-01');
        await admin.getByRole('button', { name: 'Create program' }).click();
        await admin.getByRole('button', { name: /Patna Event 2026/ }).click();
        await admin.getByRole('button', { name: 'Share / QR' }).click();
        await expect(admin.getByRole('region', { name: 'Share QR' })).toBeVisible();
        await expect(admin.getByRole('img', { name: 'Listener QR' })).toBeVisible();
        await expect(
            admin
                .getByRole('region', { name: 'Share QR' })
                .locator('p')
                .filter({ hasText: /^http:\/\/127\.0\.0\.1:4173\/patna-event-2026$/ }),
        ).toBeVisible();

        await admin.getByRole('button', { name: 'Streams' }).click();
        await admin.getByLabel('Stream language').selectOption('hi');
        await admin.getByLabel('Stream display order').fill('1');
        await admin.getByRole('button', { name: 'Create stream' }).click();
        await admin.getByRole('button', { name: 'Translators' }).click();
        await admin.getByLabel('Translator email').fill('hi@example.com');
        await admin.getByLabel('Translator name').fill('Hindi translator');
        await admin.getByLabel('Translator password').fill('translator-secret');
        await admin.getByRole('button', { name: 'Create translator' }).click();
        await admin.getByRole('button', { name: 'Assign Hindi to Hindi translator' }).click();

        await translator.goto('/patna-event-2026/translate');
        await translator.getByLabel('Email').fill('hi@example.com');
        await translator.getByLabel('Password').fill('translator-secret');
        await translator.getByRole('button', { name: 'Log in' }).click();
        await translator.getByRole('button', { name: 'Go live' }).click();
        await expect(translator.getByText('You are live.')).toBeVisible();
        await expect
            .poll(() => translator.evaluate(() => window.__translatorAudioRequests))
            .toBe(1);
        await expect
            .poll(() => translator.evaluate(() => window.__translatorVideoRequests))
            .toBe(0);

        await listener.goto('/patna-event-2026');
        await listener.getByRole('button', { name: 'Listen to Hindi' }).click();
        await expect(listener.getByText('Listening to Hindi')).toBeVisible();
        await expect.poll(() => listener.evaluate(() => window.__listenerMediaRequests)).toBe(0);

        await listener.getByRole('button', { name: 'Switch to English' }).click();
        await expect(listener.getByText('Disconnected')).toBeVisible();
        await listener.getByRole('button', { name: 'Reconnect English' }).click();
        await expect(listener.getByText('Listening to English')).toBeVisible();
        await listener.getByRole('button', { name: 'Leave stream' }).click();
        await expect(listener.getByText('Choose a language to listen.')).toBeVisible();
        await expect.poll(() => listener.evaluate(() => window.__listenerMediaRequests)).toBe(0);

        await admin.reload();
        await admin.getByRole('button', { name: /Patna Event 2026/ }).click();
        await admin.getByRole('button', { name: 'Status' }).click();
        await expect(admin.getByRole('region', { name: 'Listener counts' })).toContainText('Total');
        await expect(admin.getByRole('region', { name: 'Listener counts' })).toContainText('Live');
    } finally {
        await admin.close();
        await translator.close();
        await listener.close();
    }
});

async function installAdminMocks(page: Page): Promise<void> {
    let authenticated = false;
    await page.route(/\/api\/admin\/programs\?deleted=true$/, async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: { programs: [] },
        });
    });

    // In-memory program detail that grows as the operator creates streams,
    // translators, and assignments. Deterministic, no network state.
    const streams: Array<{
        id: string;
        languageName: string;
        languageCode: string;
        displayOrder: number;
        isActive: boolean;
        createdAt: string;
        updatedAt: string;
    }> = [];
    const translators: Array<{
        id: string;
        email: string;
        name: string;
        assignments: Array<{
            streamId: string;
            languageName: string;
            languageCode: string;
        }>;
    }> = [];

    const buildDetail = () => ({
        program,
        streams,
        translators,
        urls: {
            listenerUrl: 'http://127.0.0.1:4173/patna-event-2026',
            translatorUrl: 'http://127.0.0.1:4173/patna-event-2026/translate',
        },
        qrPayload: 'http://127.0.0.1:4173/patna-event-2026',
        suggestedQrFilename: 'patna-event-2026-listener-qr.png',
    });

    // Status reports a live Hindi stream so the counts region shows both the
    // "Total" metric label and the "Live" stream state.
    const statusJson = () => ({
        programId: 'program_1',
        totalActiveListeners: 12,
        streams: [
            {
                id: 'stream_hi',
                languageName: 'Hindi',
                languageCode: 'hi',
                isActive: true,
                state: 'live',
                activeListeners: 12,
            },
        ],
        stale: false,
        degraded: false,
        updatedAt: '2026-07-01T12:00:00.000Z',
        serverTime: '2026-07-01T12:00:03.000Z',
    });

    await page.route('**/api/admin/login', async (route) => {
        authenticated = true;
        await route.fulfill({
            contentType: 'application/json',
            json: { ok: true },
        });
    });

    await page.route('**/api/admin/me', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: { id: 'admin_1', username: 'admin', role: 'admin' },
        });
    });

    await page.route('**/api/admin/programs', async (route) => {
        if (route.request().method() === 'GET') {
            const deleted = new URL(route.request().url()).searchParams.get('deleted') === 'true';
            if (!authenticated) {
                await route.fulfill({
                    contentType: 'application/json',
                    json: deleted ? { programs: [] } : { error: 'admin_auth_required' },
                    status: deleted ? 200 : 401,
                });
                return;
            }
            await route.fulfill({
                contentType: 'application/json',
                json: { programs: deleted ? [] : [program] },
            });
            return;
        }

        if (route.request().method() === 'POST') {
            await route.fulfill({
                contentType: 'application/json',
                json: program,
                status: 201,
            });
            return;
        }

        await route.fallback();
    });

    await page.route('**/api/admin/programs/program_1/status', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: statusJson(),
        });
    });

    await page.route('**/api/admin/programs/program_1/report/summary', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: {
                programId: 'program_1',
                totals: {
                    activeListeners: 12,
                    totalConnections: 30,
                    dropouts: 1,
                    reconnects: 4,
                },
                streams: [],
                generatedAt: '2026-07-01T12:00:03.000Z',
                presenceSource: 'durable_object',
            },
        });
    });

    await page.route('**/api/admin/programs/program_1/events*', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: { events: [] },
        });
    });

    await page.route('**/api/admin/programs/program_1/readiness', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: {
                programId: 'program_1',
                items: [
                    {
                        id: 'program_setup',
                        label: 'Program setup',
                        status: 'green',
                        detail: 'Program details are configured.',
                    },
                ],
            },
        });
    });

    await page.route('**/api/admin/programs/program_1/volunteer-access', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: {
                configured: false,
                loginId: null,
                passwordUpdatedAt: null,
                activeSessionCount: 0,
            },
        });
    });

    await page.route('**/api/admin/programs/program_1/streams', async (route) => {
        const body = route.request().postDataJSON() as {
            languageName: string;
            languageCode: string;
            displayOrder: number;
        };
        const created = {
            id: 'stream_hi',
            languageName: body.languageName,
            languageCode: body.languageCode,
            displayOrder: body.displayOrder,
            isActive: true,
            createdAt: '2026-07-01T11:00:00.000Z',
            updatedAt: '2026-07-01T11:00:00.000Z',
        };
        streams.push(created);
        await route.fulfill({
            contentType: 'application/json',
            json: created,
            status: 201,
        });
    });

    await page.route(
        '**/api/admin/programs/program_1/translators/translator_hi/assignments',
        async (route) => {
            const body = route.request().postDataJSON() as { streamId: string };
            const stream = streams.find((entry) => entry.id === body.streamId);
            const translator = translators.find((entry) => entry.id === 'translator_hi');
            if (translator && stream) {
                translator.assignments.push({
                    streamId: stream.id,
                    languageName: stream.languageName,
                    languageCode: stream.languageCode,
                });
            }
            await route.fulfill({
                contentType: 'application/json',
                json: translator ?? {
                    id: 'translator_hi',
                    email: 'hi@example.com',
                    name: 'Hindi translator',
                    assignments: [],
                },
            });
        },
    );

    await page.route('**/api/admin/programs/program_1/translators', async (route) => {
        const body = route.request().postDataJSON() as {
            email: string;
            name: string;
        };
        // The server auto-generates the id; this mock pins it so the assignment
        // route below can match a stable path.
        const created = {
            id: 'translator_hi',
            email: body.email,
            name: body.name,
            assignments: [],
        };
        translators.push(created);
        await route.fulfill({
            contentType: 'application/json',
            json: created,
            status: 201,
        });
    });

    await page.route('**/api/admin/programs/program_1', async (route) => {
        if (route.request().method() === 'GET') {
            await route.fulfill({
                contentType: 'application/json',
                json: buildDetail(),
            });
            return;
        }
        await route.fallback();
    });
}

async function installTranslatorMocks(page: Page): Promise<void> {
    await page.addInitScript(() => {
        window.__translatorAudioRequests = 0;
        window.__translatorVideoRequests = 0;

        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: {
                getUserMedia: (constraints: MediaStreamConstraints) => {
                    if (constraints.video) {
                        window.__translatorVideoRequests =
                            (window.__translatorVideoRequests ?? 0) + 1;
                        return Promise.reject(new Error('camera is not allowed'));
                    }
                    if (constraints.audio) {
                        window.__translatorAudioRequests =
                            (window.__translatorAudioRequests ?? 0) + 1;
                    }
                    const track = {
                        kind: 'audio',
                        enabled: true,
                        stop() {},
                    } as unknown as MediaStreamTrack;
                    return Promise.resolve({
                        getTracks: () => [track],
                        getAudioTracks: () => [track],
                    } as unknown as MediaStream);
                },
            },
        });

        // No RTCPeerConnection/WebSocket mock is needed here: translatorClient.ts
        // hands the minted LiveKit token straight to a real `livekit-client`
        // `Room.connect()`, which this e2e build swaps out entirely for a no-real-
        // transport double (see apps/web/e2e/support/fakeLivekitClient.ts and
        // apps/web/vite.config.ts's E2E_FAKE_LIVEKIT alias).
    });

    await page.route('**/api/public/programs/patna-event-2026', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: {
                program: {
                    slug: 'patna-event-2026',
                    name: 'Patna Event 2026',
                    venue: 'Main Hall',
                    eventDate: '2026-07-01',
                    status: 'live',
                },
                streams: [],
                urls: {
                    listenerUrl: 'http://127.0.0.1:4173/patna-event-2026',
                    translatorUrl: 'http://127.0.0.1:4173/patna-event-2026/translate',
                },
            },
        });
    });

    // Logged out on load; login provides the session.
    await page.route('**/api/translator/session', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            status: 401,
            json: { error: 'translator_auth_required' },
        });
    });

    await page.route('**/api/translator/login', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: {
                ok: true,
                translator: {
                    id: 'translator_hi',
                    programId: 'program_1',
                    name: 'Hindi translator',
                    email: 'hi@example.com',
                },
                assignedStreams: [{ id: 'stream_hi', languageName: 'Hindi', languageCode: 'hi' }],
            },
        });
    });

    // Single LiveKit token-mint endpoint, replacing the old three-step SFU
    // handshake (`/realtime/session` + `/realtime/publish` + `/realtime/track`).
    // See apps/api/src/routes/translator.ts's handleTranslatorRealtimeToken.
    let tokenIndex = 0;
    await page.route('**/api/translator/realtime/token', async (route) => {
        const body = route.request().postDataJSON() as {
            streamId: string;
            reclaim?: boolean;
        };
        tokenIndex += 1;
        await route.fulfill({
            contentType: 'application/json',
            json: {
                publishSessionId: `publish_${tokenIndex}`,
                token: `jwt_${tokenIndex}`,
                url: 'wss://livekit.example.test',
                roomName: `room_${body.streamId}`,
            },
        });
    });

    await page.route('**/api/translator/realtime/stop', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: { ok: true, cleanup: 'closed' },
        });
    });

    await page.route('**/api/translator/realtime/audio-activity', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: { ok: true, state: 'live' },
        });
    });
}

async function installListenerMocks(page: Page): Promise<void> {
    await page.addInitScript(() => {
        window.__listenerMediaRequests = 0;

        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: {
                getUserMedia: () => {
                    window.__listenerMediaRequests = (window.__listenerMediaRequests ?? 0) + 1;
                    return Promise.reject(new Error('listeners must not request media'));
                },
            },
        });

        // No RTCPeerConnection/WebSocket mock is needed here: listenerClient.ts
        // hands the minted LiveKit token straight to a real `livekit-client`
        // `Room.connect()`, which this e2e build swaps out entirely for a no-real-
        // transport double (see apps/web/e2e/support/fakeLivekitClient.ts and
        // apps/web/vite.config.ts's E2E_FAKE_LIVEKIT alias).
        HTMLMediaElement.prototype.play = async () => undefined;
        HTMLMediaElement.prototype.pause = () => undefined;
    });

    await page.route('**/api/public/programs/patna-event-2026/status', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: {
                program: { slug: 'patna-event-2026' },
                streams: [
                    {
                        id: 'stream_hi',
                        languageName: 'Hindi',
                        languageCode: 'hi',
                        isActive: true,
                        state: 'live',
                        activeListeners: 7,
                    },
                    {
                        id: 'stream_en',
                        languageName: 'English',
                        languageCode: 'en',
                        isActive: true,
                        state: 'silent',
                        activeListeners: 4,
                    },
                ],
                stale: false,
                degraded: false,
                serverTime: '2026-07-01T10:00:00.000Z',
            },
        });
    });

    await page.route('**/api/public/programs/patna-event-2026', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: {
                program: {
                    slug: 'patna-event-2026',
                    name: 'Patna Event 2026',
                    venue: 'Main Hall',
                    eventDate: '2026-07-01',
                    status: 'live',
                },
                streams: [
                    {
                        id: 'stream_hi',
                        languageName: 'Hindi',
                        languageCode: 'hi',
                        displayOrder: 1,
                        isActive: true,
                    },
                    {
                        id: 'stream_en',
                        languageName: 'English',
                        languageCode: 'en',
                        displayOrder: 2,
                        isActive: true,
                    },
                ],
                urls: {
                    listenerUrl: 'http://127.0.0.1:4173/patna-event-2026',
                    translatorUrl: 'http://127.0.0.1:4173/patna-event-2026/translate',
                },
            },
        });
    });

    // createRequestedConnection (DB bookkeeping row) -- unrelated to the SFU/
    // LiveKit surface, unchanged by the migration.
    let connectionIndex = 0;
    await page.route('**/api/listeners/request', async (route) => {
        connectionIndex += 1;
        await route.fulfill({
            contentType: 'application/json',
            status: 201,
            json: { connectionId: `listener_connection_${connectionIndex}` },
        });
    });

    // Single LiveKit token-mint endpoint, replacing the old `/subscribe/
    // session` + `/subscribe/track` + `/subscribe/renegotiate` SDP dance. It is
    // the direct successor of the old subscribe/session request-shape check
    // (the only listener call that carries the program identifier -- others
    // like /connected, /heartbeat, /leave only take a connectionId).
    await page.route('**/api/listeners/token', async (route) => {
        expect(route.request().postDataJSON()).not.toHaveProperty('programId');
        expect(route.request().postDataJSON()).toHaveProperty('programSlug', 'patna-event-2026');
        const body = route.request().postDataJSON() as {
            connectionId: string;
            streamId: string;
        };
        await route.fulfill({
            contentType: 'application/json',
            json: {
                connectionId: body.connectionId,
                token: `jwt_${body.connectionId}`,
                url: 'wss://livekit.example.test',
                roomName: `room_${body.streamId}`,
            },
        });
    });

    await page.route('**/api/listeners/connected', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: { ok: true },
        });
    });
    await page.route('**/api/listeners/heartbeat', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: { ok: true },
        });
    });
    await page.route('**/api/listeners/leave', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: { ok: true },
        });
    });

    // The first switch to English fails so the UI surfaces Disconnected and a
    // Reconnect English action; the reconnect path then succeeds.
    let firstSwitch = true;
    await page.route('**/api/listeners/switch', async (route) => {
        if (firstSwitch) {
            firstSwitch = false;
            await route.fulfill({
                contentType: 'application/json',
                status: 502,
                json: { error: 'realtime_error' },
            });
            return;
        }
        await route.fulfill({
            contentType: 'application/json',
            status: 201,
            json: { connectionId: 'listener_connection_switched' },
        });
    });

    await page.route('**/api/listeners/reconnect', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            status: 201,
            json: { connectionId: 'listener_connection_reconnected' },
        });
    });
}
