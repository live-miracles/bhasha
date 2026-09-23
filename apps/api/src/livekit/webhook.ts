import {
  TrackType,
  type RoomServiceClient,
  type WebhookEvent,
  type WebhookReceiver
} from "livekit-server-sdk";
import type { Env } from "../env";
import { json } from "../http";
import {
  PublisherOwnershipError,
  PublisherReservationNotFoundError,
  PUBLISHER_TTL_MS,
  RealtimeStreamRepository
} from "../db/realtimeStreamRepository";
import { presenceJoin, presenceLeave } from "../presence/status";
import { createRoomServiceClient, createWebhookReceiver } from "./client";
import { listenerIdentity, translatorIdentity } from "./tokens";

interface TranslatorParticipantMetadata {
  role: "translator";
  programId: string;
  streamId: string;
  translatorId: string;
  publishSessionId: string;
}

interface ListenerParticipantMetadata {
  role: "listener";
  programId: string;
  streamId: string;
  connectionId: string;
}

type ParticipantMetadata =
  | TranslatorParticipantMetadata
  | ListenerParticipantMetadata;

/**
 * Receives LiveKit's webhook POSTs, verifies the signature, and dispatches
 * to the presence module / `RealtimeStreamRepository` per the event type.
 * Route this at `POST /api/livekit/webhook` (see index.ts).
 *
 * `receiver` defaults to a real `WebhookReceiver` built from `env`, matching
 * the DI pattern `auth/translatorAuth.ts`'s `requireTranslatorSession`
 * already uses (a default constructed from `env`, overridable by tests) --
 * this lets tests inject a fake receiver directly instead of trying to
 * `vi.mock` livekit/client.ts, which doesn't work here since test-env.ts's
 * setupFile-time import chain (test/apply-migrations.ts -> ./test-env ->
 * src/index.ts -> this module) instantiates the real module graph before a
 * per-test-file `vi.mock` call can intercept it.
 */
export async function handleLiveKitWebhook(
  request: Request,
  env: Env,
  receiver: WebhookReceiver = createWebhookReceiver(env),
  roomService: RoomServiceClient = createRoomServiceClient(env)
): Promise<Response> {
  const body = await request.text();
  const authHeader = request.headers.get("authorization") ?? undefined;

  let event: WebhookEvent;
  try {
    event = await receiver.receive(body, authHeader);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "livekit_webhook_rejected",
        error: error instanceof Error ? error.message : String(error)
      })
    );
    return json({ error: "invalid_webhook_signature" }, { status: 401 });
  }

  // Never fail the webhook response over a downstream bookkeeping error --
  // LiveKit does not usefully retry a 200'd delivery, and turning a
  // malformed-metadata or racy-DB-state edge case into a 5xx would just
  // trigger pointless redelivery storms. Log and move on (per-event-type
  // handlers below already treat their own expected failure modes as
  // no-ops; this is a last-resort catch-all).
  try {
    await dispatchLiveKitEvent(env, event, roomService);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "livekit_webhook_dispatch_failed",
        event: event.event,
        error: error instanceof Error ? error.message : String(error)
      })
    );
  }

  return json({ ok: true });
}

async function dispatchLiveKitEvent(
  env: Env,
  event: WebhookEvent,
  roomService: RoomServiceClient
): Promise<void> {
  switch (event.event) {
    case "participant_joined":
      await handleParticipantJoined(env, event);
      return;
    case "participant_left":
      await handleParticipantLeft(env, event);
      return;
    case "track_published":
      await handleTrackPublished(env, event, roomService);
      return;
    case "track_unpublished":
      await handleTrackUnpublished(env, event, roomService);
      return;
    default:
      // room_started, room_finished, egress_*, ingress_*, etc. -- no-op in
      // this slice.
      return;
  }
}

async function handleParticipantJoined(env: Env, event: WebhookEvent): Promise<void> {
  const metadata = parseParticipantMetadata(event);
  if (!metadata) {
    return;
  }

  if (metadata.role === "listener") {
    presenceJoin(metadata.programId, metadata.connectionId, metadata.streamId);
  }
  // Translators are not counted as listeners -- no presence action.
}

