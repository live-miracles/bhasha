import {
    FormEvent,
    KeyboardEvent as ReactKeyboardEvent,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';

import { ApiError } from '../api/client';
import { createPublicApi, type PublicApi } from '../api/public';
import {
    createTranslatorApi,
    type AssignedStream,
    type TranslatorApi,
    type TranslatorInfo,
} from '../api/translator';
import {
    createTranslatorRealtimeClient,
    type RoomHandle,
    type TranslatorPublishSession,
    type TranslatorRealtimeClient,
    type TranslatorTransportState,
} from '../realtime/translatorClient';
import { loadTranslatorPrefs, saveTranslatorPrefs } from '../lib/translatorPrefs';
import { getMeterZone, levelToFilledSegments, METER_SEGMENTS } from '../lib/micMeter';

export interface TranslatorAudioMeter {
    getLevel(): number;
    close(): void;
}

export type TranslatorAudioMeterFactory = (stream: MediaStream) => TranslatorAudioMeter | null;

// The Web Audio publish pipeline: source mic stream ──▶ GainNode ──▶ destination.
// The `publishedTrack` is created ONCE from the destination and never replaced,
// so a live mic/toggle change (swapSource) or a volume change (setGain) never
// alters the track handed to the realtime client — listeners see no disruption.
export interface TranslatorPublishGraph {
    // The stable destination track that gets published; identity never changes.
    publishedTrack: MediaStreamTrack;
    // Live volume control: sets gainNode.gain.value.
    setGain(value: number): void;
    // Swap the upstream source (new mic / new processing constraints) without
    // touching the destination/published track.
    swapSource(stream: MediaStream): void;
    // Tap point for the level meter so it reflects the post-gain (published) level.
    getMeterSource(): MediaStream;
    // Resume the underlying AudioContext if the autoplay policy left it suspended.
    // Called from the go-live user gesture. Best-effort.
    resume(): void;
    // Tear down the AudioContext + nodes.
    destroy(): void;
}

export type TranslatorPublishGraphFactory = (stream: MediaStream) => TranslatorPublishGraph;

type ScreenWakeLockSentinel = {
    release(): Promise<void>;
};

type ScreenWakeLockNavigator = Navigator & {
    wakeLock?: {
        request(type: 'screen'): Promise<ScreenWakeLockSentinel>;
    };
};

export type TranslatorConnectionStateHandler = (
    publishSessionId: string,
    state: TranslatorTransportState,
) => void;

export interface TranslatorRouteProps {
    programSlug: string;
    publicApi?: PublicApi;
    translatorApi?: TranslatorApi;
    realtimeClient?: TranslatorRealtimeClient;
    // Test seam: threaded into createTranslatorRealtimeClient when no
    // `realtimeClient` override is given, so a test can exercise the REAL client
    // construction/wiring (the one line that picks between the two) with a fake
    // Room instead of also having to fake the whole TranslatorRealtimeClient
    // interface. No-op in production (falls through to `new Room()`).
    createRoom?: () => RoomHandle;
    createAudioMeter?: TranslatorAudioMeterFactory;
    createPublishGraph?: TranslatorPublishGraphFactory;
    meterPollMs?: number;
    silentSampleThreshold?: number;
    silentWarningSampleThreshold?: number;
    audioActivityReportMs?: number;
    publisherHeartbeatMs?: number;
    // Fast-recovery tuning (injectable for deterministic tests, like the listener).
    recoveryBaseMs?: number;
    recoveryMaxMs?: number;
    recoveryMaxAttempts?: number;
    // Test seam: exposes the internal transport-state recovery dispatcher so tests
    // can drive connectionstatechange without a real PeerConnection. In production
    // the same handler is wired into createTranslatorRealtimeClient.
    onRealtimeHandlerReady?: (handler: TranslatorConnectionStateHandler) => void;
    // Test seam: exposes the permission-probe + enumerate routine that the Phase 4
    // "Audio Settings" button fires on first open. Lets the enumeration/probe
    // logic be driven before that UI exists. No-op in production.
    onAudioControlsReady?: (controls: {
        ensureMicPermissionAndEnumerate: () => Promise<void>;
    }) => void;
}

type AuthState =
    | { status: 'checking' }
    | { status: 'programMissing' }
    | { status: 'loggedOut' }
    | {
          status: 'loggedIn';
          translator: TranslatorInfo;
          assignedStreams: AssignedStream[];
      };

type PublishState =
    | { status: 'ready' }
    | { status: 'connecting' }
    | { status: 'live'; publishSessionId: string; streamId: string }
    | { status: 'reconnecting' }
    | { status: 'stopped' }
    | { status: 'error'; message: PublishErrorMessage };

type PublishErrorMessage = {
    title: string;
    detail: string;
};

const DEFAULT_METER_POLL_MS = 500;
const DEFAULT_SILENT_SAMPLE_THRESHOLD = 4;
// The translator-facing "No audio detected" warning is decoupled from the
// listener silent badge: it must only fire on a SUSTAINED silence that suggests
// a real mic problem, not the natural pauses between phrases. ~12s at the default
// 500ms poll (vs the listener badge's faster 4-sample / ~2s slow-release).
const DEFAULT_SILENT_WARNING_SAMPLE_THRESHOLD = 24;
const SILENT_LEVEL_THRESHOLD = 0.02;
// Heartbeat cadence for active audio reports. Must be well under the 5s
// server-side activity window so a live stream is not derived as Silent.
const DEFAULT_AUDIO_ACTIVITY_REPORT_MS = 2_500;
// Publisher heartbeat cadence. Keeps the bounded server-side publisher TTL
// (90s) alive while live, regardless of speaking/silence, so a genuinely-live
// publisher is never expired by the cap. Must be well under the TTL window.
const DEFAULT_PUBLISHER_HEARTBEAT_MS = 30_000;
// Fast-recovery: LiveKit's own Room already retries transient drops internally
// (RoomEvent.Reconnecting/Reconnected) with no app-level timer needed. Only a
// TERMINAL disconnect (LiveKit gave up, or the token's 1h TTL expired) reaches
// scheduleRecovery, which mints a fresh token and republishes with exponential
// backoff bounded by cap + max attempts so a persistently-down publisher never
// spins.
const DEFAULT_RECOVERY_BASE_MS = 500;
const DEFAULT_RECOVERY_MAX_MS = 4_000;
const DEFAULT_RECOVERY_MAX_ATTEMPTS = 6;

// Browser audio-processing toggles applied to the captured microphone source.
// Defaults match the legacy MIC_CONSTRAINTS (all on); the translator can flip
// these live from the Audio Settings sheet.
export type AudioToggles = {
    echoCancellation: boolean;
    noiseSuppression: boolean;
    autoGainControl: boolean;
};

// A selectable microphone input. `label` is empty until permission is granted
// (the browser withholds device labels pre-grant).
export type AudioInputDevice = {
    deviceId: string;
    label: string;
};

// Builds the getUserMedia constraints for the microphone source. A pinned
// deviceId uses `{ exact }` so a translator's chosen mic is honoured or fails
// clearly (never silently swapped); with no selection the deviceId key is
// omitted entirely so the default-mic shape is byte-identical to the legacy
// MIC_CONSTRAINTS.
// Enumerates the available microphone inputs. Guards on the API being present
// (returns [] if absent so unrelated test environments don't break), filters to
// audioinput devices, and drops entries with an empty deviceId (the browser
// emits a blank placeholder pre-permission).
async function defaultEnumerateAudioInputs(): Promise<AudioInputDevice[]> {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) {
        return [];
    }
    let devices: MediaDeviceInfo[];
    try {
        devices = await mediaDevices.enumerateDevices();
    } catch (_error) {
        return [];
    }
    return devices
        .filter((device) => device.kind === 'audioinput' && device.deviceId)
        .map((device) => ({ deviceId: device.deviceId, label: device.label }));
}

