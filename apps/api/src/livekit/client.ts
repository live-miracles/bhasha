import { RoomServiceClient, WebhookReceiver } from "livekit-server-sdk";
import type { Env } from "../env";

/**
 * Whether all three LiveKit env vars are present. Used both by
 * routes/admin.ts's readiness check (isRealtimeConfigured) and by the
 * translator/listener token routes to fail fast with a clean error instead
 * of minting a JWT that a real LiveKit server would reject.
 */
export function isLiveKitConfigured(env: Env): boolean {
  return Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
}

/**
 * `RoomServiceClient`/`WebhookReceiver` need an http(s) URL for LiveKit's
 * admin REST API. `LIVEKIT_URL` is the ws(s):// URL that browser clients
 * (via livekit-client) use for signaling. LiveKit serves both the WS
 * signaling and the HTTP admin API on the same host/port, so derive one
 * from the other with a simple scheme swap instead of adding a second env
 * var. An already-http(s) or otherwise-unrecognized scheme passes through
 * unchanged.
 */
export function livekitHttpUrl(wsUrl: string): string {
  if (wsUrl.startsWith("wss://")) {
    return `https://${wsUrl.slice("wss://".length)}`;
  }
  if (wsUrl.startsWith("ws://")) {
    return `http://${wsUrl.slice("ws://".length)}`;
  }
  return wsUrl;
}

export function createRoomServiceClient(env: Env): RoomServiceClient {
  return new RoomServiceClient(
    livekitHttpUrl(env.LIVEKIT_URL ?? ""),
    env.LIVEKIT_API_KEY ?? "",
    env.LIVEKIT_API_SECRET ?? ""
  );
}

export function createWebhookReceiver(env: Env): WebhookReceiver {
  return new WebhookReceiver(env.LIVEKIT_API_KEY ?? "", env.LIVEKIT_API_SECRET ?? "");
}

/**
 * Best-effort room-participant kick, shared by routes/translator.ts (stop,
 * logout) and routes/admin.ts (kick-publisher, kick session). A participant
 * that's already gone (or a LiveKit server that's unreachable/unconfigured)
 * is not an error worth surfacing to the caller -- mirrors the "benign
 * cleanup" philosophy the old Cloudflare-Realtime code used for the same
 * kind of best-effort teardown call.
 */
export async function removeParticipantBestEffort(
  roomService: RoomServiceClient,
  roomName: string,
  identity: string
): Promise<void> {
  try {
    await roomService.removeParticipant(roomName, identity);
  } catch (error) {
    console.info(
      JSON.stringify({
        level: "info",
        msg: "livekit_remove_participant_failed",
        roomName,
        identity,
        error: error instanceof Error ? error.message : String(error)
      })
    );
  }
}

/**
 * Best-effort room teardown, used at stream-delete and program-archive/
 * restore-to-draft points so no stray empty room lingers. Never throws --
 * LiveKit rooms are created implicitly on first join, so a delete for a
 * room that was never created (or is already gone) is an expected no-op.
 */
export async function deleteRoomBestEffort(
  roomService: RoomServiceClient,
  roomName: string
): Promise<void> {
  try {
    await roomService.deleteRoom(roomName);
  } catch (error) {
    console.info(
      JSON.stringify({
        level: "info",
        msg: "livekit_delete_room_failed",
        roomName,
        error: error instanceof Error ? error.message : String(error)
      })
    );
  }
}
