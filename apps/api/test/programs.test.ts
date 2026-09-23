import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createApp } from '../src/index';
import { ProgramRepository } from '../src/db/programRepository';
import { sha256Hex } from '../src/auth/crypto';
import {
    ORG_ADMIN_TEST_EMAIL,
    VIEWER_TEST_EMAIL,
    adminCookie,
    buildTestEnv,
    seedOrg,
    seedOrgAdmin,
    seedPlatformAdmin,
    seedProgram,
    seedViewer,
    testEnv,
    DEFAULT_TEST_ORG_ID,
} from './test-env';

async function request(
    path: string,
    init: RequestInit = {},
    workerEnv: Env = buildTestEnv(),
): Promise<Response> {
    const app = createApp(workerEnv);
    return app.fetch(new Request(`https://bhasha.test${path}`, init));
}

async function seedProgramDetailGraph(): Promise<{
    programId: string;
    hindiStreamId: string;
    tamilStreamId: string;
    translatorId: string;
    translatorEmail: string;
    privateValues: string[];
}> {
    const now = new Date().toISOString();
    const programId = 'program_admin_detail';
    const hindiStreamId = 'stream_admin_hindi';
    const tamilStreamId = 'stream_admin_tamil';
    const translatorId = 'translator_admin_hindi';
    const translatorEmail = 'hindi@example.com';
    const passwordHash = `sha256:${await sha256Hex(
        'translator-password' + testEnv.TRANSLATOR_PASSWORD_PEPPER,
    )}`;

    await testEnv.DB.prepare(
        `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
        .bind(
            programId,
            'patna-event-2026',
            'Patna Event 2026',
            'Main Hall',
            '2026-08-01',
            'draft',
            'admin setup notes',
            now,
            now,
        )
        .run();

    for (const stream of [
        {
            id: tamilStreamId,
            languageName: 'Tamil',
            languageCode: 'ta',
            displayOrder: 2,
            isActive: 0,
            isLive: 1,
            cloudflareSessionId: 'cf_admin_secret_tamil_session',
            currentTrackId: 'tamil-secret-track',
        },
        {
            id: hindiStreamId,
            languageName: 'Hindi',
            languageCode: 'hi',
            displayOrder: 1,
            isActive: 1,
            isLive: 0,
            cloudflareSessionId: 'cf_admin_secret_hindi_session',
            currentTrackId: 'hindi-secret-track',
        },
    ]) {
        await testEnv.DB.prepare(
            `INSERT INTO language_streams
      (id, program_id, language_name, language_code, display_order, is_active,
       is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
            .bind(
                stream.id,
                programId,
                stream.languageName,
                stream.languageCode,
                stream.displayOrder,
                stream.isActive,
                stream.isLive,
                stream.cloudflareSessionId,
                stream.currentTrackId,
                now,
                now,
            )
            .run();
    }

    await testEnv.DB.prepare(
        `INSERT INTO translators
    (id, program_id, name, email, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
        .bind(translatorId, programId, 'Hindi translator', translatorEmail, passwordHash, now, now)
        .run();

    await testEnv.DB.prepare(
        `INSERT INTO translator_stream_assignments
    (program_id, translator_id, language_stream_id, created_at)
    VALUES (?, ?, ?, ?)`,
    )
        .bind(programId, translatorId, hindiStreamId, now)
        .run();

    return {
        programId,
        hindiStreamId,
        tamilStreamId,
        translatorId,
        translatorEmail,
        privateValues: [
            passwordHash,
            'cf_admin_secret_tamil_session',
            'cf_admin_secret_hindi_session',
            'tamil-secret-track',
            'hindi-secret-track',
        ],
    };
}

async function createProgram(
    _cookie?: string,
    overrides: Partial<{
        slug: string;
        name: string;
        venue: string;
        eventDate: string;
        adminNotes: string;
        accessControlEnabled: boolean;
    }> = {},
): Promise<{ id: string; slug: string }> {
    const authCookie = await adminCookie(ORG_ADMIN_TEST_EMAIL);
    const response = await request('/api/admin/programs', {
        method: 'POST',
        headers: { Cookie: authCookie },
        body: JSON.stringify({
            slug: 'patna-event-2026',
            name: 'Patna Event 2026',
            venue: 'Main Hall',
            eventDate: '2026-08-01',
            adminNotes: 'initial notes',
            ...overrides,
        }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string; slug: string };
}

async function createStream(
    cookie: string,
    programId: string,
    overrides: Partial<{
        languageName: string;
        languageCode: string;
        displayOrder: number;
        isActive: boolean;
    }> = {},
): Promise<{ id: string }> {
    const response = await request(`/api/admin/programs/${programId}/streams`, {
        method: 'POST',
        headers: { Cookie: cookie },
        body: JSON.stringify({
            languageName: 'Hindi',
            languageCode: 'hi',
            displayOrder: 1,
            isActive: true,
            ...overrides,
        }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string };
}

async function setProgramStatus(
    programId: string,
    status: 'draft' | 'live' | 'archived',
): Promise<void> {
    await testEnv.DB.prepare('UPDATE programs SET status = ? WHERE id = ?')
        .bind(status, programId)
        .run();
}

async function rowCount(table: string, programId: string): Promise<number> {
    const programColumn = table === 'programs' ? 'id' : 'program_id';
    const row = (await testEnv.DB.prepare(
        `SELECT COUNT(*) as count FROM ${table} WHERE ${programColumn} = ?`,
    )
        .bind(programId)
        .get()) as { count: number } | undefined;
    return row?.count ?? 0;
}

async function countLiveStreams(programId: string): Promise<number> {
    const row = (await testEnv.DB.prepare(
        `SELECT COUNT(*) as count FROM language_streams
     WHERE program_id = ? AND is_live = 1`,
    )
        .bind(programId)
        .get()) as { count: number } | undefined;
    return row?.count ?? 0;
}

async function deletedAt(programId: string): Promise<string | null> {
    const row = (await testEnv.DB.prepare(
        'SELECT deleted_at as deletedAt FROM programs WHERE id = ?',
    )
        .bind(programId)
        .get()) as { deletedAt: string | null } | undefined;

    return row?.deletedAt ?? null;
}

async function readProgramArchiveFields(programId: string): Promise<{
    archivedAt: string | null;
    retentionProcessedAt: string | null;
    aggregateSummaryJson: string | null;
}> {
    const row = (await testEnv.DB.prepare(
        'SELECT archived_at AS archivedAt, retention_processed_at AS retentionProcessedAt, aggregate_summary_json AS aggregateSummaryJson FROM programs WHERE id = ?',
    )
        .bind(programId)
        .get()) as
        | {
              archivedAt: string | null;
              retentionProcessedAt: string | null;
              aggregateSummaryJson: string | null;
          }
        | undefined;

    return {
        archivedAt: row?.archivedAt ?? null,
        retentionProcessedAt: row?.retentionProcessedAt ?? null,
        aggregateSummaryJson: row?.aggregateSummaryJson ?? null,
    };
}

async function readProgramFirstLiveAt(programId: string): Promise<string | null> {
    const row = (await testEnv.DB.prepare(
        'SELECT first_live_at AS firstLiveAt FROM programs WHERE id = ?',
    )
        .bind(programId)
        .get()) as { firstLiveAt: string | null } | undefined;

    return row?.firstLiveAt ?? null;
}

async function streamExists(programId: string, streamId: string): Promise<boolean> {
    const row = (await testEnv.DB.prepare(
        'SELECT id FROM language_streams WHERE program_id = ? AND id = ?',
    )
        .bind(programId, streamId)
        .get()) as { id: string } | undefined;
    return row !== undefined;
}

async function seedTranslator(programId: string, translatorId: string): Promise<void> {
    const now = new Date().toISOString();
    await testEnv.DB.prepare(
        `INSERT INTO translators
    (id, program_id, name, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
    )
        .bind(translatorId, programId, 'Stream translator', 'sha256:test', now, now)
        .run();
}

async function seedPublishSession(input: {
    id: string;
    programId: string;
    streamId: string;
    translatorId: string;
    state: 'reserved' | 'published' | 'closing' | 'closed' | 'failed';
    expiresAt: string;
    closedAt?: string | null;
}): Promise<void> {
    const now = new Date().toISOString();
    await testEnv.DB.prepare(
        `INSERT INTO realtime_publish_sessions
    (id, program_id, language_stream_id, translator_id, state, expires_at,
     closed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
        .bind(
            input.id,
            input.programId,
            input.streamId,
            input.translatorId,
            input.state,
            input.expiresAt,
            input.closedAt ?? null,
            now,
            now,
        )
        .run();
}

describe('program and stream admin API', () => {
    beforeEach(async () => {
        await testEnv.DB.exec('DELETE FROM listener_realtime_cleanup_targets');
        await testEnv.DB.exec('DELETE FROM realtime_publish_sessions');
        await testEnv.DB.exec('DELETE FROM translator_sessions');
        await testEnv.DB.exec('DELETE FROM admin_sessions');
        await testEnv.DB.exec('DELETE FROM stream_events');
        await testEnv.DB.exec('DELETE FROM listener_connections');
        await testEnv.DB.exec('DELETE FROM translator_stream_assignments');
        await testEnv.DB.exec('DELETE FROM translators');
        await testEnv.DB.exec('DELETE FROM language_streams');
        await testEnv.DB.exec('DELETE FROM programs');
        await seedPlatformAdmin(testEnv);
        await seedOrgAdmin(testEnv);
    });

    it('scopes admin program listing by org and enforces create permissions', async () => {
        const cookie = await adminCookie();
        await seedOrg(testEnv, { id: 'org_other', name: 'Org Other' });
        await seedOrgAdmin(testEnv, {
            orgId: 'org_other',
            email: 'other-admin@test.local',
        });

        const platformProgram = await seedProgram(testEnv, {
            slug: 'scope-platform',
            orgId: DEFAULT_TEST_ORG_ID,
            name: 'Platform Tenant',
        });
        const otherProgram = await seedProgram(testEnv, {
            slug: 'scope-other',
            orgId: 'org_other',
            name: 'Other Tenant',
        });

        const allPrograms = await request('/api/admin/programs', {
            headers: { Cookie: cookie },
        });

        expect(allPrograms.status).toBe(200);
        const list = (await allPrograms.json()) as {
            programs: { id: string; orgId: string | null }[];
        };
        expect(list.programs.map((program) => program.id)).toEqual(
            expect.arrayContaining([platformProgram.id, otherProgram.id]),
        );
    });

    it('allows org_admins to see only their own programs', async () => {
        const orgCookie = await adminCookie(ORG_ADMIN_TEST_EMAIL);
        await seedOrg(testEnv, { id: 'org_other', name: 'Org Other' });
        await seedOrgAdmin(testEnv, {
            orgId: 'org_other',
            email: 'other-admin@test.local',
        });

        const ownProgram = await seedProgram(testEnv, {
            slug: 'scope-admin-own',
            orgId: DEFAULT_TEST_ORG_ID,
            name: 'Own Tenant',
        });
        await seedProgram(testEnv, {
            slug: 'scope-admin-other',
            orgId: 'org_other',
            name: 'Other Tenant',
        });

        const response = await request('/api/admin/programs', {
            headers: { Cookie: orgCookie },
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            programs: { id: string; orgId: string | null }[];
        };
        expect(body.programs.map((program) => program.id)).toEqual(
            expect.arrayContaining([ownProgram.id]),
        );
        expect(body.programs.length).toBe(1);
    });

    it('allows viewers to see only their own org programs and blocks viewer POST', async () => {
        const viewer = await seedViewer(testEnv);
        const viewerCookie = await adminCookie(VIEWER_TEST_EMAIL);
        await seedOrg(testEnv, { id: 'org_other', name: 'Org Other' });

        const ownProgram = await seedProgram(testEnv, {
            slug: 'scope-viewer-own',
            orgId: viewer.orgId,
            name: 'Viewer Tenant',
        });
        await seedProgram(testEnv, {
            slug: 'scope-viewer-other',
            orgId: 'org_other',
            name: 'Viewer Other',
        });

        const response = await request('/api/admin/programs', {
            headers: { Cookie: viewerCookie },
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            programs: { id: string; orgId: string | null }[];
        };
        expect(body.programs.map((program) => program.id)).toEqual(
            expect.arrayContaining([ownProgram.id]),
        );
        expect(body.programs.length).toBe(1);

        const blockedCreate = await request('/api/admin/programs', {
            method: 'POST',
            headers: { Cookie: viewerCookie },
            body: JSON.stringify({
                slug: 'viewer-attempt',
                name: 'Viewer Attempt',
                venue: 'Main Hall',
                eventDate: '2026-08-01',
            }),
        });

        expect(blockedCreate.status).toBe(403);
        expect(await blockedCreate.json()).toEqual({
            error: 'forbidden',
            message: 'only an org admin can create programs',
        });
    });

    it('requires org-admin for POST /programs', async () => {
        const platformCookie = await adminCookie();
        const blocked = await request('/api/admin/programs', {
            method: 'POST',
            headers: { Cookie: platformCookie },
            body: JSON.stringify({
                slug: 'platform-create-forbidden',
                name: 'Forbidden Platform Create',
                venue: 'Main Hall',
                eventDate: '2026-08-01',
            }),
        });

        expect(blocked.status).toBe(403);
        expect(await blocked.json()).toEqual({
            error: 'forbidden',
            message: 'only an org admin can create programs',
        });
    });

    it('allows org_admins to create programs and persists orgId', async () => {
        const orgAdminCookie = await adminCookie(ORG_ADMIN_TEST_EMAIL);
        const orgAdmin = await seedOrgAdmin(testEnv);

        const response = await request('/api/admin/programs', {
            method: 'POST',
            headers: { Cookie: orgAdminCookie },
            body: JSON.stringify({
                slug: `org-admin-create-${crypto.randomUUID()}`,
                name: 'New Admin Program',
                venue: 'Main Hall',
                eventDate: '2026-08-01',
            }),
        });

        expect(response.status).toBe(201);
        const body = (await response.json()) as { orgId: string; slug: string };
        expect(body.orgId).toBe(orgAdmin.orgId);
    });

    it('composes deleted filter with org scope', async () => {
        const orgAdminCookie = await adminCookie(ORG_ADMIN_TEST_EMAIL);
        await seedOrg(testEnv, { id: 'org_other', name: 'Org Other' });
        // A DELETED program in ANOTHER org: it satisfies deletedOnly, so only the
        // org filter can keep it out of this org_admin's deleted list. This is what
        // proves the two filters COMPOSE (not that deletedOnly alone hides it).
        const otherDeleted = await seedProgram(testEnv, {
            slug: 'scope-deleted-other',
            orgId: 'org_other',
            name: 'Other Org Deleted',
        });

        const ownActive = await seedProgram(testEnv, {
            slug: 'scope-deleted-own-active',
            orgId: DEFAULT_TEST_ORG_ID,
            name: 'Own Active',
        });
        const ownDeleted = await seedProgram(testEnv, {
            slug: 'scope-deleted-own',
            orgId: DEFAULT_TEST_ORG_ID,
            name: 'Own Deleted',
        });

        const deletedAt = new Date().toISOString();
        await testEnv.DB.prepare('UPDATE programs SET deleted_at = ? WHERE id IN (?, ?)')
            .bind(deletedAt, ownDeleted.id, otherDeleted.id)
            .run();

        const response = await request('/api/admin/programs?deleted=true', {
            headers: { Cookie: orgAdminCookie },
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            programs: { id: string; orgId: string | null }[];
        };
        const ids = body.programs.map((program) => program.id);
        expect(ids).toEqual(expect.arrayContaining([ownDeleted.id]));
        // org filter composes: the OTHER org's deleted program is absent...
        expect(ids).not.toContain(otherDeleted.id);
        // ...and the deleted filter composes: own ACTIVE program is absent too.
        expect(ids).not.toContain(ownActive.id);
        // every returned row belongs to this org_admin's org
        expect(body.programs.every((program) => program.orgId === DEFAULT_TEST_ORG_ID)).toBe(true);
    });

    it('creates and reads a program', async () => {
        const cookie = await adminCookie(ORG_ADMIN_TEST_EMAIL);
        const create = await request('/api/admin/programs', {
            method: 'POST',
            headers: { Cookie: cookie },
            body: JSON.stringify({
                slug: 'patna-event-2026',
                name: 'Patna Event 2026',
                venue: 'Main Hall',
                eventDate: '2026-08-01',
                accessControlEnabled: true,
            }),
        });

        expect(create.status).toBe(201);
        const created = (await create.json()) as {
            id: string;
            slug: string;
            accessControlEnabled: boolean;
        };
        expect(created.slug).toBe('patna-event-2026');
        expect(created.accessControlEnabled).toBe(true);

        const list = await request('/api/admin/programs', {
            headers: { Cookie: cookie },
        });

        expect(list.status).toBe(200);
        expect(await list.json()).toMatchObject({
            programs: [
                {
                    id: created.id,
                    slug: 'patna-event-2026',
                    accessControlEnabled: true,
                },
            ],
        });

        const patch = await request(`/api/admin/programs/${created.id}`, {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: JSON.stringify({ accessControlEnabled: false }),
        });
        expect(patch.status).toBe(200);
        expect(await patch.json()).toMatchObject({
            program: { accessControlEnabled: false },
        });
    });

    it('returns a conflict when a program slug already exists', async () => {
        const cookie = await adminCookie(ORG_ADMIN_TEST_EMAIL);
        const body = JSON.stringify({
            slug: 'patna-event-2026',
            name: 'Patna Event 2026',
            venue: 'Main Hall',
            eventDate: '2026-08-01',
        });

        const first = await request('/api/admin/programs', {
            method: 'POST',
            headers: { Cookie: cookie },
            body,
        });
        expect(first.status).toBe(201);

        const duplicate = await request('/api/admin/programs', {
            method: 'POST',
            headers: { Cookie: cookie },
            body,
        });

        expect(duplicate.status).toBe(409);
        expect(await duplicate.json()).toEqual({ error: 'program_slug_exists' });
    });

    it('adds a language stream to a program and returns static metadata only', async () => {
        const cookie = await adminCookie(ORG_ADMIN_TEST_EMAIL);
        const createProgram = await request('/api/admin/programs', {
            method: 'POST',
            headers: { Cookie: cookie },
            body: JSON.stringify({
                slug: 'patna-event-2026',
                name: 'Patna Event 2026',
                venue: 'Main Hall',
                eventDate: '2026-08-01',
            }),
        });
        const program = (await createProgram.json()) as { id: string };

        const createStream = await request(`/api/admin/programs/${program.id}/streams`, {
            method: 'POST',
            headers: { Cookie: cookie },
            body: JSON.stringify({
                languageName: 'Hindi',
                languageCode: 'hi',
                displayOrder: 1,
                isActive: true,
            }),
        });

        expect(createStream.status).toBe(201);
        const body = await createStream.json();
        expect(body).toEqual({
            id: expect.any(String),
            languageName: 'Hindi',
            languageCode: 'hi',
            displayOrder: 1,
            isActive: true,
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
        });
        expect(body).not.toHaveProperty('programId');
        expect(body).not.toHaveProperty('isLive');
        expect(body).not.toHaveProperty('cloudflareSessionId');
        expect(body).not.toHaveProperty('currentTrackId');
    });

    it('returns not found when adding a stream to a missing program', async () => {
        const cookie = await adminCookie();
        const createStream = await request('/api/admin/programs/program_missing/streams', {
            method: 'POST',
            headers: { Cookie: cookie },
            body: JSON.stringify({
                languageName: 'Hindi',
                languageCode: 'hi',
                displayOrder: 1,
                isActive: true,
            }),
        });

        expect(createStream.status).toBe(404);
        expect(await createStream.json()).toEqual({ error: 'program_not_found' });
    });

    it('returns validation errors for malformed program create JSON', async () => {
        const cookie = await adminCookie(ORG_ADMIN_TEST_EMAIL);
        const create = await request('/api/admin/programs', {
            method: 'POST',
            headers: { Cookie: cookie },
            body: '{',
        });

        expect(create.status).toBe(400);
        expect(await create.json()).toEqual({ error: 'invalid_json' });
    });

    it('returns validation errors for invalid stream input', async () => {
        const cookie = await adminCookie(ORG_ADMIN_TEST_EMAIL);
        const createProgram = await request('/api/admin/programs', {
            method: 'POST',
            headers: { Cookie: cookie },
            body: JSON.stringify({
                slug: 'patna-event-2026',
                name: 'Patna Event 2026',
                venue: 'Main Hall',
                eventDate: '2026-08-01',
            }),
        });
        const program = (await createProgram.json()) as { id: string };

        const createStream = await request(`/api/admin/programs/${program.id}/streams`, {
            method: 'POST',
            headers: { Cookie: cookie },
            body: JSON.stringify({
                languageName: 'Hindi',
                languageCode: 'Hindi',
                displayOrder: 1,
                isActive: true,
            }),
        });

        expect(createStream.status).toBe(400);
        expect(await createStream.json()).toEqual({
            error: 'validation_error',
            message: 'languageCode must be a supported language code',
        });
    });

    it('creates a stream for a live program', async () => {
        // NOTE(slice-3): this used to also assert a Cloudflare Realtime relay
        // "ensure" call fired on stream creation. Relay orchestration was removed
        // from routes/admin.ts in the Node/better-sqlite3 migration (TODO(slice-3)
        // marks the call site) with no replacement yet, so only the DB-visible
        // behavior (stream creation still succeeds for a live program) remains.
        const cookie = await adminCookie();
        const program = await createProgram(cookie);
        await setProgramStatus(program.id, 'live');

        const response = await request(`/api/admin/programs/${program.id}/streams`, {
            method: 'POST',
            headers: { Cookie: cookie },
            body: JSON.stringify({
                languageName: 'Hindi',
                languageCode: 'hi',
                displayOrder: 1,
                isActive: true,
            }),
        });

        expect(response.status).toBe(201);
    });

    it('lists active and inactive streams sorted by display order with static metadata', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);
        const english = await createStream(cookie, program.id, {
            languageName: 'English',
            languageCode: 'en',
            displayOrder: 2,
            isActive: true,
        });
        const tamil = await createStream(cookie, program.id, {
            languageName: 'Tamil',
            languageCode: 'ta',
            displayOrder: 1,
            isActive: false,
        });
        const bengali = await createStream(cookie, program.id, {
            languageName: 'Bengali',
            languageCode: 'bn',
            displayOrder: 3,
            isActive: true,
        });
        await testEnv.DB.prepare(
            `UPDATE language_streams
      SET is_live = 1,
          cloudflare_session_id = ?,
          current_track_id = ?
      WHERE id = ?`,
        )
            .bind('cf_secret_session', 'secret-track', tamil.id)
            .run();

        const list = await request(`/api/admin/programs/${program.id}/streams`, {
            headers: { Cookie: cookie },
        });

        expect(list.status).toBe(200);
        const body = await list.json();
        expect(body).toEqual({
            streams: [
                {
                    id: tamil.id,
                    languageName: 'Tamil',
                    languageCode: 'ta',
                    displayOrder: 1,
                    isActive: false,
                    createdAt: expect.any(String),
                    updatedAt: expect.any(String),
                },
                {
                    id: english.id,
                    languageName: 'English',
                    languageCode: 'en',
                    displayOrder: 2,
                    isActive: true,
                    createdAt: expect.any(String),
                    updatedAt: expect.any(String),
                },
                {
                    id: bengali.id,
                    languageName: 'Bengali',
                    languageCode: 'bn',
                    displayOrder: 3,
                    isActive: true,
                    createdAt: expect.any(String),
                    updatedAt: expect.any(String),
                },
            ],
        });

        const text = JSON.stringify(body);
        expect(text).not.toContain('isLive');
        expect(text).not.toContain('cloudflareSessionId');
        expect(text).not.toContain('currentTrackId');
        expect(text).not.toContain('cf_secret_session');
        expect(text).not.toContain('secret-track');
    });

    it('returns program_not_found when listing streams for a missing program', async () => {
        const cookie = await adminCookie();

        const list = await request('/api/admin/programs/program_missing/streams', {
            headers: { Cookie: cookie },
        });

        expect(list.status).toBe(404);
        expect(await list.json()).toEqual({ error: 'program_not_found' });
    });

    it('patches stream metadata and returns a normalized stream payload', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);
        const stream = await createStream(cookie, program.id);
        await testEnv.DB.prepare(
            `UPDATE language_streams
      SET is_live = 1,
          cloudflare_session_id = ?,
          current_track_id = ?
      WHERE program_id = ?
        AND id = ?`,
        )
            .bind('cf_patch_secret_session', 'patch-secret-track', program.id, stream.id)
            .run();

        const patch = await request(`/api/admin/programs/${program.id}/streams/${stream.id}`, {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: JSON.stringify({
                languageName: 'Marathi',
                languageCode: 'mr',
                displayOrder: 7,
                isActive: false,
            }),
        });

        expect(patch.status).toBe(200);
        const body = await patch.json();
        expect(body).toEqual({
            id: stream.id,
            languageName: 'Marathi',
            languageCode: 'mr',
            displayOrder: 7,
            isActive: false,
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
        });

        const text = JSON.stringify(body);
        expect(text).not.toContain('isLive');
        expect(text).not.toContain('cloudflareSessionId');
        expect(text).not.toContain('currentTrackId');
        expect(text).not.toContain('cf_patch_secret_session');
        expect(text).not.toContain('patch-secret-track');
    });

    it('returns program_not_found when patching a stream for a missing program', async () => {
        const cookie = await adminCookie();

        const patch = await request('/api/admin/programs/program_missing/streams/stream_missing', {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: JSON.stringify({ languageCode: 'kn' }),
        });

        expect(patch.status).toBe(404);
        expect(await patch.json()).toEqual({ error: 'program_not_found' });
    });

    it('returns stream_not_found when patching a stream outside the program', async () => {
        const cookie = await adminCookie();
        const sourceProgram = await createProgram(cookie);
        const otherProgram = await createProgram(cookie, {
            slug: 'other-program',
            eventDate: '2026-08-02',
        });
        const stream = await createStream(cookie, sourceProgram.id);

        const patch = await request(`/api/admin/programs/${otherProgram.id}/streams/${stream.id}`, {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: JSON.stringify({ languageCode: 'kn' }),
        });

        expect(patch.status).toBe(404);
        expect(await patch.json()).toEqual({ error: 'stream_not_found' });
    });

    it('returns validation errors for invalid stream patch input', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);
        const stream = await createStream(cookie, program.id);

        const patch = await request(`/api/admin/programs/${program.id}/streams/${stream.id}`, {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: JSON.stringify({ languageCode: 'Hindi' }),
        });

        expect(patch.status).toBe(400);
        expect(await patch.json()).toEqual({
            error: 'validation_error',
            message: 'languageCode must be a supported language code',
        });
    });

    it('deletes an unused stream and removes the row', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);
        const stream = await createStream(cookie, program.id);

        const deleted = await request(`/api/admin/programs/${program.id}/streams/${stream.id}`, {
            method: 'DELETE',
            headers: { Cookie: cookie },
        });

        expect(deleted.status).toBe(204);
        expect(await streamExists(program.id, stream.id)).toBe(false);
        expect(await rowCount('programs', program.id)).toBe(1);
    });

    it('deletes streams regardless of program status', async () => {
        // NOTE(slice-3): this used to also assert a relay "teardown" call fired
        // for each delete. Relay orchestration has been removed (see the
        // TODO(slice-3) comment at the DELETE stream route); only the DB-visible
        // behavior (deletion succeeds for both live and archived programs)
        // remains meaningful here.
        const cookie = await adminCookie();
        const liveProgram = await createProgram(cookie, {
            slug: 'relay-live-program',
            eventDate: '2026-08-02',
        });
        const archivedProgram = await createProgram(cookie, {
            slug: 'relay-archived-program',
            eventDate: '2026-08-03',
        });

        const liveStream = await createStream(cookie, liveProgram.id, {
            languageCode: 'en',
        });
        const archivedStream = await createStream(cookie, archivedProgram.id, {
            languageCode: 'ta',
        });

        await setProgramStatus(liveProgram.id, 'live');
        await setProgramStatus(archivedProgram.id, 'archived');

        const liveDelete = await request(
            `/api/admin/programs/${liveProgram.id}/streams/${liveStream.id}`,
            {
                method: 'DELETE',
                headers: { Cookie: cookie },
            },
        );
        expect(liveDelete.status).toBe(204);

        const archivedDelete = await request(
            `/api/admin/programs/${archivedProgram.id}/streams/${archivedStream.id}`,
            {
                method: 'DELETE',
                headers: { Cookie: cookie },
            },
        );
        expect(archivedDelete.status).toBe(204);
    });

    it('returns program_not_found when deleting a stream for a missing program', async () => {
        const cookie = await adminCookie();

        const deleted = await request(
            '/api/admin/programs/program_missing/streams/stream_missing',
            {
                method: 'DELETE',
                headers: { Cookie: cookie },
            },
        );

        expect(deleted.status).toBe(404);
        expect(await deleted.json()).toEqual({ error: 'program_not_found' });
    });

    it('returns stream_not_found when deleting a stream outside the program', async () => {
        const cookie = await adminCookie();
        const sourceProgram = await createProgram(cookie);
        const otherProgram = await createProgram(cookie, {
            slug: 'delete-other-program',
            eventDate: '2026-08-02',
        });
        const stream = await createStream(cookie, sourceProgram.id);

        const deleted = await request(
            `/api/admin/programs/${otherProgram.id}/streams/${stream.id}`,
            {
                method: 'DELETE',
                headers: { Cookie: cookie },
            },
        );

        expect(deleted.status).toBe(404);
        expect(await deleted.json()).toEqual({ error: 'stream_not_found' });
        expect(await streamExists(sourceProgram.id, stream.id)).toBe(true);
    });

    it('deletes an unused stream when only an expired realtime publish session remains', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);
        const stream = await createStream(cookie, program.id);
        const translatorId = 'translator_expired_publish_delete';
        await seedTranslator(program.id, translatorId);
        await seedPublishSession({
            id: 'realtime_publish_expired_delete',
            programId: program.id,
            streamId: stream.id,
            translatorId,
            state: 'reserved',
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
        });

        const deleted = await request(`/api/admin/programs/${program.id}/streams/${stream.id}`, {
            method: 'DELETE',
            headers: { Cookie: cookie },
        });

        expect(deleted.status).toBe(204);
        expect(await streamExists(program.id, stream.id)).toBe(false);
    });

    it('rejects deleting a stream with listener history', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);
        const stream = await createStream(cookie, program.id);
        const now = new Date().toISOString();
        await testEnv.DB.prepare(
            `INSERT INTO listener_connections
      (id, program_id, language_stream_id, client_id, token_issued_at,
       subscription_status, listener_ip, user_agent, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
            .bind(
                'listener_stream_delete_history',
                program.id,
                stream.id,
                'client_stream_delete_history',
                now,
                'connected',
                '203.0.113.12',
                'test-agent',
                now,
                now,
            )
            .run();

        const deleted = await request(`/api/admin/programs/${program.id}/streams/${stream.id}`, {
            method: 'DELETE',
            headers: { Cookie: cookie },
        });

        expect(deleted.status).toBe(409);
        expect(await deleted.json()).toEqual({ error: 'stream_has_history' });
        expect(await streamExists(program.id, stream.id)).toBe(true);
    });

    it('rejects deleting a stream with stream event history', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);
        const stream = await createStream(cookie, program.id);
        const now = new Date().toISOString();
        await testEnv.DB.prepare(
            `INSERT INTO stream_events
      (id, program_id, stream_program_id, language_stream_id, event_type,
       occurred_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
            .bind(
                'stream_delete_event_history',
                program.id,
                program.id,
                stream.id,
                'translator_connected',
                now,
                '{}',
            )
            .run();

        const deleted = await request(`/api/admin/programs/${program.id}/streams/${stream.id}`, {
            method: 'DELETE',
            headers: { Cookie: cookie },
        });

        expect(deleted.status).toBe(409);
        expect(await deleted.json()).toEqual({ error: 'stream_has_history' });
        expect(await streamExists(program.id, stream.id)).toBe(true);
    });

    it('rejects deleting a stream with current live state or an active realtime publish session', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);
        const liveStream = await createStream(cookie, program.id, {
            languageName: 'Live Hindi',
            languageCode: 'hi',
            displayOrder: 1,
        });
        const sessionPointerStream = await createStream(cookie, program.id, {
            languageName: 'Session English',
            languageCode: 'en',
            displayOrder: 2,
        });
        const activePublishStream = await createStream(cookie, program.id, {
            languageName: 'Reserved Tamil',
            languageCode: 'ta',
            displayOrder: 3,
        });
        const publishedPublishStream = await createStream(cookie, program.id, {
            languageName: 'Published Bengali',
            languageCode: 'bn',
            displayOrder: 4,
        });
        const closingPublishStream = await createStream(cookie, program.id, {
            languageName: 'Closing Telugu',
            languageCode: 'te',
            displayOrder: 5,
        });
        const expiresAt = new Date(Date.now() + 60_000).toISOString();

        await testEnv.DB.prepare(
            `UPDATE language_streams
      SET is_live = 1,
          cloudflare_session_id = ?,
          current_track_id = ?
      WHERE id = ?`,
        )
            .bind('cf_live_session', 'live-track', liveStream.id)
            .run();
        await testEnv.DB.prepare(
            `UPDATE language_streams
      SET cloudflare_session_id = ?
      WHERE id = ?`,
        )
            .bind('cf_current_session', sessionPointerStream.id)
            .run();
        await seedTranslator(program.id, 'translator_stream_delete_lock');
        await seedPublishSession({
            id: 'realtime_publish_reserved_delete_lock',
            programId: program.id,
            streamId: activePublishStream.id,
            translatorId: 'translator_stream_delete_lock',
            state: 'reserved',
            expiresAt,
        });
        await seedPublishSession({
            id: 'realtime_publish_published_delete_lock',
            programId: program.id,
            streamId: publishedPublishStream.id,
            translatorId: 'translator_stream_delete_lock',
            state: 'published',
            expiresAt,
        });
        await seedPublishSession({
            id: 'realtime_publish_closing_delete_lock',
            programId: program.id,
            streamId: closingPublishStream.id,
            translatorId: 'translator_stream_delete_lock',
            state: 'closing',
            expiresAt,
        });

        for (const stream of [
            liveStream,
            sessionPointerStream,
            activePublishStream,
            publishedPublishStream,
            closingPublishStream,
        ]) {
            const deleted = await request(
                `/api/admin/programs/${program.id}/streams/${stream.id}`,
                {
                    method: 'DELETE',
                    headers: { Cookie: cookie },
                },
            );

            expect(deleted.status).toBe(409);
            expect(await deleted.json()).toEqual({ error: 'stream_delete_locked' });
            expect(await streamExists(program.id, stream.id)).toBe(true);
        }
    });

    it('returns static admin program detail with all streams, translator assignments, URLs, and QR metadata', async () => {
        const cookie = await adminCookie();
        const {
            programId,
            hindiStreamId,
            tamilStreamId,
            translatorId,
            translatorEmail,
            privateValues,
        } = await seedProgramDetailGraph();

        const detail = await request(`/api/admin/programs/${programId}`, {
            headers: { Cookie: cookie },
        });

        expect(detail.status).toBe(200);
        const body = await detail.json();
        expect(body).toEqual({
            program: {
                id: programId,
                slug: 'patna-event-2026',
                name: 'Patna Event 2026',
                venue: 'Main Hall',
                eventDate: '2026-08-01',
                status: 'draft',
                accessControlEnabled: false,
                adminNotes: 'admin setup notes',
                orgId: null,
                createdAt: expect.any(String),
                updatedAt: expect.any(String),
                firstLiveAt: null,
                archivedAt: null,
                retentionProcessedAt: null,
                aggregateSummaryJson: null,
            },
            streams: [
                {
                    id: hindiStreamId,
                    languageName: 'Hindi',
                    languageCode: 'hi',
                    displayOrder: 1,
                    isActive: true,
                    createdAt: expect.any(String),
                    updatedAt: expect.any(String),
                },
                {
                    id: tamilStreamId,
                    languageName: 'Tamil',
                    languageCode: 'ta',
                    displayOrder: 2,
                    isActive: false,
                    createdAt: expect.any(String),
                    updatedAt: expect.any(String),
                },
            ],
            translators: [
                {
                    id: translatorId,
                    email: translatorEmail,
                    name: 'Hindi translator',
                    assignments: [
                        {
                            streamId: hindiStreamId,
                            languageName: 'Hindi',
                            languageCode: 'hi',
                        },
                    ],
                },
            ],
            urls: {
                listenerUrl: 'https://bhasha.test/patna-event-2026',
                translatorUrl: 'https://bhasha.test/patna-event-2026/translate',
                volunteerUrl: 'https://bhasha.test/patna-event-2026/volunteer',
            },
            qrPayload: 'https://bhasha.test/patna-event-2026',
            suggestedQrFilename: 'patna-event-2026-listener-qr.png',
        });

        const text = JSON.stringify(body);
        expect(text).not.toContain('isLive');
        expect(text).not.toContain('currentTrackId');
        expect(text).not.toContain('cloudflareSessionId');
        expect(text).not.toContain('activeListeners');
        expect(text).not.toContain('listenerCount');
        expect(text).not.toContain('stale');
        expect(text).not.toContain('degraded');
        for (const privateValue of privateValues) {
            expect(text).not.toContain(privateValue);
        }
    });

    it('returns program_not_found for missing admin program detail', async () => {
        const cookie = await adminCookie();

        const detail = await request('/api/admin/programs/program_missing', {
            headers: { Cookie: cookie },
        });

        expect(detail.status).toBe(404);
        expect(await detail.json()).toEqual({ error: 'program_not_found' });
    });

    it('stamps first_live_at on first go-live and preserves it across cycles', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);

        const firstLive = await request(`/api/admin/programs/${program.id}`, {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: JSON.stringify({ status: 'live' }),
        });
        expect(firstLive.status).toBe(200);
        const firstLiveBody = (await firstLive.json()) as {
            program: { firstLiveAt: string | null };
        };
        expect(firstLiveBody.program.firstLiveAt).not.toBeNull();
        const stampedAt = firstLiveBody.program.firstLiveAt as string;

        const draft = await request(`/api/admin/programs/${program.id}`, {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: JSON.stringify({ status: 'draft' }),
        });
        expect(draft.status).toBe(200);

        const secondLive = await request(`/api/admin/programs/${program.id}`, {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: JSON.stringify({ status: 'live' }),
        });
        expect(secondLive.status).toBe(200);
        const secondLiveBody = (await secondLive.json()) as {
            program: { firstLiveAt: string | null };
        };
        expect(secondLiveBody.program.firstLiveAt).toBe(stampedAt);
    });

    it('keeps slug locked in draft for programs that have ever been live', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);

        const firstLive = await request(`/api/admin/programs/${program.id}`, {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: JSON.stringify({ status: 'live' }),
        });
        expect(firstLive.status).toBe(200);
        expect(await readProgramFirstLiveAt(program.id)).not.toBeNull();

        const draft = await request(`/api/admin/programs/${program.id}`, {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: JSON.stringify({ status: 'draft' }),
        });
        expect(draft.status).toBe(200);

        const slugChange = await request(`/api/admin/programs/${program.id}`, {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: JSON.stringify({ nextSlug: 'live-then-back' }),
        });

        expect(slugChange.status).toBe(409);
        expect(await slugChange.json()).toEqual({ error: 'program_slug_locked' });
    });

    it('does not clear firstLiveAt when leaving archived', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);

        const firstLive = await request(`/api/admin/programs/${program.id}`, {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: JSON.stringify({ status: 'live' }),
        });
        expect(firstLive.status).toBe(200);
        const firstLiveBody = (await firstLive.json()) as {
            program: { firstLiveAt: string | null };
        };
        const stampedAt = firstLiveBody.program.firstLiveAt;

        const archived = await request(`/api/admin/programs/${program.id}`, {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: JSON.stringify({ status: 'archived' }),
        });
        expect(archived.status).toBe(200);
        const archivedBody = (await archived.json()) as {
            program: { firstLiveAt: string | null };
        };
        expect(archivedBody.program.firstLiveAt).toBe(stampedAt);

        const draft = await request(`/api/admin/programs/${program.id}`, {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: JSON.stringify({ status: 'draft' }),
        });
        expect(draft.status).toBe(200);
        const draftBody = (await draft.json()) as {
            program: { firstLiveAt: string | null };
        };
        expect(draftBody.program.firstLiveAt).toBe(stampedAt);
    });

    // NOTE(slice-3): this suite used to have four tests here asserting that
    // status transitions (draft->live, live->draft, unchanged, and errored)
    // drove a Cloudflare Realtime relay ensure/teardown call. Relay
    // orchestration has been removed from the PATCH status route (see the
    // TODO(slice-3) comment there) with no replacement, so those relay-only
    // assertions no longer apply. Status persistence itself is already covered
    // by "keeps slug locked in draft for programs that have ever been live",
    // "does not clear firstLiveAt when leaving archived", and
    // "patches mutable program metadata and returns updated URL and QR
    // metadata" below.

    it('patches mutable program metadata and returns updated URL and QR metadata', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);

        const patch = await request(`/api/admin/programs/${program.id}`, {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: JSON.stringify({
                name: 'Updated Patna Event',
                venue: 'Auditorium',
                eventDate: '2026-08-15',
                adminNotes: 'Updated notes',
                status: 'live',
                accessControlEnabled: false,
            }),
        });

        expect(patch.status).toBe(200);
        expect(await patch.json()).toMatchObject({
            program: {
                id: program.id,
                slug: 'patna-event-2026',
                name: 'Updated Patna Event',
                venue: 'Auditorium',
                eventDate: '2026-08-15',
                status: 'live',
                adminNotes: 'Updated notes',
                accessControlEnabled: false,
            },
            urls: {
                listenerUrl: 'https://bhasha.test/patna-event-2026',
                translatorUrl: 'https://bhasha.test/patna-event-2026/translate',
                volunteerUrl: 'https://bhasha.test/patna-event-2026/volunteer',
            },
            qrPayload: 'https://bhasha.test/patna-event-2026',
            suggestedQrFilename: 'patna-event-2026-listener-qr.png',
        });
    });

    it('rejects ordinary patch attempts to mutate slug', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);

        const patch = await request(`/api/admin/programs/${program.id}`, {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: JSON.stringify({ slug: 'new-public-slug' }),
        });

        expect(patch.status).toBe(400);
        expect(await patch.json()).toEqual({ error: 'slug_immutable' });
    });

    it('renames a draft program with nextSlug and updates URL and QR metadata', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);

        const patch = await request(`/api/admin/programs/${program.id}`, {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: JSON.stringify({ nextSlug: 'patna-event-final' }),
        });

        expect(patch.status).toBe(200);
        expect(await patch.json()).toMatchObject({
            program: {
                id: program.id,
                slug: 'patna-event-final',
            },
            urls: {
                listenerUrl: 'https://bhasha.test/patna-event-final',
                translatorUrl: 'https://bhasha.test/patna-event-final/translate',
            },
            qrPayload: 'https://bhasha.test/patna-event-final',
            suggestedQrFilename: 'patna-event-final-listener-qr.png',
        });
    });

    it('rejects duplicate nextSlug with program_slug_exists', async () => {
        const cookie = await adminCookie();
        const first = await createProgram(cookie);
        await createProgram(cookie, {
            slug: 'already-used-slug',
            eventDate: '2026-08-02',
        });

        const patch = await request(`/api/admin/programs/${first.id}`, {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: JSON.stringify({ nextSlug: 'already-used-slug' }),
        });

        expect(patch.status).toBe(409);
        expect(await patch.json()).toEqual({ error: 'program_slug_exists' });
    });

    it('rejects nextSlug changes after draft status', async () => {
        const cookie = await adminCookie();
        const liveProgram = await createProgram(cookie, {
            slug: 'live-program',
            eventDate: '2026-08-02',
        });
        const archivedProgram = await createProgram(cookie, {
            slug: 'archived-program',
            eventDate: '2026-08-03',
        });
        await setProgramStatus(liveProgram.id, 'live');
        await setProgramStatus(archivedProgram.id, 'archived');

        for (const program of [liveProgram, archivedProgram]) {
            const patch = await request(`/api/admin/programs/${program.id}`, {
                method: 'PATCH',
                headers: { Cookie: cookie },
                body: JSON.stringify({ nextSlug: `${program.slug}-renamed` }),
            });

            expect(patch.status).toBe(409);
            expect(await patch.json()).toEqual({ error: 'program_slug_locked' });
        }
    });

    it('rejects any nextSlug field after draft status even when unchanged', async () => {
        const cookie = await adminCookie();
        const liveProgram = await createProgram(cookie, {
            slug: 'live-unchanged-slug',
            eventDate: '2026-08-02',
        });
        const archivedProgram = await createProgram(cookie, {
            slug: 'archived-unchanged-slug',
            eventDate: '2026-08-03',
        });
        await setProgramStatus(liveProgram.id, 'live');
        await setProgramStatus(archivedProgram.id, 'archived');

        for (const program of [liveProgram, archivedProgram]) {
            const patch = await request(`/api/admin/programs/${program.id}`, {
                method: 'PATCH',
                headers: { Cookie: cookie },
                body: JSON.stringify({ nextSlug: program.slug }),
            });

            expect(patch.status).toBe(409);
            expect(await patch.json()).toEqual({ error: 'program_slug_locked' });
        }
    });

    it('allows returning non-draft programs to draft status', async () => {
        const cookie = await adminCookie();
        const liveProgram = await createProgram(cookie, {
            slug: 'live-status-locked',
            eventDate: '2026-08-02',
        });
        const archivedProgram = await createProgram(cookie, {
            slug: 'archived-status-locked',
            eventDate: '2026-08-03',
        });
        await setProgramStatus(liveProgram.id, 'live');
        await setProgramStatus(archivedProgram.id, 'archived');

        for (const program of [liveProgram, archivedProgram] as const) {
            const patch = await request(`/api/admin/programs/${program.id}`, {
                method: 'PATCH',
                headers: { Cookie: cookie },
                body: JSON.stringify({ status: 'draft' }),
            });

            expect(patch.status).toBe(200);
            expect(await patch.json()).toMatchObject({
                program: {
                    id: program.id,
                    status: 'draft',
                },
            });

            const detail = await request(`/api/admin/programs/${program.id}`, {
                headers: { Cookie: cookie },
            });
            expect(await detail.json()).toMatchObject({
                program: { id: program.id, status: 'draft' },
            });
        }
    });

    it('archives a used program and preserves listener and event history', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);
        const stream = await createStream(cookie, program.id);
        const now = new Date().toISOString();
        await testEnv.DB.prepare(
            `INSERT INTO listener_connections
      (id, program_id, language_stream_id, client_id, token_issued_at,
       subscription_status, listener_ip, user_agent, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
            .bind(
                'listener_archive_history',
                program.id,
                stream.id,
                'client_archive_history',
                now,
                'connected',
                '203.0.113.10',
                'test-agent',
                now,
                now,
            )
            .run();
        await testEnv.DB.prepare(
            `INSERT INTO stream_events
      (id, program_id, stream_program_id, language_stream_id, event_type,
       occurred_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
            .bind(
                'stream_event_archive_history',
                program.id,
                program.id,
                stream.id,
                'listener_subscribed',
                now,
                '{}',
            )
            .run();

        const archive = await request(`/api/admin/programs/${program.id}/archive`, {
            method: 'POST',
            headers: { Cookie: cookie },
        });

        expect(archive.status).toBe(200);
        expect(await archive.json()).toMatchObject({
            program: {
                id: program.id,
                status: 'archived',
            },
        });
        expect(await rowCount('listener_connections', program.id)).toBe(1);
        expect(await rowCount('stream_events', program.id)).toBe(1);
    });

    it("clears all program streams' live state on archive", async () => {
        // NOTE(slice-3): this used to also assert a relay "teardown" call fired
        // for the active stream. Relay orchestration has been removed from the
        // archive route (TODO(slice-3) comment there); the DB-visible behavior
        // (all streams' is_live cleared) is unaffected and still asserted below.
        const cookie = await adminCookie();
        const program = await createProgram(cookie);
        const activeStream = await createStream(cookie, program.id);
        await createStream(cookie, program.id, {
            isActive: false,
        });
        const now = new Date().toISOString();
        await testEnv.DB.prepare(
            `UPDATE language_streams
      SET is_live = 1,
          cloudflare_session_id = ?,
          current_track_id = ?,
          updated_at = ?
      WHERE program_id = ?`,
        )
            .bind(`cf_${activeStream.id}`, `track_${activeStream.id}`, now, program.id)
            .run();

        await setProgramStatus(program.id, 'live');
        const archive = await request(`/api/admin/programs/${program.id}/archive`, {
            method: 'POST',
            headers: { Cookie: cookie },
        });

        expect(archive.status).toBe(200);
        expect(await countLiveStreams(program.id)).toBe(0);
    });

    it('re-archives after un-archive and refreshes retention fields', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);

        const firstArchive = await request(`/api/admin/programs/${program.id}/archive`, {
            method: 'POST',
            headers: { Cookie: cookie },
        });
        expect(firstArchive.status).toBe(200);

        const firstArchiveFields = await readProgramArchiveFields(program.id);
        expect(firstArchiveFields.archivedAt).not.toBeNull();
        expect(firstArchiveFields.retentionProcessedAt).toBeNull();
        const firstArchivedAt = firstArchiveFields.archivedAt;

        await testEnv.DB.prepare(
            `UPDATE programs
      SET retention_processed_at = ?
      WHERE id = ?`,
        )
            .bind('2026-01-01T00:00:00.000Z', program.id)
            .run();

        const unarchive = await request(`/api/admin/programs/${program.id}`, {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: JSON.stringify({ status: 'live' }),
        });
        expect(unarchive.status).toBe(200);

        const unarchivedFields = await readProgramArchiveFields(program.id);
        expect(unarchivedFields.archivedAt).toBeNull();
        expect(unarchivedFields.retentionProcessedAt).toBeNull();
        expect(unarchivedFields.aggregateSummaryJson).toBeNull();

        await new Promise((resolve) => setTimeout(resolve, 20));

        const secondArchive = await request(`/api/admin/programs/${program.id}/archive`, {
            method: 'POST',
            headers: { Cookie: cookie },
        });
        expect(secondArchive.status).toBe(200);

        const secondArchiveFields = await readProgramArchiveFields(program.id);
        expect(secondArchiveFields.archivedAt).not.toBeNull();
        expect(secondArchiveFields.archivedAt).not.toEqual(firstArchivedAt);
        expect(secondArchiveFields.retentionProcessedAt).toBeNull();
    });

    it('hard-deletes only a draft program with no listener or stream event history', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);
        await createStream(cookie, program.id);

        const deleted = await request(`/api/admin/programs/${program.id}`, {
            method: 'DELETE',
            headers: { Cookie: cookie },
        });

        expect(deleted.status).toBe(204);
        expect(await rowCount('programs', program.id)).toBe(0);
        expect(await rowCount('language_streams', program.id)).toBe(0);
    });

    it('lists active programs by default and deleted-only programs when requested', async () => {
        const cookie = await adminCookie();
        const activeProgram = await createProgram(cookie);
        const softDeletedProgram = await createProgram(cookie, {
            slug: 'patna-event-2027',
            eventDate: '2026-08-02',
        });
        const deletedAt = new Date().toISOString();
        await testEnv.DB.prepare('UPDATE programs SET status = ?, deleted_at = ? WHERE id = ?')
            .bind('live', deletedAt, softDeletedProgram.id)
            .run();

        const programs = new ProgramRepository(testEnv.DB);
        const activePrograms = await programs.listPrograms();
        const deletedPrograms = await programs.listPrograms({ deletedOnly: true });

        expect(activePrograms).toHaveLength(1);
        expect(activePrograms[0]?.id).toBe(activeProgram.id);
        expect(deletedPrograms).toHaveLength(1);
        expect(deletedPrograms[0]?.id).toBe(softDeletedProgram.id);

        const adminActive = await request('/api/admin/programs', {
            headers: { Cookie: cookie },
        });
        const activeBody = (await adminActive.json()) as {
            programs: { id: string }[];
        };
        expect(activeBody.programs.some((program) => program.id === activeProgram.id)).toBe(true);
        expect(activeBody.programs.some((program) => program.id === softDeletedProgram.id)).toBe(
            false,
        );

        const adminDeleted = await request('/api/admin/programs?deleted=true', {
            headers: { Cookie: cookie },
        });
        const deletedBody = (await adminDeleted.json()) as {
            programs: { id: string }[];
        };
        expect(deletedBody.programs.some((program) => program.id === softDeletedProgram.id)).toBe(
            true,
        );
        expect(deletedBody.programs.some((program) => program.id === activeProgram.id)).toBe(false);
    });

    it('returns previousStatus from updateProgram', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);

        const programs = new ProgramRepository(testEnv.DB);
        const archived = await programs.updateProgram(program.id, {
            status: 'archived',
        });
        expect(archived.previousStatus).toBe('draft');
        expect(archived.record.id).toBe(program.id);
        expect(archived.record.status).toBe('archived');

        const live = await programs.updateProgram(program.id, { status: 'live' });
        expect(live.previousStatus).toBe('archived');
        expect(live.record.id).toBe(program.id);
        expect(live.record.status).toBe('live');
    });

    it('soft-deletes non-draft programs', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);
        await setProgramStatus(program.id, 'live');

        const deleted = await request(`/api/admin/programs/${program.id}`, {
            method: 'DELETE',
            headers: { Cookie: cookie },
        });

        expect(deleted.status).toBe(200);
        expect(await deletedAt(program.id)).not.toBeNull();
        expect(await rowCount('programs', program.id)).toBe(1);

        const programs = await request('/api/admin/programs', {
            headers: { Cookie: cookie },
        });
        const body = (await programs.json()) as { programs: { id: string }[] };
        expect(body.programs.some((listed) => listed.id === program.id)).toBe(false);

        const detail = await request(`/api/admin/programs/${program.id}`, {
            headers: { Cookie: cookie },
        });
        expect(detail.status).toBe(404);
        expect(await detail.json()).toEqual({ error: 'program_not_found' });
    });

    it('soft-deletes a live program and clears all stream is_live', async () => {
        // NOTE(slice-3): this used to also assert relay "teardown" calls fired
        // for each live stream. Relay orchestration has been removed from the
        // soft-delete route (TODO(slice-3) comment there); the DB-visible
        // behavior (soft-delete + is_live cleared) is unaffected and still
        // asserted below.
        const cookie = await adminCookie();
        const program = await createProgram(cookie);
        const hindiStream = await createStream(cookie, program.id, {
            languageName: 'Hindi',
            languageCode: 'hi',
        });
        const tamilStream = await createStream(cookie, program.id, {
            languageName: 'Tamil',
            languageCode: 'ta',
        });
        await setProgramStatus(program.id, 'live');
        await testEnv.DB.prepare(
            `UPDATE language_streams
      SET is_live = 1,
          cloudflare_session_id = ?,
          current_track_id = ?,
          updated_at = ?
      WHERE id = ? OR id = ?`,
        )
            .bind(
                `cf_${hindiStream.id}`,
                `track_${hindiStream.id}`,
                new Date().toISOString(),
                hindiStream.id,
                tamilStream.id,
            )
            .run();

        await testEnv.DB.prepare(
            `UPDATE language_streams
      SET is_live = 1,
          cloudflare_session_id = ?,
          current_track_id = ?,
          updated_at = ?
      WHERE id = ?`,
        )
            .bind(
                `cf_${tamilStream.id}`,
                `track_${tamilStream.id}`,
                new Date().toISOString(),
                tamilStream.id,
            )
            .run();

        const deleted = await request(`/api/admin/programs/${program.id}`, {
            method: 'DELETE',
            headers: { Cookie: cookie },
        });

        expect(deleted.status).toBe(200);
        expect(await deletedAt(program.id)).not.toBeNull();
        expect(await countLiveStreams(program.id)).toBe(0);
    });

    it('hard-deletes draft programs and soft-deletes archived programs on delete', async () => {
        const cookie = await adminCookie();
        const draftProgram = await createProgram(cookie);
        const draftStream = await createStream(cookie, draftProgram.id);
        const archivedProgram = await createProgram(cookie, {
            slug: 'draft-or-archived-program',
            eventDate: '2026-08-02',
        });
        await createStream(cookie, archivedProgram.id);
        await setProgramStatus(archivedProgram.id, 'archived');

        const draftDelete = await request(`/api/admin/programs/${draftProgram.id}`, {
            method: 'DELETE',
            headers: { Cookie: cookie },
        });
        expect(draftDelete.status).toBe(204);
        expect(await streamExists(draftProgram.id, draftStream.id)).toBe(false);

        const archivedDelete = await request(`/api/admin/programs/${archivedProgram.id}`, {
            method: 'DELETE',
            headers: { Cookie: cookie },
        });
        expect(archivedDelete.status).toBe(200);
        expect(await deletedAt(archivedProgram.id)).not.toBeNull();
    });

    it('restores a soft-deleted program', async () => {
        const cookie = await adminCookie();
        const program = await createProgram(cookie);
        await setProgramStatus(program.id, 'live');
        await createStream(cookie, program.id);

        const deleted = await request(`/api/admin/programs/${program.id}`, {
            method: 'DELETE',
            headers: { Cookie: cookie },
        });
        expect(deleted.status).toBe(200);
        expect(await deletedAt(program.id)).not.toBeNull();

        const restored = await request(`/api/admin/programs/${program.id}/restore`, {
            method: 'POST',
            headers: { Cookie: cookie },
        });

        expect(restored.status).toBe(200);
        expect(await deletedAt(program.id)).toBeNull();

        const detail = await request(`/api/admin/programs/${program.id}`, {
            headers: { Cookie: cookie },
        });
        expect(detail.status).toBe(200);
    });

    // NOTE(slice-3): three tests used to live here asserting that restoring a
    // soft-deleted program drove a relay "ensure" call for each active stream
    // (for a live program), and that draft/archived restores and a failing
    // relay call did not break the 200 response. Relay orchestration has been
    // removed from the restore route (TODO(slice-3) comment there) with no
    // replacement, so those relay-only assertions no longer apply. The
    // remaining DB-visible behavior (restore succeeds and clears deleted_at)
    // is already covered by "restores a soft-deleted program" above.

    it('rejects hard-delete for draft programs with listener or stream event history', async () => {
        const cookie = await adminCookie();
        const listenerProgram = await createProgram(cookie, {
            slug: 'listener-history',
            eventDate: '2026-08-02',
        });
        const listenerStream = await createStream(cookie, listenerProgram.id);
        const eventProgram = await createProgram(cookie, {
            slug: 'event-history',
            eventDate: '2026-08-03',
        });
        const eventStream = await createStream(cookie, eventProgram.id);
        const now = new Date().toISOString();
        await testEnv.DB.prepare(
            `INSERT INTO listener_connections
      (id, program_id, language_stream_id, client_id, token_issued_at,
       subscription_status, listener_ip, user_agent, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
            .bind(
                'listener_delete_history',
                listenerProgram.id,
                listenerStream.id,
                'client_delete_history',
                now,
                'requested',
                '203.0.113.11',
                'test-agent',
                now,
                now,
            )
            .run();
        await testEnv.DB.prepare(
            `INSERT INTO stream_events
      (id, program_id, stream_program_id, language_stream_id, event_type,
       occurred_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
            .bind(
                'stream_event_delete_history',
                eventProgram.id,
                eventProgram.id,
                eventStream.id,
                'listener_subscribed',
                now,
                '{}',
            )
            .run();

        for (const program of [listenerProgram, eventProgram]) {
            const deleted = await request(`/api/admin/programs/${program.id}`, {
                method: 'DELETE',
                headers: { Cookie: cookie },
            });

            expect(deleted.status).toBe(409);
            expect(await deleted.json()).toEqual({ error: 'program_has_history' });
            expect(await rowCount('programs', program.id)).toBe(1);
        }
    });
});
