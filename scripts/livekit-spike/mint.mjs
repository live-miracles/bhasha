#!/usr/bin/env node
// Dependency-free LiveKit access-token minter for the spike.
// LiveKit tokens are standard HS256 JWTs: { iss:<apiKey>, sub:<identity>, exp,
// nbf, video:<VideoGrant> } signed with the API secret. For a local `--dev`
// server the well-known keys are devkey/secret.
//
// Usage:  node scripts/livekit-spike/mint.mjs [roomName]
//   env overrides: LK_API_KEY, LK_API_SECRET, LK_WS_URL
// Writes host+listener tokens (same room) to scripts/livekit-spike/.lk_tokens.json
import crypto from "node:crypto";
import { writeFileSync } from "node:fs";

const API_KEY = process.env.LK_API_KEY || "devkey";
const API_SECRET = process.env.LK_API_SECRET || "secret";
const WS_URL = process.env.LK_WS_URL || "ws://localhost:7880";
const room = process.argv[2] || `spike-${Math.floor(Date.now() / 1000)}`;
const TTL = 6 * 3600;

const b64 = (o) =>
  Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

function mint(identity, grant) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({
    iss: API_KEY,
    sub: identity,
    name: identity,
    nbf: now - 10,
    exp: now + TTL,
    video: { room, roomJoin: true, canPublishData: true, ...grant },
  });
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac("sha256", API_SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

// Both join the SAME room for the 1-to-1 transport test (no relay yet).
const hostToken = mint("translator", { canPublish: true, canSubscribe: false });
const listenerToken = mint("listener", { canPublish: false, canSubscribe: true });

const out = { wsUrl: WS_URL, room, hostToken, listenerToken, mintedAt: new Date().toISOString() };
writeFileSync(new URL("./.lk_tokens.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("room:", room, " wsUrl:", WS_URL);
console.log("host token len:", hostToken.length, " listener token len:", listenerToken.length);
console.log("wrote scripts/livekit-spike/.lk_tokens.json");
