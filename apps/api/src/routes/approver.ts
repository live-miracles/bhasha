import { sha256Hex } from '../auth/crypto';
import {
    clearApproverSessionCookie,
    requireApproverService,
    requireApproverSession,
    approverSessionCookie,
} from '../auth/approverAuth';
import { ListenerAccessRepository } from '../db/listenerAccessRepository';
import { ProgramRepository } from '../db/programRepository';
import { ApproverRepository } from '../db/approverRepository';
import type { Env } from '../env';
import { json, readJson, type WaitUntilCtx } from '../http';
import { isProgramExpired } from '../domain/programExpiry';
import { clientIp } from '../auth/clientIp';

interface ApproverLoginInput {
    programSlug: string;
    password: string;
}

type ApproverApprovalInput = { claimId: string } | { shortCode: string };

export async function handleApproverRoutes(
    request: Request,
    env: Env,
    url: URL,
    _ctx: WaitUntilCtx,
): Promise<Response | null> {
    if (!url.pathname.startsWith('/api/approver/')) {
        return null;
    }

    const service = requireApproverService(env);
    if (service instanceof Response) {
        return approverResponse(service);
    }

    const approvers = new ApproverRepository(env.DB, env.TRANSLATOR_PASSWORD_PEPPER);
    const programs = new ProgramRepository(env.DB);
    const listenerAccess = new ListenerAccessRepository(env.DB);

    if (request.method === 'POST' && url.pathname === '/api/approver/login') {
        const input = await parseBody(request, parseApproverLoginInput);
        if (input instanceof Response) {
            return approverResponse(input);
        }

        try {
            const program = await programs.getProgramBySlug(input.programSlug);
            if (!program || !(await approvers.getAccount(program.id))) {
                return approverResponse(
                    json({ error: 'approver_not_configured' }, { status: 409 }),
                );
            }
            if (isProgramExpired(program.endDate)) {
                return approverResponse(json({ error: 'program_expired' }, { status: 410 }));
            }

            const clientAddress = clientIp(request);
            const ipHash = clientAddress === null ? null : await sha256Hex(clientAddress);
            if (await approvers.isLocked(program.id, ipHash)) {
                return approverResponse(json({ error: 'too_many_attempts' }, { status: 429 }));
            }

            // Reserve both limiter counters before password verification so a D1-
            // serialized write burst cannot all pass the unlocked read together.
            // Full request serialization with a Durable Object is deferred to the WP
            // follow-up; successful authentication rolls this reservation back.
            const failure = await approvers.recordFailure(program.id, ipHash);
            const authenticated = await approvers.authenticate(program.id, input.password);
            if (!authenticated) {
                return approverResponse(
                    failure.locked
                        ? json({ error: 'too_many_attempts' }, { status: 429 })
                        : json({ error: 'invalid_credentials' }, { status: 401 }),
                );
            }

            await approvers.clearOnSuccess(program.id, failure.reservation);
            const lockedAfterSuccess = await approvers.isLocked(program.id, ipHash);
            if (failure.firstThresholdBreach || lockedAfterSuccess) {
                return approverResponse(json({ error: 'too_many_attempts' }, { status: 429 }));
            }
            const { token } = await approvers.createSession(program.id, service.sessionSecret);
            const response = json({ ok: true });
            response.headers.set('set-cookie', approverSessionCookie(token));
            return approverResponse(response);
        } catch (_error) {
            return approverResponse(json({ error: 'database_error' }, { status: 500 }));
        }
    }

    if (request.method === 'POST' && url.pathname === '/api/approver/logout') {
        try {
            const auth = await requireApproverSession(request, env, approvers);
            if (auth instanceof Response) {
                return approverResponse(auth);
            }

            await approvers.deleteSession(auth.session.id);
            const response = json({ ok: true });
            response.headers.set('set-cookie', clearApproverSessionCookie());
            return approverResponse(response);
        } catch (_error) {
            return approverResponse(json({ error: 'database_error' }, { status: 500 }));
        }
    }

    if (request.method === 'GET' && url.pathname === '/api/approver/session') {
        try {
            const auth = await requireApproverSession(request, env, approvers);
            if (auth instanceof Response) {
                return approverResponse(auth);
            }

            const program = await programs.getProgramById(auth.session.programId);
            if (!program) {
                return approverResponse(json({ error: 'approver_auth_required' }, { status: 401 }));
            }
            if (isProgramExpired(program.endDate)) {
                return approverResponse(json({ error: 'program_expired' }, { status: 410 }));
            }
            const counts = await listenerAccess.countByStatus(program.id);
            return approverResponse(
                json({
                    program: { slug: program.slug, name: program.name },
                    approvedCount: counts.approved,
                }),
            );
        } catch (_error) {
            return approverResponse(json({ error: 'database_error' }, { status: 500 }));
        }
    }

    if (request.method === 'POST' && url.pathname === '/api/approver/approve') {
        const input = await parseBody(request, parseApproverApprovalInput);
        if (input instanceof Response) {
            return approverResponse(input);
        }

        try {
            const auth = await requireApproverSession(request, env, approvers);
            if (auth instanceof Response) {
                return approverResponse(auth);
            }

            const program = await programs.getProgramById(auth.session.programId);
            if (!program) {
                return approverResponse(json({ error: 'approver_auth_required' }, { status: 401 }));
            }
            if (isProgramExpired(program.endDate)) {
                return approverResponse(json({ error: 'program_expired' }, { status: 410 }));
            }

            const result = await listenerAccess.approveClaim(
                auth.session.programId,
                input,
                'claimId' in input ? 'scan' : 'code',
            );
            if (result.status === 'approved') {
                return approverResponse(json(result));
            }
            if (result.status === 'revoked') {
                return approverResponse(json({ error: 'claim_revoked' }, { status: 409 }));
            }
            return approverResponse(json({ error: 'claim_not_found' }, { status: 404 }));
        } catch (_error) {
            return approverResponse(json({ error: 'database_error' }, { status: 500 }));
        }
    }

    return null;
}

