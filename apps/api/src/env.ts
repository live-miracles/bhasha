import type { ConnectionEvent } from "./queue/connectionEvents";

export type WorkerEnv = {
  DB: D1Database;
  CONNECTION_EVENTS: Queue<ConnectionEvent>;
  PROGRAM_PRESENCE: DurableObjectNamespace;
  RELAY?: DurableObjectNamespace;
  RELAY_INTERNAL_SECRET?: string;
  ADMIN_PASSWORD_HASH: string;
  ADMIN_SESSION_SECRET: string;
  // Email of the single platform_admin resolved/created by the bootstrap route.
  PLATFORM_ADMIN_EMAIL?: string;
  CLOUDFLARE_REALTIME_APP_ID: string;
  CLOUDFLARE_REALTIME_APP_SECRET: string;
  CLOUDFLARE_REALTIME_BASE_URL?: string;
  TRANSLATOR_PASSWORD_PEPPER: string;
  TRANSLATOR_SESSION_SECRET: string;
  VOLUNTEER_SESSION_SECRET?: string | undefined;
  REALTIME_SMOKE_ENABLED?: string;
  DEBUG_D1_REPLICA?: string;
  REALTIME_FETCH?: typeof fetch;
  RELAY_ENABLED?: string;
  LISTENER_WRITE_BEHIND?: string;
  PRESENCE_LIVE_COUNT?: string;
  // Injection seam for the listener /status edge cache (mirrors REALTIME_FETCH).
  // Production falls back to `caches.default`; tests inject a fake Cache.
  STATUS_CACHE?: Cache;
  CLOUDFLARE_TURN_KEY_ID?: string;
  CLOUDFLARE_TURN_API_TOKEN?: string;
  CLOUDFLARE_TURN_BASE_URL?: string;
  TURN_FETCH?: typeof fetch;
};

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }

  interface Env extends WorkerEnv {}
}

export type Env = WorkerEnv;
