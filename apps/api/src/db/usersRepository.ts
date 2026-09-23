import { timingSafeEqualHex } from '../auth/crypto';
import type { Database } from './sqlite';

export type UserRole = 'admin' | 'user';

export type UserRecord = {
    id: string;
    username: string;
    passwordHash: string | null;
    passwordSalt: string | null;
    passwordIterations: number | null;
    role: UserRole;
    isDisabled: boolean;
    createdAt: string;
    updatedAt: string;
};

export type CreateUserInput = {
    username: string;
    role: UserRole;
    id?: string;
};

export type UpdateUserInput = {
    role?: UserRole;
    isDisabled?: boolean;
};

// The fixed singleton admin account's identity, seeded automatically at
// startup (see ensureDefaultAdmin) with password "admin" so the app always
// has a working admin login without any env var configuration.
export const DEFAULT_ADMIN_USERNAME = 'admin';
export const DEFAULT_ADMIN_PASSWORD = 'admin';

// PBKDF2-HMAC-SHA-256 password parameters. Iterations is stored per-user
// (password_iterations) so the work factor can be raised without invalidating
// existing hashes — verification always uses the stored value.
// Historically capped at 100,000 because the Cloudflare Workers runtime
// rejected higher PBKDF2 iteration counts ("NotSupportedError: Pbkdf2 failed:
// iteration counts above 100000 are not supported"). Node's WebCrypto has no
// such ceiling, so a future slice can raise this toward OWASP's ~600k
// recommendation for SHA-256 — left unchanged in this slice (data-layer port
// only, no behavior changes) to keep this migration a pure infrastructure
// swap. Tracked as a follow-up, not part of Slice 1.
export const PBKDF2_ITERATIONS = 100_000;
// The former Cloudflare Workers runtime hard-limit. Kept (and still checked by
// a regression test) even though Node's WebCrypto no longer enforces it, so a
// future change to PBKDF2_ITERATIONS is a deliberate, reviewed decision.
export const WORKERS_PBKDF2_MAX_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const DERIVED_KEY_BYTES = 32;

// Fixed 16-byte (32 hex char) salt used ONLY to burn an equivalent amount of
// PBKDF2 work on login failure paths where there is no real user/password to
// verify (unknown username, disabled user, unset password). Running this keeps
// the failure-path latency comparable to the real-verify path, closing a
// user-enumeration timing oracle. The derived key is discarded.
const DUMMY_VERIFY_SALT_HEX = '00000000000000000000000000000000';

type UserRow = {
    id: string;
    username: string;
    password_hash: string | null;
    password_salt: string | null;
    password_iterations: number | null;
    role: UserRole;
    is_disabled: number;
    created_at: string;
    updated_at: string;
};

function toHex(bytes: Uint8Array): string {
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
}

/**
 * Derive a PBKDF2-HMAC-SHA-256 key from a password + salt, returned as hex.
 *
 * @param password Plaintext password.
 * @param saltHex  Hex-encoded salt.
 * @param iterations PBKDF2 iteration count.
 * @returns Hex-encoded 32-byte derived key.
 */
async function deriveKeyHex(
    password: string,
    saltHex: string,
    iterations: number,
): Promise<string> {
    const salt = new Uint8Array(saltHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) ?? []);

    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveBits'],
    );

    const derivedBits = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt,
            iterations,
            hash: 'SHA-256',
        },
        keyMaterial,
        DERIVED_KEY_BYTES * 8,
    );

    return toHex(new Uint8Array(derivedBits));
}

