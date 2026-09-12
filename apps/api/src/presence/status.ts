import type { Env } from "../env";
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

const NEVER_UPDATED_AT = "1970-01-01T00:00:00.000Z";
const STALE_AFTER_MS = 5_000;

export async function readPresenceStatusSnapshot(
  env: Env,
  programId: string
): Promise<PresenceStatusSnapshot> {
  const serverTime = new Date();
  try {
    const snapshot = await fetchPresenceSnapshot(env, programId);
    return {
      total: snapshot.total,
      streams: snapshot.streams,
      audioActivity: snapshot.audioActivity,
      updatedAt: snapshot.lastUpdatedAt,
      stale: isStale(snapshot.lastUpdatedAt, serverTime),
      degraded: false,
      serverTime: serverTime.toISOString()
    };
  } catch (_error) {
    return {
      total: 0,
      streams: {},
      audioActivity: {},
      updatedAt: null,
      stale: true,
      degraded: true,
      serverTime: serverTime.toISOString()
    };
  }
}

export async function reportAudioActivity(
  env: Env,
  programId: string,
  input: { streamId: string; publishSessionId: string; active: boolean }
): Promise<AudioActivityReport> {
  const id = env.PROGRAM_PRESENCE.idFromName(programId);
  const stub = env.PROGRAM_PRESENCE.get(id);
  const response = await stub.fetch("https://presence.internal/audio-activity", {
    method: "POST",
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    throw new Error("audio activity report failed");
  }

  const body = await response.json<{
    transition?: "started" | "stopped" | null;
  }>();
  return { transition: body.transition ?? null, active: input.active };
}

async function fetchPresenceSnapshot(
  env: Env,
  programId: string
): Promise<PresenceSnapshot> {
  const id = env.PROGRAM_PRESENCE.idFromName(programId);
  const stub = env.PROGRAM_PRESENCE.get(id);
  const response = await stub.fetch("https://presence.internal/snapshot", {
    method: "POST",
    body: "{}"
  });

  if (!response.ok) {
    throw new Error("presence snapshot failed");
  }

  const body = await response.json<PresenceSnapshot>();
  if (
    typeof body.total !== "number" ||
    body.streams === null ||
    typeof body.streams !== "object" ||
    Array.isArray(body.streams) ||
    typeof body.lastUpdatedAt !== "string"
  ) {
    throw new Error("presence snapshot was invalid");
  }

  return {
    total: body.total,
    streams: body.streams,
    audioActivity: isAudioActivityMap(body.audioActivity)
      ? body.audioActivity
      : {},
    lastUpdatedAt: body.lastUpdatedAt
  };
}

function isAudioActivityMap(
  value: unknown
): value is Record<string, AudioActivitySnapshot> {
  return (
    value !== null && typeof value === "object" && !Array.isArray(value)
  );
}

function isStale(lastUpdatedAt: string, serverTime: Date): boolean {
  if (lastUpdatedAt === NEVER_UPDATED_AT) {
    return true;
  }

  const updatedAtMs = Date.parse(lastUpdatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return true;
  }

  return serverTime.getTime() - updatedAtMs > STALE_AFTER_MS;
}
