import { json } from '../http';
import type { UserAuth } from './adminAuth';
import { ProgramRepository, type ProgramRecord } from '../db/programRepository';

export async function requireProgramAccess(
    programs: ProgramRepository,
    programId: string,
    auth: UserAuth,
    opts: { write?: boolean; includeDeleted?: boolean } = {},
): Promise<ProgramRecord | Response> {
    const load = await programs.getProgramById(programId, {
        includeDeleted: opts.includeDeleted ?? false,
    });

    // Uniform 404 body for BOTH genuinely-missing and cross-org programs — the
    // body must be identical so a cross-org program stays indistinguishable from
    // one that does not exist. `program_not_found` matches the pre-existing admin
    // API contract (handlers/tests already expect this shape).
    if (!load) {
        return json({ error: 'program_not_found' }, { status: 404 });
    }

    if (auth.role === 'platform_admin') {
        return load;
    }

    if (load.orgId !== auth.orgId) {
        return json({ error: 'program_not_found' }, { status: 404 });
    }

    if (opts.write && auth.role === 'viewer') {
        return json({ error: 'forbidden' }, { status: 403 });
    }

    return load;
}
