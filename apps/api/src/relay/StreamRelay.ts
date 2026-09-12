import { extractPcmFromSfuPacket, encodePcmForSfu } from "../realtime/sfuPacket";
import { createCloudflareRealtimeClient } from "../realtime/cloudflareRealtime";
import { RealtimeStreamRepository } from "../db/realtimeStreamRepository";
import { relayToken } from "./relayAuth";
import type { Env } from "../env";
import { json } from "../http";

const CHUNK_BYTES = 16 * 1024;
const FRAME_DURATION_MS = (CHUNK_BYTES / (48000 * 2 * 2)) * 1000;
const SILENCE = new ArrayBuffer(CHUNK_BYTES);
const SILENCE_AFTER_MS = 1500;
const ALARM_CADENCE_MS = 1500;
const OUT_HEAL_GRACE_MS = 12000;

type SocketDir = "in" | "out";

type RelayState = {
  key?: string;
  relaySessionId?: string;
  relayTrackName?: string;
  ingestEndpoint?: string;
  ingestAdapterId?: string;
  egressAdapterId?: string;
  egressSource?: {
    sessionId: string;
    trackName: string;
  };
  lastInboundAt?: number;
};

type RelaySocketAttachment = {
  dir: SocketDir;
  id: string;
};

export function buildWsCallbackUrl(
  request: Request,
  path: string,
  token?: string
): string {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = token ? `?t=${token}` : "";
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class StreamRelay {
  private state: RelayState = {};
  private lastInboundAt = 0;
  private lastSilenceSentAt = 0;
  private inboundFrames = 0;
  private inboundBytes = 0;
  private outboundForwarded = 0;
  private silenceFrames = 0;
  private outDownSince = 0;
  private healInFlight = false;
  private relayTokenForKey?: string;
  private relayTokenValue?: string;

  private alarmCadenceMs = ALARM_CADENCE_MS;
  private pacingCatchupCapOverride?: number;
  private pacingTestHook?: () => void;

  private now: () => number = () => Date.now();
  private fetcher: typeof fetch;
  private client: ReturnType<typeof createCloudflareRealtimeClient>;
  private outboundSink: (frame: ArrayBuffer) => void;

  private readonly defaultOutboundSink = (frame: ArrayBuffer): void => {
    const openOutSockets = this.outSockets();
    for (const ws of openOutSockets) {
      try {
        ws.send(frame);
      } catch (_error) {}
    }
  };

  constructor(
    private readonly stateStorage: DurableObjectState,
    private readonly env: Env
  ) {
    this.outboundSink = this.defaultOutboundSink;
    this.fetcher = this.env.REALTIME_FETCH ?? fetch;
    this.client = createCloudflareRealtimeClient(this.env, this.fetcher);

    this.stateStorage.blockConcurrencyWhile(async () => {
      await this.restoreFromStorage();
    });
  }

  private async save() {
    await this.stateStorage.storage.put("relay", this.state);
  }

  private async restoreFromStorage(): Promise<void> {
    const persisted = await this.stateStorage.storage.get<RelayState>("relay");
    this.state = persisted ?? {};

    const now = this.now();
    this.lastInboundAt = Math.min(this.state.lastInboundAt ?? 0, now);
    const silenceFloor = now - this.alarmCadenceMs;
    this.lastSilenceSentAt = Math.max(this.lastInboundAt, silenceFloor);

    if (this.state.ingestAdapterId) {
      await this.ensureAlarmScheduled();
    }
  }

  public async __simulateEviction(): Promise<void> {
    this.lastInboundAt = 0;
    this.lastSilenceSentAt = 0;
    await this.restoreFromStorage();
  }

  private async getRelayCallbackToken(): Promise<string | undefined> {
    if (!this.env.RELAY_INTERNAL_SECRET || !this.state.key) {
      return undefined;
    }

    if (
      this.relayTokenForKey === this.state.key &&
      this.relayTokenValue
    ) {
      return this.relayTokenValue;
    }

    this.relayTokenForKey = this.state.key;
    this.relayTokenValue = await relayToken(
      this.env.RELAY_INTERNAL_SECRET,
      this.state.key
    );
    return this.relayTokenValue;
  }

  private outSockets(): WebSocket[] {
    return this.stateStorage.getWebSockets().filter((ws) => {
      const attachment = ws.deserializeAttachment() as RelaySocketAttachment | null;
      return (
        attachment?.dir === "out" &&
        ws.readyState === WebSocket.OPEN
      );
    });
  }

  private async ensureAlarmScheduled(): Promise<void> {
    if (!this.state.ingestAdapterId) {
      return;
    }

    const currentAlarm = await this.stateStorage.storage.getAlarm();
    if (currentAlarm === null) {
      await this.stateStorage.storage.setAlarm(this.now() + this.alarmCadenceMs);
    }
  }

  public async alarm(): Promise<void> {
    let shouldPersistState = false;

    try {
      await this.maybeHealOut();
      shouldPersistState = this.pacingStep();
    } finally {
      if (shouldPersistState) {
        await this.save();
      }

      if (this.state.ingestAdapterId) {
        await this.stateStorage.storage.setAlarm(this.now() + this.alarmCadenceMs);
      }
    }
  }

  public async maybeHealOut(): Promise<void> {
    if (this.healInFlight) {
      return;
    }

    if (!this.state.ingestAdapterId || !this.state.ingestEndpoint) {
      this.outDownSince = 0;
      return;
    }

    if (this.outSockets().length > 0) {
      this.outDownSince = 0;
      return;
    }

    const now = this.now();
    if (this.outDownSince === 0) {
      this.outDownSince = now;
      return;
    }

    if (now - this.outDownSince < OUT_HEAL_GRACE_MS) {
      return;
    }

    try {
      this.healInFlight = true;
      await this.rebuildIngest(this.state.ingestEndpoint);
      this.outDownSince = 0;
    } catch (error) {
      console.error("relay /out self-heal failed", error);
      this.outDownSince = this.now();
    } finally {
      this.healInFlight = false;
    }
  }

  private get catchupFrameBudget(): number {
    if (this.pacingCatchupCapOverride !== undefined) {
      return this.pacingCatchupCapOverride;
    }

    return Math.ceil(this.alarmCadenceMs / FRAME_DURATION_MS) + 4;
  }

  public tick(): void {
    this.pacingStep();
  }

  private pacingStep(): boolean {
    if (this.pacingTestHook) {
      this.pacingTestHook();
    }

    if (
      this.outSockets().length === 0 &&
      this.outboundSink === this.defaultOutboundSink
    ) {
      return false;
    }

    if (this.now() - this.lastInboundAt <= SILENCE_AFTER_MS) {
      return false;
    }

    const now = this.now();
    const persistedInboundAt = this.state.lastInboundAt;

    if (this.lastSilenceSentAt === 0) {
      this.lastSilenceSentAt = this.lastInboundAt;
    }

    const silenceFloor = now - this.alarmCadenceMs;
    this.lastSilenceSentAt = Math.max(this.lastSilenceSentAt, silenceFloor);

    let sent = 0;
    while (
      now - this.lastSilenceSentAt >= FRAME_DURATION_MS &&
      sent < this.catchupFrameBudget
    ) {
      this.outboundSink(encodePcmForSfu(SILENCE));
      this.silenceFrames++;
      this.lastSilenceSentAt += FRAME_DURATION_MS;
      sent++;
    }

    if (now - this.lastSilenceSentAt >= FRAME_DURATION_MS) {
      this.lastSilenceSentAt = now;
    }

    if (sent > 0 && persistedInboundAt !== this.lastInboundAt) {
      this.state.lastInboundAt = this.lastInboundAt;
      return true;
    }

    return false;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const relayIndex = parts.indexOf("relay");
    const key = parts[relayIndex + 1];
    const action = parts[relayIndex + 2];

    if (key && !this.state.key) {
      this.state.key = key;
      this.state.relayTrackName = key;
      await this.save();
    }

    try {
      switch (action) {
        case "in":
        case "out":
          return await this.handleSfuSocket(request, action);
        case "ensure":
          return await this.handleEnsure(request);
        case "attach":
          return await this.handleAttach(request);
        case "teardown":
          return await this.handleTeardown();
        case "detach":
          return await this.handleDetach(request);
        case "snapshot":
          return await this.handleSnapshot();
        default:
          return json({ error: "not_found" }, { status: 404 });
      }
    } catch (error) {
      return json(
        {
          error: String((error as Error)?.message || error)
        },
        { status: 500 }
      );
    }
  }

  private async handleSfuSocket(request: Request, dir: SocketDir): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ error: "websocket_required" }, { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.stateStorage.acceptWebSocket(server);
    server.serializeAttachment({ dir, id: crypto.randomUUID() });

    for (const ws of this.stateStorage.getWebSockets()) {
      if (ws === server) {
        continue;
      }

      const attachment = ws.deserializeAttachment() as RelaySocketAttachment | null;
      if (attachment?.dir === dir && ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "superseded");
      }
    }

    const endpoint = buildWsCallbackUrl(
      request,
      `/api/relay/${this.state.key}/out`,
      await this.getRelayCallbackToken()
    );

    if (this.state.ingestEndpoint !== endpoint) {
      this.state.ingestEndpoint = endpoint;
      await this.save();
    }

    await this.ensureAlarmScheduled();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const attachment = ws.deserializeAttachment() as RelaySocketAttachment | null;
    if (!attachment || attachment.dir !== "in" || typeof message === "string") {
      return;
    }

    const pcm = extractPcmFromSfuPacket(message);
    if (!pcm) {
      return;
    }

    this.lastInboundAt = this.now();
    this.inboundFrames++;
    this.inboundBytes += pcm.byteLength;

    for (let offset = 0; offset < pcm.byteLength; offset += CHUNK_BYTES) {
      const chunk = pcm.slice(offset, offset + CHUNK_BYTES);
      this.outboundSink(encodePcmForSfu(chunk));
      this.outboundForwarded++;
    }
  }

  async webSocketClose(): Promise<void> {}
  async webSocketError(): Promise<void> {}

  private async handleEnsure(request: Request): Promise<Response> {
    const force = new URL(request.url).searchParams.get("force");
    const forceRebuild =
      force === "1" || force?.toLowerCase() === "true";

    if (!forceRebuild && this.state.ingestAdapterId && this.state.relaySessionId) {
      const token = await this.getRelayCallbackToken();
      const endpoint = buildWsCallbackUrl(
        request,
        `/api/relay/${this.state.key}/out`,
        token
      );

      if (this.state.ingestEndpoint !== endpoint) {
        this.state.ingestEndpoint = endpoint;
        await this.save();
      }

      await this.ensureAlarmScheduled();

      return json({
        reused: true,
        relaySessionId: this.state.relaySessionId,
        relayTrackName: this.state.relayTrackName
      });
    }

    const endpoint = buildWsCallbackUrl(
      request,
      `/api/relay/${this.state.key}/out`,
      await this.getRelayCallbackToken()
    );
    await this.rebuildIngest(endpoint);

    return json({
      reused: false,
      relaySessionId: this.state.relaySessionId,
      relayTrackName: this.state.relayTrackName,
      ingestAdapterId: this.state.ingestAdapterId
    });
  }

  private async rebuildIngest(endpoint: string): Promise<void> {
    if (this.state.ingestAdapterId) {
      await this.client.closeWebSocketAdapter(this.state.ingestAdapterId);
    }

    const { sessionId, adapterId } = await this.client.pushTrackFromWebSocket(
      this.state.relayTrackName!,
      endpoint
    );
    const { programId, streamId } = this.parseRelayKey();

    this.state.relaySessionId = sessionId;
    this.state.ingestAdapterId = adapterId;
    this.state.ingestEndpoint = endpoint;

    await this.save();
    await this.ensureAlarmScheduled();
    await this.persistRelayCoords(programId, streamId);
  }

  private async handleAttach(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch (_error) {
      return new Response(JSON.stringify({ error: "invalid_body" }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }

    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof (body as { sessionId?: string }).sessionId !== "string" ||
      typeof (body as { trackName?: string }).trackName !== "string"
    ) {
      return new Response(JSON.stringify({ error: "invalid_body" }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }

    const { sessionId, trackName } = body as {
      sessionId: string;
      trackName: string;
    };

    if (this.state.egressAdapterId) {
      await this.client.closeWebSocketAdapter(this.state.egressAdapterId);
      delete this.state.egressAdapterId;
      delete this.state.egressSource;
    }

    const endpoint = buildWsCallbackUrl(
      request,
      `/api/relay/${this.state.key}/in`,
      await this.getRelayCallbackToken()
    );
    const { adapterId } = await this.client.pullTrackToWebSocket(
      sessionId,
      trackName,
      endpoint
    );

    this.state.egressAdapterId = adapterId;
    this.state.egressSource = { sessionId, trackName };
    await this.save();

    return json({
      egressAdapterId: adapterId,
      egressSource: this.state.egressSource
    });
  }

  private async handleTeardown(): Promise<Response> {
    await this.stateStorage.storage.deleteAlarm();

    if (this.state.egressAdapterId) {
      await this.client.closeWebSocketAdapter(this.state.egressAdapterId);
      delete this.state.egressAdapterId;
      delete this.state.egressSource;
    }

    if (this.state.ingestAdapterId) {
      await this.client.closeWebSocketAdapter(this.state.ingestAdapterId);
      delete this.state.ingestAdapterId;
      delete this.state.relaySessionId;
      delete this.state.relayTrackName;
      const { programId, streamId } = this.parseRelayKey();
      await this.clearRelayCoords(programId, streamId);
    }

    for (const ws of this.stateStorage.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as RelaySocketAttachment | null;
      if (
        attachment &&
        (attachment.dir === "in" || attachment.dir === "out") &&
        ws.readyState === WebSocket.OPEN
      ) {
        try {
          ws.close(1000, "teardown");
        } catch (_error) {}
      }
    }

    await this.stateStorage.storage.delete("relay");
    this.state = {};
    return json({ teardown: true });
  }

  private async handleDetach(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch (_error) {
      body = null;
    }

    const sessionId =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { sessionId?: unknown }).sessionId
        : undefined;
    const staleSession =
      this.state.egressSource &&
      this.state.egressSource.sessionId !== sessionId &&
      typeof sessionId === "string";

    if (staleSession && this.state.egressAdapterId) {
      // A newer session attached since this stop was queued (waitUntil race) — no-op.
      return json({
        detached: false,
        stale: true,
        ingestStillOpen: !!this.state.ingestAdapterId
      });
    }

    if (this.state.egressAdapterId) {
      await this.client.closeWebSocketAdapter(this.state.egressAdapterId);
      delete this.state.egressAdapterId;
      delete this.state.egressSource;
      await this.save();
    }

    return json({ detached: true, ingestStillOpen: !!this.state.ingestAdapterId });
  }

  private async handleSnapshot(): Promise<Response> {
    const now = this.now();
    const alarm = await this.stateStorage.storage.getAlarm();

    return json({
      key: this.state.key,
      relaySessionId: this.state.relaySessionId,
      relayTrackName: this.state.relayTrackName,
      ingestAdapterId: this.state.ingestAdapterId,
      egressAdapterId: this.state.egressAdapterId,
      egressSource: this.state.egressSource,
      sockets: this.stateStorage.getWebSockets().map((ws) => {
        const attachment = ws.deserializeAttachment() as
          | RelaySocketAttachment
          | null;
        return `${attachment?.dir ?? "unknown"}:${ws.readyState}`;
      }),
      msSinceLastInbound: this.lastInboundAt ? now - this.lastInboundAt : null,
      counters: {
        inboundFrames: this.inboundFrames,
        inboundBytes: this.inboundBytes,
        outboundForwarded: this.outboundForwarded,
        silenceFrames: this.silenceFrames
      },
      selfHeal: {
        outDownMs: this.outDownSince ? now - this.outDownSince : 0,
        healInFlight: this.healInFlight,
        ingestEndpointKnown: !!this.state.ingestEndpoint,
        nextAlarmInMs: alarm ? alarm - now : null
      }
    });
  }

  public __setTestHooks(hooks: {
    now?: () => number;
    fetcher?: typeof fetch;
    outboundSink?: (frame: ArrayBuffer) => void;
    alarmCadenceMs?: number;
    pacingCatchupCap?: number;
    pacingTestHook?: () => void;
  }): void {
    if (hooks.now) {
      this.now = hooks.now;
      const silenceFloor = this.now() - this.alarmCadenceMs;
      this.lastSilenceSentAt = Math.max(this.lastInboundAt, silenceFloor);
    }

    if (hooks.alarmCadenceMs !== undefined) {
      if (Number.isFinite(hooks.alarmCadenceMs) && hooks.alarmCadenceMs > 0) {
        this.alarmCadenceMs = hooks.alarmCadenceMs;
        const silenceFloor = this.now() - this.alarmCadenceMs;
        this.lastSilenceSentAt = Math.max(this.lastInboundAt, silenceFloor);
      }
    }

    if (hooks.pacingCatchupCap !== undefined) {
      this.pacingCatchupCapOverride = hooks.pacingCatchupCap;
    }

    if (hooks.pacingTestHook) {
      this.pacingTestHook = hooks.pacingTestHook;
    }

    if (hooks.fetcher && hooks.fetcher !== this.fetcher) {
      this.fetcher = hooks.fetcher;
      this.client = createCloudflareRealtimeClient(this.env, this.fetcher);
    }

    if (hooks.outboundSink) {
      this.outboundSink = hooks.outboundSink;
    }
  }

  private parseRelayKey(): { programId: string; streamId: string } {
    const key = this.state.key ?? "";
    const delimiter = key.indexOf(":");
    if (delimiter < 0) {
      return {
        programId: key,
        streamId: key
      };
    }

    return {
      programId: key.slice(0, delimiter),
      streamId: key.slice(delimiter + 1)
    };
  }

  private async persistRelayCoords(
    programId: string,
    streamId: string
  ): Promise<void> {
    const relaySessionId = this.state.relaySessionId;
    const relayTrackName = this.state.relayTrackName;

    if (!relaySessionId || !relayTrackName) {
      console.warn(
        "skip relay coord persistence because session/track is missing",
        {
          programId,
          streamId,
          relaySessionId,
          relayTrackName
        }
      );
      return;
    }

    try {
      await new RealtimeStreamRepository(this.env.DB).setRelayCoords({
        programId,
        streamId,
        relaySessionId,
        relayTrackName
      });
    } catch (_error) {
      console.error("failed to persist relay coords", _error);
    }
  }

  private async clearRelayCoords(programId: string, streamId: string): Promise<void> {
    try {
      await new RealtimeStreamRepository(this.env.DB).clearRelayCoords({
        programId,
        streamId
      });
    } catch (_error) {
      console.error("failed to clear relay coords", _error);
    }
  }

}
