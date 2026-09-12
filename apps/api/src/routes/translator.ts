import {
  requireTranslatorSession,
  clearTranslatorSessionCookie,
  translatorSessionCookie
} from "../auth/translatorAuth";
import {
  PublisherOwnershipError,
  PublisherReservationNotFoundError,
  RealtimeStreamRepository,
  StreamAlreadyPublishedError
} from "../db/realtimeStreamRepository";
import { ProgramNotFoundError, ProgramRepository } from "../db/programRepository";
import { parseEmail } from "../domain/programs";
import {
  TranslatorRepository,
  TranslatorStreamAssignmentNotFoundError
} from "../db/translatorRepository";
import type { Env } from "../env";
import { json, readJson } from "../http";
import { reportAudioActivity } from "../presence/status";
import {
  CloudflareRealtimeError,
  createCloudflareRealtimeClient,
  type RealtimeResponseTrack,
  type SessionDescription
} from "../realtime/cloudflareRealtime";
import { detachRelay, ensureAndAttachRelay } from "../relay/relayControl";
import { getIceServersForClient } from "../realtime/cloudflareTurn";
import {
  ProgramReferenceMismatchError,
  resolveBrowserProgramReference
} from "./programResolution";

interface TranslatorLoginInput {
  programId?: string;
  programSlug?: string;
  email: string;
  password: string;
}

interface TranslatorRealtimeSessionInput {
  streamId: string;
  reclaim: boolean;
}

interface TranslatorRealtimePublishInput {
  streamId: string;
  publishSessionId: string;
  sessionDescription: SessionDescription;
  track: {
    mid: string;
    trackName: string;
  };
}

interface TranslatorRealtimeStopInput {
  streamId: string;
  publishSessionId: string;
}

// partytracks path: the client creates the SFU session/track itself (via the
// /api/partytracks proxy) and reports the resulting metadata here so the backend
// can reserve the single-publisher slot and mark the stream live.
interface TranslatorRealtimeTrackInput {
  streamId: string;
  sessionId: string;
  trackName: string;
  mid: string;
}

interface TranslatorRealtimeAudioActivityInput {
  streamId: string;
  publishSessionId: string;
  active: boolean;
}

interface TranslatorRealtimeHeartbeatInput {
  streamId: string;
  publishSessionId: string;
}

export async function handleTranslatorRoutes(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext
): Promise<Response | null> {
  const translators = new TranslatorRepository(env.DB);
  const programs = new ProgramRepository(env.DB);

  if (request.method === "POST" && url.pathname === "/api/translator/login") {
    const input = await parseLoginInput(request);
    if (input instanceof Response) {
      return translatorLoginResponse(input);
    }
    if (!input) {
      return translatorLoginResponse(invalidCredentials());
    }

    try {
      const resolvedProgram = await resolveTranslatorLoginProgram(
        programs,
        input
      );
      if (!resolvedProgram) {
        return translatorLoginResponse(programNotFound());
      }

      const translator = await translators.authenticate(
        resolvedProgram.programId,
        input.email,
        input.password,
        env.TRANSLATOR_PASSWORD_PEPPER
      );
      if (!translator) {
        return translatorLoginResponse(invalidCredentials());
      }

      const userAgent = request.headers.get("User-Agent")?.slice(0, 512) ?? null;

      const { token } = await translators.createSession(
        translator.programId,
        translator.id,
        env.TRANSLATOR_SESSION_SECRET,
        userAgent
      );
      const assignedStreams = await translators.listAssignedStreams(
        translator.programId,
        translator.id
      );
      const response = json({
        ok: true,
        translator,
        assignedStreams
      });
      response.headers.set("set-cookie", translatorSessionCookie(token));
      return translatorLoginResponse(response);
    } catch (_error) {
      return translatorLoginResponse(
        json({ error: "database_error" }, { status: 500 })
      );
    }
  }

  if (request.method === "GET" && url.pathname === "/api/translator/session") {
    try {
      const auth = await requireTranslatorSession(request, env, translators);
      if (auth instanceof Response) {
        return translatorSessionResponse(auth);
      }

      return translatorSessionResponse(
        json({
          translator: auth.translator,
          assignedStreams: auth.assignedStreams
        })
      );
    } catch (_error) {
      return translatorSessionResponse(
        json({ error: "database_error" }, { status: 500 })
      );
    }
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/translator/realtime/session"
  ) {
    return handleTranslatorRealtimeSession(request, env, translators);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/translator/realtime/publish"
  ) {
    return handleTranslatorRealtimePublish(request, env, translators, ctx);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/translator/realtime/track"
  ) {
    return handleTranslatorRealtimeTrack(request, env, translators, ctx);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/translator/realtime/stop"
  ) {
    return handleTranslatorRealtimeStop(request, env, translators, ctx);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/translator/realtime/audio-activity"
  ) {
    return handleTranslatorRealtimeAudioActivity(request, env, translators);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/translator/realtime/heartbeat"
  ) {
    return handleTranslatorRealtimeHeartbeat(request, env, translators);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/translator/logout"
  ) {
    return handleTranslatorLogout(request, env, translators, ctx);
  }

  return null;
}

