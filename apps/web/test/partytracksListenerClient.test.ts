import { Subject, type Observable } from "rxjs";
import type { PartyTracksConfig, TrackMetadata } from "partytracks/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ListenerApi } from "../src/api/listeners";
import {
  createPartytracksListenerClient,
  type PartyTracksListenerHandle
} from "../src/realtime/partytracksListenerClient";

type MaybeObservableTrack = ReturnType<typeof Observable.create>;

class FakePartyTracks implements PartyTracksListenerHandle {
  readonly track$ = new Subject<MediaStreamTrack>();
  pulledMeta: TrackMetadata[] = [];
  config: PartyTracksConfig | null = null;

  pull(trackData$: Observable<TrackMetadata>): Observable<MediaStreamTrack> {
    trackData$.subscribe((meta) => {
      this.pulledMeta.push(meta);
    });
    return this.track$.asObservable();
  }
}

let trackSequence = 0;
function fakeTrack(): MediaStreamTrack {
  trackSequence += 1;
  return { id: `track-${trackSequence}` } as unknown as MediaStreamTrack;
}

function fakeApi(overrides: Partial<ListenerApi> = {}): ListenerApi {
  return {
    subscribeSession: vi.fn(async () => ({
      connectionId: "not-used",
      streamId: "not-used",
      sessionDescription: { type: "offer", sdp: "" },
      iceServers: []
    })),
    subscribeTrack: vi.fn(async () => ({
      connectionId: "not-used",
      track: { mid: "0" },
      requiresImmediateRenegotiation: false
    })),
    subscribeRenegotiate: vi.fn(async () => ({ ok: true })),
    connected: vi.fn(async () => ({ ok: true })),
    heartbeat: vi.fn(async () => ({ ok: true })),
    leave: vi.fn(async () => ({ ok: true })),
    switch: vi.fn(async () => ({ connectionId: "not-used" })),
    reconnect: vi.fn(async () => ({ connectionId: "not-used" })),
    iceServers: vi.fn(async () => ({ iceServers: [] })),
    requestConnection: vi.fn(async () => ({ connectionId: "not-used" })),
    activePublisher: vi.fn(async () => ({ sessionId: "not-used", trackName: "not-used" })),
    ...overrides
  } as unknown as ListenerApi;
}

