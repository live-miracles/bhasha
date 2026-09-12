import {
  buildRequestedConnectionRecord,
  ListenerConnectionNotFoundError,
  ListenerInvalidStateError,
  ListenerProgramNotFoundError,
  ListenerReplacementSuccessorExistsError,
  ListenerRepository,
  ListenerStreamNotFoundError,
  type ListenerClientHints,
} from "../db/listenerRepository";
import {
  ListenerAccessRepository,
  ListenerNotApprovedError,
  requireListenerApproval,
} from "../db/listenerAccessRepository";
import {
  ProgramNotFoundError,
  ProgramRepository,
  type ProgramRecord,
} from "../db/programRepository";
import {
  RealtimeStreamRepository,
  StreamNotLiveError,
} from "../db/realtimeStreamRepository";
import type { Env } from "../env";
import { json, readJson } from "../http";
import { enqueueConnectionEvent } from "../queue/connectionEvents";
import {
  CloudflareRealtimeError,
  createCloudflareRealtimeClient,
  type RealtimeResponseTrack,
  type SessionDescription,
} from "../realtime/cloudflareRealtime";
import { getIceServersForClient } from "../realtime/cloudflareTurn";
import {
  ProgramReferenceMismatchError,
  resolveBrowserProgramReference,
  type BrowserProgramReference,
} from "./programResolution";

interface CreateConnectionInput extends BrowserProgramReference {
  streamId: string;
  clientId: string;
  accessToken?: string;
}

interface ResolvedCreateConnectionInput {
  programId: string;
  streamId: string;
  clientId: string;
  program: ProgramRecord;
  accessToken?: string;
}

interface SwitchConnectionInput extends CreateConnectionInput {
  fromConnectionId: string;
}

interface ReconnectConnectionInput extends CreateConnectionInput {
  reconnectOfConnectionId: string;
}

interface ReplacementConnectionInput extends ResolvedCreateConnectionInput {
  previousConnectionId: string;
}

interface ConnectionIdInput {
  connectionId: string;
}

interface SubscribeSessionInput extends CreateConnectionInput {
  connectionId?: string;
  sessionDescription: SessionDescription;
}

interface ResolvedSubscribeSessionInput extends ResolvedCreateConnectionInput {
  connectionId?: string;
  sessionDescription: SessionDescription;
}

type SubscribeTrackInput = ConnectionIdInput;

interface SubscribeRenegotiateInput extends ConnectionIdInput {
  sessionDescription: SessionDescription;
}

interface LeaveInput extends ConnectionIdInput {
  reason: string;
}

interface AccessClaimInput {
  programSlug: string;
  clientId: string;
}

type AccessStatusInput =
  | {
      proof: "claim";
      programSlug: string;
      claimId: string;
      claimSecret: string;
    }
  | {
      proof: "token";
      programSlug: string;
      accessToken: string;
    };

