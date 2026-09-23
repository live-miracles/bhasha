import { beforeEach, describe, expect, it } from 'vitest';

import { ProgramRepository } from '../src/db/programRepository';
import type { UserAuth } from '../src/auth/adminAuth';
import { requireProgramAccess } from '../src/auth/programAccess';
import { DEFAULT_TEST_ORG_ID, seedOrg, seedProgram, testEnv } from './test-env';

async function clearData(): Promise<void> {
    await testEnv.DB.exec('DELETE FROM programs');
}

function isResponse(value: Response | { id: string }): value is Response {
    return value instanceof Response;
}

describe('requireProgramAccess', () => {
    beforeEach(async () => {
        await clearData();
    });

    it('returns programs for platform_admin readers and handles missing programs', async () => {
        const repo = new ProgramRepository(testEnv.DB);
        const program = await seedProgram(testEnv, {
            slug: `platform-${crypto.randomUUID()}`,
        });

        const platformAuth: UserAuth = {
            userId: 'platform',
            role: 'platform_admin',
            orgId: null,
        };

        const loaded = await requireProgramAccess(repo, program.id, platformAuth);
        expect(loaded).toBeTypeOf('object');
        expect(loaded).not.toBeInstanceOf(Response);
        expect((loaded as { id: string }).id).toBe(program.id);

        const missing = await requireProgramAccess(repo, 'program_missing', platformAuth);
        if (!isResponse(missing)) {
            throw new Error('expected Response for missing program');
        }
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({ error: 'program_not_found' });
    });

    it("enforces org scope, allowing reads only inside the caller's org", async () => {
        await seedOrg(testEnv, { id: 'org_other', name: 'Other Org' });
        const homeOrgProgram = await seedProgram(testEnv, {
            slug: `scope-home-${crypto.randomUUID()}`,
            orgId: DEFAULT_TEST_ORG_ID,
        });
        const otherOrgProgram = await seedProgram(testEnv, {
            slug: `scope-other-${crypto.randomUUID()}`,
            orgId: 'org_other',
        });

        const adminAuth: UserAuth = {
            userId: 'org-admin-home',
            role: 'org_admin',
            orgId: DEFAULT_TEST_ORG_ID,
        };
        const viewerAuth: UserAuth = {
            userId: 'viewer-home',
            role: 'viewer',
            orgId: DEFAULT_TEST_ORG_ID,
        };

        const orgRepo = new ProgramRepository(testEnv.DB);
        const adminReadOwn = await requireProgramAccess(orgRepo, homeOrgProgram.id, adminAuth);
        expect(adminReadOwn).not.toBeInstanceOf(Response);
        expect((adminReadOwn as { id: string }).id).toBe(homeOrgProgram.id);

        const adminWriteOwn = await requireProgramAccess(orgRepo, homeOrgProgram.id, adminAuth, {
            write: true,
        });
        expect(adminWriteOwn).not.toBeInstanceOf(Response);
        expect((adminWriteOwn as { id: string }).id).toBe(homeOrgProgram.id);

        const viewerReadOwn = await requireProgramAccess(orgRepo, homeOrgProgram.id, viewerAuth);
        expect(viewerReadOwn).not.toBeInstanceOf(Response);
        expect((viewerReadOwn as { id: string }).id).toBe(homeOrgProgram.id);

        const viewerWriteOwn = await requireProgramAccess(orgRepo, homeOrgProgram.id, viewerAuth, {
            write: true,
        });
        if (!isResponse(viewerWriteOwn)) {
            throw new Error('expected Response for viewer write');
        }
        expect(viewerWriteOwn.status).toBe(403);
        expect(await viewerWriteOwn.json()).toEqual({ error: 'forbidden' });

        const viewerWriteOther = await requireProgramAccess(
            orgRepo,
            otherOrgProgram.id,
            viewerAuth,
            { write: true },
        );
        if (!isResponse(viewerWriteOther)) {
            throw new Error('expected Response for viewer cross-org write');
        }
        expect(viewerWriteOther.status).toBe(404);
        expect(await viewerWriteOther.json()).toEqual({
            error: 'program_not_found',
        });

        const adminReadOther = await requireProgramAccess(orgRepo, otherOrgProgram.id, adminAuth);
        if (!isResponse(adminReadOther)) {
            throw new Error('expected Response for admin cross-org read');
        }
        expect(adminReadOther.status).toBe(404);
        expect(await adminReadOther.json()).toEqual({ error: 'program_not_found' });

        const adminWriteOther = await requireProgramAccess(orgRepo, otherOrgProgram.id, adminAuth, {
            write: true,
        });
        if (!isResponse(adminWriteOther)) {
            throw new Error('expected Response for admin cross-org write');
        }
        expect(adminWriteOther.status).toBe(404);
        expect(await adminWriteOther.json()).toEqual({
            error: 'program_not_found',
        });

        const viewerReadOther = await requireProgramAccess(orgRepo, otherOrgProgram.id, viewerAuth);
        if (!isResponse(viewerReadOther)) {
            throw new Error('expected Response for viewer cross-org read');
        }
        expect(viewerReadOther.status).toBe(404);
        expect(await viewerReadOther.json()).toEqual({
            error: 'program_not_found',
        });
    });

    it('allows includeDeleted callers to read deleted programs when requested', async () => {
        await seedOrg(testEnv, { id: 'org_other', name: 'Other Org' });
        const program = await seedProgram(testEnv, {
            slug: `include-deleted-${crypto.randomUUID()}`,
            orgId: DEFAULT_TEST_ORG_ID,
        });
        const adminAuth: UserAuth = {
            userId: 'org-admin-home',
            role: 'org_admin',
            orgId: DEFAULT_TEST_ORG_ID,
        };

        testEnv.DB.prepare('UPDATE programs SET deleted_at = ? WHERE id = ?').run(
            new Date().toISOString(),
            program.id,
        );

        const deletedAccess = await requireProgramAccess(
            new ProgramRepository(testEnv.DB),
            program.id,
            adminAuth,
            { includeDeleted: true },
        );
        expect(deletedAccess).not.toBeInstanceOf(Response);
        expect((deletedAccess as { id: string }).id).toBe(program.id);
    });
});
