import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { RoomEvent } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/client";
import type { PublicApi } from "../src/api/public";
import type {
  TranslatorApi,
  TranslatorHeartbeatResponse,
  TranslatorSessionResponse
} from "../src/api/translator";
import type {
  RoomHandle,
  TranslatorRealtimeClient
} from "../src/realtime/translatorClient";
import {
  TranslatorRoute,
  type TranslatorAudioMeter,
  type TranslatorConnectionStateHandler,
  type TranslatorRouteProps
} from "../src/routes/TranslatorRoute";
import { saveTranslatorPrefs } from "../src/lib/translatorPrefs";

const defaultProgramMetadata = {
  program: {
    slug: "patna-event-2026",
    name: "Patna Event 2026",
    venue: null,
    eventDate: null,
    status: "draft"
  },
  streams: [],
  urls: {
    listenerUrl: "/program/patna-event-2026",
    translatorUrl: "/program/patna-event-2026/translate"
  }
};

function createPublicApi(overrides: Partial<PublicApi> = {}): PublicApi {
  return {
    fetchProgram: vi.fn(async () => defaultProgramMetadata),
    fetchProgramStatus: vi.fn(async () => ({
      program: { slug: "patna-event-2026" },
      streams: [],
      stale: false,
      degraded: false,
      serverTime: new Date().toISOString()
    })),
    ...overrides
  } as PublicApi;
}

let getUserMedia: ReturnType<typeof vi.fn>;
let enumerateDevices: ReturnType<typeof vi.fn>;
let mediaConstraints: MediaStreamConstraints[];
let lastTrack: MediaStreamTrack | null;

// The most recent stable destination track returned by the publish-graph
// double. This is what TranslatorRoute publishes — distinct from the raw
// getUserMedia track (lastTrack).
let lastPublishedTrack: MediaStreamTrack | null;

type GraphRecord = {
  // Source streams handed to the graph: index 0 is the initial source from
  // createPublishGraph(stream); subsequent entries come from swapSource.
  sources: MediaStream[];
  gainCalls: number[];
  swapCalls: MediaStream[];
  publishedTrack: MediaStreamTrack;
  destroyed: boolean;
  resumed: number;
};

// All graphs created during a test, newest last. Reset in beforeEach.
let createdGraphs: GraphRecord[];

function makeStream(): MediaStream {
  const track = {
    kind: "audio",
    enabled: true,
    stop: vi.fn()
  } as unknown as MediaStreamTrack;
  lastTrack = track;
  const stream = new MediaStream();
  stream.addTrack(track);
  return stream;
}

// Injectable createPublishGraph double: records setGain/swapSource/resume/destroy
// and exposes a fake publishedTrack that is NOT the raw mic track. Mirrors the
// real graph's contract without a real AudioContext.
function createPublishGraphDouble(stream: MediaStream) {
  const meterStream = new MediaStream();
  const publishedTrack = {
    kind: "audio",
    enabled: true,
    stop: vi.fn()
  } as unknown as MediaStreamTrack;
  lastPublishedTrack = publishedTrack;
  const record: GraphRecord = {
    sources: [stream],
    gainCalls: [],
    swapCalls: [],
    publishedTrack,
    destroyed: false,
    resumed: 0
  };
  createdGraphs.push(record);
  return {
    publishedTrack,
    setGain(value: number) {
      record.gainCalls.push(value);
    },
    swapSource(next: MediaStream) {
      record.swapCalls.push(next);
      record.sources.push(next);
    },
    getMeterSource() {
      return meterStream;
    },
    resume() {
      record.resumed += 1;
    },
    destroy() {
      record.destroyed = true;
    }
  };
}

function makeDeviceInfo(
  deviceId: string,
  label: string
): MediaDeviceInfo {
  return {
    deviceId,
    kind: "audioinput",
    label,
    groupId: "group_default",
    toJSON() {
      return this;
    }
  } as MediaDeviceInfo;
}

// Replace the enumerateDevices mock's resolved value with the given audio
// inputs (each entry becomes an audioinput MediaDeviceInfo).
function setAudioInputs(devices: Array<{ deviceId: string; label: string }>) {
  enumerateDevices.mockResolvedValue(
    devices.map((device) => makeDeviceInfo(device.deviceId, device.label))
  );
}

function sessionResponse(): TranslatorSessionResponse {
  return {
    translator: {
      id: "translator_hi",
      programId: "program_1",
      name: "Hindi translator",
      email: "hi@example.com"
    },
    assignedStreams: [
      {
        id: "stream_hi",
        languageName: "Hindi",
        nativeName: "हिन्दी",
        languageCode: "hi"
      },
      {
        id: "stream_bn",
        languageName: "Bengali",
        nativeName: "বাংলা",
        languageCode: "bn"
      }
    ]
  };
}

function translatorApi(overrides: Partial<TranslatorApi> = {}): TranslatorApi {
  return {
    login: vi.fn(async () => ({
      ok: true as const,
      ...sessionResponse()
    })),
    session: vi.fn(async () => sessionResponse()),
    realtimeToken: vi.fn(async (streamId: string) => ({
      publishSessionId: "publish-session-id",
      token: "livekit-jwt",
      url: "wss://livekit.example.test",
      roomName: `room_${streamId}`
    })),
    realtimeStop: vi.fn(async () => ({ ok: true as const, cleanup: "closed" as const })),
    audioActivity: vi.fn(async () => ({ ok: true as const, state: "silent" as const })),
    heartbeat: vi.fn(async () => ({ ok: true as const })),
    logout: vi.fn(async () => ({ ok: true as const })),
    ...overrides
  } as TranslatorApi;
}

function realtimeClient(
  overrides: Partial<TranslatorRealtimeClient> = {}
): TranslatorRealtimeClient {
  return {
    publish: vi.fn(async (input) => ({
      publishSessionId: "publish_1",
      streamId: input.streamId,
      track: input.track,
      room: {} as unknown as RoomHandle
    })),
    mute: vi.fn(),
    stop: vi.fn(async () => undefined),
    reconnect: vi.fn(async (input) => ({
      publishSessionId: "publish_2",
      streamId: input.streamId,
      track: input.track,
      room: {} as unknown as RoomHandle
    })),
    ...overrides
  } as TranslatorRealtimeClient;
}

// A minimal fake of livekit-client's `Room`, for the one test that exercises
// the REAL createTranslatorRealtimeClient wiring (see "wires the real
// LiveKit client" below) rather than injecting a fully-mocked
// TranslatorRealtimeClient like every other test in this file. Mirrors
// translatorRealtimeClient.test.ts's FakeRoom.
class FakeRoom implements RoomHandle {
  static instances: FakeRoom[] = [];

  readonly connectCalls: Array<{ url: string; token: string }> = [];
  readonly localParticipant = {
    publishTrack: vi.fn(async () => ({}))
  };
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor() {
    FakeRoom.instances.push(this);
  }

  async connect(url: string, token: string): Promise<void> {
    this.connectCalls.push({ url, token });
  }

  async disconnect(): Promise<void> {}

  on(event: string, listener: (...args: unknown[]) => void): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }
}

function renderRoute(props: {
  translatorApi: TranslatorApi;
  publicApi?: PublicApi;
  realtimeClient?: TranslatorRealtimeClient;
  createRoom?: () => RoomHandle;
  createAudioMeter?: (stream: MediaStream) => TranslatorAudioMeter | null;
  createPublishGraph?: TranslatorRouteProps["createPublishGraph"];
  meterPollMs?: number;
  silentSampleThreshold?: number;
  silentWarningSampleThreshold?: number;
  audioActivityReportMs?: number;
  publisherHeartbeatMs?: number;
  recoveryBaseMs?: number;
  recoveryMaxMs?: number;
  recoveryMaxAttempts?: number;
  onRealtimeHandlerReady?: (handler: TranslatorConnectionStateHandler) => void;
  onAudioControlsReady?: TranslatorRouteProps["onAudioControlsReady"];
}) {
  const routeProps: TranslatorRouteProps = {
    programSlug: "patna-event-2026",
    translatorApi: props.translatorApi,
    publicApi: props.publicApi ?? createPublicApi(),
    // `createRoom` opts a test into exercising the REAL
    // createTranslatorRealtimeClient wiring (the route's own construction
    // line), so only fall back to the fully-mocked default client when
    // neither an explicit realtimeClient NOR createRoom was given.
    ...(props.realtimeClient
      ? { realtimeClient: props.realtimeClient }
      : props.createRoom
        ? { createRoom: props.createRoom }
        : { realtimeClient: realtimeClient() }),
    // Inject the publish-graph double by default so no test ever reaches the
    // real AudioContext-backed graph (absent in jsdom). Tests publish the
    // graph's destination track, not the raw mic track.
    createPublishGraph: props.createPublishGraph ?? createPublishGraphDouble
  };
  if (props.publisherHeartbeatMs !== undefined) {
    routeProps.publisherHeartbeatMs = props.publisherHeartbeatMs;
  }
  if (props.createAudioMeter) {
    routeProps.createAudioMeter = props.createAudioMeter;
  }
  if (props.meterPollMs !== undefined) {
    routeProps.meterPollMs = props.meterPollMs;
  }
  if (props.silentSampleThreshold !== undefined) {
    routeProps.silentSampleThreshold = props.silentSampleThreshold;
  }
  if (props.silentWarningSampleThreshold !== undefined) {
    routeProps.silentWarningSampleThreshold = props.silentWarningSampleThreshold;
  }
  if (props.audioActivityReportMs !== undefined) {
    routeProps.audioActivityReportMs = props.audioActivityReportMs;
  }
  if (props.recoveryBaseMs !== undefined) {
    routeProps.recoveryBaseMs = props.recoveryBaseMs;
  }
  if (props.recoveryMaxMs !== undefined) {
    routeProps.recoveryMaxMs = props.recoveryMaxMs;
  }
  if (props.recoveryMaxAttempts !== undefined) {
    routeProps.recoveryMaxAttempts = props.recoveryMaxAttempts;
  }
  if (props.onRealtimeHandlerReady) {
    routeProps.onRealtimeHandlerReady = props.onRealtimeHandlerReady;
  }
  if (props.onAudioControlsReady) {
    routeProps.onAudioControlsReady = props.onAudioControlsReady;
  }
  return render(<TranslatorRoute {...routeProps} />);
}