export async function handleListenerRoutes(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const listeners = new ListenerRepository(env.DB);
  const listenerAccess = new ListenerAccessRepository(env.DB);
  const programs = new ProgramRepository(env.DB);
  const streams = new RealtimeStreamRepository(env.DB);

  if (
    request.method === "POST" &&
    url.pathname === "/api/listeners/access/claim"
  ) {
    const input = await parseBody(request, parseAccessClaimInput);
    if (input instanceof Response) {
      return noStore(input);
    }
    return createAccessClaim(programs, listenerAccess, input);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/listeners/access/status"
  ) {
    const input = await parseBody(request, parseAccessStatusInput);
    if (input instanceof Response) {
      return noStore(input);
    }
    return getAccessStatus(programs, listenerAccess, input);
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/listeners/ice-servers"
  ) {
    return getListenerIceServers(env, programs, url);
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/listeners/active-publisher"
  ) {
    return getActivePublisherMetadata(request, programs, streams, env, url);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/listeners/subscribe/session"
  ) {
    const input = await parseBody(request, parseSubscribeSessionInput);
    if (input instanceof Response) {
      return input;
    }

    const resolved = await resolveCreateConnectionInput(programs, input);
    if (resolved instanceof Response) {
      return resolved;
    }

    return createSubscribeSession(request, env, listeners, streams, {
      ...input,
      ...resolved,
    });
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/listeners/subscribe/track"
  ) {
    const input = await parseBody(request, parseSubscribeTrackInput);
    if (input instanceof Response) {
      return input;
    }

    return subscribeTrack(env, listeners, streams, input);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/listeners/subscribe/renegotiate"
  ) {
    const input = await parseBody(request, parseSubscribeRenegotiateInput);
    if (input instanceof Response) {
      return input;
    }

    return renegotiateSubscribe(env, listeners, input);
  }

  if (request.method === "POST" && url.pathname === "/api/listeners/request") {
    const input = await parseBody(request, parseCreateConnectionInput);
    if (input instanceof Response) {
      return input;
    }

    const resolved = await resolveCreateConnectionInput(programs, input);
    if (resolved instanceof Response) {
      return resolved;
    }

    try {
      if (resolved.program.accessControlEnabled) {
        await requireListenerApproval(
          env.DB,
          resolved.programId,
          resolved.accessToken,
        );
      }
      const createInput = {
        programId: resolved.programId,
        streamId: resolved.streamId,
        clientId: resolved.clientId,
        ...listenerClientMetadata(request),
      };
      if (listenerWriteBehindEnabled(env)) {
        await listeners.validateRequestedConnection(createInput);
        const connection = buildRequestedConnectionRecord(createInput);
        await enqueueConnectionEvent(env, {
          kind: "requested",
          connection,
        });
        notifyListenerPresenceBestEffort(
          ctx,
          env,
          resolved.programId,
          "/join",
          {
            connectionId: connection.id,
            streamId: resolved.streamId,
          },
        );
        return json({ connectionId: connection.id }, { status: 201 });
      }

      const connection = await listeners.createRequestedConnection(createInput);
      notifyListenerPresenceBestEffort(ctx, env, resolved.programId, "/join", {
        connectionId: connection.id,
        streamId: resolved.streamId,
      });
      return json({ connectionId: connection.id }, { status: 201 });
    } catch (error) {
      return listenerErrorResponse(error);
    }
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/listeners/connected"
  ) {
    const input = await parseBody(request, parseConnectionIdInput);
    if (input instanceof Response) {
      return input;
    }

    try {
      if (listenerWriteBehindEnabled(env)) {
        await enqueueConnectionEvent(env, {
          kind: "connected",
          connectionId: input.connectionId,
          clientHints: listenerClientHints(request.headers),
        });
        return json({ ok: true });
      }

      const { connection } = await listeners.markConnected(
        input.connectionId,
        listenerClientHints(request.headers),
      );
      return json({ ok: true });
    } catch (error) {
      return listenerErrorResponse(error);
    }
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/listeners/heartbeat"
  ) {
    const input = await parseBody(request, parseHeartbeatInput);
    if (input instanceof Response) {
      return input;
    }

    try {
      const heartbeatTarget = await listeners.recordHeartbeat(
        input.connectionId,
        listenerClientHints(request.headers),
        listenerWriteBehindEnabled(env),
      );
      notifyListenerPresenceBestEffort(
        ctx,
        env,
        heartbeatTarget.programId,
        "/heartbeat",
        {
          connectionId: input.connectionId,
          streamId: heartbeatTarget.streamId,
        },
      );
      return json({ ok: true });
    } catch (error) {
      return listenerErrorResponse(error);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/listeners/leave") {
    const input = await parseBody(request, parseLeaveInput);
    if (input instanceof Response) {
      return input;
    }

    try {
      const { connection } = await listeners.disconnectConnection(
        input.connectionId,
        input.reason,
      );
      notifyListenerPresenceBestEffort(
        ctx,
        env,
        connection.programId,
        "/leave",
        {
          connectionId: connection.id,
        },
      );
      await cleanupListenerRealtimeBestEffort(env, listeners, connection.id);
      return json({ ok: true });
    } catch (error) {
      return listenerErrorResponse(error);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/listeners/switch") {
    const input = await parseBody(request, parseSwitchConnectionInput);
    if (input instanceof Response) {
      return input;
    }

    const resolved = await resolveCreateConnectionInput(programs, input);
    if (resolved instanceof Response) {
      return resolved;
    }

    return replaceConnection(request, ctx, env, listeners, "language_switch", {
      ...resolved,
      previousConnectionId: input.fromConnectionId,
    });
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/listeners/reconnect"
  ) {
    const input = await parseBody(request, parseReconnectConnectionInput);
    if (input instanceof Response) {
      return input;
    }

    const resolved = await resolveCreateConnectionInput(programs, input);
    if (resolved instanceof Response) {
      return resolved;
    }

    return replaceConnection(request, ctx, env, listeners, "reconnected", {
      ...resolved,
      previousConnectionId: input.reconnectOfConnectionId,
    });
  }

  return null;
}

async function createAccessClaim(
  programs: ProgramRepository,
  listenerAccess: ListenerAccessRepository,
  input: AccessClaimInput,
): Promise<Response> {
  try {
    const program = await programs.getProgramBySlug(input.programSlug);
    if (!program) {
      throw new ProgramNotFoundError();
    }
    const claim = await listenerAccess.createClaim(program.id, input.clientId);
    return noStore(json(claim, { status: 201 }));
  } catch (error) {
    return noStore(listenerErrorResponse(error));
  }
}

async function getAccessStatus(
  programs: ProgramRepository,
  listenerAccess: ListenerAccessRepository,
  input: AccessStatusInput,
): Promise<Response> {
  try {
    const program = await programs.getProgramBySlug(input.programSlug);
    if (!program) {
      throw new ProgramNotFoundError();
    }

    if (input.proof === "token") {
      const state = await listenerAccess.getStatusForAccessToken(
        program.id,
        input.accessToken,
      );
      return noStore(json({ state }));
    }

    const claim = await listenerAccess.getClaimForRedeem(
      program.id,
      input.claimId,
      input.claimSecret,
    );
    if (!claim) {
      return claimInvalidResponse();
    }

    if (claim.status === "approved") {
      const accessToken = await listenerAccess.mintAccessToken(
        program.id,
        input.claimId,
        input.claimSecret,
      );
      if (accessToken) {
        return noStore(json({ state: "approved", accessToken }));
      }

      // A concurrent revoke can win between the read and guarded mint. Re-read
      // the claim proof and report the winning state instead of reviving it.
      const current = await listenerAccess.getClaimForRedeem(
        program.id,
        input.claimId,
        input.claimSecret,
      );
      if (!current) {
        return claimInvalidResponse();
      }
      return noStore(json({ state: accessState(current.status) }));
    }

    return noStore(json({ state: accessState(claim.status) }));
  } catch (error) {
    return noStore(listenerErrorResponse(error));
  }
}

function accessState(
  status: "pending" | "approved" | "revoked" | "superseded",
): "pending" | "approved" | "revoked" | "unknown" {
  return status === "superseded" ? "unknown" : status;
}

function claimInvalidResponse(): Response {
  return noStore(json({ error: "claim_invalid" }, { status: 403 }));
}

function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

function listenerWriteBehindEnabled(env: Env): boolean {
  return env.LISTENER_WRITE_BEHIND === "true";
}

function presenceLiveCountEnabled(env: Env): boolean {
  return (
    env.PRESENCE_LIVE_COUNT === "shadow" || env.PRESENCE_LIVE_COUNT === "true"
  );
}

// Mints ephemeral TURN ICE servers for a listener BEFORE the browser builds its
// peer connection, so relay candidates (incl. turns:443) are gathered up front.
// Applying iceServers after ICE gathering (the old subscribe-only path) yielded
// zero relay candidates, so direct-UDP-only connections died on restrictive NATs.
// TODO(rate-limit): mints ephemeral TURN creds; add per-client rate limiting as a
// cross-cutting follow-up applying to subscribe too (currently unthrottled).
async function getListenerIceServers(
  env: Env,
  programs: ProgramRepository,
  url: URL,
): Promise<Response> {
  // Require programSlug (+ clientId) and slug-resolve, matching the subscribe
  // path's exposure so this endpoint mints credentials on the same terms.
  const programSlug = url.searchParams.get("programSlug")?.trim();
  const clientId = url.searchParams.get("clientId")?.trim();
  if (!programSlug) {
    return json(
      { error: "validation_error", message: "programSlug is required" },
      {
        status: 400,
      },
    );
  }
  if (!clientId) {
    return json(
      { error: "validation_error", message: "clientId is required" },
      {
        status: 400,
      },
    );
  }

  let programId: string;
  try {
    const resolved = await resolveBrowserProgramReference(programs, {
      programSlug,
    });
    programId = resolved.programId;
  } catch (error) {
    return listenerErrorResponse(error);
  }

  // getIceServersForClient ignores its input arg today, but pass a minimal valid
  // listener-role input so the contract stays correct if it starts honoring it.
  const { iceServers } = await getIceServersForClient(env, {
    role: "listener",
    programId,
  });

  return json({ iceServers });
}

// partytracks path: a listener needs the live publisher's {sessionId, trackName}
// to pull() the remote track. Returns the SFU coordinates from getActivePublisher
// (the server-side single source of truth). Deliberately NOT exposed via the broad
// /status poll, which 5k listeners hit; this is fetched only on subscribe and on a
// publisherVersion change. no-store so a reconnect's new coordinates are never stale.
async function getActivePublisherMetadata(
  request: Request,
  programs: ProgramRepository,
  streams: RealtimeStreamRepository,
  env: Env,
  url: URL,
): Promise<Response> {
  const programSlug = url.searchParams.get("programSlug")?.trim();
  const streamId = url.searchParams.get("streamId")?.trim();
  if (!programSlug) {
    return json(
      { error: "validation_error", message: "programSlug is required" },
      { status: 400 },
    );
  }
  if (!streamId) {
    return json(
      { error: "validation_error", message: "streamId is required" },
      { status: 400 },
    );
  }

  try {
    const preferRelay = env.RELAY_ENABLED === "true";
    const resolved = await resolveBrowserProgramReference(programs, {
      programSlug,
    });
    const program = resolved.program;
    if (!program) {
      throw new ProgramNotFoundError();
    }
    if (program.accessControlEnabled) {
      const accessToken =
        request.headers.get("x-listener-access-token")?.trim() || undefined;
      await requireListenerApproval(env.DB, resolved.programId, accessToken);
    }
    const publisher = await streams.getListenerPublisher(
      resolved.programId,
      streamId,
      preferRelay,
    );
    const response = json({
      sessionId: publisher.cloudflareSessionId,
      trackName: publisher.publishedTrackName,
    });
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    return listenerErrorResponse(error);
  }
}

async function replaceConnection(
  request: Request,
  ctx: ExecutionContext,
  env: Env,
  listeners: ListenerRepository,
  reason: "language_switch" | "reconnected",
  input: ReplacementConnectionInput,
): Promise<Response> {
  try {
    if (input.program.accessControlEnabled) {
      await requireListenerApproval(env.DB, input.programId, input.accessToken);
    }
    const existingConnection = await listeners.getConnection(
      input.previousConnectionId,
    );
    if (!existingConnection) {
      throw new ListenerConnectionNotFoundError();
    }

    if (existingConnection.programId !== input.programId) {
      return json({ error: "program_mismatch" }, { status: 400 });
    }

    await listeners.requireStream(input.programId, input.streamId);

    const { connection: oldConnection, changed } =
      await listeners.disconnectConnection(input.previousConnectionId, reason);

    const successorInput = {
      previousConnectionId: oldConnection.id,
      programId: input.programId,
      streamId: input.streamId,
      clientId: input.clientId,
      program: input.program,
      ...(input.accessToken ? { accessToken: input.accessToken } : {}),
    };

    if (!changed) {
      const successor = await findReplacementSuccessor(
        listeners,
        reason,
        successorInput,
      );

      if (successor) {
        notifyListenerPresenceBestEffort(ctx, env, input.programId, "/join", {
          connectionId: successor.id,
          streamId: successor.streamId,
        });
        await cleanupListenerRealtimeBestEffort(
          env,
          listeners,
          oldConnection.id,
        );
        return json({ connectionId: successor.id }, { status: 201 });
      }

      if (!canRecoverMissingSuccessor(oldConnection, reason)) {
        throw new ListenerInvalidStateError();
      }
    }

    await cleanupListenerRealtimeBestEffort(env, listeners, oldConnection.id);

    const replacementCreateInput = {
      programId: input.programId,
      streamId: input.streamId,
      clientId: input.clientId,
      ...listenerClientMetadata(request),
      ...(reason === "language_switch"
        ? { switchFromConnectionId: oldConnection.id }
        : { reconnectOfConnectionId: oldConnection.id }),
    };

    if (listenerWriteBehindEnabled(env)) {
      await listeners.validateRequestedConnection(replacementCreateInput);
      const replacement = buildRequestedConnectionRecord(
        replacementCreateInput,
      );
      // Concurrent duplicate replacements are resolved by the consumer's INSERT guard; the loser retries to DLQ.
      await enqueueConnectionEvent(env, {
        kind: "requested",
        connection: replacement,
      });
      notifyListenerPresenceBestEffort(ctx, env, input.programId, "/leave", {
        connectionId: oldConnection.id,
      });
      notifyListenerPresenceBestEffort(ctx, env, input.programId, "/join", {
        connectionId: replacement.id,
        streamId: input.streamId,
      });
      return json({ connectionId: replacement.id }, { status: 201 });
    }

    const newConnection = await createReplacementConnection(
      listeners,
      reason,
      replacementCreateInput,
      successorInput,
    );
    notifyListenerPresenceBestEffort(ctx, env, input.programId, "/leave", {
      connectionId: oldConnection.id,
    });
    notifyListenerPresenceBestEffort(ctx, env, input.programId, "/join", {
      connectionId: newConnection.id,
      streamId: newConnection.streamId,
    });

    return json({ connectionId: newConnection.id }, { status: 201 });
  } catch (error) {
    return listenerErrorResponse(error);
  }
}

async function createSubscribeSession(
  request: Request,
  env: Env,
  listeners: ListenerRepository,
  streams: RealtimeStreamRepository,
  input: ResolvedSubscribeSessionInput,
): Promise<Response> {
  try {
    if (input.program.accessControlEnabled) {
      await requireListenerApproval(env.DB, input.programId, input.accessToken);
    }
    await listeners.requireStream(input.programId, input.streamId);
    const preferRelay = env.RELAY_ENABLED === "true";
    await streams.getListenerPublisher(
      input.programId,
      input.streamId,
      preferRelay,
    );

    const requestedConnectionId = input.connectionId;
    const connection =
      requestedConnectionId !== undefined
        ? await requireReusableSubscribeConnection(listeners, {
            ...input,
            connectionId: requestedConnectionId,
          })
        : // This fallback stays synchronous: the SFU handshake updates this row immediately after,
          // and partytracks-enabled production joins use /request instead of this path.
          await listeners.createRequestedConnection({
            programId: input.programId,
            streamId: input.streamId,
            clientId: input.clientId,
            ...listenerClientMetadata(request),
          });

    const client = createCloudflareRealtimeClient(
      env,
      env.REALTIME_FETCH ?? fetch,
    );

    try {
      const realtime = await client.createSession(input.sessionDescription);
      if (!realtime.sessionId || !realtime.sessionDescription) {
        throw new CloudflareRealtimeError();
      }

      try {
        await listeners.setRealtimeSession(connection.id, realtime.sessionId);
      } catch (_error) {
        // The SFU adapter only exposes track close, not bare session close.
        await markRealtimeFailure(
          listeners,
          connection.id,
          "realtime_session_persistence_failed",
          { cloudflareSessionId: realtime.sessionId },
        );
        return realtimeErrorResponse();
      }

      const { iceServers } = await getIceServersForClient(env, {
        role: "listener",
        programId: input.programId,
        streamId: input.streamId,
        connectionId: connection.id,
      });

      return json(
        {
          connectionId: connection.id,
          streamId: connection.streamId,
          sessionDescription: realtime.sessionDescription,
          iceServers,
        },
        { status: 201 },
      );
    } catch (error) {
      if (error instanceof CloudflareRealtimeError) {
        await markRealtimeFailure(
          listeners,
          connection.id,
          "realtime_session_failed",
          realtimeFailureMetadata(error, env),
        );
        await selfHealMissingPublisher(
          streams,
          error,
          input.programId,
          input.streamId,
        );
        return realtimeErrorResponse();
      }
      throw error;
    }
  } catch (error) {
    return listenerErrorResponse(error);
  }
}

async function subscribeTrack(
  env: Env,
  listeners: ListenerRepository,
  streams: RealtimeStreamRepository,
  input: SubscribeTrackInput,
): Promise<Response> {
  try {
    const connection = await requireTrackAttachableRealtimeConnection(
      listeners,
      input.connectionId,
    );
    const preferRelay = env.RELAY_ENABLED === "true";
    const activePublisher = await streams.getListenerPublisher(
      connection.programId,
      connection.streamId,
      preferRelay,
    );
    const client = createCloudflareRealtimeClient(
      env,
      env.REALTIME_FETCH ?? fetch,
    );

    try {
      const realtime = await client.addTracks(connection.cloudflareSessionId, {
        tracks: [
          {
            location: "remote",
            sessionId: activePublisher.cloudflareSessionId,
            trackName: activePublisher.publishedTrackName,
          },
        ],
      });
      const track = firstTrackWithMid(realtime.tracks);
      try {
        await listeners.setRealtimeTrackMid(connection.id, track.mid);
      } catch (error) {
        try {
          await client.closeTracks(
            connection.cloudflareSessionId,
            [{ mid: track.mid }],
            true,
          );
        } catch (_cleanupError) {
          await listeners.recordRealtimeCleanupTarget(
            connection.id,
            connection.cloudflareSessionId,
            track.mid,
          );
          await listeners.recordConnectionFailure(
            connection.id,
            "realtime_track_cleanup_failed",
            {
              cloudflareSessionId: connection.cloudflareSessionId,
              cloudflareTrackMid: track.mid,
              trackMid: track.mid,
            },
          );
        }
        throw error;
      }

      return json({
        connectionId: connection.id,
        track,
        requiresImmediateRenegotiation:
          realtime.requiresImmediateRenegotiation ?? false,
        ...(realtime.sessionDescription
          ? { sessionDescription: realtime.sessionDescription }
          : {}),
      });
    } catch (error) {
      if (error instanceof CloudflareRealtimeError) {
        await markRealtimeFailure(
          listeners,
          connection.id,
          "realtime_track_failed",
          realtimeFailureMetadata(error, env),
        );
        await selfHealMissingPublisher(
          streams,
          error,
          connection.programId,
          connection.streamId,
        );
        return realtimeErrorResponse();
      }
      throw error;
    }
  } catch (error) {
    return listenerErrorResponse(error);
  }
}

async function renegotiateSubscribe(
  env: Env,
  listeners: ListenerRepository,
  input: SubscribeRenegotiateInput,
): Promise<Response> {
  try {
    const connection = await requireRequestedRealtimeConnection(
      listeners,
      input.connectionId,
    );
    const client = createCloudflareRealtimeClient(
      env,
      env.REALTIME_FETCH ?? fetch,
    );

    try {
      const realtime = await client.renegotiate(
        connection.cloudflareSessionId,
        input.sessionDescription,
      );

      return json(Object.keys(realtime).length > 0 ? realtime : { ok: true });
    } catch (error) {
      if (error instanceof CloudflareRealtimeError) {
        await markRealtimeFailure(
          listeners,
          connection.id,
          "realtime_renegotiate_failed",
          realtimeFailureMetadata(error, env),
        );
        return realtimeErrorResponse();
      }
      throw error;
    }
  } catch (error) {
    return listenerErrorResponse(error);
  }
}

async function requireReusableSubscribeConnection(
  listeners: ListenerRepository,
  input: ResolvedSubscribeSessionInput & { connectionId: string },
) {
  const connection = await listeners.getConnection(input.connectionId);
  if (!connection) {
    throw new ListenerConnectionNotFoundError();
  }

  if (
    connection.programId !== input.programId ||
    connection.streamId !== input.streamId ||
    connection.clientId !== input.clientId ||
    connection.subscriptionStatus !== "requested" ||
    connection.cloudflareSessionId !== null ||
    connection.cloudflareTrackMid !== null
  ) {
    throw new ListenerInvalidStateError();
  }

  return connection;
}

async function requireRequestedRealtimeConnection(
  listeners: ListenerRepository,
  connectionId: string,
) {
  const connection = await listeners.getConnection(connectionId);
  if (!connection) {
    throw new ListenerConnectionNotFoundError();
  }

  if (
    connection.subscriptionStatus !== "requested" ||
    connection.cloudflareSessionId === null
  ) {
    throw new ListenerInvalidStateError();
  }

  return connection as typeof connection & { cloudflareSessionId: string };
}

async function requireTrackAttachableRealtimeConnection(
  listeners: ListenerRepository,
  connectionId: string,
) {
  const connection = await requireRequestedRealtimeConnection(
    listeners,
    connectionId,
  );

  if (connection.cloudflareTrackMid !== null) {
    throw new ListenerInvalidStateError();
  }

  return connection;
}

function firstTrackWithMid(
  tracks: RealtimeResponseTrack[] | undefined,
): RealtimeResponseTrack & { mid: string } {
  const track = tracks?.[0];
  if (!track || typeof track.mid !== "string" || track.mid.trim() === "") {
    throw new CloudflareRealtimeError();
  }
  return { ...track, mid: track.mid };
}

async function markRealtimeFailure(
  listeners: ListenerRepository,
  connectionId: string,
  reason: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await listeners.markFailed(connectionId, reason);
  await listeners.recordConnectionFailure(connectionId, reason, metadata);
}

function realtimeFailureMetadata(
  error: CloudflareRealtimeError,
  env: Env,
): Record<string, unknown> {
  const secrets = redactionCandidates(env);
  const metadata: Record<string, unknown> = {};

  if (error.status !== undefined) {
    metadata.realtimeStatus = error.status;
  }
  if (error.errorCode !== undefined) {
    metadata.realtimeErrorCode = redactSecrets(error.errorCode, secrets);
  }
  if (error.errorDescription !== undefined) {
    metadata.realtimeErrorDescription = redactSecrets(
      error.errorDescription,
      secrets,
    );
  }

  const trackErrors = sanitizedTrackErrors(error.trackErrors, secrets);
  if (trackErrors.length > 0) {
    metadata.realtimeTrackErrors = trackErrors;
  }

  return metadata;
}

function sanitizedTrackErrors(
  tracks: RealtimeResponseTrack[] | undefined,
  secrets: string[],
): Array<Record<string, string>> {
  if (!tracks) {
    return [];
  }

  return tracks
    .map((track) => {
      const sanitized: Record<string, string> = {};
      if (typeof track.errorCode === "string") {
        sanitized.errorCode = redactSecrets(track.errorCode, secrets);
      }
      if (typeof track.errorDescription === "string") {
        sanitized.errorDescription = redactSecrets(
          track.errorDescription,
          secrets,
        );
      }
      return sanitized;
    })
    .filter((track) => Object.keys(track).length > 0);
}

function redactionCandidates(env: Env): string[] {
  return [
    env.ADMIN_PASSWORD_HASH,
    env.ADMIN_SESSION_SECRET,
    env.CLOUDFLARE_REALTIME_APP_SECRET,
    env.TRANSLATOR_PASSWORD_PEPPER,
    env.TRANSLATOR_SESSION_SECRET,
    env.CLOUDFLARE_TURN_API_TOKEN,
  ].filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
}

function redactSecrets(value: string, secrets: string[]): string {
  return secrets.reduce(
    (redacted, secret) => redacted.split(secret).join("[redacted]"),
    value,
  );
}

async function cleanupListenerRealtimeBestEffort(
  env: Env,
  listeners: ListenerRepository,
  connectionId: string,
): Promise<void> {
  try {
    await cleanupListenerRealtime(env, listeners, connectionId);
  } catch (_error) {
    // Cleanup is best-effort after local listener state has already changed.
  }
}

async function cleanupListenerRealtime(
  env: Env,
  listeners: ListenerRepository,
  connectionId: string,
): Promise<void> {
  let targets: Awaited<
    ReturnType<ListenerRepository["listRealtimeCleanupTargets"]>
  >;
  try {
    targets = await listeners.listRealtimeCleanupTargets(connectionId);
  } catch (_error) {
    return;
  }

  const client = createCloudflareRealtimeClient(
    env,
    env.REALTIME_FETCH ?? fetch,
  );
  const seen = new Set<string>();

  for (const target of targets) {
    const cloudflareSessionId = target.cloudflareSessionId?.trim();
    const cloudflareTrackMid = target.cloudflareTrackMid?.trim();
    if (!cloudflareSessionId || !cloudflareTrackMid) {
      continue;
    }

    const key = `${cloudflareSessionId}\u0000${cloudflareTrackMid}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    try {
      await client.closeTracks(
        cloudflareSessionId,
        [{ mid: cloudflareTrackMid }],
        true,
      );
      try {
        await listeners.recordRealtimeCleanupSuccess(
          connectionId,
          cloudflareSessionId,
          cloudflareTrackMid,
        );
      } catch (_recordError) {
        // Cleanup already succeeded; a missing marker only risks a later retry.
      }
    } catch (error) {
      if (isAlreadyClosedRealtimeTrackError(error)) {
        try {
          await listeners.recordRealtimeCleanupSuccess(
            connectionId,
            cloudflareSessionId,
            cloudflareTrackMid,
          );
        } catch (_recordError) {
          // Cleanup already succeeded; a missing marker only risks a later retry.
        }
        continue;
      }

      try {
        await listeners.recordConnectionFailure(
          connectionId,
          "realtime_cleanup_failed",
          {
            connectionId,
            cloudflareSessionId,
            cloudflareTrackMid,
          },
        );
      } catch (_recordError) {
        // Cleanup is best-effort after local listener state has already changed.
      }
    }
  }
}

function isAlreadyClosedRealtimeTrackError(error: unknown): boolean {
  if (!(error instanceof CloudflareRealtimeError)) {
    return false;
  }

  const errorCodes = [
    error.errorCode,
    ...(error.trackErrors ?? []).map((trackError) => trackError.errorCode),
  ].filter((code): code is string => typeof code === "string");

  if (errorCodes.some(isAlreadyClosedRealtimeTrackCode)) {
    return true;
  }

  return false;
}

function isAlreadyClosedRealtimeTrackCode(code: string): boolean {
  const normalized = code
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return TRACK_ALREADY_CLOSED_ERROR_CODES.has(normalized);
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
  "trackclosed",
]);

async function findReplacementSuccessor(
  listeners: ListenerRepository,
  reason: "language_switch" | "reconnected",
  successorInput: ReplacementConnectionInput,
) {
  return reason === "language_switch"
    ? await listeners.findSwitchSuccessor(successorInput)
    : await listeners.findReconnectSuccessor(successorInput);
}

function canRecoverMissingSuccessor(
  connection: {
    subscriptionStatus: string;
    disconnectReason: string | null;
  },
  reason: "language_switch" | "reconnected",
): boolean {
  return (
    connection.subscriptionStatus === "disconnected" &&
    connection.disconnectReason === reason
  );
}

async function createReplacementConnection(
  listeners: ListenerRepository,
  reason: "language_switch" | "reconnected",
  createInput: Parameters<ListenerRepository["createRequestedConnection"]>[0],
  successorInput: ReplacementConnectionInput,
) {
  try {
    return await listeners.createRequestedConnection(createInput);
  } catch (error) {
    if (error instanceof ListenerReplacementSuccessorExistsError) {
      const successor = await findReplacementSuccessor(
        listeners,
        reason,
        successorInput,
      );

      if (successor) {
        return successor;
      }

      throw new ListenerInvalidStateError();
    }

    throw error;
  }
}

async function parseBody<T>(
  request: Request,
  parse: (input: unknown) => T,
): Promise<T | Response> {
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (_error) {
    return json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    return parse(body);
  } catch (error) {
    return json(
      {
        error: "validation_error",
        message:
          error instanceof Error ? error.message : "request body is invalid",
      },
      { status: 400 },
    );
  }
}

function parseCreateConnectionInput(body: unknown): CreateConnectionInput {
  const accessToken = readOptionalString(body, "accessToken");
  return {
    ...readProgramReference(body),
    streamId: readRequiredString(body, "streamId"),
    clientId: readRequiredString(body, "clientId"),
    ...(accessToken ? { accessToken } : {}),
  };
}

function parseAccessClaimInput(body: unknown): AccessClaimInput {
  return {
    programSlug: readRequiredString(body, "programSlug"),
    clientId: readRequiredString(body, "clientId"),
  };
}

function parseAccessStatusInput(body: unknown): AccessStatusInput {
  const programSlug = readRequiredString(body, "programSlug");
  const claimId = readOptionalString(body, "claimId");
  const claimSecret = readOptionalString(body, "claimSecret");
  const accessToken = readOptionalString(body, "accessToken");

  if (claimId && claimSecret && !accessToken) {
    return { proof: "claim", programSlug, claimId, claimSecret };
  }
  if (accessToken && !claimId && !claimSecret) {
    return { proof: "token", programSlug, accessToken };
  }
  throw new Error("claimId and claimSecret, or accessToken, is required");
}

function parseSwitchConnectionInput(body: unknown): SwitchConnectionInput {
  return {
    ...parseCreateConnectionInput(body),
    fromConnectionId: readRequiredString(body, "fromConnectionId"),
  };
}

function parseReconnectConnectionInput(
  body: unknown,
): ReconnectConnectionInput {
  return {
    ...parseCreateConnectionInput(body),
    reconnectOfConnectionId: readRequiredString(
      body,
      "reconnectOfConnectionId",
    ),
  };
}

function parseSubscribeSessionInput(body: unknown): SubscribeSessionInput {
  const connectionId = readOptionalString(body, "connectionId");
  return {
    ...parseCreateConnectionInput(body),
    ...(connectionId ? { connectionId } : {}),
    sessionDescription: readSessionDescription(body, "sessionDescription"),
  };
}

function parseSubscribeTrackInput(body: unknown): SubscribeTrackInput {
  return parseConnectionIdInput(body);
}

function parseSubscribeRenegotiateInput(
  body: unknown,
): SubscribeRenegotiateInput {
  return {
    ...parseConnectionIdInput(body),
    sessionDescription: readSessionDescription(body, "sessionDescription"),
  };
}

function parseConnectionIdInput(body: unknown): ConnectionIdInput {
  return {
    connectionId: readRequiredString(body, "connectionId"),
  };
}

function parseHeartbeatInput(body: unknown): ConnectionIdInput {
  return parseConnectionIdInput(body);
}

function parseLeaveInput(body: unknown): LeaveInput {
  return {
    ...parseConnectionIdInput(body),
    reason: readRequiredString(body, "reason"),
  };
}

function readRequiredString(body: unknown, key: string): string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`${key} is required`);
  }

  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    throw new Error(`${key} is required`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${key} is required`);
  }

  return trimmed;
}

function readProgramReference(body: unknown): BrowserProgramReference {
  const programSlug = readOptionalString(body, "programSlug");
  const programId = readOptionalString(body, "programId");
  if (!programSlug && !programId) {
    throw new Error("programSlug or programId is required");
  }

  return {
    ...(programSlug ? { programSlug } : {}),
    ...(programId ? { programId } : {}),
  };
}

function readOptionalString(body: unknown, key: string): string | null {
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

async function resolveCreateConnectionInput(
  programs: ProgramRepository,
  input: CreateConnectionInput,
): Promise<ResolvedCreateConnectionInput | Response> {
  try {
    const resolved = await resolveBrowserProgramReference(programs, input);
    const program = resolved.program;
    if (!program) {
      throw new ProgramNotFoundError();
    }
    return {
      programId: resolved.programId,
      streamId: input.streamId,
      clientId: input.clientId,
      program,
      ...(input.accessToken ? { accessToken: input.accessToken } : {}),
    };
  } catch (error) {
    return listenerErrorResponse(error);
  }
}

function readSessionDescription(
  body: unknown,
  key: string,
): SessionDescription {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`${key} is required`);
  }

  const value = (body as Record<string, unknown>)[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} is required`);
  }

  const type = readRequiredString(value, "type");
  if (type !== "offer" && type !== "answer") {
    throw new Error(`${key}.type must be offer or answer`);
  }

  return {
    type,
    sdp: readRequiredString(value, "sdp"),
  };
}

function listenerClientMetadata(request: Request): {
  listenerIp: string;
  userAgent: string;
} {
  return {
    listenerIp: request.headers.get("cf-connecting-ip")?.trim() || "0.0.0.0",
    userAgent: request.headers.get("user-agent")?.trim() || "",
  };
}

function cleanQuotedClientHint(value: string | null): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    return undefined;
  }
  const unquoted =
    trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  return unquoted === "" ? undefined : unquoted;
}

function cleanRawClientHint(value: string | null): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

function listenerClientHints(headers: Headers): ListenerClientHints {
  const hints: ListenerClientHints = {};
  const deviceModel = cleanQuotedClientHint(headers.get("sec-ch-ua-model"));
  const platform = cleanQuotedClientHint(headers.get("sec-ch-ua-platform"));
  const platformVersion = cleanQuotedClientHint(
    headers.get("sec-ch-ua-platform-version"),
  );
  const browserFullVersion = cleanRawClientHint(
    headers.get("sec-ch-ua-full-version-list"),
  );

  if (deviceModel !== undefined) {
    hints.deviceModel = deviceModel;
  }
  if (platform !== undefined) {
    hints.platform = platform;
  }
  if (platformVersion !== undefined) {
    hints.platformVersion = platformVersion;
  }
  if (browserFullVersion !== undefined) {
    hints.browserFullVersion = browserFullVersion;
  }
  return hints;
}

async function notifyPresence(
  env: Env,
  programId: string,
  path: "/join" | "/heartbeat" | "/leave",
  body: Record<string, string>,
): Promise<void> {
  const id = env.PROGRAM_PRESENCE.idFromName(programId);
  const stub = env.PROGRAM_PRESENCE.get(id);
  const response = await stub.fetch(`https://presence.internal${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error("presence update failed");
  }
}