async function handleTranslatorLogout(
  request: Request,
  env: Env,
  translators: TranslatorRepository,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const auth = await requireTranslatorSession(request, env, translators);
    if (auth instanceof Response) {
      return translatorSessionResponse(auth);
    }

    const realtime = new RealtimeStreamRepository(env.DB);
    const freed = await translators.revokeSession(
      realtime,
      auth.translator.programId,
      auth.translator.id,
      auth.session.id
    );

    if (freed?.cloudflareSessionId) {
      ctx.waitUntil(
        detachRelay({
          env,
          request,
          programId: auth.translator.programId,
          streamId: freed.streamId,
          sessionId: freed.cloudflareSessionId
        })
      );
    }

    const response = json({ ok: true });
    response.headers.set("set-cookie", clearTranslatorSessionCookie());
    return translatorSessionResponse(response);
  } catch (_error) {
    return translatorSessionResponse(
      json({ error: "database_error" }, { status: 500 })
    );
  }
}

async function handleTranslatorRealtimeHeartbeat(
  request: Request,
  env: Env,
  translators: TranslatorRepository
): Promise<Response> {
  const input = await parseRealtimeHeartbeatInput(request);
  if (input instanceof Response) {
    return translatorRealtimeResponse(input);
  }

  const realtime = new RealtimeStreamRepository(env.DB);
  try {
    const auth = await requireTranslatorSession(request, env, translators);
    if (auth instanceof Response) {
      return translatorRealtimeResponse(auth);
    }

    // Layered security mirrors the audio-activity path: valid translator
    // session, assigned stream, and an owned reservation for this stream.
    await translators.requireAssignedStream(
      auth.translator.programId,
      auth.translator.id,
      input.streamId
    );

    // Confirm ownership (throws 404-mapped errors when the publish session is
    // unknown or belongs to another translator/stream) before the heartbeat.
    await realtime.requirePublisherReservation({
      publishSessionId: input.publishSessionId,
      translatorId: auth.translator.id,
      streamId: input.streamId
    });

    const refreshed = await realtime.touchPublisher({
      publishSessionId: input.publishSessionId,
      translatorId: auth.translator.id,
      streamId: input.streamId,
      absoluteExpiresAt: auth.session.absoluteExpiresAt
    });

    if (!refreshed) {
      // The publisher is no longer in the published state; tell the client to
      // stop heart-beating rather than retry indefinitely.
      return translatorRealtimeResponse(
        json({ error: "publisher_not_active" }, { status: 409 })
      );
    }

    return translatorRealtimeResponse(json({ ok: true }));
  } catch (error) {
    return translatorRealtimeResponse(translatorRealtimeErrorResponse(error));
  }
}

