import { describe, expect, it } from "vitest";

import { deriveStreamState } from "../src/presence/streamState";

const NOW = 1_000_000;

describe("deriveStreamState", () => {
  it("is offline when there is no current publisher pointer", () => {
    expect(
      deriveStreamState({
        currentPublishSessionId: null,
        audioActivity: {
          publishSessionId: "publish_1",
          lastAudioActivityAt: NOW,
          active: true
        },
        now: NOW,
        degraded: false
      })
    ).toBe("offline");
  });

  it("is silent when a track is published but no audio activity exists", () => {
    expect(
      deriveStreamState({
        currentPublishSessionId: "publish_1",
        audioActivity: undefined,
        now: NOW,
        degraded: false
      })
    ).toBe("silent");
  });

  it("is live when recent matching audio activity is active", () => {
    expect(
      deriveStreamState({
        currentPublishSessionId: "publish_1",
        audioActivity: {
          publishSessionId: "publish_1",
          lastAudioActivityAt: NOW - 2_000,
          active: true
        },
        now: NOW,
        degraded: false
      })
    ).toBe("live");
  });

  it("is live when matching audio activity is exactly at the window boundary", () => {
    expect(
      deriveStreamState({
        currentPublishSessionId: "publish_1",
        audioActivity: {
          publishSessionId: "publish_1",
          lastAudioActivityAt: NOW - 5_000,
          active: true
        },
        now: NOW,
        degraded: false
      })
    ).toBe("live");
  });

  it("is silent when the last audio activity is older than the window", () => {
    expect(
      deriveStreamState({
        currentPublishSessionId: "publish_1",
        audioActivity: {
          publishSessionId: "publish_1",
          lastAudioActivityAt: NOW - 5_001,
          active: true
        },
        now: NOW,
        degraded: false
      })
    ).toBe("silent");
  });

  it("is silent when audio activity is reported inactive", () => {
    expect(
      deriveStreamState({
        currentPublishSessionId: "publish_1",
        audioActivity: {
          publishSessionId: "publish_1",
          lastAudioActivityAt: NOW,
          active: false
        },
        now: NOW,
        degraded: false
      })
    ).toBe("silent");
  });

  it("does not let an older publish session's activity make a new publisher live", () => {
    expect(
      deriveStreamState({
        currentPublishSessionId: "publish_new",
        audioActivity: {
          publishSessionId: "publish_old",
          lastAudioActivityAt: NOW,
          active: true
        },
        now: NOW,
        degraded: false
      })
    ).toBe("silent");
  });

  it("degrades to silent (never live) when presence is unavailable but a pointer exists", () => {
    expect(
      deriveStreamState({
        currentPublishSessionId: "publish_1",
        audioActivity: undefined,
        now: NOW,
        degraded: true
      })
    ).toBe("silent");
  });

  it("is offline when degraded and there is no pointer", () => {
    expect(
      deriveStreamState({
        currentPublishSessionId: null,
        audioActivity: undefined,
        now: NOW,
        degraded: true
      })
    ).toBe("offline");
  });

  it("is silent for a live program with relay coords and no translator", () => {
    expect(
      deriveStreamState({
        currentPublishSessionId: null,
        audioActivity: undefined,
        now: NOW,
        degraded: false,
        relayCoordsPresent: true,
        programLive: true
      })
    ).toBe("silent");
  });

  it("is live when a translator is publishing even with relay coords and live program", () => {
    expect(
      deriveStreamState({
        currentPublishSessionId: "publish_1",
        audioActivity: {
          publishSessionId: "publish_1",
          lastAudioActivityAt: NOW - 2_000,
          active: true
        },
        now: NOW,
        degraded: false,
        relayCoordsPresent: true,
        programLive: true
      })
    ).toBe("live");
  });

  it("is offline when there is no relay and no live translator", () => {
    expect(
      deriveStreamState({
        currentPublishSessionId: null,
        audioActivity: undefined,
        now: NOW,
        degraded: false
      })
    ).toBe("offline");
  });

  it("is offline for archived or draft programs even when relay coords are present", () => {
    expect(
      deriveStreamState({
        currentPublishSessionId: null,
        audioActivity: undefined,
        now: NOW,
        degraded: false,
        relayCoordsPresent: true,
        programLive: false
      })
    ).toBe("offline");
  });
});
