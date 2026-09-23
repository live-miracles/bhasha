import { beforeEach, describe, expect, it } from 'vitest';

import { ListenerAccessRepository } from '../src/db/listenerAccessRepository';
import { createApp } from '../src/index';
import { adminCookie, buildTestEnv, seedAdmin, seedProgram, seedUser, testEnv } from './test-env';

async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const app = createApp(buildTestEnv());
    return app.fetch(new Request(`https://bhasha.test${path}`, init));
}

async function resetDb(): Promise<void> {
    await testEnv.DB.exec('DELETE FROM listener_access');
    await testEnv.DB.exec('DELETE FROM admin_sessions');
    await testEnv.DB.exec('DELETE FROM language_streams');
    await testEnv.DB.exec('DELETE FROM programs');
    await testEnv.DB.exec('DELETE FROM users');
}

describe('admin listener access routes', () => {
    beforeEach(resetDb);

    it('returns pending, approved, and revoked counts for a program', async () => {
        await seedAdmin(testEnv);
        const program = await seedProgram(testEnv);
        const repo = new ListenerAccessRepository(testEnv.DB);
        const pending = await repo.createClaim(program.id, 'client_pending');
        const approved = await repo.createClaim(program.id, 'client_approved');
        const revoked = await repo.createClaim(program.id, 'client_revoked');
        await repo.approveClaim(program.id, { claimId: approved.claimId }, 'scan');
        await repo.approveClaim(program.id, { claimId: revoked.claimId }, 'code');
        await repo.revokeForClient(program.id, 'client_revoked');
        const cookie = await adminCookie();

        expect(pending.shortCode).toHaveLength(6);

        const response = await request(
            `/api/admin/programs/${program.id}/listener-access/summary`,
            { method: 'GET', headers: { Cookie: cookie } },
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            pending: 1,
            approved: 1,
            revoked: 1,
        });
    });

    it('lets the owning user read and revoke, but a non-owning user gets 404 on both', async () => {
        const ownerId = await seedUser(testEnv, 'owner_user');
        const program = await seedProgram(testEnv, { createdBy: ownerId });
        await seedUser(testEnv, 'other_user');
        const ownerCookie = await adminCookie('owner_user');
        const otherCookie = await adminCookie('other_user');

        const ownerRead = await request(
            `/api/admin/programs/${program.id}/listener-access/summary`,
            { method: 'GET', headers: { Cookie: ownerCookie } },
        );
        expect(ownerRead.status).toBe(200);

        const ownerWrite = await request(
            `/api/admin/programs/${program.id}/listener-access/revoke`,
            {
                method: 'POST',
                headers: { Cookie: ownerCookie },
                body: JSON.stringify({ clientId: 'client_1' }),
            },
        );
        expect(ownerWrite.status).toBe(200);

        const otherRead = await request(
            `/api/admin/programs/${program.id}/listener-access/summary`,
            { method: 'GET', headers: { Cookie: otherCookie } },
        );
        expect(otherRead.status).toBe(404);

        const otherWrite = await request(
            `/api/admin/programs/${program.id}/listener-access/revoke`,
            {
                method: 'POST',
                headers: { Cookie: otherCookie },
                body: JSON.stringify({ clientId: 'client_1' }),
            },
        );
        expect(otherWrite.status).toBe(404);
    });

    it('revokes all client rows and validates the clientId payload', async () => {
        await seedAdmin(testEnv);
        const program = await seedProgram(testEnv);
        const repo = new ListenerAccessRepository(testEnv.DB);
        const claim = await repo.createClaim(program.id, 'client_1');
        await repo.approveClaim(program.id, { claimId: claim.claimId }, 'scan');
        await repo.createClaim(program.id, 'client_1');
        const cookie = await adminCookie();

        const badRequest = await request(
            `/api/admin/programs/${program.id}/listener-access/revoke`,
            {
                method: 'POST',
                headers: { Cookie: cookie },
                body: JSON.stringify({}),
            },
        );
        expect(badRequest.status).toBe(400);
        expect(await badRequest.json()).toEqual({ error: 'validation_error' });

        const response = await request(`/api/admin/programs/${program.id}/listener-access/revoke`, {
            method: 'POST',
            headers: { Cookie: cookie },
            body: JSON.stringify({ clientId: 'client_1' }),
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ revoked: 2 });
        expect(await repo.countByStatus(program.id)).toEqual({
            pending: 0,
            approved: 0,
            revoked: 2,
        });
    });
});
