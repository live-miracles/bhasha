// Relay WebRTC subscriber load test — REAL media path (k6 browser module).
//
// WHAT THIS IS (and how it differs from listener-presence-load.js):
//   listener-presence-load.js  → protocol-level only. Drives /request → /connected
//                                 → heartbeat → /leave. NO SFU, NO real WebRTC.
//                                 Cheap (1 VU ≈ 1 socket); scales to thousands/box.
//   THIS script                → each VU launches a real headless Chromium, opens
//                                 the listener page, taps "Listen", and establishes
//                                 an ACTUAL PeerConnection (ICE/DTLS/Opus decode)
//                                 against the relay → SFU. It then reads getStats()
//                                 to prove audio is genuinely flowing. Heavy:
//                                 1 VU = 1 full browser. Validation scale (~50), NOT
//                                 the 5k presence certification.
//
// This is the "T4 real-media rehearsal" the presence harness deliberately excludes.
//
// PREREQUISITES
//   1. A LIVE translator publishing to the test program (default slug `relayperf`),
//      so at least one language tile is enabled. With no live stream the "Listen"
//      button stays disabled and every VU fails the join gate (by design — you'll
//      see relay_join_success = 0 and a clear console error per VU).
//   2. k6 with the browser module (bundled in core; this repo has k6 v2.0.0).
//   3. A machine sized for browser VUs. k6's own docs call browser tests "CPU and
//      memory-intensive". Budget ~150–300 MB RAM + meaningful CPU per VU:
//      10 VUs (default) ≈ 2–3 GB RAM and ~2 cores — comfortable on a desktop.
//      (50 VUs would need ~8–15 GB and ~8 cores.) Audio decode (CPU), not RAM,
//      saturates first. If the GENERATOR saturates before the service does, treat
//      early failures as generator artefacts and split across machines (same
//      caveat as the presence harness).
//
// NOTE ON "SILENT" STREAMS: a silent stream (translator connected but not speaking,
// or relay feeding keep-alive silence) still lets a VU join, and bytesReceived will
// advance — so join/transport metrics pass. For a MEANINGFUL media reading
// (realistic packets/jitter/loss under load), have the translator actively speak or
// feed recorded Hindi audio for the duration of the run.
//
// RUN
//   # Smoke (1 VU, ~90 s) — verify the harness joins + hears audio:
//   BASE_URL=https://translate.example.com PROGRAM_SLUG=relayperf PROFILE=smoke \
//     k6 run scripts/load/relay-webrtc-browser-load.js
//
//   # 10-user ramp + hold (default profile):
//   BASE_URL=https://translate.example.com PROGRAM_SLUG=relayperf \
//     K6_BROWSER_ARGS='autoplay-policy=no-user-gesture-required' \
//     k6 run scripts/load/relay-webrtc-browser-load.js
//
//   # Scale up later by overriding TARGET_VUS (mind the resource budget):
//   TARGET_VUS=50 k6 run scripts/load/relay-webrtc-browser-load.js
//
//   Headless is the default. To WATCH the browsers (debug a join failure), add
//   K6_BROWSER_HEADLESS=false and drop TARGET_VUS to 1–2.
//
// CLEANUP: none required. This harness only subscribes/leaves; it writes no D1 rows
// beyond transient presence, which self-prunes after the last heartbeat.

import { browser } from "k6/browser";
import { check } from "k6";
import { Trend, Counter, Rate } from "k6/metrics";

// ---------------------------------------------------------------------------
// Tunables (env vars)
// ---------------------------------------------------------------------------
const BASE_URL = (__ENV.BASE_URL || "https://translate.example.com").replace(/\/$/, "");
const PROGRAM_SLUG = __ENV.PROGRAM_SLUG || "relayperf";
const LISTEN_URL = `${BASE_URL}/${encodeURIComponent(PROGRAM_SLUG)}`;

const TARGET_VUS = Number(__ENV.TARGET_VUS || 10);
const RAMP_SEC = Number(__ENV.RAMP_SEC || 60); // gradual join (0 → TARGET)
const HOLD_SEC = Number(__ENV.HOLD_SEC || 600); // steady-state hold at TARGET
const RAMPDOWN_SEC = Number(__ENV.RAMPDOWN_SEC || 30);

const JOIN_TIMEOUT_SEC = Number(__ENV.JOIN_TIMEOUT_SEC || 30); // click → "connected"
const POLL_SEC = Number(__ENV.POLL_SEC || 10); // getStats() cadence during hold
const PROFILE = __ENV.PROFILE || "ramp"; // "ramp" | "smoke"
const SMOKE = PROFILE === "smoke";
// Smoke holds briefly so a single VU completes a real join + a few stat polls and
// leaves cleanly; the ramp profile holds for the full HOLD_SEC.
const EFFECTIVE_HOLD_SEC = SMOKE ? Math.min(HOLD_SEC, 45) : HOLD_SEC;
// Per-VU milestone logging. On by default for smoke (single VU, useful trace);
// off for the ramp profile to avoid 10× console noise. Force with VERBOSE=1/0.
const VERBOSE = __ENV.VERBOSE ? __ENV.VERBOSE !== "0" : SMOKE;