function buildMicConstraints(
    deviceId: string | null,
    toggles: AudioToggles,
): MediaStreamConstraints {
    return {
        audio: {
            echoCancellation: toggles.echoCancellation,
            noiseSuppression: toggles.noiseSuppression,
            autoGainControl: toggles.autoGainControl,
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
        video: false,
    };
}

export function TranslatorRoute({
    programSlug,
    publicApi: publicApiProp,
    translatorApi: translatorApiProp,
    realtimeClient: realtimeClientProp,
    createRoom,
    createAudioMeter = createDefaultAudioMeter,
    createPublishGraph = createDefaultPublishGraph,
    meterPollMs = DEFAULT_METER_POLL_MS,
    silentSampleThreshold = DEFAULT_SILENT_SAMPLE_THRESHOLD,
    silentWarningSampleThreshold = DEFAULT_SILENT_WARNING_SAMPLE_THRESHOLD,
    audioActivityReportMs = DEFAULT_AUDIO_ACTIVITY_REPORT_MS,
    publisherHeartbeatMs = DEFAULT_PUBLISHER_HEARTBEAT_MS,
    recoveryBaseMs = DEFAULT_RECOVERY_BASE_MS,
    recoveryMaxMs = DEFAULT_RECOVERY_MAX_MS,
    recoveryMaxAttempts = DEFAULT_RECOVERY_MAX_ATTEMPTS,
    onRealtimeHandlerReady,
    onAudioControlsReady,
}: TranslatorRouteProps) {
    const translatorApi = useMemo(
        () => translatorApiProp ?? createTranslatorApi(),
        [translatorApiProp],
    );
    const publicApi = useMemo(() => publicApiProp ?? createPublicApi(), [publicApiProp]);
    // Read the latest transport-state handler via a ref so the memoized client
    // (created once) always dispatches to the current closure.
    const connectionStateHandlerRef = useRef<TranslatorConnectionStateHandler>(() => {});
    const realtimeClient = useMemo(
        () =>
            realtimeClientProp ??
            createTranslatorRealtimeClient({
                translatorApi,
                ...(createRoom ? { createRoom } : {}),
                onConnectionStateChange: (publishSessionId, state) =>
                    connectionStateHandlerRef.current(publishSessionId, state),
            }),
        [realtimeClientProp, translatorApi, createRoom],
    );

    const [auth, setAuth] = useState<AuthState>({ status: 'checking' });
    const [publish, setPublish] = useState<PublishState>({ status: 'ready' });
    const [selectedStreamId, setSelectedStreamId] = useState('');
    const [muted, setMuted] = useState(false);
    const [silent, setSilent] = useState(false);
    const [stale, setStale] = useState(false);
    const [recoveryExhausted, setRecoveryExhausted] = useState(false);
    const [justRecovered, setJustRecovered] = useState(false);
    const [endedMessage, setEndedMessage] = useState<string | null>(null);
    const [loginEmail, setLoginEmail] = useState('');
    const [loginPassword, setLoginPassword] = useState('');
    const [loginError, setLoginError] = useState<string | null>(null);
    const [meterLevel, setMeterLevel] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [elapsedLabel, setElapsedLabel] = useState(formatElapsedLabel(0));

    // Microphone selection + live audio controls. `selectedMicId === null` means
    // "browser default" (no deviceId pinned). gainValue is unity (1.0) by default.
    // Seeded from persisted prefs on mount: toggles + gain are GLOBAL, the
    // deviceId is per program slug (lazy initialiser so the read happens once).
    const initialPrefs = useRef(loadTranslatorPrefs(programSlug));
    const [selectedMicId, setSelectedMicId] = useState<string | null>(
        initialPrefs.current.micDeviceId,
    );
    const [audioToggles, setAudioToggles] = useState<AudioToggles>(
        initialPrefs.current.audioToggles,
    );
    const [gainValue, setGainValue] = useState(initialPrefs.current.gain);
    // Device enumeration + permission-probe state (Phase 3).
    const [audioInputs, setAudioInputs] = useState<AudioInputDevice[]>([]);
    const [permissionGranted, setPermissionGranted] = useState(false);
    // Audio Settings bottom sheet (Phase 4). Same sheet on Ready + Live.
    const [audioSheetOpen, setAudioSheetOpen] = useState(false);

    const mediaStreamRef = useRef<MediaStream | null>(null);
    const activeTrackRef = useRef<MediaStreamTrack | null>(null);
    // The live Web Audio publish graph (source ▶ gain ▶ destination). Set when a
    // track is acquired; read by the meter, source-swap, and teardown paths.
    const graphRef = useRef<TranslatorPublishGraph | null>(null);
    const mutedRef = useRef(false);
    // Mirror refs for the device/toggle/gain controls. The long-lived
    // auto-recovery closure (handleReconnect via handleReconnectRef) and the
    // graph callbacks always read these LIVE values, not captured state — same
    // idiom as mutedRef below.
    const selectedMicIdRef = useRef<string | null>(initialPrefs.current.micDeviceId);
    const audioTogglesRef = useRef<AudioToggles>(initialPrefs.current.audioToggles);
    const gainValueRef = useRef(initialPrefs.current.gain);
    const permissionGrantedRef = useRef(false);
    const wakeLockRef = useRef<ScreenWakeLockSentinel | null>(null);
    // Fast-recovery state. livePublishRef mirrors the current live session so the
    // transport handler can ignore stale events; the latch/timer/attempt refs
    // bound and de-duplicate re-publish attempts.
    const livePublishRef = useRef<{
        publishSessionId: string;
        streamId: string;
    } | null>(null);
    const recoveryInFlightRef = useRef(false);
    const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const recoveryAttemptRef = useRef(0);
    const hiddenSinceRef = useRef<number | null>(null);
    // Set when a reconnect (manual or auto-recovery) starts, read once when the
    // republished session goes live so the "Reconnected" confirmation fires on the
    // PRIMARY republish path (onLive/publish-effect clear stale before the new PC's
    // 'connected' event, so the transient-state check alone would miss it).
    const recoveryWasActiveRef = useRef(false);
    const handleReconnectRef = useRef<() => Promise<void>>(async () => {});
    // Latest ensureMicPermissionAndEnumerate, exposed via the onAudioControlsReady
    // test seam and (in Phase 4) the Audio Settings button.
    const ensureMicPermissionAndEnumerateRef = useRef<() => Promise<void>>(async () => {});
    const liveStartedAtRef = useRef<number | null>(null);
    const heartbeatSeqRef = useRef(0);

    useEffect(() => {
        mutedRef.current = muted;
    }, [muted]);

    useEffect(() => {
        selectedMicIdRef.current = selectedMicId;
    }, [selectedMicId]);

    useEffect(() => {
        audioTogglesRef.current = audioToggles;
    }, [audioToggles]);

    useEffect(() => {
        gainValueRef.current = gainValue;
    }, [gainValue]);

    useEffect(() => {
        permissionGrantedRef.current = permissionGranted;
    }, [permissionGranted]);

    // Persist the audio prefs whenever the device / toggles / gain change. Toggles
    // + gain are written to the GLOBAL key, the deviceId to the per-slug key (see
    // translatorPrefs). Best-effort; a throwing/full storage is swallowed there.
    useEffect(() => {
        saveTranslatorPrefs(programSlug, {
            micDeviceId: selectedMicId,
            audioToggles,
            gain: gainValue,
        });
    }, [programSlug, selectedMicId, audioToggles, gainValue]);

    function applySession(translator: TranslatorInfo, assignedStreams: AssignedStream[]) {
        setAuth({ status: 'loggedIn', translator, assignedStreams });
        setSelectedStreamId((current) => {
            if (current && assignedStreams.some((stream) => stream.id === current)) {
                return current;
            }
            return assignedStreams[0]?.id ?? '';
        });
        setPublish({ status: 'ready' });
        setMuted(false);
        setSilent(false);
        setStale(false);
        setEndedMessage(null);
        setMeterLevel(0);
        setElapsedMs(0);
        setElapsedLabel(formatElapsedLabel(0));
        // Enumerate once on session apply. Pre-grant the browser returns blank
        // labels (and may hide non-default deviceIds); the labelled list arrives
        // after the first permission probe (ensureMicPermissionAndEnumerate).
        void enumerateAudioInputs();
    }

    async function enumerateAudioInputs() {
        const inputs = await defaultEnumerateAudioInputs();
        setAudioInputs(inputs);
        // Gated stale-device reconciliation: ONLY after permission has been granted
        // (so we have a real, labelled device list — never the pre-grant empty
        // list). If a persisted/selected deviceId is no longer present, drop the
        // selection back to the browser default so go-live doesn't pin a vanished
        // mic. The save effect then clears the stale per-slug deviceId.
        if (permissionGrantedRef.current) {
            const pinned = selectedMicIdRef.current;
            if (pinned && !inputs.some((device) => device.deviceId === pinned)) {
                selectedMicIdRef.current = null;
                setSelectedMicId(null);
            }
        }
    }

    // Fired on the first Audio Settings open. If permission has not yet been
    // granted, probe getUserMedia (default constraints) purely to unlock device
    // labels — the probe tracks are stopped LOCALLY and never enter
    // mediaStreamRef/the graph. On grant we re-enumerate to pick up the labels.
    // The re-prompt guard is permissionGrantedRef (set on a successful probe);
    // a rejected probe is silent (no banner) and leaves the default device list.
    async function ensureMicPermissionAndEnumerate() {
        if (permissionGrantedRef.current) {
            await enumerateAudioInputs();
            return;
        }
        try {
            const probe = await navigator.mediaDevices.getUserMedia(
                buildMicConstraints(null, audioTogglesRef.current),
            );
            for (const track of probe.getTracks()) {
                track.stop();
            }
            setPermissionGranted(true);
            permissionGrantedRef.current = true;
            await enumerateAudioInputs();
        } catch (_error) {
            // Probe denied: leave the default (blank) list and show no banner. The
            // go-live permission failure is handled separately via messageForMicAccess.
        }
    }

    // Audio Settings sheet: open it AND fire the permission/enumerate probe so the
    // mic picker can show labelled devices. Closing is plain state.
    function openAudioSheet() {
        setAudioSheetOpen(true);
        void ensureMicPermissionAndEnumerateRef.current();
    }

    function closeAudioSheet() {
        setAudioSheetOpen(false);
    }

    // Live volume control: update state (mirrored to gainValueRef) AND push the
    // value straight into the live graph so the change is instant, on or off air,
    // with NO re-acquire / republish. The published destination track is unchanged.
    function handleGainChange(value: number) {
        setGainValue(value);
        gainValueRef.current = value;
        graphRef.current?.setGain(value);
    }

    // Partial toggle update. State is mirrored to audioTogglesRef so the next
    // acquireMicTrack (go-live / reconnect) builds constraints with the new value.
    // When a graph is live, also re-acquire the source so the processing change
    // (echo / noise / auto-gain) takes effect mid-broadcast with no republish.
    function handleToggleAudio(key: keyof AudioToggles, value: boolean) {
        // Mirror handleSelectMic: compute the next toggles and update the ref AND
        // state OUTSIDE the updater so audioTogglesRef is current before the
        // synchronous reacquireSource() reads it (a ref write inside the updater is
        // fragile under React batching / double-invoke).
        const next = { ...audioTogglesRef.current, [key]: value };
        audioTogglesRef.current = next;
        setAudioToggles(next);
        if (graphRef.current) {
            void reacquireSource().catch(() => {
                // See handleSelectMic: a non-Overconstrained failure is surfaced on the
                // next go-live/reconnect; the live graph keeps the previous source.
            });
        }
    }

    function returnToLogin() {
        stopMediaTracks();
        activeTrackRef.current = null;
        heartbeatSeqRef.current += 1;
        setPublish({ status: 'ready' });
        setMuted(false);
        setSilent(false);
        setStale(false);
        setMeterLevel(0);
        setElapsedMs(0);
        setElapsedLabel(formatElapsedLabel(0));
        liveStartedAtRef.current = null;
        setAuth({ status: 'loggedOut' });
    }

    // Sign-out button: tear down an active publish (backend stop + media +
    // recovery cancel) before logging out, so signing out while live doesn't
    // leave a publisher to expire via TTL. The auth-failure path calls
    // returnToLogin() directly (the session is already gone there).
    async function handleSignOut() {
        try {
            await translatorApi.logout?.();
        } catch (_error) {
            // Best-effort logout: proceed with local teardown even if backend cleanup
            // fails.
        }

        if (
            publish.status === 'live' ||
            publish.status === 'connecting' ||
            publish.status === 'reconnecting'
        ) {
            await handleStop();
        }
        returnToLogin();
    }

    function stopMediaTracks() {
        const stream = mediaStreamRef.current;
        if (stream) {
            for (const track of stream.getTracks()) {
                track.stop();
            }
            mediaStreamRef.current = null;
        }
        // Tear down the Web Audio publish graph alongside the source stream. The
        // graph owns the published destination track; once the source is gone the
        // graph has nothing to feed it.
        const graph = graphRef.current;
        if (graph) {
            graph.destroy();
            graphRef.current = null;
        }
    }

    // getUserMedia with the current source constraints, retrying ONCE on the
    // browser default if a pinned deviceId is rejected with OverconstrainedError
    // (the mic was unplugged / is no longer available). On retry the stale
    // selection is cleared so the UI + persisted prefs follow the fallback. Other
    // rejections (permission denied, etc.) propagate unchanged.
    async function getUserMediaWithDeviceFallback(): Promise<MediaStream> {
        try {
            return await navigator.mediaDevices.getUserMedia(
                buildMicConstraints(selectedMicIdRef.current, audioTogglesRef.current),
            );
        } catch (error) {
            const hadDeviceId = selectedMicIdRef.current !== null;
            // Check `name` directly (not `instanceof Error`): the browser throws an
            // OverconstrainedError DOMException, which is not always an Error subclass
            // (e.g. jsdom), so the name check is the portable signal.
            const isOverconstrained =
                (error as { name?: string } | null)?.name === 'OverconstrainedError';
            if (hadDeviceId && isOverconstrained) {
                selectedMicIdRef.current = null;
                setSelectedMicId(null);
                return await navigator.mediaDevices.getUserMedia(
                    buildMicConstraints(null, audioTogglesRef.current),
                );
            }
            throw error;
        }
    }

    async function acquireMicTrack(): Promise<MediaStreamTrack> {
        stopMediaTracks();
        // Translators publish microphone audio only. Camera is never requested.
        // Current device + processing toggles are read via refs so the long-lived
        // auto-recovery closure always acquires with the LIVE selection.
        const stream = await getUserMediaWithDeviceFallback();
        mediaStreamRef.current = stream;
        // Route the source through the publish graph: the track we publish is the
        // graph's stable destination track, never the raw mic track. Apply the
        // current gain immediately so go-live honours the volume slider.
        const graph = createPublishGraph(stream);
        graph.setGain(gainValueRef.current);
        // go-live runs from a user gesture (the "Go live" / "Reconnect" click), so
        // resuming a suspended context here satisfies the autoplay policy.
        graph.resume();
        graphRef.current = graph;
        return graph.publishedTrack;
    }

    // Live source-swap: re-acquire ONLY the upstream microphone source (new mic /
    // new processing constraints) and swap it into the existing graph. The graph's
    // destination (the published track) is untouched, so this never calls
    // realtimeClient.publish/reconnect — the relay/listeners see no change. Only
    // meaningful while a graph is live; the caller guards on graphRef being set.
    // An OverconstrainedError on a pinned mid-broadcast device is recovered via
    // getUserMediaWithDeviceFallback (retry-on-default), keeping the graph alive.
    async function reacquireSource() {
        const graph = graphRef.current;
        if (!graph) {
            return;
        }
        const stream = await getUserMediaWithDeviceFallback();
        const previous = mediaStreamRef.current;
        if (previous) {
            for (const track of previous.getTracks()) {
                track.stop();
            }
        }
        mediaStreamRef.current = stream;
        graph.swapSource(stream);
    }

    // Mic <select> change. State + ref update always; when a graph is live we also
    // swap the source so the change takes effect mid-broadcast with no republish.
    // Off air, the new selection is just picked up at the next acquireMicTrack.
    function handleSelectMic(deviceId: string | null) {
        setSelectedMicId(deviceId);
        selectedMicIdRef.current = deviceId;
        if (graphRef.current) {
            void reacquireSource().catch(() => {
                // A non-Overconstrained getUserMedia failure surfaces via the existing
                // mic-access banner on the next go-live/reconnect; the live graph keeps
                // feeding the previous source until then.
            });
        }
    }

    function onLive(session: TranslatorPublishSession) {
        setEndedMessage(null);
        heartbeatSeqRef.current += 1;
        liveStartedAtRef.current = Date.now();
        activeTrackRef.current = session.track;
        setMuted(false);
        setSilent(false);
        setStale(false);
        setMeterLevel(0);
        setElapsedMs(0);
        setElapsedLabel('0:00:00');
        setPublish({
            status: 'live',
            publishSessionId: session.publishSessionId,
            streamId: session.streamId,
        });
    }

    function onPublishFailure(error: unknown) {
        stopMediaTracks();
        activeTrackRef.current = null;
        if (error instanceof ApiError && error.code === 'translator_auth_required') {
            returnToLogin();
            return;
        }
        setPublish({ status: 'error', message: messageForPublishError(error) });
    }

    useEffect(() => {
        let active = true;
        setAuth({ status: 'checking' });

        void (async () => {
            try {
                await publicApi.fetchProgram(programSlug);
            } catch (error) {
                if (!active) {
                    return;
                }

                if (error instanceof ApiError && error.code === 'program_not_found') {
                    setAuth({ status: 'programMissing' });
                    return;
                }

                setAuth({ status: 'loggedOut' });
                return;
            }

            try {
                const result = await translatorApi.session();
                if (!active) {
                    return;
                }
                if (result && result.translator) {
                    applySession(result.translator, result.assignedStreams);
                } else {
                    setAuth({ status: 'loggedOut' });
                }
            } catch (_error) {
                if (active) {
                    setAuth({ status: 'loggedOut' });
                }
            }
        })();

        return () => {
            active = false;
        };
    }, [programSlug, publicApi, translatorApi]);

    useEffect(() => {
        return () => {
            stopMediaTracks();
        };
    }, []);

    useEffect(() => {
        if (publish.status !== 'live') {
            return undefined;
        }

        let cancelled = false;

        async function requestWakeLock() {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
                return;
            }

            const wakeLock = (navigator as ScreenWakeLockNavigator).wakeLock;
            if (!wakeLock) {
                return;
            }

            try {
                const previous = wakeLockRef.current;
                wakeLockRef.current = null;
                if (previous) {
                    await previous.release().catch(() => {});
                }

                const nextWakeLock = await wakeLock.request('screen');
                if (cancelled) {
                    await nextWakeLock.release().catch(() => {});
                    return;
                }
                wakeLockRef.current = nextWakeLock;
            } catch (_error) {
                // Wake Lock is a best-effort mobile safeguard. Publishing must continue
                // when the browser does not support it or denies the request.
            }
        }

        function handleVisibilityChange() {
            if (document.visibilityState === 'visible') {
                void requestWakeLock();
            }
        }

        void requestWakeLock();
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            cancelled = true;
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            const current = wakeLockRef.current;
            if (current) {
                wakeLockRef.current = null;
                void current.release().catch(() => {});
            }
        };
    }, [publish.status]);

    useEffect(() => {
        function recordHidden() {
            hiddenSinceRef.current = Date.now();
        }

        function handleVisible() {
            if (publish.status !== 'live') {
                return;
            }

            const live = livePublishRef.current;
            if (live) {
                const hbId = ++heartbeatSeqRef.current;
                void translatorApi
                    .heartbeat(live.streamId, live.publishSessionId)
                    .then(() => {
                        if (heartbeatSeqRef.current === hbId) {
                            // A healthy heartbeat means the server sees us live — re-arm
                            // recovery so the exhaustion latch can never outlive `stale`.
                            setStale(false);
                            setRecoveryExhausted(false);
                            recoveryAttemptRef.current = 0;
                        }
                    })
                    .catch(() => {
                        if (heartbeatSeqRef.current === hbId) {
                            scheduleRecovery();
                        }
                    });
            } else {
                scheduleRecovery();
            }

            hiddenSinceRef.current = null;
        }

        function handleVisibilityChange() {
            if (document.visibilityState === 'hidden') {
                recordHidden();
            } else if (document.visibilityState === 'visible') {
                handleVisible();
            }
        }

        function handlePageShow() {
            handleVisible();
        }

        function handlePageHide() {
            recordHidden();
        }

        const handleResume: EventListener = () => {
            handleVisible();
        };
        const handleFreeze: EventListener = () => {
            recordHidden();
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('pageshow', handlePageShow);
        window.addEventListener('pagehide', handlePageHide);
        const supportsResume = 'onresume' in document;
        const supportsFreeze = 'onfreeze' in document;
        if (supportsResume) {
            document.addEventListener('resume', handleResume);
        }
        if (supportsFreeze) {
            document.addEventListener('freeze', handleFreeze);
        }

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('pageshow', handlePageShow);
            window.removeEventListener('pagehide', handlePageHide);
            if (supportsResume) {
                document.removeEventListener('resume', handleResume);
            }
            if (supportsFreeze) {
                document.removeEventListener('freeze', handleFreeze);
            }
        };
    }, [publish.status, translatorApi]);

    useEffect(() => {
        if (publish.status !== 'live') {
            return undefined;
        }

        // Tap the graph's post-gain output so the meter reflects the level
        // listeners actually receive (the published destination feed). Fall back to
        // the raw source stream if the graph is somehow absent.
        const stream = graphRef.current?.getMeterSource() ?? mediaStreamRef.current;
        if (!stream) {
            return undefined;
        }

        const meter = createAudioMeter(stream);
        if (!meter) {
            return undefined;
        }

        const { streamId, publishSessionId } = publish;
        let lowSamples = 0;
        // reportedActive starts null so the first meter tick reports the true
        // current state (active or silent) rather than defaulting to Live.
        let reportedActive: boolean | null = null;
        let lastReportAt = 0;

        function sendActivity(active: boolean) {
            reportedActive = active;
            lastReportAt = Date.now();
            // Report transitions and periodic active heartbeats; meter ticks alone do
            // not produce duplicate reports.
            void translatorApi.audioActivity(streamId, publishSessionId, active).catch(() => {});
        }

        const handle = setInterval(() => {
            const level = Math.max(0, Math.min(1, meter.getLevel()));
            setMeterLevel(level);
            const hasAudio = level >= SILENT_LEVEL_THRESHOLD;
            if (hasAudio) {
                lowSamples = 0;
                setSilent(false);
            } else {
                lowSamples += 1;
                if (lowSamples >= silentWarningSampleThreshold) {
                    setSilent(true);
                }
            }

            // Listeners derive the live/silent badge from these reports, so the
            // falling edge is debounced (slow-release): once active, a brief pause
            // between words keeps reporting active so listeners don't flip to "silent"
            // mid-sentence. The rising edge is immediate (fast-attack). A session that
            // never had audio — or has gone quiet past the threshold — reports
            // inactive rather than fabricating an active state on cold-start silence.
            const active =
                !mutedRef.current &&
                (hasAudio || (reportedActive === true && lowSamples < silentSampleThreshold));
            const now = Date.now();
            if (reportedActive !== active) {
                sendActivity(active);
            } else if (active && now - lastReportAt >= audioActivityReportMs) {
                sendActivity(true);
            }
        }, meterPollMs);

        return () => {
            clearInterval(handle);
            meter.close();
            setSilent(false);
            setMeterLevel(0);
            if (reportedActive === true) {
                void translatorApi.audioActivity(streamId, publishSessionId, false).catch(() => {});
            }
        };
    }, [
        publish,
        createAudioMeter,
        meterPollMs,
        silentSampleThreshold,
        silentWarningSampleThreshold,
        translatorApi,
        audioActivityReportMs,
    ]);

    useEffect(() => {
        if (publish.status !== 'live') {
            return undefined;
        }

        // Heartbeat runs purely on a timer while live -- never gated on speaking or
        // local audio level -- so a silent-but-connected publisher keeps its bounded
        // server-side TTL alive. Cleared on stop/leave/unmount via the effect return.
        const { streamId, publishSessionId } = publish;
        const heartbeatSessionId = publishSessionId;
        const handle = setInterval(() => {
            const heartbeatId = ++heartbeatSeqRef.current;
            void translatorApi
                .heartbeat(streamId, heartbeatSessionId)
                .then(() => {
                    if (heartbeatSeqRef.current !== heartbeatId) {
                        return;
                    }
                    // Healthy heartbeat: re-arm recovery so `recoveryExhausted` never
                    // outlives `stale` and a later recoverable drop isn't mis-escalated.
                    setStale(false);
                    setRecoveryExhausted(false);
                    recoveryAttemptRef.current = 0;
                })
                .catch((error: unknown) => {
                    if (heartbeatSeqRef.current !== heartbeatId) {
                        return;
                    }

                    if (livePublishRef.current?.publishSessionId !== heartbeatSessionId) {
                        return;
                    }

                    if (
                        error instanceof ApiError &&
                        (error.code === 'publisher_not_active' ||
                            error.code === 'translator_auth_required')
                    ) {
                        setEndedMessage('Your broadcast was ended.');
                        if (publish.status === 'live') {
                            void stopWithoutServerCleanup();
                        }

                        if (error.code === 'translator_auth_required') {
                            returnToLogin();
                        }

                        return;
                    }

                    setStale(true);
                });
        }, publisherHeartbeatMs);

        return () => {
            clearInterval(handle);
        };
    }, [publish, translatorApi, publisherHeartbeatMs]);

    useEffect(() => {
        if (publish.status !== 'live') {
            return undefined;
        }

        const startedAt = liveStartedAtRef.current ?? Date.now();
        const handle = setInterval(() => {
            const nextElapsedMs = Date.now() - startedAt;
            setElapsedMs(nextElapsedMs);
            setElapsedLabel(formatElapsedLabel(nextElapsedMs));
        }, 1_000);

        return () => {
            clearInterval(handle);
        };
    }, [publish]);

    async function submitLogin(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setLoginError(null);
        try {
            const response = await translatorApi.login(
                programSlug,
                loginEmail.trim(),
                loginPassword,
            );
            setLoginPassword('');
            applySession(response.translator, response.assignedStreams);
        } catch (error) {
            setLoginError(
                error instanceof ApiError && error.code === 'program_not_found'
                    ? 'This program does not exist.'
                    : error instanceof ApiError && error.code === 'invalid_translator_credentials'
                      ? 'Invalid email or password.'
                      : 'Login failed. Please try again.',
            );
        }
    }

    async function handleGoLive() {
        if (!selectedStreamId || isBusy(publish)) {
            return;
        }
        setSilent(false);
        setMuted(false);
        setPublish({ status: 'connecting' });

        let track: MediaStreamTrack;
        try {
            track = await acquireMicTrack();
        } catch (_error) {
            setPublish({
                status: 'error',
                message: messageForMicAccess(),
            });
            return;
        }

        try {
            const session = await realtimeClient.publish({
                streamId: selectedStreamId,
                track,
                reclaim: true,
            });
            onLive(session);
        } catch (error) {
            onPublishFailure(error);
        }
    }

    async function handleReconnect() {
        // Single in-flight latch shared by manual reconnect and auto-recovery so a
        // coincident transport-failure + button press never double-publishes.
        if (recoveryInFlightRef.current) {
            return;
        }
        const live = publish.status === 'live' ? publish : null;
        const streamId = live ? live.streamId : selectedStreamId;
        if (!streamId) {
            return;
        }
        recoveryInFlightRef.current = true;
        recoveryWasActiveRef.current = true;
        setSilent(false);
        setMuted(false);
        setPublish({ status: 'reconnecting' });

        let track: MediaStreamTrack;
        try {
            track = await acquireMicTrack();
        } catch (_error) {
            recoveryInFlightRef.current = false;
            setPublish({
                status: 'error',
                message: messageForMicAccess(),
            });
            return;
        }

        try {
            const session = live
                ? await realtimeClient.reconnect({
                      publishSessionId: live.publishSessionId,
                      streamId,
                      track,
                  })
                : await realtimeClient.publish({ streamId, track, reclaim: true });
            onLive(session);
        } catch (error) {
            onPublishFailure(error);
        } finally {
            recoveryInFlightRef.current = false;
        }
    }

    function handleMute(nextMuted: boolean) {
        const track = activeTrackRef.current;
        if (!track) {
            return;
        }
        realtimeClient.mute({ track, muted: nextMuted });
        setMuted(nextMuted);
    }

    async function handleStop() {
        const live = await stopWithoutServerCleanup();

        if (live) {
            try {
                await realtimeClient.stop({ publishSessionId: live.publishSessionId });
            } catch (_error) {
                // Backend cleanup is best-effort; local media is already released.
            }
        }
    }

    async function stopWithoutServerCleanup() {
        const live = publish.status === 'live' ? publish : null;
        if (live) {
            try {
                await translatorApi.audioActivity(live.streamId, live.publishSessionId, false);
            } catch (_error) {
                // Stopping local media and provider cleanup should continue even if the
                // best-effort inactive report is rejected or races with another report.
            }
        }

        setSilent(false);
        setMuted(false);
        heartbeatSeqRef.current += 1;
        setStale(false);
        setElapsedMs(0);
        setElapsedLabel(formatElapsedLabel(0));
        liveStartedAtRef.current = null;
        setPublish({ status: 'stopped' });
        // Stop is user-intent: cancel any pending/auto recovery so we don't republish.
        livePublishRef.current = null;
        recoveryAttemptRef.current = 0;
        clearRecoveryTimer();
        stopMediaTracks();
        activeTrackRef.current = null;

        return live;
    }

    function clearRecoveryTimer() {
        if (recoveryTimerRef.current !== null) {
            clearTimeout(recoveryTimerRef.current);
            recoveryTimerRef.current = null;
        }
    }

    // Only reached for a TERMINAL disconnect (LiveKit gave up, or the token
    // expired) -- a transient drop is LiveKit's own Reconnecting/Reconnected pair
    // and never schedules anything here. First attempt fires immediately;
    // subsequent attempts back off exponentially, capped by recoveryMaxMs/
    // recoveryMaxAttempts so a persistently-down publisher never spins.
    function scheduleRecovery() {
        if (recoveryInFlightRef.current || recoveryTimerRef.current !== null) {
            return;
        }
        if (recoveryAttemptRef.current >= recoveryMaxAttempts) {
            setRecoveryExhausted(true);
            return;
        }
        const backoff = Math.min(recoveryBaseMs * 2 ** recoveryAttemptRef.current, recoveryMaxMs);
        const wait = recoveryAttemptRef.current === 0 ? 0 : backoff;
        recoveryTimerRef.current = setTimeout(() => {
            recoveryTimerRef.current = null;
            if (!livePublishRef.current || recoveryInFlightRef.current) {
                return;
            }
            recoveryAttemptRef.current += 1;
            void handleReconnectRef.current();
        }, wait);
    }

    // Transport-state handler: maps LiveKit's own Room events onto the three
    // UI-facing states. "reconnecting"/"reconnected" are LiveKit's own transient
    // self-heal (ICE restart / signal resume) -- just reflect them in the UI, no
    // manual timer needed. A terminal "disconnected" means LiveKit gave up (or
    // the token's 1h TTL expired), which is the one case that still needs an
    // app-level action: schedule a bounded, backed-off republish.
    const handleTransportState: TranslatorConnectionStateHandler = (publishSessionId, state) => {
        const live = livePublishRef.current;
        if (!live || publishSessionId !== live.publishSessionId) {
            return; // stale event / not the current live session
        }
        if (state === 'reconnected') {
            const wasRecovering = stale || recoveryExhausted;
            setStale(false);
            setRecoveryExhausted(false);
            if (wasRecovering) {
                setJustRecovered(true);
            }
            recoveryAttemptRef.current = 0;
            clearRecoveryTimer();
            return;
        }
        if (state === 'reconnecting') {
            setStale(true);
            return;
        }
        if (state === 'disconnected') {
            setStale(true);
            scheduleRecovery();
        }
    };
    connectionStateHandlerRef.current = handleTransportState;
    handleReconnectRef.current = handleReconnect;
    ensureMicPermissionAndEnumerateRef.current = ensureMicPermissionAndEnumerate;

    // Mirror the current live session into a ref (so the handler can drop stale
    // events) and reset recovery bookkeeping once we're live again.
    useEffect(() => {
        if (publish.status === 'live') {
            setStale(false);
            setRecoveryExhausted(false);
            // Confirm on the primary republish path: if a reconnect was in progress,
            // flash "Reconnected" as the new session goes live (the transport
            // 'connected' handler covers the same-PC ICE self-heal path).
            if (recoveryWasActiveRef.current) {
                setJustRecovered(true);
                recoveryWasActiveRef.current = false;
            } else {
                setJustRecovered(false);
            }
            setMeterLevel(0);
            livePublishRef.current = {
                publishSessionId: publish.publishSessionId,
                streamId: publish.streamId,
            };
            recoveryAttemptRef.current = 0;
            clearRecoveryTimer();
        } else if (
            publish.status === 'ready' ||
            publish.status === 'stopped' ||
            publish.status === 'error'
        ) {
            livePublishRef.current = null;
            setStale(false);
            clearRecoveryTimer();
        }
        // "connecting"/"reconnecting" are transitional — leave refs as-is.
    }, [publish]);

    useEffect(() => {
        if (!justRecovered) {
            return undefined;
        }

        const handle = setTimeout(() => setJustRecovered(false), 3_000);
        return () => clearTimeout(handle);
    }, [justRecovered]);

    useEffect(() => {
        onRealtimeHandlerReady?.((publishSessionId, state) =>
            connectionStateHandlerRef.current(publishSessionId, state),
        );
    }, [onRealtimeHandlerReady]);

    useEffect(() => {
        onAudioControlsReady?.({
            ensureMicPermissionAndEnumerate: () => ensureMicPermissionAndEnumerateRef.current(),
        });
    }, [onAudioControlsReady]);

    useEffect(() => {
        return () => {
            clearRecoveryTimer();
        };
    }, []);

    return (
        <main aria-label="Translator shell" className="shell shell-translator">
            <section className="translator-screen">
                {auth.status === 'checking' ? (
                    <p className="translator-checking">Checking translator access...</p>
                ) : null}

                {auth.status === 'programMissing' ? (
                    <p className="lp-info" role="status">
                        This program does not exist.
                    </p>
                ) : null}

                {auth.status === 'loggedOut' ? (
                    <>
                        {endedMessage ? (
                            <p className="translator-ended-message" role="status">
                                {endedMessage}
                            </p>
                        ) : null}
                        <div className="translator-login-head">
                            {/* Program eyebrow: we only have the slug pre-session. .eyebrow CSS
                  uppercases it for display; the textContent stays the raw slug. */}
                            <p className="eyebrow">{programSlug}</p>
                            <h1>Live translation</h1>
                        </div>
                        <form className="translator-login" onSubmit={submitLogin}>
                            <h2>Translator login</h2>
                            {loginError ? (
                                <p className="translator-alert" role="alert">
                                    {loginError}
                                </p>
                            ) : null}
                            <label>
                                Email
                                <input
                                    autoComplete="username"
                                    onChange={(event) => setLoginEmail(event.target.value)}
                                    required
                                    type="email"
                                    value={loginEmail}
                                />
                            </label>
                            <label>
                                Password
                                <input
                                    autoComplete="current-password"
                                    onChange={(event) => setLoginPassword(event.target.value)}
                                    type="password"
                                    value={loginPassword}
                                />
                            </label>
                            <button className="lp-btn" type="submit">
                                Log in
                            </button>
                        </form>
                    </>
                ) : null}

                {auth.status === 'loggedIn' ? (
                    <PublishPanel
                        assignedStreams={auth.assignedStreams}
                        muted={muted}
                        onGoLive={() => void handleGoLive()}
                        onMute={handleMute}
                        onReconnect={() => void handleReconnect()}
                        onSelectStream={setSelectedStreamId}
                        onSignOut={() => void handleSignOut()}
                        onStop={() => void handleStop()}
                        programSlug={programSlug}
                        publish={publish}
                        selectedStreamId={selectedStreamId}
                        silent={silent}
                        stale={stale}
                        recoveryExhausted={recoveryExhausted}
                        justRecovered={justRecovered}
                        meterLevel={meterLevel}
                        elapsedMs={elapsedMs}
                        elapsedLabel={elapsedLabel}
                        translator={auth.translator}
                        endedMessage={endedMessage}
                        audioSheetOpen={audioSheetOpen}
                        onOpenAudioSheet={openAudioSheet}
                        onCloseAudioSheet={closeAudioSheet}
                        audioInputs={audioInputs}
                        selectedMicId={selectedMicId}
                        onSelectMic={handleSelectMic}
                        gainValue={gainValue}
                        onGainChange={handleGainChange}
                        audioToggles={audioToggles}
                        onToggleAudio={handleToggleAudio}
                    />
                ) : null}
            </section>
        </main>
    );
}

