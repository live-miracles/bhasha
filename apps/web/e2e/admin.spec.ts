import { expect, test } from '@playwright/test';

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

const detail = {
    program,
    streams: [
        {
            id: 'stream_hi',
            languageName: 'Hindi',
            languageCode: 'hi',
            displayOrder: 1,
            isActive: true,
            createdAt: '2026-06-01T10:00:00.000Z',
            updatedAt: '2026-06-01T10:00:00.000Z',
        },
    ],
    translators: [
        {
            id: 'translator_hindi',
            email: 'hindi@example.com',
            name: 'Hindi Translator',
            assignments: [],
        },
    ],
    urls: {
        listenerUrl: 'https://ignored.example/patna-event-2026',
        translatorUrl: 'https://ignored.example/patna-event-2026/translate',
    },
    qrPayload: 'http://127.0.0.1:4173/patna-event-2026',
    suggestedQrFilename: 'patna-event-2026-listener-qr.png',
};

test('management workspace smoke with mocked APIs', async ({ page }) => {
    let authenticated = false;
    await page.route(/\/api\/admin\/programs\?deleted=true$/, async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: { programs: [] },
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
                json: {
                    ...program,
                    id: 'program_2',
                    slug: 'delhi-event-2026',
                    name: 'Delhi Event 2026',
                },
                status: 201,
            });
            return;
        }

        await route.fallback();
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
            json: { id: 'admin_1', username: 'admin', role: 'user' },
        });
    });

    await page.route('**/api/admin/programs/program_1', async (route) => {
        if (route.request().method() === 'GET') {
            await route.fulfill({ contentType: 'application/json', json: detail });
            return;
        }
        if (route.request().method() === 'PATCH') {
            await route.fulfill({
                contentType: 'application/json',
                json: {
                    ...detail,
                    program: { ...program, name: 'Patna Event Updated' },
                },
            });
            return;
        }
        await route.fallback();
    });

    await page.route('**/api/admin/programs/program_1/status', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: {
                programId: 'program_1',
                totalActiveListeners: 18,
                streams: [
                    {
                        id: 'stream_hi',
                        languageName: 'Hindi',
                        languageCode: 'hi',
                        isActive: true,
                        state: 'live',
                        activeListeners: 18,
                    },
                ],
                stale: false,
                degraded: false,
                updatedAt: '2026-06-20T12:00:00.000Z',
                serverTime: '2026-06-20T12:00:03.000Z',
            },
        });
    });

    await page.route('**/api/admin/programs/program_1/report/summary', async (route) => {
        if (!authenticated) {
            await route.fulfill({
                contentType: 'application/json',
                json: { error: 'admin_auth_required' },
                status: 401,
            });
            return;
        }
        await route.fulfill({
            contentType: 'application/json',
            json: {
                programId: 'program_1',
                totals: {
                    activeListeners: 18,
                    totalConnections: 64,
                    dropouts: 3,
                    reconnects: 9,
                },
                streams: [
                    {
                        streamId: 'stream_hi',
                        languageName: 'Hindi',
                        languageCode: 'hi',
                        activeListeners: 18,
                        totalConnections: 64,
                        dropouts: 3,
                        reconnects: 9,
                    },
                ],
                generatedAt: '2026-06-20T12:00:03.000Z',
                presenceSource: 'durable_object',
            },
        });
    });

    await page.route('**/api/admin/programs/program_1/events*', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: {
                events: [
                    {
                        id: 'ev_1',
                        eventType: 'connection_failed',
                        occurredAt: '2026-06-20T12:00:00.000Z',
                        stream: {
                            id: 'stream_hi',
                            languageName: 'Hindi',
                            languageCode: 'hi',
                        },
                        metadata: { reason: 'ice_failed', connectionId: 'lc_1' },
                    },
                ],
            },
        });
    });

    await page.route('**/api/admin/programs/program_1/listener-report.csv', async (route) => {
        await route.fulfill({
            contentType: 'text/csv; charset=utf-8',
            headers: {
                'content-disposition':
                    'attachment; filename="patna-event-2026-listener-report.csv"',
            },
            body: 'connectionId,clientId,streamId,connectedAt,disconnectedAt,disconnectReason,listenerIp,userAgent\r\nlc_1,client_1,stream_hi,2026-06-20T12:00:00.000Z,,,203.0.113.10,Mobile Safari\r\n',
        });
    });

    await page.route('**/api/admin/programs/program_1/retention/run', async (route) => {
        await route.fulfill({
            contentType: 'application/json',
            json: {
                programId: 'program_1',
                processed: false,
                anonymizedConnections: 0,
                retentionProcessedAt: null,
            },
        });
    });

    await page.route('**/api/admin/programs/program_1/approver-access', async (route) => {
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

    await page.goto('/manage');
    await expect(page.getByRole('heading', { name: 'Management login' })).toBeVisible();

    // Anonymous fetch to an admin report endpoint is denied before login.
    const unauthenticatedStatus = await page.evaluate(async () => {
        const res = await fetch('/api/admin/programs/program_1/report/summary', {
            headers: { accept: 'application/json' },
        });
        return res.status;
    });
    expect(unauthenticatedStatus).toBe(401);

    await page.getByLabel('Username').fill('admin');
    await page.getByRole('textbox', { name: 'Password' }).fill('admin-pass');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('heading', { name: 'Patna Event 2026' })).toBeVisible();

    await page.getByRole('link', { name: /Patna Event 2026/ }).click();

    // The current detail screen renders its operational sections continuously.
    await expect(page.getByRole('heading', { name: 'Languages' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Listeners', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Listeners', exact: true })).toContainText('18');
    const summaryPanel = page.getByLabel('Report summary');
    await expect(summaryPanel).toContainText('Active now');
    await expect(summaryPanel).toContainText('64');

    await expect(page.getByRole('img', { name: 'Listener QR' })).toBeVisible();
});
