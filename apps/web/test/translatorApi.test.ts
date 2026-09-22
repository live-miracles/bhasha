import { describe, expect, it, vi } from "vitest";

import { createTranslatorApi } from "../src/api/translator";
import type { TranslatorHttpClient } from "../src/api/translator";

describe("translator api", () => {
  it("posts login, session, and realtime endpoints with the expected bodies", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/translator/session") {
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
            }
          ]
        };
      }
      return {};
    });
    const post = vi.fn(async (path: string) => {
      if (path === "/api/translator/login") {
        return {
          ok: true,
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
            }
          ]
        };
      }

      if (path === "/api/translator/realtime/token") {
        return {
          publishSessionId: "publish_1",
          token: "livekit-jwt",
          url: "wss://livekit.example.test",
          roomName: "program_1-stream_hi"
        };
      }

      return { ok: true, cleanup: "closed" };
    });

    const api = createTranslatorApi({ get, post } as unknown as TranslatorHttpClient);

    await api.login("patna-event-2026", "hi@example.com", "secret-pass");
    await api.session();
    await api.realtimeToken("stream_hi", { reclaim: true });
    await api.realtimeStop("stream_hi", "publish_1");
    await api.audioActivity("stream_hi", "publish_1", true);

    expect(post).toHaveBeenNthCalledWith(1, "/api/translator/login", {
      programSlug: "patna-event-2026",
      email: "hi@example.com",
      password: "secret-pass"
    });
    expect(get).toHaveBeenCalledWith("/api/translator/session");
    expect(post).toHaveBeenNthCalledWith(2, "/api/translator/realtime/token", {
      streamId: "stream_hi",
      reclaim: true
    });
    expect(post).toHaveBeenNthCalledWith(3, "/api/translator/realtime/stop", {
      streamId: "stream_hi",
      publishSessionId: "publish_1"
    });
    expect(post).toHaveBeenNthCalledWith(
      4,
      "/api/translator/realtime/audio-activity",
      {
        streamId: "stream_hi",
        publishSessionId: "publish_1",
        active: true
      }
    );
  });

  it("returns the realtime token response shape", async () => {
    const post = vi.fn(async () => ({
      publishSessionId: "publish_1",
      token: "livekit-jwt",
      url: "wss://livekit.example.test",
      roomName: "program_1-stream_hi"
    }));
    const api = createTranslatorApi({
      get: vi.fn(),
      post
    } as unknown as TranslatorHttpClient);

    const response = await api.realtimeToken("stream_hi");

    expect(response).toEqual({
      publishSessionId: "publish_1",
      token: "livekit-jwt",
      url: "wss://livekit.example.test",
      roomName: "program_1-stream_hi"
    });
    expect(post).toHaveBeenCalledWith("/api/translator/realtime/token", {
      streamId: "stream_hi"
    });
  });
});