function PublishPanel({
    assignedStreams,
    muted,
    onSignOut,
    onGoLive,
    onMute,
    onReconnect,
    onSelectStream,
    programSlug,
    onStop,
    publish,
    selectedStreamId,
    elapsedMs,
    silent,
    stale,
    recoveryExhausted,
    justRecovered,
    meterLevel,
    elapsedLabel,
    translator,
    endedMessage,
    audioSheetOpen,
    onOpenAudioSheet,
    onCloseAudioSheet,
    audioInputs,
    selectedMicId,
    onSelectMic,
    gainValue,
    onGainChange,
    audioToggles,
    onToggleAudio,
}: {
    assignedStreams: AssignedStream[];
    muted: boolean;
    onSignOut: () => void;
    onGoLive: () => void;
    onMute: (muted: boolean) => void;
    onReconnect: () => void;
    onSelectStream: (streamId: string) => void;
    programSlug: string;
    onStop: () => void;
    publish: PublishState;
    selectedStreamId: string;
    elapsedMs: number;
    silent: boolean;
    stale: boolean;
    recoveryExhausted: boolean;
    justRecovered: boolean;
    meterLevel: number;
    elapsedLabel: string;
    translator: TranslatorInfo;
    endedMessage: string | null;
    audioSheetOpen: boolean;
    onOpenAudioSheet: () => void;
    onCloseAudioSheet: () => void;
    audioInputs: AudioInputDevice[];
    selectedMicId: string | null;
    onSelectMic: (deviceId: string | null) => void;
    gainValue: number;
    onGainChange: (value: number) => void;
    audioToggles: AudioToggles;
    onToggleAudio: (key: keyof AudioToggles, value: boolean) => void;
}) {
    const selectedStream =
        assignedStreams.length > 0
            ? (assignedStreams.find((stream) => stream.id === selectedStreamId) ??
              assignedStreams[0]!)
            : null;

    return (
        <div className="translator-panel">
            <header className="console-header">
                <div className="console-header-id">
                    <p className="translator-name">{translator.name}</p>
                    <p className="translator-slug">{programSlug}</p>
                </div>
                <button type="button" className="console-signout" onClick={onSignOut}>
                    Sign out
                </button>
            </header>

            {assignedStreams.length === 0 ? (
                <p className="translator-empty">No language assigned. Contact the event admin.</p>
            ) : (
                <div className="assigned-card">
                    <p className="assigned-card-eyebrow">YOUR LANGUAGE</p>
                    <p className="assigned-native">{selectedStream?.nativeName}</p>
                    <p className="assigned-english">{selectedStream?.languageName}</p>
                    {assignedStreams.length > 1 ? (
                        <div className="assigned-card-select">
                            <label>
                                Language stream
                                <select
                                    value={selectedStreamId}
                                    disabled={isBusy(publish)}
                                    onChange={(event) => onSelectStream(event.target.value)}
                                >
                                    {assignedStreams.map((s) => (
                                        <option key={s.id} value={s.id}>
                                            {s.nativeName} — {s.languageName}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        </div>
                    ) : null}
                </div>
            )}

            <PublishStatus
                elapsedLabel={elapsedLabel}
                elapsedMs={elapsedMs}
                muted={muted}
                publish={publish}
                silent={silent}
                stale={stale}
                recoveryExhausted={recoveryExhausted}
                justRecovered={justRecovered}
                endedMessage={endedMessage}
            />

            {publish.status === 'live' ? (
                <MeterCard meterLevel={meterLevel} muted={muted || silent} />
            ) : null}

            <div className="translator-spacer" />

            <div className="translator-actions">
                <PublishControls
                    assignedCount={assignedStreams.length}
                    muted={muted}
                    stale={stale}
                    onGoLive={onGoLive}
                    onMute={onMute}
                    onReconnect={onReconnect}
                    onStop={onStop}
                    publish={publish}
                    selectedStreamId={selectedStreamId}
                    onOpenAudioSheet={onOpenAudioSheet}
                />
                <p className="translator-mic-note">Microphone only. Camera is never used.</p>
            </div>

            {audioSheetOpen ? (
                <AudioSettingsSheet
                    audioInputs={audioInputs}
                    selectedMicId={selectedMicId}
                    onSelectMic={onSelectMic}
                    gainValue={gainValue}
                    onGainChange={onGainChange}
                    audioToggles={audioToggles}
                    onToggleAudio={onToggleAudio}
                    onClose={onCloseAudioSheet}
                />
            ) : null}
        </div>
    );
}

// Full-width secondary trigger that opens the Audio Settings sheet. Same button
// on Ready (below Go live) and Live (above the Mute/Reconnect row).
function AudioSettingsTrigger({ onClick }: { onClick: () => void }) {
    return (
        <button type="button" className="audio-settings-btn" onClick={onClick}>
            <SlidersIcon />
            Audio Settings
        </button>
    );
}

// lucide "sliders-horizontal" glyph rendered inline (no extra dependency).
function SlidersIcon() {
    return (
        <svg
            aria-hidden="true"
            className="audio-settings-btn-icon"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <line x1="21" x2="14" y1="4" y2="4" />
            <line x1="10" x2="3" y1="4" y2="4" />
            <line x1="21" x2="12" y1="12" y2="12" />
            <line x1="8" x2="3" y1="12" y2="12" />
            <line x1="21" x2="16" y1="20" y2="20" />
            <line x1="12" x2="3" y1="20" y2="20" />
            <line x1="14" x2="14" y1="2" y2="6" />
            <line x1="8" x2="8" y1="10" y2="14" />
            <line x1="16" x2="16" y1="18" y2="22" />
        </svg>
    );
}

// The processing toggles, in display order. Each maps a switch row to an
// AudioToggles key. Labels match the design ("Remove echo" etc.), not the raw
// constraint names.
const AUDIO_TOGGLE_ROWS: Array<{ key: keyof AudioToggles; label: string }> = [
    { key: 'echoCancellation', label: 'Remove echo' },
    { key: 'noiseSuppression', label: 'Reduce background noise' },
    { key: 'autoGainControl', label: 'Automatically adjust volume' },
];

// Partial bottom sheet: rounded top corners, square bottom, dim backdrop. Holds
// the mic picker, the live volume slider, and the processing toggles. Dismissed
// via close-X / backdrop tap / Escape; focus is trapped while open. Rendered
// only while open, so the ON AIR pill + level meter above it stay mounted and
// the meter keeps polling.
function AudioSettingsSheet({
    audioInputs,
    selectedMicId,
    onSelectMic,
    gainValue,
    onGainChange,
    audioToggles,
    onToggleAudio,
    onClose,
}: {
    audioInputs: AudioInputDevice[];
    selectedMicId: string | null;
    onSelectMic: (deviceId: string | null) => void;
    gainValue: number;
    onGainChange: (value: number) => void;
    audioToggles: AudioToggles;
    onToggleAudio: (key: keyof AudioToggles, value: boolean) => void;
    onClose: () => void;
}) {
    const titleId = 'audio-settings-title';
    const dialogRef = useRef<HTMLDivElement | null>(null);
    // The element that had focus when the sheet opened (the "Audio Settings"
    // trigger). Captured on open and re-focused on close/unmount so keyboard
    // users don't get dropped to <body> when the sheet is dismissed.
    const triggerRef = useRef<HTMLElement | null>(null);
    const showMicSelect = audioInputs.length > 1;
    const gainPercent = Math.round(gainValue * 100);
    // AGC fights a manual boost: when boosting above unity with auto-gain on,
    // surface the note (the published level is being normalised by the browser).
    const showAgcNote = gainValue > 1 && audioToggles.autoGainControl;

    // Move focus into the sheet on open so keyboard users land inside the trap,
    // and restore focus to the triggering element on close/unmount so dismissal
    // (Escape / backdrop / close-X) doesn't drop focus to <body>.
    useEffect(() => {
        triggerRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const dialog = dialogRef.current;
        if (!dialog) {
            return;
        }
        const focusables = Array.from(
            dialog.querySelectorAll<HTMLElement>(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            ),
        ).filter((el) => !el.hasAttribute('disabled'));
        (focusables[0] ?? dialog).focus();
        return () => {
            triggerRef.current?.focus();
        };
    }, []);

    // Escape closes; Tab/Shift+Tab wrap focus inside the sheet (focus trap).
    function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
        if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
            return;
        }
        if (event.key !== 'Tab') {
            return;
        }
        const dialog = dialogRef.current;
        if (!dialog) {
            return;
        }
        const focusables = Array.from(
            dialog.querySelectorAll<HTMLElement>(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            ),
        ).filter((el) => !el.hasAttribute('disabled'));
        if (focusables.length === 0) {
            return;
        }
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const activeEl = document.activeElement;
        if (event.shiftKey && activeEl === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && activeEl === last) {
            event.preventDefault();
            first.focus();
        }
    }

    return (
        <div>
            <div
                className="audio-sheet-backdrop"
                data-testid="audio-sheet-backdrop"
                onClick={onClose}
            />
            <div
                ref={dialogRef}
                className="audio-sheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                onKeyDown={handleKeyDown}
            >
                <div className="audio-sheet-handle" aria-hidden="true" />
                <header className="audio-sheet-header">
                    <h2 id={titleId} className="audio-sheet-title">
                        Audio Settings
                    </h2>
                    <button
                        type="button"
                        className="audio-sheet-close"
                        aria-label="Close audio settings"
                        onClick={onClose}
                    >
                        <span aria-hidden="true">✕</span>
                    </button>
                </header>

                {showMicSelect ? (
                    <section className="audio-sheet-section">
                        <label className="audio-sheet-field">
                            <span className="audio-sheet-section-label">MICROPHONE</span>
                            <select
                                className="audio-sheet-select"
                                aria-label="Microphone"
                                value={selectedMicId ?? ''}
                                onChange={(event) =>
                                    onSelectMic(
                                        event.target.value === '' ? null : event.target.value,
                                    )
                                }
                            >
                                {audioInputs.map((device) => (
                                    <option key={device.deviceId} value={device.deviceId}>
                                        {device.label || 'Microphone'}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </section>
                ) : null}

                <section className="audio-sheet-section">
                    <div className="audio-sheet-volume-head">
                        <span className="audio-sheet-section-label">MIC VOLUME</span>
                        <span className="audio-sheet-volume-value">{gainPercent}%</span>
                    </div>
                    <input
                        className="audio-sheet-range"
                        type="range"
                        min={0}
                        max={2}
                        step={0.05}
                        value={gainValue}
                        aria-label="Mic volume"
                        aria-valuenow={gainValue}
                        aria-valuetext={`${gainPercent}%`}
                        onChange={(event) => onGainChange(Number(event.target.value))}
                    />
                </section>

                <section className="audio-sheet-section">
                    <span className="audio-sheet-section-label">PROCESSING</span>
                    <ul className="audio-sheet-toggles">
                        {AUDIO_TOGGLE_ROWS.map((row) => {
                            const checked = audioToggles[row.key];
                            return (
                                <li key={row.key} className="audio-sheet-toggle-row">
                                    <span
                                        className="audio-sheet-toggle-label"
                                        id={`toggle-${row.key}`}
                                    >
                                        {row.label}
                                    </span>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={checked}
                                        aria-labelledby={`toggle-${row.key}`}
                                        className={`audio-sheet-switch${
                                            checked ? ' audio-sheet-switch--on' : ''
                                        }`}
                                        onClick={() => onToggleAudio(row.key, !checked)}
                                    >
                                        <span
                                            className="audio-sheet-switch-knob"
                                            aria-hidden="true"
                                        />
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                </section>

                {showAgcNote ? (
                    <p className="audio-sheet-note">
                        “Automatically adjust volume” overrides the slider above.
                    </p>
                ) : null}
            </div>
        </div>
    );
}

function PublishStatus({
    elapsedLabel,
    elapsedMs,
    muted,
    publish,
    silent,
    stale,
    recoveryExhausted,
    justRecovered,
    endedMessage,
}: {
    elapsedLabel: string;
    elapsedMs: number;
    muted: boolean;
    publish: PublishState;
    silent: boolean;
    stale: boolean;
    recoveryExhausted: boolean;
    justRecovered: boolean;
    endedMessage: string | null;
}) {
    if (endedMessage) {
        return (
            <p className="translator-ended-message" role="status">
                {endedMessage}
            </p>
        );
    }

    if (publish.status === 'live') {
        if (stale && !recoveryExhausted) {
            return (
                <div className="translator-connection-banner" role="status">
                    <div className="translator-connection-banner-header">
                        <span aria-hidden="true" className="translator-connection-banner-spinner" />
                        <p className="translator-connection-banner-title">Reconnecting…</p>
                    </div>
                    <p className="translator-connection-banner-subtitle">
                        Your audio will resume automatically.
                    </p>
                </div>
            );
        }

        if (stale && recoveryExhausted) {
            return (
                <div className="translator-reconnect-banner" role="alert">
                    <span aria-hidden="true" className="translator-reconnect-banner-icon">
                        ⚠
                    </span>
                    <p>Lost connection — tap Reconnect</p>
                </div>
            );
        }

        return (
            <>
                <div
                    className="translator-on-air-pill"
                    aria-live="polite"
                    data-elapsed-ms={elapsedMs}
                >
                    <span className="translator-on-air-pill-left">
                        <span className="translator-live-dot" aria-hidden="true" />
                        <strong>ON AIR</strong>
                    </span>
                    <span className="translator-on-air-pill-right">{elapsedLabel}</span>
                </div>

                {justRecovered ? (
                    <p className="translator-reconnected-pill" role="status">
                        Reconnected — audio resumed
                    </p>
                ) : null}

                {muted ? (
                    <p className="translator-muted-pill" role="status">
                        <span aria-hidden="true" className="translator-muted-pill-icon">
                            🎤
                        </span>
                        MUTED
                    </p>
                ) : null}

                {silent ? (
                    <p className="translator-silent-banner" role="status">
                        No audio detected.
                    </p>
                ) : null}
            </>
        );
    }

    if (publish.status === 'connecting') {
        return (
            <div className="translator-connection-banner" role="status">
                <div className="translator-connection-banner-header">
                    <span aria-hidden="true" className="translator-connection-banner-spinner" />
                    <p className="translator-connection-banner-title">Connecting…</p>
                </div>
                <p className="translator-connection-banner-subtitle">Setting up your microphone…</p>
            </div>
        );
    }

    if (publish.status === 'reconnecting') {
        return (
            <div className="translator-connection-banner" role="status">
                <div className="translator-connection-banner-header">
                    <span aria-hidden="true" className="translator-connection-banner-spinner" />
                    <p className="translator-connection-banner-title">Reconnecting…</p>
                </div>
                <p className="translator-connection-banner-subtitle">Re-establishing your audio…</p>
            </div>
        );
    }

    if (publish.status === 'stopped') {
        return (
            <p className="translator-stopped-state-card">
                <span aria-hidden="true" className="translator-stopped-state-icon">
                    ■
                </span>
                Stopped
            </p>
        );
    }

    if (publish.status === 'error') {
        return (
            <>
                <div className="translator-error-banner" role="alert">
                    <span aria-hidden="true" className="translator-error-banner-icon">
                        ⚠
                    </span>
                    <div className="translator-error-banner-content">
                        <p className="translator-error-banner-title">{publish.message.title}</p>
                        <p className="translator-error-banner-detail">{publish.message.detail}</p>
                    </div>
                </div>
                <p className="translator-status translator-status--muted">
                    {statusLabel(publish, muted)}
                </p>
            </>
        );
    }

    return <p className="translator-status">{statusLabel(publish, muted)}</p>;
}

function MeterCard({ meterLevel, muted }: { meterLevel: number; muted: boolean }) {
    const filled = levelToFilledSegments(meterLevel);

    return (
        <section
            className={`translator-meter-card${muted ? ' translator-meter-card--dimmed' : ''}`}
        >
            <p className="translator-meter-eyebrow">MICROPHONE LEVEL</p>
            <div className="translator-meter-bars" role="img" aria-label="Microphone level">
                {Array.from({ length: METER_SEGMENTS }, (_, index) => {
                    const zone = getMeterZone(index);
                    return (
                        <span
                            key={index}
                            className={`translator-meter-seg translator-meter-seg--${zone}${
                                index < filled ? ' translator-meter-seg--filled' : ''
                            }`}
                        />
                    );
                })}
            </div>
        </section>
    );
}

function PublishControls({
    assignedCount,
    muted,
    stale,
    onGoLive,
    onMute,
    onReconnect,
    onStop,
    publish,
    selectedStreamId,
    onOpenAudioSheet,
}: {
    assignedCount: number;
    muted: boolean;
    stale: boolean;
    onGoLive: () => void;
    onMute: (muted: boolean) => void;
    onReconnect: () => void;
    onStop: () => void;
    publish: PublishState;
    selectedStreamId: string;
    onOpenAudioSheet: () => void;
}) {
    if (publish.status === 'live') {
        return (
            <div className="translator-actions translator-live-actions">
                {/* Live: Audio Settings sits above the Mute/Reconnect row. */}
                <AudioSettingsTrigger onClick={onOpenAudioSheet} />
                <div className="translator-live-button-row">
                    <button
                        className={`translator-control-btn translator-control-btn--mute${
                            muted ? ' translator-control-btn--unmute' : ''
                        }`}
                        onClick={() => onMute(!muted)}
                        type="button"
                    >
                        <span aria-hidden="true" className="translator-live-icon">
                            🎤
                        </span>
                        {muted ? 'Unmute' : 'Mute'}
                    </button>
                    <button
                        className={`translator-control-btn translator-control-btn--reconnect${
                            stale ? ' translator-control-btn--reconnect-stale' : ''
                        }`}
                        onClick={onReconnect}
                        type="button"
                    >
                        <span aria-hidden="true" className="translator-live-icon">
                            ↺
                        </span>
                        Reconnect
                    </button>
                </div>
                <button
                    className="translator-control-btn translator-control-btn--stop"
                    onClick={onStop}
                    type="button"
                >
                    Stop
                </button>
            </div>
        );
    }

    if (publish.status === 'connecting' || publish.status === 'reconnecting') {
        return null;
    }

    const showReconnect = publish.status === 'stopped' || publish.status === 'error';

    return (
        <div className="translator-actions">
            <button
                className="lp-btn"
                disabled={assignedCount === 0 || !selectedStreamId}
                onClick={onGoLive}
                type="button"
            >
                <span className="translator-go-live-icon" aria-hidden="true">
                    🎤
                </span>
                Go live
            </button>
            {/* Ready: Audio Settings sits below Go live. */}
            <AudioSettingsTrigger onClick={onOpenAudioSheet} />
            {showReconnect ? (
                <button
                    className="translator-control-btn translator-control-btn--reconnect"
                    onClick={onReconnect}
                    type="button"
                >
                    Reconnect
                </button>
            ) : null}
        </div>
    );
}

function statusLabel(publish: PublishState, muted: boolean): string {
    switch (publish.status) {
        case 'ready':
            return 'Ready to go live.';
        case 'connecting':
            return 'Connecting…';
        case 'live':
            return muted ? 'Muted.' : 'You are live.';
        case 'reconnecting':
            return 'Reconnecting…';
        case 'stopped':
            return 'Stopped';
        case 'error':
            return 'Not live.';
    }
}

function formatElapsedLabel(ms: number) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function isBusy(publish: PublishState): boolean {
    return (
        publish.status === 'connecting' ||
        publish.status === 'reconnecting' ||
        publish.status === 'live'
    );
}

function messageForMicAccess(): PublishErrorMessage {
    return {
        title: 'Microphone access is required to go live.',
        detail: "Check your browser's microphone permission and try again.",
    };
}

function messageForPublishError(error: unknown): PublishErrorMessage {
    if (error instanceof ApiError) {
        if (error.code === 'stream_already_published') {
            return {
                title: 'This language is already being published.',
                detail: 'Another device may be publishing it. Try reconnecting.',
            };
        }
        if (error.code === 'stream_not_assigned') {
            return {
                title: 'You are not assigned to this language.',
                detail: 'Ask the event admin to assign it.',
            };
        }
        if (error.code === 'realtime_error') {
            return {
                title: 'Realtime connection failed.',
                detail: 'Try reconnecting.',
            };
        }
    }

    return {
        title: 'Could not go live.',
        detail: 'Try reconnecting.',
    };
}

// Default Web Audio publish graph: source mic stream ──▶ GainNode ──▶
// MediaStreamAudioDestinationNode. The destination's audio track is published
// ONCE and never replaced; swapSource only re-wires the upstream source into
// the same gain node, and setGain only changes gain.value — so a live mic /
// toggle / volume change never alters the published track. Mirrors VDO.Ninja's
// audioGain graph.
//
// Uses a real AudioContext (absent in jsdom) — unit tests inject a double via
// the createPublishGraph prop, so this default is never called under test.
function createDefaultPublishGraph(stream: MediaStream): TranslatorPublishGraph {
    const AudioContextCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    const context = new AudioContextCtor();
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    gain.connect(destination);

    let source: MediaStreamAudioSourceNode = context.createMediaStreamSource(stream);
    source.connect(gain);

    const publishedTrack = destination.stream.getAudioTracks()[0];
    if (!publishedTrack) {
        throw new Error('no_audio_track');
    }

    return {
        publishedTrack,
        setGain(value: number) {
            gain.gain.value = value;
        },
        swapSource(nextStream: MediaStream) {
            try {
                source.disconnect();
            } catch (_error) {
                // Already disconnected — ignore.
            }
            source = context.createMediaStreamSource(nextStream);
            source.connect(gain);
        },
        getMeterSource() {
            // The destination stream carries the post-gain (published) audio.
            return destination.stream;
        },
        resume() {
            if (context.state === 'suspended') {
                void context.resume().catch(() => {});
            }
        },
        destroy() {
            try {
                source.disconnect();
                gain.disconnect();
            } catch (_error) {
                // Ignore teardown errors on already-disconnected nodes.
            }
            void context.close().catch(() => {});
        },
    };
}

function createDefaultAudioMeter(stream: MediaStream): TranslatorAudioMeter | null {
    if (typeof window === 'undefined') {
        return null;
    }

    const AudioContextCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
        return null;
    }

    try {
        const context = new AudioContextCtor();
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        return {
            getLevel() {
                analyser.getByteTimeDomainData(data);
                let sumSquares = 0;
                for (const value of data) {
                    const centered = (value - 128) / 128;
                    sumSquares += centered * centered;
                }
                return Math.sqrt(sumSquares / data.length);
            },
            close() {
                try {
                    source.disconnect();
                    analyser.disconnect();
                    void context.close();
                } catch (_error) {
                    // Ignore teardown errors on already-closed contexts.
                }
            },
        };
    } catch (_error) {
        return null;
    }
}
