import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { sha256Hex } from "../src/auth/crypto";
import { ListenerAccessRepository } from "../src/db/listenerAccessRepository";
import type { ConnectionEvent } from "../src/queue/connectionEvents";
import { countingDb, targetsTable } from "./helpers/countingDb";
import {
  adminCookie,
  buildTestEnv,
  seedPlatformAdmin,
  testEnv,
} from "./test-env";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
type IncomingRequestInit = ConstructorParameters<typeof IncomingRequest>[1];

interface ProgramGraph {
  programId: string;
  programSlug: string;
  hindiStreamId: string;
  englishStreamId: string;
  publisherSessionId?: string;
  publisherTrackName?: string;
}

async function request(
  path: string,
  init: IncomingRequestInit = {},
  workerEnv: Env = testEnv,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(`https://bhasha.test${path}`, init),
    workerEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function resetDb(): Promise<void> {
  await testEnv.DB.exec("DELETE FROM listener_access");
  await testEnv.DB.exec("DELETE FROM listener_realtime_cleanup_targets");
  await testEnv.DB.exec("DELETE FROM stream_events");
  await testEnv.DB.exec("DELETE FROM listener_connections");
  await testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
  await testEnv.DB.exec("DELETE FROM translator_sessions");
  await testEnv.DB.exec("DELETE FROM translator_stream_assignments");
  await testEnv.DB.exec("DELETE FROM translators");
  await testEnv.DB.exec("DELETE FROM language_streams");
  await testEnv.DB.exec("DELETE FROM programs");
}

async function seedProgramGraph(
  options: {
    accessControlEnabled?: boolean;
    published?: boolean;
  } = {},
): Promise<ProgramGraph> {
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const programId = `program_${suffix}`;
  const programSlug = `listener-access-${suffix}`;
  const hindiStreamId = `stream_${suffix}_hi`;
  const englishStreamId = `stream_${suffix}_en`;

  await testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes,
     access_control_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'live', '', ?, ?, ?)`,
  )
    .bind(
      programId,
      programSlug,
      "Listener Access Test",
      "Main Hall",
      "2026-08-26",
      options.accessControlEnabled ? 1 : 0,
      now,
      now,
    )
    .run();

  for (const [streamId, languageName, languageCode, displayOrder] of [
    [hindiStreamId, "Hindi", "hi", 1],
    [englishStreamId, "English", "en", 2],
  ] as const) {
    await testEnv.DB.prepare(
      `INSERT INTO language_streams
      (id, program_id, language_name, language_code, display_order, is_active,
       is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 0, NULL, NULL, ?, ?)`,
    )
      .bind(
        streamId,
        programId,
        languageName,
        languageCode,
        displayOrder,
        now,
        now,
      )
      .run();
  }

  if (!options.published) {
    return { programId, programSlug, hindiStreamId, englishStreamId };
  }

  const translatorId = `translator_${suffix}`;
  const publishId = `realtime_publish_session_${suffix}`;
  const publisherSessionId = `cf_publisher_${suffix}`;
  const publisherTrackName = "mic-track";
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();

  await testEnv.DB.prepare(
    `INSERT INTO translators
    (id, program_id, name, password_hash, created_at, updated_at)
    VALUES (?, ?, 'Hindi translator', 'sha256:unused', ?, ?)`,
  )
    .bind(translatorId, programId, now, now)
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO realtime_publish_sessions
    (id, program_id, language_stream_id, translator_id, cloudflare_session_id,
     published_track_name, published_track_mid, state, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '0', 'published', ?, ?, ?)`,
  )
    .bind(
      publishId,
      programId,
      hindiStreamId,
      translatorId,
      publisherSessionId,
      publisherTrackName,
      expiresAt,
      now,
      now,
    )
    .run();

  await testEnv.DB.prepare(
    `UPDATE language_streams
    SET is_live = 1, cloudflare_session_id = ?, current_track_id = ?, updated_at = ?
    WHERE id = ?`,
  )
    .bind(publisherSessionId, publisherTrackName, now, hindiStreamId)
    .run();

  return {
    programId,
    programSlug,
    hindiStreamId,
    englishStreamId,
    publisherSessionId,
    publisherTrackName,
  };
}

function realtimeEnv(overrides: Partial<Env> = {}): Env {
  const realtimeFetch = (async () =>
    Response.json({
      sessionId: `cf_listener_${crypto.randomUUID()}`,
      sessionDescription: { type: "answer", sdp: "answer-sdp" },
    })) as typeof fetch;
  return buildTestEnv({ ...overrides, REALTIME_FETCH: realtimeFetch });
}

async function setAccessControl(
  programId: string,
  enabled: boolean,
): Promise<void> {
  await testEnv.DB.prepare(
    "UPDATE programs SET access_control_enabled = ? WHERE id = ?",
  )
    .bind(enabled ? 1 : 0, programId)
    .run();
}