async function handleTranslatorRealtimeAudioActivity(
  request: Request,
  env: Env,
  translators: TranslatorRepository
): Promise<Response> {
  const input = await parseRealtimeAudioActivityInput(request);
  if (input instanceof Response) {
    return translatorRealtimeResponse(input);
  }

  const realtime = new RealtimeStreamRepository(env.DB);
  try {
    const auth = await requireTranslatorSession(request, env, translators);
    if (auth instanceof Response) {
      return translatorRealtimeResponse(auth);
    }

    // Layered security: valid translator session, assigned stream, and an owned
    // active published reservation matching the publishSessionId.
    await translators.requireAssignedStream(
      auth.translator.programId,
      auth.translator.id,
      input.streamId
    );

    const reservation = await realtime.requirePublisherReservation({
      publishSessionId: input.publishSessionId,
      translatorId: auth.translator.id,
      streamId: input.streamId
    });
    if (reservation.state !== "published") {
      throw new PublisherReservationNotFoundError();
    }

    await reportAudioActivity(env, auth.translator.programId, {
      streamId: input.streamId,
      publishSessionId: input.publishSessionId,
      active: input.active
    });

    return translatorRealtimeResponse(
      json({ ok: true, state: input.active ? "live" : "silent" })
    );
  } catch (error) {
    return translatorRealtimeResponse(translatorRealtimeErrorResponse(error));
  }
}

async function handleTranslatorRealtimeSession(
  request: Request,
  env: Env,
  translators: TranslatorRepository
): Promise<Response> {
  const input = await parseRealtimeSessionInput(request);
  if (input instanceof Response) {
    return translatorRealtimeResponse(input);
  }

  const realtime = new RealtimeStreamRepository(env.DB);
  try {
    const auth = await requireTranslatorSession(request, env, translators);
    if (auth instanceof Response) {
      return translatorRealtimeResponse(auth);
    }

    await translators.requireAssignedStream(
      auth.translator.programId,
      auth.translator.id,
      input.streamId
    );

    const client = createCloudflareRealtimeClient(
      env,
      env.REALTIME_FETCH ?? fetch
    );
    const reservation = await reservePublisherForTranslator({
      realtime,
      client,
      programId: auth.translator.programId,
      streamId: input.streamId,
      translatorId: auth.translator.id,
      sessionId: auth.session.id,
      reclaim: input.reclaim
    });

    let realtimeSession;
    try {
      realtimeSession = await client.createSession();
      if (!isNonEmptyString(realtimeSession.sessionId)) {
        throw new CloudflareRealtimeError();
      }
    } catch (error) {
      if (error instanceof CloudflareRealtimeError) {
        await realtime.markPublisherFailed({
          publishSessionId: reservation.id,
          translatorId: auth.translator.id,
          streamId: input.streamId
        });
        return translatorRealtimeResponse(realtimeError());
      }
      throw error;
    }

    try {
      await realtime.attachPublisherSession({
        publishSessionId: reservation.id,
        translatorId: auth.translator.id,
        streamId: input.streamId,
        cloudflareSessionId: realtimeSession.sessionId
      });
    } catch (_error) {
      await realtime.markPublisherFailed({
        publishSessionId: reservation.id,
        translatorId: auth.translator.id,
        streamId: input.streamId
      });
      return translatorRealtimeResponse(realtimeError());
    }

    const { iceServers } = await getIceServersForClient(env, {
      role: "translator",
      programId: auth.translator.programId,
      streamId: input.streamId,
      connectionId: reservation.id
    });

    return translatorRealtimeResponse(
      json({
        publishSessionId: reservation.id,
        streamId: input.streamId,
        iceServers
      })
    );
  } catch (error) {
    return translatorRealtimeResponse(translatorRealtimeErrorResponse(error));
  }
}

async function reservePublisherForTranslator(input: {
  realtime: RealtimeStreamRepository;
  client: ReturnType<typeof createCloudflareRealtimeClient>;
  programId: string;
  streamId: string;
  translatorId: string;
  sessionId: string;
  reclaim: boolean;
}) {
  try {
    return await input.realtime.reservePublisher({
      programId: input.programId,
      streamId: input.streamId,
      translatorId: input.translatorId,
      sessionId: input.sessionId
    });
  } catch (error) {
    if (!(error instanceof StreamAlreadyPublishedError) || !input.reclaim) {
      throw error;
    }

    const blocking = await input.realtime.getBlockingPublisher(
      input.programId,
      input.streamId
    );
    if (!blocking || blocking.translatorId !== input.translatorId) {
      throw error;
    }

    await closeOwnedPublisherForReclaim({
      realtime: input.realtime,
      client: input.client,
      publisher: blocking
    });

    return input.realtime.reservePublisher({
      programId: input.programId,
      streamId: input.streamId,
      translatorId: input.translatorId,
      sessionId: input.sessionId
    });
  }
}