function notifyListenerPresenceBestEffort(
  ctx: ExecutionContext,
  env: Env,
  programId: string,
  path: "/join" | "/heartbeat" | "/leave",
  body: Record<string, string>,
): void {
  if (!presenceLiveCountEnabled(env)) {
    return;
  }

  ctx.waitUntil(
    notifyPresence(env, programId, path, body).catch((err) => {
      console.log(
        JSON.stringify({
          msg: "presence_notify_failed",
          path,
          err: String(err),
        }),
      );
    }),
  );
}

function listenerErrorResponse(error: unknown): Response {
  if (error instanceof ListenerNotApprovedError) {
    return json({ error: "listener_not_approved" }, { status: 403 });
  }

  if (error instanceof ProgramReferenceMismatchError) {
    return json({ error: "program_reference_mismatch" }, { status: 400 });
  }

  if (
    error instanceof ProgramNotFoundError ||
    error instanceof ListenerProgramNotFoundError
  ) {
    return json({ error: "program_not_found" }, { status: 404 });
  }

  if (error instanceof ListenerStreamNotFoundError) {
    return json({ error: "stream_not_found" }, { status: 404 });
  }

  if (error instanceof ListenerConnectionNotFoundError) {
    return json({ error: "listener_connection_not_found" }, { status: 404 });
  }

  if (error instanceof ListenerInvalidStateError) {
    return json({ error: "listener_invalid_state" }, { status: 409 });
  }

  if (error instanceof StreamNotLiveError) {
    return json({ error: "stream_not_live" }, { status: 409 });
  }

  if (error instanceof CloudflareRealtimeError) {
    return realtimeErrorResponse();
  }

  return json({ error: "database_error" }, { status: 500 });
}

