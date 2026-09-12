#!/usr/bin/env node
// RealtimeKit bootstrap / R0 re-verify + mint test tokens for the R0.5 spike.
// Reads the credentials file specified by CLOUDFLARE_REALTIME_CREDENTIALS_FILE.
//   line 2 = account_id, line 5 = CF API token (Realtime scope).
// Usage:
//   node rtk_bootstrap.mjs verify                 # GET apps (token sanity)
//   node rtk_bootstrap.mjs mint <hostPreset> <viewerPreset>  # create meeting + 2 participants
// Writes authTokens to scripts/.rtk_tokens.json (gitignored), prints only lengths.
import { readFileSync, writeFileSync } from "node:fs";

const CREDS = process.env.CLOUDFLARE_REALTIME_CREDENTIALS_FILE || ".cloudflare-realtime.key";
const APP_ID = process.env.CLOUDFLARE_REALTIME_APP_ID;
const BASE = "https://api.cloudflare.com/client/v4";

if (!APP_ID) {
  console.error("Set CLOUDFLARE_REALTIME_APP_ID before running this script.");
  process.exit(1);
}
const lines = readFileSync(CREDS, "utf8").split(/\r?\n/);
const ACCOUNT = (lines[1] || "").trim();
const TOKEN = (lines[4] || "").trim();
if (!ACCOUNT || !TOKEN) {
  console.error("Could not read account_id (line 2) / token (line 5) from creds");
  process.exit(1);
}
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

const cmd = process.argv[2];

if (cmd === "verify") {
  const r = await call("GET", `/accounts/${ACCOUNT}/realtime/kit/apps`);
  console.log("GET apps status:", r.status);
  // RealtimeKit wraps under `data`, not `result`.
  const apps = r.json?.data ?? r.json?.result ?? r.json;
  console.log("apps payload keys:", Object.keys(r.json || {}));
  console.log(JSON.stringify(apps, null, 2).slice(0, 1500));
  process.exit(r.status === 200 ? 0 : 1);
}

if (cmd === "mint") {
  const hostPreset = process.argv[3] || "translator";
  const viewerPreset = process.argv[4] || "listener";
  // 1. create meeting
  const m = await call("POST", `/accounts/${ACCOUNT}/realtime/kit/${APP_ID}/meetings`, {
    title: `r05-spike-${Date.now()}`,
  });
  console.log("create meeting status:", m.status);
  const meeting = m.json?.data ?? m.json?.result ?? m.json;
  const meetingId = meeting?.id;
  if (!meetingId) {
    console.error("no meeting id:", JSON.stringify(m.json).slice(0, 800));
    process.exit(1);
  }
  console.log("meeting_id:", meetingId);

  async function addParticipant(name, preset) {
    const p = await call(
      "POST",
      `/accounts/${ACCOUNT}/realtime/kit/${APP_ID}/meetings/${meetingId}/participants`,
      { name, preset_name: preset, custom_participant_id: `${name}-${Date.now()}` }
    );
    const data = p.json?.data ?? p.json?.result ?? p.json;
    return { status: p.status, data, raw: p.json };
  }

  const host = await addParticipant("spike-host", hostPreset);
  const viewer = await addParticipant("spike-viewer", viewerPreset);
  console.log("host add status:", host.status, "token len:", (host.data?.token || host.data?.authToken || "").length);
  console.log("viewer add status:", viewer.status, "token len:", (viewer.data?.token || viewer.data?.authToken || "").length);
  if (host.status !== 201 && host.status !== 200) {
    console.error("host add failed:", JSON.stringify(host.raw).slice(0, 800));
  }
  if (viewer.status !== 201 && viewer.status !== 200) {
    console.error("viewer add failed:", JSON.stringify(viewer.raw).slice(0, 800));
  }

  const out = {
    meetingId,
    hostPreset,
    viewerPreset,
    hostToken: host.data?.token || host.data?.authToken || null,
    viewerToken: viewer.data?.token || viewer.data?.authToken || null,
    mintedAt: new Date().toISOString(),
  };
  writeFileSync(new URL("./.rtk_tokens.json", import.meta.url), JSON.stringify(out, null, 2));
  console.log("wrote scripts/.rtk_tokens.json (tokens redacted from stdout)");
}
