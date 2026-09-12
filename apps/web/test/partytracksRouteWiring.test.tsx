import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ListenerApi } from "../src/api/listeners";
import { ApiError } from "../src/api/client";
import type {
  PublicApi,
  PublicProgramMetadata,
  PublicProgramStatus
} from "../src/api/public";
import type {
  TranslatorApi,
  TranslatorSessionResponse
} from "../src/api/translator";

vi.mock("../src/config/featureFlags", () => ({
  usePartytracks: true
}));

vi.mock("../src/realtime/translatorClient", async (orig) => ({
  ...(await orig<typeof import("../src/realtime/translatorClient")>()),
  createTranslatorRealtimeClient: vi.fn(() => ({}) as never)
}));

vi.mock("../src/realtime/partytracksTranslatorClient", async (orig) => ({
  ...(await orig<typeof import("../src/realtime/partytracksTranslatorClient")>()),
  createPartytracksTranslatorClient: vi.fn(() => ({}) as never)
}));

vi.mock("../src/realtime/listenerClient", async (orig) => ({
  ...(await orig<typeof import("../src/realtime/listenerClient")>()),
  createListenerRealtimeClient: vi.fn(() => ({}) as never)
}));

vi.mock("../src/realtime/partytracksListenerClient", async (orig) => ({
  ...(await orig<typeof import("../src/realtime/partytracksListenerClient")>()),
  createPartytracksListenerClient: vi.fn(() => ({}) as never)
}));

import {
  createPartytracksTranslatorClient
} from "../src/realtime/partytracksTranslatorClient";
import { createTranslatorRealtimeClient } from "../src/realtime/translatorClient";
import {
  createPartytracksListenerClient
} from "../src/realtime/partytracksListenerClient";
import { createListenerRealtimeClient } from "../src/realtime/listenerClient";
import { ListenerRoute } from "../src/routes/ListenerRoute";
import { TranslatorRoute } from "../src/routes/TranslatorRoute";

function makeTranslatorSessionResponse(): TranslatorSessionResponse {
  return {
    translator: {
      id: "translator_hi",
      programId: "program_1",
      name: "Hindi translator",
      email: "hi@example.com"
    },
    assignedStreams: [
      { id: "stream_hi", languageName: "Hindi", nativeName: "हिन्दी", languageCode: "hi" },
      { id: "stream_bn", languageName: "Bengali", nativeName: "বাংলা", languageCode: "bn" }
    ]
  };
}

function translatorApi(overrides: Partial<TranslatorApi> = {}): TranslatorApi {
  return {
    login: vi.fn(async () => ({
      ok: true as const,
      ...makeTranslatorSessionResponse()
    })),
    session: vi.fn(async () => makeTranslatorSessionResponse()),
    realtimeSession: vi.fn(),
    realtimePublish: vi.fn(),
    realtimeStop: vi.fn(async () => ({ ok: true as const, cleanup: "closed" as const })),
    realtimeTrack: vi.fn(async (streamId: string) => ({
      publishSessionId: "publish-session-id",
      streamId
    })),
    audioActivity: vi.fn(async () => ({ ok: true as const, state: "silent" as const })),
    heartbeat: vi.fn(async () => ({ ok: true as const })),
    ...overrides
  } as TranslatorApi;
}

function publicMetadata(): PublicProgramMetadata {
  return {
    program: {
      slug: "patna-event-2026",
      name: "Patna Event 2026",
      venue: "Main Hall",
      eventDate: "2026-07-01",
      status: "live",
      accessControlEnabled: false
    },
    streams: [
      {
        id: "stream_en",
        languageName: "English",
        nativeName: "English",
        languageCode: "en",
        displayOrder: 2,
        isActive: true
      },
      {
        id: "stream_hi",
        languageName: "Hindi",
        nativeName: "हिन्दी",
        languageCode: "hi",
        displayOrder: 1,
        isActive: true
      }
    ],
    urls: {
      listenerUrl: "https://bhasha.test/patna-event-2026",
      translatorUrl: "https://bhasha.test/patna-event-2026/translate",
      volunteerUrl: "https://bhasha.test/patna-event-2026/volunteer"
    }
  };
}

function publicStatus(overrides: Partial<PublicProgramStatus> = {}): PublicProgramStatus {
  return {
    program: {
      slug: "patna-event-2026"
    },
    streams: [
      {
        id: "stream_en",
        languageName: "English",
        nativeName: "English",
        languageCode: "en",
        isActive: true,
        state: "offline",
        publisherVersion: null
      },
      {
        id: "stream_hi",
        languageName: "Hindi",
        nativeName: "हिन्दी",
        languageCode: "hi",
        isActive: true,
        state: "live",
        publisherVersion: "publisher_hi_1"
      }
    ],
    stale: false,
    degraded: false,
    serverTime: "2026-06-21T10:00:00.000Z",
    ...overrides
  };
}

function publicApi(overrides: Partial<PublicApi> = {}): PublicApi {
  return {
    fetchProgram: vi.fn(async () => publicMetadata()),
    fetchProgramStatus: vi.fn(async () => publicStatus()),
    ...overrides
  };
}

function listenerApi(overrides: Partial<ListenerApi> = {}): ListenerApi {
  return {
    subscribeSession: vi.fn(),
    subscribeTrack: vi.fn(),
    subscribeRenegotiate: vi.fn(),
    connected: vi.fn(),
    heartbeat: vi.fn(async () => ({ ok: true })),
    leave: vi.fn(async () => ({ ok: true })),
    switch: vi.fn(),
    reconnect: vi.fn(),
    iceServers: vi.fn(async () => ({
      iceServers: [
        {
          urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
          username: "turn-user",
          credential: "turn-credential"
        }
      ]
    })),
    ...overrides
  } as ListenerApi;
}

function makeTranslatorSessionError(): Promise<TranslatorSessionResponse> {
  throw new ApiError({
    status: 401,
    code: "translator_auth_required",
    body: { error: "translator_auth_required" }
  });
}

describe("partytracks route wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("uses partytracks factory for translator route when flag is enabled and no prop is passed", async () => {
    await act(async () => {
      render(
        <TranslatorRoute
          programSlug="patna-event-2026"
          translatorApi={translatorApi({ session: vi.fn(async () => makeTranslatorSessionError()) })}
        />
      );
    });

    await waitFor(() => {
      expect(createPartytracksTranslatorClient).toHaveBeenCalledTimes(1);
      expect(createTranslatorRealtimeClient).not.toHaveBeenCalled();
    });
  });

  it("uses partytracks factory for listener route when flag is enabled and no prop is passed", async () => {
    await act(async () => {
      render(
        <ListenerRoute
          programSlug="patna-event-2026"
          publicApi={publicApi()}
          listenerApi={listenerApi()}
        />
      );
    });

    await waitFor(() => {
      expect(createPartytracksListenerClient).toHaveBeenCalledTimes(1);
      expect(createListenerRealtimeClient).not.toHaveBeenCalled();
    });
  });
});