function realtimeErrorResponse(): Response {
  return json({ error: "realtime_error" }, { status: 502 });
}

// Provider error codes that mean the publisher's SFU session/track is gone.
// Normalized to match the translator-side cleanup predicates in translator.ts
// (keep these two lists in lockstep). NOTE: a subscribe to a dead publisher track
// surfaces the failure PER-TRACK as HTTP 200 + tracks[].errorCode, so we must
// consult error.trackErrors, not just the top-level status/errorCode.
const MISSING_PUBLISHER_ERROR_CODES = new Set([
  "not_found_track_error",
  "notfoundtrackerror",
  "track_not_found",
  "track_notfound",
  "tracknotfound",
  "not_found_session_error",
  "notfoundsessionerror",
  "session_not_found",
  "session_notfound",
  "sessionnotfound",
]);

function normalizeRealtimeErrorCode(code: string | undefined): string {
  return (code ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isMissingPublisherError(error: CloudflareRealtimeError): boolean {
  if (error.status === 404 || error.status === 410) {
    return true;
  }
  const codes = [
    error.errorCode,
    ...(error.trackErrors ?? []).map((trackError) => trackError.errorCode),
  ].filter((code): code is string => typeof code === "string");
  return codes.some((code) =>
    MISSING_PUBLISHER_ERROR_CODES.has(normalizeRealtimeErrorCode(code)),
  );
}

// Self-heal hook: when a listener subscribe fails because the publisher's SFU
// session/track is gone, close the orphaned published row and clear the stream's
// live pointer so the stream reports `offline` (listeners then see "waiting for
// translator" instead of every listener hitting the same dead track). Gated on a
// genuine not-found shape -- a transient 5xx must never tear down a live publisher.
async function selfHealMissingPublisher(
  streams: RealtimeStreamRepository,
  error: CloudflareRealtimeError,
  programId: string,
  streamId: string,
): Promise<void> {
  if (!isMissingPublisherError(error)) {
    return;
  }
  try {
    await streams.expireActivePublisher(programId, streamId);
  } catch (_cleanupError) {
    // Best-effort: the listener already receives realtime_error.
  }
}
