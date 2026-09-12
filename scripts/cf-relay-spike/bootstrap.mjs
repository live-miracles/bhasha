#!/usr/bin/env node
// R0 bootstrap: create a THROWAWAY Cloudflare Realtime SFU app for the relay spike,
// so R0 needs no prod secrets. Reads the CF API token from the creds file, creates a
// Calls/Realtime SFU app, and writes its id+secret to scripts/cf-relay-spike/.env
// (gitignored). The SFU media API is then https://rtc.live.cloudflare.com/v1/apps/<id>
// with `Authorization: Bearer <secret>`.
//
// Usage: node scripts/cf-relay-spike/bootstrap.mjs
import { readFileSync, writeFileSync } from "node:fs";

const CREDS = process.env.CLOUDFLARE_CREDENTIALS_FILE || ".cloudflare-full.key";
const lines = readFileSync(CREDS, "utf8").split(/\r?\n/);
const ACCOUNT = (lines[1] || "").trim();   // line 2 = Account ID
const TOKEN = (lines[3] || "").trim();     // line 4 = API Token
if (!ACCOUNT || !TOKEN) { console.error("missing account/token in", CREDS); process.exit(1); }
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/calls/apps`, {
  method: "POST", headers: H,
  body: JSON.stringify({ name: `relay-spike-${Math.floor(Date.now() / 1000)}` }),
});
const j = await res.json();
if (!j.success) { console.error("create failed:", JSON.stringify(j.errors)); process.exit(1); }
const appId = j.result.uid;
const secret = j.result.secret; // returned ONCE at creation — cannot be re-read later
writeFileSync(new URL("./.env", import.meta.url),
  `SFU_BASE=https://rtc.live.cloudflare.com/v1\nSFU_APP_ID=${appId}\nSFU_APP_SECRET=${secret}\n`);
console.log("created throwaway SFU app:", appId, " (secret len:", (secret || "").length, ")");
console.log("wrote scripts/cf-relay-spike/.env (gitignored)");
