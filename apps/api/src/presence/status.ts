// In-process presence manager, replacing the deleted `ProgramPresence`
// Durable Object. It keeps per-program listener join/leave state and
// audio-activity state in a plain `Map`, with no persistence -- it does NOT
// survive process restarts or run across multiple Node instances (fine for
// the single-server target architecture; see the migration plan doc).
//
// SOURCE OF TRUTH (Slice 3): listener join/leave now comes from
// `livekit/webhook.ts`'s handling of LiveKit's `participant_joined`/
// `participant_left` events (dispatched from the real WebRTC connection
// state), NOT from routes/listeners.ts's DB-lifecycle endpoints
// (`/request`, `/connected`, `/leave`, `/switch`, `/reconnect` all keep
// their `listener_connections` bookkeeping unchanged, but no longer call
// into this module). This is a materially stronger liveness signal than an
// app-level heartbeat: a participant that's genuinely gone produces a
// `participant_left` webhook without any client cooperation needed.
//
// STALENESS PRUNING (`pruneStale` below) is kept, but demoted from "primary
// mechanism" (Slice 1's stub) to "defense-in-depth safety net": LiveKit's
// webhook delivery is not 100% guaranteed (a dropped/lost `participant_left`
// would otherwise leak a listener in the count forever). `STALE_AFTER_MS` is
// therefore set to a multi-hour window -- long enough that it never fires
// during a real event's normal join->listen->leave lifecycle (nothing
// refreshes an individual listener's `lastSeenAt` between join and leave any
// more, since there is no more per-listener heartbeat call into this
// module), but still bounds the damage from a permanently-lost webhook to
// "stale after a few hours" rather than "leaked until process restart".
// `presenceHeartbeat` is kept (unchanged signature/behavior, still directly
// unit-tested) as public API surface for a future signal that wants to
// refresh a specific listener's liveness without a full join/leave, but has
// no production caller as of this slice.
import type { AudioActivitySnapshot } from "./streamState";

export interface PresenceSnapshot {
  total: number;
  streams: Record<string, number>;
  audioActivity: Record<string, AudioActivitySnapshot>;
  lastUpdatedAt: string;
}

export interface PresenceStatusSnapshot {
  total: number;
  streams: Record<string, number>;
  audioActivity: Record<string, AudioActivitySnapshot>;
  updatedAt: string | null;
  stale: boolean;
  degraded: boolean;
  serverTime: string;
}

export interface AudioActivityReport {
  transition: "started" | "stopped" | null;
  active: boolean;
}

// Defense-in-depth safety net against a lost/dropped `participant_left`
// webhook (see the module header comment) -- NOT a normal-operation timer.
// Six hours comfortably outlasts any real single-event program while still
// bounding a leaked listener's lifetime to "eventually", not "forever".
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const NEVER_UPDATED_AT = "1970-01-01T00:00:00.000Z";
const STALE_STATUS_AFTER_MS = 5_000;

interface ListenerPresenceRecord {
  streamId: string;
  lastSeenAt: number;
}

interface ProgramPresenceState {
  records: Map<string, ListenerPresenceRecord>;
  knownStreamIds: Set<string>;
  audioActivity: Map<string, AudioActivitySnapshot>;
  lastUpdatedAt: string;
}

const programStates = new Map<string, ProgramPresenceState>();

function emptyState(): ProgramPresenceState {
  return {
    records: new Map(),
    knownStreamIds: new Set(),
    audioActivity: new Map(),
    lastUpdatedAt: NEVER_UPDATED_AT
  };
}

function getState(programId: string): ProgramPresenceState {
  let state = programStates.get(programId);
  if (!state) {
    state = emptyState();
    programStates.set(programId, state);
  }
  return state;
}

function pruneStale(state: ProgramPresenceState, now: number): boolean {
  let pruned = false;
  for (const [connectionId, record] of state.records) {
    if (now - record.lastSeenAt > STALE_AFTER_MS) {
      state.knownStreamIds.add(record.streamId);
      state.records.delete(connectionId);
      pruned = true;
    }
  }
  return pruned;
}

