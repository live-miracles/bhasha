import type { PartyTracksConfig, TrackMetadata } from "partytracks/client";
import { BehaviorSubject, Subject, type Observable } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TranslatorApi } from "../src/api/translator";
import {
  createPartytracksTranslatorClient,
  type PartyTracksHandle
} from "../src/realtime/partytracksTranslatorClient";

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = "connected";
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    for (const listener of this.listeners.get("connectionstatechange") ?? []) {
      listener();
    }
  }

  reset(): void {
    this.connectionState = "connected";
    this.listeners.clear();
  }
}

const fakePc = new FakePeerConnection();

class FakePartyTracks implements PartyTracksHandle {
  readonly metadata$ = new Subject<TrackMetadata>();
  readonly pc$ = new BehaviorSubject<RTCPeerConnection>(
    fakePc as unknown as RTCPeerConnection
  );
  pushCalls = 0;
  pushedTrack: MediaStreamTrack | null = null;
  config: PartyTracksConfig | null = null;

  push(sourceTrack$: Observable<MediaStreamTrack>): Observable<TrackMetadata> {
    this.pushCalls += 1;
    sourceTrack$.subscribe((track) => {
      this.pushedTrack = track;
    });
    return this.metadata$.asObservable();
  }

  get peerConnection$(): Observable<RTCPeerConnection> {
    return this.pc$.asObservable();
  }
}

