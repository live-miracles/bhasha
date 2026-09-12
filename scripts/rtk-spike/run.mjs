#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const spikeDir = __dirname;
const pidPath = path.join(spikeDir, ".pids");
const logPath = path.join(spikeDir, "run.log");

function parseArgs(argv) {
  const opts = {
    duration: 360,
    drop: false,
    port: 8973,
    hostPort: 9222,
    audPort: 9223,
    headless: false,
    close: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--duration") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) {
        opts.duration = Math.max(1, Math.trunc(v));
      }
      i += 1;
    } else if (arg === "--drop") {
      opts.drop = true;
    } else if (arg === "--port") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0 && v < 65536) {
        opts.port = v;
      }
      i += 1;
    } else if (arg === "--host-port") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0 && v < 65536) {
        opts.hostPort = v;
      }
      i += 1;
    } else if (arg === "--aud-port") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0 && v < 65536) {
        opts.audPort = v;
      }
      i += 1;
    } else if (arg === "--headless") {
      opts.headless = true;
    } else if (arg === "--close") {
      opts.close = true;
    }
  }

  return opts;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nowSeconds(startMs) {
  return Math.max(0, Math.round((Date.now() - startMs) / 1000));
}

function contentTypeFor(target) {
  const ext = path.extname(target).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript";
  if (ext === ".json") return "application/json";
  return "application/octet-stream";
}

