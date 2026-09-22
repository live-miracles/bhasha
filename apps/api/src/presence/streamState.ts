export type StreamAudioState = "offline" | "silent" | "live";

export interface AudioActivitySnapshot {
  publishSessionId: string;
  lastAudioActivityAt: number;
  active: boolean;
}

// A stream is Live only when the translator is connected, an audio track is
// published (the current D1 publisher pointer), and recent matching audio
// activity has been reported within this window. Published track without recent
// audio is Silent; no publisher pointer is Offline.
export const AUDIO_ACTIVITY_WINDOW_MS = 5_000;

export function deriveStreamState(input: {
  currentPublishSessionId: string | null;
  audioActivity: AudioActivitySnapshot | undefined;
  now: number;
  degraded: boolean;
}): StreamAudioState {
  if (input.currentPublishSessionId === null) {
    // The Cloudflare-Realtime-relay fallback ("no confirmed publisher, but
    // stale relay coordinates + a live program" reports as silent instead of
    // offline) was removed along with the rest of the relay subsystem in
    // Slice 1/3 -- no publisher pointer now always means offline, full stop.
    return "offline";
  }

  if (input.degraded) {
    return "silent";
  }

  const activity = input.audioActivity;
  const isLive =
    activity !== undefined &&
    activity.publishSessionId === input.currentPublishSessionId &&
    activity.active === true &&
    input.now - activity.lastAudioActivityAt <= AUDIO_ACTIVITY_WINDOW_MS;

  if (isLive) {
    return "live";
  }

  // MVP gap: there is no Durable Object alarm. When presence is unavailable we
  // cannot confirm recent audio, so a published stream degrades to Silent and
  // never to Live. Silent is also derived on reads below when the last activity
  // is older than AUDIO_ACTIVITY_WINDOW_MS, without persisting a
  // transition event.
  return "silent";
}
