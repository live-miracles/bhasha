import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  enqueueConnectionEvent,
  handleConnectionEventsBatch,
  type ConnectionEvent
} from "../src/queue/connectionEvents";
import {
  ListenerRepository,
  type ListenerClientHints,
  type ListenerConnectionRecord
} from "../src/db/listenerRepository";
import { deviceLabelFromUserAgent } from "../src/domain/deviceLabel";
import type { Env } from "../src/env";
import { buildTestEnv, testEnv } from "./test-env";

interface SeededProgram {
  programId: string;
  streamId: string;
}

async function resetDb(): Promise<void> {
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

async function seedProgram(): Promise<SeededProgram> {
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const programId = `program_queue_${suffix}`;
  const streamId = `stream_queue_${suffix}`;

  await testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      programId,
      `queue-${suffix}`,
      "Queue test program",
      "Main Hall",
      "2026-08-01",
      "live",
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
    .bind(streamId, programId, "Hindi", "hi", 1, 1, now, now)
    .run();

  return { programId, streamId };
}

function connection(
  seed: SeededProgram,
  index: number,
  overrides: Partial<ListenerConnectionRecord> = {}
): ListenerConnectionRecord {
  const timestamp = `2026-08-01T10:00:0${index}.000Z`;
  return {
    id: `listener_connection_queue_${index}`,
    programId: seed.programId,
    streamId: seed.streamId,
    clientId: `client_${index}`,
    subscriptionStatus: "requested",
    connectedAt: null,
    disconnectedAt: null,
    disconnectReason: null,
    cloudflareSessionId: null,
    cloudflareTrackMid: null,
    listenerIp: `203.0.113.${index}`,
    userAgent: `Queue Test Browser ${index}`,
    switchFromConnectionId: null,
    reconnectOfConnectionId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function eventFor(connectionRecord: ListenerConnectionRecord): ConnectionEvent {
  return { kind: "requested", connection: connectionRecord };
}

function connectedEvent(
  connectionId: string,
  clientHints: ListenerClientHints = {}
): ConnectionEvent {
  return {
    kind: "connected",
    connectionId,
    clientHints
  } as unknown as ConnectionEvent;
}

function batchFor(events: ConnectionEvent[]): {
  batch: MessageBatch<ConnectionEvent>;
  messages: Array<Message<ConnectionEvent> & { ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> }>;
} {
  const messages = events.map((event, index) => ({
    id: `message_${index}`,
    timestamp: new Date(`2026-08-01T11:00:0${index}.000Z`),
    body: event,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn()
  }));

  return {
    batch: {
      queue: "bhasha-connection-events",
      messages,
      metadata: {
        metrics: {
          backlogCount: events.length,
          backlogBytes: 0
        }
      },
      ackAll: vi.fn(),
      retryAll: vi.fn()
    },
    messages
  };
}

async function connectionRows(): Promise<Array<{
  id: string;
  programId: string;
  streamId: string;
  clientId: string;
  tokenIssuedAt: string;
  subscriptionStatus: string;
  listenerIp: string;
  userAgent: string;
  deviceLabel: string | null;
  createdAt: string;
  updatedAt: string;
}>> {
  const { results } = await testEnv.DB.prepare(
    `SELECT id, program_id as programId, language_stream_id as streamId,
      client_id as clientId, token_issued_at as tokenIssuedAt,
      subscription_status as subscriptionStatus, listener_ip as listenerIp,
      user_agent as userAgent, device_label as deviceLabel,
      created_at as createdAt, updated_at as updatedAt
    FROM listener_connections
    ORDER BY id`
  ).all();

  return results as Array<{
    id: string;
    programId: string;
    streamId: string;
    clientId: string;
    tokenIssuedAt: string;
    subscriptionStatus: string;
    listenerIp: string;
    userAgent: string;
    deviceLabel: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
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

describe("connection events queue", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("writes requested listener connections from a queue batch and acks every message", async () => {
    const seed = await seedProgram();
    const records = [connection(seed, 1), connection(seed, 2), connection(seed, 3)];
    const { batch, messages } = batchFor(records.map(eventFor));

    await handleConnectionEventsBatch(batch, testEnv);

    const rows = await connectionRows();
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      records.map((record) => ({
        id: record.id,
        programId: record.programId,
        streamId: record.streamId,
        clientId: record.clientId,
        tokenIssuedAt: record.createdAt,
        subscriptionStatus: "requested",
        listenerIp: record.listenerIp,
        userAgent: record.userAgent,
        deviceLabel: deviceLabelFromUserAgent(record.userAgent),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
      }))
    );
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledTimes(1);
      expect(message.retry).not.toHaveBeenCalled();
    }
  });

  it("chunks requested listener connection batches larger than the D1 bind limit", async () => {
    const seed = await seedProgram();
    const records = Array.from({ length: 13 }, (_, index) => connection(seed, index + 1));
    const { batch, messages } = batchFor(records.map(eventFor));
    const bindCounts: number[] = [];
    const db = {
      ...testEnv.DB,
      prepare(sql: string) {
        const statement = testEnv.DB.prepare(sql);
        return {
          ...statement,
          bind(...values: unknown[]) {
            bindCounts.push(values.length);
            if (values.length > 100) {
              throw new Error(`D1 bind limit exceeded: ${values.length}`);
            }
            return statement.bind(...values);
          }
        } as D1PreparedStatement;
      }
    } as D1Database;

    await handleConnectionEventsBatch(batch, { ...testEnv, DB: db });

    const rows = await connectionRows();
    expect(rows).toHaveLength(13);
    expect(new Set(rows.map((row) => row.id))).toEqual(
      new Set(records.map((record) => record.id))
    );
    expect(Math.max(...bindCounts)).toBeLessThanOrEqual(96);
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledTimes(1);
      expect(message.retry).not.toHaveBeenCalled();
    }
  });

  it("is idempotent on replay and does not clobber an existing connection", async () => {
    const seed = await seedProgram();
    const records = [connection(seed, 1), connection(seed, 2)];
    const { batch, messages } = batchFor(records.map(eventFor));

    await handleConnectionEventsBatch(batch, testEnv);
    await testEnv.DB.prepare(
      `UPDATE listener_connections
      SET subscription_status = 'connected', connected_at = ?, updated_at = ?
      WHERE id = ?`
    )
      .bind("2026-08-01T10:10:00.000Z", "2026-08-01T10:10:00.000Z", records[0]!.id)
      .run();
    await handleConnectionEventsBatch(batch, testEnv);

    const rows = await testEnv.DB.prepare(
      `SELECT COUNT(*) as count,
        SUM(CASE WHEN subscription_status = 'connected' THEN 1 ELSE 0 END) as connectedCount
      FROM listener_connections`
    ).first<{ count: number; connectedCount: number }>();

    expect(rows).toEqual({ count: 2, connectedCount: 1 });
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledTimes(2);
      expect(message.retry).not.toHaveBeenCalled();
    }
  });

  it("falls back per message when one row fails and retries only the bad message", async () => {
    const seed = await seedProgram();
    const validA = connection(seed, 1);
    const bad = connection(
      { programId: "missing_program", streamId: "missing_stream" },
      2
    );
    const validB = connection(seed, 3);
    const { batch, messages } = batchFor([validA, bad, validB].map(eventFor));

    await handleConnectionEventsBatch(batch, testEnv);

    const rows = await connectionRows();
    expect(rows.map((row) => row.id)).toEqual([validA.id, validB.id]);
    const [messageA, messageBad, messageB] = messages;
    expect(messageA?.ack).toHaveBeenCalledTimes(1);
    expect(messageA?.retry).not.toHaveBeenCalled();
    expect(messageBad?.ack).not.toHaveBeenCalled();
    expect(messageBad?.retry).toHaveBeenCalledTimes(1);
    expect(messageB?.ack).toHaveBeenCalledTimes(1);
    expect(messageB?.retry).not.toHaveBeenCalled();
  });

  it("updates a requested connection from a connected event and acks the message", async () => {
    const seed = await seedProgram();
    const record = connection(seed, 1);
    await handleConnectionEventsBatch(batchFor([eventFor(record)]).batch, testEnv);
    const { batch, messages } = batchFor([
      connectedEvent(record.id, {
        deviceModel: "iPhone",
        platform: "iOS",
        platformVersion: "18.0",
        browserFullVersion: '"Mobile Safari";v="18.0"'
      })
    ]);

    await handleConnectionEventsBatch(batch, testEnv);

    const row = await testEnv.DB.prepare(
      `SELECT subscription_status as subscriptionStatus,
        connected_at as connectedAt,
        last_seen_at as lastSeenAt,
        client_device_model as deviceModel,
        client_platform as platform,
        client_platform_version as platformVersion,
        client_browser_full_version as browserFullVersion
      FROM listener_connections
      WHERE id = ?`
    )
      .bind(record.id)
      .first<{
        subscriptionStatus: string;
        connectedAt: string | null;
        lastSeenAt: string | null;
        deviceModel: string | null;
        platform: string | null;
        platformVersion: string | null;
        browserFullVersion: string | null;
      }>();
    expect(row).toMatchObject({
      subscriptionStatus: "connected",
      deviceModel: "iPhone",
      platform: "iOS",
      platformVersion: "18.0",
      browserFullVersion: '"Mobile Safari";v="18.0"'
    });
    expect(row?.connectedAt).toEqual(expect.any(String));
    expect(row?.lastSeenAt).toBe(row?.connectedAt);
    expect(await subscribedEventCount(record.id)).toBe(0);
    expect(messages[0]?.ack).toHaveBeenCalledTimes(1);
    expect(messages[0]?.retry).not.toHaveBeenCalled();
  });

  it("retries a connected event when the requested row is not inserted yet", async () => {
    const { batch, messages } = batchFor([
      connectedEvent("listener_connection_missing")
    ]);

    await handleConnectionEventsBatch(batch, testEnv);

    expect(messages[0]?.ack).not.toHaveBeenCalled();
    expect(messages[0]?.retry).toHaveBeenCalledTimes(1);
  });

  it("acks a connected event for an already connected row", async () => {
    const seed = await seedProgram();
    const repository = new ListenerRepository(testEnv.DB);
    const existing = await repository.createRequestedConnection({
      programId: seed.programId,
      streamId: seed.streamId,
      clientId: "client_already_connected",
      listenerIp: "203.0.113.44",
      userAgent: "Already Connected Browser"
    });
    await repository.markConnected(existing.id);
    const { batch, messages } = batchFor([connectedEvent(existing.id)]);

    await handleConnectionEventsBatch(batch, testEnv);

    expect(messages[0]?.ack).toHaveBeenCalledTimes(1);
    expect(messages[0]?.retry).not.toHaveBeenCalled();
  });

  it("processes requested events before connected events in the same batch", async () => {
    const seed = await seedProgram();
    const record = connection(seed, 1);
    const { batch, messages } = batchFor([
      connectedEvent(record.id),
      eventFor(record)
    ]);

    await handleConnectionEventsBatch(batch, testEnv);

    const row = await testEnv.DB.prepare(
      `SELECT subscription_status as subscriptionStatus,
        connected_at as connectedAt
      FROM listener_connections
      WHERE id = ?`
    )
      .bind(record.id)
      .first<{ subscriptionStatus: string; connectedAt: string | null }>();
    expect(row?.subscriptionStatus).toBe("connected");
    expect(row?.connectedAt).toEqual(expect.any(String));
    expect(messages[0]?.ack).toHaveBeenCalledTimes(1);
    expect(messages[1]?.ack).toHaveBeenCalledTimes(1);
    expect(messages[0]?.retry).not.toHaveBeenCalled();
    expect(messages[1]?.retry).not.toHaveBeenCalled();
  });

  it("logs and acks unknown connection event kinds", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const unknownEvent = { kind: "mystery" } as unknown as ConnectionEvent;
    const { batch, messages } = batchFor([unknownEvent]);

    await handleConnectionEventsBatch(batch, testEnv);

    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ msg: "connection_event_unknown_kind", kind: "mystery" })
    );
    expect(messages[0]?.ack).toHaveBeenCalledTimes(1);
    expect(messages[0]?.retry).not.toHaveBeenCalled();
    expect(await connectionRows()).toEqual([]);
    log.mockRestore();
  });

  it("sends producer events to the connection events queue binding", async () => {
    const seed = { programId: "program_producer", streamId: "stream_producer" };
    const event = eventFor(connection(seed, 1));
    const send = vi.fn<Queue<ConnectionEvent>["send"]>();
    const env = buildTestEnv({
      CONNECTION_EVENTS: { send } as unknown as Queue<ConnectionEvent>
    }) as Env & { CONNECTION_EVENTS: Queue<ConnectionEvent> };

    await enqueueConnectionEvent(env, event);

    expect(send).toHaveBeenCalledWith(event);
  });
});
