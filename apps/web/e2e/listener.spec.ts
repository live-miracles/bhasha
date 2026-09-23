import { expect, test } from '@playwright/test';

declare global {
    interface Window {
        __listenerMediaRequests?: number;
    }
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: {
                getUserMedia: () => {
                    window.__listenerMediaRequests = (window.__listenerMediaRequests ?? 0) + 1;
                    return Promise.reject(new Error('listeners must not request media'));
                },
            },
        });

        window.__listenerMediaRequests = 0;
        // No RTCPeerConnection/WebSocket mock is needed here: listenerClient.ts
        // hands the minted LiveKit token straight to a real `livekit-client`
        // `Room.connect()`, which this e2e build swaps out entirely for a no-real-
        // transport double (see apps/web/e2e/support/fakeLivekitClient.ts and
        // apps/web/vite.config.ts's E2E_FAKE_LIVEKIT alias). connect() resolves
        // immediately, so only the HTTP mocks below are needed to reach
        // "Listening to X".
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
                serverTime: '2026-06-21T10:00:00.000Z',
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
                    listenerUrl: 'https://bhasha.test/patna-event-2026',
                    translatorUrl: 'https://bhasha.test/patna-event-2026/translate',
                },
            },
        });
    });

    // createRequestedConnection (DB bookkeeping row) -- unrelated to the SFU/
    // LiveKit surface, unchanged by the migration. listenerClient.ts's
    // subscribe() calls this first, then joinRoom() mints the LiveKit token.
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
    // session` + `/subscribe/track` + `/subscribe/renegotiate` SDP dance. See
    // apps/api/src/routes/listeners.ts's handleListenerRealtimeToken. Every
    // join path (subscribe/switch/reconnect) ends here via listenerClient.ts's
    // shared joinRoom().
    await page.route('**/api/listeners/token', async (route) => {
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
    await page.route('**/api/listeners/switch', async (route) => {
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
});

test('listener can start, switch, and leave without requesting media', async ({ page }) => {
    await page.goto('/patna-event-2026');

    await page.getByRole('button', { name: 'Listen to Hindi' }).click();
    await expect(page.getByText('Listening to Hindi')).toBeVisible();

    await page.getByRole('button', { name: 'Switch to English' }).click();
    await expect(page.getByText('Listening to English')).toBeVisible();

    await page.getByRole('button', { name: 'Leave stream' }).click();
    await expect(page.getByText('Choose a language to listen.')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__listenerMediaRequests)).toBe(0);
});

test('listener can reconnect after a failed first listen without requesting media', async ({
    page,
}) => {
    let firstToken = true;
    await page.route('**/api/listeners/token', async (route) => {
        if (firstToken) {
            firstToken = false;
            await route.fulfill({
                contentType: 'application/json',
                status: 502,
                json: { error: 'realtime_error' },
            });
            return;
        }

        const body = route.request().postDataJSON() as {
            connectionId: string;
            streamId: string;
        };
        await route.fulfill({
            contentType: 'application/json',
            json: {
                connectionId: body.connectionId,
                token: 'jwt_recovered',
                url: 'wss://livekit.example.test',
                roomName: `room_${body.streamId}`,
            },
        });
    });

    await page.goto('/patna-event-2026');

    await page.getByRole('button', { name: 'Listen to Hindi' }).click();
    await expect(page.getByText('Disconnected')).toBeVisible();
    await expect(page.getByText('Realtime connection failed. Try reconnecting.')).toBeVisible();
    await page.getByRole('button', { name: 'Reconnect Hindi' }).click();
    await expect(page.getByText('Listening to Hindi')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__listenerMediaRequests)).toBe(0);
});
