import { beforeEach, describe, expect, it } from 'vitest';

import { ProgramRepository } from '../src/db/programRepository';
import type { UserAuth } from '../src/auth/adminAuth';
import { requireProgramAccess } from '../src/auth/programAccess';
import { seedProgram, seedUser, testEnv } from './test-env';

async function clearData(): Promise<void> {
    await testEnv.DB.exec('DELETE FROM programs');
    await testEnv.DB.exec('DELETE FROM users');
}

function isResponse(value: Response | { id: string }): value is Response {
    return value instanceof Response;
}

describe('requireProgramAccess', () => {
    beforeEach(async () => {
        await clearData();
    });

    it('returns programs for admin readers and handles missing programs', async () => {
        const repo = new ProgramRepository(testEnv.DB);
        const program = await seedProgram(testEnv, {
            slug: `admin-${crypto.randomUUID()}`,
        });

        const adminAuth: UserAuth = {
            userId: 'admin-1',
            role: 'admin',
        };

        const loaded = await requireProgramAccess(repo, program.id, adminAuth);
        expect(loaded).toBeTypeOf('object');
        expect(loaded).not.toBeInstanceOf(Response);
        expect((loaded as { id: string }).id).toBe(program.id);

        const missing = await requireProgramAccess(repo, 'program_missing', adminAuth);
        if (!isResponse(missing)) {
            throw new Error('expected Response for missing program');
        }
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({ error: 'program_not_found' });
    });

    it("enforces ownership, allowing a 'user' full read/write only on programs it created", async () => {
        const ownerId = await seedUser(testEnv, 'owner_user');
        const otherId = await seedUser(testEnv, 'other_user');
        const ownProgram = await seedProgram(testEnv, {
            slug: `own-${crypto.randomUUID()}`,
            createdBy: ownerId,
        });
        const otherProgram = await seedProgram(testEnv, {
            slug: `other-${crypto.randomUUID()}`,
            createdBy: otherId,
        });

        const ownerAuth: UserAuth = { userId: ownerId, role: 'user' };
        const adminAuth: UserAuth = { userId: 'admin-1', role: 'admin' };

        const repo = new ProgramRepository(testEnv.DB);

        // The owner has full read AND write access to its own program (the
        // `write` opt is a no-op — access is all-or-nothing).
        const ownerReadOwn = await requireProgramAccess(repo, ownProgram.id, ownerAuth);
        expect(ownerReadOwn).not.toBeInstanceOf(Response);
        expect((ownerReadOwn as { id: string }).id).toBe(ownProgram.id);

        const ownerWriteOwn = await requireProgramAccess(repo, ownProgram.id, ownerAuth, {
            write: true,
        });
        expect(ownerWriteOwn).not.toBeInstanceOf(Response);
        expect((ownerWriteOwn as { id: string }).id).toBe(ownProgram.id);

        // A non-owning 'user' gets a uniform 404 for both read and write on
        // someone else's program.
        const ownerReadOther = await requireProgramAccess(repo, otherProgram.id, ownerAuth);
        if (!isResponse(ownerReadOther)) {
            throw new Error('expected Response for non-owner read');
        }
        expect(ownerReadOther.status).toBe(404);
        expect(await ownerReadOther.json()).toEqual({ error: 'program_not_found' });

        const ownerWriteOther = await requireProgramAccess(repo, otherProgram.id, ownerAuth, {
            write: true,
        });
        if (!isResponse(ownerWriteOther)) {
            throw new Error('expected Response for non-owner write');
        }
        expect(ownerWriteOther.status).toBe(404);
        expect(await ownerWriteOther.json()).toEqual({ error: 'program_not_found' });

        // admin sees and can write to every program, regardless of who created it.
        const adminReadOther = await requireProgramAccess(repo, otherProgram.id, adminAuth);
        expect(adminReadOther).not.toBeInstanceOf(Response);
        expect((adminReadOther as { id: string }).id).toBe(otherProgram.id);

        const adminWriteOther = await requireProgramAccess(repo, otherProgram.id, adminAuth, {
            write: true,
        });
        expect(adminWriteOther).not.toBeInstanceOf(Response);
        expect((adminWriteOther as { id: string }).id).toBe(otherProgram.id);
    });

    it('allows includeDeleted callers to read deleted programs when requested', async () => {
        const ownerId = await seedUser(testEnv, 'owner_user');
        const program = await seedProgram(testEnv, {
            slug: `include-deleted-${crypto.randomUUID()}`,
            createdBy: ownerId,
        });
        const ownerAuth: UserAuth = { userId: ownerId, role: 'user' };

        testEnv.DB.prepare('UPDATE programs SET deleted_at = ? WHERE id = ?').run(
            new Date().toISOString(),
            program.id,
        );

        const deletedAccess = await requireProgramAccess(
            new ProgramRepository(testEnv.DB),
            program.id,
            ownerAuth,
            { includeDeleted: true },
        );
        expect(deletedAccess).not.toBeInstanceOf(Response);
        expect((deletedAccess as { id: string }).id).toBe(program.id);
    });
});