// ---------------------------------------------------------------------------
// Custom WebRTC metrics (k6 browser has NO native RTC stats — we plumb getStats()
// values into these ourselves).
// ---------------------------------------------------------------------------
const joinSuccess = new Rate("relay_join_success"); // reached connectionState=connected
const joinTimeMs = new Trend("relay_join_time_ms", true);
const iceConnected = new Rate("relay_ice_connected"); // per poll: iceConnectionState in {connected,completed}
const audioFlowing = new Rate("relay_audio_flowing"); // per poll: bytesReceived increased since last poll
const packetLossPct = new Trend("relay_packet_loss_pct"); // per poll: cumulative loss %
const jitterMs = new Trend("relay_jitter_ms", true); // per poll: inbound-rtp jitter (s → ms)
const bytesReceived = new Counter("relay_bytes_received"); // sum of per-poll byte deltas
const audioStalls = new Counter("relay_audio_stalls"); // polls where audio did NOT advance while connected

function rampStages() {
  return [
    { duration: `${RAMP_SEC}s`, target: TARGET_VUS },
    { duration: `${HOLD_SEC}s`, target: TARGET_VUS },
    { duration: `${RAMPDOWN_SEC}s`, target: 0 }
  ];
}

// Smoke uses per-vu-iterations so the single VU activates IMMEDIATELY and runs
// listener() exactly once (ramping-vus would only reach 1 VU at the END of the
// ramp). The ramp profile uses ramping-vus because gradual join IS the point.
const scenario = SMOKE
  ? {
      executor: "per-vu-iterations",
      exec: "listener",
      vus: 1,
      iterations: 1,
      // Headroom: goto + button-wait + join-wait + hold + clean leave.
      maxDuration: `${JOIN_TIMEOUT_SEC * 2 + EFFECTIVE_HOLD_SEC + 60}s`,
      options: { browser: { type: "chromium" } }
    }
  : {
      executor: "ramping-vus",
      exec: "listener",
      startVUs: 0,
      stages: rampStages(),
      gracefulStop: "20s",
      options: { browser: { type: "chromium" } }
    };

export const options = {
  scenarios: {
    relay_listeners: scenario
  },
  // Success bar for a real-media rehearsal. Tune to taste.
  thresholds: {
    relay_join_success: ["rate>0.95"], // ≥95% of VUs establish a connection
    relay_audio_flowing: ["rate>0.90"], // ≥90% of stat polls show audio advancing
    relay_packet_loss_pct: ["p(95)<5"], // p95 cumulative loss under 5%
    relay_join_time_ms: ["p(95)<15000"] // p95 join under 15 s
  }
};

// Browser-context shim: register every RTCPeerConnection the page creates by
// hooking the shared prototype method that EVERY receiving connection calls to
// apply the SFU/relay answer. Patching the prototype (not the constructor) is
// timing-independent: it works even if partytracks captured the global
// RTCPeerConnection reference at import time. Safe to install after page load
// because the PC is constructed lazily on the "Listen" tap, not at load.
function installRtcCapture() {
  if (window.__k6relay) {
    return;
  }
  const store = { pcs: [] };
  window.__k6relay = store;

  const proto = window.RTCPeerConnection && window.RTCPeerConnection.prototype;
  if (!proto) {
    return;
  }
  const origSetRemote = proto.setRemoteDescription;
  proto.setRemoteDescription = function patchedSetRemoteDescription(...args) {
    if (store.pcs.indexOf(this) === -1) {
      store.pcs.push(this);
    }
    return origSetRemote.apply(this, args);
  };
}

// Browser-context reader: pick the live connection and pull audio inbound-rtp stats.
async function readRtcStats() {
  const store = window.__k6relay;
  const pcs = (store && store.pcs) || [];
  if (pcs.length === 0) {
    return null;
  }
  // Prefer a connected PC; fall back to the most recent one.
  let pc = pcs.find((p) => p.connectionState === "connected");
  if (!pc) {
    pc = pcs[pcs.length - 1];
  }

  const out = {
    connectionState: pc.connectionState,
    iceConnectionState: pc.iceConnectionState,
    bytesReceived: 0,
    packetsReceived: 0,
    packetsLost: 0,
    jitter: 0,
    hasInbound: false
  };

  try {
    const report = await pc.getStats();
    report.forEach((r) => {
      const isAudioInbound =
        r.type === "inbound-rtp" &&
        (r.kind === "audio" || r.mediaType === "audio");
      if (isAudioInbound) {
        out.hasInbound = true;
        out.bytesReceived = r.bytesReceived || 0;
        out.packetsReceived = r.packetsReceived || 0;
        out.packetsLost = r.packetsLost || 0;
        out.jitter = r.jitter || 0;
      }
    });
  } catch (_e) {
    // getStats can briefly reject during teardown; treat as a no-sample poll.
  }
  return out;
}

