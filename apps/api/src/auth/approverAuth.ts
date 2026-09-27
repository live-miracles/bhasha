import { ApproverRepository, type ApproverSessionRecord } from '../db/approverRepository';
import type { Env } from '../env';
import { json } from '../http';

const APPROVER_SESSION_COOKIE = 'approver_session';
const APPROVER_SESSION_SECONDS = 8 * 60 * 60;

export interface AuthenticatedApprover {
    session: ApproverSessionRecord;
}

export function approverSessionCookie(token: string): string {
    return `${APPROVER_SESSION_COOKIE}=${token}; Path=/; Max-Age=${APPROVER_SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearApproverSessionCookie(): string {
    return `${APPROVER_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function requireApproverService(env: Env): { sessionSecret: string } | Response {
    if (!env.APPROVER_SESSION_SECRET) {
        return json({ error: 'service_unavailable' }, { status: 503 });
    }
    return { sessionSecret: env.APPROVER_SESSION_SECRET };
}

export async function requireApproverSession(
    request: Request,
    env: Env,
    repository = new ApproverRepository(env.DB, env.TRANSLATOR_PASSWORD_PEPPER),
): Promise<AuthenticatedApprover | Response> {
    const service = requireApproverService(env);
    if (service instanceof Response) {
        return service;
    }

    const token = cookieValue(request, APPROVER_SESSION_COOKIE);
    if (!token) {
        return approverAuthRequired();
    }

    const session = await repository.getSession(token, service.sessionSecret);
    if (!session) {
        return approverAuthRequired();
    }

    const touchedSession = await repository.touchSession(session.id);
    if (!touchedSession) {
        return approverAuthRequired();
    }

    return { session: touchedSession };
}

function approverAuthRequired(): Response {
    return json({ error: 'approver_auth_required' }, { status: 401 });
}

function cookieValue(request: Request, name: string): string | null {
    const cookie = request.headers.get('cookie');
    if (!cookie) {
        return null;
    }

    for (const part of cookie.split(';')) {
        const [key, ...rawValue] = part.trim().split('=');
        const value = rawValue.join('=');
        if (key === name && value) {
            return value;
        }
    }

    return null;
}