// closeTracks on a just-dropped SFU session can hang ~20s — it waits for a
// renegotiation/ack from a transport that no longer exists. Bound it: on timeout
// treat the close as best-effort and proceed. Cloudflare GCs the stale track
// (~30s) and the publisher TTL frees the slot regardless, so blocking the
// republish/stop on a dead session's close only hurts recovery latency.
const CLOSE_TRACKS_TIMEOUT_MS = 2_000;

class CloseTracksTimeoutError extends Error {}

function withCloseTracksTimeout<T>(
  promise: Promise<T>,
  timeoutMs = CLOSE_TRACKS_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new CloseTracksTimeoutError()),
      timeoutMs
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function closeOwnedPublisherForReclaim(input: {
  realtime: RealtimeStreamRepository;
  client: ReturnType<typeof createCloudflareRealtimeClient>;
  publisher: {
    id: string;
    translatorId: string;
    streamId: string;
    cloudflareSessionId: string | null;
    publishedTrackMid: string | null;
  };
}): Promise<void> {
  const { publisher } = input;
  if (publisher.cloudflareSessionId && publisher.publishedTrackMid) {
    try {
      await withCloseTracksTimeout(
        input.client.closeTracks(
          publisher.cloudflareSessionId,
          [{ mid: publisher.publishedTrackMid }],
          true
        )
      );
    } catch (error) {
      if (
        !(error instanceof CloseTracksTimeoutError) &&
        !isIgnorablePublisherCleanupError(error) &&
        !isMissingRealtimePublisherError(error)
      ) {
        throw error;
      }
    }
  }

  await input.realtime.clearPublisher({
    publishSessionId: publisher.id,
    translatorId: publisher.translatorId,
    streamId: publisher.streamId,
    cleanupFailed: false
  });
}

// partytracks reclaim: free our own stale publisher slot WITHOUT an SFU
// closeTracks. partytracks owns the SFU session lifecycle (it tears the prior
// session down on re-push), so the backend only clears the D1 reservation. This
// also avoids the ~20s closeTracks hang on a just-dropped session.
async function reservePublisherForPartytracks(input: {
  realtime: RealtimeStreamRepository;
  programId: string;
  streamId: string;
  translatorId: string;
  sessionId: string;
}) {
  try {
    return await input.realtime.reservePublisher({
      programId: input.programId,
      streamId: input.streamId,
      translatorId: input.translatorId,
      sessionId: input.sessionId
    });
  } catch (error) {
    if (!(error instanceof StreamAlreadyPublishedError)) {
      throw error;
    }

    const blocking = await input.realtime.getBlockingPublisher(
      input.programId,
      input.streamId
    );
    if (!blocking || blocking.translatorId !== input.translatorId) {
      throw error;
    }

    await input.realtime.clearPublisher({
      publishSessionId: blocking.id,
      translatorId: blocking.translatorId,
      streamId: blocking.streamId,
      cleanupFailed: false
    });

    return input.realtime.reservePublisher({
      programId: input.programId,
      streamId: input.streamId,
      translatorId: input.translatorId,
      sessionId: input.sessionId
    });
  }
}

// partytracks publish: the client already created the SFU session + track via the
// proxy and now reports {sessionId, trackName, mid}. We reserve a fresh publisher
// slot (a new publishSessionId so the public `publisherVersion` bumps and listeners
// re-pull on reconnect), record the session, and mark the stream live. No SFU calls.
async function handleTranslatorRealtimeTrack(
  request: Request,
  env: Env,
  translators: TranslatorRepository,
  ctx: ExecutionContext
): Promise<Response> {
  const input = await parseRealtimeTrackInput(request);
  if (input instanceof Response) {
    return translatorRealtimeResponse(input);
  }

  const realtime = new RealtimeStreamRepository(env.DB);
  try {
    const auth = await requireTranslatorSession(request, env, translators);
    if (auth instanceof Response) {
      return translatorRealtimeResponse(auth);
    }

    await translators.requireAssignedStream(
      auth.translator.programId,
      auth.translator.id,
      input.streamId
    );

    const reservation = await reservePublisherForPartytracks({
      realtime,
      programId: auth.translator.programId,
      streamId: input.streamId,
      translatorId: auth.translator.id,
      sessionId: auth.session.id
    });

    await realtime.attachPublisherSession({
      publishSessionId: reservation.id,
      translatorId: auth.translator.id,
      streamId: input.streamId,
      cloudflareSessionId: input.sessionId
    });

    await realtime.markPublisherTrackLive({
      publishSessionId: reservation.id,
      translatorId: auth.translator.id,
      streamId: input.streamId,
      trackName: input.trackName,
      trackMid: input.mid,
      expiresAt: auth.session.absoluteExpiresAt
    });
    ctx.waitUntil(
      ensureAndAttachRelay({
        env,
        request,
        programId: auth.translator.programId,
        streamId: input.streamId,
        sessionId: input.sessionId,
        trackName: input.trackName
      })
    );

    return translatorRealtimeResponse(
      json({ publishSessionId: reservation.id, streamId: input.streamId })
    );
  } catch (error) {
    return translatorRealtimeResponse(translatorRealtimeErrorResponse(error));
  }
}

