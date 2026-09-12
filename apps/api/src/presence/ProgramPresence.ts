import { json, notFound } from "../http";

interface PresenceRecord {
  streamId: string;
  lastSeenAt: number;
}

interface AudioActivityRecord {
  publishSessionId: string;
  lastAudioActivityAt: number;
  active: boolean;
}

interface PresenceSnapshot {
  total: number;
  streams: Record<string, number>;
  audioActivity: Record<string, AudioActivityRecord>;
  lastUpdatedAt: string;
}

interface AudioActivityResult extends PresenceSnapshot {
  transition: "started" | "stopped" | null;
}

interface StoredPresenceState {
  records: Record<string, PresenceRecord>;
  connectionVersions: Record<string, string>;
  connectionVersionKinds: Record<string, ConnectionVersionKind>;
  leftConnections: Record<string, number>;
  knownStreamIds: Set<string>;
  audioActivity: Record<string, AudioActivityRecord>;
  lastUpdatedAt: string;
}

interface AudioActivityInput {
  streamId: string;
  publishSessionId: string;
  active: boolean;
}

type ConnectionVersionKind = "join" | "leave";

interface JoinInput {
  connectionId: string;
  streamId: string;
  statusVersion: string | null;
}

interface ConnectionInput {
  connectionId: string;
  statusVersion: string | null;
}

interface HeartbeatInput {
  connectionId: string;
  streamId: string | null;
}

const JOIN_VALIDATION_MESSAGE = "connectionId and streamId are required";
const CONNECTION_VALIDATION_MESSAGE = "connectionId is required";
const AUDIO_ACTIVITY_VALIDATION_MESSAGE =
  "streamId, publishSessionId and active are required";
const RECORDS_STORAGE_KEY = "records";
const CONNECTION_VERSIONS_STORAGE_KEY = "connectionVersions";
const CONNECTION_VERSION_KINDS_STORAGE_KEY = "connectionVersionKinds";
const LEFT_CONNECTIONS_STORAGE_KEY = "leftConnections";
const KNOWN_STREAM_IDS_STORAGE_KEY = "knownStreamIds";
const AUDIO_ACTIVITY_STORAGE_KEY = "audioActivity";
const LAST_UPDATED_AT_STORAGE_KEY = "lastUpdatedAt";
const NEVER_UPDATED_AT = "1970-01-01T00:00:00.000Z";

export class ProgramPresence {
  // Listener clients heartbeat every 90s; keep this aligned with the 240s D1
  // active-listener window so DO counts do not evict live listeners early.
  private readonly staleAfterMs = 240_000;
  private readonly checkpointAfterMs = 2_500;
  private cachedState: StoredPresenceState = emptyPresenceState();
  private dirty = false;
  private readonly initialized: Promise<void>;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {
    this.initialized = this.loadState().then((storedState) => {
      this.cachedState = storedState;
    });
    this.state.blockConcurrencyWhile(() => this.initialized);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return notFound();
    }

    const path = new URL(request.url).pathname;
    if (path === "/snapshot") {
      return json(await this.currentSnapshot(Date.now()));
    }

    if (path === "/join") {
      return this.join(request);
    }

    if (path === "/heartbeat") {
      return this.heartbeat(request);
    }

    if (path === "/leave") {
      return this.leave(request);
    }

    if (path === "/audio-activity") {
      return this.audioActivity(request);
    }

