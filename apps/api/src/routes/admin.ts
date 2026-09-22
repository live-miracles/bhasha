import {
  handleBootstrap,
  handleChangeOwnPassword,
  handleLogin,
  handleLogout,
  type UserAuth,
  requireUserAuth
} from "../auth/adminAuth";
import { requireProgramAccess } from "../auth/programAccess";
import {
  ACTIVE_LISTENER_WINDOW_SECONDS,
  ListenerProgramNotFoundError,
  ListenerRepository,
  MAX_CSV_ROWS,
  type ActiveListenerCounts,
  type ListenerReportFilters
} from "../db/listenerRepository";
import {
  type AdminProgramDetail,
  ProgramDeleteLockedError,
  ProgramHasHistoryError,
  ProgramNotFoundError,
  ProgramRepository,
  ProgramSlugExistsError,
  ProgramSlugLockedError,
  StreamDeleteLockedError,
  StreamHasHistoryError,
  StreamNotFoundError
} from "../db/programRepository";
import { ListenerAccessRepository } from "../db/listenerAccessRepository";
import {
  UsersRepository,
  isEmailConflict,
  isOrgAdminConflict,
  type UserRecord
} from "../db/usersRepository";
import {
  TranslatorAssignmentExistsError,
  TranslatorAssignmentNotFoundError,
  TranslatorDeleteLockedError,
  TranslatorExistsError,
  TranslatorNotFoundError,
  TranslatorRepository
} from "../db/translatorRepository";
import {
  VolunteerPasswordTooShortError,
  VolunteerRepository
} from "../db/volunteerRepository";
import {
  parseCreateProgramInput,
  parseCreateStreamInput,
  parseCreateTranslatorAssignmentInput,
  parseCreateTranslatorInput,
  parseResetTranslatorPasswordInput,
  parseUpdateProgramInput,
  parseUpdateStreamInput,
  parseUpdateTranslatorInput,
  type UpdateProgramInput
} from "../domain/programs";
import {
  parseCreateOrgInput,
  parseCreateUserInput,
  parseResetPasswordInput,
  parseUpdateOrgInput,
  parseUpdateUserInput
} from "../domain/users";
import { RealtimeStreamRepository } from "../db/realtimeStreamRepository";
import {
  buildReadinessItems,
  isConfirmableReadinessItem,
  type AdminReadinessResponse
} from "../domain/readiness";
import type { Env } from "../env";
import { json, readJson, type WaitUntilCtx } from "../http";
import {
  createRoomServiceClient,
  deleteRoomBestEffort,
  isLiveKitConfigured,
  removeParticipantBestEffort
} from "../livekit/client";
import { roomNameForStream, translatorIdentity } from "../livekit/tokens";
import { readPresenceStatusSnapshot } from "../presence/status";
import type { RoomServiceClient } from "livekit-server-sdk";
import { DEVICE_LABELS } from "../domain/deviceLabel";
import { deriveStreamState } from "../presence/streamState";
import {
  type AdminReportStreamSummary,
  type AdminReportSummaryTotals,
  isRetentionEligible,
  listenerConnectionsToCsv
} from "../domain/reports";

const CSV_REPORT_NOTES =
  "disconnectedAt may be empty if the browser disappeared without an explicit leave event before presence timeout.";

const DEFAULT_EVENT_PAGE_SIZE = 20;
const MAX_EVENT_PAGE_SIZE = 100;
const DEFAULT_BACKFILL_BATCH_SIZE = 200;
const MAX_BACKFILL_BATCH_SIZE = 1000;

function presenceLiveCountSource(env: Env): "d1" | "shadow" | "true" {
  return env.PRESENCE_LIVE_COUNT === "shadow" || env.PRESENCE_LIVE_COUNT === "true"
    ? env.PRESENCE_LIVE_COUNT
    : "d1";
}