async function handleTranslatorRealtimePublish(
  request: Request,
  env: Env,
  translators: TranslatorRepository,
  ctx: ExecutionContext
): Promise<Response> {
  const input = await parseRealtimePublishInput(request);
  if (input instanceof Response) {
    return translatorRealtimeResponse(input);
  }

  const realtime = new RealtimeStreamRepository(env.DB);
  try {
    const auth = await requireTranslatorSession(request, env, translators);
    if (auth instanceof Response) {
      return translatorRealtimeResponse(auth);
    }

    await translators.requireAssignedStream(
      auth.translator.programId,
      auth.translator.id,
      input.streamId
    );

    const reservation = await realtime.requirePublisherReservation({
      publishSessionId: input.publishSessionId,
      translatorId: auth.translator.id,
      streamId: input.streamId
    });
    if (
      reservation.state !== "reserved" ||
      !reservation.cloudflareSessionId
    ) {
      throw new PublisherReservationNotFoundError();
    }

    const client = createCloudflareRealtimeClient(
      env,
      env.REALTIME_FETCH ?? fetch
    );

    try {
      const publish = await client.addTracks(reservation.cloudflareSessionId, {
        sessionDescription: input.sessionDescription,
        tracks: [
          {
            location: "local",
            kind: "audio",
            mid: input.track.mid,
            trackName: input.track.trackName
          }
        ]
      });
      const publishedTrack = publish.tracks?.[0];
      const trackName =
        readResponseTrackString(publishedTrack, "trackName") ??
        input.track.trackName;
      const trackMid =
        readResponseTrackString(publishedTrack, "mid") ?? input.track.mid;

      try {
        if (!isSessionDescription(publish.sessionDescription)) {
          throw new CloudflareRealtimeError();
        }

        await realtime.markPublisherTrackLive({
          publishSessionId: input.publishSessionId,
          translatorId: auth.translator.id,
          streamId: input.streamId,
          trackName,
          trackMid,
          expiresAt: auth.session.absoluteExpiresAt
        });
        ctx.waitUntil(
          ensureAndAttachRelay({
            env,
            request,
            programId: auth.translator.programId,
            streamId: input.streamId,
            sessionId: reservation.cloudflareSessionId,
            trackName
          })
        );
      } catch (_error) {
        let cleanupFailed = false;
        try {
          await client.closeTracks(
            reservation.cloudflareSessionId,
            [{ mid: trackMid }],
            true
          );
        } catch (cleanupError) {
          cleanupFailed = !isIgnorablePublisherCleanupError(cleanupError);
        }

        if (cleanupFailed) {
          await realtime.markPublisherCleanupFailed({
            publishSessionId: input.publishSessionId,
            translatorId: auth.translator.id,
            streamId: input.streamId,
            trackName,
            trackMid
          });
        } else {
          await realtime.markPublisherFailed({
            publishSessionId: input.publishSessionId,
            translatorId: auth.translator.id,
            streamId: input.streamId
          });
        }
        return translatorRealtimeResponse(realtimeError());
      }

      return translatorRealtimeResponse(
        json({
          streamId: input.streamId,
          publishSessionId: input.publishSessionId,
          publishedTrack: {
            trackName,
            mid: trackMid
          },
          sessionDescription: publish.sessionDescription,
          requiresImmediateRenegotiation:
            publish.requiresImmediateRenegotiation === true
        })
      );
    } catch (error) {
      if (error instanceof CloudflareRealtimeError) {
        await realtime.markPublisherFailed({
          publishSessionId: input.publishSessionId,
          translatorId: auth.translator.id,
          streamId: input.streamId
        });
        return translatorRealtimeResponse(realtimeError());
      }
      throw error;
    }
  } catch (error) {
    return translatorRealtimeResponse(translatorRealtimeErrorResponse(error));
  }
}

