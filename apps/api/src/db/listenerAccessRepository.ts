import { sha256Hex } from "../auth/crypto";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SHORT_CODE_LENGTH = 6;
const TOKEN_BYTES = 32;
const CREATE_CLAIM_ATTEMPTS = 8;

export type ListenerAccessStatus =
  "pending" | "approved" | "revoked" | "superseded";

export interface ListenerAccessClaim {
  claimId: string;
  claimSecret: string;
  shortCode: string;
}

export interface ListenerAccessClaimRecord {
  claimId: string;
  programId: string;
  clientId: string;
  shortCode: string;
  status: ListenerAccessStatus;
  createdAt: string;
  approvedAt: string | null;
  approvedVia: "scan" | "code" | null;
  revokedAt: string | null;
  supersededAt: string | null;
}

export type ListenerAccessApprovalTarget =
  { claimId: string } | { shortCode: string };

export type ListenerAccessApprovalResult =
  | { status: "approved"; already: boolean }
  | { status: "not_found" }
  | { status: "revoked" };

export interface ListenerAccessStatusCounts {
  pending: number;
  approved: number;
  revoked: number;
}

interface ListenerAccessClaimRow {
  claimId: string;
  programId: string;
  clientId: string;
  shortCode: string;
  status: ListenerAccessStatus;
  createdAt: string;
  approvedAt: string | null;
  approvedVia: "scan" | "code" | null;
  revokedAt: string | null;
  supersededAt: string | null;
}

interface ListenerAccessStatusRow {
  status: ListenerAccessStatus;
}

interface ListenerAccessCountRow {
  pending: number | string | null;
  approved: number | string | null;
  revoked: number | string | null;
}

interface ListenerAccessClaimIdRow {
  claimId: string;
}

export class ListenerNotApprovedError extends Error {
  constructor() {
    super("listener is not approved");
    this.name = "ListenerNotApprovedError";
  }
}