function clientWith(api: ListenerApi): {
  client: ReturnType<typeof createPartytracksListenerClient>;
  party: FakePartyTracks;
} {
  const party = new FakePartyTracks();
  const client = createPartytracksListenerClient({
    listenerApi: api,
    createPartyTracks: (config) => {
      party.config = config;
      return party;
    }
  });
  return { client, party };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("partytracks listener client", () => {
  it("reads the current access token for fresh, switch, and reconnect acquisitions", async () => {
    let accessToken = "access-token-1";
    const api = fakeApi({
      activePublisher: vi.fn(async () => ({
        sessionId: "session-1",
        trackName: "track-main"
      })),
      requestConnection: vi.fn(async () => ({ connectionId: "conn-1" })),
      switch: vi.fn(async () => ({ connectionId: "conn-2" }))
    });
    const party = new FakePartyTracks();
    const client = createPartytracksListenerClient({
      listenerApi: api,
      getAccessToken: () => accessToken,
      createPartyTracks: () => party
    });

    const pending = client.subscribe({
      programSlug: "program-1",
      streamId: "stream-1",
      clientId: "client-1"
    });
    await flush();
    party.track$.next(fakeTrack());
    await pending;

    accessToken = "access-token-2";
    await client.switch({
      connectionId: "conn-1",
      programSlug: "program-1",
      nextStreamId: "stream-2",
      clientId: "client-1"
    });

    accessToken = "access-token-3";
    await client.reconnect({
      connectionId: "conn-2",
      programSlug: "program-1",
      streamId: "stream-2",
      clientId: "client-1"
    });

    expect(api.activePublisher).toHaveBeenNthCalledWith(1, {
      programSlug: "program-1",
      streamId: "stream-1",
      accessToken: "access-token-1"
    });
    expect(api.requestConnection).toHaveBeenCalledWith({
      programSlug: "program-1",
      streamId: "stream-1",
      clientId: "client-1",
      accessToken: "access-token-1"
    });
    expect(api.switch).toHaveBeenCalledWith({
      programSlug: "program-1",
      streamId: "stream-2",
      clientId: "client-1",
      fromConnectionId: "conn-1",
      accessToken: "access-token-2"
    });
    expect(api.activePublisher).toHaveBeenNthCalledWith(2, {
      programSlug: "program-1",
      streamId: "stream-2",
      accessToken: "access-token-2"
    });
    expect(api.activePublisher).toHaveBeenNthCalledWith(3, {
      programSlug: "program-1",
      streamId: "stream-2",
      accessToken: "access-token-3"
    });
  });

  it("subscribes by checking live publisher, requesting a connection, and pulling the first track", async () => {
    const api = fakeApi({
      activePublisher: vi.fn(async () => ({
        sessionId: "session-1",
        trackName: "track-main"
      })),
      requestConnection: vi.fn(async () => ({ connectionId: "conn-1" }))
    });

    const { client, party } = clientWith(api);

    const pending = client.subscribe({
      programSlug: "program-1",
      streamId: "stream-1",
      clientId: "client-1"
    });

    await flush();
    const track = fakeTrack();
    party.track$.next(track);

    const session = await pending;

    expect(party.config?.prefix).toBe("/api/partytracks");
    expect(api.activePublisher).toHaveBeenCalledWith({
      programSlug: "program-1",
      streamId: "stream-1"
    });
    expect(api.requestConnection).toHaveBeenCalledWith({
      programSlug: "program-1",
      streamId: "stream-1",
      clientId: "client-1"
    });
    expect(party.pulledMeta[0]).toEqual({
      location: "remote",
      sessionId: "session-1",
      trackName: "track-main"
    });
    expect(session).toMatchObject({
      connectionId: "conn-1",
      streamId: "stream-1",
      mediaStream: expect.any(MediaStream)
    });
    expect(session.mediaStream.getTracks()).toContain(track);
    expect(api.connected).toHaveBeenCalledWith({ connectionId: "conn-1" });
  });

  it("reconnects and re-pulls the new publisher metadata into the same MediaStream", async () => {
    const api = fakeApi({
      activePublisher: vi
        .fn()
        .mockResolvedValueOnce({ sessionId: "session-1", trackName: "track-main" })
        .mockResolvedValueOnce({ sessionId: "session-2", trackName: "track-reconnect" }),
      requestConnection: vi.fn(async () => ({ connectionId: "conn-1" }))
    });

    const { client, party } = clientWith(api);

    const pending = client.subscribe({
      programSlug: "program-1",
      streamId: "stream-1",
      clientId: "client-1"
    });

    await flush();
    const firstTrack = fakeTrack();
    party.track$.next(firstTrack);
    const firstSession = await pending;

    const reconnecting = client.reconnect({
      connectionId: "conn-1",
      programSlug: "program-1",
      streamId: "stream-1",
      clientId: "client-1"
    });

    await flush();
    const secondTrack = fakeTrack();
    party.track$.next(secondTrack);
    const secondSession = await reconnecting;

    expect(secondSession.mediaStream).toBe(firstSession.mediaStream);
    expect(secondSession.connectionId).toBe("conn-1");
    expect(secondSession.mediaStream.getTracks()).toHaveLength(1);
    expect(secondSession.mediaStream.getTracks()[0]).toBe(secondTrack);
    expect(party.pulledMeta.at(-1)).toEqual({
      location: "remote",
      sessionId: "session-2",
      trackName: "track-reconnect"
    });
  });

  it("switches stream, updates connection id, and repulls on the same MediaStream", async () => {
    const api = fakeApi({
      activePublisher: vi
        .fn()
        .mockResolvedValueOnce({ sessionId: "session-1", trackName: "track-main" })
        .mockResolvedValueOnce({ sessionId: "session-2", trackName: "track-next" }),
      requestConnection: vi.fn(async () => ({ connectionId: "conn-1" })),
      switch: vi.fn(async () => ({ connectionId: "conn-2" }))
    });

    const { client, party } = clientWith(api);

    const pending = client.subscribe({
      programSlug: "program-1",
      streamId: "stream-1",
      clientId: "client-1"
    });

    await flush();
    const firstTrack = fakeTrack();
    party.track$.next(firstTrack);
    const firstSession = await pending;

    const switching = client.switch({
      connectionId: "conn-1",
      programSlug: "program-1",
      nextStreamId: "stream-2",
      clientId: "client-1"
    });

    expect(api.switch).toHaveBeenCalledWith({
      programSlug: "program-1",
      streamId: "stream-2",
      clientId: "client-1",
      fromConnectionId: "conn-1"
    });

    await flush();
    const secondTrack = fakeTrack();
    party.track$.next(secondTrack);
    const secondSession = await switching;

    expect(secondSession.mediaStream).toBe(firstSession.mediaStream);
    expect(secondSession.connectionId).toBe("conn-2");
    expect(secondSession.mediaStream.getTracks()).toHaveLength(1);
    expect(secondSession.mediaStream.getTracks()[0]).toBe(secondTrack);
    expect(party.pulledMeta.at(-1)).toEqual({
      location: "remote",
      sessionId: "session-2",
      trackName: "track-next"
    });
  });

  it("stops and unsubscribes the track pull, passing listener_left by default", async () => {
    const api = fakeApi({
      activePublisher: vi.fn(async () => ({
        sessionId: "session-1",
        trackName: "track-main"
      })),
      requestConnection: vi.fn(async () => ({ connectionId: "conn-1" }))
    });

    const { client, party } = clientWith(api);

    const pending = client.subscribe({
      programSlug: "program-1",
      streamId: "stream-1",
      clientId: "client-1"
    });

    await flush();
    const firstTrack = fakeTrack();
    party.track$.next(firstTrack);
    const session = await pending;

    await client.stop({ connectionId: "conn-1" });
    expect(api.leave).toHaveBeenCalledWith({ connectionId: "conn-1", reason: "listener_left" });

    const before = session.mediaStream.getTracks().length;
    party.track$.next(fakeTrack());
    await flush();

    expect(session.mediaStream.getTracks()).toHaveLength(before);
    expect(session.mediaStream.getTracks()[0]).toBe(firstTrack);
  });

  it("rejects subscribe when active publisher check fails and never requests a connection", async () => {
    const api = fakeApi({
      activePublisher: vi.fn(async () => {
        throw new Error("offline");
      }),
      requestConnection: vi.fn()
    });

    const { client } = clientWith(api);

    const pending = client.subscribe({
      programSlug: "program-1",
      streamId: "stream-1",
      clientId: "client-1"
    });

    await expect(pending).rejects.toThrow("offline");
    expect(api.requestConnection).not.toHaveBeenCalled();
  });
});
