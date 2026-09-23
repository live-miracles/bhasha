import type { Env } from '../env';
import { json } from '../http';
import { sha256Hex, timingSafeEqualHex } from './crypto';
import { UsersRepository, type UserRecord, type UserRole } from '../db/usersRepository';

const SESSION_SECONDS = 86_400;
// Break-glass bootstrap sessions are short-lived: the operator should set a real
// password (POST /api/admin/me/password) promptly, which re-issues a full session.
const BOOTSTRAP_SESSION_SECONDS = 3_600;

export type UserAuth = {
    userId: string;
    role: UserRole;
    orgId: string | null;
};

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

function sessionCookie(token: string, maxAgeSeconds: number): string {
    return `admin_session=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

// Expire the cookie in the browser (Max-Age=0). Same attributes as sessionCookie
// so the browser matches and clears it.
function clearSessionCookie(): string {
    return `admin_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Sign out the current admin: delete this session's row (so the cookie can never
 * be reused, incl. from another tab/device holding the same token) and expire the
 * cookie. Idempotent — succeeds even without a valid/present session cookie, so a
 * user with a stale or already-expired session can still clear it. Only the
 * caller's own session is removed; other devices stay signed in.
 */
export async function handleLogout(request: Request, env: Env): Promise<Response> {
    const token = cookieValue(request, 'admin_session');
    if (token) {
        const sessionHash = await sha256Hex(token + env.ADMIN_SESSION_SECRET);
        env.DB.prepare('DELETE FROM admin_sessions WHERE session_hash = ?').run(sessionHash);
    }
    const response = json({ ok: true });
    response.headers.set('set-cookie', clearSessionCookie());
    return response;
}

/**
 * Insert a user-bound admin session and return the opaque cookie token.
 * The stored `session_hash` is sha256(token + ADMIN_SESSION_SECRET); only the
 * token leaves the server (in the cookie).
 */
