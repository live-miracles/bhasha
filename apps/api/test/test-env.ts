import { randomUUID } from 'node:crypto';
import type { Env } from '../src/env';
import type { Database } from '../src/db/sqlite';
import { createApp } from '../src/index';
import { ProgramRepository, type ProgramRecord } from '../src/db/programRepository';
import { UsersRepository, type UserRecord } from '../src/db/usersRepository';

// Default credentials for the seeded admin/user accounts used across
// admin/program tests.
export const ADMIN_TEST_USERNAME = 'admin_test';
export const USER_TEST_USERNAME = 'user_test';

const adminSessionSecret = `test-admin-session-secret-${randomUUID()}`;
const testPassword = `test-password-${randomUUID()}`;
const translatorPasswordPepper = `test-translator-password-pepper-${randomUUID()}`;
const translatorSessionSecret = `test-translator-session-secret-${randomUUID()}`;
const volunteerSessionSecret = `test-volunteer-session-secret-${randomUUID()}`;

/**
 * Holds the CURRENT test file's database (set by test/apply-migrations.ts's
 * `beforeAll`) plus the fixed test secrets, in one object so existing tests
 * that poke at `testEnv.DB` directly keep working. Unlike the old
 * `env as TestEnv` (a real Cloudflare Worker binding under Miniflare), `DB`
 * here is a getter over a module-level variable that a fresh test file
 * repopulates before its tests run.
 */
class TestEnvHandle {
    private _db: Database | undefined;

    get DB(): Database {
        if (!this._db) {
            throw new Error(
                "test database not initialized -- every test file needs test/apply-migrations.ts wired into vitest.config.ts's setupFiles",
            );
        }
        return this._db;
    }

    readonly ADMIN_SESSION_SECRET = adminSessionSecret;
    readonly TEST_PASSWORD = testPassword;
    readonly TRANSLATOR_PASSWORD_PEPPER = translatorPasswordPepper;
    readonly TRANSLATOR_SESSION_SECRET = translatorSessionSecret;
    readonly VOLUNTEER_SESSION_SECRET = volunteerSessionSecret;

    __setDatabase(db: Database): void {
        this._db = db;
    }
}

export const testEnv = new TestEnvHandle();

export function __setTestDatabase(db: Database): void {
    testEnv.__setDatabase(db);
}

// Matches the well-known `livekit-server --dev` credentials (see
// scripts/livekit-spike/mint.mjs) so tests exercise real AccessToken/
// RoomServiceClient/WebhookReceiver construction end-to-end without a live
// LiveKit server -- token minting is pure JWT signing (no network call), and
// admin/translator best-effort RoomServiceClient calls (removeParticipant/
// deleteRoom) against this unreachable ws://localhost:7880 fail fast
// (ECONNREFUSED) and are swallowed, matching this repo's "benign cleanup"
// philosophy. Tests that need to exercise the "LiveKit not configured" path
// (e.g. isRealtimeConfigured/readiness) override these to `undefined`.
const DEFAULT_LIVEKIT_URL = 'ws://localhost:7880';
const DEFAULT_LIVEKIT_API_KEY = 'devkey';
const DEFAULT_LIVEKIT_API_SECRET = 'secret';

// `Env`'s LIVEKIT_* fields are `string | undefined` optional under
// exactOptionalPropertyTypes, which normally forbids assigning `undefined`
// explicitly (only "key absent" is allowed) -- but a test simulating
// "LiveKit is not configured" needs exactly that (these three are the only
// baseEnv fields a test ever needs to explicitly un-set, since every other
// optional Env field defaults to simply absent already). This override type
// widens just those three to allow an explicit `undefined`, and the
// implementation below deletes the key entirely when it sees one, so the
// object returned to callers still satisfies `Env` for real.
type TestEnvOverrides = Omit<
    Partial<Env>,
    'LIVEKIT_URL' | 'LIVEKIT_API_KEY' | 'LIVEKIT_API_SECRET'
