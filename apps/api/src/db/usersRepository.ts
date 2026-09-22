import { timingSafeEqualHex } from "../auth/crypto";
import type { Database } from "./sqlite";

export type UserRole = "platform_admin" | "org_admin" | "viewer";

export type OrgRecord = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type UserRecord = {
  id: string;
  email: string;
  passwordHash: string | null;
  passwordSalt: string | null;
  passwordIterations: number | null;
  role: UserRole;
  orgId: string | null;
  isDisabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type UpdateOrgInput = {
  name: string;
};

export type CreateUserInput = {
  email: string;
  role: UserRole;
  orgId?: string | null;
  id?: string;
};

export type UpdateUserInput = {
  email?: string;
  role?: UserRole;
  orgId?: string | null;
  isDisabled?: boolean;
};

export type CreateOrgWithOrgAdminInput = {
  orgName: string;
  adminEmail: string;
  id?: string;
  adminId?: string;
};

export type ListUsersScope = {
  orgId?: string | null;
  role?: UserRole;
};

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
// verify (unknown email, disabled user, unset password). Running this keeps the
// failure-path latency comparable to the real-verify path, closing a
// user-enumeration timing oracle. The derived key is discarded.
const DUMMY_VERIFY_SALT_HEX = "00000000000000000000000000000000";

type OrgRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

type UserRow = {
  id: string;
  email: string;
  password_hash: string | null;
  password_salt: string | null;
  password_iterations: number | null;
  role: UserRole;
  org_id: string | null;
  is_disabled: number;
  created_at: string;
  updated_at: string;
};

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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
  iterations: number
): Promise<string> {
  const salt = new Uint8Array(
    saltHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) ?? []
  );

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256"
    },
    keyMaterial,
    DERIVED_KEY_BYTES * 8
  );

  return toHex(new Uint8Array(derivedBits));
}

function mapOrg(row: OrgRow): OrgRecord {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    passwordIterations: row.password_iterations,
    role: row.role,
    orgId: row.org_id,
    isDisabled: row.is_disabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isEmailConflict(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes("UNIQUE constraint failed") &&
    message.includes("users.email")
  );
}

export function isOrgAdminConflict(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes("UNIQUE constraint failed") &&
    (message.includes("idx_one_active_org_admin") ||
      message.includes("users.org_id"))
  );
}

/**
 * Data access for orgs + users + their password material.
 *
 * Email is normalized to lower-case on write and read so the NOCASE unique
 * index and lookups stay consistent. Password verification reuses the existing
 * constant-time hex compare (auth/crypto.ts) to avoid timing leaks.
 */
export class UsersRepository {
  constructor(private readonly db: Database) {}

  // ----- orgs -----

  async createOrg(input: { name: string; id?: string }): Promise<OrgRecord> {
    const now = new Date().toISOString();
    const id = input.id ?? `org_${crypto.randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO orgs (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`
      )
      .run(id, input.name, now, now);