async function parseBody<T>(request: Request, parse: (body: unknown) => T): Promise<T | Response> {
    let body: unknown;
    try {
        body = await readJson(request);
    } catch (_error) {
        return json({ error: 'invalid_json' }, { status: 400 });
    }

    try {
        return parse(body);
    } catch (_error) {
        return json({ error: 'validation_error' }, { status: 400 });
    }
}

function parseApproverLoginInput(body: unknown): ApproverLoginInput {
    return {
        programSlug: requiredString(body, 'programSlug'),
        password: requiredString(body, 'password', false),
    };
}

function parseApproverApprovalInput(body: unknown): ApproverApprovalInput {
    const claimId = optionalString(body, 'claimId');
    const shortCode = optionalString(body, 'shortCode');
    if (claimId && !shortCode) {
        return { claimId };
    }
    if (shortCode && !claimId) {
        return { shortCode: shortCode.toUpperCase() };
    }
    throw new Error('claimId or shortCode is required');
}

function requiredString(body: unknown, key: string, trim = true): string {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error(`${key} is required`);
    }
    const raw = (body as Record<string, unknown>)[key];
    if (typeof raw !== 'string') {
        throw new Error(`${key} is required`);
    }
    const value = trim ? raw.trim() : raw;
    if (value.length === 0) {
        throw new Error(`${key} is required`);
    }
    return value;
}

function optionalString(body: unknown, key: string): string | null {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }
    const raw = (body as Record<string, unknown>)[key];
    if (typeof raw !== 'string') {
        return null;
    }
    const value = raw.trim();
    return value.length > 0 ? value : null;
}

function approverResponse(response: Response): Response {
    response.headers.set('cache-control', 'no-store');
    response.headers.set('vary', 'Cookie');
    return response;
}
