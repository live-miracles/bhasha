/**
 * Phase T0/T1 — listener PRESENCE control-plane baseline (k6).
 *
 * Goal: find the ceiling of the per-program ProgramPresence Durable Object + D1
 * under realistic steady-state load (heartbeats + status polls), WITHOUT pulling
 * the Cloudflare SFU into the measurement.
 *
 * How it stays SFU-free: it drives POST /api/listeners/request (which calls
 * createRequestedConnection only — no getActivePublisher, no SFU sessions/new)
 * → /connected → heartbeat loop (+ /status poll) → /leave. This produces the
 * EXACT DO load that is the bottleneck (/join on connect+heartbeat, /snapshot on
 * poll, /leave), at production cadence. It under-represents only the 2 extra
 * join-time D1 writes per listener — negligible vs the ~5.5 joins/s real arrival.
 *
 * One k6 VU == one held listener. ramping-vus stages == concurrent listener count.
 *
 * Run (smoke, local wrangler dev):
 *   BASE_URL=http://127.0.0.1:8787 PROFILE=smoke k6 run scripts/load/listener-presence-load.js
 * Run (full staged ramp to 5k against a deployed target):
 *   BASE_URL=https://<staging-host> PROFILE=ramp k6 run scripts/load/listener-presence-load.js
 *
 * Env knobs:
 *   BASE_URL       target origin (default http://127.0.0.1:8787)
 *   PROGRAM_SLUG   default loadtest-5k          STREAM_ID default loadtest_stream_1
 *   HEARTBEAT_MS   default 10000 (current prod cadence — keep for the baseline)
 *   POLL_MS        default 5000  (current prod cadence; set 0 to disable polling)
 *   HOLD_SEC       per-listener session length before leave+rejoin (default 600)
 *   PROFILE        smoke | ramp | <custom via STAGES_JSON>
 *   STAGES_JSON    JSON array of {duration,target} to override the ramp
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";

const BASE_URL = (__ENV.BASE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const PROGRAM_SLUG = __ENV.PROGRAM_SLUG || "loadtest-5k";
const STREAM_ID = __ENV.STREAM_ID || "loadtest_stream_1";
const HEARTBEAT_MS = Number(__ENV.HEARTBEAT_MS || 10000);
const POLL_MS = Number(__ENV.POLL_MS || 5000);
const HOLD_SEC = Number(__ENV.HOLD_SEC || 600);

const joinTrend = new Trend("listener_join_ms", true);
const hbTrend = new Trend("listener_heartbeat_ms", true);
const pollTrend = new Trend("listener_status_poll_ms", true);
const joinFail = new Rate("listener_join_failed");
const hbFail = new Rate("listener_heartbeat_failed");
const hb5xx = new Counter("listener_heartbeat_5xx"); // DO overloaded / presence failure
const hb409 = new Counter("listener_heartbeat_409"); // invalid-state (D1 not 'connected')
const pollFail = new Rate("listener_status_poll_failed");

const RAMP_STAGES = [
  { duration: "1m", target: 200 },
  { duration: "10m", target: 200 },
  { duration: "1m", target: 500 },
  { duration: "10m", target: 500 },
  { duration: "1m", target: 1000 },
  { duration: "10m", target: 1000 },
  { duration: "1m", target: 2500 },
  { duration: "10m", target: 2500 },
  { duration: "1m", target: 5000 },
  { duration: "15m", target: 5000 },
  { duration: "1m", target: 0 }
];
const SMOKE_STAGES = [
  { duration: "10s", target: 1 },
  { duration: "5m", target: 1 },
  { duration: "5s", target: 0 }
];

function stages() {
  if (__ENV.STAGES_JSON) return JSON.parse(__ENV.STAGES_JSON);
  return (__ENV.PROFILE || "ramp") === "smoke" ? SMOKE_STAGES : RAMP_STAGES;
}

export const options = {
  scenarios: {
    listeners: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: stages(),
      gracefulRampDown: "30s",
      gracefulStop: "30s"
    }
  },
  thresholds: {
    // The knee of the curve: when these break, you've found the ceiling.
    listener_heartbeat_ms: ["p(95)<200"],
    listener_heartbeat_failed: ["rate<0.01"],
    listener_join_failed: ["rate<0.01"],
    listener_status_poll_failed: ["rate<0.01"]
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"]
};

const JSON_HEADERS = { "Content-Type": "application/json" };
function postJson(path, body) {
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: JSON_HEADERS,
    tags: { ep: path }
  });
}

// JOB_ID makes clientIds unique across parallel load generators (e.g. a GitHub
// Actions matrix), so the N runners don't collide on `k6_<VU>_<ITER>`.
const JOB_ID = __ENV.JOB_ID || "0";
const JOIN_BACKOFF_BASE_MS = 1000;
const JOIN_BACKOFF_MAX_MS = 30000;
const joinFails = {};

function sleepAfterJoinFailure() {
  joinFails[__VU] = (joinFails[__VU] || 0) + 1;
  const delayMs = Math.min(
    JOIN_BACKOFF_BASE_MS * 2 ** (joinFails[__VU] - 1),
    JOIN_BACKOFF_MAX_MS
  );
  // Mirrors ListenerRoute.tsx exponential backoff to avoid a synthetic retry storm.
  sleep(delayMs / 1000);
}

export default function () {
  const clientId = `k6_${JOB_ID}_${__VU}_${__ITER}`;

  // 1. request — creates a 'requested' connection, NO SFU.
  const reqRes = postJson("/api/listeners/request", {
    programSlug: PROGRAM_SLUG,
    streamId: STREAM_ID,
    clientId
  });
  joinTrend.add(reqRes.timings.duration);
  const created = check(reqRes, { "request 201": (r) => r.status === 201 });
  joinFail.add(!created);
  if (!created) {
    sleepAfterJoinFailure();
    return;
  }
  const connectionId = reqRes.json("connectionId");

  // 2. connected — flips requested -> connected, fires DO /join.
  const conRes = postJson("/api/listeners/connected", { connectionId });
  if (!check(conRes, { "connected 200": (r) => r.status === 200 })) {
    joinFail.add(true);
    sleepAfterJoinFailure();
    return;
  }
  joinFails[__VU] = 0;

  // 3. hold: heartbeat (DO /join) + status poll (DO /snapshot) at prod cadence.
  const start = Date.now();
  let lastHb = start;
  let lastPoll = start;
  while (Date.now() - start < HOLD_SEC * 1000) {
    const now = Date.now();
    if (now - lastHb >= HEARTBEAT_MS) {
      const hb = postJson("/api/listeners/heartbeat", { connectionId });
      hbTrend.add(hb.timings.duration);
      hbFail.add(hb.status !== 200);
      if (hb.status >= 500) hb5xx.add(1);
      if (hb.status === 409) hb409.add(1);
      lastHb = now;
    }
    if (POLL_MS > 0 && now - lastPoll >= POLL_MS) {
      const p = http.get(
        `${BASE_URL}/api/public/programs/${PROGRAM_SLUG}/status`,
        { tags: { ep: "/api/public/programs/:slug/status" } }
      );
      pollTrend.add(p.timings.duration);
      pollFail.add(p.status !== 200);
      lastPoll = now;
    }
    sleep(0.5);
  }

  // 4. leave — disconnect + DO /leave. Then the VU re-iterates (rejoin),
  //    keeping the active-listener count ~= active VUs.
  postJson("/api/listeners/leave", {
    connectionId,
    reason: "load_test_complete"
  });
}
