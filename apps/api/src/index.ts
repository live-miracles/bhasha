import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Env } from "./env";
import { createFireAndForgetCtx, json, notFound, type WaitUntilCtx } from "./http";
import { openDatabase } from "./db/sqlite";
import { runMigrations } from "./db/migrate";
import { handleAdminRoutes } from "./routes/admin";
import { handleListenerRoutes } from "./routes/listeners";
import { handlePublicRoutes } from "./routes/public";
import { handleTranslatorRoutes } from "./routes/translator";
import { handleVolunteerRoutes } from "./routes/volunteer";
import { handleLiveKitWebhook } from "./livekit/webhook";

// NOTE(slice-1): the retention cron (`triggers.crons` in the old
// wrangler.jsonc) and the connection-events queue consumer are intentionally
// NOT reintroduced here. They will come back as `node-cron` (calling the
// existing, DB-agnostic `runScheduledRetention`) and direct synchronous
// writes respectively, in a later slice. Scheduled retention simply does not
// run yet in this slice — see AGENTS/plan doc for the phased rollout.

/**
 * Builds the Hono app for a given `Env`. Kept separate from process wiring
 * (`main`, below) so tests can construct an app around an in-memory database
 * without starting a real HTTP listener — call `app.fetch(request)` directly.
 */
export function createApp(env: Env): Hono {
  const app = new Hono();
  const ctx: WaitUntilCtx = createFireAndForgetCtx();

  app.all("*", async (c) => {
    try {
      const request = c.req.raw;
      const url = new URL(c.req.url);

      if (
        request.method === "GET" &&
        url.pathname === "/api/health" &&
        url.searchParams.get("deep") === "1"
      ) {
        try {
          env.DB.prepare("SELECT 1").get();
          return json({ ok: true, checks: { db: "ok" } });
        } catch {
          return json({ ok: false, checks: { db: "error" } }, { status: 503 });
        }
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        return json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/smoke/realtime") {
        // TODO(slice-3): the Cloudflare-Realtime debug smoke page was deleted
        // along with the rest of realtime/ (it only ever exercised the
        // Cloudflare Realtime SFU directly). Re-add a LiveKit-flavored
        // equivalent here if/when it's needed again.
        return canServeRealtimeSmokePage(url, env)
          ? json(
              {
                error: "not_implemented",
                message: "Realtime smoke page lands with LiveKit in a later slice"
              },
              { status: 501 }
            )
          : notFound();
      }

      if (request.method === "POST" && url.pathname === "/api/livekit/webhook") {
        return handleLiveKitWebhook(request, env);
      }

      const publicResponse = await handlePublicRoutes(request, env, url, ctx);
      if (publicResponse) {
        return publicResponse;
      }

      const adminResponse = await handleAdminRoutes(request, env, url, ctx);
      if (adminResponse) {
        return adminResponse;
      }

      const translatorResponse = await handleTranslatorRoutes(request, env, url, ctx);
      if (translatorResponse) {
        return translatorResponse;
      }

      const volunteerResponse = await handleVolunteerRoutes(request, env, url, ctx);
      if (volunteerResponse) {
        return volunteerResponse;
      }

      const listenerResponse = await handleListenerRoutes(request, env, url, ctx);
      if (listenerResponse) {
        return listenerResponse;
      }

      return notFound();
    } catch (error) {
      if (error instanceof Response) {
        return error;
      }

      const err = error as Error;
      console.error(
        JSON.stringify({
          level: "error",
          message: "unhandled_fetch_error",
          method: c.req.raw.method,
          pathname: new URL(c.req.url).pathname,
          error: err?.message,
          stack: err?.stack
        })
      );
      return json({ error: "internal_error" }, { status: 500 });
    }
  });

  return app;
}

function canServeRealtimeSmokePage(url: URL, env: Env): boolean {
  if (isLocalhost(url.hostname)) {
    return true;
  }

  return (
    env.REALTIME_SMOKE_ENABLED === "true" ||
    env.REALTIME_SMOKE_ENABLED === "1"
  );
}

function isLocalhost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function requireEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Builds a real `Env` from `process.env` and a freshly-opened, migrated
 * better-sqlite3 database. Used by `main()`; tests build their own `Env`
 * around a `:memory:` database instead (see test/test-env.ts).
 */
export function buildEnvFromProcess(): Env {
  const db = openDatabase(process.env.DATABASE_PATH);
  runMigrations(db);

  return {
    DB: db,
    ADMIN_PASSWORD_HASH: requireEnvVar("ADMIN_PASSWORD_HASH"),
    ADMIN_SESSION_SECRET: requireEnvVar("ADMIN_SESSION_SECRET"),
    ...(process.env.PLATFORM_ADMIN_EMAIL !== undefined
      ? { PLATFORM_ADMIN_EMAIL: process.env.PLATFORM_ADMIN_EMAIL }
      : {}),
    TRANSLATOR_PASSWORD_PEPPER: requireEnvVar("TRANSLATOR_PASSWORD_PEPPER"),
    TRANSLATOR_SESSION_SECRET: requireEnvVar("TRANSLATOR_SESSION_SECRET"),
    VOLUNTEER_SESSION_SECRET: process.env.VOLUNTEER_SESSION_SECRET,
    ...(process.env.REALTIME_SMOKE_ENABLED !== undefined
      ? { REALTIME_SMOKE_ENABLED: process.env.REALTIME_SMOKE_ENABLED }
      : {}),
    ...(process.env.PRESENCE_LIVE_COUNT !== undefined
      ? { PRESENCE_LIVE_COUNT: process.env.PRESENCE_LIVE_COUNT }
      : {}),
    ...(process.env.DATABASE_PATH !== undefined
      ? { DATABASE_PATH: process.env.DATABASE_PATH }
      : {}),
    ...(process.env.LIVEKIT_URL !== undefined
      ? { LIVEKIT_URL: process.env.LIVEKIT_URL }
      : {}),
    ...(process.env.LIVEKIT_API_KEY !== undefined
      ? { LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY }
      : {}),
    ...(process.env.LIVEKIT_API_SECRET !== undefined
      ? { LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET }
      : {})
  };
}

function main(): void {
  const env = buildEnvFromProcess();
  const app = createApp(env);
  const port = Number.parseInt(process.env.PORT ?? "8787", 10);

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(
      JSON.stringify({
        level: "info",
        message: "server_listening",
        port: info.port
      })
    );
  });
}

// Only boot the server when this module is executed directly (`node
// src/index.ts` / `tsx watch src/index.ts`), not when imported by tests.
const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  main();
}
