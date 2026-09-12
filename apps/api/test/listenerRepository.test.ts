import { beforeEach, describe, expect, it } from "vitest";

import {
  ListenerProgramNotFoundError,
  ListenerRepository,
  MAX_CSV_ROWS,
  type ListenerReportFilters,
  type ListenerReportConnection,
  type ListenerSubscriptionStatus
} from "../src/db/listenerRepository";
import { deviceLabelFromUserAgent } from "../src/domain/deviceLabel";
import { deviceModelNameFromCode } from "../src/domain/deviceModelName";
import { testEnv } from "./test-env";

interface SeededProgram {
  programId: string;
  streams: [string, string];
}

interface SeededReportRow {
  id: string;
  createdAt: string;
  streamId: string;
  subscriptionStatus: ListenerSubscriptionStatus;
  deviceLabel: string | null;
  userAgent: string;
}

async function resetDb(): Promise<void> {
  await testEnv.DB.exec("DELETE FROM listener_access");
  await testEnv.DB.exec("DELETE FROM listener_realtime_cleanup_targets");
  await testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
  await testEnv.DB.exec("DELETE FROM translator_sessions");
  await testEnv.DB.exec("DELETE FROM stream_events");
  await testEnv.DB.exec("DELETE FROM listener_connections");
  await testEnv.DB.exec("DELETE FROM admin_sessions");
  await testEnv.DB.exec("DELETE FROM translator_stream_assignments");
  await testEnv.DB.exec("DELETE FROM translators");
  await testEnv.DB.exec("DELETE FROM language_streams");
  await testEnv.DB.exec("DELETE FROM programs");
}

async function seedProgram(
  status: "draft" | "live" | "archived" = "live"
): Promise<SeededProgram> {
  const suffix = crypto.randomUUID();
  const programId = `program_report_repo_${suffix}`;
  const slug = `report-repo-${suffix}`;
  const now = new Date().toISOString();
  const [streamA, streamB] = [`stream_a_${suffix}`, `stream_b_${suffix}`];

  await testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      programId,
      slug,
      "Report repository test program",
      "Main Hall",
      "2026-08-01",
      status,
      "",
      now,
      now
    )
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO language_streams
    (id, program_id, language_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`
  )
    .bind(
      streamA,
      programId,
      "Hindi",
      "hi",
      1,
      1,
      now,
      now
    )
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO language_streams
    (id, program_id, language_name, language_code, display_order, is_active,
     is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`
  )
    .bind(
      streamB,
      programId,
      "Tamil",
      "ta",
      2,
      1,
      now,
      now
    )
    .run();

  return { programId, streams: [streamA, streamB] };
}

async function insertConnection(input: {
  id: string;
  programId: string;
  streamId: string;
  clientId?: string | null;
  subscriptionStatus: ListenerSubscriptionStatus;
  userAgent: string;
  deviceLabel?: string | null;
  deviceModel?: string | null;
  platform?: string | null;
  platformVersion?: string | null;
  browserFullVersion?: string | null;
  createdAt: string;
  connectedAt?: string | null;
  lastSeenAt?: string | null;
  disconnectedAt?: string | null;
  disconnectReason?: string | null;
  listenerIp?: string;
}): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO listener_connections
    (id, program_id, language_stream_id, client_id, token_issued_at,
     subscription_status, connected_at, last_seen_at, disconnected_at, disconnect_reason,
     switch_from_connection_id, reconnect_of_connection_id, listener_ip,
     user_agent, device_label, client_device_model, client_platform,
     client_platform_version, client_browser_full_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.id,
      input.programId,
      input.streamId,
      input.clientId ?? `client_${input.id}`,
      input.createdAt,
      input.subscriptionStatus,
      input.connectedAt ?? null,
      input.lastSeenAt ?? null,
      input.disconnectedAt ?? null,
      input.disconnectReason ?? null,
      null,
      null,
      input.listenerIp ?? "203.0.113.10",
      input.userAgent,
      input.deviceLabel ?? null,
      input.deviceModel ?? null,
      input.platform ?? null,
      input.platformVersion ?? null,
      input.browserFullVersion ?? null,
      input.createdAt,
      input.createdAt
    )
    .run();
}

async function insertListenerAccess(input: {
  id: string;
  programId: string;
  clientId: string;
  status: "pending" | "approved" | "revoked" | "superseded";
  createdAt: string;
  shortCode?: string;
  claimSecretHash?: string;
  accessTokenHash?: string | null;
  approvedAt?: string | null;
  approvedVia?: "scan" | "code" | null;
  revokedAt?: string | null;
  supersededAt?: string | null;
}): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO listener_access
    (id, program_id, client_id, short_code, claim_secret_hash, status,
     access_token_hash, created_at, approved_at, approved_via, revoked_at, superseded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.id,
      input.programId,
      input.clientId,
      input.shortCode ?? crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase(),
      input.claimSecretHash ?? `hash_${input.id}`,
      input.status,
      input.accessTokenHash ?? null,
      input.createdAt,
      input.approvedAt ?? null,
      input.approvedVia ?? null,
      input.revokedAt ?? null,
      input.supersededAt ?? null
    )
    .run();
}