async function handleParticipantLeft(env: Env, event: WebhookEvent): Promise<void> {
  const metadata = parseParticipantMetadata(event);
  if (!metadata) {
    return;
  }

  if (metadata.role === "listener") {
    presenceLeave(metadata.programId, metadata.connectionId);
    return;
  }

  // Best-effort: mark the translator's publisher reservation closed in case
  // their own client-side `/api/translator/realtime/stop` call never landed
  // (tab crash, network loss, etc.). Idempotent against an
  // already-closed/closing/failed reservation or one that no longer exists.
  await closePublisherReservationBestEffort(env, metadata);
}

async function handleTrackPublished(
  env: Env,
  event: WebhookEvent,
  roomService: RoomServiceClient
): Promise<void> {
  const metadata = await resolveParticipantMetadata(roomService, event);
  if (!metadata || metadata.role !== "translator") {
    return;
  }
  if (event.track?.type !== TrackType.AUDIO) {
    return;
  }

  const realtime = new RealtimeStreamRepository(env.DB);
  try {
    // Confirms the reservation actually has a flowing track ("reserved" ->
    // "published"). There is no SDP/track-name/mid to record with LiveKit --
    // markPublisherTrackLive's trackName/trackMid columns are repurposed to
    // hold LiveKit's own track sid (for audit/debugging) and a constant
    // placeholder respectively, since LiveKit has no "mid" concept exposed
    // at this level. The expiry is a short TTL from now rather than the
    // translator's true absolute session expiry (which this webhook has no
    // easy access to) -- the translator's own `/heartbeat` call (unchanged)
    // extends it with the real absolute expiry once it starts firing.
    await realtime.markPublisherTrackLive({
      publishSessionId: metadata.publishSessionId,
      translatorId: metadata.translatorId,
      streamId: metadata.streamId,
      trackName: event.track?.sid || "livekit-audio",
      trackMid: "livekit",
      expiresAt: new Date(Date.now() + PUBLISHER_TTL_MS).toISOString()
    });
  } catch (error) {
    logBenignPublisherError("livekit_webhook_track_published_failed", metadata, error);
  }
}

async function handleTrackUnpublished(
  env: Env,
  event: WebhookEvent,
  roomService: RoomServiceClient
): Promise<void> {
  const metadata = await resolveParticipantMetadata(roomService, event);
  if (!metadata || metadata.role !== "translator") {
    return;
  }
  if (event.track?.type !== TrackType.AUDIO) {
    return;
  }

  // Mirrors participant_left's translator handling, but independent of it --
  // a translator can unpublish their mic without leaving the room. Safe to
  // call even if participant_left (or the client's own /stop) already closed
  // this reservation: clearPublisher() is idempotent on an already-closed/
  // failed/closing row.
  await closePublisherReservationBestEffort(env, metadata);
}

async function closePublisherReservationBestEffort(
  env: Env,
  metadata: TranslatorParticipantMetadata
): Promise<void> {
  const realtime = new RealtimeStreamRepository(env.DB);
  try {
    await realtime.clearPublisher({
      publishSessionId: metadata.publishSessionId,
      translatorId: metadata.translatorId,
      streamId: metadata.streamId,
      cleanupFailed: false
    });
  } catch (error) {
    logBenignPublisherError("livekit_webhook_close_publisher_failed", metadata, error);
  }
}

// PublisherReservationNotFoundError/PublisherOwnershipError are expected,
// benign outcomes here (the reservation was already cleared by the client's
// own call, reclaimed by another translator, or simply never existed under
// this id) -- log at info level rather than error, and always no-op rather
// than throw (this repo's transactional guards already make every one of
// these DB calls idempotent/safe to retry).
function logBenignPublisherError(
  msg: string,
  metadata: TranslatorParticipantMetadata,
  error: unknown
): void {
  const level =
    error instanceof PublisherReservationNotFoundError ||
    error instanceof PublisherOwnershipError
      ? "info"
      : "error";
  const log = level === "info" ? console.info : console.error;
  log(
    JSON.stringify({
      level,
      msg,
      programId: metadata.programId,
      streamId: metadata.streamId,
      translatorId: metadata.translatorId,
      publishSessionId: metadata.publishSessionId,
      error: error instanceof Error ? error.message : String(error)
    })
  );
}

