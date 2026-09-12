import type { Env } from "./env";
import { json, notFound } from "./http";
import { ProgramPresence } from "./presence/ProgramPresence";
import { StreamRelay } from "./relay/StreamRelay";
import { ListenerRepository } from "./db/listenerRepository";
import { ProgramRepository } from "./db/programRepository";
import { RetentionRepository } from "./db/retentionRepository";
import { handleAdminRoutes } from "./routes/admin";
import { handleListenerRoutes } from "./routes/listeners";
import { handlePartytracksRoutes } from "./routes/partytracks";
import { handlePublicRoutes } from "./routes/public";
import { handleTranslatorRoutes } from "./routes/translator";
import { handleVolunteerRoutes } from "./routes/volunteer";
import { handleRelayRoutes } from "./routes/relay";
import { realtimeSmokePage } from "./smoke/realtimeSmokePage";
import { runScheduledRetention } from "./domain/retentionService";
import {
  handleConnectionEventsBatch,
  type ConnectionEvent
} from "./queue/connectionEvents";

export { ProgramPresence, StreamRelay };

export default {
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const programs = new ProgramRepository(env.DB);
    const listeners = new ListenerRepository(env.DB);
    const retention = new RetentionRepository(env.DB);
    const now = new Date();

    ctx.waitUntil(retention.pruneDailyAccessData(now));

    ctx.waitUntil(
      runScheduledRetention(
        {
          listProgramsToPrune: retention.listProgramsToPrune.bind(retention),
          listProgramsToRedact: retention.listProgramsToRedact.bind(retention),
          pruneProgram: retention.pruneProgram.bind(retention),
          anonymizeProgramTelemetry: listeners.anonymizeProgramTelemetry.bind(listeners),
          markRetentionProcessed: programs.markRetentionProcessed.bind(programs)
        },
        now
      ).then((result) => {
        console.log(
          `scheduled retention: pruned=${result.pruned} redacted=${result.redacted} failures=${result.failures.length}`
        );
        if (result.failures.length > 0) {
          console.error("scheduled retention failures", result.failures);
        }
      })
    );
  },

  async queue(
    batch: MessageBatch<ConnectionEvent>,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    await handleConnectionEventsBatch(batch, env);
  },

  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (
        request.method === "GET" &&
        url.pathname === "/api/health" &&
        url.searchParams.get("deep") === "1"
      ) {
        try {
          await env.DB.prepare("SELECT 1").first();
          return json({ ok: true, checks: { db: "ok" } });
        } catch {
          return json({ ok: false, checks: { db: "error" } }, { status: 503 });
        }
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        return json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/smoke/realtime") {
        return canServeRealtimeSmokePage(url, env)
          ? realtimeSmokePage()
          : notFound();
      }

      const partytracksResponse = await handlePartytracksRoutes(request, env, url);
      if (partytracksResponse) {
        return partytracksResponse;
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

      const relayResponse = await handleRelayRoutes(request, env, url);
      if (relayResponse) {
        return relayResponse;
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
          method: request.method,
          pathname: new URL(request.url).pathname,
          error: err?.message,
          stack: err?.stack
        })
      );
      return json({ error: "internal_error" }, { status: 500 });
    }
  }
};

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