function snapshot(state: ProgramPresenceState): PresenceSnapshot {
  const streams: Record<string, number> = {};
  for (const streamId of state.knownStreamIds) {
    streams[streamId] = 0;
  }
  for (const record of state.records.values()) {
    streams[record.streamId] = (streams[record.streamId] ?? 0) + 1;
  }

  const audioActivity: Record<string, AudioActivitySnapshot> = {};
  for (const [streamId, activity] of state.audioActivity) {
    audioActivity[streamId] = activity;
  }

  return {
    total: state.records.size,
    streams,
    audioActivity,
    lastUpdatedAt: state.lastUpdatedAt
  };
}

/** Record a listener joining `streamId` for presence-counting purposes. */
export function presenceJoin(
  programId: string,
  connectionId: string,
  streamId: string
): void {
  const state = getState(programId);
  const now = Date.now();
  pruneStale(state, now);
  state.knownStreamIds.add(streamId);
  state.records.set(connectionId, { streamId, lastSeenAt: now });
  state.lastUpdatedAt = new Date(now).toISOString();
}

/** Record a liveness heartbeat for an already-known (or rejoining) listener. */
export function presenceHeartbeat(
  programId: string,
  connectionId: string,
  streamId: string | null
): void {
  const state = getState(programId);
  const now = Date.now();
  pruneStale(state, now);

  const existing = state.records.get(connectionId);
  const resolvedStreamId = existing?.streamId ?? streamId;
  if (!resolvedStreamId) {
    return;
  }

  state.knownStreamIds.add(resolvedStreamId);
  state.records.set(connectionId, {
    streamId: resolvedStreamId,
    lastSeenAt: now
  });
  state.lastUpdatedAt = new Date(now).toISOString();
}

/** Record a listener leaving. */
export function presenceLeave(programId: string, connectionId: string): void {
  const state = getState(programId);
  const now = Date.now();
  pruneStale(state, now);

  const record = state.records.get(connectionId);
  if (record) {
    state.knownStreamIds.add(record.streamId);
    state.records.delete(connectionId);
  }
  state.lastUpdatedAt = new Date(now).toISOString();
}

export async function readPresenceStatusSnapshot(
  _env: unknown,
  programId: string
): Promise<PresenceStatusSnapshot> {
  const serverTime = new Date();
  const state = getState(programId);
  pruneStale(state, serverTime.getTime());
  const snap = snapshot(state);

  return {
    total: snap.total,
    streams: snap.streams,
    audioActivity: snap.audioActivity,
    updatedAt: snap.lastUpdatedAt === NEVER_UPDATED_AT ? null : snap.lastUpdatedAt,
    stale: isStale(snap.lastUpdatedAt, serverTime),
    degraded: false,
    serverTime: serverTime.toISOString()
  };
}

export async function reportAudioActivity(
  _env: unknown,
  programId: string,
  input: { streamId: string; publishSessionId: string; active: boolean }
): Promise<AudioActivityReport> {
  const state = getState(programId);
  const now = Date.now();
  const previous = state.audioActivity.get(input.streamId);
  const wasActiveForSession =
    previous !== undefined &&
    previous.publishSessionId === input.publishSessionId &&
    previous.active === true;

  let transition: "started" | "stopped" | null = null;
  if (input.active && !wasActiveForSession) {
    transition = "started";
  } else if (!input.active && wasActiveForSession) {
    transition = "stopped";
  }

  state.audioActivity.set(input.streamId, {
    publishSessionId: input.publishSessionId,
    lastAudioActivityAt: now,
    active: input.active
  });
  state.lastUpdatedAt = new Date(now).toISOString();

  return { transition, active: input.active };
}

function isStale(lastUpdatedAt: string, serverTime: Date): boolean {
  if (lastUpdatedAt === NEVER_UPDATED_AT) {
    return true;
  }

  const updatedAtMs = Date.parse(lastUpdatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return true;
  }

  return serverTime.getTime() - updatedAtMs > STALE_STATUS_AFTER_MS;
}

/** Test-only: reset all in-process presence state between test files/cases. */
export function __resetPresenceForTests(): void {
  programStates.clear();
}