async function mintAccess(
  graph: ProgramGraph,
  clientId = `client_${crypto.randomUUID()}`,
): Promise<{
  accessToken: string;
  claimId: string;
  claimSecret: string;
  clientId: string;
}> {
  const claimResponse = await request("/api/listeners/access/claim", {
    method: "POST",
    body: JSON.stringify({ programSlug: graph.programSlug, clientId }),
  });
  expect(claimResponse.status).toBe(201);
  const claim = await claimResponse.json<{
    claimId: string;
    claimSecret: string;
    shortCode: string;
  }>();

  const repo = new ListenerAccessRepository(testEnv.DB);
  await expect(
    repo.approveClaim(graph.programId, { claimId: claim.claimId }, "scan"),
  ).resolves.toEqual({ status: "approved", already: false });

  const statusResponse = await request("/api/listeners/access/status", {
    method: "POST",
    body: JSON.stringify({
      programSlug: graph.programSlug,
      claimId: claim.claimId,
      claimSecret: claim.claimSecret,
    }),
  });
  expect(statusResponse.status).toBe(200);
  const status = await statusResponse.json<{
    state: string;
    accessToken: string;
  }>();
  expect(status.state).toBe("approved");
  expect(status.accessToken).toMatch(/^[0-9a-f]{64}$/);

  return {
    accessToken: status.accessToken,
    claimId: claim.claimId,
    claimSecret: claim.claimSecret,
    clientId,
  };
}

function createInput(
  graph: ProgramGraph,
  clientId: string,
  accessToken?: string,
): Record<string, string> {
  return {
    programSlug: graph.programSlug,
    streamId: graph.hindiStreamId,
    clientId,
    ...(accessToken ? { accessToken } : {}),
  };
}

