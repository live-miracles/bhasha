import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { createApp } from "../src/index";
import { buildTestEnv } from "./test-env";

// Exercises apps/api's static-SPA-serving layer (the Node/Hono replacement
// for Cloudflare Pages' apps/web/dist hosting + _headers/_redirects), using a
// throwaway directory standing in for a real `apps/web/dist` build so this
// suite doesn't depend on `npm run build --workspace apps/web` having run.
const INDEX_HTML_MARKER = "<!-- bhasha-spa-shell-marker -->";
const ASSET_MARKER = "console.log('bhasha-static-asset-marker');";

let webDistPath: string;

beforeAll(() => {
  webDistPath = mkdtempSync(path.join(tmpdir(), "bhasha-web-dist-"));
  writeFileSync(
    path.join(webDistPath, "index.html"),
    `<!doctype html><html><body>${INDEX_HTML_MARKER}</body></html>`
  );
  mkdirSync(path.join(webDistPath, "assets"), { recursive: true });
  writeFileSync(path.join(webDistPath, "assets", "app.js"), ASSET_MARKER);
});

afterAll(() => {
  rmSync(webDistPath, { recursive: true, force: true });
});

function envWithWebDist(overrides: Partial<Env> = {}): Env {
  return buildTestEnv({ WEB_DIST_PATH: webDistPath, ...overrides });
}

async function request(path: string, init: RequestInit = {}, env: Env = envWithWebDist()): Promise<Response> {
  const app = createApp(env);
  return app.fetch(new Request(`https://bhasha.test${path}`, init));
}

describe("static SPA serving", () => {
  it("serves a real static asset from WEB_DIST_PATH", async () => {
    const response = await request("/assets/app.js");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(ASSET_MARKER);
  });

  it("falls back to index.html for an unknown non-API path (client-side routing)", async () => {
    const response = await request("/programs/some-slug/listen");

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(INDEX_HTML_MARKER);
  });

  it("falls back to index.html at the root path", async () => {
    const response = await request("/");

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(INDEX_HTML_MARKER);
  });

  it("still 404s an unrecognized /api/* path instead of falling back to index.html", async () => {
    const response = await request("/api/this-route-does-not-exist");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("keeps explicit routes (e.g. /api/health) taking priority over static serving", async () => {
    const response = await request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("sets the client-hint Accept-CH/Critical-CH headers on an API response", async () => {
    const response = await request("/api/health");

    expect(response.headers.get("Accept-CH")).toBe(
      "Sec-CH-UA-Model, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List"
    );
    expect(response.headers.get("Critical-CH")).toBe(
      "Sec-CH-UA-Model, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version"
    );
  });

  it("sets the client-hint Accept-CH/Critical-CH headers on the SPA shell response", async () => {
    const response = await request("/");

    expect(response.headers.get("Accept-CH")).toBe(
      "Sec-CH-UA-Model, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List"
    );
    expect(response.headers.get("Critical-CH")).toBe(
      "Sec-CH-UA-Model, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version"
    );
  });
});