    return notFound();
  }

  private async audioActivity(request: Request): Promise<Response> {
    const body = await readRequestBody(request);
    const input = parseAudioActivityInput(body);
    if (!input) {
      return validationError(AUDIO_ACTIVITY_VALIDATION_MESSAGE);
    }

    const now = Date.now();
    let transition: "started" | "stopped" | null = null;
    const snapshot = await this.mutatePresence(now, (state) => {
      const previous = state.audioActivity[input.streamId];
      const wasActiveForSession =
        previous !== undefined &&
        previous.publishSessionId === input.publishSessionId &&
        previous.active === true;

      if (input.active && !wasActiveForSession) {
        transition = "started";
      } else if (!input.active && wasActiveForSession) {
        transition = "stopped";
      }

      state.audioActivity[input.streamId] = {
        publishSessionId: input.publishSessionId,
        lastAudioActivityAt: now,
        active: input.active
      };
      return true;
    });

    const result: AudioActivityResult = { ...snapshot, transition };
    return json(result);
  }

  private async join(request: Request): Promise<Response> {
    const body = await readRequestBody(request);
    const input = parseJoinInput(body);
    if (!input) {
      return validationError(JOIN_VALIDATION_MESSAGE);
    }

    const now = Date.now();
    const statusVersion = input.statusVersion ?? new Date(now).toISOString();
    const snapshot = await this.mutatePresence(now, (state) => {
      if (shouldIgnoreJoin(state, input.connectionId, statusVersion)) {
        return false;
      }

      rememberStatusVersion(state, input.connectionId, statusVersion, "join");
      delete state.leftConnections[input.connectionId];

      const existingRecord = state.records[input.connectionId];
      if (existingRecord) {
        state.knownStreamIds.add(existingRecord.streamId);
      }

      state.knownStreamIds.add(input.streamId);
      state.records[input.connectionId] = {
        streamId: input.streamId,
        lastSeenAt: now
      };
      return true;
    });

    return json(snapshot);
  }

  private async heartbeat(request: Request): Promise<Response> {
    const body = await readRequestBody(request);
    const input = parseHeartbeatInput(body);
    if (!input) {
      return validationError(CONNECTION_VALIDATION_MESSAGE);
    }

    const now = Date.now();
    const snapshot = await this.mutatePresence(now, (state) => {
      const record = state.records[input.connectionId];
      if (!record) {
        if (!input.streamId) {
          return false;
        }

        if (state.leftConnections[input.connectionId] !== undefined) {
          return false;
        }

        state.knownStreamIds.add(input.streamId);
        state.records[input.connectionId] = {
          streamId: input.streamId,
          lastSeenAt: now
        };
        return true;
      }

      state.knownStreamIds.add(record.streamId);
      state.records[input.connectionId] = {
        streamId: record.streamId,
        lastSeenAt: now
      };
      return true;
    });

    return json(snapshot);
  }

  private async leave(request: Request): Promise<Response> {
    const body = await readRequestBody(request);
    const input = parseConnectionInput(body);
    if (!input) {
      return validationError(CONNECTION_VALIDATION_MESSAGE);
    }

    const now = Date.now();
    const statusVersion = input.statusVersion ?? new Date(now).toISOString();
    const snapshot = await this.mutatePresence(now, (state) => {
      if (isStaleStatusVersion(state, input.connectionId, statusVersion)) {
        return false;
      }

      const previousVersion = state.connectionVersions[input.connectionId];
      const previousKind = state.connectionVersionKinds[input.connectionId];
      const previousLeftAt = state.leftConnections[input.connectionId];
      rememberStatusVersion(state, input.connectionId, statusVersion, "leave");
      state.leftConnections[input.connectionId] = now;

      const record = state.records[input.connectionId];
      if (!record) {
        return (
          previousVersion !== state.connectionVersions[input.connectionId] ||
          previousKind !== state.connectionVersionKinds[input.connectionId] ||
          previousLeftAt !== state.leftConnections[input.connectionId]
        );
      }

      state.knownStreamIds.add(record.streamId);
      delete state.records[input.connectionId];
      return true;
    });

    return json(snapshot);
  }

  private async currentSnapshot(now: number): Promise<PresenceSnapshot> {
    return this.mutatePresence(now, () => false);
  }

  async alarm(): Promise<void> {
    await this.initialized;

    try {
      const now = Date.now();
      const pruned = this.pruneStale(this.cachedState, now);
      if (pruned) {
        this.cachedState.lastUpdatedAt = new Date(now).toISOString();
        this.dirty = true;
      }

      if (this.dirty) {
        await this.writeState(this.cachedState);
        this.dirty = false;
      }
    } catch (_error) {
      // A failed checkpoint must not permanently stop the single-flight alarm loop.
    } finally {
      if (this.dirty || Object.keys(this.cachedState.records).length > 0) {
        await this.scheduleCheckpoint();
      }
    }
  }

  private async mutatePresence(
    now: number,
    applyMutation: (state: StoredPresenceState) => boolean
  ): Promise<PresenceSnapshot> {
    await this.initialized;

    const pruned = this.pruneStale(this.cachedState, now);
    const mutated = applyMutation(this.cachedState);

    if (pruned || mutated) {
      this.cachedState.lastUpdatedAt = new Date(now).toISOString();
      this.dirty = true;
      // Checkpoints are alarm-driven. If this object is evicted before the next
      // checkpoint, the bounded gap is repaired when listeners heartbeat with streamId.
      await this.scheduleCheckpoint();
    } else if (this.dirty) {
      await this.scheduleCheckpoint();
    }

    return this.snapshot(this.cachedState);
  }

  private snapshot(state: StoredPresenceState): PresenceSnapshot {
    const streams: Record<string, number> = {};
    for (const streamId of state.knownStreamIds) {
      streams[streamId] = 0;
    }

    for (const record of Object.values(state.records)) {
      streams[record.streamId] = (streams[record.streamId] ?? 0) + 1;
    }

    return {
      total: Object.keys(state.records).length,
      streams,
      audioActivity: { ...state.audioActivity },
      lastUpdatedAt: state.lastUpdatedAt
    };
  }

  private pruneStale(state: StoredPresenceState, now: number): boolean {
    let pruned = false;
    for (const [connectionId, record] of Object.entries(state.records)) {
      if (now - record.lastSeenAt > this.staleAfterMs) {
        state.knownStreamIds.add(record.streamId);
        delete state.records[connectionId];
        pruned = true;
      }
    }

    for (const [connectionId, leftAt] of Object.entries(state.leftConnections)) {
      if (now - leftAt > this.staleAfterMs) {
        delete state.leftConnections[connectionId];
        pruned = true;
      }
    }

    return pruned;
  }

  private async loadState(): Promise<StoredPresenceState> {
    const [
      records,
      connectionVersions,
      connectionVersionKinds,
      leftConnections,
      knownStreamIds,
      audioActivity,
      lastUpdatedAt
    ] =
      await Promise.all([
        this.state.storage.get<Record<string, PresenceRecord>>(RECORDS_STORAGE_KEY),
        this.state.storage.get<Record<string, string>>(
          CONNECTION_VERSIONS_STORAGE_KEY
        ),
        this.state.storage.get<Record<string, ConnectionVersionKind>>(
          CONNECTION_VERSION_KINDS_STORAGE_KEY
        ),
        this.state.storage.get<Record<string, number>>(LEFT_CONNECTIONS_STORAGE_KEY),
        this.state.storage.get<string[]>(KNOWN_STREAM_IDS_STORAGE_KEY),
        this.state.storage.get<Record<string, AudioActivityRecord>>(
          AUDIO_ACTIVITY_STORAGE_KEY
        ),
        this.state.storage.get<string>(LAST_UPDATED_AT_STORAGE_KEY)
      ]);

    return {
      records: records ?? {},
      connectionVersions: connectionVersions ?? {},
      connectionVersionKinds: connectionVersionKinds ?? {},
      leftConnections: leftConnections ?? {},
      knownStreamIds: new Set(knownStreamIds ?? []),
      audioActivity: audioActivity ?? {},
      lastUpdatedAt: lastUpdatedAt ?? NEVER_UPDATED_AT
    };
  }

  private async ensureAlarmScheduled(): Promise<void> {
    const currentAlarm = await this.state.storage.getAlarm();
    if (currentAlarm === null) {
      await this.state.storage.setAlarm(Date.now() + this.checkpointAfterMs);
    }
  }

  private async scheduleCheckpoint(): Promise<void> {
    try {
      await this.ensureAlarmScheduled();
    } catch (_error) {
      // Scheduling is best-effort; dirty state stays dirty and later reads or
      // mutations retry without failing listener/admin requests.
    }
  }

  private async writeState(state: StoredPresenceState): Promise<void> {
    await this.state.storage.transaction(async (txn) => {
      await txn.put(RECORDS_STORAGE_KEY, state.records);
      await txn.put(CONNECTION_VERSIONS_STORAGE_KEY, state.connectionVersions);
      await txn.put(
        CONNECTION_VERSION_KINDS_STORAGE_KEY,
        state.connectionVersionKinds
      );
      await txn.put(LEFT_CONNECTIONS_STORAGE_KEY, state.leftConnections);
      await txn.put(KNOWN_STREAM_IDS_STORAGE_KEY, [...state.knownStreamIds]);
      await txn.put(AUDIO_ACTIVITY_STORAGE_KEY, state.audioActivity);
      await txn.put(LAST_UPDATED_AT_STORAGE_KEY, state.lastUpdatedAt);
    });
  }
}

