import type { Env, WorkerEnv } from "../env";
import {
  applyConnectedUpdate,
  ListenerRepository,
  type ListenerClientHints,
  type ListenerConnectionRecord
} from "../db/listenerRepository";
import { deviceLabelFromUserAgent } from "../domain/deviceLabel";

export type ConnectionEvent =
  | { kind: "requested"; connection: ListenerConnectionRecord }
  | { kind: "connected"; connectionId: string; clientHints: ListenerClientHints };

type RequestedConnectionEvent = Extract<ConnectionEvent, { kind: "requested" }>;
type ConnectedConnectionEvent = Extract<ConnectionEvent, { kind: "connected" }>;

const CONNECTION_COLUMNS = [
  "id",
  "program_id",
  "language_stream_id",
  "client_id",
  "token_issued_at",
  "subscription_status",
  "connected_at",
  "disconnected_at",
  "disconnect_reason",
  "switch_from_connection_id",
  "reconnect_of_connection_id",
  "listener_ip",
  "user_agent",
  "device_label",
  "created_at",
  "updated_at"
] as const;

const ROW_PLACEHOLDERS = `(${CONNECTION_COLUMNS.map(() => "?").join(", ")})`;

// D1 allows 100 bound parameters per query; 16 columns per row means 6 rows = 96 params.
const MAX_ROWS_PER_INSERT = 6;

export async function enqueueConnectionEvent(
  env: WorkerEnv,
  event: ConnectionEvent
): Promise<void> {
  await env.CONNECTION_EVENTS.send(event);
}

export async function handleConnectionEventsBatch(
  batch: MessageBatch<ConnectionEvent>,
  env: Env
): Promise<void> {
  const requestedMessages: Message<RequestedConnectionEvent>[] = [];
  const connectedMessages: Message<ConnectedConnectionEvent>[] = [];
  for (const message of batch.messages) {
    const kind = (message.body as { kind?: string }).kind;
    if (kind === "requested") {
      requestedMessages.push(message as Message<RequestedConnectionEvent>);
    } else if (kind === "connected") {
      connectedMessages.push(message as Message<ConnectedConnectionEvent>);
    } else {
      console.log(JSON.stringify({ msg: "connection_event_unknown_kind", kind }));
      message.ack();
    }
  }

  for (let index = 0; index < requestedMessages.length; index += MAX_ROWS_PER_INSERT) {
    const chunk = requestedMessages.slice(index, index + MAX_ROWS_PER_INSERT);
    try {
      await insertRequestedConnections(
        env.DB,
        chunk.map((message) => message.body.connection)
      );
      for (const message of chunk) {
        message.ack();
      }
    } catch {
      for (const message of chunk) {
        try {
          await insertRequestedConnections(env.DB, [message.body.connection]);
          message.ack();
        } catch {
          message.retry();
        }
      }
    }
  }

  if (connectedMessages.length === 0) {
    return;
  }

  const repository = new ListenerRepository(env.DB);
  for (const message of connectedMessages) {
    try {
      const { connectionId, clientHints } = message.body;
      const { changes } = await applyConnectedUpdate(
        env.DB,
        connectionId,
        clientHints,
        true
      );
      if (changes > 0) {
        message.ack();
        continue;
      }

      const existing = await repository.getConnection(connectionId);
      if (existing) {
        message.ack();
      } else {
        message.retry();
      }
    } catch {
      message.retry();
    }
  }
}

async function insertRequestedConnections(
  db: D1Database,
  connections: ListenerConnectionRecord[]
): Promise<void> {
  if (connections.length === 0) {
    return;
  }

  const placeholders = connections.map(() => ROW_PLACEHOLDERS).join(", ");
  const sql = `INSERT INTO listener_connections
    (${CONNECTION_COLUMNS.join(", ")})
    VALUES ${placeholders}
    ON CONFLICT(id) DO NOTHING`;

  await db
    .prepare(sql)
    .bind(...connections.flatMap(connectionValues))
    .run();
}

function connectionValues(connection: ListenerConnectionRecord): unknown[] {
  return [
    connection.id,
    connection.programId,
    connection.streamId,
    connection.clientId,
    connection.createdAt,
    connection.subscriptionStatus,
    connection.connectedAt,
    connection.disconnectedAt,
    connection.disconnectReason,
    connection.switchFromConnectionId,
    connection.reconnectOfConnectionId,
    connection.listenerIp,
    connection.userAgent,
    deviceLabelFromUserAgent(connection.userAgent),
    connection.createdAt,
    connection.updatedAt
  ];
}
