import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/index';
import { buildTestEnv, testEnv } from './test-env';

async function request(path: string, init: RequestInit = {}) {
    const app = createApp(buildTestEnv());
    return app.fetch(new Request(`https://bhasha.test${path}`, init));
}

async function seedProgramWithStreams(
    programStatus: 'live' | 'draft' | 'archived' = 'live',
): Promise<{
    programId: string;
    hindiStreamId: string;
    englishStreamId: string;
    privateRealtimeValues: string[];
}> {
    const now = new Date().toISOString();
    const programId = 'program_public_contract';
    const hindiStreamId = 'stream_public_hindi';
    const englishStreamId = 'stream_public_english';
    const inactiveStreamId = 'stream_public_tamil';

    await testEnv.DB.prepare(
        `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, access_control_enabled,
     created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
        programId,
        'patna-event-2026',
        'Patna Event 2026',
        'Main Hall',
        '2026-07-01',
        programStatus,
        'admin-only notes',
        now,
        now,
    );

    for (const stream of [
        {
            id: inactiveStreamId,
            languageName: 'Tamil',
            nativeName: 'தமிழ்',
            languageCode: 'ta',
            displayOrder: 0,
            isActive: 0,
            isLive: 1,
            cloudflareSessionId: 'cf_secret_inactive_session',
            currentTrackId: 'inactive-track',
        },
        {
            id: englishStreamId,
            languageName: 'English',
            nativeName: 'English',
            languageCode: 'en',
            displayOrder: 2,
            isActive: 1,
            isLive: 1,
            cloudflareSessionId: 'cf_secret_english_session',
            currentTrackId: 'english-track',
        },
        {
            id: hindiStreamId,
            languageName: 'Hindi',
            nativeName: 'हिन्दी',
            languageCode: 'hi',
            displayOrder: 1,
            isActive: 1,
            isLive: 0,
            cloudflareSessionId: null,
            currentTrackId: null,
        },
    ]) {
        await testEnv.DB.prepare(
            `INSERT INTO language_streams
      (id, program_id, language_name, native_name, language_code, display_order, is_active,
       is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            stream.id,
            programId,
            stream.languageName,
            stream.nativeName,
            stream.languageCode,
            stream.displayOrder,
            stream.isActive,
            stream.isLive,
            stream.cloudflareSessionId,
            stream.currentTrackId,
            now,
            now,
        );
    }

    return {
        programId,
        hindiStreamId,
        englishStreamId,
        privateRealtimeValues: [
            'cf_secret_inactive_session',
            'cf_secret_english_session',
            'inactive-track',
            'english-track',
        ],
    };
}

