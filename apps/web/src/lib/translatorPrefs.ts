import type { AudioToggles } from "../routes/TranslatorRoute";

// Persisted translator audio preferences. Toggles + gain are hardware/
// environment preferences and persist GLOBALLY (one key for all programs); the
// chosen microphone deviceId is persisted PER PROGRAM SLUG (a translator may
// use different mics in different venues, and deviceIds are origin/device
// specific so they should not bleed across programs).
//
// `AudioToggles` is imported as a type-only import: it is erased at compile
// time, so there is no runtime import cycle with TranslatorRoute even though
// TranslatorRoute imports load/save from here.
export type TranslatorPrefs = {
  micDeviceId: string | null;
  audioToggles: AudioToggles;
  gain: number;
};

// Global key for the shared toggles + gain.
const GLOBAL_AUDIO_KEY = "bhasha.translator.audio";
// Per-slug key for the chosen microphone deviceId.
const micDeviceIdKey = (slug: string) =>
  `bhasha.translator.${slug}.micDeviceId`;

const DEFAULT_TOGGLES: AudioToggles = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
};

function defaultPrefs(): TranslatorPrefs {
  return {
    micDeviceId: null,
    audioToggles: { ...DEFAULT_TOGGLES },
    gain: 1
  };
}

// The persisted shape of the global toggles+gain blob. Validated defensively on
// read so a malformed/partial blob degrades to defaults rather than throwing.
type StoredAudio = {
  audioToggles: AudioToggles;
  gain: number;
};

function isBool(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function parseStoredAudio(raw: string | null): StoredAudio | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (_error) {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  const toggles = candidate.audioToggles;
  if (typeof toggles !== "object" || toggles === null) {
    return null;
  }
  const t = toggles as Record<string, unknown>;
  if (
    !isBool(t.echoCancellation) ||
    !isBool(t.noiseSuppression) ||
    !isBool(t.autoGainControl)
  ) {
    return null;
  }
  const gain = typeof candidate.gain === "number" ? candidate.gain : 1;
  return {
    audioToggles: {
      echoCancellation: t.echoCancellation,
      noiseSuppression: t.noiseSuppression,
      autoGainControl: t.autoGainControl
    },
    gain
  };
}

// Load the translator's audio prefs for a program slug. The global toggles+gain
// blob and the per-slug deviceId are read independently; ANY failure (storage
// unavailable, getItem throwing, corrupt JSON) degrades to all-on defaults
// without throwing. Mirrors the getOrCreateClientId() storage idiom.
export function loadTranslatorPrefs(slug: string): TranslatorPrefs {
  try {
    const stored = parseStoredAudio(localStorage.getItem(GLOBAL_AUDIO_KEY));
    const micDeviceId = localStorage.getItem(micDeviceIdKey(slug));
    return {
      micDeviceId: micDeviceId || null,
      audioToggles: stored
        ? stored.audioToggles
        : { ...DEFAULT_TOGGLES },
      gain: stored ? stored.gain : 1
    };
  } catch (_error) {
    return defaultPrefs();
  }
}

// Persist the translator's audio prefs: toggles + gain to the global key,
// deviceId to the per-slug key. Best-effort — a throwing/full storage is
// swallowed so the UI never breaks on a save.
export function saveTranslatorPrefs(slug: string, prefs: TranslatorPrefs): void {
  try {
    localStorage.setItem(
      GLOBAL_AUDIO_KEY,
      JSON.stringify({
        audioToggles: prefs.audioToggles,
        gain: prefs.gain
      } satisfies StoredAudio)
    );
    if (prefs.micDeviceId) {
      localStorage.setItem(micDeviceIdKey(slug), prefs.micDeviceId);
    } else {
      localStorage.removeItem(micDeviceIdKey(slug));
    }
  } catch (_error) {
    // Storage unavailable / quota exceeded: prefs simply won't persist.
  }
}
