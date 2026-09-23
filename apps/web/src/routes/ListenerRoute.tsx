import { useEffect, useMemo, useRef, useState } from 'react';

import { ApiError } from '../api/client';
import {
    createListenerApi,
    type ListenerAccessClaim,
    type ListenerApi,
    type ListenerNotListenableReason,
    type ListenerPublicProgramMetadata,
    type ListenerPublicProgramStatus,
} from '../api/listeners';
import type { PublicApi, PublicLanguageStream } from '../api/public';
import {
    createListenerRealtimeClient,
    type ListenerRealtimeClient,
    type ListenerSession,
    type ListenerTransportState,
    type RoomHandle,
} from '../realtime/listenerClient';
import { detectInAppBrowser } from './inAppBrowser';
import { ListenerAccessGate } from './ListenerAccessGate';

type ListenerState =
    | { status: 'loading' }
    | {
          status: 'success';
          metadata: ListenerPublicProgramMetadata;
          snapshot: ListenerPublicProgramStatus | null;
          statusDegraded: boolean;
      }
    | { status: 'error' };

type ListenerAccessState =
    | { status: 'checking'; storageDegraded: boolean }
    | {
          status: 'error';
          claim?: ListenerAccessClaim;
          message: string;
          retrying: boolean;
          storageDegraded: boolean;
      }
    | { status: 'disabled'; storageDegraded: boolean }
    | {
          status: 'waiting';
          claim: ListenerAccessClaim;
          checking: boolean;
          message?: string;
          storageDegraded: boolean;
      }
    | { status: 'entering'; accessToken: string; storageDegraded: boolean }
    | { status: 'approved'; accessToken: string; storageDegraded: boolean };

type PlaybackState =
    | { status: 'idle' }
    | { status: 'connecting'; streamId: string }
    | {
          status: 'connected';
          streamId: string;
          connectionId: string;
          publisherVersion: string | null;
          // Set when the connection is live but the browser blocked autoplay (typically
          // iOS Safari without a fresh user gesture). The stream is attached and the
          // session is kept; a one-tap "enable sound" affordance starts playback.
          needsGesture?: boolean;
      }
    | { status: 'switching'; streamId: string; connectionId: string }
    | { status: 'reconnecting'; streamId: string; connectionId?: string }
    | {
          status: 'disconnected';
          streamId: string;
          connectionId?: string;
          errorCode?: ListenerPlaybackErrorCode;
      };

type ListenerPlaybackErrorCode =
    | 'stream_not_live'
    | 'listener_invalid_state'
    | 'realtime_error'
    | 'playback_failed'
    | 'connection_lost';

type ScreenWakeLockSentinel = {
    release(): Promise<void>;
};

type ScreenWakeLockNavigator = Navigator & {
    wakeLock?: {
        request(type: 'screen'): Promise<ScreenWakeLockSentinel>;
    };
};

type ReconnectOptions = {
    viaGesture?: boolean;
};

export type ConnectionStateHandler = (connectionId: string, state: ListenerTransportState) => void;

export interface ListenerRouteProps {
    programSlug: string;
    publicApi: PublicApi;
    listenerApi?: ListenerApi;
    realtimeClient?: ListenerRealtimeClient;
    // Test seam: threaded into createListenerRealtimeClient when no
    // `realtimeClient` override is given, so a test can exercise the REAL client
    // construction/wiring with a fake Room instead of also having to fake the
    // whole ListenerRealtimeClient interface. No-op in production (falls
    // through to `new Room()`).
    createRoom?: () => RoomHandle;
    heartbeatMs?: number;
    statusPollMs?: number;
    accessBroadcastPollMs?: number;
    accessSafetyPollMs?: number;
    accessApprovedDelayMs?: number;
    // Fast-recovery tuning (injectable for deterministic tests, like statusPollMs).
    recoveryBaseMs?: number;
    recoveryMaxMs?: number;
    recoveryMaxAttempts?: number;
    // Test seam: exposes the internal transport-state recovery dispatcher so tests
    // can drive connectionstatechange events without a real PeerConnection. In
    // production the same handler is wired into createListenerRealtimeClient.
    onRealtimeHandlerReady?: (handler: ConnectionStateHandler) => void;
}

// 90s heartbeat pairs with the 240s D1 active-listener window (~2.7× → tolerates 2 missed
// beats). Intervals widened (Phase 10) to cut the client request rate: at 60s poll + 90s
// heartbeat, 6k listeners ≈ 167 req/s (vs ~1,200 at 5s/30s) — relieves D1 write saturation
// and keeps a 5k/3h event within the Workers request budget (~1.5M vs ~12.6M req).
const DEFAULT_HEARTBEAT_MS = 90_000;
const DEFAULT_STATUS_POLL_MS = 60_000;
const DEFAULT_ACCESS_SAFETY_POLL_MS = 5 * 60_000;
const DEFAULT_ACCESS_APPROVED_DELAY_MS = 700;
const ACCESS_SERVICE_ERROR_MESSAGE = 'Check your connection, then retry.';
// LiveKit's own Room retries a transient drop internally (RoomEvent.
// Reconnecting/Reconnected) with no app-level timer needed. Only a terminal
// "disconnected" (LiveKit gave up, or the token's 1h TTL expired) schedules a
// reconnect here. Backoff is exponential from base to cap, bounded by max
// attempts, so a persistently-down connection never spins in a tight loop.
const DEFAULT_RECOVERY_BASE_MS = 500;
const DEFAULT_RECOVERY_MAX_MS = 4_000;
const DEFAULT_RECOVERY_MAX_ATTEMPTS = 6;
// Listener output volume is session-local (never persisted) and starts high so a
// listener hears audio immediately after tapping a language. Steps are coarse so
// the large +/- buttons are easy to operate for low-tech-literacy users.
const DEFAULT_VOLUME = 0.8;
const VOLUME_STEP = 0.1;
const VOLUME_SEGMENTS = 5;

function clampVolume(value: number): number {
    return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}

