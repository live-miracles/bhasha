import {
    type AssignedStreamRecord,
    TranslatorRepository,
    type TranslatorSessionRecord,
} from '../db/translatorRepository';
import type { Env } from '../env';
import { json } from '../http';

const TRANSLATOR_SESSION_COOKIE = 'translator_session';
const TRANSLATOR_SESSION_SECONDS = 8 * 60 * 60;

export interface AuthenticatedTranslator {
    session: TranslatorSessionRecord;
    translator: {
        id: string;
        programId: string;
        name: string;
        email: string;
    };
    assignedStreams: AssignedStreamRecord[];
}

export function translatorSessionCookie(token: string): string {
    return `${TRANSLATOR_SESSION_COOKIE}=${token}; Path=/; Max-Age=${TRANSLATOR_SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearTranslatorSessionCookie(): string {
    return `${TRANSLATOR_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export async function requireTranslatorSession(
    request: Request,
    env: Env,
    repository = new TranslatorRepository(env.DB),
): Promise<AuthenticatedTranslator | Response> {
    const token = cookieValue(request, TRANSLATOR_SESSION_COOKIE);
    if (!token) {
        return translatorAuthRequired();
    }

    const session = await repository.getSession(token, env.TRANSLATOR_SESSION_SECRET);
    if (!session) {
        return translatorAuthRequired();
    }

    const touchedSession = await repository.touchSession(session.id);
    if (!touchedSession) {
        return translatorAuthRequired();
    }

    const assignedStreams = await repository.listAssignedStreams(
        touchedSession.programId,
        touchedSession.translatorId,
    );

    return {
        session: touchedSession,
        translator: {
            id: touchedSession.translatorId,
            programId: touchedSession.programId,
            name: touchedSession.translatorName,
            email: touchedSession.translatorEmail,
        },
        assignedStreams,
    };
}

function translatorAuthRequired(): Response {
    return json({ error: 'translator_auth_required' }, { status: 401 });
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