async function goLive() {
  fireEvent.click(await screen.findByRole("button", { name: "Go live" }));
  await screen.findByText("ON AIR");
}

describe("TranslatorRoute", () => {
  beforeEach(() => {
    // Persistence (translatorPrefs) is keyed in localStorage; clear it between
    // tests so seeded/saved prefs from one test never leak into the next (which
    // would, e.g., break the byte-identical default-constraints assertion).
    localStorage.clear();
    mediaConstraints = [];
    lastTrack = null;
    lastPublishedTrack = null;
    createdGraphs = [];
    getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      mediaConstraints.push(constraints);
      return makeStream();
    });
    // Default to a single audioinput so the mic picker stays hidden unless a
    // test opts into multiple devices via setAudioInputs().
    enumerateDevices = vi.fn(async () => [
      makeDeviceInfo("default", "")
    ]);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, enumerateDevices }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("shows the login form with the program slug when there is no session", async () => {
    const api = translatorApi({
      session: vi.fn(async () => {
        throw new ApiError({
          status: 401,
          code: "translator_auth_required",
          body: { error: "translator_auth_required" }
        });
      })
    });

    renderRoute({ translatorApi: api });

    expect(
      await screen.findByRole("heading", { name: "Translator login" })
    ).toBeInTheDocument();
    expect(screen.getByText("patna-event-2026")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go live" })).not.toBeInTheDocument();
  });

  it("shows a missing program message and skips auth checks", async () => {
    const api = translatorApi({
      session: vi.fn(async () => {
        throw new Error("session should not be called");
      }),
      login: vi.fn(async () => {
        throw new Error("login should not be called");
      })
    });
    const routePublicApi = createPublicApi({
      fetchProgram: vi.fn(async () => {
        throw new ApiError({
          status: 404,
          code: "program_not_found",
          body: { error: "program_not_found" }
        });
      })
    });

    renderRoute({ translatorApi: api, publicApi: routePublicApi });

    expect(
      await screen.findByText("This program does not exist.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Translator login" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log in" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go live" })).not.toBeInTheDocument();
    expect((routePublicApi.fetchProgram as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "patna-event-2026"
    );
    expect(api.session).not.toHaveBeenCalled();
    expect(api.login).not.toHaveBeenCalled();
  });

  it("restores a session and shows only assigned streams", async () => {
    renderRoute({ translatorApi: translatorApi() });

    expect(await screen.findByText("Hindi translator")).toBeInTheDocument();
    expect(screen.getByText("हिन्दी")).toBeInTheDocument();
    expect(screen.getByText("Hindi")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go live" })).toBeInTheDocument();
    const select = screen.getByLabelText("Language stream") as HTMLSelectElement;
    const options = Array.from(select.options).map((option) => option.textContent);
    expect(options).toEqual(["हिन्दी — Hindi", "বাংলা — Bengali"]);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Log in" })).toBeInTheDocument();
  });

  it("calls logout on sign-out and still signs out on translator session", async () => {
    const api = translatorApi();

    renderRoute({ translatorApi: api });

    expect(await screen.findByText("Hindi translator")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("button", { name: "Log in" })).toBeInTheDocument();
    expect(api.logout).toHaveBeenCalledTimes(1);
  });

  it("signs out even when logout rejects", async () => {
    const api = translatorApi({
      logout: vi.fn(async () => {
        throw new Error("logout failed");
      })
    });

    renderRoute({
      translatorApi: api,
      realtimeClient: realtimeClient()
    });

    await goLive();
    const track = lastTrack;

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("button", { name: "Log in" })).toBeInTheDocument();
    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(track?.stop).toHaveBeenCalled();
  });

  it("shows identity language card for a single assigned stream", async () => {
    const session = sessionResponse();

    const api = translatorApi({
      session: vi.fn(async () => ({
        ...session,
        assignedStreams: [session.assignedStreams[0]!]
      }))
    });

    renderRoute({ translatorApi: api });

    expect(await screen.findByText("हिन्दी")).toBeInTheDocument();
    expect(screen.getByText("Hindi")).toBeInTheDocument();
    expect(screen.queryByLabelText("Language stream")).not.toBeInTheDocument();
  });

  it("logs in with the program slug, translator id, and password", async () => {
    const api = translatorApi({
      session: vi.fn(async () => {
        throw new ApiError({
          status: 401,
          code: "translator_auth_required",
          body: { error: "translator_auth_required" }
        });
      })
    });

    renderRoute({ translatorApi: api });

    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "hi@example.com" }
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret-pass" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => {
      expect(api.login).toHaveBeenCalledWith(
        "patna-event-2026",
        "hi@example.com",
        "secret-pass"
      );
    });
    expect(await screen.findByRole("button", { name: "Go live" })).toBeInTheDocument();
  });

  it("shows an error for invalid login credentials", async () => {
    const api = translatorApi({
      session: vi.fn(async () => {
        throw new ApiError({
          status: 401,
          code: "translator_auth_required",
          body: { error: "translator_auth_required" }
        });
      }),
      login: vi.fn(async () => {
        throw new ApiError({
          status: 401,
          code: "invalid_translator_credentials",
          body: { error: "invalid_translator_credentials" }
        });
      })
    });

    renderRoute({ translatorApi: api });

    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "hi@example.com" }
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrong" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(
      await screen.findByText("Invalid email or password.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go live" })).not.toBeInTheDocument();
  });

  it("shows a missing-program error when login returns program_not_found", async () => {
    const api = translatorApi({
      session: vi.fn(async () => {
        throw new ApiError({
          status: 401,
          code: "translator_auth_required",
          body: { error: "translator_auth_required" }
        });
      }),
      login: vi.fn(async () => {
        throw new ApiError({
          status: 404,
          code: "program_not_found",
          body: { error: "program_not_found" }
        });
      })
    });

    renderRoute({ translatorApi: api });

    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "hi@example.com" }
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret-pass" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(
      await screen.findByText("This program does not exist.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go live" })).not.toBeInTheDocument();
  });

  it("requests audio-only microphone and never the camera when going live", async () => {
    const realtime = realtimeClient();
    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });

    await goLive();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    // Default go-live constraints must stay byte-identical to the legacy
    // MIC_CONSTRAINTS shape: audio processing all on, no deviceId pinned
    // (the builder only adds deviceId when a specific mic is selected).
    expect(mediaConstraints[0]).toEqual({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
    expect(mediaConstraints[0]!.audio).not.toHaveProperty("deviceId");
    for (const constraints of mediaConstraints) {
      expect(constraints.video).toBe(false);
    }
    expect(realtime.publish).toHaveBeenCalledWith({
      streamId: "stream_hi",
      track: lastPublishedTrack,
      reclaim: true
    });
  });

  it("guards against a second go-live while already live", async () => {
    const realtime = realtimeClient();
    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });

    await goLive();

    expect(screen.queryByRole("button", { name: "Go live" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(realtime.publish).toHaveBeenCalledTimes(1);
  });

  it("surfaces stream_already_published and offers reconnect", async () => {
    let attempts = 0;
    const realtime = realtimeClient({
      publish: vi.fn(async (input) => {
        attempts += 1;
        if (attempts === 1) {
          throw new ApiError({
            status: 409,
            code: "stream_already_published",
            body: { error: "stream_already_published" }
          });
        }
        return {
          publishSessionId: "publish_recovered",
          streamId: input.streamId,
          track: input.track,
          room: {} as unknown as RoomHandle
        };
      })
    });

    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });

    fireEvent.click(await screen.findByRole("button", { name: "Go live" }));

    expect(
      await screen.findByText("This language is already being published.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Another device may be publishing it. Try reconnecting.")
    ).toBeInTheDocument();
    const reconnect = await screen.findByRole("button", { name: "Reconnect" });

    fireEvent.click(reconnect);
    await screen.findByText("ON AIR");
    expect(realtime.publish).toHaveBeenCalledTimes(2);
  });

  it("surfaces an unassigned-stream error", async () => {
    const realtime = realtimeClient({
      publish: vi.fn(async () => {
        throw new ApiError({
          status: 403,
          code: "stream_not_assigned",
          body: { error: "stream_not_assigned" }
        });
      })
    });

    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });

    fireEvent.click(await screen.findByRole("button", { name: "Go live" }));

    expect(
      await screen.findByText("You are not assigned to this language.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Ask the event admin to assign it.")
    ).toBeInTheDocument();
  });

  it("surfaces a realtime error", async () => {
    const realtime = realtimeClient({
      publish: vi.fn(async () => {
        throw new ApiError({
          status: 502,
          code: "realtime_error",
          body: { error: "realtime_error" }
        });
      })
    });

    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });

    fireEvent.click(await screen.findByRole("button", { name: "Go live" }));

    expect(await screen.findByText("Realtime connection failed.")).toBeInTheDocument();
    expect(screen.getByText("Try reconnecting.")).toBeInTheDocument();
    expect(screen.getByText("Not live.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go live" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("surfaces a microphone permission failure without publishing", async () => {
    getUserMedia.mockImplementationOnce(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    const realtime = realtimeClient();

    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });

    fireEvent.click(await screen.findByRole("button", { name: "Go live" }));

    expect(
      await screen.findByText("Microphone access is required to go live.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Check your browser's microphone permission and try again.")
    ).toBeInTheDocument();
    expect(realtime.publish).not.toHaveBeenCalled();
  });

  it("shows connecting state with a banner and no controls", async () => {
    const realtime = realtimeClient({
      publish: vi.fn(async () => new Promise(() => {})) as TranslatorRealtimeClient["publish"]
    });

    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });

    fireEvent.click(await screen.findByRole("button", { name: "Go live" }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Connecting…");
    expect(screen.getByText("Setting up your microphone…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go live" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  });

  it("shows reconnecting state with a banner and no controls", async () => {
    const realtime = realtimeClient({
      reconnect: vi.fn(async () => new Promise(() => {})) as TranslatorRealtimeClient["reconnect"]
    });

    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });

    await goLive();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Reconnecting…");
    expect(screen.getByText("Re-establishing your audio…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go live" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  });

  it("mutes and unmutes without stopping the session", async () => {
    const realtime = realtimeClient();
    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });

    await goLive();

    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(realtime.mute).toHaveBeenCalledWith({
      track: lastPublishedTrack,
      muted: true
    });
    expect(await screen.findByRole("button", { name: "Unmute" })).toBeInTheDocument();
    expect(await screen.findByText("MUTED")).toBeInTheDocument();
    expect(realtime.stop).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
    expect(realtime.mute).toHaveBeenCalledWith({
      track: lastPublishedTrack,
      muted: false
    });
    expect(await screen.findByText("ON AIR")).toBeInTheDocument();
  });

  it("stops local media and the backend session", async () => {
    const realtime = realtimeClient();
    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });

    await goLive();
    const track = lastTrack;

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(realtime.stop).toHaveBeenCalledWith({ publishSessionId: "publish_1" });
    });
    expect(track?.stop).toHaveBeenCalled();
    expect(await screen.findByText("Stopped")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go live" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("keeps the screen awake while live when the browser supports wake locks", async () => {
    const release = vi.fn(async () => undefined);
    const request = vi.fn(async () => ({ release }));
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request }
    });

    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtimeClient() });

    await goLive();

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith("screen");
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(release).toHaveBeenCalled();
    });
  });

  it("re-acquires the screen wake lock when a live translator returns to the tab", async () => {
    const firstRelease = vi.fn(async () => undefined);
    const secondRelease = vi.fn(async () => undefined);
    const request = vi
      .fn()
      .mockResolvedValueOnce({ release: firstRelease })
      .mockResolvedValueOnce({ release: secondRelease });
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request }
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible"
    });

    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtimeClient() });

    await goLive();
    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(1);
    });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden"
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(request).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible"
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
    });
    expect(firstRelease).toHaveBeenCalled();
  });

  it("sends an immediate catch-up heartbeat when a live translator returns to the tab", async () => {
    const api = translatorApi();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible"
    });

    renderRoute({
      translatorApi: api,
      realtimeClient: realtimeClient(),
      publisherHeartbeatMs: 60_000
    });

    await goLive();
    expect(api.heartbeat).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden"
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(api.heartbeat).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible"
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => {
      expect(api.heartbeat).toHaveBeenCalledTimes(1);
    });
    expect(api.heartbeat).toHaveBeenCalledWith("stream_hi", "publish_1");
  });

  it("starts immediate recovery when the catch-up heartbeat reports the session lost on tab return", async () => {
    const api = translatorApi({
      heartbeat: vi.fn(async () => {
        throw new ApiError({
          status: 409,
          code: "publisher_not_active",
          body: { error: "publisher_not_active" }
        });
      })
    });
    const realtime = realtimeClient();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible"
    });

    renderRoute({
      translatorApi: api,
      realtimeClient: realtime,
      publisherHeartbeatMs: 60_000,
      recoveryBaseMs: 5
    });

    await goLive();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden"
    });
    document.dispatchEvent(new Event("visibilitychange"));

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible"
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => {
      expect(realtime.reconnect).toHaveBeenCalledWith(
        expect.objectContaining({
          publishSessionId: "publish_1",
          streamId: "stream_hi"
        })
      );
    });
  });

  it("reconnects the live stream with a fresh microphone track", async () => {
    const realtime = realtimeClient();
    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });

    await goLive();
    const freshGoal = lastTrack;
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

    await waitFor(() => {
      expect(realtime.reconnect).toHaveBeenCalledWith({
        publishSessionId: "publish_1",
        streamId: "stream_hi",
        track: lastPublishedTrack
      });
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(lastTrack).not.toBe(freshGoal);
    expect(await screen.findByText("ON AIR")).toBeInTheDocument();
  });

  it("reconnect re-acquires with the current device and republishes a graph track", async () => {
    // Regression pin for the ref-based current-value read: a long-lived
    // connection-drop reconnect must acquire the source with the CURRENTLY
    // selected mic (read via selectedMicIdRef), not a stale closure default,
    // and must hand realtimeClient.reconnect a graph DESTINATION track — never
    // the raw getUserMedia track.
    setAudioInputs([
      { deviceId: "mic-built-in", label: "Built-in Microphone" },
      { deviceId: "mic-usb", label: "USB Microphone" }
    ]);
    const realtime = realtimeClient();
    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });

    await goLive();
    expect(createdGraphs).toHaveLength(1);

    // Change the live mic so selectedMicId is now a non-default device. Open the
    // sheet (fires the permission/enumerate probe) and let it settle so the
    // following getUserMedia is attributable to the swap alone.
    fireEvent.click(screen.getByRole("button", { name: "Audio Settings" }));
    await screen.findByRole("dialog");
    const micSelect = (await screen.findByLabelText(
      "Microphone"
    )) as HTMLSelectElement;
    fireEvent.change(micSelect, { target: { value: "mic-usb" } });
    await waitFor(() => {
      expect(createdGraphs[0]!.swapCalls.length).toBe(1);
    });

    // A genuine connection drop runs the existing reconnect() path. Capture the
    // graph that exists pre-reconnect: acquireMicTrack REBUILDS the graph, so
    // the republished destination track is a fresh object (NOT the same
    // identity) — this is correct for a real drop; the relay absorbs it.
    const graphBeforeReconnect = createdGraphs[0]!;
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

    await waitFor(() => {
      expect(realtime.reconnect).toHaveBeenCalledTimes(1);
    });

    // A brand-new graph was built for the reconnect (rebuild, not reuse); the
    // old graph was destroyed by stopMediaTracks().
    expect(createdGraphs).toHaveLength(2);
    const reconnectGraph = createdGraphs[1]!;
    expect(graphBeforeReconnect.destroyed).toBe(true);

    // The re-acquired SOURCE carries the CURRENT deviceId via { exact } — proof
    // acquireMicTrack read selectedMicIdRef, not a stale captured value.
    const reacquireConstraints = mediaConstraints[mediaConstraints.length - 1]!;
    expect(
      (reacquireConstraints.audio as MediaTrackConstraints).deviceId
    ).toEqual({ exact: "mic-usb" });

    // The track handed to reconnect is the (new) graph's destination track —
    // the factory's publishedTrack, never the raw mic track.
    expect(realtime.reconnect).toHaveBeenCalledWith({
      publishSessionId: "publish_1",
      streamId: "stream_hi",
      track: reconnectGraph.publishedTrack
    });
    expect(reconnectGraph.publishedTrack).toBe(lastPublishedTrack);
    expect(reconnectGraph.publishedTrack).not.toBe(lastTrack);

    expect(await screen.findByText("ON AIR")).toBeInTheDocument();
  });

  it("publishes the graph destination track, not the raw mic track", async () => {
    const realtime = realtimeClient();
    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });

    await goLive();

    // Exactly one graph was built from a getUserMedia source stream.
    expect(createdGraphs).toHaveLength(1);
    const graph = createdGraphs[0]!;
    expect(graph.sources[0]).toBeInstanceOf(MediaStream);

    // The published track is the graph's stable destination track, never the
    // raw mic track.
    expect(realtime.publish).toHaveBeenCalledTimes(1);
    expect(realtime.publish).toHaveBeenCalledWith({
      streamId: "stream_hi",
      track: graph.publishedTrack,
      reclaim: true
    });
    expect(graph.publishedTrack).toBe(lastPublishedTrack);
    expect(graph.publishedTrack).not.toBe(lastTrack);
  });

  it("applies the current gain to the graph on go-live", async () => {
    const realtime = realtimeClient();
    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });

    await goLive();

    // Default gain is unity; the graph receives it at go-live so the published
    // feed honours the volume control from the first sample.
    expect(createdGraphs).toHaveLength(1);
    expect(createdGraphs[0]!.gainCalls).toContain(1);
  });

  it("populates labelled mic devices after permission granted on open", async () => {
    // Pre-grant: the browser hides labels (blank-deviceId placeholder, dropped).
    // After the permission probe, enumeration returns the labelled inputs.
    enumerateDevices
      .mockResolvedValueOnce([makeDeviceInfo("", "")])
      .mockResolvedValue([
        makeDeviceInfo("mic-built-in", "Built-in Microphone"),
        makeDeviceInfo("mic-usb", "USB Microphone")
      ]);

    let controls: {
      ensureMicPermissionAndEnumerate: () => Promise<void>;
    } | null = null;
    renderRoute({
      translatorApi: translatorApi(),
      onAudioControlsReady: (value) => {
        controls = value;
      }
    });

    // Logged in → the session-apply enumerate has run once (blank → dropped).
    await screen.findByRole("button", { name: "Go live" });
    await waitFor(() => {
      expect(controls).not.toBeNull();
    });

    const probeCallsBefore = getUserMedia.mock.calls.length;

    // First open: fires the permission probe, then re-enumerates → labelled list.
    await controls!.ensureMicPermissionAndEnumerate();

    // The probe issued exactly one extra getUserMedia, with default constraints
    // (no pinned deviceId) — and the probe stream was NOT routed into a graph.
    expect(getUserMedia.mock.calls.length).toBe(probeCallsBefore + 1);
    const probeConstraints = mediaConstraints[mediaConstraints.length - 1]!;
    expect(probeConstraints.audio).not.toHaveProperty("deviceId");
    expect(createdGraphs).toHaveLength(0);

    // Opening again does not re-probe (permission already granted).
    await controls!.ensureMicPermissionAndEnumerate();
    expect(getUserMedia.mock.calls.length).toBe(probeCallsBefore + 1);
  });

  it("renders a segmented meter and fills it from the live level", async () => {
    const meter: TranslatorAudioMeter = {
      getLevel: vi.fn(() => 0.8),
      close: vi.fn()
    };

    const view = renderRoute({
      translatorApi: translatorApi(),
      createAudioMeter: () => meter,
      meterPollMs: 5,
      silentSampleThreshold: 2
    });

    await goLive();

    await waitFor(() => {
      expect(
        view.container.querySelectorAll(".translator-meter-seg").length
      ).toBe(20);
      expect(
        Array.from(view.container.querySelectorAll(".translator-meter-seg")).filter(
          (segment) => segment.classList.contains("translator-meter-seg--filled")
        ).length
      ).toBe(20);
    });
  });

  it("fills into the amber zone at a calibrated mid-high level", async () => {
    const meter: TranslatorAudioMeter = {
      getLevel: vi.fn(() => 0.35),
      close: vi.fn()
    };

    const view = renderRoute({
      translatorApi: translatorApi(),
      createAudioMeter: () => meter,
      meterPollMs: 5,
      silentSampleThreshold: 2
    });

    await goLive();

    await waitFor(() => {
      const filledSegments = view.container.querySelectorAll(
        ".translator-meter-seg--filled"
      );
      expect(filledSegments).toHaveLength(18);
      expect(filledSegments.item(filledSegments.length - 1)).toHaveClass(
        "translator-meter-seg--amber",
        "translator-meter-seg--filled"
      );
    });
  });

  it("fills into the red zone near the calibrated peak", async () => {
    const meter: TranslatorAudioMeter = {
      getLevel: vi.fn(() => 0.47),
      close: vi.fn()
    };

    const view = renderRoute({
      translatorApi: translatorApi(),
      createAudioMeter: () => meter,
      meterPollMs: 5,
      silentSampleThreshold: 2
    });

    await goLive();

    await waitFor(() => {
      const filledSegments = view.container.querySelectorAll(
        ".translator-meter-seg--filled"
      );
      expect(filledSegments).toHaveLength(20);
      expect(filledSegments.item(filledSegments.length - 1)).toHaveClass(
        "translator-meter-seg--red",
        "translator-meter-seg--filled"
      );
    });
  });

  it("renders the elapsed timer while live", async () => {
    const meter: TranslatorAudioMeter = {
      getLevel: vi.fn(() => 0.5),
      close: vi.fn()
    };

    renderRoute({
      translatorApi: translatorApi(),
      createAudioMeter: () => meter,
      meterPollMs: 5,
      silentSampleThreshold: 2
    });

    await goLive();

    // The timer renders in H:MM:SS and advances once per second on real timers.
    // Assert it renders, then advances past zero with a tolerant matcher +
    // generous timeout — exact "0:00:01" with the default 1s waitFor raced the
    // 1s tick and flaked on slower CI.
    expect(screen.getByText(/^\d:\d{2}:\d{2}$/)).toBeInTheDocument();
    await waitFor(
      () => {
        expect(screen.getByText(/0:00:0[1-9]/)).toBeInTheDocument();
      },
      { timeout: 2500 }
    );
  });

  it("stops publish and shows broadcast-ended state on publisher_not_active heartbeat", async () => {
    const heartbeatError = new ApiError({
      status: 409,
      code: "publisher_not_active",
      body: { error: "publisher_not_active" }
    });
    const api = translatorApi({
      heartbeat: vi
        .fn()
        .mockRejectedValueOnce(heartbeatError)
        .mockResolvedValue({ ok: true as const })
    });

    renderRoute({
      translatorApi: api,
      meterPollMs: 5,
      silentSampleThreshold: 2,
      publisherHeartbeatMs: 20
    });

    await goLive();

    expect(await screen.findByText("Your broadcast was ended.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go live" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();

    expect(screen.queryByRole("heading", { name: "Translator login" })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByText("Your broadcast was ended.")).toBeInTheDocument();
    });
  });

  it("shows broadcast-ended state and returns to login on translator_auth_required heartbeat", async () => {
    const heartbeatError = new ApiError({
      status: 401,
      code: "translator_auth_required",
      body: { error: "translator_auth_required" }
    });
    const api = translatorApi({
      heartbeat: vi
        .fn()
        .mockRejectedValueOnce(heartbeatError)
        .mockResolvedValue({ ok: true as const })
    });

    renderRoute({
      translatorApi: api,
      meterPollMs: 5,
      silentSampleThreshold: 2,
      publisherHeartbeatMs: 20
    });

    await goLive();

    expect(await screen.findByText("Your broadcast was ended.")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Translator login" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Go live" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reconnect" })
    ).not.toBeInTheDocument();
  });

  it("keeps stale state from non-publish-end heartbeat failures", async () => {
    const heartbeatError = new ApiError({
      status: 0,
      code: "network_error",
      body: { error: "network_error" }
    });
    const api = translatorApi({
      heartbeat: vi
        .fn()
        .mockRejectedValueOnce(heartbeatError)
        .mockResolvedValue({ ok: true as const })
    });

    renderRoute({
      translatorApi: api,
      meterPollMs: 5,
      silentSampleThreshold: 2,
      publisherHeartbeatMs: 20
    });

    await goLive();

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Reconnecting…");
    expect(status).toHaveTextContent("Your audio will resume automatically.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Your broadcast was ended.")).not.toBeInTheDocument();
  });

  it("shows a calm status while automatic transport recovery is pending", async () => {
    const realtime = realtimeClient();
    let handler: TranslatorConnectionStateHandler | null = null;

    renderRoute({
      translatorApi: translatorApi(),
      realtimeClient: realtime,
      onRealtimeHandlerReady: (next) => {
        handler = next;
      }
    });

    await goLive();
    expect(handler).toBeTruthy();

    // LiveKit is already retrying on its own -- "reconnecting" just reflects
    // that in the UI, with no manual timer pending.
    handler!("publish_1", "reconnecting");
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Reconnecting…");
    expect(status).toHaveTextContent("Your audio will resume automatically.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("shows the reconnect alert after automatic recovery is exhausted", async () => {
    const realtime = realtimeClient();
    let handler: TranslatorConnectionStateHandler | null = null;

    renderRoute({
      translatorApi: translatorApi(),
      realtimeClient: realtime,
      recoveryMaxAttempts: 0,
      onRealtimeHandlerReady: (next) => {
        handler = next;
      }
    });

    await goLive();
    expect(handler).toBeTruthy();

    handler!("publish_1", "disconnected");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Lost connection — tap Reconnect");
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("clears recovery exhaustion and confirms when the transport reconnects", async () => {
    const realtime = realtimeClient();
    let handler: TranslatorConnectionStateHandler | null = null;

    renderRoute({
      translatorApi: translatorApi(),
      realtimeClient: realtime,
      recoveryMaxAttempts: 0,
      onRealtimeHandlerReady: (next) => {
        handler = next;
      }
    });

    await goLive();
    expect(handler).toBeTruthy();

    handler!("publish_1", "disconnected");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Lost connection — tap Reconnect"
    );

    handler!("publish_1", "reconnected");
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Reconnected — audio resumed");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("ON AIR")).toBeInTheDocument();
  });

  it("confirms recovery after automatic republish returns live", async () => {
    const realtime = realtimeClient();
    let handler: TranslatorConnectionStateHandler | null = null;

    renderRoute({
      translatorApi: translatorApi(),
      realtimeClient: realtime,
      recoveryBaseMs: 5,
      onRealtimeHandlerReady: (next) => {
        handler = next;
      }
    });

    await goLive();
    expect(handler).toBeTruthy();

    handler!("publish_1", "disconnected");

    await waitFor(() => {
      expect(realtime.reconnect).toHaveBeenCalledWith(
        expect.objectContaining({
          publishSessionId: "publish_1",
          streamId: "stream_hi"
        })
      );
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Reconnected — audio resumed"
    );
    expect(screen.getByText("ON AIR")).toBeInTheDocument();
  });

  it("clears recovery exhaustion after a healthy publisher heartbeat", async () => {
    const heartbeatResolves: Array<
      (value: TranslatorHeartbeatResponse) => void
    > = [];
    const api = translatorApi({
      heartbeat: vi.fn(
        () =>
          new Promise<TranslatorHeartbeatResponse>((resolve) => {
            heartbeatResolves.push(resolve);
          })
      )
    });
    let handler: TranslatorConnectionStateHandler | null = null;

    renderRoute({
      translatorApi: api,
      publisherHeartbeatMs: 10,
      recoveryMaxAttempts: 0,
      onRealtimeHandlerReady: (next) => {
        handler = next;
      }
    });

    await goLive();
    expect(handler).toBeTruthy();

    handler!("publish_1", "disconnected");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Lost connection — tap Reconnect"
    );

    await waitFor(() => {
      expect(api.heartbeat).toHaveBeenCalledWith("stream_hi", "publish_1");
      expect(heartbeatResolves.length).toBeGreaterThan(0);
    });
    heartbeatResolves.forEach((resolve) => resolve({ ok: true as const }));

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    expect(screen.getByText("ON AIR")).toBeInTheDocument();
  });

  it("shows a silent warning when the local audio level stays low", async () => {
    const meter: TranslatorAudioMeter = {
      getLevel: vi.fn(() => 0),
      close: vi.fn()
    };
    const realtime = realtimeClient();

    renderRoute({
      translatorApi: translatorApi(),
      realtimeClient: realtime,
      createAudioMeter: () => meter,
      meterPollMs: 5,
      silentSampleThreshold: 2,
      silentWarningSampleThreshold: 3
    });

    await goLive();

    expect(
      await screen.findByText("No audio detected.")
    ).toBeInTheDocument();
  });

  it("reports active audio activity once when the local meter has audio", async () => {
    const api = translatorApi();
    const meter: TranslatorAudioMeter = {
      getLevel: vi.fn(() => 0.5),
      close: vi.fn()
    };

    renderRoute({
      translatorApi: api,
      createAudioMeter: () => meter,
      meterPollMs: 5,
      silentSampleThreshold: 2,
      audioActivityReportMs: 1_000_000
    });

    await goLive();

    await waitFor(() => {
      expect(api.audioActivity).toHaveBeenCalledWith("stream_hi", "publish_1", true);
    });

    // Audio stays high, so no duplicate active reports on every meter tick.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const activeCalls = (api.audioActivity as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[2] === true
    );
    expect(activeCalls).toHaveLength(1);
  });

  it("reports silent->audio and audio->silent transitions", async () => {
    const api = translatorApi();
    let high = true;
    const meter: TranslatorAudioMeter = {
      getLevel: vi.fn(() => (high ? 0.5 : 0)),
      close: vi.fn()
    };

    renderRoute({
      translatorApi: api,
      createAudioMeter: () => meter,
      meterPollMs: 5,
      silentSampleThreshold: 2,
      audioActivityReportMs: 1_000_000
    });

    await goLive();

    await waitFor(() => {
      expect(api.audioActivity).toHaveBeenCalledWith("stream_hi", "publish_1", true);
    });

    high = false;
    await waitFor(() => {
      expect(api.audioActivity).toHaveBeenCalledWith("stream_hi", "publish_1", false);
    });
  });

  it("keeps reporting active through a brief sub-threshold audio dip", async () => {
    // Repro for the listener "false silent" bug: a natural pause between words
    // (a single low meter tick, shorter than silentSampleThreshold) must NOT be
    // reported to the server as inactive. The local silent banner is debounced
    // (slow-release); the server-reported activity that drives the listener's
    // live/silent badge must use the same debounce, not the raw per-tick level.
    const api = translatorApi();
    let tick = 0;
    const meter: TranslatorAudioMeter = {
      getLevel: vi.fn(() => {
        tick += 1;
        // Audio present except for one isolated low tick (the brief pause).
        return tick === 4 ? 0 : 0.5;
      }),
      close: vi.fn()
    };

    renderRoute({
      translatorApi: api,
      createAudioMeter: () => meter,
      meterPollMs: 5,
      silentSampleThreshold: 3,
      audioActivityReportMs: 1_000_000
    });

    await goLive();

    // The live (active) report is established first.
    await waitFor(() => {
      expect(api.audioActivity).toHaveBeenCalledWith("stream_hi", "publish_1", true);
    });

    // Let the brief dip happen and audio recover (~16 ticks at 5ms).
    await new Promise((resolve) => setTimeout(resolve, 80));

    // A pause shorter than the silent threshold must never be reported as
    // inactive — otherwise listeners flip to "silent" mid-sentence.
    const inactiveCalls = (
      api.audioActivity as ReturnType<typeof vi.fn>
    ).mock.calls.filter((call) => call[2] === false);
    expect(inactiveCalls).toHaveLength(0);
  });

  it("sends periodic active heartbeats while audio remains active", async () => {
    const api = translatorApi();
    const meter: TranslatorAudioMeter = {
      getLevel: vi.fn(() => 0.5),
      close: vi.fn()
    };

    renderRoute({
      translatorApi: api,
      createAudioMeter: () => meter,
      meterPollMs: 5,
      silentSampleThreshold: 2,
      audioActivityReportMs: 10
    });

    await goLive();

    await waitFor(() => {
      const activeCalls = (
        api.audioActivity as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call) => call[2] === true);
      expect(activeCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("sends publisher heartbeats on an interval while live even when silent", async () => {
    const api = translatorApi();
    // A silent meter (no audio) must NOT suppress the publisher heartbeat -- it
    // keeps the bounded server-side TTL alive regardless of speaking.
    const meter: TranslatorAudioMeter = {
      getLevel: vi.fn(() => 0),
      close: vi.fn()
    };

    renderRoute({
      translatorApi: api,
      createAudioMeter: () => meter,
      meterPollMs: 5,
      silentSampleThreshold: 2,
      publisherHeartbeatMs: 10
    });

    await goLive();

    await waitFor(() => {
      const heartbeatCalls = (
        api.heartbeat as ReturnType<typeof vi.fn>
      ).mock.calls.filter(
        (call) => call[0] === "stream_hi" && call[1] === "publish_1"
      );
      expect(heartbeatCalls.length).toBeGreaterThanOrEqual(2);
    });
    // Audio stayed silent, so no active audio-activity reports were sent.
    const activeAudio = (
      api.audioActivity as ReturnType<typeof vi.fn>
    ).mock.calls.filter((call) => call[2] === true);
    expect(activeAudio).toHaveLength(0);
  });

  it("stops sending publisher heartbeats after the translator stops", async () => {
    const api = translatorApi();
    const realtime = realtimeClient();
    const meter: TranslatorAudioMeter = {
      getLevel: vi.fn(() => 0),
      close: vi.fn()
    };

    renderRoute({
      translatorApi: api,
      realtimeClient: realtime,
      createAudioMeter: () => meter,
      meterPollMs: 5,
      silentSampleThreshold: 2,
      publisherHeartbeatMs: 10
    });

    await goLive();
    await waitFor(() => {
      expect(
        (api.heartbeat as ReturnType<typeof vi.fn>).mock.calls.length
      ).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText("Stopped");

    const countAfterStop = (api.heartbeat as ReturnType<typeof vi.fn>).mock.calls
      .length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(
      (api.heartbeat as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBe(countAfterStop);
  });

  it("ignores older heartbeat responses after newer heartbeat resolves", async () => {
    type HeartbeatRequest = {
      resolve: (value: TranslatorHeartbeatResponse) => void;
      reject: (error: Error) => void;
    };
    const heartbeatRequests: HeartbeatRequest[] = [];
    const deferredHeartbeat = () =>
      new Promise<TranslatorHeartbeatResponse>((resolve, reject) => {
        heartbeatRequests.push({ resolve, reject });
      });
    const api = translatorApi({
      heartbeat: vi
        .fn((..._args) =>
          heartbeatRequests.length < 2
            ? deferredHeartbeat()
            : Promise.resolve({ ok: true as const })
        )
    });

    renderRoute({
      translatorApi: api,
      createAudioMeter: () => ({
        getLevel: () => 0.5,
        close: vi.fn()
      }),
      meterPollMs: 5,
      silentSampleThreshold: 2,
      publisherHeartbeatMs: 15
    });

    await goLive();

    await waitFor(() => {
      expect(heartbeatRequests).toHaveLength(2);
    });

    expect(heartbeatRequests).toHaveLength(2);
    heartbeatRequests[1]?.resolve({ ok: true as const });
    await waitFor(() => {
      expect(screen.queryByText("Your audio will resume automatically."))
        .not.toBeInTheDocument();
    });

    const heartbeatError = new ApiError({
      status: 409,
      code: "publisher_not_active",
      body: { error: "publisher_not_active" }
    });
    heartbeatRequests[0]?.reject(heartbeatError);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(
      screen.queryByText("Your audio will resume automatically.")
    ).not.toBeInTheDocument();
  });

  it("reports inactive audio before stopping an active publisher", async () => {
    const api = translatorApi();
    const realtime = realtimeClient();
    const meter: TranslatorAudioMeter = {
      getLevel: vi.fn(() => 0.5),
      close: vi.fn()
    };

    renderRoute({
      translatorApi: api,
      realtimeClient: realtime,
      createAudioMeter: () => meter,
      meterPollMs: 5,
      silentSampleThreshold: 2,
      audioActivityReportMs: 1_000_000
    });

    await goLive();
    await waitFor(() => {
      expect(api.audioActivity).toHaveBeenCalledWith("stream_hi", "publish_1", true);
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(api.audioActivity).toHaveBeenCalledWith("stream_hi", "publish_1", false);
      expect(realtime.stop).toHaveBeenCalledWith({ publishSessionId: "publish_1" });
    });

    const inactiveCallIndex = (
      api.audioActivity as ReturnType<typeof vi.fn>
    ).mock.calls.findIndex((call) => call[2] === false);
    const inactiveOrder = (api.audioActivity as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[inactiveCallIndex];
    const stopOrder = (realtime.stop as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(inactiveOrder).toBeDefined();
    expect(stopOrder).toBeDefined();
    expect(inactiveOrder!).toBeLessThan(stopOrder!);
  });

  it("auto-republishes when the live publisher room disconnects terminally", async () => {
    const realtime = realtimeClient();
    let handler: TranslatorConnectionStateHandler | null = null;
    renderRoute({
      translatorApi: translatorApi(),
      realtimeClient: realtime,
      recoveryBaseMs: 5,
      onRealtimeHandlerReady: (h) => {
        handler = h;
      }
    });

    await goLive();
    expect(handler).toBeTruthy();

    // LiveKit gave up on the live publisher's room -> auto re-publish, no
    // manual action.
    handler!("publish_1", "disconnected");

    await waitFor(() => {
      expect(realtime.reconnect).toHaveBeenCalledWith(
        expect.objectContaining({
          publishSessionId: "publish_1",
          streamId: "stream_hi"
        })
      );
    });
  });

  it("ignores connection failures for a stale publish session", async () => {
    const realtime = realtimeClient();
    let handler: TranslatorConnectionStateHandler | null = null;
    renderRoute({
      translatorApi: translatorApi(),
      realtimeClient: realtime,
      recoveryBaseMs: 5,
      onRealtimeHandlerReady: (h) => {
        handler = h;
      }
    });

    await goLive();
    handler!("publish_stale", "disconnected");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(realtime.reconnect).not.toHaveBeenCalled();
  });

  // Every other realtime-related test above injects a fully-mocked
  // TranslatorRealtimeClient via `realtimeClient`, which never exercises the
  // route's own `createTranslatorRealtimeClient({..., onConnectionStateChange})`
  // construction line. This test omits `realtimeClient` and instead injects a
  // fake Room via `createRoom`, so the REAL client is constructed and the
  // route's transport-state wiring is proven end-to-end, not just the
  // reducer (`handleTransportState`) it happens to be pointed at in isolation.
  it("wires the real LiveKit client end-to-end (token mint, room join, transport events)", async () => {
    const api = translatorApi();
    renderRoute({
      translatorApi: api,
      createRoom: () => new FakeRoom()
    });

    await goLive();

    expect(api.realtimeToken).toHaveBeenCalledWith("stream_hi", {
      reclaim: true
    });
    const room = FakeRoom.instances[0]!;
    expect(room.connectCalls).toEqual([
      { url: "wss://livekit.example.test", token: "livekit-jwt" }
    ]);
    expect(room.localParticipant.publishTrack).toHaveBeenCalled();

    // LiveKit's own transient self-heal: Reconnecting -> stale UI banner.
    room.emit(RoomEvent.Reconnecting);
    await screen.findByText("Reconnecting…");

    // ...and its own recovery succeeding -> justRecovered confirmation.
    room.emit(RoomEvent.Reconnected);
    await screen.findByText("Reconnected — audio resumed");
  });

  // ---- Phase 4: Audio Settings button + bottom sheet ----

  it("Audio Settings button opens the sheet", async () => {
    renderRoute({ translatorApi: translatorApi() });

    const trigger = await screen.findByRole("button", {
      name: "Audio Settings"
    });
    // Sheet is closed until the button is clicked.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // Opening fires the permission/enumerate probe (default constraints).
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalled();
    });
    const probeConstraints = mediaConstraints[mediaConstraints.length - 1]!;
    expect(probeConstraints.audio).not.toHaveProperty("deviceId");
    // The probe stream is NOT routed through a publish graph.
    expect(createdGraphs).toHaveLength(0);
  });

  it("button renders on ready and live", async () => {
    renderRoute({ translatorApi: translatorApi() });

    // Ready: the Audio Settings trigger is present below Go live.
    expect(
      await screen.findByRole("button", { name: "Audio Settings" })
    ).toBeInTheDocument();

    await goLive();

    // Live: the trigger is still present (above the Mute/Reconnect row).
    expect(
      screen.getByRole("button", { name: "Audio Settings" })
    ).toBeInTheDocument();
  });

  it("sheet closes on Escape / backdrop / close button", async () => {
    renderRoute({ translatorApi: translatorApi() });

    const openSheet = async () => {
      fireEvent.click(
        await screen.findByRole("button", { name: "Audio Settings" })
      );
      return screen.findByRole("dialog");
    };

    // Close via the close-X button.
    await openSheet();
    fireEvent.click(screen.getByRole("button", { name: "Close audio settings" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Close via Escape.
    const dialog = await openSheet();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Close via backdrop tap.
    await openSheet();
    fireEvent.click(screen.getByTestId("audio-sheet-backdrop"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("restores focus to the trigger when the sheet closes via Escape", async () => {
    renderRoute({ translatorApi: translatorApi() });

    const trigger = await screen.findByRole("button", {
      name: "Audio Settings"
    });
    // Focus the trigger as a keyboard user would before activating it, so the
    // sheet captures it as the element to restore on close.
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    // Open moves focus inward (into the sheet), away from the trigger.
    expect(document.activeElement).not.toBe(trigger);

    // Dismiss via Escape → focus returns to the "Audio Settings" trigger
    // (not dropped to <body>).
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Audio Settings" })
    );
  });

  it("meter stays mounted while the sheet is open", async () => {
    const meter: TranslatorAudioMeter = {
      getLevel: vi.fn(() => 0.8),
      close: vi.fn()
    };
    const view = renderRoute({
      translatorApi: translatorApi(),
      createAudioMeter: () => meter,
      meterPollMs: 5,
      silentSampleThreshold: 2
    });

    await goLive();

    // The meter renders while live.
    await waitFor(() => {
      expect(
        view.container.querySelectorAll(".translator-meter-seg").length
      ).toBe(20);
    });

    // Open the sheet — the ON AIR pill + meter must stay mounted above it.
    fireEvent.click(screen.getByRole("button", { name: "Audio Settings" }));
    await screen.findByRole("dialog");

    expect(screen.getByText("ON AIR")).toBeInTheDocument();
    expect(view.container.querySelectorAll(".translator-meter-seg").length).toBe(
      20
    );

    // The meter keeps updating: getLevel is still polled with the sheet open.
    const callsWithSheetOpen = (meter.getLevel as ReturnType<typeof vi.fn>).mock
      .calls.length;
    await waitFor(() => {
      expect(
        (meter.getLevel as ReturnType<typeof vi.fn>).mock.calls.length
      ).toBeGreaterThan(callsWithSheetOpen);
    });
  });

  it("mic select hidden at ≤1 device, shown at ≥2", async () => {
    // Single audioinput everywhere (default beforeEach mock) → picker hidden.
    const single = renderRoute({ translatorApi: translatorApi() });
    fireEvent.click(
      await screen.findByRole("button", { name: "Audio Settings" })
    );
    await screen.findByRole("dialog");
    // Let the open-probe re-enumeration settle; with one device the select
    // stays hidden.
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalled();
    });
    expect(screen.queryByLabelText("Microphone")).not.toBeInTheDocument();
    single.unmount();
    cleanup();

    // Two audioinputs → the labelled <select> is shown.
    setAudioInputs([
      { deviceId: "mic-built-in", label: "Built-in Microphone" },
      { deviceId: "mic-usb", label: "USB Microphone" }
    ]);
    renderRoute({ translatorApi: translatorApi() });
    fireEvent.click(
      await screen.findByRole("button", { name: "Audio Settings" })
    );
    await screen.findByRole("dialog");
    const micSelect = (await screen.findByLabelText(
      "Microphone"
    )) as HTMLSelectElement;
    const labels = Array.from(micSelect.options).map((o) => o.textContent);
    expect(labels).toEqual(["Built-in Microphone", "USB Microphone"]);
  });

  it("volume slider updates graph gain live with no re-publish", async () => {
    const realtime = realtimeClient();
    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });

    await goLive();
    expect(createdGraphs).toHaveLength(1);
    const graph = createdGraphs[0]!;
    const publishCallsBefore = (realtime.publish as ReturnType<typeof vi.fn>).mock
      .calls.length;
    const reconnectCallsBefore = (
      realtime.reconnect as ReturnType<typeof vi.fn>
    ).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Audio Settings" }));
    await screen.findByRole("dialog");

    const slider = screen.getByRole("slider", {
      name: "Mic volume"
    }) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "1.5" } });

    // Gain applied live on the existing graph...
    expect(graph.gainCalls).toContain(1.5);
    // ...with NO republish: publish/reconnect are not called again.
    expect((realtime.publish as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      publishCallsBefore
    );
    expect(
      (realtime.reconnect as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBe(reconnectCallsBefore);
    // The slider reflects the new value (and a11y attributes track it).
    expect(slider.value).toBe("1.5");
    expect(slider).toHaveAttribute("aria-valuenow", "1.5");
  });

  it("toggling a switch is reflected in the next source constraints", async () => {
    renderRoute({ translatorApi: translatorApi() });

    // Open the sheet (not yet live) and turn OFF "Reduce background noise".
    fireEvent.click(
      await screen.findByRole("button", { name: "Audio Settings" })
    );
    await screen.findByRole("dialog");

    const noiseSwitch = screen.getByRole("switch", {
      name: "Reduce background noise"
    });
    expect(noiseSwitch).toHaveAttribute("aria-checked", "true");
    fireEvent.click(noiseSwitch);
    expect(noiseSwitch).toHaveAttribute("aria-checked", "false");

    // Close and go live → the next acquire builds constraints with the new value.
    fireEvent.click(screen.getByRole("button", { name: "Close audio settings" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    const constraintsBefore = mediaConstraints.length;

    await goLive();

    const liveConstraints = mediaConstraints[constraintsBefore]!;
    expect((liveConstraints.audio as MediaTrackConstraints).noiseSuppression).toBe(
      false
    );
    expect((liveConstraints.audio as MediaTrackConstraints).echoCancellation).toBe(
      true
    );
  });

  it("toggling a switch while live swaps the source with the new constraints", async () => {
    // On-air complement to the off-air toggle test: turning a processing switch
    // OFF mid-broadcast must re-acquire the source (graph.swapSource) AND the
    // re-acquire getUserMedia must carry the NEW toggle value. Pins the
    // handleToggleAudio ref timing (ref set before the synchronous
    // reacquireSource read) so a future React batching change can't regress it.
    const realtime = realtimeClient();
    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });

    await goLive();
    expect(createdGraphs).toHaveLength(1);
    const graph = createdGraphs[0]!;

    // Open the sheet (fires the permission/enumerate probe) and let it settle
    // BEFORE we baseline, so the toggle's source-swap is the only thing we
    // attribute the next getUserMedia to.
    fireEvent.click(screen.getByRole("button", { name: "Audio Settings" }));
    await screen.findByRole("dialog");
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalled();
    });

    const getUserMediaCallsBefore = getUserMedia.mock.calls.length;
    const publishCallsBefore = (realtime.publish as ReturnType<typeof vi.fn>)
      .mock.calls.length;
    const reconnectCallsBefore = (
      realtime.reconnect as ReturnType<typeof vi.fn>
    ).mock.calls.length;

    // Turn OFF "Reduce background noise" while live.
    const noiseSwitch = screen.getByRole("switch", {
      name: "Reduce background noise"
    });
    expect(noiseSwitch).toHaveAttribute("aria-checked", "true");
    fireEvent.click(noiseSwitch);
    expect(noiseSwitch).toHaveAttribute("aria-checked", "false");

    // A second getUserMedia is issued for the re-acquired source...
    await waitFor(() => {
      expect(getUserMedia.mock.calls.length).toBe(getUserMediaCallsBefore + 1);
    });
    // ...carrying the NEW toggle value (noiseSuppression now false).
    const swapConstraints = mediaConstraints[mediaConstraints.length - 1]!;
    expect(
      (swapConstraints.audio as MediaTrackConstraints).noiseSuppression
    ).toBe(false);
    expect(
      (swapConstraints.audio as MediaTrackConstraints).echoCancellation
    ).toBe(true);

    // The new source was swapped into the SAME live graph — no republish.
    await waitFor(() => {
      expect(graph.swapCalls.length).toBe(1);
    });
    expect((realtime.publish as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      publishCallsBefore
    );
    expect(
      (realtime.reconnect as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBe(reconnectCallsBefore);
  });

  it("auto-gain note shows when boosting with AGC on", async () => {
    renderRoute({ translatorApi: translatorApi() });

    fireEvent.click(
      await screen.findByRole("button", { name: "Audio Settings" })
    );
    await screen.findByRole("dialog");

    // At unity gain with AGC on, no note.
    const noteMatcher = /overrides the slider above/i;
    expect(screen.queryByText(noteMatcher)).not.toBeInTheDocument();

    // Boost above unity → note appears (AGC still on by default).
    const slider = screen.getByRole("slider", { name: "Mic volume" });
    fireEvent.change(slider, { target: { value: "1.4" } });
    expect(screen.getByText(noteMatcher)).toBeInTheDocument();

    // Turning AGC off removes the note even while boosting.
    fireEvent.click(
      screen.getByRole("switch", { name: "Automatically adjust volume" })
    );
    expect(screen.queryByText(noteMatcher)).not.toBeInTheDocument();
  });

  // ---- Phase 5: live source-swap + persistence + fallbacks ----

  it("changing mic while live swaps the source without republishing", async () => {
    // Two labelled inputs so the mic <select> renders.
    setAudioInputs([
      { deviceId: "mic-built-in", label: "Built-in Microphone" },
      { deviceId: "mic-usb", label: "USB Microphone" }
    ]);
    const realtime = realtimeClient();
    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });

    await goLive();
    expect(createdGraphs).toHaveLength(1);
    const graph = createdGraphs[0]!;

    // Open the sheet (fires the permission/enumerate probe) and let it settle
    // BEFORE we baseline, so the source-swap is the only thing we attribute the
    // next getUserMedia to.
    fireEvent.click(screen.getByRole("button", { name: "Audio Settings" }));
    await screen.findByRole("dialog");
    const micSelect = (await screen.findByLabelText(
      "Microphone"
    )) as HTMLSelectElement;

    const getUserMediaCallsBefore = getUserMedia.mock.calls.length;
    const publishCallsBefore = (realtime.publish as ReturnType<typeof vi.fn>)
      .mock.calls.length;
    const reconnectCallsBefore = (
      realtime.reconnect as ReturnType<typeof vi.fn>
    ).mock.calls.length;

    // Switch the mic while live.
    fireEvent.change(micSelect, { target: { value: "mic-usb" } });

    // A second getUserMedia is issued for the new source, pinning the chosen
    // deviceId with { exact }.
    await waitFor(() => {
      expect(getUserMedia.mock.calls.length).toBe(getUserMediaCallsBefore + 1);
    });
    const swapConstraints = mediaConstraints[mediaConstraints.length - 1]!;
    expect((swapConstraints.audio as MediaTrackConstraints).deviceId).toEqual({
      exact: "mic-usb"
    });

    // The new source was swapped into the SAME live graph...
    await waitFor(() => {
      expect(graph.swapCalls.length).toBe(1);
    });
    // ...and the published destination track was untouched: no republish.
    expect((realtime.publish as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      publishCallsBefore
    );
    expect(
      (realtime.reconnect as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBe(reconnectCallsBefore);
  });

  it("restores saved mic + gain on go-live", async () => {
    // Seed prefs BEFORE mount: a non-default mic + a boosted gain.
    saveTranslatorPrefs("patna-event-2026", {
      micDeviceId: "mic-usb",
      audioToggles: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      gain: 1.5
    });
    // The saved mic must be present in the post-grant enumeration so it is not
    // reconciled away as stale.
    setAudioInputs([
      { deviceId: "mic-built-in", label: "Built-in Microphone" },
      { deviceId: "mic-usb", label: "USB Microphone" }
    ]);

    const realtime = realtimeClient();
    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });
    await screen.findByRole("button", { name: "Go live" });

    await goLive();

    // Go-live constraints carry the restored deviceId.
    const liveConstraints = mediaConstraints[mediaConstraints.length - 1]!;
    expect((liveConstraints.audio as MediaTrackConstraints).deviceId).toEqual({
      exact: "mic-usb"
    });
    // The graph received the restored gain.
    expect(createdGraphs).toHaveLength(1);
    expect(createdGraphs[0]!.gainCalls).toContain(1.5);
  });

  it("reconciles stale deviceId post-grant", async () => {
    // Seed a deviceId that is ABSENT from the post-grant enumeration.
    saveTranslatorPrefs("patna-event-2026", {
      micDeviceId: "mic-gone",
      audioToggles: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      gain: 1
    });
    setAudioInputs([
      { deviceId: "mic-built-in", label: "Built-in Microphone" },
      { deviceId: "mic-usb", label: "USB Microphone" }
    ]);

    let controls: {
      ensureMicPermissionAndEnumerate: () => Promise<void>;
    } | null = null;
    renderRoute({
      translatorApi: translatorApi(),
      onAudioControlsReady: (value) => {
        controls = value;
      }
    });
    await screen.findByRole("button", { name: "Go live" });
    await waitFor(() => {
      expect(controls).not.toBeNull();
    });

    // Run the post-grant permission probe + enumeration: the stale deviceId is
    // not present in the labelled list, so the selection is reset to default.
    await controls!.ensureMicPermissionAndEnumerate();

    const constraintsBefore = mediaConstraints.length;
    await goLive();

    // Go-live constraints OMIT the deviceId (selection reconciled to default).
    const liveConstraints = mediaConstraints[constraintsBefore]!;
    expect(liveConstraints.audio).not.toHaveProperty("deviceId");
  });

  it("OverconstrainedError on swap retries on default", async () => {
    setAudioInputs([
      { deviceId: "mic-built-in", label: "Built-in Microphone" },
      { deviceId: "mic-usb", label: "USB Microphone" }
    ]);
    const realtime = realtimeClient();
    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });

    await goLive();
    expect(createdGraphs).toHaveLength(1);
    const graph = createdGraphs[0]!;

    // Open the sheet first; the permission/enumerate probe runs here (and must
    // NOT consume the OverconstrainedError mock, so we arm it afterwards).
    fireEvent.click(screen.getByRole("button", { name: "Audio Settings" }));
    await screen.findByRole("dialog");
    const micSelect = (await screen.findByLabelText(
      "Microphone"
    )) as HTMLSelectElement;

    // The chosen-mic getUserMedia (the swap's first attempt) rejects
    // OverconstrainedError (mic unplugged); the default-constraints retry
    // resolves.
    getUserMedia.mockImplementationOnce(async (constraints: MediaStreamConstraints) => {
      mediaConstraints.push(constraints);
      throw new DOMException("constraint", "OverconstrainedError");
    });

    fireEvent.change(micSelect, { target: { value: "mic-usb" } });

    // Retried once on default constraints (no deviceId) and the source was
    // swapped into the still-alive graph.
    await waitFor(() => {
      expect(graph.swapCalls.length).toBe(1);
    });
    const retryConstraints = mediaConstraints[mediaConstraints.length - 1]!;
    expect(retryConstraints.audio).not.toHaveProperty("deviceId");

    // No error banner — the graph stayed alive and recovered on default.
    expect(
      screen.queryByText("Microphone access is required to go live.")
    ).not.toBeInTheDocument();
    expect(graph.destroyed).toBe(false);
  });

  it("a denied permission probe does not show an error banner", async () => {
    // The sheet-open permission probe is best-effort and silent: a rejected
    // probe leaves the device list at its default and shows NO mic-access
    // banner. A subsequent successful go-live must still work.
    const realtime = realtimeClient();
    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });
    await screen.findByRole("button", { name: "Audio Settings" });

    // Arm ONLY the probe's getUserMedia (the first call after this) to reject.
    // The go-live getUserMedia later falls through to the default resolving mock.
    getUserMedia.mockImplementationOnce(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });

    fireEvent.click(screen.getByRole("button", { name: "Audio Settings" }));
    await screen.findByRole("dialog");

    // The probe ran (consumed the rejection) but surfaced no banner...
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.queryByText("Microphone access is required to go live.")
    ).not.toBeInTheDocument();
    // ...and the probe never built a graph (rejected before acquireMicTrack).
    expect(createdGraphs).toHaveLength(0);

    // A subsequent successful go-live still works.
    await goLive();
    expect(realtime.publish).toHaveBeenCalledTimes(1);
    expect(createdGraphs).toHaveLength(1);
    expect(
      screen.queryByText("Microphone access is required to go live.")
    ).not.toBeInTheDocument();
  });

  it("go-live still surfaces the mic-access error when permission is denied", async () => {
    // Opening the sheet fires the probe FIRST; sequence the mocks so the probe
    // resolves (silent) but the go-live getUserMedia rejects, preserving the
    // existing messageForMicAccess() banner behaviour.
    const realtime = realtimeClient();
    renderRoute({ translatorApi: translatorApi(), realtimeClient: realtime });
    await screen.findByRole("button", { name: "Audio Settings" });

    // Open the sheet: the probe consumes the default resolving getUserMedia.
    fireEvent.click(screen.getByRole("button", { name: "Audio Settings" }));
    await screen.findByRole("dialog");
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });
    // The silent probe showed no banner.
    expect(
      screen.queryByText("Microphone access is required to go live.")
    ).not.toBeInTheDocument();

    // Now arm the go-live getUserMedia (the next call) to reject.
    getUserMedia.mockImplementationOnce(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });

    fireEvent.click(screen.getByRole("button", { name: "Go live" }));

    // The go-live permission failure surfaces messageForMicAccess(), and no
    // publish was attempted.
    expect(
      await screen.findByText("Microphone access is required to go live.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Check your browser's microphone permission and try again.")
    ).toBeInTheDocument();
    expect(realtime.publish).not.toHaveBeenCalled();
  });

  it("persists gain + toggles across remount", async () => {
    const first = renderRoute({ translatorApi: translatorApi() });

    // Open the sheet, boost gain + flip a toggle.
    fireEvent.click(
      await screen.findByRole("button", { name: "Audio Settings" })
    );
    await screen.findByRole("dialog");
    const slider = screen.getByRole("slider", {
      name: "Mic volume"
    }) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "1.7" } });
    const noiseSwitch = screen.getByRole("switch", {
      name: "Reduce background noise"
    });
    fireEvent.click(noiseSwitch);
    expect(noiseSwitch).toHaveAttribute("aria-checked", "false");

    // Let the persistence effect flush.
    await waitFor(() => {
      expect(localStorage.getItem("bhasha.translator.audio")).toBeTruthy();
    });

    first.unmount();
    cleanup();

    // Remount fresh: the prefs are restored from localStorage.
    renderRoute({ translatorApi: translatorApi() });
    fireEvent.click(
      await screen.findByRole("button", { name: "Audio Settings" })
    );
    await screen.findByRole("dialog");
    const restoredSlider = screen.getByRole("slider", {
      name: "Mic volume"
    }) as HTMLInputElement;
    expect(restoredSlider.value).toBe("1.7");
    expect(
      screen.getByRole("switch", { name: "Reduce background noise" })
    ).toHaveAttribute("aria-checked", "false");
  });
});