function mapUser(row: UserRow): UserRecord {
    return {
        id: row.id,
        username: row.username,
        passwordHash: row.password_hash,
        passwordSalt: row.password_salt,
        passwordIterations: row.password_iterations,
        role: row.role,
        isDisabled: row.is_disabled === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function isUsernameConflict(error: unknown): boolean {
    const message = errorMessage(error);
    return message.includes('UNIQUE constraint failed') && message.includes('users.username');
}

/**
 * Data access for users + their password material.
 *
 * Username is normalized to lower-case on write and read so the NOCASE unique
 * index and lookups stay consistent. Password verification reuses the existing
 * constant-time hex compare (auth/crypto.ts) to avoid timing leaks.
 */
export class UsersRepository {
    constructor(private readonly db: Database) {}

    async createUser(input: CreateUserInput): Promise<UserRecord> {
        const now = new Date().toISOString();
        const id = input.id ?? `user_${crypto.randomUUID()}`;
        const username = normalizeUsername(input.username);

        this.db
            .prepare(
                `INSERT INTO users
          (id, username, password_hash, password_salt, password_iterations,
           role, is_disabled, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, NULL, ?, 0, ?, ?)`,
            )
            .run(id, username, input.role, now, now);

        return {
            id,
            username,
            passwordHash: null,
            passwordSalt: null,
            passwordIterations: null,
            role: input.role,
            isDisabled: false,
            createdAt: now,
            updatedAt: now,
        };
    }

    async getUserByUsername(username: string): Promise<UserRecord | null> {
        const row =
            (this.db
                .prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`)
                .get(normalizeUsername(username)) as UserRow | undefined) ?? null;
        return row ? mapUser(row) : null;
    }

    async getUserById(id: string): Promise<UserRecord | null> {
        const row =
            (this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined) ??
            null;
        return row ? mapUser(row) : null;
    }

    async listUsers(scope: { role?: UserRole } = {}): Promise<UserRecord[]> {
        const clauses: string[] = [];
        const params: unknown[] = [];

        if (scope.role !== undefined) {
            clauses.push('role = ?');
            params.push(scope.role);
        }

        const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        const results = this.db
            .prepare(`SELECT * FROM users ${where} ORDER BY created_at ASC`)
            .all(...params) as UserRow[];
        return results.map(mapUser);
    }

    async updateUser(userId: string, fields: UpdateUserInput): Promise<UserRecord | null> {
        const sets: string[] = [];
        const params: unknown[] = [];

        if (fields.role !== undefined) {
            sets.push('role = ?');
            params.push(fields.role);
        }
        if (fields.isDisabled !== undefined) {
            sets.push('is_disabled = ?');
            params.push(fields.isDisabled ? 1 : 0);
        }

        if (sets.length === 0) {
            return this.getUserById(userId);
        }

        sets.push('updated_at = ?');
        params.push(new Date().toISOString());
        params.push(userId);

        this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);

        return this.getUserById(userId);
    }

    async disableUser(userId: string): Promise<UserRecord | null> {
        return this.updateUser(userId, { isDisabled: true });
    }

    /**
     * Ensure exactly one admin account exists, seeded as username "admin" /
     * password "admin". Called once at startup (see index.ts). Idempotent and
     * safe to call on every boot — it only creates the row the first time; an
     * admin who has since changed the password is never reset.
     */
    async ensureDefaultAdmin(): Promise<void> {
        const existing = await this.listUsers({ role: 'admin' });
        if (existing.length > 0) {
            return;
        }

        const admin = await this.createUser({
            username: DEFAULT_ADMIN_USERNAME,
            role: 'admin',
        });
        await this.setPassword(admin.id, DEFAULT_ADMIN_PASSWORD);
    }

    // ----- passwords -----

    /**
     * Set (or replace) a user's password using PBKDF2-HMAC-SHA-256 with a fresh
     * 16-byte random salt. Stores the hash, salt, and iteration count.
     */
    async setPassword(userId: string, password: string): Promise<void> {
        const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
        const saltHex = toHex(salt);
        const hashHex = await deriveKeyHex(password, saltHex, PBKDF2_ITERATIONS);

        this.db
            .prepare(
                `UPDATE users
         SET password_hash = ?, password_salt = ?, password_iterations = ?, updated_at = ?
         WHERE id = ?`,
            )
            .run(hashHex, saltHex, PBKDF2_ITERATIONS, new Date().toISOString(), userId);
    }

    /**
     * Verify a candidate password against a user's stored PBKDF2 material using a
     * constant-time hex comparison. Returns false if the user has no password set.
     */
    async verifyPassword(user: UserRecord, password: string): Promise<boolean> {
        if (!user.passwordHash || !user.passwordSalt || !user.passwordIterations) {
            return false;
        }

        const candidate = await deriveKeyHex(password, user.passwordSalt, user.passwordIterations);
        return timingSafeEqualHex(candidate, user.passwordHash);
    }

    /**
     * Run a throwaway PBKDF2 derivation with the same cost as {@link verifyPassword}
     * (fixed salt + PBKDF2_ITERATIONS) and discard the result.
     *
     * Call this on login failure paths that have no real password to verify
     * (unknown username, disabled user, unset password) so those paths spend
     * comparable CPU time to a genuine verify, preventing a user-enumeration
     * timing oracle. Always returns false.
     */
    async dummyVerify(password: string): Promise<boolean> {
        await deriveKeyHex(password, DUMMY_VERIFY_SALT_HEX, PBKDF2_ITERATIONS);
        return false;
    }

    // ----- sessions -----

    async deleteSessionsForUser(userId: string): Promise<void> {
        this.db.prepare(`DELETE FROM admin_sessions WHERE user_id = ?`).run(userId);
    }
}