> & {
    LIVEKIT_URL?: string | undefined;
    LIVEKIT_API_KEY?: string | undefined;
    LIVEKIT_API_SECRET?: string | undefined;
};

export function buildTestEnv(overrides: TestEnvOverrides = {}): Env {
    const baseEnv: Env = {
        DB: testEnv.DB,
        ADMIN_SESSION_SECRET: testEnv.ADMIN_SESSION_SECRET,
        TRANSLATOR_PASSWORD_PEPPER: testEnv.TRANSLATOR_PASSWORD_PEPPER,
        TRANSLATOR_SESSION_SECRET: testEnv.TRANSLATOR_SESSION_SECRET,
        VOLUNTEER_SESSION_SECRET: testEnv.VOLUNTEER_SESSION_SECRET,
        LIVEKIT_URL: DEFAULT_LIVEKIT_URL,
        LIVEKIT_API_KEY: DEFAULT_LIVEKIT_API_KEY,
        LIVEKIT_API_SECRET: DEFAULT_LIVEKIT_API_SECRET,
    };

    const merged: Record<string, unknown> = { ...baseEnv, ...overrides };
    for (const key of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const) {
        if (key in overrides && overrides[key] === undefined) {
            delete merged[key];
        }
    }
    return merged as Env;
}

/**
 * Seed (or repair) an admin user with a known password. Idempotent: if the
 * user already exists it just (re)sets the role + password. Returns the user id.
 */
export async function seedAdmin(
    env: Env,
    username: string = ADMIN_TEST_USERNAME,
    password: string = testEnv.TEST_PASSWORD,
): Promise<string> {
    const users = new UsersRepository(env.DB);
    const existing = await users.getUserByUsername(username);
    const user = existing
        ? ((await users.updateUser(existing.id, { role: 'admin' })) ?? existing)
        : await users.createUser({ username, role: 'admin' });
    await users.setPassword(user.id, password);
    return user.id;
}

/**
 * Seed (or repair) a 'user'-role account with a known password. Idempotent.
 * Returns the user id.
 */
export async function seedUser(
    env: Env,
    username: string = USER_TEST_USERNAME,
    password: string = testEnv.TEST_PASSWORD,
): Promise<string> {
    const users = new UsersRepository(env.DB);
    const existing = await users.getUserByUsername(username);
    const user: UserRecord = existing
        ? ((await users.updateUser(existing.id, { role: 'user' })) ?? existing)
        : await users.createUser({ username, role: 'user' });
    await users.setPassword(user.id, password);
    return user.id;
}

export async function seedProgram(
    env: Env,
    overrides: Partial<{
        slug: string;
        name: string;
        venue: string;
        eventDate: string;
        adminNotes: string;
        createdBy: string;
    }> = {},
): Promise<ProgramRecord> {
    const repo = new ProgramRepository(env.DB);
    const createdBy = overrides.createdBy ?? (await seedUser(env));
    return repo.createProgram(
        {
            slug: overrides.slug ?? `program-${crypto.randomUUID()}`,
            name: overrides.name ?? 'Patna Event 2026',
            venue: overrides.venue ?? 'Main Hall',
            eventDate: overrides.eventDate ?? '2026-08-01',
            adminNotes: overrides.adminNotes ?? '',
        },
        createdBy,
    );
}

/**
 * Log in via POST /api/admin/login and return the `admin_session=<token>`
 * cookie fragment suitable for a `cookie` request header.
 */
export async function adminCookie(
    username: string = ADMIN_TEST_USERNAME,
    password: string = testEnv.TEST_PASSWORD,
    env: Env = buildTestEnv(),
): Promise<string> {
    const app = createApp(env);
    const response = await app.fetch(
        new Request('https://bhasha.test/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
        }),
    );

    const setCookie = response.headers.get('set-cookie');
    if (!setCookie) {
        throw new Error(`admin login failed: ${response.status}`);
    }
    return setCookie.split(';')[0] ?? '';
}
