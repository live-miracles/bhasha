#!/usr/bin/env node
// Tiny phone-test host: serves phone.html (as index.html) + a /token endpoint
// that mints a LiveKit JWT (host or listener) so the phone URLs stay short
// (https://realtime-app.example.com/?role=host). Keys come from env.
import http from "node:http";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";

const API_KEY = process.env.LK_API_KEY || "devkey";
const API_SECRET = process.env.LK_API_SECRET || "secret";
const WS = process.env.LK_WS_URL || "wss://realtime.example.com";
const ROOM = process.env.LK_ROOM || "phone-test";
const PORT = Number(process.env.PORT || 80);
const PAGE = readFileSync(new URL("./index.html", import.meta.url), "utf8");

const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function mint(identity, grant) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({ iss: API_KEY, sub: identity, name: identity, nbf: now - 10, exp: now + 6 * 3600,
    video: { room: ROOM, roomJoin: true, canPublishData: true, ...grant } });
  const d = `${h}.${p}`;
  return `${d}.${crypto.createHmac("sha256", API_SECRET).update(d).digest("base64url")}`;
}

http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  if (u.pathname === "/token") {
    const role = u.searchParams.get("role") === "host" ? "host" : "listener";
    const grant = role === "host"
      ? { canPublish: true, canSubscribe: false }
      : { canPublish: false, canSubscribe: true };
    const token = mint(role + "-" + crypto.randomBytes(3).toString("hex"), grant);
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ token, ws: WS, room: ROOM }));
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(PAGE);
}).listen(PORT, () => console.log(`livekit-app on :${PORT} room=${ROOM} ws=${WS}`));
