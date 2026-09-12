import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import worker from "../src/index";
import { ProgramRepository, type ProgramRecord } from "../src/db/programRepository";
import {
  type OrgRecord,
  type UserRecord,
  UsersRepository
} from "../src/db/usersRepository";
import type { ConnectionEvent } from "../src/queue/connectionEvents";

export type TestEnv = Env & {
  ADMIN_TEST_PASSWORD: string;
};

export const testEnv = env as TestEnv;

// Default email for the seeded platform_admin used across admin/program tests.
export const ADMIN_TEST_EMAIL = "platform@test.local";
export const ORG_ADMIN_TEST_EMAIL = "orgadmin@test.local";
export const VIEWER_TEST_EMAIL = "viewer@test.local";
export const DEFAULT_TEST_ORG_ID = "org_default";

export function buildTestEnv(overrides: Partial<Env>): Env {
  const baseEnv: Env = {
    DB: testEnv.DB,
    PROGRAM_PRESENCE: testEnv.PROGRAM_PRESENCE,
    ADMIN_PASSWORD_HASH: testEnv.ADMIN_PASSWORD_HASH,
    ADMIN_SESSION_SECRET: testEnv.ADMIN_SESSION_SECRET,
    CONNECTION_EVENTS: {
      send: async () => {},
      sendBatch: async () => {}
    } as unknown as Queue<ConnectionEvent>,
    CLOUDFLARE_REALTIME_APP_ID: testEnv.CLOUDFLARE_REALTIME_APP_ID,
    CLOUDFLARE_REALTIME_APP_SECRET: testEnv.CLOUDFLARE_REALTIME_APP_SECRET,
    TRANSLATOR_PASSWORD_PEPPER: testEnv.TRANSLATOR_PASSWORD_PEPPER,
    TRANSLATOR_SESSION_SECRET: testEnv.TRANSLATOR_SESSION_SECRET,
    VOLUNTEER_SESSION_SECRET: testEnv.VOLUNTEER_SESSION_SECRET
  };

  if (testEnv.CLOUDFLARE_REALTIME_BASE_URL) {
    baseEnv.CLOUDFLARE_REALTIME_BASE_URL = testEnv.CLOUDFLARE_REALTIME_BASE_URL;
  }
  if (testEnv.REALTIME_FETCH) {
    baseEnv.REALTIME_FETCH = testEnv.REALTIME_FETCH;
  }
  if (testEnv.CLOUDFLARE_TURN_KEY_ID) {
    baseEnv.CLOUDFLARE_TURN_KEY_ID = testEnv.CLOUDFLARE_TURN_KEY_ID;
  }
  if (testEnv.CLOUDFLARE_TURN_API_TOKEN) {
    baseEnv.CLOUDFLARE_TURN_API_TOKEN = testEnv.CLOUDFLARE_TURN_API_TOKEN;
  }
  if (testEnv.CLOUDFLARE_TURN_BASE_URL) {
    baseEnv.CLOUDFLARE_TURN_BASE_URL = testEnv.CLOUDFLARE_TURN_BASE_URL;
  }
  if (testEnv.TURN_FETCH) {
    baseEnv.TURN_FETCH = testEnv.TURN_FETCH;
  }

  return { ...baseEnv, ...overrides };
}

/**
 * Seed (or repair) a platform_admin user with a known password. Idempotent:
 * if the user already exists it just (re)sets the password. Returns the user id.
 */
export async function seedPlatformAdmin(
  env: Env,
  email: string = ADMIN_TEST_EMAIL,
  password: string = testEnv.ADMIN_TEST_PASSWORD
): Promise<string> {
  const users = new UsersRepository(env.DB);
  const existing = await users.getUserByEmail(email);
  const user =
    existing ??
    (await users.createUser({ email, role: "platform_admin", orgId: null }));
  await users.setPassword(user.id, password);
  return user.id;
}

export async function seedOrg(
  env: Env,
  { id, name }: { id?: string; name?: string } = {}
): Promise<OrgRecord> {
  const users = new UsersRepository(env.DB);
  const orgId = id ?? `org_${crypto.randomUUID()}`;
  const existing = await users.getOrg(orgId);
  if (existing) {
    return existing;
  }

  return users.createOrg({
    id: orgId,
    name: name ?? `Org ${orgId}`
  });
}

async function repairRoleAndOrg(
  users: UsersRepository,
  user: UserRecord,
  role: "platform_admin" | "org_admin" | "viewer",
  orgId: string | null
): Promise<UserRecord> {
  if (user.role !== role || user.orgId !== orgId) {
    const updated = await users.updateUser(user.id, {
      role,
      orgId
    });
    return updated ?? user;
  }

  return user;
}

export async function seedOrgAdmin(
  env: Env,
  {
    orgId = DEFAULT_TEST_ORG_ID,
    email = ORG_ADMIN_TEST_EMAIL,
    password = testEnv.ADMIN_TEST_PASSWORD
  }: { orgId?: string; email?: string; password?: string } = {}
): Promise<{ userId: string; orgId: string; email: string }> {
  const users = new UsersRepository(env.DB);
  const org = await seedOrg(env, { id: orgId, name: `${orgId} org` });

  const existing = await users.getUserByEmail(email);
  const user = existing
    ? await repairRoleAndOrg(users, existing, "org_admin", org.id)
    : await users.createUser({
        email,
        role: "org_admin",
        orgId: org.id
      });

  await users.setPassword(user.id, password);
  return { userId: user.id, orgId: org.id, email: user.email };
}

export async function seedViewer(
  env: Env,
  {
    orgId = DEFAULT_TEST_ORG_ID,
    email = VIEWER_TEST_EMAIL,
    password = testEnv.ADMIN_TEST_PASSWORD
  }: { orgId?: string; email?: string; password?: string } = {}
): Promise<{ userId: string; orgId: string; email: string }> {
  const users = new UsersRepository(env.DB);
  const org = await seedOrg(env, { id: orgId, name: `${orgId} org` });

  const existing = await users.getUserByEmail(email);
  const user = existing
    ? await repairRoleAndOrg(users, existing, "viewer", org.id)
    : await users.createUser({
        email,
        role: "viewer",
        orgId: org.id
      });

  await users.setPassword(user.id, password);
  return { userId: user.id, orgId: org.id, email: user.email };
}

export async function seedProgram(
  env: Env,
  overrides: Partial<{
    slug: string;
    name: string;
    venue: string;
    eventDate: string;
    adminNotes: string;
    orgId: string;
  }> = {}
): Promise<ProgramRecord> {
  const repo = new ProgramRepository(env.DB);
  return repo.createProgram(
    {
      slug: overrides.slug ?? `program-${crypto.randomUUID()}`,
      name: overrides.name ?? "Patna Event 2026",
      venue: overrides.venue ?? "Main Hall",
      eventDate: overrides.eventDate ?? "2026-08-01",
      adminNotes: overrides.adminNotes ?? "",
    },
    overrides.orgId ?? DEFAULT_TEST_ORG_ID
  );
}

/**
 * Log in via POST /api/admin/login and return the `admin_session=<token>`
 * cookie fragment suitable for a `cookie` request header.
 */
export async function adminCookie(
  email: string = ADMIN_TEST_EMAIL,
  password: string = testEnv.ADMIN_TEST_PASSWORD,
  env: Env = testEnv
): Promise<string> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://bhasha.test/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    }) as unknown as Request<unknown, IncomingRequestCfProperties>,
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);

  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error(`admin login failed: ${response.status}`);
  }
  return setCookie.split(";")[0] ?? "";
}
