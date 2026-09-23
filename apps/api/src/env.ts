import type { Database } from './db/sqlite';

export type WorkerEnv = {
    DB: Database;
    ADMIN_SESSION_SECRET: string;
    TRANSLATOR_PASSWORD_PEPPER: string;
    TRANSLATOR_SESSION_SECRET: string;
    VOLUNTEER_SESSION_SECRET?: string | undefined;
    REALTIME_SMOKE_ENABLED?: string;
    PRESENCE_LIVE_COUNT?: string;
    // Path to the better-sqlite3 database file. Defaults to ./data/bhasha.sqlite;
    // pass ":memory:" for tests.
    DATABASE_PATH?: string;
    // Directory containing the built web SPA (apps/web/dist) to serve static
    // assets from, plus the index.html SPA-fallback (see index.ts's
    // createApp). Defaults to a path resolved relative to this module that
    // works both in a local/dev checkout and inside the Docker runtime image
    // (which mirrors the monorepo's apps/api + apps/web/dist layout).
    WEB_DIST_PATH?: string;
    // LiveKit server-sdk configuration (Slice 3). All three are optional at the
    // type level -- and NOT required at boot via requireEnvVar in
    // buildEnvFromProcess -- so the app can still start before LiveKit is
    // provisioned; routes/admin.ts's isRealtimeConfigured()/readiness check
    // reports this as a blocker until all three are set. LIVEKIT_URL is the
    // ws(s):// URL browser clients use for signaling; livekit/client.ts derives
    // the http(s) admin-API URL from it rather than needing a second env var.
    LIVEKIT_URL?: string;
    LIVEKIT_API_KEY?: string;
    LIVEKIT_API_SECRET?: string;
};

export type Env = WorkerEnv;
