import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
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
                        activeListeners: 1,
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
                ],
                urls: {
                    listenerUrl: 'https://bhasha.test/patna-event-2026',
                    translatorUrl: 'https://bhasha.test/patna-event-2026/translate',
                },
            },
        });
    });
});

test('admin route smoke', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByRole('main', { name: 'Admin dashboard' })).toBeVisible();
});

test('listener route smoke', async ({ page }) => {
    await page.goto('/patna-event-2026');
    await expect(page.getByRole('main', { name: 'Listener shell' })).toBeVisible();
    await expect(page.getByText('Patna Event 2026')).toBeVisible();
});

test('translator route smoke', async ({ page }) => {
    await page.goto('/patna-event-2026/translate');
    await expect(page.getByRole('main', { name: 'Translator shell' })).toBeVisible();
    await expect(page.getByText('patna-event-2026')).toBeVisible();
});

test('missing route smoke', async ({ page }) => {
    await page.goto('/missing/path');
    await expect(page.getByRole('main', { name: 'Not found' })).toBeVisible();
});
