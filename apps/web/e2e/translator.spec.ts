import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __micRequests?: number;
    __cameraRequests?: number;
    __translatorPeerCloses?: number;
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__micRequests = 0;
    window.__cameraRequests = 0;
    window.__translatorPeerCloses = 0;

    // Return REAL MediaStreams (from an AudioContext destination) so the
    // production Web Audio publish graph (createMediaStreamSource → gain →
    // destination) works in Chromium. A plain fake object throws in
    // createMediaStreamSource.
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const audioCtx = new AudioCtx();
    const makeStream = () => audioCtx.createMediaStreamDestination().stream;

    const audioInputs = [
      { deviceId: "mic-default", kind: "audioinput", label: "Default Microphone", groupId: "g1" },
      { deviceId: "mic-usb", kind: "audioinput", label: "USB Microphone", groupId: "g2" }
    ];

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: (constraints: MediaStreamConstraints) => {
          if (constraints && constraints.video) {
            window.__cameraRequests = (window.__cameraRequests ?? 0) + 1;
            return Promise.reject(new Error("translators must not request camera"));
          }
          if (constraints && constraints.audio) {
            window.__micRequests = (window.__micRequests ?? 0) + 1;
          }
          return Promise.resolve(makeStream());
        },
        enumerateDevices: () =>
          Promise.resolve(
            audioInputs.map((d) => ({ ...d, toJSON: () => d })) as unknown as MediaDeviceInfo[]
          )
      }
    });

    class MockPeerConnection {
      localDescription: RTCSessionDescriptionInit | null = null;
      iceConnectionState: RTCIceConnectionState = "connected";
      // The publisher client attaches transport-state listeners and reads
      // connectionState (fast-recovery). The mock must expose both or
      // attachStateListeners throws and publish fails ("Could not go live.").
      connectionState: RTCPeerConnectionState = "connected";

      addEventListener(_type: string, _handler: unknown) {}

      removeEventListener(_type: string, _handler: unknown) {}

      addTransceiver(_trackOrKind: unknown, _init?: RTCRtpTransceiverInit) {
        return { mid: "0" };
      }

      async createOffer() {
        return { type: "offer" as const, sdp: "offer-sdp" };
      }

      async setLocalDescription(description: RTCSessionDescriptionInit) {
        this.localDescription = description;
      }

      async setRemoteDescription(_description: RTCSessionDescriptionInit) {}

      setConfiguration(_configuration: RTCConfiguration) {}

      close() {
        window.__translatorPeerCloses = (window.__translatorPeerCloses ?? 0) + 1;
      }
    }

    window.RTCPeerConnection =
      MockPeerConnection as unknown as typeof RTCPeerConnection;
  });

  // Logged out on load; login provides the session.
  await page.route("**/api/translator/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 401,
      json: { error: "translator_auth_required" }
    });
  });

  await page.route("**/api/translator/login", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        ok: true,
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
      }
    });
  });

  let sessionIndex = 0;
  await page.route("**/api/translator/realtime/session", async (route) => {
    const body = route.request().postDataJSON() as { streamId: string };
    sessionIndex += 1;
    await route.fulfill({
      contentType: "application/json",
      json: {
        publishSessionId: `publish_${sessionIndex}`,
        streamId: body.streamId,
        sessionDescription: { type: "answer", sdp: "session-answer" },
        iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }]
      }
    });
  });

  await page.route("**/api/translator/realtime/publish", async (route) => {
    const body = route.request().postDataJSON() as {
      streamId: string;
      publishSessionId: string;
      track: { mid: string; trackName: string };
    };
    await route.fulfill({
      contentType: "application/json",
      json: {
        streamId: body.streamId,
        publishSessionId: body.publishSessionId,
        publishedTrack: { trackName: body.track.trackName, mid: body.track.mid },
        sessionDescription: { type: "answer", sdp: "publish-answer" },
        requiresImmediateRenegotiation: false
      }
    });
  });

  await page.route("**/api/translator/realtime/stop", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: { ok: true, cleanup: "closed" }
    });
  });
});

test("translator logs in, publishes audio-only, mutes, reconnects, and stops", async ({
  page
}) => {
  await page.goto("/patna-event-2026/translate");

  await expect(
    page.getByRole("heading", { name: "Translator login" })
  ).toBeVisible();

  await page.getByLabel("Email").fill("hi@example.com");
  await page.getByLabel("Password").fill("secret-pass");
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page.getByRole("button", { name: "Go live" })).toBeVisible();

  // Assigned stream selector shows only assigned streams.
  await expect(page.getByLabel("Language stream").locator("option")).toHaveText([
    "हिन्दी — Hindi",
    "বাংলা — Bengali"
  ]);

  await page.getByRole("button", { name: "Go live" }).click();
  await expect(page.getByText("ON AIR")).toBeVisible();

  // Microphone was requested audio-only; camera was never requested.
  await expect.poll(() => page.evaluate(() => window.__micRequests)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__cameraRequests)).toBe(0);

  // Mute / unmute does not stop the session.
  await page.getByRole("button", { name: "Mute" }).click();
  await expect(page.getByText("MUTED")).toBeVisible();
  await page.getByRole("button", { name: "Unmute" }).click();
  await expect(page.getByText("MUTED")).toBeHidden();
  await expect(page.getByText("ON AIR")).toBeVisible();

  // Reconnect republishes the stream with a fresh microphone track.
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.getByText("ON AIR")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__micRequests)).toBe(2);

  // Stop releases the session.
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Stopped")).toBeVisible();
  await expect(page.getByRole("button", { name: "Go live" })).toBeVisible();

  // Camera was never requested across the whole flow.
  await expect.poll(() => page.evaluate(() => window.__cameraRequests)).toBe(0);
});

test("translator opens Audio Settings sheet: mic picker, volume, toggles — on air too", async ({
  page
}) => {
  await page.goto("/patna-event-2026/translate");
  await page.getByLabel("Email").fill("hi@example.com");
  await page.getByLabel("Password").fill("secret-pass");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("button", { name: "Go live" })).toBeVisible();

  // Open the Audio Settings sheet (pre-live). The open fires the mic
  // permission probe + enumeration.
  await page.getByRole("button", { name: "Audio Settings" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Mic picker shows the two enumerated devices.
  await expect(dialog.getByLabel("Microphone").locator("option")).toHaveText([
    "Default Microphone",
    "USB Microphone"
  ]);

  // Volume slider + the three processing switches are present.
  await expect(dialog.getByRole("slider")).toBeVisible();
  await expect(dialog.getByRole("switch")).toHaveCount(3);

  // Dismiss via Escape.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Controls remain available ON AIR: go live, reopen, slider usable.
  await page.getByRole("button", { name: "Go live" }).click();
  await expect(page.getByText("ON AIR")).toBeVisible();
  await page.getByRole("button", { name: "Audio Settings" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("slider")).toBeEnabled();

  // Camera was never requested.
  await expect.poll(() => page.evaluate(() => window.__cameraRequests)).toBe(0);
});
