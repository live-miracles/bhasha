import { sha256Hex } from "../auth/crypto";
import {
  clearVolunteerSessionCookie,
  requireVolunteerService,
  requireVolunteerSession,
  volunteerSessionCookie
} from "../auth/volunteerAuth";
import { ListenerAccessRepository } from "../db/listenerAccessRepository";
import { ProgramRepository } from "../db/programRepository";
import { VolunteerRepository } from "../db/volunteerRepository";
import type { Env } from "../env";
import { json, readJson, type WaitUntilCtx } from "../http";

interface VolunteerLoginInput {
  programSlug: string;
  loginId: string;
  password: string;
}

type VolunteerApprovalInput =
  | { claimId: string }
  | { shortCode: string };

export async function handleVolunteerRoutes(
  request: Request,
  env: Env,
  url: URL,
  _ctx: WaitUntilCtx
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/volunteer/")) {
    return null;
  }

  const service = requireVolunteerService(env);
  if (service instanceof Response) {
    return volunteerResponse(service);
  }

  const volunteers = new VolunteerRepository(
    env.DB,
    env.TRANSLATOR_PASSWORD_PEPPER
  );
  const programs = new ProgramRepository(env.DB);
  const listenerAccess = new ListenerAccessRepository(env.DB);

  if (request.method === "POST" && url.pathname === "/api/volunteer/login") {
    const input = await parseBody(request, parseVolunteerLoginInput);
    if (input instanceof Response) {
      return volunteerResponse(input);
    }

    try {
      const program = await programs.getProgramBySlug(input.programSlug);
      if (!program || !(await volunteers.getAccount(program.id))) {
        return volunteerResponse(
          json({ error: "volunteer_not_configured" }, { status: 409 })
        );
      }

      // TODO(slice-5): `CF-Connecting-IP` was set by Cloudflare's edge; on the
      // new Caddy-fronted deploy this needs to become `X-Forwarded-For` (or
      // whatever header Caddy is configured to set). Until then this always
      // reads null, so per-IP volunteer login throttling is a no-op (the
      // per-program-wide threshold in recordFailure still applies).
      const clientIp = request.headers.get("CF-Connecting-IP");
      const ipHash = clientIp === null ? null : await sha256Hex(clientIp);
      if (await volunteers.isLocked(program.id, ipHash)) {
        return volunteerResponse(
          json({ error: "too_many_attempts" }, { status: 429 })
        );
      }

      // Reserve both limiter counters before password verification so a D1-
      // serialized write burst cannot all pass the unlocked read together.
      // Full request serialization with a Durable Object is deferred to the WP
      // follow-up; successful authentication rolls this reservation back.
      const failure = await volunteers.recordFailure(program.id, ipHash);
      const authenticated = await volunteers.authenticate(
        program.id,
        input.loginId,
        input.password
      );
      if (!authenticated) {
        return volunteerResponse(
          failure.locked
            ? json({ error: "too_many_attempts" }, { status: 429 })
            : json({ error: "invalid_credentials" }, { status: 401 })
        );
      }

      await volunteers.clearOnSuccess(program.id, failure.reservation);
      const lockedAfterSuccess = await volunteers.isLocked(program.id, ipHash);
      if (failure.firstThresholdBreach || lockedAfterSuccess) {
        return volunteerResponse(
          json({ error: "too_many_attempts" }, { status: 429 })
        );
      }
      const { token } = await volunteers.createSession(
        program.id,
        service.sessionSecret
      );
      const response = json({ ok: true });
      response.headers.set("set-cookie", volunteerSessionCookie(token));
      return volunteerResponse(response);
    } catch (_error) {
      return volunteerResponse(
        json({ error: "database_error" }, { status: 500 })
      );
    }
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/volunteer/logout"
  ) {
    try {
      const auth = await requireVolunteerSession(request, env, volunteers);
      if (auth instanceof Response) {
        return volunteerResponse(auth);
      }

      await volunteers.deleteSession(auth.session.id);
      const response = json({ ok: true });
      response.headers.set("set-cookie", clearVolunteerSessionCookie());
      return volunteerResponse(response);
    } catch (_error) {
      return volunteerResponse(
        json({ error: "database_error" }, { status: 500 })
      );
    }
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/volunteer/session"
  ) {
    try {
      const auth = await requireVolunteerSession(request, env, volunteers);
      if (auth instanceof Response) {
        return volunteerResponse(auth);
      }

      const program = await programs.getProgramById(auth.session.programId);
      if (!program) {
        return volunteerResponse(
          json({ error: "volunteer_auth_required" }, { status: 401 })
        );
      }
      const counts = await listenerAccess.countByStatus(program.id);
      return volunteerResponse(
        json({
          program: { slug: program.slug, name: program.name },
          approvedCount: counts.approved
        })
      );
    } catch (_error) {
      return volunteerResponse(
        json({ error: "database_error" }, { status: 500 })
      );
    }
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/volunteer/approve"
  ) {
    const input = await parseBody(request, parseVolunteerApprovalInput);
    if (input instanceof Response) {
      return volunteerResponse(input);
    }

    try {
      const auth = await requireVolunteerSession(request, env, volunteers);
      if (auth instanceof Response) {
        return volunteerResponse(auth);
      }

      const result = await listenerAccess.approveClaim(
        auth.session.programId,
        input,
        "claimId" in input ? "scan" : "code"
      );
      if (result.status === "approved") {
        return volunteerResponse(json(result));
      }
      if (result.status === "revoked") {
        return volunteerResponse(
          json({ error: "claim_revoked" }, { status: 409 })
        );
      }
      return volunteerResponse(
        json({ error: "claim_not_found" }, { status: 404 })
      );
    } catch (_error) {
      return volunteerResponse(
        json({ error: "database_error" }, { status: 500 })
      );
    }
  }

  return null;
}

async function parseBody<T>(
  request: Request,
  parse: (body: unknown) => T
): Promise<T | Response> {
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (_error) {
    return json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    return parse(body);
  } catch (_error) {
    return json({ error: "validation_error" }, { status: 400 });
  }
}

function parseVolunteerLoginInput(body: unknown): VolunteerLoginInput {
  return {
    programSlug: requiredString(body, "programSlug"),
    loginId: requiredString(body, "loginId"),
    password: requiredString(body, "password", false)
  };
}

function parseVolunteerApprovalInput(body: unknown): VolunteerApprovalInput {
  const claimId = optionalString(body, "claimId");
  const shortCode = optionalString(body, "shortCode");
  if (claimId && !shortCode) {
    return { claimId };
  }
  if (shortCode && !claimId) {
    return { shortCode: shortCode.toUpperCase() };
  }
  throw new Error("claimId or shortCode is required");
}

function requiredString(
  body: unknown,
  key: string,
  trim = true
): string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`${key} is required`);
  }
  const raw = (body as Record<string, unknown>)[key];
  if (typeof raw !== "string") {
    throw new Error(`${key} is required`);
  }
  const value = trim ? raw.trim() : raw;
  if (value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function optionalString(body: unknown, key: string): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const raw = (body as Record<string, unknown>)[key];
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

function volunteerResponse(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  response.headers.set("vary", "Cookie");
  return response;
}