async function handleTranslatorRealtimeStop(
  request: Request,
  env: Env,
  translators: TranslatorRepository,
  ctx: ExecutionContext
): Promise<Response> {
  const input = await parseRealtimeStopInput(request);
  if (input instanceof Response) {
    return translatorRealtimeResponse(input);
  }

  const realtime = new RealtimeStreamRepository(env.DB);
  try {
    const auth = await requireTranslatorSession(request, env, translators);
    if (auth instanceof Response) {
      return translatorRealtimeResponse(auth);
    }

    await translators.requireAssignedStream(
      auth.translator.programId,
      auth.translator.id,
      input.streamId
    );

    const reservation = await realtime.requirePublisherReservation({
      publishSessionId: input.publishSessionId,
      translatorId: auth.translator.id,
      streamId: input.streamId
    });

    let cleanupFailed = false;
    if (reservation.cloudflareSessionId && reservation.publishedTrackMid) {
      const client = createCloudflareRealtimeClient(
        env,
        env.REALTIME_FETCH ?? fetch
      );
      try {
        await withCloseTracksTimeout(
          client.closeTracks(
            reservation.cloudflareSessionId,
            [{ mid: reservation.publishedTrackMid }],
            true
          )
        );
      } catch (error) {
        // A timeout is best-effort: free the slot now and let Cloudflare GC the
        // stale track. Only a genuine, non-ignorable provider error is a failure.
        cleanupFailed =
          !(error instanceof CloseTracksTimeoutError) &&
          !isIgnorablePublisherCleanupError(error);
      }
    }

    await realtime.clearPublisher({
      publishSessionId: input.publishSessionId,
      translatorId: auth.translator.id,
      streamId: input.streamId,
      cleanupFailed
    });
    if (reservation.cloudflareSessionId) {
      ctx.waitUntil(
        detachRelay({
          env,
          request,
          programId: auth.translator.programId,
          streamId: input.streamId,
          sessionId: reservation.cloudflareSessionId
        })
      );
    }

    return translatorRealtimeResponse(
      json({ ok: true, cleanup: cleanupFailed ? "failed" : "closed" })
    );
  } catch (error) {
    return translatorRealtimeResponse(translatorRealtimeErrorResponse(error));
  }
}

