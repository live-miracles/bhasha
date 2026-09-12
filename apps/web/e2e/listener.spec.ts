import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __listenerMediaRequests?: number;
    __listenerPeerCloses?: number;
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => {
          window.__listenerMediaRequests = (window.__listenerMediaRequests ?? 0) + 1;
          return Promise.reject(new Error("listeners must not request media"));
        }
      }
    });

    class MockPeerConnection {
      localDescription: RTCSessionDescriptionInit | null = null;
      ontrack: ((event: RTCTrackEvent) => void) | null = null;

      addTransceiver(_kind: string, _init: RTCRtpTransceiverInit) {
        return {};
      }

      async createOffer() {
        return { type: "offer" as const, sdp: "offer-sdp" };
      }

      async createAnswer() {
        return { type: "answer" as const, sdp: "answer-sdp" };
      }

      async setLocalDescription(description: RTCSessionDescriptionInit) {
        this.localDescription = description;
      }

      async setRemoteDescription(description: RTCSessionDescriptionInit) {
        if (description.type === "offer" && this.ontrack) {
          this.ontrack({
            streams: [new MediaStream()]
          } as unknown as RTCTrackEvent);
        }
      }

      setConfiguration(_configuration: RTCConfiguration) {}

      close() {
        window.__listenerPeerCloses = (window.__listenerPeerCloses ?? 0) + 1;
      }
    }

    window.__listenerMediaRequests = 0;
    window.__listenerPeerCloses = 0;
    window.RTCPeerConnection =
      MockPeerConnection as unknown as typeof RTCPeerConnection;
    HTMLMediaElement.prototype.play = async () => undefined;
    HTMLMediaElement.prototype.pause = () => undefined;
  });

  await page.route(
    "**/api/public/programs/patna-event-2026/status",
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        json: {
          program: { slug: "patna-event-2026" },
          streams: [
            {
              id: "stream_hi",
              languageName: "Hindi",
              languageCode: "hi",
              isActive: true,
              state: "live",
              activeListeners: 7
            },
            {
              id: "stream_en",
              languageName: "English",
              languageCode: "en",
              isActive: true,
              state: "silent",
              activeListeners: 4
            }
          ],
          stale: false,
          degraded: false,
          serverTime: "2026-06-21T10:00:00.000Z"
        }
      });
    }
  );

  await page.route("**/api/public/programs/patna-event-2026", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        program: {
          slug: "patna-event-2026",
          name: "Patna Event 2026",
          venue: "Main Hall",
          eventDate: "2026-07-01",
          status: "live"
        },
        streams: [
          {
            id: "stream_hi",
            languageName: "Hindi",
            languageCode: "hi",
            displayOrder: 1,
            isActive: true
          },
          {
            id: "stream_en",
            languageName: "English",
            languageCode: "en",
            displayOrder: 2,
            isActive: true
          }
        ],
        urls: {
          listenerUrl: "https://bhasha.test/patna-event-2026",
          translatorUrl: "https://bhasha.test/patna-event-2026/translate"
        }
      }
    });
  });

  let connectionIndex = 0;
  await page.route("**/api/listeners/subscribe/session", async (route) => {
    const body = route.request().postDataJSON() as { connectionId?: string; streamId: string };
    connectionIndex += 1;
    await route.fulfill({
      contentType: "application/json",
      status: 201,
      json: {
        connectionId: body.connectionId ?? `listener_connection_${connectionIndex}`,
        streamId: body.streamId,
        sessionDescription: { type: "answer", sdp: "session-answer" },
        iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }]
      }
    });
  });

  await page.route("**/api/listeners/subscribe/track", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        connectionId: "listener_connection_current",
        track: { mid: "0", trackName: "remote-track" },
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: "offer", sdp: "remote-offer" }
      }
    });
  });

  await page.route("**/api/listeners/subscribe/renegotiate", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { ok: true } });
  });
  await page.route("**/api/listeners/connected", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { ok: true } });
  });
  await page.route("**/api/listeners/heartbeat", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { ok: true } });
  });
  await page.route("**/api/listeners/leave", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { ok: true } });
  });
  await page.route("**/api/listeners/switch", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 201,
      json: { connectionId: "listener_connection_switched" }
    });
  });
  await page.route("**/api/listeners/reconnect", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 201,
      json: { connectionId: "listener_connection_reconnected" }
    });
  });
});

test("listener can start, switch, and leave without requesting media", async ({ page }) => {
  await page.goto("/patna-event-2026");

  await page.getByRole("button", { name: "Listen to Hindi" }).click();
  await expect(page.getByText("Listening to Hindi")).toBeVisible();

  await page.getByRole("button", { name: "Switch to English" }).click();
  await expect(page.getByText("Listening to English")).toBeVisible();

  await page.getByRole("button", { name: "Leave stream" }).click();
  await expect(page.getByText("Choose a language to listen.")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__listenerMediaRequests))
    .toBe(0);
});

test("listener can reconnect after a failed first listen without requesting media", async ({
  page
}) => {
  let firstSubscribe = true;
  await page.route("**/api/listeners/subscribe/session", async (route) => {
    const body = route.request().postDataJSON() as { streamId: string };
    if (firstSubscribe) {
      firstSubscribe = false;
      await route.fulfill({
        contentType: "application/json",
        status: 502,
        json: { error: "realtime_error" }
      });
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      status: 201,
      json: {
        connectionId: "listener_connection_recovered",
        streamId: body.streamId,
        sessionDescription: { type: "answer", sdp: "session-answer" },
        iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }]
      }
    });
  });

  await page.goto("/patna-event-2026");

  await page.getByRole("button", { name: "Listen to Hindi" }).click();
  await expect(page.getByText("Disconnected")).toBeVisible();
  await expect(
    page.getByText("Realtime connection failed. Try reconnecting.")
  ).toBeVisible();
  await page.getByRole("button", { name: "Reconnect Hindi" }).click();
  await expect(page.getByText("Listening to Hindi")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__listenerMediaRequests))
    .toBe(0);
});
