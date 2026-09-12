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

      if (path === "/api/translator/realtime/session") {
        return {
          publishSessionId: "publish_1",
          streamId: "stream_hi",
          iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }]
        };
      }

      if (path === "/api/translator/realtime/publish") {
        return {
          streamId: "stream_hi",
          publishSessionId: "publish_1",
          publishedTrack: { trackName: "mic-track", mid: "0" },
          sessionDescription: { type: "answer", sdp: "publish-answer" },
          requiresImmediateRenegotiation: false
        };
      }

      return { ok: true, cleanup: "closed" };
    });

    const api = createTranslatorApi({ get, post } as unknown as TranslatorHttpClient);

    await api.login("patna-event-2026", "hi@example.com", "secret-pass");
    await api.session();
    await api.realtimeSession("stream_hi", { reclaim: true });
    await api.realtimePublish(
      "stream_hi",
      "publish_1",
      { type: "offer", sdp: "publish-offer" },
      { mid: "0", trackName: "mic-track" }
    );
    await api.realtimeStop("stream_hi", "publish_1");
    await api.audioActivity("stream_hi", "publish_1", true);

    expect(post).toHaveBeenNthCalledWith(1, "/api/translator/login", {
      programSlug: "patna-event-2026",
      email: "hi@example.com",
      password: "secret-pass"
    });
    expect(get).toHaveBeenCalledWith("/api/translator/session");
    expect(post).toHaveBeenNthCalledWith(2, "/api/translator/realtime/session", {
      streamId: "stream_hi",
      reclaim: true
    });
    expect(post).toHaveBeenNthCalledWith(3, "/api/translator/realtime/publish", {
      streamId: "stream_hi",
      publishSessionId: "publish_1",
      sessionDescription: { type: "offer", sdp: "publish-offer" },
      track: { mid: "0", trackName: "mic-track" }
    });
    expect(post).toHaveBeenNthCalledWith(4, "/api/translator/realtime/stop", {
      streamId: "stream_hi",
      publishSessionId: "publish_1"
    });
    expect(post).toHaveBeenNthCalledWith(
      5,
      "/api/translator/realtime/audio-activity",
      {
        streamId: "stream_hi",
        publishSessionId: "publish_1",
        active: true
      }
    );
  });

  it("returns the realtime session response shape", async () => {
    const post = vi.fn(async () => ({
      publishSessionId: "publish_1",
      streamId: "stream_hi",
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }]
    }));
    const api = createTranslatorApi({
      get: vi.fn(),
      post
    } as unknown as TranslatorHttpClient);

    const response = await api.realtimeSession("stream_hi");

    expect(response).toEqual({
      publishSessionId: "publish_1",
      streamId: "stream_hi",
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }]
    });
  });
});
