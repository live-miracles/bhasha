import { json } from '../http';
import type { UserAuth } from './adminAuth';
import { ProgramRepository, type ProgramRecord } from '../db/programRepository';

export async function requireProgramAccess(
    programs: ProgramRepository,
    programId: string,
    auth: UserAuth,
    // `write` is accepted (and still passed by every call site) but no longer
    // changes the outcome: access is now all-or-nothing per program (admin, or
    // the user who created it), so anyone who can load a program can also
    // write to it. Kept in the signature to avoid a mechanical touch of every
    // call site for a pure no-op.
    opts: { write?: boolean; includeDeleted?: boolean } = {},
): Promise<ProgramRecord | Response> {
    const load = await programs.getProgramById(programId, {
        includeDeleted: opts.includeDeleted ?? false,
    });

    // Uniform 404 body for BOTH genuinely-missing and someone-else's programs —
    // the body must be identical so another user's program stays
    // indistinguishable from one that does not exist. `program_not_found`
    // matches the pre-existing admin API contract (handlers/tests already
    // expect this shape).
    if (!load) {
        return json({ error: 'program_not_found' }, { status: 404 });
    }

    if (auth.role === 'admin') {
        return load;
    }

    if (load.createdBy !== auth.userId) {
        return json({ error: 'program_not_found' }, { status: 404 });
    }

    return load;
}