async function resolveActiveListenerCount(
  env: Env,
  programId: string,
  d1Count: ActiveListenerCounts
): Promise<ActiveListenerCounts> {
  const source = presenceLiveCountSource(env);
  if (source === "d1") {
    return d1Count;
  }

  const presence = await readPresenceStatusSnapshot(env, programId);
  const doCount = {
    total: presence.total,
    streams: Object.entries(presence.streams).map(([streamId, count]) => ({
      streamId,
      count
    }))
  };
  const fallback = source === "true" && presence.degraded;
  console.log(
    JSON.stringify({
      msg: "presence_count_dualread",
      programId,
      d1: d1Count.total,
      do: presence.total,
      source,
      fallback
    })
  );
  return source === "true" && !fallback ? doCount : d1Count;
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (raw === null) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

const VALID_LISTENER_REPORT_STATES = [
  "requested",
  "connected",
  "disconnected",
  "failed"
] as const;
type ValidListenerReportState = (typeof VALID_LISTENER_REPORT_STATES)[number];
const VALID_LISTENER_ACCESS_STATUSES = [
  "pending",
  "approved",
  "revoked",
  "superseded"
] as const;

const VALID_EVENT_FEED_TYPES = [
  "translator_connected",
  "translator_disconnected",
  "listener_left",
  "listener_switched",
  "listener_reconnected",
  "connection_failed"
] as const;
type ValidEventFeedType = (typeof VALID_EVENT_FEED_TYPES)[number];

const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateBound(raw: string | null, isTo: boolean): string | undefined {
  if (!raw) {
    return undefined;
  }
  if (!Number.isFinite(Date.parse(raw))) {
    return undefined;
  }
  if (BARE_DATE_RE.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00.000Z`);
    if (isTo) {
      parsed.setUTCDate(parsed.getUTCDate() + 1);
    }
    return parsed.toISOString();
  }
  return new Date(raw).toISOString();
}

function parseDateRange(params: URLSearchParams): {
  from?: string;
  to?: string;
} {
  const range: { from?: string; to?: string } = {};
  const from = parseDateBound(params.get("from"), false);
  if (from) {
    range.from = from;
  }
  const to = parseDateBound(params.get("to"), true);
  if (to) {
    range.to = to;
  }
  return range;
}

export function parseListenerReportQuery(params: URLSearchParams): {
  filters: ListenerReportFilters;
  page: number;
} {
  const rawPage = params.get("page") ?? "";
  const parsedPage = Number.parseInt(rawPage, 10);
  const page = Number.isFinite(parsedPage) && parsedPage >= 1 ? parsedPage : 1;

  const states = params
    .getAll("state")
    .filter(
      (state): state is ValidListenerReportState =>
        (VALID_LISTENER_REPORT_STATES as readonly string[]).includes(state)
    );
  const approvalStatuses = params
    .getAll("approvalStatus")
    .filter(
      (status): status is (typeof VALID_LISTENER_ACCESS_STATUSES)[number] =>
        (VALID_LISTENER_ACCESS_STATUSES as readonly string[]).includes(status)
    );

  const device = params.get("device");
  const parsedDevice =
    device && (DEVICE_LABELS as readonly string[]).includes(device)
      ? (device as (typeof DEVICE_LABELS)[number])
      : undefined;

  const streamId = params.get("streamId") || undefined;
  const range = parseDateRange(params);

  const filters: ListenerReportFilters = {};
  if (states.length > 0) {
    filters.states = states;
  }
  if (approvalStatuses.length > 0) {
    filters.approvalStatuses = approvalStatuses;
  }
  if (streamId) {
    filters.streamId = streamId;
  }
  if (parsedDevice) {
    filters.deviceLabel = parsedDevice;
  }
  if (range.from) {
    filters.createdFrom = range.from;
  }
  if (range.to) {
    filters.createdTo = range.to;
  }

  return { filters, page };
}

export function parseEventFeedQuery(params: URLSearchParams): {
  range: { from?: string; to?: string };
  eventTypes?: ValidEventFeedType[];
  translatorId?: string;
  page: number;
  pageSize: number;
} {
  const eventTypes = params
    .getAll("eventType")
    .filter(
      (eventType): eventType is ValidEventFeedType =>
        (VALID_EVENT_FEED_TYPES as readonly string[]).includes(eventType)
    );
  const translatorId = params.get("translatorId") || undefined;
  const page = parsePositiveInt(params.get("page"), 1);
  const pageSize = Math.min(
    parsePositiveInt(params.get("pageSize"), DEFAULT_EVENT_PAGE_SIZE),
    MAX_EVENT_PAGE_SIZE
  );
  const result: {
    range: { from?: string; to?: string };
    eventTypes?: ValidEventFeedType[];
    translatorId?: string;
    page: number;
    pageSize: number;
  } = {
    range: parseDateRange(params),
    page,
    pageSize
  };
  if (eventTypes.length > 0) {
    result.eventTypes = eventTypes;
  }
  if (translatorId) {
    result.translatorId = translatorId;
  }

  return result;
}

function clampBatchSize(raw: string | null): number {
  if (raw === null) {
    return DEFAULT_BACKFILL_BATCH_SIZE;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_BACKFILL_BATCH_SIZE;
  }
  return Math.min(Math.max(parsed, 1), MAX_BACKFILL_BATCH_SIZE);
}

function parseArchivedSummary(value: string): {
  totals: AdminReportSummaryTotals;
  streams: AdminReportStreamSummary[];
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (_error) {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as {
    totals?: unknown;
    streams?: unknown;
  };
  if (
    typeof candidate.totals !== "object" ||
    candidate.totals === null ||
    !Array.isArray(candidate.streams)
  ) {
    return null;
  }

  const totals = candidate.totals as Partial<AdminReportSummaryTotals>;
  return {
    totals: {
      ...totals,
      // Legacy archived snapshots predate uniqueDevices; 0 is the honest
      // default because the original per-device aggregate was never captured.
      uniqueDevices:
        typeof totals.uniqueDevices === "number" &&
        Number.isFinite(totals.uniqueDevices)
          ? totals.uniqueDevices
          : 0
    } as AdminReportSummaryTotals,
    streams: candidate.streams as AdminReportStreamSummary[]
  };
}

async function parseBody<T>(
  request: Request,
  parse: (input: unknown) => T
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
          error instanceof Error ? error.message : "request body is invalid"
      },
      { status: 400 }
    );
  }
}

async function parseVolunteerAccessBody(request: Request): Promise<{
  loginId: string;
  password?: string;
} | Response> {
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (_error) {
    return json({ error: "invalid_json" }, { status: 400 });
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "validation_error" }, { status: 400 });
  }
  const record = body as Record<string, unknown>;
  if (typeof record.loginId !== "string" || record.loginId.trim().length === 0) {
    return json({ error: "validation_error" }, { status: 400 });
  }
  if (record.password !== undefined && typeof record.password !== "string") {
    return json({ error: "validation_error" }, { status: 400 });
  }
  return {
    loginId: record.loginId,
    ...(typeof record.password === "string"
      ? { password: record.password }
      : {})
  };
}

async function parseListenerAccessRevokeBody(request: Request): Promise<{
  clientId: string;
} | Response> {
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (_error) {
    return json({ error: "invalid_json" }, { status: 400 });
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "validation_error" }, { status: 400 });
  }
  const clientId = (body as Record<string, unknown>).clientId;
  if (typeof clientId !== "string" || clientId.trim().length === 0) {
    return json({ error: "validation_error" }, { status: 400 });
  }
  return { clientId };
}

function volunteerAccessResponse(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  response.headers.set("vary", "Cookie");
  return response;
}

function listenerAccessResponse(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  response.headers.set("vary", "Cookie");
  return response;
}

function parseReadinessConfirmInput(body: unknown): {
  itemId: "realtime_smoke_tested" | "mobile_field_tested";
} {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("itemId is required");
  }

  const itemId = (body as Record<string, unknown>).itemId;
  if (typeof itemId !== "string" || !isConfirmableReadinessItem(itemId)) {
    throw new Error(
      "itemId must be realtime_smoke_tested or mobile_field_tested"
    );
  }

  return { itemId };
}

async function translatorExistsInProgram(
  translators: TranslatorRepository,
  programId: string,
  translatorId: string
): Promise<boolean> {
  const records = await translators.listAdminTranslators(programId);
  return records.some((record) => record.id === translatorId);
}

function repositoryErrorResponse(error: unknown): Response {
  if (error instanceof ListenerProgramNotFoundError) {
    return json({ error: "program_not_found" }, { status: 404 });
  }

  if (error instanceof ProgramSlugExistsError) {
    return json({ error: "program_slug_exists" }, { status: 409 });
  }

  if (error instanceof ProgramSlugLockedError) {
    return json({ error: "program_slug_locked" }, { status: 409 });
  }

  if (error instanceof ProgramDeleteLockedError) {
    return json({ error: "program_delete_locked" }, { status: 409 });
  }

  if (error instanceof ProgramHasHistoryError) {
    return json({ error: "program_has_history" }, { status: 409 });
  }

  if (error instanceof StreamHasHistoryError) {
    return json({ error: "stream_has_history" }, { status: 409 });
  }

  if (error instanceof StreamDeleteLockedError) {
    return json({ error: "stream_delete_locked" }, { status: 409 });
  }

  if (error instanceof StreamNotFoundError) {
    return json({ error: "stream_not_found" }, { status: 404 });
  }

  if (error instanceof TranslatorExistsError) {
    return json({ error: "translator_exists" }, { status: 409 });
  }

  if (error instanceof TranslatorDeleteLockedError) {
    return json({ error: "translator_delete_locked" }, { status: 409 });
  }

  if (error instanceof TranslatorAssignmentExistsError) {
    return json({ error: "translator_assignment_exists" }, { status: 409 });
  }

  if (error instanceof TranslatorAssignmentNotFoundError) {
    return json(
      { error: "translator_assignment_not_found" },
      { status: 404 }
    );
  }

  if (error instanceof TranslatorNotFoundError) {
    return json({ error: "translator_not_found" }, { status: 404 });
  }

  if (error instanceof ProgramNotFoundError) {
    return json({ error: "program_not_found" }, { status: 404 });
  }

  return json({ error: "database_error" }, { status: 500 });
}

function publicAdminUser(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    orgId: user.orgId,
    isDisabled: user.isDisabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

type ManageUserScope = "ok" | "not_found" | "forbidden";

function canManageTarget(
  actor: UserAuth,
  target: UserRecord
): ManageUserScope {
  if (actor.role === "platform_admin") {
    return "ok";
  }

  if (actor.role === "viewer") {
    return "forbidden";
  }

  if (target.orgId !== actor.orgId) {
    return "not_found";
  }
  if (target.role !== "viewer") {
    return "forbidden";
  }
  return "ok";
}

async function parseUpdateProgramBody(
  request: Request
): Promise<UpdateProgramInput | Response> {
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (_error) {
    return json({ error: "invalid_json" }, { status: 400 });
  }

  if (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Object.prototype.hasOwnProperty.call(body, "slug")
  ) {
    return json({ error: "slug_immutable" }, { status: 400 });
  }

  try {
    return parseUpdateProgramInput(body);
  } catch (error) {
    return json(
      {
        error: "validation_error",
        message:
          error instanceof Error ? error.message : "request body is invalid"
      },
      { status: 400 }
    );
  }
}

function adminProgramPayload(detail: AdminProgramDetail, origin: string) {
  const publicPath = `/${encodeURIComponent(detail.program.slug)}`;
  const listenerUrl = `${origin}${publicPath}`;
  const translatorUrl = `${listenerUrl}/translate`;

  return {
    program: detail.program,
    streams: detail.streams,
    translators: detail.translators,
    urls: {
      listenerUrl,
      translatorUrl,
      volunteerUrl: `${listenerUrl}/volunteer`
    },
    qrPayload: listenerUrl,
    suggestedQrFilename: `${detail.program.slug}-listener-qr.png`
  };
}

// Best-effort teardown of every stream's LiveKit room for a program, used at
// the program-archive/soft-delete/PATCH-to-non-live points below. LiveKit
// rooms are created implicitly on first participant join, so there is no
// matching "create rooms" call needed at the mirror-image transitions
// (restore-to-live, PATCH-to-live, stream create) -- explicit pre-creation
// would only be useful for a synchronous "the room is ready before anyone
// joins" guarantee, which nothing in this codebase depends on.
async function teardownProgramRoomsBestEffort(
  programs: ProgramRepository,
  roomService: RoomServiceClient,
  programId: string
): Promise<void> {
  try {
    const streams = await programs.listAdminStreams(programId);
    await Promise.all(
      streams.map((stream) =>
        deleteRoomBestEffort(roomService, roomNameForStream(programId, stream.id))
      )
    );
  } catch (error) {
    console.info(
      JSON.stringify({
        level: "info",
        msg: "livekit_teardown_program_rooms_failed",
        programId,
        error: error instanceof Error ? error.message : String(error)
      })
    );
  }
}

async function adminProgramDetailResponse(
  programs: ProgramRepository,
  programId: string,
  origin: string
): Promise<Response> {
  const detail = await programs.getAdminProgramDetail(programId);
  return json(adminProgramPayload(detail, origin));
}

function isRealtimeConfigured(env: Env): boolean {
  return isLiveKitConfigured(env);
}

// LiveKit bundles its own built-in TURN server -- there is no separate TURN
// credential to configure/check the way Cloudflare Realtime needed
// (CLOUDFLARE_TURN_KEY_ID/TOKEN). This mirrors isRealtimeConfigured() rather
// than being removed outright because the readiness checklist
// (domain/readiness.ts) still surfaces "TURN credentials configured" as its
// own line item for operators -- keeping a second (identical) function here
// documents *why* the two flags happen to always agree now, instead of
// leaving a caller to wonder if that's a bug.
function isTurnConfigured(env: Env): boolean {
  return isLiveKitConfigured(env);
}

async function buildReadinessResponse(
  programs: ProgramRepository,
  env: Env,
  programId: string
): Promise<AdminReadinessResponse> {
  const detail = await programs.getAdminProgramDetail(programId);
  const row = await programs.getReadinessChecks(programId);

  const items = buildReadinessItems({
    programName: detail.program.name,
    streams: detail.streams.map((stream) => ({
      id: stream.id,
      languageName: stream.languageName,
      isActive: stream.isActive
    })),
    translators: detail.translators.map((translator) => ({
      assignments: translator.assignments.map((assignment) => ({
        streamId: assignment.streamId
      }))
    })),
    realtimeConfigured: isRealtimeConfigured(env),
    turnConfigured: isTurnConfigured(env),
    row: row
      ? {
          realtimeSmokeTestedAt: row.realtimeSmokeTestedAt,
          mobileFieldTestedAt: row.mobileFieldTestedAt
        }
      : null
  });

  return { programId, items };
}

export async function handleAdminRoutes(
  request: Request,
  env: Env,
  url: URL,
  _ctx: WaitUntilCtx,
  // Defaults to a real RoomServiceClient built from `env`; tests inject a
  // fake directly (see the DI note on handleLiveKitWebhook in
  // livekit/webhook.ts for why -- the same setupFile-eager-import problem
  // rules out `vi.mock` here).
  roomService: RoomServiceClient = createRoomServiceClient(env)
): Promise<Response | null> {
  const programs = new ProgramRepository(env.DB);
  const listeners = new ListenerRepository(env.DB);
  const listenerAccess = new ListenerAccessRepository(env.DB);
  const translators = new TranslatorRepository(env.DB);
  const volunteers = new VolunteerRepository(
    env.DB,
    env.TRANSLATOR_PASSWORD_PEPPER
  );
  const users = new UsersRepository(env.DB);
  let auth: UserAuth | null = null;

  if (request.method === "POST" && url.pathname === "/api/admin/login") {
    return handleLogin(request, env);
  }

  if (request.method === "POST" && url.pathname === "/api/admin/bootstrap") {
    return handleBootstrap(request, env);
  }

  // Logout is intentionally BEFORE the requireUserAuth guard: a user with a
  // stale/expired session must still be able to clear their cookie + session row.
  if (request.method === "POST" && url.pathname === "/api/admin/logout") {
    return handleLogout(request, env);
  }

  if (url.pathname.startsWith("/api/admin/")) {
    const authResult = await requireUserAuth(request, env);
    if (authResult instanceof Response) {
      return authResult;
    }
    auth = authResult;
  }

  const volunteerAccessMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/volunteer-access$/
  );
  if (volunteerAccessMatch) {
    const programId = volunteerAccessMatch[1];
    if (!programId) {
      return null;
    }

    if (request.method === "GET") {
      const access = await requireProgramAccess(programs, programId, auth!, {
        write: false,
        includeDeleted: false
      });
      if (access instanceof Response) {
        return volunteerAccessResponse(access);
      }

      try {
        const [account, activeSessionCount] = await Promise.all([
          volunteers.getAccount(programId),
          volunteers.countActiveSessions(programId)
        ]);
        return volunteerAccessResponse(
          json({
            configured: account !== null,
            loginId: account?.loginId ?? null,
            passwordUpdatedAt: account?.passwordUpdatedAt ?? null,
            activeSessionCount
          })
        );
      } catch (error) {
        return volunteerAccessResponse(repositoryErrorResponse(error));
      }
    }

    if (request.method === "PUT") {
      const access = await requireProgramAccess(programs, programId, auth!, {
        write: true,
        includeDeleted: false
      });
      if (access instanceof Response) {
        return volunteerAccessResponse(access);
      }

      const input = await parseVolunteerAccessBody(request);
      if (input instanceof Response) {
        return volunteerAccessResponse(input);
      }

      try {
        const result = await volunteers.rotateCredential(
          programId,
          input.loginId,
          input.password
        );
        return volunteerAccessResponse(
          json({
            configured: true,
            loginId: result.account.loginId,
            passwordUpdatedAt: result.account.passwordUpdatedAt,
            activeSessionCount: 0,
            ...(result.generatedPassword
              ? { generatedPassword: result.generatedPassword }
              : {})
          })
        );
      } catch (error) {
        if (error instanceof VolunteerPasswordTooShortError) {
          return volunteerAccessResponse(
            json({ error: "validation_error" }, { status: 400 })
          );
        }
        return volunteerAccessResponse(repositoryErrorResponse(error));
      }
    }
  }

  const listenerAccessSummaryMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/listener-access\/summary$/
  );
  if (request.method === "GET" && listenerAccessSummaryMatch) {
    const programId = listenerAccessSummaryMatch[1];
    if (!programId) {
      return null;
    }

    const access = await requireProgramAccess(programs, programId, auth!, {
      write: false,
      includeDeleted: false
    });
    if (access instanceof Response) {
      return listenerAccessResponse(access);
    }

    try {
      return listenerAccessResponse(
        json(await listenerAccess.countByStatus(programId))
      );
    } catch (error) {
      return listenerAccessResponse(repositoryErrorResponse(error));
    }
  }

  const listenerAccessRevokeMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/listener-access\/revoke$/
  );
  if (request.method === "POST" && listenerAccessRevokeMatch) {
    const programId = listenerAccessRevokeMatch[1];
    if (!programId) {
      return null;
    }

    const access = await requireProgramAccess(programs, programId, auth!, {
      write: true,
      includeDeleted: false
    });
    if (access instanceof Response) {
      return listenerAccessResponse(access);
    }

    const input = await parseListenerAccessRevokeBody(request);
    if (input instanceof Response) {
      return listenerAccessResponse(input);
    }

    try {
      return listenerAccessResponse(
        json({
          revoked: await listenerAccess.revokeForClient(
            programId,
            input.clientId
          )
        })
      );
    } catch (error) {
      return listenerAccessResponse(repositoryErrorResponse(error));
    }
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/admin/me/password"
  ) {
    return handleChangeOwnPassword(request, env);
  }

  if (request.method === "GET" && url.pathname === "/api/admin/me") {
    try {
      const actor = await users.getUserById(auth!.userId);
      if (!actor) {
        return json({ error: "admin_not_found" }, { status: 401 });
      }

      const org = actor.orgId ? await users.getOrg(actor.orgId) : null;
      return json({
        id: actor.id,
        email: actor.email,
        role: actor.role,
        orgId: actor.orgId,
        orgName: org ? org.name : null
      });
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/admin/orgs") {
    if (auth!.role !== "platform_admin") {
      return json({ error: "admin_role_required" }, { status: 403 });
    }

    const input = await parseBody(request, parseCreateOrgInput);
    if (input instanceof Response) {
      return input;
    }

    try {
      const { org, admin } = await users.createOrgWithOrgAdmin({
        orgName: input.orgName,
        adminEmail: input.email
      });
      await users.setPassword(admin.id, input.tempPassword);

      return json(
        {
          org: { id: org.id, name: org.name },
          admin: {
            id: admin.id,
            email: admin.email,
            role: admin.role,
            orgId: admin.orgId
          }
        },
        { status: 201 }
      );
    } catch (error) {
      if (isEmailConflict(error) || isOrgAdminConflict(error)) {
        return json({ error: "email_taken" }, { status: 409 });
      }
      return repositoryErrorResponse(error);
    }
  }

  if (request.method === "GET" && url.pathname === "/api/admin/orgs") {
    if (auth!.role !== "platform_admin") {
      return json({ error: "admin_role_required" }, { status: 403 });
    }

    try {
      return json({ orgs: await users.listOrgs() });
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const orgMatch = url.pathname.match(/^\/api\/admin\/orgs\/([^/]+)$/);
  if (request.method === "PATCH" && orgMatch) {
    if (auth!.role !== "platform_admin") {
      return json({ error: "admin_role_required" }, { status: 403 });
    }

    const orgId = orgMatch[1];
    if (!orgId) {
      return null;
    }

    const input = await parseBody(request, parseUpdateOrgInput);
    if (input instanceof Response) {
      return input;
    }

    const org = await users.updateOrg(orgId, input);
    if (!org) {
      return json({ error: "org_not_found" }, { status: 404 });
    }

    return json(org);
  }

  if (request.method === "GET" && url.pathname === "/api/admin/users") {
    if (auth!.role === "viewer") {
      return json({ error: "admin_role_required" }, { status: 403 });
    }

    try {
      if (auth!.role !== "platform_admin" && !auth!.orgId) {
        return json({ error: "admin_role_required" }, { status: 403 });
      }

      const list =
        auth!.role === "platform_admin"
          ? await users.listUsers()
          : await users.listUsers({
              orgId: auth!.orgId,
              role: "viewer"
            });
      return json({ users: list.map(publicAdminUser) });
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/admin/users") {
    if (auth!.role === "viewer") {
      return json({ error: "admin_role_required" }, { status: 403 });
    }

    const input = await parseBody(request, parseCreateUserInput);
    if (input instanceof Response) {
      return input;
    }

    if (auth!.role === "org_admin") {
      if (!auth!.orgId) {
        return json({ error: "admin_role_required" }, { status: 403 });
      }
      if (input.role !== "viewer") {
        return json({ error: "admin_role_required" }, { status: 403 });
      }
      input.orgId = auth!.orgId;
    } else if (input.role === "platform_admin" && input.orgId !== null) {
      return json(
        { error: "validation_error", message: "platform_admin users do not belong to orgs" },
        { status: 400 }
      );
    } else if (input.role !== "platform_admin") {
      if (input.orgId === null) {
        return json(
          { error: "validation_error", message: "orgId is required" },
          { status: 400 }
        );
      }
      const org = await users.getOrg(input.orgId);
      if (!org) {
        return json({ error: "org_not_found" }, { status: 404 });
      }
    }

    try {
      const newUser = await users.createUser({
        email: input.email,
        role: input.role,
        orgId: input.orgId
      });
      await users.setPassword(newUser.id, input.tempPassword);
      return json(publicAdminUser(newUser), { status: 201 });
    } catch (error) {
      if (isEmailConflict(error)) {
        return json({ error: "email_taken" }, { status: 409 });
      }
      if (isOrgAdminConflict(error)) {
        return json({ error: "org_admin_exists" }, { status: 409 });
      }
      return repositoryErrorResponse(error);
    }
  }

  const resetPasswordMatch = url.pathname.match(
    /^\/api\/admin\/users\/([^/]+)\/password$/
  );
  if (request.method === "POST" && resetPasswordMatch) {
    if (auth!.role === "viewer") {
      return json({ error: "admin_role_required" }, { status: 403 });
    }

    const userId = resetPasswordMatch[1];
    if (!userId) {
      return null;
    }

    const input = await parseBody(request, parseResetPasswordInput);
    if (input instanceof Response) {
      return input;
    }

    const target = await users.getUserById(userId);
    if (!target) {
      return json({ error: "user_not_found" }, { status: 404 });
    }

    const scope = canManageTarget(auth!, target);
    if (scope === "not_found") {
      return json({ error: "not_found" }, { status: 404 });
    }
    if (scope === "forbidden") {
      return json({ error: "admin_role_required" }, { status: 403 });
    }

    try {
      await users.setPassword(userId, input.newPassword);
      await users.deleteSessionsForUser(userId);
      return json({ ok: true });
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const userMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (request.method === "PATCH" && userMatch) {
    if (auth!.role === "viewer") {
      return json({ error: "admin_role_required" }, { status: 403 });
    }

    const userId = userMatch[1];
    if (!userId) {
      return null;
    }

    const target = await users.getUserById(userId);
    if (!target) {
      return json({ error: "user_not_found" }, { status: 404 });
    }

    const scope = canManageTarget(auth!, target);
    if (scope === "not_found") {
      return json({ error: "not_found" }, { status: 404 });
    }
    if (scope === "forbidden") {
      return json({ error: "admin_role_required" }, { status: 403 });
    }

    const input = await parseBody(request, parseUpdateUserInput);
    if (input instanceof Response) {
      return input;
    }

    if (auth!.role === "org_admin" && input.role !== undefined) {
      return json({ error: "admin_role_required" }, { status: 403 });
    }

    // Pre-validate the post-patch role/org SHAPE so a boundary-crossing role
    // change returns a clean 400 instead of hitting the DB CHECK → 500. This
    // endpoint can't change org_id, so the only shape-affecting field is role:
    // platform_admin ⇒ org_id must be NULL; org_admin/viewer ⇒ org_id non-null.
    if (input.role !== undefined) {
      const wouldBePlatform = input.role === "platform_admin";
      const hasOrg = target.orgId !== null;
      if (wouldBePlatform && hasOrg) {
        return json(
          {
            error: "validation_error",
            message:
              "cannot promote an org-scoped user to platform_admin (org_id cannot be changed here)"
          },
          { status: 400 }
        );
      }
      if (!wouldBePlatform && !hasOrg) {
        return json(
          {
            error: "validation_error",
            message:
              "cannot change a platform_admin to an org role (org_id cannot be assigned here)"
          },
          { status: 400 }
        );
      }
    }

    try {
      const updated = await users.updateUser(userId, input);
      if (!updated) {
        return json({ error: "user_not_found" }, { status: 404 });
      }
      if (input.isDisabled === true && !target.isDisabled) {
        await users.deleteSessionsForUser(userId);
      }
      return json(publicAdminUser(updated));
    } catch (error) {
      if (isOrgAdminConflict(error)) {
        return json({ error: "org_admin_exists" }, { status: 409 });
      }
      // Backstop: any residual role/org-shape CHECK violation → 400, not 500.
      if (
        error instanceof Error &&
        error.message.includes("CHECK constraint failed")
      ) {
        return json({ error: "validation_error" }, { status: 400 });
      }
      return repositoryErrorResponse(error);
    }
  }

  if (request.method === "GET" && url.pathname === "/api/admin/programs") {
    try {
      const deleted = url.searchParams.get("deleted") === "true";
      // Fail closed: a non-platform principal MUST be org-scoped. The DB CHECK
      // guarantees org_admin/viewer carry a non-null org_id, but never let a
      // missing org_id silently widen the listing to every org.
      let scopedOrgId: string | undefined;
      if (auth!.role === "platform_admin") {
        scopedOrgId = undefined;
      } else {
        if (!auth!.orgId) {
          return json({ error: "forbidden" }, { status: 403 });
        }
        scopedOrgId = auth!.orgId;
      }
      const listOptions =
        scopedOrgId === undefined
          ? { deletedOnly: deleted }
          : { deletedOnly: deleted, orgId: scopedOrgId };
      return json({ programs: await programs.listPrograms(listOptions) });
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/admin/programs") {
    if (auth!.role !== "org_admin") {
      return json(
        {
          error: "forbidden",
          message: "only an org admin can create programs"
        },
        { status: 403 }
      );
    }

    // Fail closed: an org_admin without a non-null org_id is a corrupt session
    // (DB CHECK forbids it). Never bind a NULL org_id onto a new program.
    const creatorOrgId = auth!.orgId;
    if (!creatorOrgId) {
      return json({ error: "forbidden" }, { status: 403 });
    }

    const input = await parseBody(request, parseCreateProgramInput);
    if (input instanceof Response) {
      return input;
    }

    try {
      return json(
        await programs.createProgram(input, creatorOrgId),
        { status: 201 }
      );
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const programDetailMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)$/
  );
  if (programDetailMatch) {
    const programId = programDetailMatch[1];
    if (!programId) {
      return null;
    }

    if (request.method === "GET") {
      const access = await requireProgramAccess(programs, programId, auth!, {
        write: false,
        includeDeleted: false
      });
      if (access instanceof Response) {
        return access;
      }

      try {
        return await adminProgramDetailResponse(programs, programId, url.origin);
      } catch (error) {
        return repositoryErrorResponse(error);
      }
    }

    if (request.method === "PATCH") {
      const access = await requireProgramAccess(programs, programId, auth!, {
        write: true,
        includeDeleted: false
      });
      if (access instanceof Response) {
        return access;
      }

      const input = await parseUpdateProgramBody(request);
      if (input instanceof Response) {
        return input;
      }

      try {
        const updateResult = await programs.updateProgram(programId, input);
        // LiveKit rooms are created implicitly on join, so there's nothing to
        // do on a transition INTO "live" -- but a transition OUT of "live"
        // (back to draft, or archived via this generic PATCH rather than the
        // dedicated /archive endpoint) should proactively tear down any
        // rooms so no stray publisher/listener lingers in a room whose
        // program the admin just took off the air.
        if (
          updateResult.previousStatus === "live" &&
          updateResult.record.status !== "live"
        ) {
          await teardownProgramRoomsBestEffort(programs, roomService, programId);
        }

        return await adminProgramDetailResponse(programs, programId, url.origin);
      } catch (error) {
        return repositoryErrorResponse(error);
      }
    }

    if (request.method === "DELETE") {
      const access = await requireProgramAccess(programs, programId, auth!, {
        write: true,
        includeDeleted: true
      });
      if (access instanceof Response) {
        return access;
      }

      try {
        const program = access;

        if (program.status === "draft") {
          await programs.deleteDraftProgram(programId);
          return new Response(null, { status: 204 });
        }

        const realtime = new RealtimeStreamRepository(env.DB);
        const wasLive = program.status === "live";
        await programs.softDeleteProgram(programId);

        if (wasLive) {
          try {
            await realtime.clearProgramStreamsLive(programId);
          } catch (error) {
            console.error("admin program soft-delete clear streams live failed", error);
          }

          await teardownProgramRoomsBestEffort(programs, roomService, programId);
        }

        return new Response(null, { status: 200 });
      } catch (error) {
        return repositoryErrorResponse(error);
      }
    }
  }

  const restoreMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/restore$/
  );
  if (request.method === "POST" && restoreMatch) {
    const programId = restoreMatch[1];
    if (!programId) {
      return null;
    }

    const access = await requireProgramAccess(programs, programId, auth!, {
      write: true,
      includeDeleted: true
    });
    if (access instanceof Response) {
      return access;
    }

    try {
      await programs.restoreProgram(programId);
      // No explicit LiveKit room (re-)creation needed here -- rooms are
      // created implicitly on first participant join, unlike the old
      // Cloudflare-Realtime StreamRelay which needed a synchronous
      // ensureProgramActiveStreamRelays call to pre-provision relay state.
      return new Response(null, { status: 200 });
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const archiveMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/archive$/
  );
  if (request.method === "POST" && archiveMatch) {
    const programId = archiveMatch[1];
    if (!programId) {
      return null;
    }

    const access = await requireProgramAccess(programs, programId, auth!, {
      write: true,
      includeDeleted: false
    });
    if (access instanceof Response) {
      return access;
    }

    try {
      // Capture the aggregate summary snapshot before archiving so archived
      // reports keep the live D1 window count at archive time.
      const aggregates = await listeners.getProgramReportAggregates(programId);
      const activeListeners = await resolveActiveListenerCount(
        env,
        programId,
        await listeners.countActiveListeners(
          programId,
          ACTIVE_LISTENER_WINDOW_SECONDS
        )
      );
      const activeListenersByStream = new Map(
        activeListeners.streams.map((stream) => [stream.streamId, stream.count])
      );
      const snapshot: {
        totals: AdminReportSummaryTotals;
        streams: AdminReportStreamSummary[];
      } = {
        totals: {
          activeListeners: activeListeners.total,
          totalConnections: aggregates.totals.totalConnections,
          uniqueDevices: aggregates.totals.uniqueDevices,
          dropouts: aggregates.totals.dropouts,
          reconnects: aggregates.totals.reconnects
        },
        streams: aggregates.streams.map((stream) => ({
          streamId: stream.streamId,
          languageName: stream.languageName,
          languageCode: stream.languageCode,
          activeListeners:
            activeListenersByStream.get(stream.streamId) ?? 0,
          totalConnections: stream.totalConnections,
          dropouts: stream.dropouts,
          reconnects: stream.reconnects
        }))
      };

      await programs.archiveProgram(programId, JSON.stringify(snapshot));
      const realtime = new RealtimeStreamRepository(env.DB);
      await realtime.clearProgramStreamsLive(programId);

      await teardownProgramRoomsBestEffort(programs, roomService, programId);

      return await adminProgramDetailResponse(programs, programId, url.origin);
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const listenerReportMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/listener-report$/
  );
  if (request.method === "GET" && listenerReportMatch) {
    const programId = listenerReportMatch[1];
    if (!programId) {
      return null;
    }

    const access = await requireProgramAccess(programs, programId, auth!, {
      write: false,
      includeDeleted: false
    });
    if (access instanceof Response) {
      return access;
    }

    try {
      const readDb = env.DB;
      const listeners = new ListenerRepository(readDb);
      const { filters, page } = parseListenerReportQuery(url.searchParams);
      const result = await listeners.listProgramConnectionsPage(
        programId,
        filters,
        page
      );
      return json(result);
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const listenerReportCsvMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/listener-report\.csv$/
  );
  if (request.method === "GET" && listenerReportCsvMatch) {
    const programId = listenerReportCsvMatch[1];
    if (!programId) {
      return null;
    }

    const access = await requireProgramAccess(programs, programId, auth!, {
      write: false,
      includeDeleted: false
    });
    if (access instanceof Response) {
      return access;
    }

    try {
      const readDb = env.DB;
      const listeners = new ListenerRepository(readDb);
      const program = access;

      const { filters } = parseListenerReportQuery(url.searchParams);
      const { connections, truncated } = await listeners.listProgramConnectionsForCsv(
        programId,
        filters
      );
      const csv = listenerConnectionsToCsv(
        connections.map((connection) => ({
          id: connection.id,
          clientId: connection.clientId,
          streamId: connection.streamId,
          connectedAt: connection.connectedAt,
          disconnectedAt: connection.disconnectedAt,
          disconnectReason: connection.disconnectReason,
          listenerIp: connection.listenerIp,
          userAgent: connection.userAgent,
          deviceModel: connection.deviceModel,
          deviceModelName: connection.deviceModelName,
          platform: connection.platform,
          platformVersion: connection.platformVersion,
          browserFullVersion: connection.browserFullVersion,
          approvalStatus: connection.approvalStatus,
          approvedAt: connection.approvedAt,
          approvedVia: connection.approvedVia
        }))
      );

      const reportNotes = truncated
        ? `${CSV_REPORT_NOTES} (truncated to ${MAX_CSV_ROWS} rows)`
        : CSV_REPORT_NOTES;

      return new Response(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${program.slug}-listener-report.csv"`,
          "x-report-notes": reportNotes
        }
      });
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const backfillDeviceLabelsMatch = url.pathname.match(
    /^\/api\/admin\/maintenance\/backfill-device-labels$/
  );
  if (request.method === "POST" && backfillDeviceLabelsMatch) {
    const batchSize = clampBatchSize(url.searchParams.get("batchSize"));
    try {
      const { updated, remaining } = await listeners.backfillDeviceLabels(batchSize);
      return json({ updated, remaining });
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const reportSummaryMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/report\/summary$/
  );
  if (request.method === "GET" && reportSummaryMatch) {
    const programId = reportSummaryMatch[1];
    if (!programId) {
      return null;
    }

    const access = await requireProgramAccess(programs, programId, auth!, {
      write: false,
      includeDeleted: false
    });
    if (access instanceof Response) {
      return access;
    }

    try {
      const readDb = env.DB;
      const listeners = new ListenerRepository(readDb);
      const program = access;

      if (program.status === "archived" && program.aggregateSummaryJson) {
        const snapshot = parseArchivedSummary(program.aggregateSummaryJson);
        if (snapshot) {
          return json({
            programId,
            totals: snapshot.totals,
            streams: snapshot.streams,
            generatedAt: new Date().toISOString(),
            presenceSource: "archived_snapshot"
          });
        }
      }

      const range = parseDateRange(url.searchParams);
      const aggregates = await listeners.getProgramReportAggregates(
        programId,
        range
      );
      const presence = await readPresenceStatusSnapshot(env, programId);

      const activeListeners = await resolveActiveListenerCount(
        env,
        programId,
        await listeners.countActiveListeners(
          programId,
          ACTIVE_LISTENER_WINDOW_SECONDS
        )
      );
      const activeListenersByStream = new Map(
        activeListeners.streams.map((stream) => [stream.streamId, stream.count])
      );

      return json({
        programId,
        totals: {
          activeListeners: activeListeners.total,
          totalConnections: aggregates.totals.totalConnections,
          uniqueDevices: aggregates.totals.uniqueDevices,
          dropouts: aggregates.totals.dropouts,
          reconnects: aggregates.totals.reconnects
        },
        streams: aggregates.streams.map((stream) => ({
          streamId: stream.streamId,
          languageName: stream.languageName,
          languageCode: stream.languageCode,
          activeListeners: activeListenersByStream.get(stream.streamId) ?? 0,
          totalConnections: stream.totalConnections,
          dropouts: stream.dropouts,
          reconnects: stream.reconnects
        })),
        generatedAt: presence.serverTime,
        // `presenceSource` tracks the provenance of presence state and generatedAt
        // (still sourced from Durable Object snapshots); active-listener counts
        // are read independently from the D1 rolling window aggregate.
        presenceSource: "durable_object"
      });
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const eventsMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/events$/
  );
  if (request.method === "GET" && eventsMatch) {
    const programId = eventsMatch[1];
    if (!programId) {
      return null;
    }

    const access = await requireProgramAccess(programs, programId, auth!, {
      write: false,
      includeDeleted: false
    });
    if (access instanceof Response) {
      return access;
    }

    try {
      const readDb = env.DB;
      const listeners = new ListenerRepository(readDb);

      return json(
        await listeners.listProgramEventsPage(
          programId,
          parseEventFeedQuery(url.searchParams)
        )
      );
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const readinessConfirmMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/readiness\/confirm$/
  );
  if (request.method === "POST" && readinessConfirmMatch) {
    const programId = readinessConfirmMatch[1];
    if (!programId) {
      return null;
    }

    const access = await requireProgramAccess(programs, programId, auth!, {
      write: true,
      includeDeleted: false
    });
    if (access instanceof Response) {
      return access;
    }

    const input = await parseBody(request, parseReadinessConfirmInput);
    if (input instanceof Response) {
      return input;
    }

    try {
      const column =
        input.itemId === "realtime_smoke_tested"
          ? "realtime_smoke_tested_at"
          : "mobile_field_tested_at";
      await programs.confirmReadinessCheck(
        programId,
        column,
        new Date().toISOString()
      );

      return json(await buildReadinessResponse(programs, env, programId));
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const readinessMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/readiness$/
  );
  if (request.method === "GET" && readinessMatch) {
    const programId = readinessMatch[1];
    if (!programId) {
      return null;
    }

    const access = await requireProgramAccess(programs, programId, auth!, {
      write: false,
      includeDeleted: false
    });
    if (access instanceof Response) {
      return access;
    }

    try {
      return json(await buildReadinessResponse(programs, env, programId));
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const retentionRunMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/retention\/run$/
  );
  if (request.method === "POST" && retentionRunMatch) {
    const programId = retentionRunMatch[1];
    if (!programId) {
      return null;
    }

    const access = await requireProgramAccess(programs, programId, auth!, {
      write: true,
      includeDeleted: false
    });
    if (access instanceof Response) {
      return access;
    }

    try {
      const program = access;

      const now = new Date();
      const eligible = isRetentionEligible({
        status: program.status,
        archivedAt: program.archivedAt,
        retentionProcessedAt: program.retentionProcessedAt,
        now
      });

      if (!eligible) {
        return json({
          programId,
          processed: false,
          anonymizedConnections: 0,
          retentionProcessedAt: program.retentionProcessedAt
        });
      }

      const anonymizedConnections = await listeners.anonymizeProgramTelemetry(
        programId,
        now
      );
      const retentionProcessedAt = now.toISOString();
      await programs.markRetentionProcessed(programId, retentionProcessedAt);

      return json({
        programId,
        processed: true,
        anonymizedConnections,
        retentionProcessedAt
      });
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const statusMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/status$/
  );
  if (request.method === "GET" && statusMatch) {
    const programId = statusMatch[1];
    if (!programId) {
      return null;
    }

    const access = await requireProgramAccess(programs, programId, auth!, {
      write: false,
      includeDeleted: false
    });
    if (access instanceof Response) {
      return access;
    }

    try {
      const readDb = env.DB;
      const programs = new ProgramRepository(readDb);
      const listeners = new ListenerRepository(readDb);
      const realtime = new RealtimeStreamRepository(readDb);
      const [program, streams, presence, activePublishers, activeListeners] =
        await Promise.all([
          programs.getProgramById(programId),
          programs.listAdminStreams(programId),
          readPresenceStatusSnapshot(env, programId),
          realtime.listActivePublishers(programId),
          listeners
            .countActiveListeners(programId, ACTIVE_LISTENER_WINDOW_SECONDS)
            .then((d1Count) => resolveActiveListenerCount(env, programId, d1Count))
        ]);
      if (!program) {
        return json({ error: "program_not_found" }, { status: 404 });
      }
    const activeListenersByStream = new Map(
      activeListeners.streams.map((stream) => [stream.streamId, stream.count])
    );

      const publishSessionByStream = new Map(
        activePublishers.map((publisher) => [
          publisher.streamId,
          publisher.publishSessionId
        ])
      );
      const now = Date.parse(presence.serverTime);

      return json({
        programId,
        totalActiveListeners: activeListeners.total,
        streams: streams.map((stream) => ({
          id: stream.id,
          languageName: stream.languageName,
          languageCode: stream.languageCode,
          isActive: stream.isActive,
          // "Confirmed publisher" (currentPublishSessionId) is set by
          // livekit/webhook.ts's track_published handling once a
          // translator's audio track is actually flowing -- see
          // realtimeStreamRepository.ts's markPublisherTrackLive and
          // listActivePublishers.
          state: deriveStreamState({
            currentPublishSessionId:
              publishSessionByStream.get(stream.id) ?? null,
            audioActivity: presence.audioActivity[stream.id],
            now,
            degraded: presence.degraded
          }),
          activeListeners: activeListenersByStream.get(stream.id) ?? 0
        })),
        stale: presence.stale,
        degraded: presence.degraded,
        updatedAt: presence.updatedAt,
        serverTime: presence.serverTime
      });
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const translatorSessionsMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/translators\/([^/]+)\/sessions$/
  );
  if (request.method === "GET" && translatorSessionsMatch) {
    const [, programId, translatorId] = translatorSessionsMatch;
    if (!programId || !translatorId) {
      return null;
    }

    const access = await requireProgramAccess(programs, programId, auth!, {
      write: false,
      includeDeleted: false
    });
    if (access instanceof Response) {
      return access;
    }

    try {
      if (!(await translatorExistsInProgram(translators, programId, translatorId))) {
        return json({ error: "translator_not_found" }, { status: 404 });
      }

      return json({
        sessions: await translators.listSessionsForTranslator(programId, translatorId)
      });
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const translatorSessionMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/translators\/([^/]+)\/sessions\/([^/]+)$/
  );
  if (request.method === "DELETE" && translatorSessionMatch) {
    const [, programId, translatorId, sessionId] = translatorSessionMatch;
    if (!programId || !translatorId || !sessionId) {
      return null;
    }

    const access = await requireProgramAccess(programs, programId, auth!, {
      write: true,
      includeDeleted: false
    });
    if (access instanceof Response) {
      return access;
    }

    const realtime = new RealtimeStreamRepository(env.DB);

    try {
      if (!(await translatorExistsInProgram(translators, programId, translatorId))) {
        return json({ error: "translator_not_found" }, { status: 404 });
      }

      const freed = await translators.revokeSession(
        realtime,
        programId,
        translatorId,
        sessionId
      );
      if (freed) {
        await removeParticipantBestEffort(
          roomService,
          roomNameForStream(programId, freed.streamId),
          translatorIdentity(translatorId)
        );
      }

      console.info(
        JSON.stringify({
          action: "revoke_session",
          programId,
          target: translatorId,
          at: new Date().toISOString()
        })
      );

      return json({ ok: true });
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const translatorSessionsCollectionMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/translators\/([^/]+)\/sessions$/
  );
  if (request.method === "DELETE" && translatorSessionsCollectionMatch) {
    const [, programId, translatorId] = translatorSessionsCollectionMatch;
    if (!programId || !translatorId) {
      return null;
    }

    const access = await requireProgramAccess(programs, programId, auth!, {
      write: true,
      includeDeleted: false
    });
    if (access instanceof Response) {
      return access;
    }

    const realtime = new RealtimeStreamRepository(env.DB);

    try {
      if (!(await translatorExistsInProgram(translators, programId, translatorId))) {
        return json({ error: "translator_not_found" }, { status: 404 });
      }

      const freed = await translators.revokeAllSessionsForTranslator(
        realtime,
        programId,
        translatorId
      );
      await Promise.all(
        freed.map((entry) =>
          removeParticipantBestEffort(
            roomService,
            roomNameForStream(programId, entry.streamId),
            translatorIdentity(translatorId)
          )
        )
      );

      console.info(
        JSON.stringify({
          action: "revoke_all",
          programId,
          target: translatorId,
          at: new Date().toISOString()
        })
      );

      return json({ ok: true });
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const kickPublisherMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/streams\/([^/]+)\/kick-publisher$/
  );
  if (request.method === "POST" && kickPublisherMatch) {
    const [, programId, streamId] = kickPublisherMatch;
    if (!programId || !streamId) {
      return null;
    }

    const access = await requireProgramAccess(programs, programId, auth!, {
      write: true,
      includeDeleted: false
    });
    if (access instanceof Response) {
      return access;
    }

    const realtime = new RealtimeStreamRepository(env.DB);
    let signOut = false;
    try {
      const body = await request.json();
      if (body !== null && typeof body === "object" && !Array.isArray(body)) {
        signOut = (body as { signOut?: unknown }).signOut === true;
      }
    } catch (_error) {
      signOut = false;
    }

    try {
      const freed = await realtime.clearPublisherForStream(programId, streamId);
      if (!freed) {
        console.info(
          JSON.stringify({
            action: "kick_publisher",
            programId,
            target: streamId,
            at: new Date().toISOString()
          })
        );
        return json({ freed: false });
      }

      if (signOut && freed.translatorSessionId) {
        await translators.revokeSession(
          realtime,
          programId,
          freed.translatorId,
          freed.translatorSessionId
        );
      }

      await removeParticipantBestEffort(
        roomService,
        roomNameForStream(programId, streamId),
        translatorIdentity(freed.translatorId)
      );

      console.info(
        JSON.stringify({
          action: "kick_publisher",
          programId,
          target: streamId,
          at: new Date().toISOString()
        })
      );

      return json({ freed: true });
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const streamMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/streams$/
  );
  if (streamMatch) {
    const programId = streamMatch[1];
    if (!programId) {
      return null;
    }

    if (request.method === "GET") {
      const access = await requireProgramAccess(programs, programId, auth!, {
        write: false,
        includeDeleted: false
      });
      if (access instanceof Response) {
        return access;
      }

      try {
        return json({ streams: await programs.listAdminStreams(programId) });
      } catch (error) {
        return repositoryErrorResponse(error);
      }
    }

    if (request.method === "POST") {
      const access = await requireProgramAccess(programs, programId, auth!, {
        write: true,
        includeDeleted: false
      });
      if (access instanceof Response) {
        return access;
      }

      const input = await parseBody(request, parseCreateStreamInput);
      if (input instanceof Response) {
        return input;
      }

      try {
        const stream = await programs.createStream(programId, input);
        // No explicit LiveKit room creation needed here (unlike the old
        // Cloudflare-Realtime ensureStreamRelay, which had to synchronously
        // provision relay state) -- the room is created implicitly the
        // first time a translator or listener joins it.

        return json(stream, {
          status: 201
        });
      } catch (error) {
        return repositoryErrorResponse(error);
      }
    }
  }

  const streamItemMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/streams\/([^/]+)$/
  );
  if (streamItemMatch) {
    const [, programId, streamId] = streamItemMatch;
    if (!programId || !streamId) {
      return null;
    }

    if (request.method === "PATCH") {
      const access = await requireProgramAccess(programs, programId, auth!, {
        write: true,
        includeDeleted: false
      });
      if (access instanceof Response) {
        return access;
      }

      const input = await parseBody(request, parseUpdateStreamInput);
      if (input instanceof Response) {
        return input;
      }

      try {
        return json(await programs.updateStream(programId, streamId, input));
      } catch (error) {
        return repositoryErrorResponse(error);
      }
    }

    if (request.method === "DELETE") {
      const access = await requireProgramAccess(programs, programId, auth!, {
        write: true,
        includeDeleted: false
      });
      if (access instanceof Response) {
        return access;
      }

      try {
        await programs.deleteStream(programId, streamId);
        await deleteRoomBestEffort(roomService, roomNameForStream(programId, streamId));
        return new Response(null, { status: 204 });
      } catch (error) {
        return repositoryErrorResponse(error);
      }
    }
  }

  const translatorCollectionMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/translators$/
  );
  if (translatorCollectionMatch) {
    const programId = translatorCollectionMatch[1];
    if (!programId) {
      return null;
    }

    if (request.method === "GET") {
      const access = await requireProgramAccess(programs, programId, auth!, {
        write: false,
        includeDeleted: false
      });
      if (access instanceof Response) {
        return access;
      }

      try {
        return json({
          translators: await translators.listAdminTranslators(programId)
        });
      } catch (error) {
        return repositoryErrorResponse(error);
      }
    }

    if (request.method === "POST") {
      const access = await requireProgramAccess(programs, programId, auth!, {
        write: true,
        includeDeleted: false
      });
      if (access instanceof Response) {
        return access;
      }

      const input = await parseBody(request, parseCreateTranslatorInput);
      if (input instanceof Response) {
        return input;
      }

      try {
        return json(
          await translators.createAdminTranslator(
            programId,
            input,
            env.TRANSLATOR_PASSWORD_PEPPER
          ),
          { status: 201 }
        );
      } catch (error) {
        return repositoryErrorResponse(error);
      }
    }
  }

  const translatorResetPasswordMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/translators\/([^/]+)\/reset-password$/
  );
  if (request.method === "POST" && translatorResetPasswordMatch) {
    const [, programId, translatorId] = translatorResetPasswordMatch;
    if (!programId || !translatorId) {
      return null;
    }

    const access = await requireProgramAccess(programs, programId, auth!, {
      write: true,
      includeDeleted: false
    });
    if (access instanceof Response) {
      return access;
    }

    const input = await parseBody(request, parseResetTranslatorPasswordInput);
    if (input instanceof Response) {
      return input;
    }

    try {
      return json(
        await translators.resetAdminTranslatorPassword(
          programId,
          translatorId,
          input,
          env.TRANSLATOR_PASSWORD_PEPPER
        )
      );
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const translatorAssignmentCollectionMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/translators\/([^/]+)\/assignments$/
  );
  if (request.method === "POST" && translatorAssignmentCollectionMatch) {
    const [, programId, translatorId] = translatorAssignmentCollectionMatch;
    if (!programId || !translatorId) {
      return null;
    }

    const access = await requireProgramAccess(programs, programId, auth!, {
      write: true,
      includeDeleted: false
    });
    if (access instanceof Response) {
      return access;
    }

    const input = await parseBody(request, parseCreateTranslatorAssignmentInput);
    if (input instanceof Response) {
      return input;
    }

    try {
      return json(
        await translators.createAdminTranslatorAssignment(
          programId,
          translatorId,
          input
        ),
        { status: 201 }
      );
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const translatorAssignmentItemMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/translators\/([^/]+)\/assignments\/([^/]+)$/
  );
  if (request.method === "DELETE" && translatorAssignmentItemMatch) {
    const [, programId, translatorId, streamId] = translatorAssignmentItemMatch;
    if (!programId || !translatorId || !streamId) {
      return null;
    }

    const access = await requireProgramAccess(programs, programId, auth!, {
      write: true,
      includeDeleted: false
    });
    if (access instanceof Response) {
      return access;
    }

    try {
      return json(
        await translators.deleteAdminTranslatorAssignment(
          programId,
          translatorId,
          streamId
        )
      );
    } catch (error) {
      return repositoryErrorResponse(error);
    }
  }

  const translatorItemMatch = url.pathname.match(
    /^\/api\/admin\/programs\/([^/]+)\/translators\/([^/]+)$/
  );
  if (translatorItemMatch) {
    const [, programId, translatorId] = translatorItemMatch;
    if (!programId || !translatorId) {
      return null;
    }

    if (request.method === "PATCH") {
      const access = await requireProgramAccess(programs, programId, auth!, {
        write: true,
        includeDeleted: false
      });
      if (access instanceof Response) {
        return access;
      }

      const input = await parseBody(request, parseUpdateTranslatorInput);
      if (input instanceof Response) {
        return input;
      }

      try {
        return json(
          await translators.updateAdminTranslator(programId, translatorId, input)
        );
      } catch (error) {
        return repositoryErrorResponse(error);
      }
    }

    if (request.method === "DELETE") {
      const access = await requireProgramAccess(programs, programId, auth!, {
        write: true,
        includeDeleted: false
      });
      if (access instanceof Response) {
        return access;
      }

      try {
        await translators.deleteAdminTranslator(programId, translatorId);
        return new Response(null, { status: 204 });
      } catch (error) {
        return repositoryErrorResponse(error);
      }
    }
  }

  return null;
}