export function ListenerRoute({
    programSlug,
    publicApi,
    listenerApi: listenerApiProp,
    realtimeClient: realtimeClientProp,
    createRoom,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    statusPollMs = DEFAULT_STATUS_POLL_MS,
    accessBroadcastPollMs,
    accessSafetyPollMs = DEFAULT_ACCESS_SAFETY_POLL_MS,
    accessApprovedDelayMs = DEFAULT_ACCESS_APPROVED_DELAY_MS,
    recoveryBaseMs = DEFAULT_RECOVERY_BASE_MS,
    recoveryMaxMs = DEFAULT_RECOVERY_MAX_MS,
    recoveryMaxAttempts = DEFAULT_RECOVERY_MAX_ATTEMPTS,
    onRealtimeHandlerReady,
}: ListenerRouteProps) {
    const [state, setState] = useState<ListenerState>({ status: 'loading' });
    const [accessState, setAccessState] = useState<ListenerAccessState>({
        status: 'checking',
        storageDegraded: false,
    });
    const [playback, setPlayback] = useState<PlaybackState>({ status: 'idle' });
    const [volume, setVolume] = useState(DEFAULT_VOLUME);
    const inAppBrowser = useMemo(() => detectInAppBrowser(), []);
    const listenerApi = useMemo(() => listenerApiProp ?? createListenerApi(), [listenerApiProp]);
    const clientId = useMemo(() => getOrCreateClientId(programSlug), [programSlug]);
    const accessTokenRef = useRef<string | undefined>(undefined);
    const accessGenerationRef = useRef(0);
    const accessRedemptionRef = useRef<Promise<void> | null>(null);
    const accessRedeemedRef = useRef(false);
    const gateTransitionedRef = useRef(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const connectedRef = useRef<{
        connectionId: string;
        streamId: string;
    } | null>(null);
    const reconnectingPublisherVersionRef = useRef<string | null>(null);
    // The recovery dispatcher is wired into the memoized realtime client ONCE, so
    // it must read live state through a ref to avoid a stale closure capturing the
    // first render's values.
    const connectionStateHandlerRef = useRef<ConnectionStateHandler>(() => {});
    // Latest live stream status (live/silent/offline) for offline-standdown, kept
    // in a ref so the recovery callback reads the current value at fire-time.
    const streamStatusRef = useRef<'live' | 'silent' | 'offline' | undefined>(undefined);
    // Latest known publisher version for the live stream, mirrored so a transport
    // recovery can stamp the freshest version onto its new connection and collapse
    // a coincident publisher-version reconnect (in-flight latch + version stamp).
    const streamPublisherVersionRef = useRef<string | null>(null);
    // Shared in-flight latch: prevents the transport-failed recovery and the
    // publisher-version reconnect from firing two concurrent reconnects.
    const recoveryInFlightRef = useRef(false);
    // Pending backoff/grace timer, cleared on connect/switch/leave/unmount.
    const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Current backoff attempt count; reset to 0 on a successful "connected".
    const recoveryAttemptRef = useRef(0);
    // Held scheduler so a failed reconnect can queue the next backoff attempt
    // without re-entering through a transport event.
    const scheduleRecoveryRef = useRef<() => void>(() => {});
    const wakeLockRef = useRef<ScreenWakeLockSentinel | null>(null);
    // The stream being recovered. Captured when recovery starts so subsequent
    // backoff attempts survive playback moving to "disconnected" (which nulls
    // connectedRef). Cleared on connect/switch/leave.
    const recoveryStreamRef = useRef<PublicLanguageStream | null>(null);

    const realtimeClient = useMemo(
        () =>
            realtimeClientProp ??
            createListenerRealtimeClient({
                listenerApi,
                ...(createRoom ? { createRoom } : {}),
                onConnectionStateChange: (connectionId, connectionState) => {
                    connectionStateHandlerRef.current(connectionId, connectionState);
                },
            }),
        [listenerApi, realtimeClientProp, createRoom],
    );

    function isAccessGenerationCurrent(accessGeneration: number): boolean {
        return accessGenerationRef.current === accessGeneration;
    }

    function accessServiceErrorState(
        storageDegraded: boolean,
        claim?: ListenerAccessClaim,
    ): ListenerAccessState {
        return {
            status: 'error',
            ...(claim ? { claim } : {}),
            message: ACCESS_SERVICE_ERROR_MESSAGE,
            retrying: false,
            storageDegraded,
        };
    }

    useEffect(() => {
        let isCurrent = true;
        let pollHandle: ReturnType<typeof setInterval> | undefined;
        const accessGeneration = accessGenerationRef.current + 1;
        accessGenerationRef.current = accessGeneration;
        accessRedemptionRef.current = null;
        accessRedeemedRef.current = false;
        gateTransitionedRef.current = false;
        accessTokenRef.current = undefined;
        setState({ status: 'loading' });
        setAccessState({ status: 'checking', storageDegraded: false });
        setPlayback({ status: 'idle' });

        async function load() {
            let metadata: ListenerPublicProgramMetadata;
            try {
                metadata = (await publicApi.fetchProgram(
                    programSlug,
                )) as ListenerPublicProgramMetadata;
            } catch (_error) {
                if (isCurrent && isAccessGenerationCurrent(accessGeneration)) {
                    setState({ status: 'error' });
                }
                return;
            }
            if (!isCurrent || !isAccessGenerationCurrent(accessGeneration)) {
                return;
            }

            let snapshot: ListenerPublicProgramStatus | null = null;
            try {
                snapshot = (await publicApi.fetchProgramStatus(
                    programSlug,
                )) as ListenerPublicProgramStatus;
            } catch (_error) {
                // snapshot already null from initialization above
            }
            if (!isCurrent || !isAccessGenerationCurrent(accessGeneration)) {
                return;
            }

            setState({
                status: 'success',
                metadata,
                snapshot,
                statusDegraded: snapshot === null,
            });

            pollHandle = setInterval(async () => {
                try {
                    const nextSnapshot = (await publicApi.fetchProgramStatus(
                        programSlug,
                    )) as ListenerPublicProgramStatus;
                    if (isCurrent) {
                        setState((current) =>
                            current.status === 'success'
                                ? {
                                      ...current,
                                      snapshot: nextSnapshot,
                                      statusDegraded: false,
                                  }
                                : current,
                        );
                    }
                } catch (_error) {
                    if (isCurrent) {
                        setState((current) =>
                            current.status === 'success'
                                ? {
                                      ...current,
                                      snapshot: current.snapshot,
                                      statusDegraded: true,
                                  }
                                : current,
                        );
                    }
                }
            }, statusPollMs);

            try {
                const nextAccessState = await initialAccessState(metadata, accessGeneration);
                if (
                    !nextAccessState ||
                    !isCurrent ||
                    !isAccessGenerationCurrent(accessGeneration)
                ) {
                    return;
                }
                setAccessState(nextAccessState);
            } catch (_error) {
                if (isCurrent && isAccessGenerationCurrent(accessGeneration)) {
                    setAccessState(accessServiceErrorState(false));
                }
            }
        }

        void load();

        return () => {
            isCurrent = false;
            // Retry and authoritative 403 handling may have advanced the generation
            // beyond this effect's initial value. Unmount must still invalidate that
            // newest work, so advance unconditionally instead of comparing to the
            // generation captured when the effect mounted.
            accessGenerationRef.current += 1;
            accessRedemptionRef.current = null;
            accessRedeemedRef.current = false;
            if (pollHandle) {
                clearInterval(pollHandle);
            }
        };
    }, [programSlug, publicApi, listenerApi, clientId, statusPollMs]);

    async function mintWaitingAccessState(
        storageDegraded: boolean,
        message: string | undefined,
        accessGeneration: number,
    ): Promise<ListenerAccessState | null> {
        if (!isAccessGenerationCurrent(accessGeneration)) {
            return null;
        }
        const claim = await listenerApi.claimAccess({ programSlug, clientId });
        if (!isAccessGenerationCurrent(accessGeneration)) {
            return null;
        }
        const writeDegraded = storeAccessClaim(programSlug, claim);
        return {
            status: 'waiting',
            claim,
            checking: false,
            ...(message ? { message } : {}),
            storageDegraded: storageDegraded || writeDegraded,
        };
    }

    async function initialAccessState(
        metadata: ListenerPublicProgramMetadata,
        accessGeneration: number,
    ): Promise<ListenerAccessState | null> {
        if (!isAccessGenerationCurrent(accessGeneration)) {
            return null;
        }
        if (!metadata.program.accessControlEnabled) {
            accessTokenRef.current = undefined;
            return { status: 'disabled', storageDegraded: false };
        }

        let storageDegraded = false;
        const storedToken = readStoredAccessToken(programSlug);
        storageDegraded ||= storedToken.storageDegraded;
        if (storedToken.value) {
            if (!isAccessGenerationCurrent(accessGeneration)) {
                return null;
            }
            try {
                const response = await listenerApi.accessStatus({
                    programSlug,
                    accessToken: storedToken.value,
                });
                if (!isAccessGenerationCurrent(accessGeneration)) {
                    return null;
                }
                if (response.state === 'approved') {
                    accessTokenRef.current = storedToken.value;
                    return {
                        status: 'approved',
                        accessToken: storedToken.value,
                        storageDegraded,
                    };
                }

                const tokenClearDegraded = clearStoredAccessToken(programSlug);
                const claimClearDegraded = clearStoredAccessClaim(programSlug);
                storageDegraded = tokenClearDegraded || claimClearDegraded || storageDegraded;
                accessTokenRef.current = undefined;
                return mintWaitingAccessState(
                    storageDegraded,
                    response.state === 'revoked'
                        ? 'Your access was removed. Ask a volunteer to approve you again.'
                        : undefined,
                    accessGeneration,
                );
            } catch (_error) {
                if (!isAccessGenerationCurrent(accessGeneration)) {
                    return null;
                }
                // A transport/5xx failure is not an authoritative revocation. Keep the
                // previously approved listener on the listen path; the next acquisition
                // remains server-authoritative and can return listener_not_approved.
                accessTokenRef.current = storedToken.value;
                return {
                    status: 'approved',
                    accessToken: storedToken.value,
                    storageDegraded,
                };
            }
        }

        const storedClaim = readStoredAccessClaim(programSlug);
        storageDegraded ||= storedClaim.storageDegraded;
        if (storedClaim.value) {
            return {
                status: 'waiting',
                claim: storedClaim.value,
                checking: false,
                storageDegraded,
            };
        }

        return mintWaitingAccessState(storageDegraded, undefined, accessGeneration);
    }

    function setWaitingCheckState(claim: ListenerAccessClaim, checking: boolean, message?: string) {
        setAccessState((current) =>
            current.status === 'waiting' || current.status === 'error'
                ? {
                      status: 'waiting',
                      claim,
                      checking,
                      ...(message ? { message } : {}),
                      storageDegraded: current.storageDegraded,
                  }
                : current,
        );
    }

    function redeemAccessClaim(
        claim: ListenerAccessClaim,
        showPendingMessage: boolean,
        accessGeneration = accessGenerationRef.current,
    ): Promise<void> {
        if (!isAccessGenerationCurrent(accessGeneration)) {
            return Promise.resolve();
        }
        if (accessRedeemedRef.current) {
            return Promise.resolve();
        }
        if (accessRedemptionRef.current) {
            return accessRedemptionRef.current;
        }
        const redemption: Promise<void> = (async () => {
            let response: Awaited<ReturnType<ListenerApi['accessStatus']>>;
            try {
                if (!isAccessGenerationCurrent(accessGeneration)) {
                    return;
                }
                response = await listenerApi.accessStatus({
                    programSlug,
                    claimId: claim.claimId,
                    claimSecret: claim.claimSecret,
                });
            } catch (_error) {
                if (!isAccessGenerationCurrent(accessGeneration)) {
                    return;
                }
                if (showPendingMessage) {
                    setAccessState((current) =>
                        accessServiceErrorState(current.storageDegraded, claim),
                    );
                } else {
                    setWaitingCheckState(claim, false);
                }
                return;
            }
            if (!isAccessGenerationCurrent(accessGeneration)) {
                return;
            }
            if (response.state === 'approved' && response.accessToken) {
                accessRedeemedRef.current = true;
                const writeDegraded = storeAccessToken(programSlug, response.accessToken);
                accessTokenRef.current = response.accessToken;
                setAccessState((current) => ({
                    status: 'entering',
                    accessToken: response.accessToken!,
                    storageDegraded: writeDegraded || current.storageDegraded,
                }));
                return;
            }
            if (response.state === 'revoked' || response.state === 'unknown') {
                let storageDegraded = clearStoredAccessClaim(programSlug);
                storageDegraded = clearStoredAccessToken(programSlug) || storageDegraded;
                accessTokenRef.current = undefined;
                try {
                    const waiting = await mintWaitingAccessState(
                        storageDegraded || accessState.storageDegraded,
                        response.state === 'revoked'
                            ? 'Your access was removed. Ask a volunteer to approve you again.'
                            : undefined,
                        accessGeneration,
                    );
                    if (waiting && isAccessGenerationCurrent(accessGeneration)) {
                        setAccessState(waiting);
                    }
                } catch (_error) {
                    if (isAccessGenerationCurrent(accessGeneration)) {
                        setAccessState(
                            accessServiceErrorState(storageDegraded || accessState.storageDegraded),
                        );
                    }
                }
                return;
            }
            setWaitingCheckState(
                claim,
                false,
                showPendingMessage ? 'Not yet — ask a volunteer nearby for access.' : undefined,
            );
        })().finally(() => {
            if (accessRedemptionRef.current === redemption) {
                accessRedemptionRef.current = null;
            }
        });
        accessRedemptionRef.current = redemption;
        return redemption;
    }

    async function handleAccessCheck() {
        if (accessState.status !== 'waiting' || accessState.checking) {
            return;
        }
        const claim = accessState.claim;
        const accessGeneration = accessGenerationRef.current;
        setWaitingCheckState(claim, true);
        try {
            if (!isAccessGenerationCurrent(accessGeneration)) {
                return;
            }
            const metadata = (await publicApi.fetchProgram(
                programSlug,
            )) as ListenerPublicProgramMetadata;
            if (!isAccessGenerationCurrent(accessGeneration)) {
                return;
            }
            setState((current) =>
                current.status === 'success' ? { ...current, metadata } : current,
            );
            if (!metadata.program.accessControlEnabled) {
                accessTokenRef.current = undefined;
                setAccessState({
                    status: 'disabled',
                    storageDegraded: accessState.storageDegraded,
                });
                return;
            }
            await redeemAccessClaim(claim, true, accessGeneration);
        } catch (_error) {
            if (isAccessGenerationCurrent(accessGeneration)) {
                setAccessState((current) =>
                    accessServiceErrorState(current.storageDegraded, claim),
                );
            }
        }
    }

    async function handleAccessRetry() {
        if (accessState.status !== 'error' || accessState.retrying || state.status !== 'success') {
            return;
        }
        const claim = accessState.claim;
        const accessGeneration = accessGenerationRef.current + 1;
        accessGenerationRef.current = accessGeneration;
        accessRedemptionRef.current = null;
        accessRedeemedRef.current = false;
        setAccessState({ ...accessState, retrying: true });

        if (claim) {
            setWaitingCheckState(claim, true);
            await redeemAccessClaim(claim, true, accessGeneration);
            return;
        }

        try {
            const nextAccessState = await initialAccessState(state.metadata, accessGeneration);
            if (nextAccessState && isAccessGenerationCurrent(accessGeneration)) {
                setAccessState(nextAccessState);
            }
        } catch (_error) {
            if (isAccessGenerationCurrent(accessGeneration)) {
                setAccessState(accessServiceErrorState(accessState.storageDegraded));
            }
        }
    }

    useEffect(() => {
        if (accessState.status !== 'entering') {
            return undefined;
        }
        const handle = setTimeout(() => {
            setAccessState((current) =>
                current.status === 'entering'
                    ? {
                          status: 'approved',
                          accessToken: current.accessToken,
                          storageDegraded: current.storageDegraded,
                      }
                    : current,
            );
        }, accessApprovedDelayMs);
        return () => clearTimeout(handle);
    }, [accessState.status, accessApprovedDelayMs]);

    useEffect(() => {
        if (accessState.status !== 'waiting') {
            return undefined;
        }

        const claim = accessState.claim;
        const accessGeneration = accessGenerationRef.current;
        let cancelled = false;
        let broadcastHandle: ReturnType<typeof setTimeout> | undefined;
        let safetyHandle: ReturnType<typeof setTimeout> | undefined;
        let broadcastInFlight = false;

        const broadcastDelay = () => accessBroadcastPollMs ?? 10_000 + Math.random() * 5_000;
        const safetyDelay = () =>
            accessSafetyPollMs + Math.random() * Math.min(30_000, accessSafetyPollMs / 10);

        function scheduleBroadcast() {
            if (
                cancelled ||
                !isAccessGenerationCurrent(accessGeneration) ||
                document.visibilityState !== 'visible' ||
                broadcastInFlight ||
                broadcastHandle
            ) {
                return;
            }
            broadcastHandle = setTimeout(() => {
                broadcastHandle = undefined;
                void pollBroadcast();
            }, broadcastDelay());
        }

        async function pollBroadcast() {
            if (
                cancelled ||
                !isAccessGenerationCurrent(accessGeneration) ||
                document.visibilityState !== 'visible' ||
                broadcastInFlight
            ) {
                return;
            }
            broadcastInFlight = true;
            try {
                const response = await listenerApi.approvedAccessClaims(programSlug);
                if (cancelled || !isAccessGenerationCurrent(accessGeneration)) {
                    return;
                }
                if (response.approved.includes(claim.claimId)) {
                    await redeemAccessClaim(claim, false, accessGeneration);
                }
            } catch (_error) {
                // The edge broadcast is an optimization; Access and the safety poll remain.
            } finally {
                broadcastInFlight = false;
                scheduleBroadcast();
            }
        }

        function scheduleSafetyPoll() {
            if (cancelled || !isAccessGenerationCurrent(accessGeneration) || safetyHandle) {
                return;
            }
            safetyHandle = setTimeout(() => {
                safetyHandle = undefined;
                void pollSafety();
            }, safetyDelay());
        }

        async function pollSafety() {
            if (cancelled || !isAccessGenerationCurrent(accessGeneration)) {
                return;
            }
            await redeemAccessClaim(claim, false, accessGeneration);
            if (!cancelled && isAccessGenerationCurrent(accessGeneration)) {
                scheduleSafetyPoll();
            }
        }

        function clearBroadcastTimer() {
            if (broadcastHandle) {
                clearTimeout(broadcastHandle);
                broadcastHandle = undefined;
            }
        }

        function handleVisibilityChange() {
            if (document.visibilityState === 'visible') {
                clearBroadcastTimer();
                void pollBroadcast();
            } else {
                clearBroadcastTimer();
            }
        }

        scheduleBroadcast();
        scheduleSafetyPoll();
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            cancelled = true;
            clearBroadcastTimer();
            if (safetyHandle) {
                clearTimeout(safetyHandle);
                safetyHandle = undefined;
            }
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [
        accessState.status,
        accessState.status === 'waiting' ? accessState.claim.claimId : null,
        accessBroadcastPollMs,
        accessSafetyPollMs,
        listenerApi,
        programSlug,
    ]);

    useEffect(() => {
        connectedRef.current =
            playback.status === 'connected'
                ? {
                      connectionId: playback.connectionId,
                      streamId: playback.streamId,
                  }
                : null;
    }, [playback]);

    // Mirror the live stream's latest status into a ref so the recovery callback
    // can stand down while the publisher is offline and resume when it returns.
    useEffect(() => {
        const streamId = playbackStreamId(playback);
        const liveStream =
            state.status === 'success' && streamId
                ? state.snapshot?.streams.find((stream) => stream.id === streamId)
                : undefined;
        streamStatusRef.current = liveStream?.state;
        // Cache the PREFERRED version (relayVersion ?? publisherVersion) so the
        // transport-recovery stamp and the re-pull comparison agree in relay mode —
        // otherwise recovery stamps publisher_* while the effect compares relay_*,
        // firing an unnecessary reconnect.
        streamPublisherVersionRef.current = preferredStreamVersion(liveStream);
    }, [state, playback]);

    useEffect(() => {
        if (playback.status !== 'connected') {
            return undefined;
        }

        const connectionId = playback.connectionId;
        const streamId = playback.streamId;
        const handle = setInterval(() => {
            listenerApi.heartbeat({ connectionId }).catch(() => {
                setPlayback({ status: 'disconnected', streamId, connectionId });
            });
        }, heartbeatMs);

        return () => {
            clearInterval(handle);
        };
    }, [heartbeatMs, listenerApi, playback]);

    useEffect(() => {
        if (state.status !== 'success' || playback.status !== 'connected') {
            return;
        }

        const nextPublisherVersion = publisherVersionForStream(state, playback.streamId);
        if (
            !nextPublisherVersion ||
            reconnectingPublisherVersionRef.current === nextPublisherVersion
        ) {
            return;
        }

        if (playback.publisherVersion === null) {
            setPlayback((current) =>
                current.status === 'connected' &&
                current.connectionId === playback.connectionId &&
                current.streamId === playback.streamId &&
                current.publisherVersion === null
                    ? { ...current, publisherVersion: nextPublisherVersion }
                    : current,
            );
            return;
        }

        if (nextPublisherVersion === playback.publisherVersion) {
            return;
        }

        const activeStream = state.metadata.streams.find(
            (stream) => stream.id === playback.streamId,
        );
        if (!activeStream) {
            return;
        }

        // If a transport-failure recovery is already mid-flight, let it complete
        // rather than firing a second concurrent reconnect for the version bump.
        if (recoveryInFlightRef.current) {
            reconnectingPublisherVersionRef.current = nextPublisherVersion;
            return;
        }

        reconnectingPublisherVersionRef.current = nextPublisherVersion;
        void handleReconnect(activeStream, { viaGesture: false });
    }, [state, playback]);

    const isConnectedPlayback = playback.status === 'connected';
    const connectedPlaybackStreamId = isConnectedPlayback ? playback.streamId : undefined;
    const connectedPlaybackConnectionId = isConnectedPlayback ? playback.connectionId : undefined;
    const shouldTreatAsNeedGesture = isConnectedPlayback ? playback.needsGesture : undefined;

    useEffect(() => {
        if (!isConnectedPlayback) {
            return undefined;
        }

        let cancelled = false;

        async function requestWakeLock() {
            if (shouldTreatAsNeedGesture) {
                return;
            }

            const audio = audioRef.current;
            if (!audio || audio.paused) {
                return;
            }

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
                // Wake Lock is best-effort; keep playback running if unavailable.
            }
        }

        function handleVisibilityChange() {
            if (document.visibilityState === 'visible') {
                const audio = audioRef.current;
                if (!audio) {
                    return;
                }

                if (audio.paused) {
                    void audio.play().then(
                        () => {
                            setPlayback((current) =>
                                current.status === 'connected'
                                    ? { ...current, needsGesture: false }
                                    : current,
                            );
                        },
                        (error) => {
                            if (isAutoplayBlocked(error)) {
                                setPlayback((current) =>
                                    current.status === 'connected'
                                        ? { ...current, needsGesture: true }
                                        : current,
                                );
                            }
                        },
                    );
                }

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
    }, [
        isConnectedPlayback,
        connectedPlaybackStreamId,
        connectedPlaybackConnectionId,
        shouldTreatAsNeedGesture,
    ]);

    // Keep the transport-state recovery dispatcher fresh on every render and expose
    // it (test seam) so a connectionstatechange can drive fast, app-level recovery.
    useEffect(() => {
        function clearRecoveryTimer() {
            if (recoveryTimerRef.current !== null) {
                clearTimeout(recoveryTimerRef.current);
                recoveryTimerRef.current = null;
            }
        }

        function scheduleRecovery() {
            // Stand down while the publisher is offline; the publisher-version effect
            // resumes recovery when the stream returns live.
            if (streamStatusRef.current === 'offline') {
                return;
            }
            if (recoveryInFlightRef.current) {
                return;
            }
            if (recoveryAttemptRef.current >= recoveryMaxAttempts) {
                return;
            }

            // Prefer the live connection's stream; fall back to the stream captured at
            // the start of this recovery sequence (playback may already be
            // "disconnected" from a failed attempt, which nulls connectedRef).
            const current = connectedRef.current;
            const activeStream =
                (state.status === 'success' && current
                    ? state.metadata.streams.find((stream) => stream.id === current.streamId)
                    : undefined) ??
                recoveryStreamRef.current ??
                undefined;
            if (!activeStream) {
                return;
            }
            recoveryStreamRef.current = activeStream;

            const attempt = recoveryAttemptRef.current;
            recoveryAttemptRef.current = attempt + 1;
            const delay = Math.min(recoveryBaseMs * 2 ** attempt, recoveryMaxMs);
            clearRecoveryTimer();
            recoveryTimerRef.current = setTimeout(() => {
                recoveryTimerRef.current = null;
                // Re-check standdown at fire-time: the publisher may have just gone away.
                if (streamStatusRef.current === 'offline') {
                    return;
                }
                void handleReconnect(activeStream, { viaGesture: false });
            }, delay);
        }

        // Maps LiveKit's own Room events onto the recovery machinery.
        // "reconnecting"/"reconnected" are LiveKit's own transient self-heal (ICE
        // restart / signal resume) -- no manual timer needed, so "reconnecting" is
        // a no-op here (mirrors the old grace period's quiet wait, without a
        // timer). A terminal "disconnected" means LiveKit gave up (or the token's
        // 1h TTL expired), which is the one case that still needs an app-level
        // reconnect.
        const handler: ConnectionStateHandler = (connectionId, connectionState) => {
            const current = connectedRef.current;
            // Ignore events from any connection that is no longer the live one (e.g. a
            // late event from a pre-switch / closed connection).
            if (!current || current.connectionId !== connectionId) {
                return;
            }

            if (connectionState === 'reconnected') {
                // Recovered (by us or LiveKit itself): reset backoff and drop any
                // pending timer.
                recoveryAttemptRef.current = 0;
                clearRecoveryTimer();
                return;
            }

            if (connectionState === 'disconnected') {
                // Terminal — recover immediately (subject to backoff spacing).
                scheduleRecovery();
            }
        };

        connectionStateHandlerRef.current = handler;
        scheduleRecoveryRef.current = scheduleRecovery;
        onRealtimeHandlerReady?.(handler);
    }, [state, recoveryBaseMs, recoveryMaxMs, recoveryMaxAttempts, onRealtimeHandlerReady]);

    // Clear any pending recovery timer on unmount so a scheduled reconnect cannot
    // fire after the component is gone.
    useEffect(() => {
        return () => {
            if (recoveryTimerRef.current !== null) {
                clearTimeout(recoveryTimerRef.current);
                recoveryTimerRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        return () => {
            const current = connectedRef.current;
            if (current) {
                void realtimeClient.stop({
                    connectionId: current.connectionId,
                    reason: 'page_unloaded',
                });
            }
        };
    }, [realtimeClient]);

    // Keep the (hidden) audio element's output level in sync with the listener's
    // chosen volume. Re-applied whenever a new stream attaches so a fresh
    // srcObject inherits the current level.
    useEffect(() => {
        const audio = audioRef.current;
        if (audio) {
            audio.volume = volume;
        }
    }, [volume, playback]);

    function adjustVolume(delta: number) {
        setVolume((current) => clampVolume(current + delta));
    }

    function markAccessAcquisitionSucceeded() {
        if (!accessTokenRef.current) {
            return;
        }
        clearStoredAccessClaim(programSlug);
        gateTransitionedRef.current = false;
    }

    async function enterAccessGate(
        error: unknown,
        failedAccessToken: string | undefined,
    ): Promise<boolean> {
        if (!isListenerNotApprovedError(error)) {
            return false;
        }

        if (accessTokenRef.current && accessTokenRef.current !== failedAccessToken) {
            return true;
        }
        if (gateTransitionedRef.current) {
            return true;
        }
        gateTransitionedRef.current = true;

        const accessGeneration = accessGenerationRef.current + 1;
        accessGenerationRef.current = accessGeneration;
        accessRedemptionRef.current = null;
        accessRedeemedRef.current = false;
        const tokenClearDegraded = clearStoredAccessToken(programSlug);
        const claimClearDegraded = clearStoredAccessClaim(programSlug);
        accessTokenRef.current = undefined;

        if (recoveryTimerRef.current !== null) {
            clearTimeout(recoveryTimerRef.current);
            recoveryTimerRef.current = null;
        }
        recoveryInFlightRef.current = false;
        recoveryAttemptRef.current = 0;
        recoveryStreamRef.current = null;
        reconnectingPublisherVersionRef.current = null;

        const currentConnection = connectedRef.current;
        connectedRef.current = null;
        detachAudio(audioRef.current);
        setPlayback({ status: 'idle' });
        setAccessState({
            status: 'checking',
            storageDegraded: tokenClearDegraded || claimClearDegraded,
        });
        if (currentConnection) {
            void realtimeClient
                .stop({
                    connectionId: currentConnection.connectionId,
                    reason: 'listener_access_removed',
                })
                .catch(() => {});
        }

        let metadata = state.status === 'success' ? state.metadata : null;
        try {
            if (!isAccessGenerationCurrent(accessGeneration)) {
                return true;
            }
            const freshMetadata = (await publicApi.fetchProgram(
                programSlug,
            )) as ListenerPublicProgramMetadata;
            if (!isAccessGenerationCurrent(accessGeneration)) {
                return true;
            }
            metadata = freshMetadata;
            setState((current) =>
                current.status === 'success' ? { ...current, metadata: freshMetadata } : current,
            );
            if (!freshMetadata.program.accessControlEnabled) {
                if (isAccessGenerationCurrent(accessGeneration)) {
                    gateTransitionedRef.current = false;
                    setAccessState({
                        status: 'disabled',
                        storageDegraded: tokenClearDegraded || claimClearDegraded,
                    });
                }
                return true;
            }
        } catch (_error) {
            // The gated 403 is authoritative if the metadata refresh is unavailable.
        }

        if (!metadata || !isAccessGenerationCurrent(accessGeneration)) {
            return true;
        }
        try {
            const waiting = await mintWaitingAccessState(
                tokenClearDegraded || claimClearDegraded,
                'Your access was removed. Ask a volunteer to approve you again.',
                accessGeneration,
            );
            if (waiting && isAccessGenerationCurrent(accessGeneration)) {
                setAccessState(waiting);
            }
        } catch (_error) {
            if (isAccessGenerationCurrent(accessGeneration)) {
                setAccessState(accessServiceErrorState(tokenClearDegraded || claimClearDegraded));
            }
        }
        return true;
    }

    async function handleListen(stream: PublicLanguageStream) {
        setPlayback({ status: 'connecting', streamId: stream.id });
        // iOS Safari only honours play() inside the synchronous gesture turn; the
        // awaited subscribe below spends it, so prime the sink now (still in the tap).
        primeAudioPlayback(audioRef.current);
        let session: ListenerSession | null = null;
        const acquisitionAccessToken = accessTokenRef.current;
        try {
            session = await realtimeClient.subscribe({
                programSlug,
                streamId: stream.id,
                clientId,
                ...(accessTokenRef.current ? { accessToken: accessTokenRef.current } : {}),
            });
            markAccessAcquisitionSucceeded();
            const { started } = await attachAudioWithGesture(session, audioRef.current);
            setPlayback({
                status: 'connected',
                streamId: session.streamId,
                connectionId: session.connectionId,
                publisherVersion: publisherVersionForStream(state, session.streamId),
                ...(started ? {} : { needsGesture: true }),
            });
        } catch (error) {
            detachAudio(audioRef.current);
            if (session) {
                await stopSessionBestEffort(realtimeClient, session, 'playback_failed');
            }
            if (
                isListenerNotApprovedError(error) &&
                (await enterAccessGate(error, acquisitionAccessToken))
            ) {
                return;
            }
            setPlayback({
                status: 'disconnected',
                streamId: stream.id,
                errorCode: playbackErrorCode(error, session ? 'playback_failed' : undefined),
            });
        }
    }

    async function handleSwitch(stream: PublicLanguageStream) {
        if (playback.status !== 'connected') {
            await handleListen(stream);
            return;
        }

        const previousConnectionId = playback.connectionId;
        setPlayback({
            status: 'switching',
            streamId: stream.id,
            connectionId: previousConnectionId,
        });
        primeAudioPlayback(audioRef.current);

        let session: ListenerSession | null = null;
        const acquisitionAccessToken = accessTokenRef.current;
        try {
            session = await realtimeClient.switch({
                connectionId: previousConnectionId,
                programSlug,
                nextStreamId: stream.id,
                clientId,
                ...(accessTokenRef.current ? { accessToken: accessTokenRef.current } : {}),
            });
            markAccessAcquisitionSucceeded();
            const { started } = await attachAudioWithGesture(session, audioRef.current);
            setPlayback({
                status: 'connected',
                streamId: session.streamId,
                connectionId: session.connectionId,
                publisherVersion: publisherVersionForStream(state, session.streamId),
                ...(started ? {} : { needsGesture: true }),
            });
        } catch (error) {
            detachAudio(audioRef.current);
            if (session) {
                await stopSessionBestEffort(realtimeClient, session, 'playback_failed');
            }
            if (
                isListenerNotApprovedError(error) &&
                (await enterAccessGate(error, acquisitionAccessToken))
            ) {
                return;
            }
            setPlayback({
                status: 'disconnected',
                streamId: stream.id,
                connectionId: previousConnectionId,
                errorCode: playbackErrorCode(error, session ? 'playback_failed' : undefined),
            });
        }
    }

    async function handleReconnect(stream: PublicLanguageStream, options: ReconnectOptions = {}) {
        // Single in-flight latch shared with the transport-failure recovery and the
        // publisher-version reconnect so the two never fire concurrent reconnects.
        if (recoveryInFlightRef.current) {
            return;
        }
        recoveryInFlightRef.current = true;
        // Prefer the live connection (refs survive stale closures from the memoized
        // recovery callback); fall back to the render-time playback connectionId.
        const connectionId =
            ('connectionId' in playback ? playback.connectionId : undefined) ??
            connectedRef.current?.connectionId;
        setPlayback({
            status: 'reconnecting',
            streamId: stream.id,
            ...(connectionId ? { connectionId } : {}),
        });
        primeAudioPlayback(audioRef.current);

        let session: ListenerSession | null = null;
        let recovered = false;
        let shouldScheduleRetry = true;
        const viaGesture = options.viaGesture === true;
        const acquisitionAccessToken = accessTokenRef.current;
        try {
            session = connectionId
                ? await realtimeClient.reconnect({
                      connectionId,
                      programSlug,
                      streamId: stream.id,
                      clientId,
                      ...(accessTokenRef.current ? { accessToken: accessTokenRef.current } : {}),
                  })
                : await realtimeClient.subscribe({
                      programSlug,
                      streamId: stream.id,
                      clientId,
                      ...(accessTokenRef.current ? { accessToken: accessTokenRef.current } : {}),
                  });
            markAccessAcquisitionSucceeded();
            const { started } = await attachAudioWithGesture(session, audioRef.current);
            if (!started && !viaGesture) {
                await stopSessionBestEffort(realtimeClient, session, 'playback_failed');
                setPlayback({
                    status: 'disconnected',
                    streamId: stream.id,
                    ...(connectionId ? { connectionId } : {}),
                    errorCode: 'playback_failed',
                });
                recoveryAttemptRef.current = 0;
                recoveryStreamRef.current = null;
                reconnectingPublisherVersionRef.current = null;
                shouldScheduleRetry = false;
            } else {
                // Stamp the new connection with the FRESHEST known publisher version (the
                // status poll may have advanced it while we were reconnecting). This makes
                // a coincident publisher-version reconnect a no-op: the new connection is
                // already current, so the version effect stands down instead of firing a
                // second reconnect on top of this transport recovery.
                const latestPublisherVersion =
                    streamPublisherVersionRef.current ??
                    publisherVersionForStream(state, session.streamId);
                setPlayback({
                    status: 'connected',
                    streamId: session.streamId,
                    connectionId: session.connectionId,
                    publisherVersion: latestPublisherVersion,
                    ...(started ? {} : { needsGesture: true }),
                });
                reconnectingPublisherVersionRef.current = latestPublisherVersion;
                // Recovered: reset backoff so a future failure starts from the base delay.
                recoveryAttemptRef.current = 0;
                recoveryStreamRef.current = null;
                recovered = true;
            }
        } catch (error) {
            detachAudio(audioRef.current);
            if (session) {
                await stopSessionBestEffort(realtimeClient, session, 'playback_failed');
            }
            if (
                isListenerNotApprovedError(error) &&
                (await enterAccessGate(error, acquisitionAccessToken))
            ) {
                return;
            }
            setPlayback({
                status: 'disconnected',
                streamId: stream.id,
                ...(connectionId ? { connectionId } : {}),
                errorCode: playbackErrorCode(error, session ? 'playback_failed' : undefined),
            });
            reconnectingPublisherVersionRef.current = null;
        } finally {
            recoveryInFlightRef.current = false;
        }

        // Failed attempt that was part of an active backoff sequence: queue the next
        // attempt (the scheduler caps total attempts so this cannot loop forever).
        if (shouldScheduleRetry && !recovered && recoveryAttemptRef.current > 0) {
            scheduleRecoveryRef.current();
        }
    }

    async function handleEnableSound() {
        const audio = audioRef.current;
        if (!audio) {
            return;
        }
        try {
            // Runs inside the user's tap with the stream already attached, so iOS
            // permits playback. On success, drop the gesture prompt.
            await audio.play();
            setPlayback((current) =>
                current.status === 'connected' ? { ...current, needsGesture: false } : current,
            );
        } catch (_error) {
            // Still blocked — leave the prompt up for another tap.
        }
    }

    async function handleLeave() {
        if (!('connectionId' in playback) || !playback.connectionId) {
            setPlayback({ status: 'idle' });
            detachAudio(audioRef.current);
            return;
        }

        const connectionId = playback.connectionId;
        setPlayback({ status: 'idle' });
        detachAudio(audioRef.current);
        try {
            await realtimeClient.stop({ connectionId, reason: 'listener_left' });
        } catch (_error) {
            setPlayback({
                status: 'disconnected',
                streamId: playback.streamId,
                connectionId,
                errorCode: 'connection_lost',
            });
        }
    }

    return (
        <main aria-label="Listener shell" className="shell shell-listener">
            {state.status === 'loading' ? <p className="lp-info">Loading program...</p> : null}
            {state.status === 'error' ? (
                <p className="lp-info">This program does not exist.</p>
            ) : null}
            {state.status === 'success' &&
            (accessState.status === 'checking' ||
                accessState.status === 'error' ||
                accessState.status === 'waiting' ||
                accessState.status === 'entering') ? (
                <ListenerAccessGate
                    metadata={state.metadata}
                    {...(accessState.status === 'error'
                        ? {
                              error: accessState.message,
                              retrying: accessState.retrying,
                          }
                        : {})}
                    {...(accessState.status === 'waiting'
                        ? {
                              claim: accessState.claim,
                              checking: accessState.checking,
                              ...(accessState.message ? { message: accessState.message } : {}),
                          }
                        : {})}
                    entered={accessState.status === 'entering'}
                    storageDegraded={accessState.storageDegraded}
                    inAppBrowserBanner={
                        accessState.status === 'waiting' && inAppBrowser.isInApp ? (
                            <InAppBrowserBanner app={inAppBrowser.app} />
                        ) : undefined
                    }
                    onAccess={() =>
                        accessState.status === 'error'
                            ? void handleAccessRetry()
                            : void handleAccessCheck()
                    }
                />
            ) : null}
            {state.status === 'success' &&
            (accessState.status === 'disabled' || accessState.status === 'approved') ? (
                <ListenerMetadata
                    metadata={state.metadata}
                    playback={playback}
                    snapshot={state.snapshot}
                    statusDegraded={state.statusDegraded}
                    inAppBrowser={inAppBrowser}
                    volume={volume}
                    onEnableSound={handleEnableSound}
                    onLeave={handleLeave}
                    onListen={handleListen}
                    onReconnect={handleReconnect}
                    onSwitch={handleSwitch}
                    onVolumeDown={() => adjustVolume(-VOLUME_STEP)}
                    onVolumeUp={() => adjustVolume(VOLUME_STEP)}
                />
            ) : null}
            {/* Receive-only audio sink: driven imperatively via srcObject/play(). Native
          controls are hidden in favour of the custom tap-to-play + volume UI, but
          the element must stay mounted and ref-attached. */}
            <audio ref={audioRef} className="lp-audio-sink" playsInline aria-hidden="true" />
        </main>
    );
}

function ListenerMetadata({
    metadata,
    playback,
    snapshot,
    statusDegraded,
    inAppBrowser,
    volume,
    onEnableSound,
    onLeave,
    onListen,
    onReconnect,
    onSwitch,
    onVolumeDown,
    onVolumeUp,
}: {
    metadata: ListenerPublicProgramMetadata;
    playback: PlaybackState;
    snapshot: ListenerPublicProgramStatus | null;
    inAppBrowser: { isInApp: boolean; app?: string };
    statusDegraded: boolean;
    volume: number;
    onEnableSound: () => void;
    onLeave: () => void;
    onListen: (stream: PublicLanguageStream) => void;
    onReconnect: (stream: PublicLanguageStream, options?: ReconnectOptions) => void;
    onSwitch: (stream: PublicLanguageStream) => void;
    onVolumeDown: () => void;
    onVolumeUp: () => void;
}) {
    const streams = [...metadata.streams].sort(
        (left, right) => left.displayOrder - right.displayOrder,
    );
    const statusByStream = new Map((snapshot?.streams ?? []).map((stream) => [stream.id, stream]));
    const activeStream = streams.find((stream) => stream.id === playbackStreamId(playback));
    const metaLine = [metadata.program.venue].filter(Boolean).join(' · ');
    const listenability = getProgramListenability(metadata, snapshot);

    if (listenability.listenable === false) {
        return (
            <section className="listener-screen">
                <header className="lp-header">
                    <p className="eyebrow">Live translation</p>
                    <h1>{metadata.program.name}</h1>
                    {metaLine ? <p className="listener-meta">{metaLine}</p> : null}
                </header>
                {listenability.notListenableReason ? (
                    <ListenerGateMessage reason={listenability.notListenableReason} />
                ) : null}
            </section>
        );
    }

    return (
        <section className="listener-screen">
            <header className="lp-header">
                <p className="eyebrow">Live translation</p>
                <h1>{metadata.program.name}</h1>
                {metaLine ? <p className="listener-meta">{metaLine}</p> : null}
            </header>

            {statusDegraded || snapshot?.degraded ? (
                <p className="listener-alert" role="status">
                    Live status is degraded.
                </p>
            ) : null}

            {inAppBrowser.isInApp ? <InAppBrowserBanner app={inAppBrowser.app} /> : null}

            <PlaybackStatus playback={playback} activeStream={activeStream} />
            <PlaybackError playback={playback} />

            {playback.status === 'connected' ? (
                <VolumeControl
                    volume={volume}
                    onVolumeDown={onVolumeDown}
                    onVolumeUp={onVolumeUp}
                />
            ) : null}

            {streams.length === 0 ? (
                <p className="lp-info">No languages are available yet.</p>
            ) : (
                <ul className="lp-tile-list">
                    {streams.map((stream) => {
                        const rawStreamState = statusByStream.get(stream.id)?.state;
                        const streamState = rawStreamState ?? 'offline';
                        const isCurrent = playbackStreamId(playback) === stream.id;
                        const isPlaying =
                            isCurrent && playback.status === 'connected' && !playback.needsGesture;
                        return (
                            <li
                                key={stream.id}
                                className={`lp-tile lp-tile--${streamState}${
                                    isPlaying ? ' lp-tile--playing' : ''
                                }`}
                            >
                                <div className="lp-tile-main">
                                    {(() => {
                                        const { primary, secondary } = displayLanguage(stream);
                                        return (
                                            <h2 className="lp-lang">
                                                <span className="lp-lang-primary">{primary}</span>
                                                {secondary !== primary ? (
                                                    <span className="lp-lang-secondary">
                                                        {secondary}
                                                    </span>
                                                ) : null}
                                            </h2>
                                        );
                                    })()}
                                    <p className="lp-tile-state">
                                        <span
                                            className={`lp-dot lp-dot--${streamState}`}
                                            aria-hidden="true"
                                        />
                                        {labelForState(streamState)}
                                        {isPlaying ? (
                                            <span className="lp-playing"> · Playing</span>
                                        ) : null}
                                    </p>
                                </div>
                                <StreamAction
                                    isCurrent={isCurrent}
                                    playback={playback}
                                    stream={stream}
                                    streamState={streamState}
                                    rawStreamState={rawStreamState}
                                    onEnableSound={onEnableSound}
                                    onLeave={onLeave}
                                    onListen={onListen}
                                    onReconnect={onReconnect}
                                    onSwitch={onSwitch}
                                />
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}

function InAppBrowserBanner({ app }: { app?: string | undefined }) {
    const appName = app ? ` (${app})` : '';
    const currentUrl = typeof window === 'undefined' ? '' : window.location.href;

    return (
        <section className="listener-alert" role="status">
            <p className="lp-banner-title">
                For audio to work, open this page in Safari or Chrome. In-app browser
                {appName} may block sound.
            </p>
            <p className="lp-banner-subtext">
                Tap the browser menu (⋯) and choose Open in browser.
            </p>
            <p className="lp-browser-url" style={{ wordBreak: 'break-word' }}>
                {currentUrl}
            </p>
        </section>
    );
}

function ListenerGateMessage({ reason }: { reason: Exclude<ListenerNotListenableReason, null> }) {
    const [headline, subtext] =
        reason === 'not_started'
            ? ['This event has not started yet.', 'Check back when the event begins.']
            : ['This event has ended.', 'Thank you for joining.'];

    return (
        <>
            <p className="lp-gate-status" role="status">
                {headline}
            </p>
            <p className="lp-gate-subtext">{subtext}</p>
        </>
    );
}

function VolumeControl({
    volume,
    onVolumeDown,
    onVolumeUp,
}: {
    volume: number;
    onVolumeDown: () => void;
    onVolumeUp: () => void;
}) {
    const filled = Math.round(volume * VOLUME_SEGMENTS);
    return (
        <div className="lp-volume">
            <button
                type="button"
                className="lp-vol-btn"
                aria-label="Decrease volume"
                onClick={onVolumeDown}
            >
                <span aria-hidden="true">−</span>
            </button>
            <div
                className="lp-vol-level"
                role="img"
                aria-label={`Volume ${Math.round(volume * 100)} percent`}
            >
                {Array.from({ length: VOLUME_SEGMENTS }, (_, index) => (
                    <span
                        key={index}
                        className={`lp-vol-seg${index < filled ? ' lp-vol-seg--on' : ''}`}
                    />
                ))}
            </div>
            <button
                type="button"
                className="lp-vol-btn"
                aria-label="Increase volume"
                onClick={onVolumeUp}
            >
                <span aria-hidden="true">+</span>
            </button>
        </div>
    );
}

function StreamAction({
    isCurrent,
    playback,
    stream,
    streamState,
    rawStreamState,
    onEnableSound,
    onLeave,
    onListen,
    onReconnect,
    onSwitch,
}: {
    isCurrent: boolean;
    playback: PlaybackState;
    stream: PublicLanguageStream;
    streamState: 'live' | 'silent' | 'offline';
    rawStreamState: 'live' | 'silent' | 'offline' | undefined;
    onEnableSound: () => void;
    onLeave: () => void;
    onListen: (stream: PublicLanguageStream) => void;
    onReconnect: (stream: PublicLanguageStream, options?: ReconnectOptions) => void;
    onSwitch: (stream: PublicLanguageStream) => void;
}) {
    if (isCurrent && playback.status === 'connected') {
        // Autoplay was blocked (typically iOS without a fresh gesture): the stream is
        // attached but paused. Offer a one-tap unlock instead of the Stop control.
        if (playback.needsGesture) {
            return (
                <button
                    type="button"
                    className="lp-btn lp-btn--enable-sound"
                    aria-label="Tap to enable sound"
                    onClick={onEnableSound}
                >
                    Enable sound
                </button>
            );
        }
        // The active card's button stops playback. Its accessible name stays
        // "Leave stream" (matching the rest of the app and the e2e specs) while it
        // reads "Stop" for sighted users per the redesign. The same pattern applies
        // to every tile action below: the visible label is a short verb so all tile
        // buttons share one fixed width, while aria-label keeps the full
        // "<verb> <language>" name the tests and screen readers rely on (the
        // language itself is the tile heading, so sighted users lose nothing).
        return (
            <button
                type="button"
                className="lp-btn lp-btn--stop"
                aria-label="Leave stream"
                onClick={onLeave}
            >
                Stop
            </button>
        );
    }

    if (isCurrent && (playback.status === 'disconnected' || playback.status === 'reconnecting')) {
        return (
            <button
                type="button"
                className="lp-btn lp-btn--reconnect"
                aria-label={`Reconnect ${stream.languageName}`}
                onClick={() => onReconnect(stream, { viaGesture: true })}
            >
                Reconnect
            </button>
        );
    }

    const isOffline = rawStreamState === 'offline';

    if (playback.status === 'connected') {
        return (
            <button
                type="button"
                className="lp-btn lp-btn--switch"
                aria-label={`Switch to ${stream.languageName}`}
                disabled={isOffline}
                onClick={() => onSwitch(stream)}
            >
                Switch
            </button>
        );
    }

    // An offline stream has no live translator yet — tapping it only surfaces a
    // "Waiting for translator." error, which reads as broken to a non-technical
    // listener. Disable the control until the stream goes live/silent so the
    // language is visibly "not on yet" rather than erroring on tap.
    const disabled =
        isOffline ||
        (isCurrent &&
            (playback.status === 'connecting' ||
                playback.status === 'switching' ||
                playback.status === 'reconnecting'));

    return (
        <button
            type="button"
            className="lp-btn lp-btn--play"
            aria-label={`Listen to ${stream.languageName}`}
            disabled={disabled}
            onClick={() => onListen(stream)}
        >
            Listen
        </button>
    );
}

function PlaybackStatus({
    playback,
    activeStream,
}: {
    playback: PlaybackState;
    activeStream: PublicLanguageStream | undefined;
}) {
    if (playback.status === 'idle') {
        return <p className="listener-status">Choose a language to listen.</p>;
    }

    const language = activeStream?.languageName ?? 'selected language';

    if (playback.status === 'connected') {
        if (playback.needsGesture) {
            return <p className="listener-status">Tap “Enable sound” to start audio.</p>;
        }
        return <p className="listener-status">Listening to {language}</p>;
    }

    if (playback.status === 'connecting') {
        return <p className="listener-status">Connecting to {language}</p>;
    }

    if (playback.status === 'switching') {
        return <p className="listener-status">Switching to {language}</p>;
    }

    if (playback.status === 'reconnecting') {
        return <p className="listener-status">Reconnecting {language}</p>;
    }

    return <p className="listener-status">Disconnected</p>;
}

function PlaybackError({ playback }: { playback: PlaybackState }) {
    if (playback.status !== 'disconnected' || !playback.errorCode) {
        return null;
    }

    return <p className="listener-alert">{playbackErrorMessage(playback.errorCode)}</p>;
}

function playbackStreamId(playback: PlaybackState): string | undefined {
    return 'streamId' in playback ? playback.streamId : undefined;
}

function getProgramListenability(
    metadata: ListenerPublicProgramMetadata,
    snapshot: ListenerPublicProgramStatus | null,
): {
    listenable: boolean;
    notListenableReason: ListenerNotListenableReason;
} {
    return {
        listenable: snapshot?.program.listenable ?? metadata.program.listenable,
        notListenableReason:
            snapshot?.program.notListenableReason ?? metadata.program.notListenableReason,
    };
}

export function preferredStreamVersion(
    stream:
        | {
              relayVersion?: string | null;
              publisherVersion?: string | null;
          }
        | undefined,
): string | null {
    return stream?.relayVersion ?? stream?.publisherVersion ?? null;
}

function publisherVersionForStream(state: ListenerState, streamId: string): string | null {
    if (state.status !== 'success') {
        return null;
    }

    return preferredStreamVersion(state.snapshot?.streams.find((stream) => stream.id === streamId));
}

interface DisplayLanguage {
    // Native-script name (e.g. "हिन्दी") is the primary tile label; the English
    // name is the secondary, muted line beneath it. For English the two are
    // identical, so callers may render only the primary to avoid a duplicate line.
    primary: string;
    secondary: string;
}

function displayLanguage(stream: PublicLanguageStream): DisplayLanguage {
    return {
        primary: stream.nativeName || stream.languageName,
        secondary: stream.languageName,
    };
}

function labelForState(state: 'live' | 'silent' | 'offline'): string {
    if (state === 'live') {
        return 'Live';
    }

    // Silent means the translator is connected but no audio is detected right now.
    // Listeners may still subscribe and wait for audio to resume.
    if (state === 'silent') {
        return 'Silent';
    }

    return 'Offline';
}

// Attaches the stream and tries to start playback. Returns { started:false } when
// the browser blocks autoplay (typically iOS without a fresh gesture) — leaving
// srcObject attached so a one-tap "enable sound" can start it — and only throws on
// a genuine playback failure, which the caller treats as a teardown.
async function attachAudioWithGesture(
    session: ListenerSession,
    audio: HTMLAudioElement | null,
): Promise<{ started: boolean }> {
    if (!audio) {
        return { started: true };
    }

    audio.srcObject = session.mediaStream;
    try {
        await audio.play();
        return { started: true };
    } catch (error) {
        if (isAutoplayBlocked(error)) {
            return { started: false };
        }
        throw error;
    }
}

function isAutoplayBlocked(error: unknown): boolean {
    if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
        return error.name === 'NotAllowedError';
    }

    if (
        error !== null &&
        typeof error === 'object' &&
        'name' in error &&
        (error as { name?: unknown }).name === 'NotAllowedError'
    ) {
        return true;
    }

    return false;
}

// Called synchronously inside a user gesture (the language tap), before the
// awaited subscribe spends it. A play() here grants the <audio> element
// user-activation so the later programmatic play() is permitted on iOS Safari.
// With no source attached yet it may reject — that is expected and ignored.
function primeAudioPlayback(audio: HTMLAudioElement | null): void {
    if (!audio) {
        return;
    }
    try {
        const result = audio.play() as unknown;
        if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch(() => {});
        }
    } catch (_error) {
        // No source / not allowed — best effort; attachAudioWithGesture is the fallback.
    }
}

function detachAudio(audio: HTMLAudioElement | null): void {
    if (!audio) {
        return;
    }

    audio.pause();
    audio.srcObject = null;
}

async function stopSessionBestEffort(
    realtimeClient: ListenerRealtimeClient,
    session: ListenerSession,
    reason: string,
): Promise<void> {
    try {
        await realtimeClient.stop({ connectionId: session.connectionId, reason });
    } catch (_error) {
        // The UI has already moved to a disconnected state; backend cleanup is best-effort.
    }
}

function playbackErrorCode(
    error: unknown,
    fallback: ListenerPlaybackErrorCode | undefined,
): ListenerPlaybackErrorCode {
    if (error instanceof ApiError) {
        if (error.code === 'stream_not_live') {
            return 'stream_not_live';
        }

        if (error.code === 'listener_invalid_state') {
            return 'listener_invalid_state';
        }

        if (error.code === 'realtime_error') {
            return 'realtime_error';
        }
    }

    return fallback ?? 'connection_lost';
}

function playbackErrorMessage(errorCode: ListenerPlaybackErrorCode): string {
    if (errorCode === 'stream_not_live') {
        return 'Waiting for translator.';
    }

    if (errorCode === 'listener_invalid_state') {
        return 'Stream ended. Choose a language again.';
    }

    if (errorCode === 'realtime_error') {
        return 'Realtime connection failed. Try reconnecting.';
    }

    if (errorCode === 'playback_failed') {
        return 'Audio playback failed. Try reconnecting.';
    }

    return 'Connection lost. Try reconnecting.';
}

function isListenerNotApprovedError(error: unknown): error is ApiError {
    return (
        error instanceof ApiError && error.status === 403 && error.code === 'listener_not_approved'
    );
}

export function getOrCreateClientId(programSlug: string): string {
    const storageKey = listenerAccessStorageKey(programSlug, 'clientId');
    const stored = readListenerAccessValue(storageKey);
    if (stored.value) {
        return stored.value;
    }

    const next = `listener_client_${crypto.randomUUID()}`;
    writeListenerAccessValue(storageKey, next);
    return next;
}

type StoredAccessResult<T> = {
    value: T | null;
    storageDegraded: boolean;
};

const listenerAccessMemory = new Map<string, string>();

function listenerAccessStorageKey(
    programSlug: string,
    kind: 'accessClaim' | 'accessToken' | 'clientId',
): string {
    return `bhasha.listener.${programSlug}.${kind}`;
}

function readListenerAccessValue(storageKey: string): StoredAccessResult<string> {
    let localStorageFailed = false;
    try {
        const value = window.localStorage.getItem(storageKey);
        if (value) {
            return { value, storageDegraded: false };
        }
    } catch (_error) {
        localStorageFailed = true;
    }

    try {
        const value = window.sessionStorage.getItem(storageKey);
        if (value) {
            return { value, storageDegraded: true };
        }
    } catch (_error) {
        // The in-memory fallback below is the final storage tier.
    }

    const memoryValue = listenerAccessMemory.get(storageKey) ?? null;
    return {
        value: memoryValue,
        storageDegraded: localStorageFailed || memoryValue !== null,
    };
}

function writeListenerAccessValue(storageKey: string, value: string): boolean {
    try {
        window.localStorage.setItem(storageKey, value);
        try {
            window.sessionStorage.removeItem(storageKey);
        } catch (_error) {
            // Primary storage succeeded; a stale fallback value is harmless here and
            // will be superseded the next time fallback storage is writable.
        }
        listenerAccessMemory.delete(storageKey);
        return false;
    } catch (_error) {
        // Try session storage before falling back to this page's memory.
    }

    try {
        window.sessionStorage.setItem(storageKey, value);
        listenerAccessMemory.delete(storageKey);
        return true;
    } catch (_error) {
        listenerAccessMemory.set(storageKey, value);
        return true;
    }
}

function clearListenerAccessValue(storageKey: string): boolean {
    let storageDegraded = false;
    try {
        window.localStorage.removeItem(storageKey);
    } catch (_error) {
        storageDegraded = true;
    }
    try {
        window.sessionStorage.removeItem(storageKey);
    } catch (_error) {
        storageDegraded = true;
    }
    listenerAccessMemory.delete(storageKey);
    return storageDegraded;
}

function isListenerAccessClaim(value: unknown): value is ListenerAccessClaim {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const claim = value as Partial<ListenerAccessClaim>;
    return (
        typeof claim.claimId === 'string' &&
        claim.claimId.length > 0 &&
        typeof claim.claimSecret === 'string' &&
        claim.claimSecret.length > 0 &&
        typeof claim.shortCode === 'string' &&
        claim.shortCode.length > 0
    );
}

export function readStoredAccessClaim(
    programSlug: string,
): StoredAccessResult<ListenerAccessClaim> {
    const storageKey = listenerAccessStorageKey(programSlug, 'accessClaim');
    const stored = readListenerAccessValue(storageKey);
    if (!stored.value) {
        return { value: null, storageDegraded: stored.storageDegraded };
    }
    try {
        const parsed: unknown = JSON.parse(stored.value);
        if (isListenerAccessClaim(parsed)) {
            return { value: parsed, storageDegraded: stored.storageDegraded };
        }
    } catch (_error) {
        // Corrupt claims cannot be redeemed and are replaced below.
    }
    const clearDegraded = clearListenerAccessValue(storageKey);
    return {
        value: null,
        storageDegraded: stored.storageDegraded || clearDegraded,
    };
}

export function storeAccessClaim(programSlug: string, claim: ListenerAccessClaim): boolean {
    return writeListenerAccessValue(
        listenerAccessStorageKey(programSlug, 'accessClaim'),
        JSON.stringify(claim),
    );
}

export function clearStoredAccessClaim(programSlug: string): boolean {
    return clearListenerAccessValue(listenerAccessStorageKey(programSlug, 'accessClaim'));
}

export function readStoredAccessToken(programSlug: string): StoredAccessResult<string> {
    return readListenerAccessValue(listenerAccessStorageKey(programSlug, 'accessToken'));
}

export function storeAccessToken(programSlug: string, accessToken: string): boolean {
    return writeListenerAccessValue(
        listenerAccessStorageKey(programSlug, 'accessToken'),
        accessToken,
    );
}

export function clearStoredAccessToken(programSlug: string): boolean {
    return clearListenerAccessValue(listenerAccessStorageKey(programSlug, 'accessToken'));
}
