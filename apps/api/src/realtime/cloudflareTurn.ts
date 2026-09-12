import type { Env } from "../env";

export const DEFAULT_TURN_BASE_URL = "https://rtc.live.cloudflare.com/v1";
export const TURN_TTL_SECONDS = 3600;
export const STUN_ICE_SERVERS: IceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" }
];

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface TurnIssueInput {
  role: "listener" | "translator" | "smoke";
  programId: string;
  streamId?: string;
  connectionId?: string;
}

export interface IceServersResult {
  iceServers: IceServer[];
  turnConfigured: boolean;
  turnIncluded: boolean;
}

type TurnEnv = Pick<
  Env,
  | "CLOUDFLARE_TURN_KEY_ID"
  | "CLOUDFLARE_TURN_API_TOKEN"
  | "CLOUDFLARE_TURN_BASE_URL"
  | "TURN_FETCH"
>;

// Cloudflare docs flag alternate port 53 as commonly blocked by browsers, so we
// strip any ICE URL that targets it. The negative lookahead keeps real ports
// such as :5349 and :53478 intact while removing :53 (with or without query).
const BLOCKED_PORT_53 = /:53(?!\d)/;

function trimmed(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isTurnConfigured(
  env: Pick<Env, "CLOUDFLARE_TURN_KEY_ID" | "CLOUDFLARE_TURN_API_TOKEN">
): boolean {
  return (
    trimmed(env.CLOUDFLARE_TURN_KEY_ID).length > 0 &&
    trimmed(env.CLOUDFLARE_TURN_API_TOKEN).length > 0
  );
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (trimmed(baseUrl) || DEFAULT_TURN_BASE_URL).replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filterUrlList(urls: string[]): string[] {
  return urls.filter((url) => !BLOCKED_PORT_53.test(url));
}

// Keep only WebRTC-relevant fields. The TURN key id and api token must never be
// forwarded to the browser, so we rebuild each server from an allow-list.
function normalizeIceServer(value: unknown): IceServer | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawUrls = value.urls;
  let urls: string | string[];
  if (typeof rawUrls === "string") {
    if (BLOCKED_PORT_53.test(rawUrls)) {
      return null;
    }
    urls = rawUrls;
  } else if (Array.isArray(rawUrls)) {
    const filtered = filterUrlList(
      rawUrls.filter((url): url is string => typeof url === "string")
    );
    if (filtered.length === 0) {
      return null;
    }
    urls = filtered;
  } else {
    return null;
  }

  const server: IceServer = { urls };
  if (typeof value.username === "string") {
    server.username = value.username;
  }
  if (typeof value.credential === "string") {
    server.credential = value.credential;
  }
  return server;
}

function normalizeIceServers(payload: unknown): IceServer[] {
  if (!isRecord(payload)) {
    return [];
  }

  const raw = payload.iceServers;
  const candidates = Array.isArray(raw) ? raw : [raw];
  return candidates
    .map((candidate) => normalizeIceServer(candidate))
    .filter((server): server is IceServer => server !== null);
}

function stunOnly(turnConfigured: boolean): IceServersResult {
  return {
    iceServers: [...STUN_ICE_SERVERS],
    turnConfigured,
    turnIncluded: false
  };
}

export async function getIceServersForClient(
  env: TurnEnv,
  _input: TurnIssueInput
): Promise<IceServersResult> {
  if (!isTurnConfigured(env)) {
    return stunOnly(false);
  }

  const keyId = trimmed(env.CLOUDFLARE_TURN_KEY_ID);
  const apiToken = trimmed(env.CLOUDFLARE_TURN_API_TOKEN);
  const baseUrl = normalizeBaseUrl(env.CLOUDFLARE_TURN_BASE_URL);
  const fetcher = env.TURN_FETCH ?? fetch;
  const url = `${baseUrl}/turn/keys/${encodeURIComponent(
    keyId
  )}/credentials/generate-ice-servers`;

  let turnServers: IceServer[];
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ ttl: TURN_TTL_SECONDS })
    });

    if (!response.ok) {
      return stunOnly(true);
    }

    const text = await response.text();
    const payload: unknown = text.trim() === "" ? {} : JSON.parse(text);
    turnServers = normalizeIceServers(payload);
  } catch (_error) {
    // TURN issuance is best-effort: if Cloudflare is unreachable or returns an
    // unexpected shape, the session still proceeds STUN-only rather than failing.
    return stunOnly(true);
  }

  if (turnServers.length === 0) {
    return stunOnly(true);
  }

  return {
    iceServers: [...STUN_ICE_SERVERS, ...turnServers],
    turnConfigured: true,
    turnIncluded: true
  };
}