function createStaticServer(rootDir, port) {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      let relPath = url.pathname;
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.end("method-not-allowed");
        return;
      }
      if (relPath === "/" || relPath === "/index.html") {
        relPath = "/index.html";
      }

      let decoded;
      try {
        decoded = decodeURIComponent(relPath);
      } catch {
        res.statusCode = 400;
        res.end("bad-path");
        return;
      }

      if (decoded.includes("..")) {
        res.statusCode = 403;
        res.end("forbidden");
        return;
      }
      // NOTE: do NOT reject on path.isAbsolute(decoded) — a URL pathname always
      // starts with "/", so that test is always true and 403s every request.
      // The absPath.startsWith(rootWithSep) check below is the real traversal guard.

      const safeRel = decoded.replace(/^\/+/, "");
      const absPath = path.resolve(rootDir, safeRel);
      const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
      if (!absPath.startsWith(rootWithSep)) {
        res.statusCode = 403;
        res.end("forbidden");
        return;
      }

      fsSync.stat(absPath, (statErr, stat) => {
        if (statErr || !stat.isFile()) {
          res.statusCode = 404;
          res.end("not-found");
          return;
        }

        const stream = fsSync.createReadStream(absPath);
        res.statusCode = 200;
        res.setHeader("Content-Type", contentTypeFor(absPath));
        stream.pipe(res);
      });
    } catch {
      res.statusCode = 500;
      res.end("server-error");
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function waitForCDP(port) {
  const timeoutMs = 20000;
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/json/version`;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // keep trying
    }
    await delay(250);
  }
  throw new Error(`CDP not ready on ${port}`);
}

async function waitForRoleJoin(page, role) {
  const start = Date.now();
  let status = "booting";
  let error = null;
  const bad = new Set(["ERROR", "NO TOKEN", "SDK FAILED TO LOAD"]);

  while (Date.now() - start < 35000) {
    const state = await page.evaluate(() => {
      const spike = window.__spike || {};
      return {
        status: spike.status || null,
        error: spike.error || null,
      };
    });

    status = state.status;
    error = state.error;

    if (error) {
      throw new Error(`${role} join failed (${error})`);
    }
    if (status && bad.has(status)) {
      throw new Error(`${role} status=${status}`);
    }
    if (status === "joined") {
      return nowSeconds(start);
    }

    await delay(500);
  }

  throw new Error(`${role} join timeout (status=${status || "unknown"}, error=${error || ""})`);
}

function formatHeartbeatSample(sec, sample) {
  const media = sample?.mediaState ?? "unknown";
  const pps = sample?.pps;
  const rttMs = sample?.rtt == null ? null : Math.round(sample.rtt * 1000);
  const level = sample?.audioLevel;
  const rms = sample?.rms;

  const ppsText = typeof pps === "number" ? pps.toFixed(1) : "n/a";
  const rttText = rttMs == null ? "n/a" : `${rttMs}`;
  const levelText = typeof level === "number" ? level.toFixed(4) : "n/a";
  const rmsText = typeof rms === "number" ? rms.toFixed(4) : "n/a";

  return `[t=${sec}s] OK media=${media} pps=${ppsText} rtt=${rttText}ms level=${levelText} rms=${rmsText}`;
}

function toNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function getSpikeLast(page) {
  return page.evaluate(() => {
    const s = window.__spike || {};
    return s.last || null;
  });
}

async function getSpikeEvents(page) {
  return page.evaluate(() => {
    const s = window.__spike || {};
    return Array.isArray(s.events) ? s.events : [];
  });
}

function isAnomalyWindowActive(windowState) {
  return windowState.active;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const scriptStart = Date.now();
  let server = null;

  let hostChild = null;
  let audChild = null;
  let hostPid = null;
  let audPid = null;
  let hostBrowser = null;
  let audBrowser = null;
  let hostContext = null;
  let audContext = null;
  let hostPage = null;
  let audPage = null;

  let stabilityFailed = false;
  let recoveryMs = "n/a";
  let held = true;
  let anomalies = [];

  const exitCleanup = async () => {
    if (hostBrowser) {
      try {
        await hostBrowser.disconnect();
      } catch {
        // best effort
      }
    }
    if (audBrowser) {
      try {
        await audBrowser.disconnect();
      } catch {
        // best effort
      }
    }

    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
      server = null;
    }

    if (opts.close) {
      if (hostPid) {
        try {
          process.kill(hostPid, "SIGTERM");
        } catch {
          // ignore
        }
      }
      if (audPid) {
        try {
          process.kill(audPid, "SIGTERM");
        } catch {
          // ignore
        }
      }
    }
  };

  try {
    const tokensPath = path.join(spikeDir, "..", ".rtk_tokens.json"); // tokens live in scripts/, parent of rtk-spike/
    const tokenFileRaw = await fs.readFile(tokensPath, "utf8");
    const tokens = JSON.parse(tokenFileRaw);

    const meetingId = tokens?.meetingId;
    const hostToken = tokens?.hostToken;
    const viewerToken = tokens?.viewerToken;
    if (!meetingId || !hostToken || !viewerToken) {
      console.error("❌ tokens missing — run: node scripts/rtk_bootstrap.mjs mint translator listener");
      process.exit(1);
    }

    await fs.writeFile(logPath, "");

    server = await createStaticServer(spikeDir, opts.port);

    const chromeArgsBase = (remotePort, userDataDir, headless) => {
      const args = [
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${remotePort}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-session-crashed-bubble",
        // Real mic on the host (user speaks): --use-fake-ui auto-grants the mic
        // permission to the REAL default device; NO --use-fake-device (that would
        // substitute a synthetic tone). Audience inits audio:false → no mic.
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ];
      if (headless) {
        args.push("--headless=new");
      }
      args.push("about:blank");
      return args;
    };

    const uniqueHostDir = await fs.mkdtemp(path.join(os.tmpdir(), `rtk-host-${crypto.randomUUID()}-`));
    const uniqueAudDir = await fs.mkdtemp(path.join(os.tmpdir(), `rtk-aud-${crypto.randomUUID()}-`));

    try {
      hostChild = spawn("/usr/bin/google-chrome", chromeArgsBase(opts.hostPort, uniqueHostDir, opts.headless), {
        detached: true,
        stdio: "ignore",
      });
      audChild = spawn("/usr/bin/google-chrome", chromeArgsBase(opts.audPort, uniqueAudDir, opts.headless), {
        detached: true,
        stdio: "ignore",
      });
    } catch (err) {
      console.error(`❌ chrome launch failed: ${err?.message || err}`);
      process.exit(1);
    }

    hostPid = hostChild?.pid ?? null;
    audPid = audChild?.pid ?? null;

    if (!hostPid || !audPid) {
      console.error("❌ chrome launch failed: missing chrome pid");
      process.exit(1);
    }

    await fs.writeFile(pidPath, `${hostPid}\n${audPid}\n`);

    hostChild.unref();
    audChild.unref();

    try {
      await waitForCDP(opts.hostPort);
      await waitForCDP(opts.audPort);
    } catch (err) {
      throw new Error(err.message);
    }

    try {
      hostBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.hostPort}`);
      audBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.audPort}`);
    } catch (err) {
      throw new Error(`chromium connect failed: ${err?.message || err}`);
    }

    hostContext = hostBrowser.contexts()[0];
    audContext = audBrowser.contexts()[0];
    if (!hostContext || !audContext) {
      throw new Error("connectOverCDP returned no default context");
    }

    hostPage = await hostContext.newPage();
    audPage = await audContext.newPage();

    const baseUrl = `http://127.0.0.1:${opts.port}/index.html`;
    await hostPage.goto(
      `${baseUrl}?role=host&token=${encodeURIComponent(hostToken)}&meetingId=${encodeURIComponent(meetingId)}`,
      { waitUntil: "domcontentloaded" }
    );

    await delay(1500);

    await audPage.goto(
      `${baseUrl}?role=audience&token=${encodeURIComponent(viewerToken)}&meetingId=${encodeURIComponent(meetingId)}`,
      { waitUntil: "domcontentloaded" }
    );

    const hostJoinMs = await waitForRoleJoin(hostPage, "HOST");
    const audJoinMs = await waitForRoleJoin(audPage, "AUD");
    console.log(`✅ HOST joined (${hostJoinMs}ms)`);
    console.log(`✅ AUD joined (${audJoinMs}ms)`);

    const audAudioStart = Date.now();
    let receivedAudio = false;
    let audioPps = null;

    while (Date.now() - audAudioStart < 20000) {
      const s = await getSpikeLast(audPage);
      if (s?.remoteAudioOn === true) {
        receivedAudio = true;
        audioPps = toNumber(s?.pps);
        break;
      }
      await delay(500);
    }

    if (receivedAudio) {
      console.log(`✅ AUD receiving audio (pps=${typeof audioPps === "number" ? audioPps.toFixed(1) : "n/a"})`);
    } else {
      console.log("⚠ AUD joined but no remote audio after 20s");
    }

    const stabilityStart = Date.now();
    const stabilityMs = opts.duration * 1000;
    const stabilityEnd = stabilityStart + stabilityMs;

    let nextHeartbeat = 30;

    let stallCandidateStart = null;
    let stallCounter = 0;
    let stallActive = false;
    let stallWindowStart = null;

    let mediaDropActive = false;
    let mediaDropStart = null;

    let deadCounter = 0;
    let deadStartCandidate = null;
    let deadActive = false;
    let deadWindowStart = null;

    let minPps = Number.POSITIVE_INFINITY;
    let maxRttMs = 0;

    while (Date.now() < stabilityEnd) {
      const audLast = await getSpikeLast(audPage);
      const sec = nowSeconds(stabilityStart);
      if (audLast) {
        await fs.appendFile(logPath, `${JSON.stringify(audLast)}\n`);
      } else {
        await fs.appendFile(logPath, `${JSON.stringify(null)}\n`);
      }

      const pps = toNumber(audLast?.pps);
      const mediaState = audLast?.mediaState;
      const rms = toNumber(audLast?.rms);
      const rtt = toNumber(audLast?.rtt);

      if (pps != null) {
        minPps = Math.min(minPps, pps);
      }
      if (rtt != null) {
        maxRttMs = Math.max(maxRttMs, Math.round(rtt * 1000));
      }

      const isStall = mediaState === "connected" && pps === 0;
      if (isStall) {
        if (stallCounter === 0) {
          stallCandidateStart = sec;
        }
        stallCounter += 1;
        if (!stallActive && stallCounter >= 10) {
          stallActive = true;
          stallWindowStart = stallCandidateStart;
          anomalies.push({ type: "STALL", start: stallWindowStart, end: null, duration: null });
          console.log(`[t=${sec}s] ⚠ STALL begins (pps=0 while media=connected)`);
        }
      } else if (stallActive) {
        const duration = sec - (stallWindowStart ?? sec);
        anomalies[anomalies.length - 1] = { ...anomalies[anomalies.length - 1], end: sec, duration };
        console.log(`[t=${sec}s] ✅ STALL cleared after ${duration}s`);
        if (duration >= 2) {
          held = false;
        }
        stallActive = false;
        stallCounter = 0;
        stallCandidateStart = null;
        stallWindowStart = null;
      } else {
        stallCounter = 0;
        stallCandidateStart = null;
      }

      const isMediaDrop = mediaState != null && mediaState !== "connected";
      if (isMediaDrop) {
        if (!mediaDropActive) {
          mediaDropActive = true;
          mediaDropStart = sec;
          anomalies.push({ type: "MEDIA", start: mediaDropStart, end: null, duration: null, state: mediaState });
          console.log(`[t=${sec}s] ⚠ media=${mediaState}`);
        }
      } else if (mediaDropActive) {
        const duration = sec - mediaDropStart;
        anomalies[anomalies.length - 1] = { ...anomalies[anomalies.length - 1], end: sec, duration };
        console.log(`[t=${sec}s] ✅ media reconnected after ${duration}s`);
        if (duration >= 2) {
          held = false;
        }
        mediaDropActive = false;
        mediaDropStart = null;
      }

      const isDeadAudio = rms != null && rms === 0;
      if (isDeadAudio) {
        if (deadCounter === 0) {
          deadStartCandidate = sec;
        }
        deadCounter += 1;
        if (!deadActive && deadCounter >= 10) {
          deadActive = true;
          deadWindowStart = deadStartCandidate;
          anomalies.push({ type: "DEAD_AUDIO", start: deadWindowStart, end: null, duration: null });
          console.log(`[t=${sec}s] ⚠ decoded audio silent`);
        }
      } else if (deadActive) {
        const duration = sec - (deadWindowStart ?? sec);
        anomalies[anomalies.length - 1] = { ...anomalies[anomalies.length - 1], end: sec, duration };
        console.log(`[t=${sec}s] ✅ DEAD AUDIO cleared after ${duration}s`);
        if (duration >= 2) {
          held = false;
        }
        deadActive = false;
        deadCounter = 0;
        deadStartCandidate = null;
        deadWindowStart = null;
      } else {
        deadCounter = 0;
        deadStartCandidate = null;
      }

      if (sec >= nextHeartbeat) {
        console.log(formatHeartbeatSample(sec, audLast));
        if (sec - nextHeartbeat >= 30) {
          nextHeartbeat += 30;
        } else {
          nextHeartbeat = sec + 30;
        }
        try {
          const hostLast = await getSpikeLast(hostPage);
          if (hostLast?.mediaState === "connected" && toNumber(hostLast?.pps) === 0) {
            console.log(`[t=${sec}s] ⚠ HOST outbound stalled`);
          }
        } catch {
          // ignore
        }
      }

      const elapsed = Date.now() - stabilityStart;
      await delay(Math.max(0, 1000 - (Date.now() - (stabilityStart + elapsed))));
    }

    const stabilityElapsedSec = nowSeconds(stabilityStart);

    if (stallActive) {
      const duration = stabilityElapsedSec - (stallWindowStart ?? stabilityElapsedSec);
      anomalies[anomalies.length - 1] = { ...anomalies[anomalies.length - 1], end: stabilityElapsedSec, duration };
      console.log(`[t=${stabilityElapsedSec}s] ✅ STALL cleared after ${duration}s`);
      if (duration >= 2) {
        held = false;
      }
      stallActive = false;
    }
    if (mediaDropActive) {
      const duration = stabilityElapsedSec - mediaDropStart;
      anomalies[anomalies.length - 1] = { ...anomalies[anomalies.length - 1], end: stabilityElapsedSec, duration };
      console.log(`[t=${stabilityElapsedSec}s] ✅ media reconnected after ${duration}s`);
      if (duration >= 2) {
        held = false;
      }
      mediaDropActive = false;
    }
    if (deadActive) {
      const duration = stabilityElapsedSec - deadWindowStart;
      anomalies[anomalies.length - 1] = { ...anomalies[anomalies.length - 1], end: stabilityElapsedSec, duration };
      console.log(`[t=${stabilityElapsedSec}s] ✅ DEAD AUDIO cleared after ${duration}s`);
      if (duration >= 2) {
        held = false;
      }
      deadActive = false;
    }

    // Real mic: STALL (pps=0) and DEAD_AUDIO (rms=0) occur during natural speech
    // pauses, so they are informational only. The transport-health verdict (held)
    // depends ONLY on a real media-connection drop (mediaState != connected) lasting
    // >=2s — that is the prod failure mode we are trying to beat.
    held = !anomalies.some((a) => a.type === "MEDIA" && (a.duration ?? 99) >= 2);

    const longestStall = anomalies
      .filter((a) => a.type === "STALL" && typeof a.duration === "number")
      .reduce((m, a) => Math.max(m, a.duration), 0);

    console.log(
      `[t=${stabilityElapsedSec}s] STABILITY DONE: held=${held ? "true" : "false"} anomalies=${anomalies.length} longestStall=${longestStall}s minPps=${toNumber(minPps) == null ? "n/a" : minPps.toFixed(1)} maxRttMs=${Math.round(maxRttMs)}`
    );

    if (opts.drop) {
      const cdp = await audContext.newCDPSession(audPage);
      await cdp.send("Network.enable");
      const dropLabel = `[t=${nowSeconds(stabilityStart)}s] DROP injected (audience offline 3s)`;
      console.log(dropLabel);

      await cdp.send("Network.emulateNetworkConditions", {
        offline: true,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });

      await delay(3000);

      const restoreAt = Date.now();
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });

      let recovered = false;
      const recoveryStart = Date.now();
      while (Date.now() - recoveryStart < 30000) {
        const s = await getSpikeLast(audPage);
        if (s && s.mediaState === "connected" && toNumber(s.pps) > 0 && toNumber(s.rms) > 0) {
          recovered = true;
          recoveryMs = Date.now() - recoveryStart;
          break;
        }
        await delay(250);
      }

      if (recovered) {
        console.log(`[t=${nowSeconds(stabilityStart)}s] ✅ RECOVERY ${recoveryMs}ms`);
      } else {
        console.log(`[t=${nowSeconds(stabilityStart)}s] ❌ NO RECOVERY within 30s`);
        recoveryMs = "fail";
      }

      const dropEvents = (await getSpikeEvents(audPage)).filter((e) => e?.type === "mediaConnectionUpdate");
      const compact = dropEvents
        .map((e) => {
          const t = typeof e.t === "number" ? `${Math.round(e.t)}ms` : "?";
          return `${t}:${e.transport || "?"}:${e.state || "?"}`;
        })
        .join(" |");
      console.log(`[t=${nowSeconds(stabilityStart)}s] mediaConnectionUpdate events: ${compact || "(none)"}`);

      if (recoveryMs === "fail") {
        stabilityFailed = true;
      }
    }

    stabilityFailed = stabilityFailed || !held;

    const recoveryText = recoveryMs === "fail" ? "n/a" : `${recoveryMs}ms`;
    console.log(`DONE: held=${held ? "true" : "false"}, anomalies=${anomalies.length}, recovery=${recoveryText}`);

    if (hostPid && audPid) {
      console.log(`Chrome pids: host=${hostPid}, audience=${audPid}`);
      console.log(`Hint: kill ${hostPid} ${audPid}`);
    }

    await exitCleanup();

    process.exit(stabilityFailed ? 1 : 0);
  } catch (err) {
    console.error(`❌ ${err?.message || err}`);
    if (hostPid && audPid) {
      console.log(`Chrome pids: host=${hostPid}, audience=${audPid}`);
      console.log(`Hint: kill ${hostPid} ${audPid}`);
    }
    await exitCleanup();
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(`❌ ${err?.message || err}`);
  process.exit(1);
});