async function parseLoginInput(
  request: Request
): Promise<TranslatorLoginInput | Response | null> {
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (_error) {
    return json({ error: "invalid_json" }, { status: 400 });
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const programId = readTrimmedString(body, "programId");
  const programSlug = readTrimmedString(body, "programSlug");
  const email = readLoginEmail(body);
  const password = readPassword(body);
  if ((!programId && !programSlug) || !email || !password) {
    return null;
  }

  return {
    ...(programId ? { programId } : {}),
    ...(programSlug ? { programSlug } : {}),
    email,
    password
  };
}

// Login normalizes the email through the same parseEmail used at create time so
// casing/trimming can never diverge. A malformed email is not a 400 on login;
// it simply falls through to invalid_translator_credentials.
function readLoginEmail(body: object): string | null {
  const value = (body as Record<string, unknown>).email;
  try {
    return parseEmail(value);
  } catch (_error) {
    return null;
  }
}

async function resolveTranslatorLoginProgram(
  programs: ProgramRepository,
  input: TranslatorLoginInput
): Promise<{ programId: string } | null> {
  try {
    return await resolveBrowserProgramReference(programs, input);
  } catch (error) {
    if (
      error instanceof ProgramNotFoundError ||
      error instanceof ProgramReferenceMismatchError
    ) {
      return null;
    }
    throw error;
  }
}

async function parseRealtimeSessionInput(
  request: Request
): Promise<TranslatorRealtimeSessionInput | Response> {
  const body = await readRequestObject(request);
  if (body instanceof Response) {
    return body;
  }

  const streamId = readTrimmedString(body, "streamId");
  if (!streamId) {
    return invalidRealtimeRequest();
  }

  return { streamId, reclaim: body.reclaim === true };
}

async function parseRealtimePublishInput(
  request: Request
): Promise<TranslatorRealtimePublishInput | Response> {
  const body = await readRequestObject(request);
  if (body instanceof Response) {
    return body;
  }

  const streamId = readTrimmedString(body, "streamId");
  const publishSessionId = readTrimmedString(body, "publishSessionId");
  const sessionDescription = readSessionDescription(body);
  const track = readPublishTrack(body);
  if (!streamId || !publishSessionId || !sessionDescription || !track) {
    return invalidRealtimeRequest();
  }

  return { streamId, publishSessionId, sessionDescription, track };
}

async function parseRealtimeStopInput(
  request: Request
): Promise<TranslatorRealtimeStopInput | Response> {
  const body = await readRequestObject(request);
  if (body instanceof Response) {
    return body;
  }

  const streamId = readTrimmedString(body, "streamId");
  const publishSessionId = readTrimmedString(body, "publishSessionId");
  if (!streamId || !publishSessionId) {
    return invalidRealtimeRequest();
  }

  return { streamId, publishSessionId };
}

async function parseRealtimeTrackInput(
  request: Request
): Promise<TranslatorRealtimeTrackInput | Response> {
  const body = await readRequestObject(request);
  if (body instanceof Response) {
    return body;
  }

  const streamId = readTrimmedString(body, "streamId");
  const sessionId = readTrimmedString(body, "sessionId");
  const trackName = readTrimmedString(body, "trackName");
  const mid = readTrimmedString(body, "mid");
  if (!streamId || !sessionId || !trackName || !mid) {
    return invalidRealtimeRequest();
  }

  return { streamId, sessionId, trackName, mid };
}

async function parseRealtimeAudioActivityInput(
  request: Request
): Promise<TranslatorRealtimeAudioActivityInput | Response> {
  const body = await readRequestObject(request);
  if (body instanceof Response) {
    return body;
  }

  const streamId = readTrimmedString(body, "streamId");
  const publishSessionId = readTrimmedString(body, "publishSessionId");
  const active = body.active;
  if (!streamId || !publishSessionId || typeof active !== "boolean") {
    return invalidRealtimeRequest();
  }

  return { streamId, publishSessionId, active };
}

async function parseRealtimeHeartbeatInput(
  request: Request
): Promise<TranslatorRealtimeHeartbeatInput | Response> {
  const body = await readRequestObject(request);
  if (body instanceof Response) {
    return body;
  }

  const streamId = readTrimmedString(body, "streamId");
  const publishSessionId = readTrimmedString(body, "publishSessionId");
  if (!streamId || !publishSessionId) {
    return invalidRealtimeRequest();
  }

  return { streamId, publishSessionId };
}

async function readRequestObject(
  request: Request
): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (_error) {
    return json({ error: "invalid_json" }, { status: 400 });
  }

  if (!isRecord(body)) {
    return invalidRealtimeRequest();
  }

  return body;
}

