import { describe, expect, it } from "vitest";

import {
  DEFAULT_TURN_BASE_URL,
  STUN_ICE_SERVERS,
  TURN_TTL_SECONDS,
  getIceServersForClient,
  isTurnConfigured
} from "../src/realtime/cloudflareTurn";

type TurnCall = {
  url: string;
  method: string | undefined;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
};

const TURN_KEY_ID = "turn-key-123";
const TURN_API_TOKEN = "turn-token-secret-abc";

function fakeFetch(
  calls: TurnCall[],
  responder: () => { body: unknown; status?: number } | Promise<never>
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      authorization: new Headers(init?.headers).get("authorization"),
      contentType: new Headers(init?.headers).get("content-type"),
      body:
        init?.body === undefined || init?.body === null
          ? null
          : JSON.parse(String(init.body))
    });
    const result = await responder();
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200
    });
  }) as typeof fetch;
}

function throwingFetch(calls: TurnCall[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      authorization: new Headers(init?.headers).get("authorization"),
      contentType: new Headers(init?.headers).get("content-type"),
      body:
        init?.body === undefined || init?.body === null
          ? null
          : JSON.parse(String(init.body))
    });
    throw new Error("network down");
  }) as typeof fetch;
}

describe("cloudflare TURN client", () => {
  it("reports configuration only when both key id and api token are present", () => {
    expect(
      isTurnConfigured({
        CLOUDFLARE_TURN_KEY_ID: TURN_KEY_ID,
        CLOUDFLARE_TURN_API_TOKEN: TURN_API_TOKEN
      })
    ).toBe(true);
    expect(
      isTurnConfigured({
        CLOUDFLARE_TURN_KEY_ID: TURN_KEY_ID
      })
    ).toBe(false);
    expect(
      isTurnConfigured({
        CLOUDFLARE_TURN_KEY_ID: "  ",
        CLOUDFLARE_TURN_API_TOKEN: TURN_API_TOKEN
      })
    ).toBe(false);
    expect(isTurnConfigured({})).toBe(false);
  });

  it("requests generate-ice-servers with bearer auth and a bounded ttl", async () => {
    const calls: TurnCall[] = [];
    const env = {
      CLOUDFLARE_TURN_KEY_ID: TURN_KEY_ID,
      CLOUDFLARE_TURN_API_TOKEN: TURN_API_TOKEN,
      TURN_FETCH: fakeFetch(calls, () => ({
        body: {
          iceServers: {
            urls: [
              "turn:turn.cloudflare.com:3478?transport=udp",
              "turns:turn.cloudflare.com:5349?transport=tcp"
            ],
            username: "cf-user",
            credential: "cf-credential"
          }
        }
      }))
    };

    const result = await getIceServersForClient(env, {
      role: "listener",
      programId: "program-1",
      streamId: "stream-1",
      connectionId: "connection-1"
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `${DEFAULT_TURN_BASE_URL}/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.authorization).toBe(`Bearer ${TURN_API_TOKEN}`);
    expect(calls[0]?.contentType).toContain("application/json");
    expect(calls[0]?.body).toEqual({ ttl: TURN_TTL_SECONDS });
    expect(TURN_TTL_SECONDS).toBe(3600);

    expect(result.turnConfigured).toBe(true);
    expect(result.turnIncluded).toBe(true);
    expect(result.iceServers).toEqual([
      ...STUN_ICE_SERVERS,
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turns:turn.cloudflare.com:5349?transport=tcp"
        ],
        username: "cf-user",
        credential: "cf-credential"
      }
    ]);
  });

  it("removes ICE URLs that use the browser-blocked port 53", async () => {
    const calls: TurnCall[] = [];
    const env = {
      CLOUDFLARE_TURN_KEY_ID: TURN_KEY_ID,
      CLOUDFLARE_TURN_API_TOKEN: TURN_API_TOKEN,
      TURN_FETCH: fakeFetch(calls, () => ({
        body: {
          iceServers: [
            {
              urls: [
                "turn:turn.cloudflare.com:53?transport=udp",
                "turn:turn.cloudflare.com:3478?transport=udp",
                "turns:turn.cloudflare.com:5349?transport=tcp"
              ],
              username: "cf-user",
              credential: "cf-credential"
            },
            {
              urls: "turn:turn.cloudflare.com:53?transport=tcp",
              username: "cf-user",
              credential: "cf-credential"
            }
          ]
        }
      }))
    };

    const result = await getIceServersForClient(env, {
      role: "translator",
      programId: "program-1",
      streamId: "stream-1"
    });

    expect(result.turnIncluded).toBe(true);
    expect(result.iceServers).toEqual([
      ...STUN_ICE_SERVERS,
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turns:turn.cloudflare.com:5349?transport=tcp"
        ],
        username: "cf-user",
        credential: "cf-credential"
      }
    ]);
  });

  it("degrades to STUN-only when TURN is not configured", async () => {
    const calls: TurnCall[] = [];
    const result = await getIceServersForClient(
      {
        TURN_FETCH: fakeFetch(calls, () => ({ body: {} }))
      },
      { role: "listener", programId: "program-1" }
    );

    expect(calls).toHaveLength(0);
    expect(result.turnConfigured).toBe(false);
    expect(result.turnIncluded).toBe(false);
    expect(result.iceServers).toEqual(STUN_ICE_SERVERS);
  });

  it("degrades to STUN-only when the TURN provider call fails", async () => {
    const calls: TurnCall[] = [];
    const result = await getIceServersForClient(
      {
        CLOUDFLARE_TURN_KEY_ID: TURN_KEY_ID,
        CLOUDFLARE_TURN_API_TOKEN: TURN_API_TOKEN,
        TURN_FETCH: throwingFetch(calls)
      },
      { role: "listener", programId: "program-1" }
    );

    expect(calls).toHaveLength(1);
    expect(result.turnConfigured).toBe(true);
    expect(result.turnIncluded).toBe(false);
    expect(result.iceServers).toEqual(STUN_ICE_SERVERS);
  });

  it("never leaks the api token or key id in the browser-facing ICE servers", async () => {
    const calls: TurnCall[] = [];
    const env = {
      CLOUDFLARE_TURN_KEY_ID: TURN_KEY_ID,
      CLOUDFLARE_TURN_API_TOKEN: TURN_API_TOKEN,
      TURN_FETCH: fakeFetch(calls, () => ({
        body: {
          iceServers: {
            urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
            username: "cf-user",
            credential: "cf-credential"
          }
        }
      }))
    };

    const result = await getIceServersForClient(env, {
      role: "smoke",
      programId: "program-1"
    });

    const serialized = JSON.stringify(result.iceServers);
    expect(serialized).not.toContain(TURN_API_TOKEN);
    expect(serialized).not.toContain(TURN_KEY_ID);
  });
});