describe("ListenerAccessRepository", () => {
  beforeEach(resetDb);

  it("creates hashed Crockford claims and atomically supersedes prior pending claims", async () => {
    const graph = await seedProgramGraph();
    const repo = new ListenerAccessRepository(testEnv.DB);
    const first = await repo.createClaim(graph.programId, "client_1");

    expect(first.claimId).toMatch(/^listener_access_/);
    expect(first.claimSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(first.shortCode).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);

    const stored = await testEnv.DB.prepare(
      `SELECT claim_secret_hash as claimSecretHash, status
      FROM listener_access WHERE id = ?`,
    )
      .bind(first.claimId)
      .first<{ claimSecretHash: string; status: string }>();
    expect(stored).toEqual({
      claimSecretHash: await sha256Hex(first.claimSecret),
      status: "pending",
    });

    const second = await repo.createClaim(graph.programId, "client_1");
    const { results } = await testEnv.DB.prepare(
      `SELECT id, status, superseded_at as supersededAt
      FROM listener_access WHERE program_id = ? AND client_id = ? ORDER BY created_at, id`,
    )
      .bind(graph.programId, "client_1")
      .all<{ id: string; status: string; supersededAt: string | null }>();
    expect(results).toEqual([
      {
        id: first.claimId,
        status: "superseded",
        supersededAt: expect.any(String),
      },
      { id: second.claimId, status: "pending", supersededAt: null },
    ]);
  });

  it("retries a short-code unique collision without losing the pending claim", async () => {
    const graph = await seedProgramGraph();
    const timestamp = new Date().toISOString();
    const priorClaimId = `listener_access_prior_${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO listener_access
      (id, program_id, client_id, short_code, claim_secret_hash, status,
       access_token_hash, created_at, approved_at, approved_via,
       revoked_at, superseded_at)
      VALUES
        (?, ?, 'client_existing', 'AAAAAA', ?, 'pending', NULL, ?, NULL, NULL, NULL, NULL),
        (?, ?, 'client_collision', 'CCCCCC', ?, 'pending', NULL, ?, NULL, NULL, NULL, NULL)`,
    )
      .bind(
        `listener_access_existing_${crypto.randomUUID()}`,
        graph.programId,
        await sha256Hex("existing-claim-secret"),
        timestamp,
        priorClaimId,
        graph.programId,
        await sha256Hex("prior-claim-secret"),
        timestamp,
      )
      .run();
    const generateShortCode = vi
      .fn<() => string>()
      .mockReturnValueOnce("AAAAAA")
      .mockReturnValueOnce("BBBBBB");
    let batches = 0;
    let priorStatusAfterCollision: string | null = null;
    const collisionDb = new Proxy(testEnv.DB, {
      get(target, property, receiver) {
        if (property !== "batch") {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }

        return async (statements: D1PreparedStatement[]) => {
          batches += 1;
          try {
            return await target.batch(statements);
          } catch (error) {
            priorStatusAfterCollision =
              (
                await target
                  .prepare("SELECT status FROM listener_access WHERE id = ?")
                  .bind(priorClaimId)
                  .first<{ status: string }>()
              )?.status ?? null;
            throw error;
          }
        };
      },
    }) as D1Database;

    const claim = await new ListenerAccessRepository(
      collisionDb,
      generateShortCode,
    ).createClaim(graph.programId, "client_collision");

    expect(batches).toBe(2);
    expect(priorStatusAfterCollision).toBe("pending");
    expect(generateShortCode).toHaveBeenCalledTimes(2);
    expect(claim.shortCode).toBe("BBBBBB");
    const { results } = await testEnv.DB.prepare(
      `SELECT client_id as clientId, short_code as shortCode, status
      FROM listener_access
      WHERE program_id = ?
      ORDER BY short_code`,
    )
      .bind(graph.programId)
      .all<{ clientId: string; shortCode: string; status: string }>();
    expect(results).toEqual([
      {
        clientId: "client_existing",
        shortCode: "AAAAAA",
        status: "pending",
      },
      {
        clientId: "client_collision",
        shortCode: "BBBBBB",
        status: "pending",
      },
      {
        clientId: "client_collision",
        shortCode: "CCCCCC",
        status: "superseded",
      },
    ]);
  });

  it("preserves approved rows on re-claim and implements guarded transitions", async () => {
    const graph = await seedProgramGraph();
    const repo = new ListenerAccessRepository(testEnv.DB);
    const first = await repo.createClaim(graph.programId, "client_approved");

    await expect(
      repo.approveClaim(
        graph.programId,
        { shortCode: first.shortCode },
        "code",
      ),
    ).resolves.toEqual({ status: "approved", already: false });
    await expect(
      repo.approveClaim(graph.programId, { claimId: first.claimId }, "scan"),
    ).resolves.toEqual({ status: "approved", already: true });

    const next = await repo.createClaim(graph.programId, "client_approved");
    expect(
      await repo.getClaimForRedeem(
        graph.programId,
        first.claimId,
        first.claimSecret,
      ),
    ).toMatchObject({ status: "approved" });
    expect(
      await repo.getClaimForRedeem(
        graph.programId,
        next.claimId,
        next.claimSecret,
      ),
    ).toMatchObject({ status: "pending" });

    const superseded = await repo.createClaim(
      graph.programId,
      "client_pending",
    );
    await repo.createClaim(graph.programId, "client_pending");
    await expect(
      repo.approveClaim(
        graph.programId,
        { claimId: superseded.claimId },
        "scan",
      ),
    ).resolves.toEqual({ status: "not_found" });

    await repo.revokeForClient(graph.programId, "client_approved");
    await expect(
      repo.approveClaim(graph.programId, { claimId: first.claimId }, "scan"),
    ).resolves.toEqual({ status: "revoked" });
  });

  it("re-mints with last-write-wins, revokes all client rows, counts, and lists the window", async () => {
    const graph = await seedProgramGraph();
    const repo = new ListenerAccessRepository(testEnv.DB);
    const claim = await repo.createClaim(graph.programId, "client_remint");
    await repo.approveClaim(
      graph.programId,
      { claimId: claim.claimId },
      "scan",
    );

    const firstToken = await repo.mintAccessToken(
      graph.programId,
      claim.claimId,
      claim.claimSecret,
    );
    const secondToken = await repo.mintAccessToken(
      graph.programId,
      claim.claimId,
      claim.claimSecret,
    );
    expect(firstToken).toMatch(/^[0-9a-f]{64}$/);
    expect(secondToken).toMatch(/^[0-9a-f]{64}$/);
    expect(secondToken).not.toBe(firstToken);
    await expect(
      repo.verifyAccessToken(graph.programId, firstToken ?? ""),
    ).resolves.toBe(false);
    await expect(
      repo.verifyAccessToken(graph.programId, secondToken ?? ""),
    ).resolves.toBe(true);

    expect(
      await repo.listApprovedSince(
        graph.programId,
        new Date(Date.now() - 90_000).toISOString(),
      ),
    ).toContain(claim.claimId);
    expect(await repo.countByStatus(graph.programId)).toEqual({
      pending: 0,
      approved: 1,
      revoked: 0,
    });

    expect(await repo.revokeForClient(graph.programId, "client_remint")).toBe(
      1,
    );
    await expect(
      repo.verifyAccessToken(graph.programId, secondToken ?? ""),
    ).resolves.toBe(false);
    expect(await repo.countByStatus(graph.programId)).toEqual({
      pending: 0,
      approved: 0,
      revoked: 1,
    });
    expect(
      await repo.listApprovedSince(
        graph.programId,
        new Date(Date.now() - 90_000).toISOString(),
      ),
    ).toEqual([]);
  });
});