async function insertEvent(input: {
  id: string;
  programId: string;
  streamId: string | null;
  eventType: string;
  occurredAt: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO stream_events
    (id, program_id, stream_program_id, language_stream_id, event_type,
     occurred_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.id,
      input.programId,
      input.streamId ? input.programId : null,
      input.streamId,
      input.eventType,
      input.occurredAt,
      JSON.stringify(input.metadata ?? {})
    )
    .run();
}

async function subscribedEventCount(connectionId: string): Promise<number> {
  const { results } = await testEnv.DB.prepare(
    `SELECT id FROM stream_events
    WHERE event_type = 'listener_subscribed'
      AND json_extract(metadata_json, '$.connectionId') = ?`
  )
    .bind(connectionId)
    .all<{ id: string }>();
  return results.length;
}

function reportConnectionRow(
  id: string
): Omit<ListenerReportConnection, "deviceLabel"> & { deviceLabel: string | null } {
  return {
    id,
    programId: "program_csv",
    streamId: "stream_csv",
    clientId: `client_${id}`,
    subscriptionStatus: "connected",
    connectedAt: "2026-06-24T00:00:00.000Z",
    disconnectedAt: null,
    disconnectReason: null,
    listenerIp: "203.0.113.10",
    userAgent: "Test UA",
    lastSeenAt: "2026-06-24T00:00:00.000Z",
    deviceLabel: "Desktop",
    deviceModel: null,
    deviceModelName: null,
    platform: null,
    platformVersion: null,
    browserFullVersion: null,
    approvalStatus: null,
    approvedAt: null,
    approvedVia: null,
    hasRevokedHistory: false
  };
}

function stubCsvDb(
  results: Array<Omit<ListenerReportConnection, "deviceLabel"> & { deviceLabel: string | null }>
): { db: D1Database; boundValues: unknown[] } {
  const boundValues: unknown[] = [];
  const db = {
    prepare() {
      return {
        bind(...values: unknown[]) {
          boundValues.push(...values);
          return {
            async all() {
              return { results };
            }
          };
        }
      };
    }
  } as unknown as D1Database;

  return { db, boundValues };
}

function capturePreparedSql(
  db: D1Database,
  onPrepare: (sql: string) => void
): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          onPrepare(sql);
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function seedConnections(
  program: SeededProgram
): Promise<SeededReportRow[]> {
  const rows: SeededReportRow[] = [];
  const safariUa =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const androidUa =
    "Mozilla/5.0 (Linux; Android 13; Pixel 6 Build/TP1A.220905.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
  const safariLabel = deviceLabelFromUserAgent(safariUa);
  const androidLabel = deviceLabelFromUserAgent(androidUa);
  const fallbackLabel = deviceLabelFromUserAgent(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
  );
  const states: ListenerSubscriptionStatus[] = [
    "connected",
    "disconnected",
    "failed",
    "requested"
  ];
  const base = Date.parse("2026-06-24T00:00:00.000Z");

  for (let index = 0; index < 150; index += 1) {
    const createdAt = new Date(base + index * 1000).toISOString();
    const streamId = index % 2 === 0 ? program.streams[0] : program.streams[1];
    const status = states[index % states.length]!;
    const deviceLabel = index === 149 ? null : index % 2 === 0 ? safariLabel : androidLabel;
    const userAgent = index % 2 === 0 ? safariUa : androidUa;
    const rowId = `listener_connection_${index}_${program.programId}`;

    await insertConnection({
      id: rowId,
      programId: program.programId,
      streamId,
      subscriptionStatus: status,
      userAgent,
      deviceLabel,
      createdAt,
      connectedAt: createdAt
    });

    rows.push({
      id: rowId,
      createdAt,
      streamId,
      subscriptionStatus: status,
      deviceLabel: index === 149 ? fallbackLabel : deviceLabel,
      userAgent
    });
  }
  return rows;
}

describe("ListenerRepository pagination/filtering/report helpers", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("markConnected does not write listener_subscribed rows", async () => {
    const repo = new ListenerRepository(testEnv.DB);
    const program = await seedProgram();

    const connection = await repo.createRequestedConnection({
      programId: program.programId,
      streamId: program.streams[0],
      clientId: "listener_subscribed_client",
      listenerIp: "203.0.113.200",
      userAgent: "Listener Repo Test Browser"
    });
    const result = await repo.markConnected(connection.id);

    expect(result).toMatchObject({
      changed: true,
      connection: expect.objectContaining({
        id: connection.id,
        subscriptionStatus: "connected"
      })
    });
    expect(await subscribedEventCount(connection.id)).toBe(0);
  });

  it("paginates report connections newest-first and clamps out-of-range pages", async () => {
    const repo = new ListenerRepository(testEnv.DB);
    const program = await seedProgram();
    const rows = await seedConnections(program);
    const expectedPage1Ids = [...rows]
      .slice(50, 150)
      .map((row) => row.id)
      .reverse();
    const expectedPage2Ids = [...rows]
      .slice(0, 50)
      .map((row) => row.id)
      .reverse();

    const page1 = await repo.listProgramConnectionsPage(program.programId, {}, 1);
    expect(page1.total).toBe(150);
    expect(page1.totalPages).toBe(2);
    expect(page1.page).toBe(1);
    expect(page1.pageSize).toBe(100);
    expect(page1.connections).toHaveLength(100);
    expect(page1.connections.map((connection) => connection.id)).toEqual(expectedPage1Ids);

    const page2 = await repo.listProgramConnectionsPage(program.programId, {}, 2);
    expect(page2.page).toBe(2);
    expect(page2.connections).toHaveLength(50);
    expect(page2.connections.map((connection) => connection.id)).toEqual(expectedPage2Ids);

    const clamped = await repo.listProgramConnectionsPage(program.programId, {}, 99);
    expect(clamped.page).toBe(2);
    expect(clamped.connections).toHaveLength(50);
    expect(clamped.connections.map((connection) => connection.id)).toEqual(expectedPage2Ids);
  });

  it("filters report pagination by state, stream, device label, and createdAt range", async () => {
    const repo = new ListenerRepository(testEnv.DB);
    const program = await seedProgram();
    const rows = await seedConnections(program);
    const safariUa =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    const safariLabel = deviceLabelFromUserAgent(safariUa);

    const connected = rows.filter((row) => row.subscriptionStatus === "connected");
    const connectedPage = await repo.listProgramConnectionsPage(
      program.programId,
      { states: ["connected"] },
      1
    );
    expect(connectedPage.total).toBe(connected.length);
    expect(connectedPage.connections.every((connection) => connection.subscriptionStatus === "connected"))
      .toBe(true);

    const streamPage = await repo.listProgramConnectionsPage(
      program.programId,
      { streamId: program.streams[0] },
      1
    );
    expect(streamPage.total).toBe(75);

    const safariPage = await repo.listProgramConnectionsPage(
      program.programId,
      { deviceLabel: safariLabel },
      1
    );
    expect(safariPage.total).toBe(75);
    expect(safariPage.connections.every((connection) => connection.deviceLabel === safariLabel))
      .toBe(true);

    const createdFrom = rows[50]!.createdAt;
    const createdTo = rows[100]!.createdAt;
    const createdRange = await repo.listProgramConnectionsPage(
      program.programId,
      { createdFrom, createdTo },
      1
    );
    expect(createdRange.total).toBe(50);
    expect(createdRange.connections.map((connection) => connection.id)).toEqual(
      [...rows]
        .slice(50, 100)
        .map((row) => row.id)
        .reverse()
    );
    expect(createdRange.connections.some((connection) => connection.id === rows[100]!.id)).toBe(
      false
    );
    expect(createdRange.connections.some((connection) => connection.id === rows[50]!.id)).toBe(
      true
    );
  });

  it("returns the same count from list and count methods", async () => {
    const repo = new ListenerRepository(testEnv.DB);
    const program = await seedProgram();
    await seedConnections(program);

    const filters: ListenerReportFilters = {
      states: ["connected", "disconnected"]
    };
    const page = await repo.listProgramConnectionsPage(program.programId, filters, 1);
    const count = await repo.countProgramConnections(program.programId, filters);
    expect(count).toBe(page.total);
  });

  it("does not join listener access when counting without approval filters", async () => {
    const program = await seedProgram();
    const preparedSql: string[] = [];
    const repo = new ListenerRepository(
      capturePreparedSql(testEnv.DB, (sql) => preparedSql.push(sql))
    );

    await repo.countProgramConnections(program.programId, {
      states: ["connected"]
    });

    const countSql = preparedSql.find((sql) => sql.includes("SELECT COUNT(*)"));
    expect(countSql).toBeDefined();
    expect(countSql).not.toContain("listener_access");
    expect(countSql).not.toContain("report_access");
  });

  it("constrains the listener access report plan by program", async () => {
    const program = await seedProgram();
    let reportSql: string | null = null;
    const repo = new ListenerRepository(
      capturePreparedSql(testEnv.DB, (sql) => {
        if (sql.includes("ROW_NUMBER() OVER") && sql.includes("listener_connections")) {
          reportSql = sql;
        }
      })
    );

    await repo.listProgramConnectionsForCsv(program.programId, {});
    if (!reportSql) {
      throw new Error("expected listener report SQL to be prepared");
    }

    const { results } = await testEnv.DB.prepare(
      `EXPLAIN QUERY PLAN ${reportSql}`
    )
      .bind(program.programId, program.programId, MAX_CSV_ROWS + 1)
      .all<{ detail: string }>();
    const plan = results.map((row) => row.detail).join("\n");

    expect(plan).toContain(
      "SEARCH la USING INDEX idx_listener_access_client (program_id=?)"
    );
    expect(plan).not.toMatch(/\bSCAN la\b/);
  });

  it("returns all filtered rows for CSV mode without pagination", async () => {
    const repo = new ListenerRepository(testEnv.DB);
    const program = await seedProgram();
    await seedConnections(program);

    const filters: ListenerReportFilters = { streamId: program.streams[1] };
    const page = await repo.listProgramConnectionsPage(program.programId, filters, 1);
    const count = await repo.countProgramConnections(program.programId, filters);
    const csvResult = await repo.listProgramConnectionsForCsv(
      program.programId,
      filters
    );

    expect(page.total).toBe(count);
    expect(csvResult.connections).toHaveLength(count);
    expect(csvResult.truncated).toBe(false);
  });

  it("includes client hint device fields in report page and CSV rows", async () => {
    const repo = new ListenerRepository(testEnv.DB);
    const program = await seedProgram();
    const createdAt = "2026-06-24T10:00:00.000Z";

    await insertConnection({
      id: "connection_client_hints",
      programId: program.programId,
      streamId: program.streams[0],
      subscriptionStatus: "connected",
      userAgent: "Chrome Android",
      deviceModel: "M2101K7BI",
      platform: "Android",
      platformVersion: "15.0.0",
      browserFullVersion:
        '"Chromium";v="125.0.6422.141", "Google Chrome";v="125.0.6422.141"',
      createdAt,
      connectedAt: createdAt,
      lastSeenAt: createdAt
    });

    const page = await repo.listProgramConnectionsPage(program.programId, {}, 1);
    expect(page.connections[0]).toMatchObject({
      id: "connection_client_hints",
      deviceModel: "M2101K7BI",
      deviceModelName: deviceModelNameFromCode("M2101K7BI"),
      platform: "Android",
      platformVersion: "15.0.0",
      browserFullVersion:
        '"Chromium";v="125.0.6422.141", "Google Chrome";v="125.0.6422.141"'
    });

    const csvResult = await repo.listProgramConnectionsForCsv(
      program.programId,
      {}
    );
    expect(csvResult.connections[0]).toMatchObject({
      id: "connection_client_hints",
      deviceModel: "M2101K7BI",
      deviceModelName: deviceModelNameFromCode("M2101K7BI"),
      platform: "Android",
      platformVersion: "15.0.0",
      browserFullVersion:
        '"Chromium";v="125.0.6422.141", "Google Chrome";v="125.0.6422.141"'
    });
  });

  it("joins the ranked listener access row and filters by approval status", async () => {
    const repo = new ListenerRepository(testEnv.DB);
    const program = await seedProgram();

    await insertConnection({
      id: "connection_approved",
      programId: program.programId,
      streamId: program.streams[0],
      clientId: "client_approved",
      subscriptionStatus: "connected",
      userAgent: "Chrome Android",
      createdAt: "2026-06-24T10:00:00.000Z",
      connectedAt: "2026-06-24T10:00:00.000Z",
      lastSeenAt: "2026-06-24T10:01:00.000Z"
    });
    await insertConnection({
      id: "connection_revoked",
      programId: program.programId,
      streamId: program.streams[0],
      clientId: "client_revoked",
      subscriptionStatus: "disconnected",
      userAgent: "Chrome Android",
      createdAt: "2026-06-24T09:00:00.000Z",
      connectedAt: "2026-06-24T09:00:00.000Z",
      disconnectedAt: "2026-06-24T09:05:00.000Z"
    });
    await insertConnection({
      id: "connection_pending",
      programId: program.programId,
      streamId: program.streams[1],
      clientId: "client_pending",
      subscriptionStatus: "requested",
      userAgent: "Safari iPhone",
      createdAt: "2026-06-24T08:00:00.000Z",
      lastSeenAt: "2026-06-24T08:01:00.000Z"
    });
    await insertConnection({
      id: "connection_tie",
      programId: program.programId,
      streamId: program.streams[1],
      clientId: "client_tie",
      subscriptionStatus: "connected",
      userAgent: "Chrome Desktop",
      createdAt: "2026-06-24T07:00:00.000Z",
      connectedAt: "2026-06-24T07:00:00.000Z",
      lastSeenAt: "2026-06-24T07:01:00.000Z"
    });

    await insertListenerAccess({
      id: "listener_access_approved",
      programId: program.programId,
      clientId: "client_approved",
      status: "approved",
      accessTokenHash: "token_hash_approved",
      createdAt: "2026-06-24T09:30:00.000Z",
      approvedAt: "2026-06-24T09:31:00.000Z",
      approvedVia: "scan"
    });
    await insertListenerAccess({
      id: "listener_access_pending_after_approved",
      programId: program.programId,
      clientId: "client_approved",
      status: "pending",
      createdAt: "2026-06-24T09:35:00.000Z"
    });
    await insertListenerAccess({
      id: "listener_access_revoked",
      programId: program.programId,
      clientId: "client_revoked",
      status: "revoked",
      createdAt: "2026-06-24T09:10:00.000Z",
      revokedAt: "2026-06-24T09:11:00.000Z"
    });
    await insertListenerAccess({
      id: "listener_access_pending_after_revoke",
      programId: program.programId,
      clientId: "client_revoked",
      status: "pending",
      createdAt: "2026-06-24T09:15:00.000Z"
    });
    await insertListenerAccess({
      id: "listener_access_approved_without_token",
      programId: program.programId,
      clientId: "client_pending",
      status: "approved",
      createdAt: "2026-06-24T07:50:00.000Z",
      approvedAt: "2026-06-24T07:51:00.000Z",
      approvedVia: "code"
    });
    await insertListenerAccess({
      id: "listener_access_pending",
      programId: program.programId,
      clientId: "client_pending",
      status: "pending",
      createdAt: "2026-06-24T07:55:00.000Z"
    });
    await insertListenerAccess({
      id: "listener_access_tie_a",
      programId: program.programId,
      clientId: "client_tie",
      status: "approved",
      accessTokenHash: "token_hash_tie_a",
      createdAt: "2026-06-24T06:50:00.000Z",
      approvedAt: "2026-06-24T06:51:00.000Z",
      approvedVia: "scan"
    });
    await insertListenerAccess({
      id: "listener_access_tie_z",
      programId: program.programId,
      clientId: "client_tie",
      status: "approved",
      accessTokenHash: "token_hash_tie_z",
      createdAt: "2026-06-24T06:50:00.000Z",
      approvedAt: "2026-06-24T06:52:00.000Z",
      approvedVia: "code"
    });

    const page = await repo.listProgramConnectionsPage(program.programId, {}, 1);
    const byClient = new Map(
      page.connections.map((connection) => [connection.clientId, connection])
    );

    expect(byClient.get("client_approved")).toMatchObject({
      approvalStatus: "approved",
      approvedAt: "2026-06-24T09:31:00.000Z",
      approvedVia: "scan",
      hasRevokedHistory: false
    });
    expect(byClient.get("client_revoked")).toMatchObject({
      approvalStatus: "revoked",
      approvedAt: null,
      approvedVia: null,
      hasRevokedHistory: true
    });
    expect(byClient.get("client_pending")).toMatchObject({
      approvalStatus: "pending",
      approvedAt: null,
      approvedVia: null,
      hasRevokedHistory: false
    });
    expect(byClient.get("client_tie")).toMatchObject({
      approvalStatus: "approved",
      approvedAt: "2026-06-24T06:52:00.000Z",
      approvedVia: "code",
      hasRevokedHistory: false
    });

    const revokedFiltered = await repo.listProgramConnectionsPage(
      program.programId,
      { approvalStatuses: ["revoked"] },
      1
    );
    expect(revokedFiltered.total).toBe(1);
    expect(revokedFiltered.connections[0]).toMatchObject({
      clientId: "client_revoked",
      approvalStatus: "revoked",
      hasRevokedHistory: true
    });

    const filtered = await repo.listProgramConnectionsPage(
      program.programId,
      { approvalStatuses: ["revoked", "pending"] },
      1
    );
    expect(filtered.total).toBe(2);
    expect(filtered.connections.map((connection) => connection.clientId)).toEqual([
      "client_revoked",
      "client_pending"
    ]);

    const csvResult = await repo.listProgramConnectionsForCsv(program.programId, {
      approvalStatuses: ["approved"]
    });
    expect(csvResult.truncated).toBe(false);
    expect(csvResult.connections).toHaveLength(2);
    expect(
      csvResult.connections.find(
        (connection) => connection.clientId === "client_approved"
      )
    ).toMatchObject({
      clientId: "client_approved",
      approvalStatus: "approved",
      approvedAt: "2026-06-24T09:31:00.000Z",
      approvedVia: "scan",
      hasRevokedHistory: false
    });

    const revokedCsvResult = await repo.listProgramConnectionsForCsv(
      program.programId,
      { approvalStatuses: ["revoked"] }
    );
    expect(revokedCsvResult.connections).toHaveLength(1);
    expect(revokedCsvResult.connections[0]).toMatchObject({
      clientId: "client_revoked",
      approvalStatus: "revoked",
      hasRevokedHistory: true
    });
  });

  it("caps CSV exports at the configured row limit and reports truncation", async () => {
    const rows = Array.from({ length: MAX_CSV_ROWS + 1 }, (_, index) =>
      reportConnectionRow(`connection_${index}`)
    );
    const { db, boundValues } = stubCsvDb(rows);
    const repo = new ListenerRepository(db);

    const result = await repo.listProgramConnectionsForCsv("program_csv", {});

    expect(boundValues.at(-1)).toBe(MAX_CSV_ROWS + 1);
    expect(result.connections).toHaveLength(MAX_CSV_ROWS);
    expect(result.connections.at(-1)?.id).toBe(`connection_${MAX_CSV_ROWS - 1}`);
    expect(result.truncated).toBe(true);
  });

  it("does not mark CSV exports at the row limit as truncated", async () => {
    const rows = [reportConnectionRow("connection_1")];
    const { db, boundValues } = stubCsvDb(rows);
    const repo = new ListenerRepository(db);

    const result = await repo.listProgramConnectionsForCsv("program_csv", {});

    expect(boundValues.at(-1)).toBe(MAX_CSV_ROWS + 1);
    expect(result.connections.map((connection) => connection.id)).toEqual([
      "connection_1"
    ]);
    expect(result.truncated).toBe(false);
  });

  it("derives aggregate totals from grouped connection and event rows", async () => {
    const repo = new ListenerRepository(testEnv.DB);
    const program = await seedProgram();
    const base = Date.parse("2026-06-24T00:00:00.000Z");
    const at = (offset: number) => new Date(base + offset).toISOString();

    await insertConnection({
      id: "lc_hi_1",
      programId: program.programId,
      streamId: program.streams[0],
      subscriptionStatus: "connected",
      userAgent: "Test UA",
      createdAt: at(0),
      connectedAt: at(0)
    });
    await insertConnection({
      id: "lc_hi_2",
      programId: program.programId,
      streamId: program.streams[0],
      subscriptionStatus: "disconnected",
      userAgent: "Test UA",
      createdAt: at(1000),
      connectedAt: at(1000),
      disconnectedAt: at(2000),
      disconnectReason: "network_loss"
    });
    await insertConnection({
      id: "lc_ta_1",
      programId: program.programId,
      streamId: program.streams[1],
      subscriptionStatus: "disconnected",
      userAgent: "Test UA",
      createdAt: at(3000),
      connectedAt: at(3000),
      disconnectedAt: at(4000),
      disconnectReason: "client_disconnect"
    });

    await insertEvent({
      id: "ev_hi_reconnect",
      programId: program.programId,
      streamId: program.streams[0],
      eventType: "listener_reconnected",
      occurredAt: at(5000)
    });
    await insertEvent({
      id: "ev_hi_dropout",
      programId: program.programId,
      streamId: program.streams[0],
      eventType: "listener_left",
      occurredAt: at(6000),
      metadata: { reason: "network_loss" }
    });
    await insertEvent({
      id: "ev_ta_graceful",
      programId: program.programId,
      streamId: program.streams[1],
      eventType: "listener_left",
      occurredAt: at(7000),
      metadata: { reason: "client_disconnect" }
    });
    await insertEvent({
      id: "ev_null_reconnect",
      programId: program.programId,
      streamId: null,
      eventType: "listener_reconnected",
      occurredAt: at(8000)
    });
    await insertEvent({
      id: "ev_null_dropout",
      programId: program.programId,
      streamId: null,
      eventType: "connection_failed",
      occurredAt: at(9000)
    });

    const aggregates = await repo.getProgramReportAggregates(program.programId);
    const streamTotalConnections = aggregates.streams.reduce(
      (sum, stream) => sum + stream.totalConnections,
      0
    );

    expect(aggregates.totals.totalConnections).toBe(streamTotalConnections);
    expect(aggregates.totals).toEqual({
      totalConnections: 3,
      uniqueDevices: 3,
      reconnects: 2,
      dropouts: 2
    });
    expect(aggregates.streams).toEqual([
      {
        streamId: program.streams[0],
        languageName: "Hindi",
        languageCode: "hi",
        totalConnections: 2,
        reconnects: 1,
        dropouts: 1
      },
      {
        streamId: program.streams[1],
        languageName: "Tamil",
        languageCode: "ta",
        totalConnections: 1,
        reconnects: 0,
        dropouts: 0
      }
    ]);
  });

  it("getProgramReportAggregates filters connections + events by from/to range", async () => {
    const repo = new ListenerRepository(testEnv.DB);
    const program = await seedProgram();
    const from = "2026-06-24T10:00:00.000Z";
    const to = "2026-06-25T10:00:00.000Z";

    await insertConnection({
      id: "lc_before_window",
      programId: program.programId,
      streamId: program.streams[0],
      subscriptionStatus: "connected",
      userAgent: "Test UA",
      createdAt: "2026-06-24T09:59:59.000Z",
      connectedAt: "2026-06-24T09:59:59.000Z"
    });
    await insertConnection({
      id: "lc_in_window_hi",
      programId: program.programId,
      streamId: program.streams[0],
      subscriptionStatus: "connected",
      userAgent: "Test UA",
      createdAt: from,
      connectedAt: from
    });
    await insertConnection({
      id: "lc_in_window_ta",
      programId: program.programId,
      streamId: program.streams[1],
      subscriptionStatus: "connected",
      userAgent: "Test UA",
      createdAt: "2026-06-25T09:59:59.000Z",
      connectedAt: "2026-06-25T09:59:59.000Z"
    });
    await insertConnection({
      id: "lc_at_exclusive_to",
      programId: program.programId,
      streamId: program.streams[1],
      subscriptionStatus: "connected",
      userAgent: "Test UA",
      createdAt: to,
      connectedAt: to
    });

    await insertEvent({
      id: "ev_before_reconnect",
      programId: program.programId,
      streamId: program.streams[0],
      eventType: "listener_reconnected",
      occurredAt: "2026-06-24T09:59:59.000Z"
    });
    await insertEvent({
      id: "ev_in_reconnect",
      programId: program.programId,
      streamId: program.streams[0],
      eventType: "listener_reconnected",
      occurredAt: from
    });
    await insertEvent({
      id: "ev_in_dropout",
      programId: program.programId,
      streamId: program.streams[1],
      eventType: "listener_left",
      occurredAt: "2026-06-25T09:59:59.000Z",
      metadata: { reason: "network_loss" }
    });
    await insertEvent({
      id: "ev_at_exclusive_to",
      programId: program.programId,
      streamId: program.streams[1],
      eventType: "connection_failed",
      occurredAt: to
    });

    const ranged = await repo.getProgramReportAggregates(program.programId, {
      from,
      to
    });
    expect(ranged.totals).toEqual({
      totalConnections: 2,
      uniqueDevices: 2,
      reconnects: 1,
      dropouts: 1
    });
    expect(ranged.streams).toEqual([
      {
        streamId: program.streams[0],
        languageName: "Hindi",
        languageCode: "hi",
        totalConnections: 1,
        reconnects: 1,
        dropouts: 0
      },
      {
        streamId: program.streams[1],
        languageName: "Tamil",
        languageCode: "ta",
        totalConnections: 1,
        reconnects: 0,
        dropouts: 1
      }
    ]);

    const unfiltered = await repo.getProgramReportAggregates(program.programId);
    expect(unfiltered.totals).toEqual({
      totalConnections: 4,
      uniqueDevices: 4,
      reconnects: 2,
      dropouts: 2
    });
  });

  it("getProgramReportAggregates returns uniqueDevices as distinct client_id", async () => {
    const repo = new ListenerRepository(testEnv.DB);
    const program = await seedProgram();

    await insertConnection({
      id: "lc_device_a_1",
      programId: program.programId,
      streamId: program.streams[0],
      clientId: "device_a",
      subscriptionStatus: "connected",
      userAgent: "Test UA",
      createdAt: "2026-06-24T10:00:00.000Z",
      connectedAt: "2026-06-24T10:00:00.000Z"
    });
    await insertConnection({
      id: "lc_device_a_2",
      programId: program.programId,
      streamId: program.streams[0],
      clientId: "device_a",
      subscriptionStatus: "connected",
      userAgent: "Test UA",
      createdAt: "2026-06-24T10:01:00.000Z",
      connectedAt: "2026-06-24T10:01:00.000Z"
    });
    await insertConnection({
      id: "lc_device_b",
      programId: program.programId,
      streamId: program.streams[1],
      clientId: "device_b",
      subscriptionStatus: "connected",
      userAgent: "Test UA",
      createdAt: "2026-06-24T10:02:00.000Z",
      connectedAt: "2026-06-24T10:02:00.000Z"
    });

    const aggregates = await repo.getProgramReportAggregates(program.programId);

    expect(aggregates.totals.totalConnections).toBe(3);
    expect(aggregates.totals.uniqueDevices).toBe(2);
  });

  it("getProgramReportAggregates uniqueDevices honors the date range", async () => {
    const repo = new ListenerRepository(testEnv.DB);
    const program = await seedProgram();
    const from = "2026-06-24T10:00:00.000Z";
    const to = "2026-06-25T10:00:00.000Z";

    await insertConnection({
      id: "lc_before_window",
      programId: program.programId,
      streamId: program.streams[0],
      clientId: "device_before",
      subscriptionStatus: "connected",
      userAgent: "Test UA",
      createdAt: "2026-06-24T09:59:59.000Z",
      connectedAt: "2026-06-24T09:59:59.000Z"
    });
    await insertConnection({
      id: "lc_in_window_a",
      programId: program.programId,
      streamId: program.streams[0],
      clientId: "device_a",
      subscriptionStatus: "connected",
      userAgent: "Test UA",
      createdAt: from,
      connectedAt: from
    });
    await insertConnection({
      id: "lc_in_window_b",
      programId: program.programId,
      streamId: program.streams[1],
      clientId: "device_b",
      subscriptionStatus: "connected",
      userAgent: "Test UA",
      createdAt: "2026-06-25T09:59:59.000Z",
      connectedAt: "2026-06-25T09:59:59.000Z"
    });
    await insertConnection({
      id: "lc_at_exclusive_to",
      programId: program.programId,
      streamId: program.streams[1],
      clientId: "device_after",
      subscriptionStatus: "connected",
      userAgent: "Test UA",
      createdAt: to,
      connectedAt: to
    });

    const aggregates = await repo.getProgramReportAggregates(program.programId, {
      from,
      to
    });

    expect(aggregates.totals.totalConnections).toBe(2);
    expect(aggregates.totals.uniqueDevices).toBe(2);
  });

  it("listProgramEventsPage paginates default 20, computes totalPages, and clamps pages", async () => {
    const repo = new ListenerRepository(testEnv.DB);
    const program = await seedProgram();
    const base = Date.parse("2026-06-24T10:00:00.000Z");

    for (let index = 0; index < 25; index += 1) {
      await insertEvent({
        id: `ev_page_${String(index).padStart(2, "0")}`,
        programId: program.programId,
        streamId: program.streams[index % 2] ?? null,
        eventType: "listener_left",
        occurredAt: new Date(base + index * 1000).toISOString()
      });
    }

    const page1 = await repo.listProgramEventsPage(program.programId, {});
    expect(page1.total).toBe(25);
    expect(page1.totalPages).toBe(2);
    expect(page1.page).toBe(1);
    expect(page1.pageSize).toBe(20);
    expect(page1.events).toHaveLength(20);
    expect(page1.events.map((event) => event.id)).toEqual(
      Array.from({ length: 20 }, (_, offset) =>
        `ev_page_${String(24 - offset).padStart(2, "0")}`
      )
    );

    const clamped = await repo.listProgramEventsPage(program.programId, {
      page: 99
    });
    expect(clamped.page).toBe(2);
    expect(clamped.events.map((event) => event.id)).toEqual([
      "ev_page_04",
      "ev_page_03",
      "ev_page_02",
      "ev_page_01",
      "ev_page_00"
    ]);
  });

  it("listProgramEventsPage filters by multiple eventTypes", async () => {
    const repo = new ListenerRepository(testEnv.DB);
    const program = await seedProgram();

    await insertEvent({
      id: "ev_subscribed",
      programId: program.programId,
      streamId: program.streams[0],
      eventType: "listener_reconnected",
      occurredAt: "2026-06-24T10:00:00.000Z"
    });
    await insertEvent({
      id: "ev_failed",
      programId: program.programId,
      streamId: program.streams[1],
      eventType: "connection_failed",
      occurredAt: "2026-06-24T10:01:00.000Z"
    });
    await insertEvent({
      id: "ev_left",
      programId: program.programId,
      streamId: program.streams[1],
      eventType: "listener_left",
      occurredAt: "2026-06-24T10:02:00.000Z"
    });

    const page = await repo.listProgramEventsPage(program.programId, {
      eventTypes: ["connection_failed", "listener_left"]
    });

    expect(page.total).toBe(2);
    expect(page.events.map((event) => event.id)).toEqual([
      "ev_left",
      "ev_failed"
    ]);
  });

  it("listProgramEventsPage filters by translatorId in metadata", async () => {
    const repo = new ListenerRepository(testEnv.DB);
    const program = await seedProgram();

    await insertEvent({
      id: "ev_translator_a",
      programId: program.programId,
      streamId: program.streams[0],
      eventType: "translator_connected",
      occurredAt: "2026-06-24T10:00:00.000Z",
      metadata: { translatorId: "translator_a" }
    });
    await insertEvent({
      id: "ev_translator_b",
      programId: program.programId,
      streamId: program.streams[1],
      eventType: "translator_disconnected",
      occurredAt: "2026-06-24T10:01:00.000Z",
      metadata: { translatorId: "translator_b" }
    });

    const page = await repo.listProgramEventsPage(program.programId, {
      translatorId: "translator_b"
    });

    expect(page.total).toBe(1);
    expect(page.events.map((event) => event.id)).toEqual(["ev_translator_b"]);
  });

  it("listProgramEventsPage range still applies", async () => {
    const repo = new ListenerRepository(testEnv.DB);
    const program = await seedProgram();
    const from = "2026-06-24T10:00:00.000Z";
    const to = "2026-06-25T10:00:00.000Z";

    await insertEvent({
      id: "ev_before_window",
      programId: program.programId,
      streamId: program.streams[0],
      eventType: "listener_left",
      occurredAt: "2026-06-24T09:59:59.000Z"
    });
    await insertEvent({
      id: "ev_from_inclusive",
      programId: program.programId,
      streamId: program.streams[0],
      eventType: "listener_reconnected",
      occurredAt: from
    });
    await insertEvent({
      id: "ev_inside_window",
      programId: program.programId,
      streamId: program.streams[1],
      eventType: "connection_failed",
      occurredAt: "2026-06-25T09:59:59.000Z",
      metadata: { reason: "ice_failed" }
    });
    await insertEvent({
      id: "ev_to_exclusive",
      programId: program.programId,
      streamId: program.streams[1],
      eventType: "listener_left",
      occurredAt: to
    });

    const result = await repo.listProgramEventsPage(program.programId, {
      range: { from, to },
      pageSize: 10
    });

    expect(result.events.map((event) => event.id)).toEqual([
      "ev_inside_window",
      "ev_from_inclusive"
    ]);
  });

  it("handles empty filtered results without throwing", async () => {
    const repo = new ListenerRepository(testEnv.DB);
    const program = await seedProgram();
    await seedConnections(program);

    const result = await repo.listProgramConnectionsPage(
      program.programId,
      { streamId: "stream_missing" },
      1
    );
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(1);
    expect(result.connections).toHaveLength(0);
  });

  it("throws for soft-deleted programs", async () => {
    const repo = new ListenerRepository(testEnv.DB);
    const program = await seedProgram();
    await seedConnections(program);
    const deletedAt = "2026-07-01T00:00:00.000Z";

    await testEnv.DB.prepare("UPDATE programs SET deleted_at = ? WHERE id = ?")
      .bind(deletedAt, program.programId)
      .run();

    await expect(
      repo.listProgramConnectionsPage(program.programId, {}, 1)
    ).rejects.toBeInstanceOf(ListenerProgramNotFoundError);
  });

  it("is injection-safe for device label and streamId filters", async () => {
    const repo = new ListenerRepository(testEnv.DB);
    const program = await seedProgram();
    await seedConnections(program);

    const injected = await repo.listProgramConnectionsPage(
      program.programId,
      { deviceLabel: "'; DROP TABLE x;--" },
      1
    );
    expect(injected.total).toBe(0);
    expect(injected.connections).toHaveLength(0);

    const streamFiltered = await repo.listProgramConnectionsPage(
      program.programId,
      { streamId: "stream_does_not_exist" },
      1
    );
    expect(streamFiltered.total).toBe(0);
    expect(streamFiltered.connections).toHaveLength(0);
  });

  it("maps NULL device_label to fallback derived label in report rows", async () => {
    const repo = new ListenerRepository(testEnv.DB);
    const program = await seedProgram();
    const rows = await seedConnections(program);
    const fallbackRow = rows.at(-1);
    if (!fallbackRow) {
      throw new Error("expected fallback row");
    }
    const fallbackDeviceLabel = deviceLabelFromUserAgent(fallbackRow.userAgent);

    const page = await repo.listProgramConnectionsPage(program.programId, {}, 1);
    const firstConnection = page.connections.at(0);
    if (!firstConnection) {
      throw new Error("expected page connection");
    }
    expect(firstConnection.deviceLabel).toBe(fallbackDeviceLabel);
    expect(firstConnection.id).toBe(fallbackRow.id);
  });
});