function vlog(vu, msg) {
  if (VERBOSE) {
    console.log(`[VU ${vu}] ${msg}`);
  }
}

export async function listener() {
  const page = await browser.newPage();
  const vu = __VU;

  try {
    // domcontentloaded, NOT networkidle: this SPA keeps background activity
    // (status polling) that can keep "networkidle" from ever firing. We gate on
    // the actual Listen button below, which is the meaningful readiness signal.
    await page.goto(LISTEN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    vlog(vu, "page loaded");

    // Install the RTC capture shim BEFORE tapping "Listen" (PC is built on tap).
    await page.evaluate(installRtcCapture);

    // Wait for an ENABLED language tile. The play button is disabled while the
    // stream is offline, so this also gates on "translator is live".
    const playSelector = "button.lp-btn--play:not([disabled])";
    let playReady = false;
    const playDeadline = Date.now() + JOIN_TIMEOUT_SEC * 1000;
    while (Date.now() < playDeadline) {
      const ready = await page.evaluate(
        (sel) => !!document.querySelector(sel),
        playSelector
      );
      if (ready) {
        playReady = true;
        break;
      }
      await page.waitForTimeout(500);
    }

    if (!playReady) {
      console.error(
        `[VU ${vu}] No enabled "Listen" button at ${LISTEN_URL} within ${JOIN_TIMEOUT_SEC}s ` +
          `— is a translator live on "${PROGRAM_SLUG}"? Marking join failed.`
      );
      joinSuccess.add(false);
      return;
    }
    vlog(vu, "Listen button ready — clicking");

    // Tap the language tile. This is the real user gesture; it grants audio
    // user-activation so autoplay is permitted. relayperf has a single stream,
    // so the selector matches exactly one element (no strict-mode violation).
    const t0 = Date.now();
    await page.locator(playSelector).click({ timeout: 5000 });

    // Wait for the PeerConnection to reach "connected".
    let connected = false;
    const joinDeadline = Date.now() + JOIN_TIMEOUT_SEC * 1000;
    while (Date.now() < joinDeadline) {
      const st = await page.evaluate(readRtcStats);
      if (st && st.connectionState === "connected") {
        connected = true;
        break;
      }
      await page.waitForTimeout(500);
    }

    const joinMs = Date.now() - t0;
    joinSuccess.add(connected);
    if (connected) {
      joinTimeMs.add(joinMs);
      vlog(vu, `connected in ${joinMs}ms — holding ${EFFECTIVE_HOLD_SEC}s`);
    } else {
      console.error(
        `[VU ${vu}] PeerConnection did not reach "connected" within ${JOIN_TIMEOUT_SEC}s.`
      );
      return;
    }

    // -----------------------------------------------------------------------
    // STEADY-STATE HOLD: poll getStats() and assert audio is genuinely flowing.
    // -----------------------------------------------------------------------
    let prev = null;
    const holdDeadline = Date.now() + EFFECTIVE_HOLD_SEC * 1000;
    while (Date.now() < holdDeadline) {
      const s = await page.evaluate(readRtcStats);
      if (s && s.hasInbound) {
        const iceOk =
          s.iceConnectionState === "connected" ||
          s.iceConnectionState === "completed";
        iceConnected.add(iceOk);

        const total = s.packetsReceived + s.packetsLost;
        if (total > 0) {
          packetLossPct.add((s.packetsLost / total) * 100);
        }
        jitterMs.add(s.jitter * 1000);

        if (prev) {
          const byteDelta = s.bytesReceived - prev.bytesReceived;
          const advancing = byteDelta > 0 && s.connectionState === "connected";
          audioFlowing.add(advancing);
          if (byteDelta > 0) {
            bytesReceived.add(byteDelta);
          } else if (s.connectionState === "connected") {
            audioStalls.add(1);
          }
          vlog(
            vu,
            `poll: +${byteDelta}B pktsRecv=${s.packetsReceived} ` +
              `lost=${s.packetsLost} jitter=${(s.jitter * 1000).toFixed(1)}ms ` +
              `conn=${s.connectionState}`
          );
        }
        prev = s;
      }
      await page.waitForTimeout(POLL_SEC * 1000);
    }

    // Final assertion for this VU's run.
    check(prev, {
      "audio was received": (p) => p !== null && p.bytesReceived > 0
    });
  } catch (error) {
    console.error(`[VU ${vu}] iteration error: ${error}`);
    joinSuccess.add(false);
  } finally {
    // Be a good citizen: click "Stop" (→ /stop) so the relay/presence backend
    // tears the listener down promptly rather than waiting for heartbeat expiry.
    try {
      // Short timeout: if the Stop button isn't present (never connected), don't
      // block teardown waiting for it to appear.
      await page
        .locator('button[aria-label="Leave stream"]')
        .click({ timeout: 3000 });
      await page.waitForTimeout(500);
    } catch (_e) {
      // best-effort teardown — page.close() below still cleans up the browser
    }
    await page.close();
  }
}