describe("listener access claim and status routes", () => {
  beforeEach(resetDb);

  it("creates claims, reports transitions, preserves claim-invalid parity, and re-mints", async () => {
    const graph = await seedProgramGraph({ accessControlEnabled: true });
    const unknownProgram = await request("/api/listeners/access/claim", {
      method: "POST",
      body: JSON.stringify({ programSlug: "missing", clientId: "client_1" }),
    });
    expect(unknownProgram.status).toBe(404);
    expect(unknownProgram.headers.get("cache-control")).toBe("no-store");

    const created = await request("/api/listeners/access/claim", {
      method: "POST",
      body: JSON.stringify({
        programSlug: graph.programSlug,
        clientId: "client_1",
      }),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const claim = await created.json<{
      claimId: string;
      claimSecret: string;
      shortCode: string;
    }>();

    const pending = await request("/api/listeners/access/status", {
      method: "POST",
      body: JSON.stringify({
        programSlug: graph.programSlug,
        claimId: claim.claimId,
        claimSecret: claim.claimSecret,
      }),
    });
    expect(await pending.json()).toEqual({ state: "pending" });
    expect(pending.headers.get("cache-control")).toBe("no-store");

    const badSecret = await request("/api/listeners/access/status", {
      method: "POST",
      body: JSON.stringify({
        programSlug: graph.programSlug,
        claimId: claim.claimId,
        claimSecret: "wrong-secret",
      }),
    });
    const unknownClaim = await request("/api/listeners/access/status", {
      method: "POST",
      body: JSON.stringify({
        programSlug: graph.programSlug,
        claimId: "listener_access_missing",
        claimSecret: "wrong-secret",
      }),
    });
    expect(badSecret.status).toBe(403);
    expect(unknownClaim.status).toBe(403);
    expect(await badSecret.json()).toEqual({ error: "claim_invalid" });
    expect(await unknownClaim.json()).toEqual({ error: "claim_invalid" });
    expect(badSecret.headers.get("cache-control")).toBe("no-store");

    const repo = new ListenerAccessRepository(testEnv.DB);
    await repo.approveClaim(
      graph.programId,
      { claimId: claim.claimId },
      "scan",
    );
    const firstMint = await request("/api/listeners/access/status", {
      method: "POST",
      body: JSON.stringify({
        programSlug: graph.programSlug,
        claimId: claim.claimId,
        claimSecret: claim.claimSecret,
      }),
    });
    const first = await firstMint.json<{
      state: string;
      accessToken: string;
    }>();
    expect(first.state).toBe("approved");

    const tokenProof = await request("/api/listeners/access/status", {
      method: "POST",
      body: JSON.stringify({
        programSlug: graph.programSlug,
        accessToken: first.accessToken,
      }),
    });
    expect(await tokenProof.json()).toEqual({ state: "approved" });

    const secondMint = await request("/api/listeners/access/status", {
      method: "POST",
      body: JSON.stringify({
        programSlug: graph.programSlug,
        claimId: claim.claimId,
        claimSecret: claim.claimSecret,
      }),
    });
    const second = await secondMint.json<{
      state: string;
      accessToken: string;
    }>();
    expect(second.accessToken).not.toBe(first.accessToken);
    await expect(
      repo.verifyAccessToken(graph.programId, first.accessToken),
    ).resolves.toBe(false);
    await expect(
      repo.verifyAccessToken(graph.programId, second.accessToken),
    ).resolves.toBe(true);

    await repo.revokeForClient(graph.programId, "client_1");
    const revokedToken = await request("/api/listeners/access/status", {
      method: "POST",
      body: JSON.stringify({
        programSlug: graph.programSlug,
        accessToken: second.accessToken,
      }),
    });
    expect(await revokedToken.json()).toEqual({ state: "revoked" });

    const unknownToken = await request("/api/listeners/access/status", {
      method: "POST",
      body: JSON.stringify({
        programSlug: graph.programSlug,
        accessToken: "unknown-token",
      }),
    });
    expect(unknownToken.status).toBe(200);
    expect(await unknownToken.json()).toEqual({ state: "unknown" });
  });

  it("maps a valid secret for superseded and revoked claims without leaking a token", async () => {
    const graph = await seedProgramGraph({ accessControlEnabled: true });
    const repo = new ListenerAccessRepository(testEnv.DB);
    const superseded = await repo.createClaim(graph.programId, "client_1");
    await repo.createClaim(graph.programId, "client_1");

    const supersededStatus = await request("/api/listeners/access/status", {
      method: "POST",
      body: JSON.stringify({
        programSlug: graph.programSlug,
        claimId: superseded.claimId,
        claimSecret: superseded.claimSecret,
      }),
    });
    expect(await supersededStatus.json()).toEqual({ state: "unknown" });

    const revoked = await repo.createClaim(graph.programId, "client_revoked");
    await repo.revokeForClient(graph.programId, "client_revoked");
    const revokedStatus = await request("/api/listeners/access/status", {
      method: "POST",
      body: JSON.stringify({
        programSlug: graph.programSlug,
        claimId: revoked.claimId,
        claimSecret: revoked.claimSecret,
      }),
    });
    expect(await revokedStatus.json()).toEqual({ state: "revoked" });
  });
});

describe("listener access approval broadcast", () => {
  beforeEach(resetDb);

  it("returns recent approvals and edge-caches each flag-specific payload", async () => {
    const enabled = await seedProgramGraph({ accessControlEnabled: true });
    const disabled = await seedProgramGraph({ accessControlEnabled: false });
    const repo = new ListenerAccessRepository(testEnv.DB);
    const recent = await repo.createClaim(enabled.programId, "client_recent");
    const old = await repo.createClaim(enabled.programId, "client_old");
    const revoked = await repo.createClaim(enabled.programId, "client_revoked");
    const other = await repo.createClaim(disabled.programId, "client_other");
    await repo.approveClaim(
      enabled.programId,
      { claimId: recent.claimId },
      "scan",
    );
    await repo.approveClaim(
      enabled.programId,
      { claimId: old.claimId },
      "scan",
    );
    await repo.approveClaim(
      enabled.programId,
      { claimId: revoked.claimId },
      "scan",
    );
    await repo.approveClaim(
      disabled.programId,
      { claimId: other.claimId },
      "scan",
    );
    await repo.revokeForClient(enabled.programId, "client_revoked");
    await testEnv.DB.prepare(
      "UPDATE listener_access SET approved_at = ? WHERE id = ?",
    )
      .bind(new Date(Date.now() - 120_000).toISOString(), old.claimId)
      .run();

    const enabledSql: string[] = [];
    const enabledPath =
      `/api/public/programs/${enabled.programSlug}/access/approved`;
    const enabledEnv = buildTestEnv({
      DB: countingDb(testEnv.DB, enabledSql),
    });
    const enabledResponse = await request(
      enabledPath,
      {},
      enabledEnv,
    );
    expect(enabledResponse.status).toBe(200);
    expect(enabledResponse.headers.get("cache-control")).toBe(
      "public, max-age=10",
    );
    expect(await enabledResponse.json()).toEqual({
      approved: [recent.claimId],
    });
    const firstOriginQueryCount = enabledSql.length;
    expect(
      enabledSql.filter((statement) =>
        targetsTable(statement, "listener_access"),
      ),
    ).toHaveLength(1);

    const cachedEnabledResponse = await request(enabledPath, {}, enabledEnv);
    expect(cachedEnabledResponse.status).toBe(200);
    expect(await cachedEnabledResponse.json()).toEqual({
      approved: [recent.claimId],
    });
    expect(enabledSql).toHaveLength(firstOriginQueryCount);

    const sql: string[] = [];
    const disabledResponse = await request(
      `/api/public/programs/${disabled.programSlug}/access/approved`,
      {},
      buildTestEnv({ DB: countingDb(testEnv.DB, sql) }),
    );
    expect(disabledResponse.status).toBe(200);
    expect(disabledResponse.headers.get("cache-control")).toBe(
      "public, max-age=3600",
    );
    expect(await disabledResponse.json()).toEqual({ approved: [] });
    expect(
      sql.filter((statement) => targetsTable(statement, "listener_access")),
    ).toEqual([]);
  });
});

describe("listener approval gate", () => {
  beforeEach(resetDb);

  it("gates active-publisher before stream disclosure and accepts only a current token", async () => {
    const graph = await seedProgramGraph({
      accessControlEnabled: true,
      published: true,
    });
    const access = await mintAccess(graph, "client_primary");
    const path = `/api/listeners/active-publisher?programSlug=${graph.programSlug}&streamId=${graph.hindiStreamId}`;

    const missing = await request(path);
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ error: "listener_not_approved" });

    const invalid = await request(path, {
      headers: { "x-listener-access-token": "invalid-token" },
    });
    expect(invalid.status).toBe(403);

    const approved = await request(path, {
      headers: { "x-listener-access-token": access.accessToken },
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({
      sessionId: graph.publisherSessionId,
      trackName: graph.publisherTrackName,
    });

    const repo = new ListenerAccessRepository(testEnv.DB);
    await repo.revokeForClient(graph.programId, access.clientId);
    const revoked = await request(path, {
      headers: { "x-listener-access-token": access.accessToken },
    });
    expect(revoked.status).toBe(403);

    const offlineGraph = await seedProgramGraph({ accessControlEnabled: true });
    const precedence = await request(
      `/api/listeners/active-publisher?programSlug=${offlineGraph.programSlug}&streamId=${offlineGraph.hindiStreamId}`,
    );
    expect(precedence.status).toBe(403);
    expect(await precedence.json()).toEqual({ error: "listener_not_approved" });
  });

  it("gates all four secondary acquisition paths before stream or connection work", async () => {
    const graph = await seedProgramGraph({ accessControlEnabled: true });
    const cases = [
      ["/api/listeners/request", createInput(graph, "client_request")],
      [
        "/api/listeners/subscribe/session",
        {
          ...createInput(graph, "client_subscribe"),
          sessionDescription: { type: "offer", sdp: "offer-sdp" },
        },
      ],
      [
        "/api/listeners/switch",
        {
          ...createInput(graph, "client_switch"),
          fromConnectionId: "missing-connection",
        },
      ],
      [
        "/api/listeners/reconnect",
        {
          ...createInput(graph, "client_reconnect"),
          reconnectOfConnectionId: "missing-connection",
        },
      ],
    ] as const;

    for (const [path, body] of cases) {
      const response = await request(path, {
        method: "POST",
        body: JSON.stringify({ ...body, streamId: "missing-stream" }),
      });
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toEqual({
        error: "listener_not_approved",
      });
    }
  });

  it("allows all four secondary acquisition paths with a minted token", async () => {
    const graph = await seedProgramGraph({
      accessControlEnabled: true,
      published: true,
    });
    const access = await mintAccess(graph, "client_secondary");

    const firstRequest = await request("/api/listeners/request", {
      method: "POST",
      body: JSON.stringify(
        createInput(graph, "client_first", access.accessToken),
      ),
    });
    expect(firstRequest.status).toBe(201);
    const first = await firstRequest.json<{ connectionId: string }>();

    const secondRequest = await request("/api/listeners/request", {
      method: "POST",
      body: JSON.stringify(
        createInput(graph, "client_second", access.accessToken),
      ),
    });
    expect(secondRequest.status).toBe(201);
    const second = await secondRequest.json<{ connectionId: string }>();

    const subscribe = await request(
      "/api/listeners/subscribe/session",
      {
        method: "POST",
        body: JSON.stringify({
          ...createInput(graph, "client_subscribe", access.accessToken),
          sessionDescription: { type: "offer", sdp: "offer-sdp" },
        }),
      },
      realtimeEnv(),
    );
    expect(subscribe.status).toBe(201);

    const switched = await request("/api/listeners/switch", {
      method: "POST",
      body: JSON.stringify({
        programSlug: graph.programSlug,
        streamId: graph.englishStreamId,
        clientId: "client_first",
        fromConnectionId: first.connectionId,
        accessToken: access.accessToken,
      }),
    });
    expect(switched.status).toBe(201);

    const reconnected = await request("/api/listeners/reconnect", {
      method: "POST",
      body: JSON.stringify({
        ...createInput(graph, "client_second", access.accessToken),
        reconnectOfConnectionId: second.connectionId,
      }),
    });
    expect(reconnected.status).toBe(201);
  });

  it("completes approve, admin revoke, grandfather, re-claim, and re-approve lifecycle", async () => {
    const graph = await seedProgramGraph({
      accessControlEnabled: true,
      published: true,
    });
    await seedPlatformAdmin(testEnv);
    const cookie = await adminCookie();
    const clientId = "client_full_lifecycle";
    const access = await mintAccess(graph, clientId);
    const activePublisherPath =
      `/api/listeners/active-publisher?programSlug=${graph.programSlug}` +
      `&streamId=${graph.hindiStreamId}`;

    const activeBeforeRevoke = await request(activePublisherPath, {
      headers: { "x-listener-access-token": access.accessToken },
    });
    expect(activeBeforeRevoke.status).toBe(200);

    const subscribe = await request(
      "/api/listeners/subscribe/session",
      {
        method: "POST",
        body: JSON.stringify({
          ...createInput(graph, clientId, access.accessToken),
          sessionDescription: { type: "offer", sdp: "offer-sdp" },
        }),
      },
      realtimeEnv(),
    );
    expect(subscribe.status).toBe(201);
    const { connectionId } = await subscribe.json<{ connectionId: string }>();
    const connected = await request("/api/listeners/connected", {
      method: "POST",
      body: JSON.stringify({ connectionId }),
    });
    expect(connected.status).toBe(200);

    const revoke = await request(
      `/api/admin/programs/${graph.programId}/listener-access/revoke`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ clientId }),
      },
    );
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toEqual({ revoked: 1 });

    const activeAfterRevoke = await request(activePublisherPath, {
      headers: { "x-listener-access-token": access.accessToken },
    });
    expect(activeAfterRevoke.status).toBe(403);
    const subscribeAfterRevoke = await request(
      "/api/listeners/subscribe/session",
      {
        method: "POST",
        body: JSON.stringify({
          ...createInput(graph, clientId, access.accessToken),
          sessionDescription: { type: "offer", sdp: "offer-sdp" },
        }),
      },
      realtimeEnv(),
    );
    expect(subscribeAfterRevoke.status).toBe(403);

    const heartbeat = await request("/api/listeners/heartbeat", {
      method: "POST",
      body: JSON.stringify({ connectionId }),
    });
    expect(heartbeat.status).toBe(200);

    const claimResponse = await request("/api/listeners/access/claim", {
      method: "POST",
      body: JSON.stringify({ programSlug: graph.programSlug, clientId }),
    });
    expect(claimResponse.status).toBe(201);
    const claim = await claimResponse.json<{
      claimId: string;
      claimSecret: string;
    }>();
    const pendingRows = await testEnv.DB.prepare(
      `SELECT COUNT(*) as count FROM listener_access
      WHERE program_id = ? AND client_id = ? AND status = 'pending'`,
    )
      .bind(graph.programId, clientId)
      .first<{ count: number }>();
    expect(pendingRows?.count).toBe(1);

    const reportResponse = await request(
      `/api/admin/programs/${graph.programId}/listener-report`,
      { headers: { Cookie: cookie } },
    );
    expect(reportResponse.status).toBe(200);
    const report = await reportResponse.json<{
      connections: Array<{
        clientId: string;
        approvalStatus: string | null;
        hasRevokedHistory: boolean;
      }>;
    }>();
    expect(report.connections.find((row) => row.clientId === clientId))
      .toMatchObject({
        approvalStatus: "revoked",
        hasRevokedHistory: true,
      });

    const repo = new ListenerAccessRepository(testEnv.DB);
    await expect(
      repo.approveClaim(graph.programId, { claimId: claim.claimId }, "scan"),
    ).resolves.toEqual({ status: "approved", already: false });
    const statusResponse = await request("/api/listeners/access/status", {
      method: "POST",
      body: JSON.stringify({
        programSlug: graph.programSlug,
        claimId: claim.claimId,
        claimSecret: claim.claimSecret,
      }),
    });
    expect(statusResponse.status).toBe(200);
    const reminted = await statusResponse.json<{ accessToken: string }>();
    const activeAfterReapprove = await request(activePublisherPath, {
      headers: { "x-listener-access-token": reminted.accessToken },
    });
    expect(activeAfterReapprove.status).toBe(200);
  });

  it("grandfathers heartbeat but blocks the next reconnect after OFF to ON", async () => {
    const graph = await seedProgramGraph({ published: true });
    const initial = await request("/api/listeners/request", {
      method: "POST",
      body: JSON.stringify(createInput(graph, "client_toggle_reconnect")),
    });
    expect(initial.status).toBe(201);
    const { connectionId } = await initial.json<{ connectionId: string }>();
    const connected = await request("/api/listeners/connected", {
      method: "POST",
      body: JSON.stringify({ connectionId }),
    });
    expect(connected.status).toBe(200);

    await setAccessControl(graph.programId, true);

    const heartbeat = await request("/api/listeners/heartbeat", {
      method: "POST",
      body: JSON.stringify({ connectionId }),
    });
    expect(heartbeat.status).toBe(200);

    const reconnect = await request("/api/listeners/reconnect", {
      method: "POST",
      body: JSON.stringify({
        ...createInput(graph, "client_toggle_reconnect"),
        reconnectOfConnectionId: connectionId,
      }),
    });
    expect(reconnect.status).toBe(403);
    expect(await reconnect.json()).toEqual({ error: "listener_not_approved" });
  });

  it("honors approval minted while OFF after access control turns ON", async () => {
    const graph = await seedProgramGraph({ published: true });
    const access = await mintAccess(graph, "client_prior_approval");

    await setAccessControl(graph.programId, true);

    const response = await request(
      `/api/listeners/active-publisher?programSlug=${graph.programSlug}` +
        `&streamId=${graph.hindiStreamId}`,
      { headers: { "x-listener-access-token": access.accessToken } },
    );
    expect(response.status).toBe(200);
  });

  it("adds no listener-access reads and preserves all acquisition paths when disabled", async () => {
    const graph = await seedProgramGraph({ published: true });
    const sql: string[] = [];
    const db = countingDb(testEnv.DB, sql);
    const workerEnv = realtimeEnv({ DB: db });

    const active = await request(
      `/api/listeners/active-publisher?programSlug=${graph.programSlug}&streamId=${graph.hindiStreamId}`,
      {},
      workerEnv,
    );
    expect(active.status).toBe(200);

    const firstRequest = await request(
      "/api/listeners/request",
      {
        method: "POST",
        body: JSON.stringify(createInput(graph, "client_first")),
      },
      workerEnv,
    );
    const first = await firstRequest.json<{ connectionId: string }>();
    expect(firstRequest.status).toBe(201);

    const secondRequest = await request(
      "/api/listeners/request",
      {
        method: "POST",
        body: JSON.stringify(createInput(graph, "client_second")),
      },
      workerEnv,
    );
    const second = await secondRequest.json<{ connectionId: string }>();
    expect(secondRequest.status).toBe(201);

    const subscribe = await request(
      "/api/listeners/subscribe/session",
      {
        method: "POST",
        body: JSON.stringify({
          ...createInput(graph, "client_subscribe"),
          sessionDescription: { type: "offer", sdp: "offer-sdp" },
        }),
      },
      workerEnv,
    );
    expect(subscribe.status).toBe(201);

    const switched = await request(
      "/api/listeners/switch",
      {
        method: "POST",
        body: JSON.stringify({
          programSlug: graph.programSlug,
          streamId: graph.englishStreamId,
          clientId: "client_first",
          fromConnectionId: first.connectionId,
        }),
      },
      workerEnv,
    );
    expect(switched.status).toBe(201);

    const reconnected = await request(
      "/api/listeners/reconnect",
      {
        method: "POST",
        body: JSON.stringify({
          ...createInput(graph, "client_second"),
          reconnectOfConnectionId: second.connectionId,
        }),
      },
      workerEnv,
    );
    expect(reconnected.status).toBe(201);
    expect(
      sql.filter((statement) => targetsTable(statement, "listener_access")),
    ).toEqual([]);
  });

  it("never gates grandfathered lifecycle, track, or renegotiate calls", async () => {
    const graph = await seedProgramGraph({ published: true });
    if (!graph.publisherSessionId || !graph.publisherTrackName) {
      throw new Error("published realtime fixture is incomplete");
    }
    const session = await request(
      "/api/listeners/subscribe/session",
      {
        method: "POST",
        body: JSON.stringify({
          ...createInput(graph, "client_grandfathered"),
          sessionDescription: { type: "offer", sdp: "offer-sdp" },
        }),
      },
      realtimeEnv(),
    );
    expect(session.status).toBe(201);
    const { connectionId } = await session.json<{ connectionId: string }>();
    await setAccessControl(graph.programId, true);

    const sql: string[] = [];
    const realtimeResponses: unknown[] = [
      {
        tracks: [
          {
            mid: "0",
            sessionId: graph.publisherSessionId,
            trackName: graph.publisherTrackName,
          },
        ],
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: "offer", sdp: "remote-offer" },
      },
      { ok: true },
      { ok: true },
    ];
    const realtimeFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json(realtimeResponses.shift() ?? { ok: true }),
    ) as unknown as typeof fetch;
    const workerEnv = buildTestEnv({
      DB: countingDb(testEnv.DB, sql),
      REALTIME_FETCH: realtimeFetch,
    });

    const track = await request(
      "/api/listeners/subscribe/track",
      {
        method: "POST",
        body: JSON.stringify({ connectionId }),
      },
      workerEnv,
    );
    expect(track.status).toBe(200);
    expect(await track.json()).toMatchObject({
      connectionId,
      track: { mid: "0" },
      requiresImmediateRenegotiation: true,
    });

    const renegotiate = await request(
      "/api/listeners/subscribe/renegotiate",
      {
        method: "POST",
        body: JSON.stringify({
          connectionId,
          sessionDescription: { type: "answer", sdp: "answer-sdp" },
        }),
      },
      workerEnv,
    );
    expect(renegotiate.status).toBe(200);
    expect(await renegotiate.json()).toEqual({ ok: true });

    const connected = await request(
      "/api/listeners/connected",
      {
        method: "POST",
        body: JSON.stringify({ connectionId }),
      },
      workerEnv,
    );
    expect(connected.status).toBe(200);

    const heartbeat = await request(
      "/api/listeners/heartbeat",
      {
        method: "POST",
        body: JSON.stringify({ connectionId }),
      },
      workerEnv,
    );
    expect(heartbeat.status).toBe(200);

    const leave = await request(
      "/api/listeners/leave",
      {
        method: "POST",
        body: JSON.stringify({
          connectionId,
          reason: "client_disconnect",
        }),
      },
      workerEnv,
    );
    expect(leave.status).toBe(200);
    expect(realtimeFetch).toHaveBeenCalledTimes(3);
    expect(
      sql.filter((statement) => targetsTable(statement, "listener_access")),
    ).toEqual([]);
  });

  it("rejects before write-behind enqueues", async () => {
    const graph = await seedProgramGraph({ accessControlEnabled: true });
    const send = vi.fn<Queue<ConnectionEvent>["send"]>();
    const workerEnv = buildTestEnv({
      LISTENER_WRITE_BEHIND: "true",
      CONNECTION_EVENTS: { send } as unknown as Queue<ConnectionEvent>,
    });

    const requested = await request(
      "/api/listeners/request",
      {
        method: "POST",
        body: JSON.stringify(createInput(graph, "client_queue")),
      },
      workerEnv,
    );
    expect(requested.status).toBe(403);

    const switched = await request(
      "/api/listeners/switch",
      {
        method: "POST",
        body: JSON.stringify({
          ...createInput(graph, "client_queue"),
          fromConnectionId: "missing-connection",
        }),
      },
      workerEnv,
    );
    expect(switched.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
});
