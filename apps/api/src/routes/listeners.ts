import {
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
import type { Env } from "../env";
import { json, readJson, type WaitUntilCtx } from "../http";
import { isLiveKitConfigured } from "../livekit/client";
import { mintListenerToken } from "../livekit/tokens";
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

interface ListenerTokenInput extends BrowserProgramReference {
  streamId: string;
  connectionId: string;
  accessToken?: string;
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
  _ctx: WaitUntilCtx,
): Promise<Response | null> {
  const listeners = new ListenerRepository(env.DB);
  const listenerAccess = new ListenerAccessRepository(env.DB);
  const programs = new ProgramRepository(env.DB);

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

  if (request.method === "POST" && url.pathname === "/api/listeners/token") {
    const input = await parseBody(request, parseListenerTokenInput);
    if (input instanceof Response) {
      return input;
    }

    return handleListenerRealtimeToken(env, programs, listeners, input);
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
      const connection = await listeners.createRequestedConnection(createInput);
      // Presence join is no longer notified from here -- it is driven by
      // livekit/webhook.ts's `participant_joined` handling once the listener
      // actually joins the LiveKit room with the token from
      // POST /api/listeners/token (see presence/status.ts's header comment).
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
      await listeners.markConnected(
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
      // Extends the listener_connections DB row's liveness for admin
      // reporting/audit purposes only -- LiveKit's own WebSocket connection
      // state (via the webhook) is what now drives live presence counts, so
      // this no longer also heartbeats the in-process presence Map (see
      // presence/status.ts's header comment).
      await listeners.recordHeartbeat(
        input.connectionId,
        listenerClientHints(request.headers),
        false,
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
      // Presence leave is no longer notified from here -- see the /request
      // handler's comment above; it is driven by the LiveKit
      // `participant_left` webhook instead.
      await listeners.disconnectConnection(input.connectionId, input.reason);
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

    return replaceConnection(request, env, listeners, "language_switch", {
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

    return replaceConnection(request, env, listeners, "reconnected", {
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

// Mints a subscribe-only LiveKit token for a listener connection already
// created via POST /api/listeners/request. This is the LiveKit-era
// replacement for the deleted `/subscribe/session` (SDP-exchange) endpoint --
// it keeps exactly the same generic bookkeeping that endpoint did before
// ever touching the SFU (access-control gate, stream existence, and
// connectionId validation), then mints a token instead of stubbing.
// `/ice-servers` and `/active-publisher` are deleted entirely rather than
// replaced: LiveKit's client SDK has its own built-in TURN (no separate
// ICE-servers fetch needed), and "is there a publisher" is now answered by
// the room's own state / the public `/status` endpoint, not a per-listener
// poll.
async function handleListenerRealtimeToken(
  env: Env,
  programs: ProgramRepository,
  listeners: ListenerRepository,
  input: ListenerTokenInput,
): Promise<Response> {
  if (!isLiveKitConfigured(env)) {
    return json({ error: "realtime_not_configured" }, { status: 503 });
  }

  try {
    const resolved = await resolveBrowserProgramReference(programs, input);
    const program = resolved.program;
    if (!program) {
      throw new ProgramNotFoundError();
    }
    if (program.accessControlEnabled) {
      await requireListenerApproval(env.DB, resolved.programId, input.accessToken);
    }
    await listeners.requireStream(resolved.programId, input.streamId);
    const connection = await listeners.getConnection(input.connectionId);
    if (!connection) {
      throw new ListenerConnectionNotFoundError();
    }
    if (connection.programId !== resolved.programId) {
      return json({ error: "program_mismatch" }, { status: 400 });
    }
    if (connection.streamId !== input.streamId) {
      return json({ error: "stream_mismatch" }, { status: 400 });
    }
    if (
      connection.subscriptionStatus === "disconnected" ||
      connection.subscriptionStatus === "failed"
    ) {
      throw new ListenerInvalidStateError();
    }

    const minted = await mintListenerToken(env, {
      connectionId: input.connectionId,
      programId: resolved.programId,
      streamId: input.streamId,
    });

    return json({
      connectionId: input.connectionId,
      token: minted.token,
      url: minted.url,
      roomName: minted.roomName,
    });
  } catch (error) {
    return listenerErrorResponse(error);
  }
}

async function replaceConnection(
  request: Request,
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
        return json({ connectionId: successor.id }, { status: 201 });
      }

      if (!canRecoverMissingSuccessor(oldConnection, reason)) {
        throw new ListenerInvalidStateError();
      }
    }

    const replacementCreateInput = {
      programId: input.programId,
      streamId: input.streamId,
      clientId: input.clientId,
      ...listenerClientMetadata(request),
      ...(reason === "language_switch"
        ? { switchFromConnectionId: oldConnection.id }
        : { reconnectOfConnectionId: oldConnection.id }),
    };

    const newConnection = await createReplacementConnection(
      listeners,
      reason,
      replacementCreateInput,
      successorInput,
    );

    return json({ connectionId: newConnection.id }, { status: 201 });
  } catch (error) {
    return listenerErrorResponse(error);
  }
}

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

function parseListenerTokenInput(body: unknown): ListenerTokenInput {
  const accessToken = readOptionalString(body, "accessToken");
  return {
    ...readProgramReference(body),
    streamId: readRequiredString(body, "streamId"),
    connectionId: readRequiredString(body, "connectionId"),
    ...(accessToken ? { accessToken } : {}),
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

function listenerClientMetadata(request: Request): {
  listenerIp: string;
  userAgent: string;
} {
  return {
    // TODO(slice-5): `cf-connecting-ip` was Cloudflare's edge header; the
    // Caddy-fronted deploy needs to forward a real client IP header instead
    // (e.g. X-Forwarded-For), or every listener_connections row records
    // "0.0.0.0" for listenerIp.
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

  return json({ error: "database_error" }, { status: 500 });
}
