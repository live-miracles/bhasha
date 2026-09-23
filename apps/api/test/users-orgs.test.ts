import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createApp } from '../src/index';
import { UsersRepository } from '../src/db/usersRepository';
import {
    adminCookie,
    ADMIN_TEST_EMAIL,
    buildTestEnv,
    DEFAULT_TEST_ORG_ID,
    ORG_ADMIN_TEST_EMAIL,
    seedOrg,
    seedOrgAdmin,
    seedPlatformAdmin,
    seedViewer,
    testEnv,
    VIEWER_TEST_EMAIL,
} from './test-env';

async function request(path: string, init: RequestInit = {}, requestEnv: Env = buildTestEnv()) {
    const app = createApp(requestEnv);
    const response = await app.fetch(new Request(`https://bhasha.test${path}`, init));
    return response;
}

describe('admin org & user management APIs', () => {
    beforeEach(async () => {
        await testEnv.DB.exec('DELETE FROM admin_sessions');
        await testEnv.DB.exec('DELETE FROM users');
        await testEnv.DB.exec('DELETE FROM orgs');
    });

    it('returns admin identity for /api/admin/me', async () => {
        const users = new UsersRepository(testEnv.DB);
        const platformId = await seedPlatformAdmin(buildTestEnv());
        const platformCookie = await adminCookie(ADMIN_TEST_EMAIL);

        const platformResponse = await request('/api/admin/me', {
            headers: { Cookie: platformCookie },
        });
        const platformBody = (await platformResponse.json()) as {
            id: string;
            email: string;
            role: 'platform_admin';
            orgId: string | null;
            orgName: string | null;
        };
        expect(platformResponse.status).toBe(200);
        expect(platformBody).toEqual({
            id: platformId,
            email: ADMIN_TEST_EMAIL,
            role: 'platform_admin',
            orgId: null,
            orgName: null,
        });

        const { userId, orgId } = await seedOrgAdmin(buildTestEnv(), {
            email: ORG_ADMIN_TEST_EMAIL,
        });
        const orgAdminCookie = await adminCookie(ORG_ADMIN_TEST_EMAIL);
        const orgAdminResponse = await request('/api/admin/me', {
            headers: { Cookie: orgAdminCookie },
        });
        const orgAdminBody = (await orgAdminResponse.json()) as {
            id: string;
            email: string;
            role: 'org_admin';
            orgId: string | null;
            orgName: string | null;
        };
        expect(orgAdminResponse.status).toBe(200);
        expect(orgAdminBody).toEqual({
            id: userId,
            email: ORG_ADMIN_TEST_EMAIL,
            role: 'org_admin',
            orgId,
            orgName: (await users.getOrg(orgId))?.name,
        });
    });

    it('POST /api/admin/orgs creates org+admin, and duplicate emails do not create orphan orgs', async () => {
        await seedPlatformAdmin(buildTestEnv());
        const cookie = await adminCookie(ADMIN_TEST_EMAIL);

        const first = await request('/api/admin/orgs', {
            method: 'POST',
            headers: { Cookie: cookie },
            body: JSON.stringify({
                orgName: 'Platform Hub',
                email: 'new-admin@test.local',
                tempPassword: 'very-strong-password',
            }),
        });
        const firstBody = (await first.json()) as {
            org: { id: string; name: string };
            admin: {
                id: string;
                email: string;
                role: 'org_admin';
                orgId: string;
            };
        };
        expect(first.status).toBe(201);
        expect(firstBody.org.name).toBe('Platform Hub');
        expect(firstBody.admin.role).toBe('org_admin');
        expect(firstBody.admin.orgId).toBe(firstBody.org.id);

        const users = new UsersRepository(testEnv.DB);
        const login = await request('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({
                email: 'new-admin@test.local',
                password: 'very-strong-password',
            }),
        });
        expect(login.status).toBe(200);

        const orgsBeforeDuplicate = (await users.listOrgs()).length;
        const duplicate = await request('/api/admin/orgs', {
            method: 'POST',
            headers: { Cookie: cookie },
            body: JSON.stringify({
                orgName: 'Another Tenant',
                email: 'new-admin@test.local',
                tempPassword: 'very-strong-password',
            }),
        });
        expect(duplicate.status).toBe(409);
        expect(await duplicate.json()).toEqual({ error: 'email_taken' });
        expect((await users.listOrgs()).length).toBe(orgsBeforeDuplicate);
    });

    it('blocks /api/admin/orgs for non-platform admins', async () => {
        await seedOrgAdmin(buildTestEnv(), { email: ORG_ADMIN_TEST_EMAIL });
        await seedViewer(buildTestEnv(), { email: VIEWER_TEST_EMAIL });
        const orgAdminCookie = await adminCookie(ORG_ADMIN_TEST_EMAIL);
        const viewerCookie = await adminCookie(VIEWER_TEST_EMAIL);

        const orgAdminDenied = await request('/api/admin/orgs', {
            method: 'POST',
            headers: { Cookie: orgAdminCookie },
            body: JSON.stringify({
                orgName: 'Rejected',
                email: 'should-not-work@test.local',
                tempPassword: 'very-strong-password',
            }),
        });
        expect(orgAdminDenied.status).toBe(403);

        const viewerDenied = await request('/api/admin/orgs', {
            method: 'POST',
            headers: { Cookie: viewerCookie },
            body: JSON.stringify({
                orgName: 'Rejected',
                email: 'viewer-should-not-work@test.local',
                tempPassword: 'very-strong-password',
            }),
        });
        expect(viewerDenied.status).toBe(403);
    });

    it('GET /api/admin/orgs lists for platform_admin, forbids others, and PATCH updates names', async () => {
        await seedPlatformAdmin(buildTestEnv());
        const platformCookie = await adminCookie(ADMIN_TEST_EMAIL);
        await seedOrgAdmin(buildTestEnv(), { email: ORG_ADMIN_TEST_EMAIL });
        const orgAdminCookie = await adminCookie(ORG_ADMIN_TEST_EMAIL);
        await seedViewer(buildTestEnv(), { email: VIEWER_TEST_EMAIL });
        const viewerCookie = await adminCookie(VIEWER_TEST_EMAIL);
        const seededOrg = await seedOrg(buildTestEnv(), {
            id: 'org_seeded',
            name: 'Seeded Tenant',
        });
        const platformList = await request('/api/admin/orgs', {
            headers: { Cookie: platformCookie },
        });
        const platformBody = (await platformList.json()) as {
            orgs: Array<{
                id: string;
                name: string;
                createdAt: string;
                updatedAt: string;
            }>;
        };
        expect(platformList.status).toBe(200);
        expect(platformBody.orgs).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: seededOrg.id,
                    name: 'Seeded Tenant',
                }),
            ]),
        );

        const orgAdminListForbidden = await request('/api/admin/orgs', {
            headers: { Cookie: orgAdminCookie },
        });
        expect(orgAdminListForbidden.status).toBe(403);

        const viewerListForbidden = await request('/api/admin/orgs', {
            headers: { Cookie: viewerCookie },
        });
        expect(viewerListForbidden.status).toBe(403);

        const rename = await request(`/api/admin/orgs/${seededOrg.id}`, {
            method: 'PATCH',
            headers: { Cookie: platformCookie },
            body: JSON.stringify({ name: 'Renamed Tenant' }),
        });
        expect(rename.status).toBe(200);
        const renameBody = (await rename.json()) as {
            id: string;
            name: string;
            createdAt: string;
            updatedAt: string;
        };
        expect(renameBody.name).toBe('Renamed Tenant');

        const missing = await request('/api/admin/orgs/org_missing', {
            method: 'PATCH',
            headers: { Cookie: platformCookie },
            body: JSON.stringify({ name: 'No Org' }),
        });
        expect(missing.status).toBe(404);
    });

    it('POST /api/admin/users enforces role/org scoping and email uniqueness', async () => {
        await seedOrgAdmin(buildTestEnv(), { orgId: DEFAULT_TEST_ORG_ID });
        await seedPlatformAdmin(buildTestEnv());
        const orgAdminCookie = await adminCookie(ORG_ADMIN_TEST_EMAIL);
        const platformCookie = await adminCookie(ADMIN_TEST_EMAIL);
        const tenant = await seedOrg(buildTestEnv(), {
            id: 'org_other_users',
            name: 'Other Tenant',
        });

        const platformViewer = await request('/api/admin/users', {
            method: 'POST',
            headers: { Cookie: platformCookie },
            body: JSON.stringify({
                email: 'platform-viewer@example.local',
                role: 'viewer',
                orgId: tenant.id,
                tempPassword: 'very-strong-password',
            }),
        });
        const platformViewerBody = (await platformViewer.json()) as {
            id: string;
            email: string;
            role: 'viewer';
            orgId: string;
            isDisabled: boolean;
            createdAt: string;
            updatedAt: string;
        };
        expect(platformViewer.status).toBe(201);
        expect(platformViewerBody.orgId).toBe(tenant.id);

        const orgAdminCannotCreateOrgAdmin = await request('/api/admin/users', {
            method: 'POST',
            headers: { Cookie: orgAdminCookie },
            body: JSON.stringify({
                email: 'org-admin-from-admin@test.local',
                role: 'org_admin',
                orgId: tenant.id,
                tempPassword: 'very-strong-password',
            }),
        });
        expect(orgAdminCannotCreateOrgAdmin.status).toBe(403);

        const orgAdminCreateViewer = await request('/api/admin/users', {
            method: 'POST',
            headers: { Cookie: orgAdminCookie },
            body: JSON.stringify({
                email: 'orgadmin-viewer@test.local',
                role: 'viewer',
                orgId: 'org_other_users',
                tempPassword: 'very-strong-password',
            }),
        });
        const orgAdminCreateBody = (await orgAdminCreateViewer.json()) as {
            id: string;
            email: string;
            role: 'viewer';
            orgId: string;
            isDisabled: boolean;
            createdAt: string;
            updatedAt: string;
        };
        expect(orgAdminCreateViewer.status).toBe(201);
        expect(orgAdminCreateBody.orgId).toBe(DEFAULT_TEST_ORG_ID);

        const platformCreateOrgAdmin = await request('/api/admin/users', {
            method: 'POST',
            headers: { Cookie: platformCookie },
            body: JSON.stringify({
                email: 'platform-created-admin@test.local',
                role: 'org_admin',
                orgId: tenant.id,
                tempPassword: 'very-strong-password',
            }),
        });
        const platformCreateOrgAdminBody = (await platformCreateOrgAdmin.json()) as {
            id: string;
            email: string;
            role: 'org_admin';
            orgId: string;
            isDisabled: boolean;
            createdAt: string;
            updatedAt: string;
        };
        expect(platformCreateOrgAdmin.status).toBe(201);
        expect(platformCreateOrgAdminBody.role).toBe('org_admin');
        expect(platformCreateOrgAdminBody.orgId).toBe(tenant.id);

        const platformSecondOrgAdmin = await request('/api/admin/users', {
            method: 'POST',
            headers: { Cookie: platformCookie },
            body: JSON.stringify({
                email: 'platform-second-admin@test.local',
                role: 'org_admin',
                orgId: tenant.id,
                tempPassword: 'very-strong-password',
            }),
        });
        expect(platformSecondOrgAdmin.status).toBe(409);
        expect(await platformSecondOrgAdmin.json()).toEqual({
            error: 'org_admin_exists',
        });

        const duplicateEmail = await request('/api/admin/users', {
            method: 'POST',
            headers: { Cookie: platformCookie },
            body: JSON.stringify({
                email: 'platform-viewer@example.local',
                role: 'viewer',
                orgId: tenant.id,
                tempPassword: 'very-strong-password',
            }),
        });
        expect(duplicateEmail.status).toBe(409);
        expect(await duplicateEmail.json()).toEqual({ error: 'email_taken' });

        const viewer = await seedViewer(buildTestEnv(), {
            email: VIEWER_TEST_EMAIL,
        });
        const viewerCookie = await adminCookie(VIEWER_TEST_EMAIL);
        const viewerCreateDenied = await request('/api/admin/users', {
            method: 'POST',
            headers: { Cookie: viewerCookie },
            body: JSON.stringify({
                email: 'viewer-forbidden@example.local',
                role: 'viewer',
                orgId: tenant.id,
                tempPassword: 'very-strong-password',
            }),
        });
        expect(viewerCreateDenied.status).toBe(403);
    });

    it('GET /api/admin/users returns scoped, sanitized users', async () => {
        const users = new UsersRepository(testEnv.DB);
        await seedPlatformAdmin(buildTestEnv());
        await seedOrgAdmin(buildTestEnv(), { orgId: DEFAULT_TEST_ORG_ID });
        await seedViewer(buildTestEnv(), { orgId: DEFAULT_TEST_ORG_ID });
        await seedOrg(buildTestEnv(), {
            id: 'org_users_other',
            name: 'Other Tenant',
        });
        await seedViewer(buildTestEnv(), {
            orgId: 'org_users_other',
            email: 'other-viewer@tenant.local',
        });
        await seedOrgAdmin(buildTestEnv(), {
            orgId: 'org_users_other',
            email: 'other-admin@tenant.local',
        });

        const platformCookie = await adminCookie(ADMIN_TEST_EMAIL);
        const platformUsers = await request('/api/admin/users', {
            headers: { Cookie: platformCookie },
        });
        const platformUsersBody = (await platformUsers.json()) as {
            users: Array<{
                id: string;
                email: string;
                role: 'platform_admin' | 'org_admin' | 'viewer';
                orgId: string | null;
                isDisabled: boolean;
                createdAt: string;
                updatedAt: string;
            }>;
        };
        expect(platformUsers.status).toBe(200);
        expect(platformUsersBody.users.length).toBe((await users.listUsers()).length);

        const orgAdminCookie = await adminCookie(ORG_ADMIN_TEST_EMAIL);
        const orgUsers = await request('/api/admin/users', {
            headers: { Cookie: orgAdminCookie },
        });
        const orgUsersBody = (await orgUsers.json()) as {
            users: Array<{
                id: string;
                email: string;
                role: 'viewer';
                orgId: string;
                isDisabled: boolean;
                createdAt: string;
                updatedAt: string;
            }>;
        };
        expect(orgUsers.status).toBe(200);
        expect(orgUsersBody.users.every((user: { role: string }) => user.role === 'viewer')).toBe(
            true,
        );
        expect(
            orgUsersBody.users.every(
                (user: { orgId: string }) => user.orgId === DEFAULT_TEST_ORG_ID,
            ),
        ).toBe(true);
        expect(
            orgUsersBody.users.some(
                (user: { email: string }) => user.email === 'other-viewer@tenant.local',
            ),
        ).toBe(false);

        const orgAdminUsersForSanitization = await request('/api/admin/users', {
            headers: { Cookie: orgAdminCookie },
        });
        const orgAdminUsersForOrg = (await orgAdminUsersForSanitization.json()) as {
            users: Array<Record<string, unknown>>;
        };
        for (const user of orgAdminUsersForOrg.users) {
            expect('passwordHash' in user).toBe(false);
            expect('passwordSalt' in user).toBe(false);
            expect('passwordIterations' in user).toBe(false);
        }

        const viewerCookie = await adminCookie(VIEWER_TEST_EMAIL);
        const viewerList = await request('/api/admin/users', {
            headers: { Cookie: viewerCookie },
        });
        expect(viewerList.status).toBe(403);
    });

    it('PATCH /api/admin/users enforces scope and revokes sessions', async () => {
        await seedPlatformAdmin(buildTestEnv());
        await seedOrgAdmin(buildTestEnv(), { orgId: DEFAULT_TEST_ORG_ID });
        const adminCookieDefault = await adminCookie(ORG_ADMIN_TEST_EMAIL);
        const viewer = await seedViewer(buildTestEnv(), {
            orgId: DEFAULT_TEST_ORG_ID,
            email: 'viewer-to-disable@test.local',
        });
        const viewerCookie = await adminCookie('viewer-to-disable@test.local');

        const disableOwnViewer = await request(`/api/admin/users/${viewer.userId}`, {
            method: 'PATCH',
            headers: { Cookie: adminCookieDefault },
            body: JSON.stringify({ isDisabled: true }),
        });
        expect(disableOwnViewer.status).toBe(200);
        const disabledSelfRequest = await request('/api/admin/me', {
            headers: { Cookie: viewerCookie },
        });
        expect(disabledSelfRequest.status).toBe(401);

        const otherOrgViewer = await seedViewer(buildTestEnv(), {
            orgId: 'org_other_scope',
            email: 'scope-other-viewer@test.local',
        });
        const otherOrgBlocked = await request(`/api/admin/users/${otherOrgViewer.userId}`, {
            method: 'PATCH',
            headers: { Cookie: adminCookieDefault },
            body: JSON.stringify({ isDisabled: true }),
        });
        expect(otherOrgBlocked.status).toBe(404);

        const roleChange = await request(`/api/admin/users/${viewer.userId}`, {
            method: 'PATCH',
            headers: { Cookie: adminCookieDefault },
            body: JSON.stringify({ role: 'viewer' }),
        });
        expect(roleChange.status).toBe(403);

        const otherOrgAdmin = await request(
            `/api/admin/users/${
                (
                    await seedOrgAdmin(buildTestEnv(), {
                        orgId: 'org_scope_other_admin',
                        email: 'other-admin@test.local',
                    })
                ).userId
            }`,
            {
                method: 'PATCH',
                headers: { Cookie: adminCookieDefault },
                body: JSON.stringify({ isDisabled: true }),
            },
        );
        // cross-org target is invisible to an org_admin → 404 not_found (not 403)
        expect(otherOrgAdmin.status).toBe(404);
        expect(await otherOrgAdmin.json()).toEqual({ error: 'not_found' });
    });

    it('platform PATCH rejects boundary-crossing role changes with 400 (not 500)', async () => {
        await seedPlatformAdmin(buildTestEnv());
        const platformCookie = await adminCookie(ADMIN_TEST_EMAIL);
        // an org-scoped viewer → platform_admin would need org_id=NULL (can't change
        // org_id here) → clean 400, never a DB CHECK 500.
        const orgViewer = await seedViewer(buildTestEnv(), {
            orgId: DEFAULT_TEST_ORG_ID,
            email: 'promote-me@test.local',
        });
        const promote = await request(`/api/admin/users/${orgViewer.userId}`, {
            method: 'PATCH',
            headers: { Cookie: platformCookie },
            body: JSON.stringify({ role: 'platform_admin' }),
        });
        expect(promote.status).toBe(400);

        // a platform_admin → org role would need a non-null org_id → 400.
        const otherPlatformId = await seedPlatformAdmin(
            buildTestEnv(),
            'second-platform@test.local',
        );
        const demote = await request(`/api/admin/users/${otherPlatformId}`, {
            method: 'PATCH',
            headers: { Cookie: platformCookie },
            body: JSON.stringify({ role: 'org_admin' }),
        });
        expect(demote.status).toBe(400);
    });

    it('POST /api/admin/users/:id/password resets password and revokes sessions', async () => {
        await seedPlatformAdmin(buildTestEnv());
        await seedOrgAdmin(buildTestEnv());
        const platformCookie = await adminCookie(ADMIN_TEST_EMAIL);
        const orgAdminCookie = await adminCookie(ORG_ADMIN_TEST_EMAIL);

        const targetViewer = await seedViewer(buildTestEnv(), {
            email: 'platform-target-viewer@tenant.local',
            orgId: DEFAULT_TEST_ORG_ID,
        });
        const targetViewerCookie = await adminCookie('platform-target-viewer@tenant.local');
        const resetByPlatform = await request(`/api/admin/users/${targetViewer.userId}/password`, {
            method: 'POST',
            headers: { Cookie: platformCookie },
            body: JSON.stringify({ newPassword: 'platform-reset-password' }),
        });
        expect(resetByPlatform.status).toBe(200);
        expect(await resetByPlatform.json()).toEqual({ ok: true });
        expect(
            (
                await request('/api/admin/me', {
                    headers: { Cookie: targetViewerCookie },
                })
            ).status,
        ).toBe(401);

        const orgViewer = await seedViewer(buildTestEnv(), {
            orgId: DEFAULT_TEST_ORG_ID,
            email: 'org-reset-viewer@tenant.local',
        });
        const orgViewerCookie = await adminCookie('org-reset-viewer@tenant.local');
        const orgAdminReset = await request(`/api/admin/users/${orgViewer.userId}/password`, {
            method: 'POST',
            headers: { Cookie: orgAdminCookie },
            body: JSON.stringify({ newPassword: 'org-admin-reset-password' }),
        });
        expect(orgAdminReset.status).toBe(200);
        expect(await orgAdminReset.json()).toEqual({ ok: true });
        expect(
            (await request('/api/admin/me', { headers: { Cookie: orgViewerCookie } })).status,
        ).toBe(401);

        const otherTenantViewer = await seedViewer(buildTestEnv(), {
            orgId: 'tenant_other_reset',
            email: 'other-reset-viewer@tenant.local',
        });
        const crossTenantReset = await request(
            `/api/admin/users/${otherTenantViewer.userId}/password`,
            {
                method: 'POST',
                headers: { Cookie: orgAdminCookie },
                body: JSON.stringify({ newPassword: 'cross-tenant-reset' }),
            },
        );
        expect(crossTenantReset.status).toBe(404);
    });
});

describe('PBKDF2 work factor (Workers runtime cap)', () => {
    it('keeps PBKDF2_ITERATIONS within the Cloudflare Workers 100k cap', async () => {
        const { PBKDF2_ITERATIONS, WORKERS_PBKDF2_MAX_ITERATIONS } =
            await import('../src/db/usersRepository');
        // Above this, prod workerd throws NotSupportedError (500) even though the
        // test pool does not enforce it. Must never regress above the cap.
        expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(WORKERS_PBKDF2_MAX_ITERATIONS);
        expect(WORKERS_PBKDF2_MAX_ITERATIONS).toBe(100_000);
    });
});