async function issueSession(env: Env, userId: string, ttlSeconds: number): Promise<string> {
    const token = crypto.randomUUID();
    const sessionHash = await sha256Hex(token + env.ADMIN_SESSION_SECRET);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

    env.DB.prepare(
        `INSERT INTO admin_sessions (id, user_id, session_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    ).run(
        `admin_session_${crypto.randomUUID()}`,
        userId,
        sessionHash,
        expiresAt,
        now.toISOString(),
    );

    return token;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | Response> {
    let body: unknown;
    try {
        body = await request.json();
    } catch (_error) {
        return json({ error: 'invalid_json' }, { status: 400 });
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return {};
    }

    return body as Record<string, unknown>;
}

function readString(body: Record<string, unknown>, key: string): string {
    const value = body[key];
    return typeof value === 'string' ? value : '';
}

/**
 * Email + password login against the `users` table. On success, issues a
 * user-bound `admin_session` cookie. Disabled users and users without a
 * password set are rejected (401), with a generic error to avoid user
 * enumeration.
 */
export async function handleLogin(request: Request, env: Env): Promise<Response> {
    const body = await readJsonObject(request);
    if (body instanceof Response) {
        return body;
    }

    const email = readString(body, 'email');
    const password = readString(body, 'password');

    const invalid = json({ error: 'invalid_admin_password' }, { status: 401 });

    if (!email || !password) {
        return invalid;
    }

    const users = new UsersRepository(env.DB);
    const user = await users.getUserByEmail(email);
    if (!user || user.isDisabled || !user.passwordHash) {
        // Burn equivalent PBKDF2 work even when there is no real password to verify,
        // so the unknown-email / disabled / unset-password paths take comparable
        // time to a wrong-password attempt. Closes a user-enumeration timing oracle.
        await users.dummyVerify(password);
        return invalid;
    }

    const ok = await users.verifyPassword(user, password);
    if (!ok) {
        return invalid;
    }

    const token = await issueSession(env, user.id, SESSION_SECONDS);
    const response = json({ ok: true });
    response.headers.set('set-cookie', sessionCookie(token, SESSION_SECONDS));
    return response;
}

/**
 * Validate the `admin_session` cookie against a user-bound session.
 *
 * The JOIN to `users` means legacy sessions (user_id IS NULL) are dropped → 401,
 * forcing re-login. `is_disabled = 0` is re-checked on EVERY request so a
 * disabled user loses access immediately, not just on next login.
 *
 * @returns The resolved {userId, role, orgId} or a 401 Response.
 */
export async function requireUserAuth(request: Request, env: Env): Promise<UserAuth | Response> {
    const token = cookieValue(request, 'admin_session');
    if (!token) {
        return json({ error: 'admin_auth_required' }, { status: 401 });
    }

    const sessionHash = await sha256Hex(token + env.ADMIN_SESSION_SECRET);
    const row = env.DB.prepare(
        `SELECT u.id AS id, u.role AS role, u.org_id AS org_id
     FROM admin_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.session_hash = ? AND s.expires_at > ? AND u.is_disabled = 0`,
    ).get(sessionHash, new Date().toISOString()) as
        { id: string; role: UserRole; org_id: string | null } | undefined;

    if (!row) {
        return json({ error: 'admin_auth_required' }, { status: 401 });
    }

    return { userId: row.id, role: row.role, orgId: row.org_id };
}

/**
 * Gate for platform-only endpoints. Resolves the session, then requires the
 * platform_admin role (403 otherwise).
 */
export async function requireAdminRole(request: Request, env: Env): Promise<UserAuth | Response> {
    const auth = await requireUserAuth(request, env);
    if (auth instanceof Response) {
        return auth;
    }
    if (auth.role !== 'platform_admin') {
        return json({ error: 'admin_role_required' }, { status: 403 });
    }
    return auth;
}

const SHA256_PREFIX = 'sha256:';

/**
 * A stored break-glass hash is `sha256:<hex>`. Strip the prefix so the hex can
 * be compared in constant time; return null if the prefix is absent (treated as
 * a non-match → fail closed).
 */
function stripSha256Prefix(value: string): string | null {
    return value.startsWith(SHA256_PREFIX) ? value.slice(SHA256_PREFIX.length) : null;
}

/** The single break-glass identity: platform_admin with no org binding. */
function isPlatformAdminRow(user: UserRecord): boolean {
    return user.role === 'platform_admin' && user.orgId === null;
}

/**
 * Structured audit log for every break-glass bootstrap attempt (success AND
 * failure). Records the outcome + a coarse reason only — never the candidate
 * password or any secret material.
 */
function logBootstrapAttempt(outcome: string, reason: string): void {
    console.log(JSON.stringify({ msg: 'admin_bootstrap_attempt', outcome, reason }));
    // TODO(rate-limit): per-IP throttle needs a DO/KV counter — follow-up.
}

/**
 * Break-glass bootstrap. Authenticates the env `ADMIN_PASSWORD_HASH` via a
 * constant-time hex compare and issues a short-lived platform_admin session.
 *
 * RESOLVE-ONLY, FAIL-CLOSED: the platform_admin row is identified by
 * `PLATFORM_ADMIN_EMAIL`.
 * - If a user with that email exists but is NOT (`role='platform_admin'` AND
 *   `org_id IS NULL`) → 403 `bootstrap_conflict`, NO session issued. This stops
 *   an existing org_admin/viewer whose email collides from being handed a
 *   platform_admin break-glass session (privilege escalation).
 * - If it exists AND is the platform_admin → the SAME row is resolved (no
 *   duplicate is ever minted).
 * - If no user exists → exactly one platform_admin is created (org_id NULL,
 *   password unset).
 */
export async function handleBootstrap(request: Request, env: Env): Promise<Response> {
    const body = await readJsonObject(request);
    if (body instanceof Response) {
        return body;
    }

    const password = readString(body, 'password');
    const invalid = json({ error: 'invalid_admin_password' }, { status: 401 });

    if (!env.ADMIN_PASSWORD_HASH) {
        logBootstrapAttempt('rejected', 'password_hash_unset');
        return invalid;
    }

    const candidateHex = await sha256Hex(password + env.ADMIN_SESSION_SECRET);
    const expectedHex = stripSha256Prefix(env.ADMIN_PASSWORD_HASH);
    if (!expectedHex || !(await timingSafeEqualHex(candidateHex, expectedHex))) {
        logBootstrapAttempt('rejected', 'invalid_password');
        return invalid;
    }

    const email = env.PLATFORM_ADMIN_EMAIL;
    if (!email) {
        logBootstrapAttempt('error', 'platform_admin_email_unset');
        return json({ error: 'bootstrap_not_configured' }, { status: 500 });
    }

    const users = new UsersRepository(env.DB);
    const existing = await users.getUserByEmail(email);

    if (existing && !isPlatformAdminRow(existing)) {
        // Fail closed: the email resolves to a non-platform_admin (or org-bound)
        // row. Never escalate it — and never issue any session.
        logBootstrapAttempt('rejected', 'bootstrap_conflict');
        return json({ error: 'bootstrap_conflict' }, { status: 403 });
    }

    let user = existing;
    if (user) {
        logBootstrapAttempt('resolved', 'existing_platform_admin');
    } else {
        user = await users.createUser({
            email,
            role: 'platform_admin',
            orgId: null,
        });
        logBootstrapAttempt('created', 'platform_admin_created');
    }

    const token = await issueSession(env, user.id, BOOTSTRAP_SESSION_SECONDS);
    const response = json({ ok: true });
    response.headers.set('set-cookie', sessionCookie(token, BOOTSTRAP_SESSION_SECONDS));
    return response;
}

/**
 * Change the authenticated caller's own password.
 *
 * - If the user has no password set (NULL hash), allows a first-set WITHOUT
 *   currentPassword (the bootstrap → first-password flow).
 * - Otherwise requires `currentPassword` and verifies it (401 on mismatch).
 *
 * On success, all of the user's sessions are revoked, then a fresh session is
 * re-issued for THIS caller so they are not logged out.
 */
export async function handleChangeOwnPassword(request: Request, env: Env): Promise<Response> {
    const auth = await requireUserAuth(request, env);
    if (auth instanceof Response) {
        return auth;
    }

    const body = await readJsonObject(request);
    if (body instanceof Response) {
        return body;
    }

    const newPassword = readString(body, 'newPassword');
    if (!newPassword) {
        return json({ error: 'invalid_password' }, { status: 400 });
    }

    const users = new UsersRepository(env.DB);
    const user = await users.getUserById(auth.userId);
    if (!user) {
        return json({ error: 'admin_auth_required' }, { status: 401 });
    }

    if (user.passwordHash) {
        const currentValue = body.currentPassword;
        const currentPassword = typeof currentValue === 'string' ? currentValue : '';
        if (!currentPassword || !(await users.verifyPassword(user, currentPassword))) {
            return json({ error: 'invalid_current_password' }, { status: 401 });
        }
    }

    await users.setPassword(user.id, newPassword);
    // Revoke every session (incl. the current one), then re-issue for this caller.
    await users.deleteSessionsForUser(user.id);
    const token = await issueSession(env, user.id, SESSION_SECONDS);

    const response = json({ ok: true });
    response.headers.set('set-cookie', sessionCookie(token, SESSION_SECONDS));
    return response;
}