function readTrimmedString(body: object, key: string): string | null {
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readSessionDescription(body: object): SessionDescription | null {
  const value = (body as Record<string, unknown>).sessionDescription;
  if (!isRecord(value)) {
    return null;
  }

  const { type, sdp } = value;
  if (
    (type !== "offer" && type !== "answer") ||
    typeof sdp !== "string" ||
    sdp.length === 0
  ) {
    return null;
  }

  return { type, sdp };
}

function readPublishTrack(
  body: object
): TranslatorRealtimePublishInput["track"] | null {
  const value = (body as Record<string, unknown>).track;
  if (!isRecord(value)) {
    return null;
  }

  const mid = readTrimmedString(value, "mid");
  const trackName = readTrimmedString(value, "trackName");
  if (!mid || !trackName) {
    return null;
  }

  return { mid, trackName };
}

function readPassword(body: object): string | null {
  const value = (body as Record<string, unknown>).password;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readResponseTrackString(
  track: RealtimeResponseTrack | undefined,
  key: "trackName" | "mid"
): string | null {
  if (!track) {
    return null;
  }

  const value = track[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionDescription(
  value: unknown
): value is SessionDescription {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.type === "offer" || value.type === "answer") &&
    typeof value.sdp === "string" &&
    value.sdp.length > 0
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAlreadyClosedRealtimeTrackError(error: unknown): boolean {
  if (!(error instanceof CloudflareRealtimeError)) {
    return false;
  }

  const errorCodes = [
    error.errorCode,
    ...(error.trackErrors ?? []).map((trackError) => trackError.errorCode)
  ].filter((code): code is string => typeof code === "string");

  return errorCodes.some(isAlreadyClosedRealtimeTrackCode);
}

function isIgnorablePublisherCleanupError(error: unknown): boolean {
  return (
    isAlreadyClosedRealtimeTrackError(error) ||
    isDisconnectedRealtimeSessionError(error) ||
    isAlreadyClosedRealtimeSessionError(error)
  );
}

function isMissingRealtimePublisherError(error: unknown): boolean {
  // During reclaim, a 404 (or 410 Gone) means the stale SFU publisher is
  // already gone, so closing its track is a no-op we can safely ignore.
  return (
    error instanceof CloudflareRealtimeError &&
    (error.status === 404 || error.status === 410)
  );
}

function isAlreadyClosedRealtimeSessionError(error: unknown): boolean {
  // A fully-gone SFU session can surface a session-not-found / session-closed
  // code under any HTTP status (not only 404 or 410+session_error). Treat the
  // close as already-done whenever the normalized code names a missing or
  // closed session, regardless of status.
  if (!(error instanceof CloudflareRealtimeError)) {
    return false;
  }

  return SESSION_ALREADY_CLOSED_ERROR_CODES.has(
    normalizeRealtimeErrorCode(error.errorCode)
  );
}

function isDisconnectedRealtimeSessionError(error: unknown): boolean {
  return (
    error instanceof CloudflareRealtimeError &&
    error.status === 410 &&
    normalizeRealtimeErrorCode(error.errorCode) === "session_error"
  );
}

function isAlreadyClosedRealtimeTrackCode(code: string): boolean {
  return TRACK_ALREADY_CLOSED_ERROR_CODES.has(normalizeRealtimeErrorCode(code));
}

function normalizeRealtimeErrorCode(code: string | undefined): string {
  return (code ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const TRACK_ALREADY_CLOSED_ERROR_CODES = new Set([
  "not_found_track_error",
  "notfoundtrackerror",
  "track_not_found",
  "track_notfound",
  "tracknotfound",
  "track_already_closed",
  "track_alreadyclosed",
  "trackalreadyclosed",
  "track_closed",
  "trackclosed"
]);

const SESSION_ALREADY_CLOSED_ERROR_CODES = new Set([
  "not_found_session_error",
  "notfoundsessionerror",
  "session_not_found",
  "session_notfound",
  "sessionnotfound",
  "session_already_closed",
  "session_alreadyclosed",
  "sessionalreadyclosed",
  "session_closed",
  "sessionclosed"
]);

function invalidCredentials(): Response {
  return json({ error: "invalid_translator_credentials" }, { status: 401 });
}

function programNotFound(): Response {
  return json({ error: "program_not_found" }, { status: 404 });
}

function invalidRealtimeRequest(): Response {
  return json({ error: "invalid_request" }, { status: 400 });
}

function realtimeError(): Response {
  return json({ error: "realtime_error" }, { status: 502 });
}

function translatorRealtimeErrorResponse(error: unknown): Response {
  if (error instanceof TranslatorStreamAssignmentNotFoundError) {
    return json({ error: "stream_not_assigned" }, { status: 403 });
  }

  if (error instanceof StreamAlreadyPublishedError) {
    return json({ error: "stream_already_published" }, { status: 409 });
  }

  if (error instanceof CloudflareRealtimeError) {
    return realtimeError();
  }

  if (
    error instanceof PublisherReservationNotFoundError ||
    error instanceof PublisherOwnershipError
  ) {
    return json({ error: "publisher_session_not_found" }, { status: 404 });
  }

  return json({ error: "database_error" }, { status: 500 });
}

function translatorLoginResponse(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

function translatorSessionResponse(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  response.headers.set("vary", "Cookie");
  return response;
}

function translatorRealtimeResponse(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  response.headers.set("vary", "Cookie");
  return response;
}
