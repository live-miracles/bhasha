import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadTranslatorPrefs,
  saveTranslatorPrefs,
  type TranslatorPrefs
} from "../src/lib/translatorPrefs";

const GLOBAL_KEY = "bhasha.translator.audio";
const slugKey = (slug: string) => `bhasha.translator.${slug}.micDeviceId`;

describe("translatorPrefs", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("round-trips saved prefs for a slug", () => {
    const prefs: TranslatorPrefs = {
      micDeviceId: "mic-usb",
      audioToggles: {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: false
      },
      gain: 1.5
    };

    saveTranslatorPrefs("patna-event-2026", prefs);

    expect(loadTranslatorPrefs("patna-event-2026")).toEqual(prefs);
  });

  it("shares toggles + gain globally across two different slugs", () => {
    saveTranslatorPrefs("event-a", {
      micDeviceId: "mic-a",
      audioToggles: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true
      },
      gain: 0.5
    });

    // A different slug sees the SAME global toggles + gain, but its own
    // (here unset → null) deviceId.
    const loadedB = loadTranslatorPrefs("event-b");
    expect(loadedB.audioToggles).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true
    });
    expect(loadedB.gain).toBe(0.5);
    expect(loadedB.micDeviceId).toBeNull();
  });

  it("scopes the deviceId per slug", () => {
    saveTranslatorPrefs("event-a", {
      micDeviceId: "mic-a",
      audioToggles: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      gain: 1
    });
    saveTranslatorPrefs("event-b", {
      micDeviceId: "mic-b",
      audioToggles: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      gain: 1
    });

    expect(loadTranslatorPrefs("event-a").micDeviceId).toBe("mic-a");
    expect(loadTranslatorPrefs("event-b").micDeviceId).toBe("mic-b");
    // Distinct per-slug keys are used for the deviceId.
    expect(localStorage.getItem(slugKey("event-a"))).toBeTruthy();
    expect(localStorage.getItem(slugKey("event-b"))).toBeTruthy();
  });

  it("returns all-on defaults when storage is empty", () => {
    expect(loadTranslatorPrefs("fresh-event")).toEqual({
      micDeviceId: null,
      audioToggles: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      gain: 1
    });
  });

  it("returns defaults (no throw) when the stored JSON is corrupt", () => {
    // The global toggles+gain blob is JSON; a corrupt value degrades the whole
    // toggles+gain pref to all-on defaults. (The deviceId is a plain string, so
    // it is not subject to JSON corruption — left unset here → null.)
    localStorage.setItem(GLOBAL_KEY, "{not valid json");

    expect(() => loadTranslatorPrefs("bad-event")).not.toThrow();
    expect(loadTranslatorPrefs("bad-event")).toEqual({
      micDeviceId: null,
      audioToggles: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      gain: 1
    });
  });

  it("returns defaults when localStorage.getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    expect(() => loadTranslatorPrefs("blocked-event")).not.toThrow();
    expect(loadTranslatorPrefs("blocked-event")).toEqual({
      micDeviceId: null,
      audioToggles: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      gain: 1
    });
  });

  it("does not throw when localStorage.setItem throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    expect(() =>
      saveTranslatorPrefs("blocked-event", {
        micDeviceId: "mic-x",
        audioToggles: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        gain: 1
      })
    ).not.toThrow();
  });
});