function parseParticipantMetadata(event: WebhookEvent): ParticipantMetadata | null {
  return parseParticipantMetadataFields(
    event.participant?.metadata,
    event.participant?.identity,
    event.event
  );
}

// LiveKit's own webhook payload for track_published/track_unpublished carries
// a PARTIAL `participant` reference with NO metadata (confirmed empirically
// against a real LiveKit server: participant_joined/participant_left DO
// include full metadata, track_* events do not -- LiveKit builds a lighter
// participant snapshot for track-level events). Without this fallback,
// handleTrackPublished can never identify the publishing translator via a
// real LiveKit server, so a stream can never move out of "offline" -- only
// caught by testing against a live server, since a synthetic WebhookEvent
// fixture naturally has whatever fields a test author assumed were present.
// Falls back to asking LiveKit directly for the full participant record
// (by room + the still-present, signed identity) only when the inline
// metadata is missing -- never when it's present-but-malformed/mismatched,
// since a fresh fetch would just return the same already-rejected value.
async function resolveParticipantMetadata(
  roomService: RoomServiceClient,
  event: WebhookEvent
): Promise<ParticipantMetadata | null> {
  const inline = parseParticipantMetadata(event);
  if (inline) {
    return inline;
  }
  if (event.participant?.metadata) {
    // Metadata WAS present but failed to parse/validate -- already logged by
    // parseParticipantMetadata; refetching would just return the same value.
    return null;
  }

  const roomName = event.room?.name;
  const identity = event.participant?.identity;
  if (!roomName || !identity) {
    return null;
  }

  let participant: { metadata: string; identity: string };
  try {
    participant = await roomService.getParticipant(roomName, identity);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "livekit_webhook_participant_refetch_failed",
        event: event.event,
        room: roomName,
        identity,
        error: error instanceof Error ? error.message : String(error)
      })
    );
    return null;
  }

  return parseParticipantMetadataFields(
    participant.metadata,
    participant.identity,
    event.event
  );
}

function parseParticipantMetadataFields(
  raw: string | undefined,
  identity: string | undefined,
  eventName: string
): ParticipantMetadata | null {
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "livekit_webhook_metadata_malformed",
        event: eventName,
        error: error instanceof Error ? error.message : String(error)
      })
    );
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.role === "translator" &&
    typeof candidate.programId === "string" &&
    typeof candidate.streamId === "string" &&
    typeof candidate.translatorId === "string" &&
    typeof candidate.publishSessionId === "string"
  ) {
    if (identity !== translatorIdentity(candidate.translatorId)) {
      logIdentityMismatch(eventName, identity);
      return null;
    }
    return candidate as unknown as TranslatorParticipantMetadata;
  }

  if (
    candidate.role === "listener" &&
    typeof candidate.programId === "string" &&
    typeof candidate.streamId === "string" &&
    typeof candidate.connectionId === "string"
  ) {
    if (identity !== listenerIdentity(candidate.connectionId)) {
      logIdentityMismatch(eventName, identity);
      return null;
    }
    return candidate as unknown as ListenerParticipantMetadata;
  }

  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "livekit_webhook_metadata_unrecognized",
      event: eventName
    })
  );
  return null;
}

// Defense-in-depth: `identity` is derived from the token's signed `sub`
// claim and (per LiveKit's `canUpdateOwnMetadata` grant, left unset for both
// roles in tokens.ts) `metadata` should never diverge from what was minted --
// but if that assumption is ever wrong (a future grant change, a LiveKit
// server bug), this cross-check stops a participant whose claimed role/id in
// metadata doesn't match its actual signed identity from being trusted.
function logIdentityMismatch(eventName: string, identity: string | undefined): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "livekit_webhook_identity_metadata_mismatch",
      event: eventName,
      identity
    })
  );
}