function randomHex(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomShortCode(): string {
  const bytes = new Uint8Array(SHORT_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => CROCKFORD_BASE32[byte & 31]).join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isShortCodeCollision(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes("UNIQUE") &&
    (message.includes("idx_listener_access_program_code") ||
      (message.includes("listener_access.program_id") &&
        message.includes("listener_access.short_code")))
  );
}

function claimId(): string {
  return `listener_access_${crypto.randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class ListenerAccessRepository {
  constructor(
    private readonly db: D1Database,
    private readonly generateShortCode: () => string = randomShortCode,
  ) {}

  async createClaim(
    programId: string,
    clientId: string,
  ): Promise<ListenerAccessClaim> {
    let collision: unknown;

    for (let attempt = 0; attempt < CREATE_CLAIM_ATTEMPTS; attempt += 1) {
      const id = claimId();
      const claimSecret = randomHex();
      const shortCode = this.generateShortCode();
      const claimSecretHash = await sha256Hex(claimSecret);
      const timestamp = nowIso();

      try {
        await this.db.batch([
          this.db
            .prepare(
              `UPDATE listener_access
              SET status = 'superseded', superseded_at = ?
              WHERE program_id = ? AND client_id = ? AND status = 'pending'`,
            )
            .bind(timestamp, programId, clientId),
          this.db
            .prepare(
              `INSERT INTO listener_access
              (id, program_id, client_id, short_code, claim_secret_hash, status,
               access_token_hash, created_at, approved_at, approved_via,
               revoked_at, superseded_at)
              VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, NULL, NULL, NULL)`,
            )
            .bind(
              id,
              programId,
              clientId,
              shortCode,
              claimSecretHash,
              timestamp,
            ),
        ]);
        return { claimId: id, claimSecret, shortCode };
      } catch (error) {
        if (!isShortCodeCollision(error)) {
          throw error;
        }
        collision = error;
      }
    }

    throw (
      collision ?? new Error("listener access short-code allocation failed")
    );
  }

  async getClaimForRedeem(
    programId: string,
    id: string,
    claimSecret: string,
  ): Promise<ListenerAccessClaimRecord | null> {
    const claimSecretHash = await sha256Hex(claimSecret);
    return this.db
      .prepare(
        `SELECT id as claimId,
          program_id as programId,
          client_id as clientId,
          short_code as shortCode,
          status,
          created_at as createdAt,
          approved_at as approvedAt,
          approved_via as approvedVia,
          revoked_at as revokedAt,
          superseded_at as supersededAt
        FROM listener_access
        WHERE program_id = ? AND id = ? AND claim_secret_hash = ?`,
      )
      .bind(programId, id, claimSecretHash)
      .first<ListenerAccessClaimRow>();
  }

  async mintAccessToken(
    programId: string,
    id: string,
    claimSecret: string,
  ): Promise<string | null> {
    const token = randomHex();
    const [claimSecretHash, accessTokenHash] = await Promise.all([
      sha256Hex(claimSecret),
      sha256Hex(token),
    ]);
    const result = await this.db
      .prepare(
        `UPDATE listener_access
        SET access_token_hash = ?
        WHERE program_id = ? AND id = ? AND claim_secret_hash = ?
          AND status = 'approved'`,
      )
      .bind(accessTokenHash, programId, id, claimSecretHash)
      .run();

    return (result.meta.changes ?? 0) > 0 ? token : null;
  }

  async verifyAccessToken(
    programId: string,
    accessToken: string,
  ): Promise<boolean> {
    const accessTokenHash = await sha256Hex(accessToken);
    const row = await this.db
      .prepare(
        `SELECT 1 as approved
        FROM listener_access
        WHERE access_token_hash = ? AND program_id = ? AND status = 'approved'`,
      )
      .bind(accessTokenHash, programId)
      .first<{ approved: number }>();
    return row !== null;
  }

  async getStatusForAccessToken(
    programId: string,
    accessToken: string,
  ): Promise<"approved" | "revoked" | "unknown"> {
    const accessTokenHash = await sha256Hex(accessToken);
    const row = await this.db
      .prepare(
        `SELECT status
        FROM listener_access
        WHERE access_token_hash = ? AND program_id = ?`,
      )
      .bind(accessTokenHash, programId)
      .first<ListenerAccessStatusRow>();

    return row?.status === "approved" || row?.status === "revoked"
      ? row.status
      : "unknown";
  }

  async approveClaim(
    programId: string,
    target: ListenerAccessApprovalTarget,
    approvedVia: "scan" | "code",
  ): Promise<ListenerAccessApprovalResult> {
    const column = "claimId" in target ? "id" : "short_code";
    const value = "claimId" in target ? target.claimId : target.shortCode;
    const result = await this.db
      .prepare(
        `UPDATE listener_access
        SET status = 'approved', approved_at = ?, approved_via = ?
        WHERE program_id = ? AND ${column} = ? AND status = 'pending'`,
      )
      .bind(nowIso(), approvedVia, programId, value)
      .run();

    if ((result.meta.changes ?? 0) > 0) {
      return { status: "approved", already: false };
    }

    const row = await this.db
      .prepare(
        `SELECT status FROM listener_access
        WHERE program_id = ? AND ${column} = ?`,
      )
      .bind(programId, value)
      .first<ListenerAccessStatusRow>();

    if (row?.status === "approved") {
      return { status: "approved", already: true };
    }
    if (row?.status === "revoked") {
      return { status: "revoked" };
    }
    return { status: "not_found" };
  }

  async revokeForClient(programId: string, clientId: string): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE listener_access
        SET status = 'revoked', revoked_at = ?
        WHERE program_id = ? AND client_id = ? AND status <> 'revoked'`,
      )
      .bind(nowIso(), programId, clientId)
      .run();
    return result.meta.changes ?? 0;
  }

  async countByStatus(programId: string): Promise<ListenerAccessStatusCounts> {
    const row = await this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
          SUM(CASE WHEN status = 'revoked' THEN 1 ELSE 0 END) as revoked
        FROM listener_access
        WHERE program_id = ?`,
      )
      .bind(programId)
      .first<ListenerAccessCountRow>();

    return {
      pending: Number(row?.pending ?? 0),
      approved: Number(row?.approved ?? 0),
      revoked: Number(row?.revoked ?? 0),
    };
  }

  async listApprovedSince(
    programId: string,
    cutoffIso: string,
  ): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id as claimId
        FROM listener_access
        WHERE program_id = ? AND status = 'approved' AND approved_at >= ?
        ORDER BY approved_at ASC, id ASC`,
      )
      .bind(programId, cutoffIso)
      .all<ListenerAccessClaimIdRow>();
    return results.map((row) => row.claimId);
  }
}

export async function requireListenerApproval(
  db: D1Database,
  programId: string,
  accessToken?: string,
): Promise<void> {
  if (!accessToken) {
    throw new ListenerNotApprovedError();
  }

  const approved = await new ListenerAccessRepository(db).verifyAccessToken(
    programId,
    accessToken,
  );
  if (!approved) {
    throw new ListenerNotApprovedError();
  }
}