function fakeTrack(): MediaStreamTrack {
  return { enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
}

function fakeApi(overrides: Partial<TranslatorApi> = {}): TranslatorApi {
  return {
    realtimeTrack: vi.fn(async (streamId: string) => ({
      publishSessionId: "ps-1",
      streamId
    })),
    realtimeStop: vi.fn(async () => ({
      ok: true as const,
      cleanup: "closed" as const
    })),
    ...overrides
  } as unknown as TranslatorApi;
}

function clientWith(api: TranslatorApi): {
  client: ReturnType<typeof createPartytracksTranslatorClient>;
  party: FakePartyTracks;
} {
  const party = new FakePartyTracks();
  const client = createPartytracksTranslatorClient({
    translatorApi: api,
    createPartyTracks: (config) => {
      party.config = config;
      return party;
    }
  });
  return { client, party };
}

afterEach(() => {
  fakePc.reset();
  vi.restoreAllMocks();
});

describe("partytracks translator client", () => {
  it("pushes the mic track and registers reported metadata", async () => {
    const api = fakeApi();
    const { client, party } = clientWith(api);
    const track = fakeTrack();

    const pending = client.publish({ streamId: "stream-1", track });
    party.metadata$.next({
      location: "local",
      sessionId: "cf-session-1",
      trackName: "mic-aaa",
      mid: "0"
    });
    const session = await pending;

    expect(party.pushCalls).toBe(1);
    expect(party.pushedTrack).toBe(track);
    expect(party.config?.prefix).toBe("/api/partytracks");
    expect(api.realtimeTrack).toHaveBeenCalledWith("stream-1", {
      sessionId: "cf-session-1",
      trackName: "mic-aaa",
      mid: "0"
    });
    expect(session).toEqual({
      publishSessionId: "ps-1",
      streamId: "stream-1",
      track,
      peerConnection: fakePc
    });
  });

  it("ignores incomplete metadata emits and resolves on the first complete one", async () => {
    const api = fakeApi();
    const { client, party } = clientWith(api);

    const pending = client.publish({ streamId: "stream-1", track: fakeTrack() });
    party.metadata$.next({ location: "local", sessionId: "cf-session-1" });
    expect(api.realtimeTrack).not.toHaveBeenCalled();

    party.metadata$.next({
      location: "local",
      sessionId: "cf-session-1",
      trackName: "mic-aaa",
      mid: "0"
    });
    await pending;
    expect(api.realtimeTrack).toHaveBeenCalledTimes(1);
  });

  it("registers when partytracks omits mid from push metadata (the real shape)", async () => {
    const api = fakeApi();
    const { client, party } = clientWith(api);

    const pending = client.publish({ streamId: "stream-1", track: fakeTrack() });
    // partytracks deletes `mid` from push metadata before emitting; only
    // sessionId + trackName are present. Registration must still happen.
    party.metadata$.next({
      location: "local",
      sessionId: "cf-session-1",
      trackName: "mic-aaa"
    });
    const session = await pending;

    expect(api.realtimeTrack).toHaveBeenCalledWith("stream-1", {
      sessionId: "cf-session-1",
      trackName: "mic-aaa",
      mid: "0"
    });
    expect(session.publishSessionId).toBe("ps-1");
  });

  it("re-registers a reconnect re-push without re-resolving publish", async () => {
    const realtimeTrack = vi
      .fn()
      .mockResolvedValueOnce({ publishSessionId: "ps-1", streamId: "stream-1" })
      .mockResolvedValueOnce({ publishSessionId: "ps-2", streamId: "stream-1" });
    const api = fakeApi({ realtimeTrack });
    const { client, party } = clientWith(api);

    const pending = client.publish({ streamId: "stream-1", track: fakeTrack() });
    party.metadata$.next({
      location: "local",
      sessionId: "cf-session-1",
      trackName: "mic-aaa",
      mid: "0"
    });
    const session = await pending;
    expect(session.publishSessionId).toBe("ps-1");

    // partytracks re-pushed after an internal transport recovery.
    party.metadata$.next({
      location: "local",
      sessionId: "cf-session-2",
      trackName: "mic-bbb",
      mid: "0"
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(realtimeTrack).toHaveBeenCalledTimes(2);
    expect(realtimeTrack).toHaveBeenLastCalledWith("stream-1", {
      sessionId: "cf-session-2",
      trackName: "mic-bbb",
      mid: "0"
    });
  });

  it("stop() unsubscribes the push and reports backend stop", async () => {
    const api = fakeApi();
    const { client, party } = clientWith(api);

    const pending = client.publish({ streamId: "stream-1", track: fakeTrack() });
    party.metadata$.next({
      location: "local",
      sessionId: "cf-session-1",
      trackName: "mic-aaa",
      mid: "0"
    });
    await pending;

    await client.stop({ publishSessionId: "ps-1" });
    expect(api.realtimeStop).toHaveBeenCalledWith("stream-1", "ps-1");

    // After stop the push is unsubscribed: a further emit must not re-register.
    const callsBefore = (api.realtimeTrack as ReturnType<typeof vi.fn>).mock.calls
      .length;
    party.metadata$.next({
      location: "local",
      sessionId: "cf-session-9",
      trackName: "mic-zzz",
      mid: "0"
    });
    await Promise.resolve();
    expect((api.realtimeTrack as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsBefore
    );
  });

  it("reports publishSessionId on initial publish and each re-push", async () => {
    const realtimeTrack = vi
      .fn()
      .mockResolvedValueOnce({ publishSessionId: "ps-1", streamId: "stream-1" })
      .mockResolvedValueOnce({ publishSessionId: "ps-2", streamId: "stream-1" });
    const api = fakeApi({ realtimeTrack });
    const party = new FakePartyTracks();
    const onPublishSessionId = vi.fn();
    const client = createPartytracksTranslatorClient({
      translatorApi: api,
      createPartyTracks: () => party,
      onPublishSessionId
    });

    const pending = client.publish({ streamId: "stream-1", track: fakeTrack() });
    party.metadata$.next({
      location: "local",
      sessionId: "cf-1",
      trackName: "mic-aaa"
    });
    await pending;
    expect(onPublishSessionId).toHaveBeenLastCalledWith("ps-1");

    // partytracks re-push -> new reservation; the route must learn the new id.
    party.metadata$.next({
      location: "local",
      sessionId: "cf-2",
      trackName: "mic-bbb"
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(onPublishSessionId).toHaveBeenLastCalledWith("ps-2");
    expect(onPublishSessionId).toHaveBeenCalledTimes(2);
  });

  it("reports peer connection state changes for the live reservation", async () => {
    const api = fakeApi();
    const party = new FakePartyTracks();
    const onConnectionStateChange = vi.fn();
    const client = createPartytracksTranslatorClient({
      translatorApi: api,
      createPartyTracks: () => party,
      onConnectionStateChange
    });

    const pending = client.publish({ streamId: "stream-1", track: fakeTrack() });
    party.metadata$.next({
      location: "local",
      sessionId: "cf-1",
      trackName: "mic-aaa"
    });
    await pending;

    fakePc.dispatchConnectionState("failed");

    expect(onConnectionStateChange).toHaveBeenCalledWith("ps-1", "failed");
  });

  it("detaches peer connection state listeners on stop", async () => {
    const api = fakeApi();
    const party = new FakePartyTracks();
    const onConnectionStateChange = vi.fn();
    const client = createPartytracksTranslatorClient({
      translatorApi: api,
      createPartyTracks: () => party,
      onConnectionStateChange
    });

    const pending = client.publish({ streamId: "stream-1", track: fakeTrack() });
    party.metadata$.next({
      location: "local",
      sessionId: "cf-1",
      trackName: "mic-aaa"
    });
    await pending;
    await client.stop({ publishSessionId: "ps-1" });

    fakePc.dispatchConnectionState("failed");

    expect(onConnectionStateChange).not.toHaveBeenCalled();
  });

  it("ignores peer connection state changes before a reservation exists", async () => {
    const api = fakeApi();
    const party = new FakePartyTracks();
    const onConnectionStateChange = vi.fn();
    const client = createPartytracksTranslatorClient({
      translatorApi: api,
      createPartyTracks: () => party,
      onConnectionStateChange
    });

    const pending = client.publish({ streamId: "stream-1", track: fakeTrack() });

    fakePc.dispatchConnectionState("failed");

    expect(onConnectionStateChange).not.toHaveBeenCalled();

    party.metadata$.next({
      location: "local",
      sessionId: "cf-1",
      trackName: "mic-aaa"
    });
    await pending;
  });

  it("mute() toggles the local track without touching the transport", () => {
    const { client } = clientWith(fakeApi());
    const track = fakeTrack();

    client.mute({ track, muted: true });
    expect(track.enabled).toBe(false);
    client.mute({ track, muted: false });
    expect(track.enabled).toBe(true);
  });
});
