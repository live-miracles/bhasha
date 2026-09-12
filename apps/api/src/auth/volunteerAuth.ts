import {
  VolunteerRepository,
  type VolunteerSessionRecord
} from "../db/volunteerRepository";
import type { Env } from "../env";
import { json } from "../http";

const VOLUNTEER_SESSION_COOKIE = "volunteer_session";
const VOLUNTEER_SESSION_SECONDS = 8 * 60 * 60;

export interface AuthenticatedVolunteer {
  session: VolunteerSessionRecord;
}

export function volunteerSessionCookie(token: string): string {
  return `${VOLUNTEER_SESSION_COOKIE}=${token}; Path=/; Max-Age=${VOLUNTEER_SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearVolunteerSessionCookie(): string {
  return `${VOLUNTEER_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function requireVolunteerService(
  env: Env
): { sessionSecret: string } | Response {
  if (!env.VOLUNTEER_SESSION_SECRET) {
    return json({ error: "service_unavailable" }, { status: 503 });
  }
  return { sessionSecret: env.VOLUNTEER_SESSION_SECRET };
}

export async function requireVolunteerSession(
  request: Request,
  env: Env,
  repository = new VolunteerRepository(
    env.DB,
    env.TRANSLATOR_PASSWORD_PEPPER
  )
): Promise<AuthenticatedVolunteer | Response> {
  const service = requireVolunteerService(env);
  if (service instanceof Response) {
    return service;
  }

  const token = cookieValue(request, VOLUNTEER_SESSION_COOKIE);
  if (!token) {
    return volunteerAuthRequired();
  }

  const session = await repository.getSession(token, service.sessionSecret);
  if (!session) {
    return volunteerAuthRequired();
  }

  const touchedSession = await repository.touchSession(session.id);
  if (!touchedSession) {
    return volunteerAuthRequired();
  }

  return { session: touchedSession };
}

function volunteerAuthRequired(): Response {
  return json({ error: "volunteer_auth_required" }, { status: 401 });
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) {
    return null;
  }

  for (const part of cookie.split(";")) {
    const [key, ...rawValue] = part.trim().split("=");
    const value = rawValue.join("=");
    if (key === name && value) {
      return value;
    }
  }

  return null;
}