    return { id, name: input.name, createdAt: now, updatedAt: now };
  }

  async createOrgWithOrgAdmin(
    input: CreateOrgWithOrgAdminInput
  ): Promise<{ org: OrgRecord; admin: UserRecord }> {
    const now = new Date().toISOString();
    const id = input.id ?? `org_${crypto.randomUUID()}`;
    const adminId = input.adminId ?? `user_${crypto.randomUUID()}`;
    const adminEmail = normalizeEmail(input.adminEmail);

    const org: OrgRecord = { id, name: input.orgName, createdAt: now, updatedAt: now };
    const admin: UserRecord = {
      id: adminId,
      email: adminEmail,
      passwordHash: null,
      passwordSalt: null,
      passwordIterations: null,
      role: "org_admin",
      orgId: id,
      isDisabled: false,
      createdAt: now,
      updatedAt: now
    };

    // A transaction is atomic — a unique conflict (email / one-active-org_admin)
    // rolls back BOTH inserts, so no orphan org is left behind. Errors propagate
    // to the route handler, which maps isEmailConflict/isOrgAdminConflict → 409.
    const insertOrgAndAdmin = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO orgs (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`
        )
        .run(org.id, org.name, org.createdAt, org.updatedAt);

      this.db
        .prepare(
          `INSERT INTO users
            (id, email, password_hash, password_salt, password_iterations,
             role, org_id, is_disabled, created_at, updated_at)
           VALUES (?, ?, NULL, NULL, NULL, ?, ?, 0, ?, ?)`
        )
        .run(
          admin.id,
          admin.email,
          admin.role,
          admin.orgId,
          admin.createdAt,
          admin.updatedAt
        );
    });
    insertOrgAndAdmin();

    return { org, admin };
  }

  async getOrg(id: string): Promise<OrgRecord | null> {
    const row = (this.db
      .prepare(`SELECT * FROM orgs WHERE id = ?`)
      .get(id) as OrgRow | undefined) ?? null;
    return row ? mapOrg(row) : null;
  }

  async listOrgs(): Promise<OrgRecord[]> {
    const results = this.db
      .prepare(`SELECT * FROM orgs ORDER BY created_at ASC`)
      .all() as OrgRow[];
    return results.map(mapOrg);
  }

  // ----- users -----

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const now = new Date().toISOString();
    const id = input.id ?? `user_${crypto.randomUUID()}`;
    const email = normalizeEmail(input.email);
    const orgId = input.orgId ?? null;

    this.db
      .prepare(
        `INSERT INTO users
          (id, email, password_hash, password_salt, password_iterations,
           role, org_id, is_disabled, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, NULL, ?, ?, 0, ?, ?)`
      )
      .run(id, email, input.role, orgId, now, now);

    return {
      id,
      email,
      passwordHash: null,
      passwordSalt: null,
      passwordIterations: null,
      role: input.role,
      orgId,
      isDisabled: false,
      createdAt: now,
      updatedAt: now
    };
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const row = (this.db
      .prepare(`SELECT * FROM users WHERE email = ? COLLATE NOCASE`)
      .get(normalizeEmail(email)) as UserRow | undefined) ?? null;
    return row ? mapUser(row) : null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const row = (this.db
      .prepare(`SELECT * FROM users WHERE id = ?`)
      .get(id) as UserRow | undefined) ?? null;
    return row ? mapUser(row) : null;
  }

  async listUsers(scope: ListUsersScope = {}): Promise<UserRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (scope.orgId !== undefined) {
      if (scope.orgId === null) {
        clauses.push("org_id IS NULL");
      } else {
        clauses.push("org_id = ?");
        params.push(scope.orgId);
      }
    }
    if (scope.role !== undefined) {
      clauses.push("role = ?");
      params.push(scope.role);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const results = this.db
      .prepare(`SELECT * FROM users ${where} ORDER BY created_at ASC`)
      .all(...params) as UserRow[];
    return results.map(mapUser);
  }

  async updateUser(
    userId: string,
    fields: UpdateUserInput
  ): Promise<UserRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (fields.email !== undefined) {
      sets.push("email = ?");
      params.push(normalizeEmail(fields.email));
    }
    if (fields.role !== undefined) {
      sets.push("role = ?");
      params.push(fields.role);
    }
    if (fields.orgId !== undefined) {
      sets.push("org_id = ?");
      params.push(fields.orgId);
    }
    if (fields.isDisabled !== undefined) {
      sets.push("is_disabled = ?");
      params.push(fields.isDisabled ? 1 : 0);
    }

    if (sets.length === 0) {
      return this.getUserById(userId);
    }

    sets.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(userId);

    this.db
      .prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);

    return this.getUserById(userId);
  }

  async updateOrg(
    orgId: string,
    input: UpdateOrgInput
  ): Promise<OrgRecord | null> {
    const updatedAt = new Date().toISOString();
    const result = this.db
      .prepare(`UPDATE orgs SET name = ?, updated_at = ? WHERE id = ?`)
      .run(input.name, updatedAt, orgId);

    if (result.changes === 0) {
      return null;
    }

    return this.getOrg(orgId);
  }

  async disableUser(userId: string): Promise<UserRecord | null> {
    return this.updateUser(userId, { isDisabled: true });
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
         WHERE id = ?`
      )
      .run(hashHex, saltHex, PBKDF2_ITERATIONS, new Date().toISOString(), userId);
  }

  /**
   * Verify a candidate password against a user's stored PBKDF2 material using a
   * constant-time hex comparison. Returns false if the user has no password set.
   */
  async verifyPassword(user: UserRecord, password: string): Promise<boolean> {
    if (
      !user.passwordHash ||
      !user.passwordSalt ||
      !user.passwordIterations
    ) {
      return false;
    }

    const candidate = await deriveKeyHex(
      password,
      user.passwordSalt,
      user.passwordIterations
    );
    return timingSafeEqualHex(candidate, user.passwordHash);
  }

  /**
   * Run a throwaway PBKDF2 derivation with the same cost as {@link verifyPassword}
   * (fixed salt + PBKDF2_ITERATIONS) and discard the result.
   *
   * Call this on login failure paths that have no real password to verify
   * (unknown email, disabled user, unset password) so those paths spend
   * comparable CPU time to a genuine verify, preventing a user-enumeration
   * timing oracle. Always returns false.
   */
  async dummyVerify(password: string): Promise<boolean> {
    await deriveKeyHex(password, DUMMY_VERIFY_SALT_HEX, PBKDF2_ITERATIONS);
    return false;
  }

  // ----- sessions -----

  async deleteSessionsForUser(userId: string): Promise<void> {
    this.db
      .prepare(`DELETE FROM admin_sessions WHERE user_id = ?`)
      .run(userId);
  }
}