describe('public program contract', () => {
    beforeEach(async () => {
        await testEnv.DB.exec('DELETE FROM listener_realtime_cleanup_targets');
        await testEnv.DB.exec('DELETE FROM realtime_publish_sessions');
        await testEnv.DB.exec('DELETE FROM translator_sessions');
        await testEnv.DB.exec('DELETE FROM stream_events');
        await testEnv.DB.exec('DELETE FROM listener_connections');
        await testEnv.DB.exec('DELETE FROM admin_sessions');
        await testEnv.DB.exec('DELETE FROM translator_stream_assignments');
        await testEnv.DB.exec('DELETE FROM translators');
        await testEnv.DB.exec('DELETE FROM language_streams');
        await testEnv.DB.exec('DELETE FROM programs');
    });

    it('returns metadata-only public program details with sorted active streams and same-origin URLs', async () => {
        const { hindiStreamId, englishStreamId, privateRealtimeValues } =
            await seedProgramWithStreams();

        const response = await request('/api/public/programs/patna-event-2026');

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({
            program: {
                slug: 'patna-event-2026',
                name: 'Patna Event 2026',
                venue: 'Main Hall',
                eventDate: '2026-07-01',
                status: 'live',
                accessControlEnabled: true,
                listenable: true,
                notListenableReason: null,
            },
            streams: [
                {
                    id: hindiStreamId,
                    languageName: 'Hindi',
                    nativeName: 'हिन्दी',
                    languageCode: 'hi',
                    displayOrder: 1,
                    isActive: true,
                },
                {
                    id: englishStreamId,
                    languageName: 'English',
                    nativeName: 'English',
                    languageCode: 'en',
                    displayOrder: 2,
                    isActive: true,
                },
            ],
            urls: {
                listenerUrl: 'https://bhasha.test/patna-event-2026',
                translatorUrl: 'https://bhasha.test/patna-event-2026/translate',
                volunteerUrl: 'https://bhasha.test/patna-event-2026/volunteer',
            },
        });

        const text = JSON.stringify(body);
        expect(text).not.toContain('program_public_contract');
        expect(text).not.toContain('admin-only notes');
        expect(text).not.toContain('state');
        expect(text).not.toContain('isLive');
        expect(text).not.toContain('currentTrackId');
        expect(text).not.toContain('activeListeners');
        expect(text).not.toContain('listenerIp');
        expect(text).not.toContain('userAgent');
        expect(text).not.toContain('passwordHash');
        expect(text).not.toContain('cloudflareSessionId');
        for (const value of privateRealtimeValues) {
            expect(text).not.toContain(value);
        }
    });

    it('returns not-listenable state for a draft public program', async () => {
        const { hindiStreamId, englishStreamId } = await seedProgramWithStreams('draft');

        const response = await request('/api/public/programs/patna-event-2026');

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({
            program: {
                slug: 'patna-event-2026',
                name: 'Patna Event 2026',
                venue: 'Main Hall',
                eventDate: '2026-07-01',
                status: 'draft',
                accessControlEnabled: true,
                listenable: false,
                notListenableReason: 'not_started',
            },
            streams: [
                {
                    id: hindiStreamId,
                    languageName: 'Hindi',
                    nativeName: 'हिन्दी',
                    languageCode: 'hi',
                    displayOrder: 1,
                    isActive: true,
                },
                {
                    id: englishStreamId,
                    languageName: 'English',
                    nativeName: 'English',
                    languageCode: 'en',
                    displayOrder: 2,
                    isActive: true,
                },
            ],
            urls: {
                listenerUrl: 'https://bhasha.test/patna-event-2026',
                translatorUrl: 'https://bhasha.test/patna-event-2026/translate',
                volunteerUrl: 'https://bhasha.test/patna-event-2026/volunteer',
            },
        });
    });

    it('returns not-listenable state for an archived public program', async () => {
        const { hindiStreamId, englishStreamId } = await seedProgramWithStreams('archived');

        const response = await request('/api/public/programs/patna-event-2026');

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({
            program: {
                slug: 'patna-event-2026',
                name: 'Patna Event 2026',
                venue: 'Main Hall',
                eventDate: '2026-07-01',
                status: 'archived',
                accessControlEnabled: true,
                listenable: false,
                notListenableReason: 'ended',
            },
            streams: [
                {
                    id: hindiStreamId,
                    languageName: 'Hindi',
                    nativeName: 'हिन्दी',
                    languageCode: 'hi',
                    displayOrder: 1,
                    isActive: true,
                },
                {
                    id: englishStreamId,
                    languageName: 'English',
                    nativeName: 'English',
                    languageCode: 'en',
                    displayOrder: 2,
                    isActive: true,
                },
            ],
            urls: {
                listenerUrl: 'https://bhasha.test/patna-event-2026',
                translatorUrl: 'https://bhasha.test/patna-event-2026/translate',
                volunteerUrl: 'https://bhasha.test/patna-event-2026/volunteer',
            },
        });
    });

    it('returns program_not_found for a soft-deleted public program', async () => {
        const { programId } = await seedProgramWithStreams();
        await testEnv.DB.prepare(
            'UPDATE programs SET deleted_at = ?, updated_at = ? WHERE id = ?',
        ).run(new Date().toISOString(), new Date().toISOString(), programId);

        const response = await request('/api/public/programs/patna-event-2026');
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'program_not_found' });
    });

    it('returns program_not_found for an unknown public slug', async () => {
        const response = await request('/api/public/programs/missing-program');

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'program_not_found' });
    });

    it('returns program_not_found for a malformed percent-encoded public slug', async () => {
        const response = await request('/api/public/programs/%E0%A4%A');

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'program_not_found' });
    });
});