function emptyPresenceState(): StoredPresenceState {
  return {
    records: {},
    connectionVersions: {},
    connectionVersionKinds: {},
    leftConnections: {},
    knownStreamIds: new Set(),
    audioActivity: {},
    lastUpdatedAt: NEVER_UPDATED_AT
  };
}

async function readRequestBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (_error) {
    return null;
  }
}

function parseJoinInput(body: unknown): JoinInput | null {
  const connectionId = readNonEmptyString(body, "connectionId");
  const streamId = readNonEmptyString(body, "streamId");

  if (!connectionId || !streamId) {
    return null;
  }

  return {
    connectionId,
    streamId,
    statusVersion: readOptionalNonEmptyString(body, "statusVersion")
  };
}

function parseAudioActivityInput(body: unknown): AudioActivityInput | null {
  const streamId = readNonEmptyString(body, "streamId");
  const publishSessionId = readNonEmptyString(body, "publishSessionId");
  if (!streamId || !publishSessionId) {
    return null;
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const active = (body as Record<string, unknown>).active;
  if (typeof active !== "boolean") {
    return null;
  }

  return { streamId, publishSessionId, active };
}

function parseConnectionInput(body: unknown): ConnectionInput | null {
  const connectionId = readNonEmptyString(body, "connectionId");
  if (!connectionId) {
    return null;
  }

  return {
    connectionId,
    statusVersion: readOptionalNonEmptyString(body, "statusVersion")
  };
}

function parseHeartbeatInput(body: unknown): HeartbeatInput | null {
  const connectionId = readNonEmptyString(body, "connectionId");
  if (!connectionId) {
    return null;
  }

  return {
    connectionId,
    streamId: readOptionalNonEmptyString(body, "streamId")
  };
}

function readNonEmptyString(body: unknown, key: string): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalNonEmptyString(body: unknown, key: string): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isStaleStatusVersion(
  state: StoredPresenceState,
  connectionId: string,
  statusVersion: string
): boolean {
  const storedVersion = state.connectionVersions[connectionId];
  return (
    storedVersion !== undefined &&
    compareStatusVersions(statusVersion, storedVersion) < 0
  );
}

function shouldIgnoreJoin(
  state: StoredPresenceState,
  connectionId: string,
  statusVersion: string
): boolean {
  if (isStaleStatusVersion(state, connectionId, statusVersion)) {
    return true;
  }

  const storedVersion = state.connectionVersions[connectionId];
  return (
    storedVersion !== undefined &&
    state.connectionVersionKinds[connectionId] === "leave" &&
    compareStatusVersions(statusVersion, storedVersion) === 0
  );
}

function rememberStatusVersion(
  state: StoredPresenceState,
  connectionId: string,
  statusVersion: string,
  kind: ConnectionVersionKind
): void {
  const storedVersion = state.connectionVersions[connectionId];
  if (
    storedVersion === undefined ||
    compareStatusVersions(statusVersion, storedVersion) >= 0
  ) {
    state.connectionVersions[connectionId] = statusVersion;
    state.connectionVersionKinds[connectionId] = kind;
  }
}

function compareStatusVersions(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);

  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return leftTime - rightTime;
  }

  return left.localeCompare(right);
}

function validationError(message: string): Response {
  return json({ error: "validation_error", message }, { status: 400 });
}
