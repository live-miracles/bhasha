import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError } from '../api/client';
import { createPublicApi, type PublicApi } from '../api/public';
import {
    createVolunteerApi,
    isVolunteerApiError,
    type VolunteerApi,
    type VolunteerApproveInput,
} from '../api/volunteer';
import { detectInAppBrowser } from './inAppBrowser';
import { createQrScanner, normalizeQrScannerError } from './qrScanner';

const SCAN_DEBOUNCE_MS = 2_500;
const RESULT_FLASH_MS = 500;
const RESULT_BANNER_MS = 2_800;
const CROCKFORD_32 = /[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]/g;

type ScreenWakeLockSentinel = {
    release(): Promise<void>;
};

type ScreenWakeLockNavigator = Navigator & {
    wakeLock?: {
        request(type: 'screen'): Promise<ScreenWakeLockSentinel>;
    };
};

type AuthState = 'checking' | 'loggedOut' | 'loggedIn' | 'loggingOut' | 'programMissing';
type FeedbackKind = 'approved' | 'already' | 'notFound' | 'revoked' | 'rateLimited' | 'error';

type ApprovalOutcome = {
    kind: 'approved' | 'already' | 'not_found' | 'revoked' | 'rate_limited' | 'error';
};

interface VolunteerFeedback {
    kind: FeedbackKind;
    message: string;
}

export interface VolunteerRouteProps {
    programSlug: string;
    publicApi?: PublicApi;
    volunteerApi?: VolunteerApi;
}

export function VolunteerRoute({
    programSlug,
    publicApi: publicApiProp,
    volunteerApi: volunteerApiProp,
}: VolunteerRouteProps) {
    const publicApi = useMemo(() => publicApiProp ?? createPublicApi(), [publicApiProp]);
    const volunteerApi = useMemo(
        () => volunteerApiProp ?? createVolunteerApi(),
        [volunteerApiProp],
    );
    const inAppBrowser = useMemo(() => detectInAppBrowser(), []);
    const [auth, setAuth] = useState<AuthState>('checking');
    const [programName, setProgramName] = useState(programSlug);
    const [approvedCount, setApprovedCount] = useState(0);
    const [loginId, setLoginId] = useState('');
    const [password, setPassword] = useState('');
    const [loginError, setLoginError] = useState<string | null>(null);
    const [loginPending, setLoginPending] = useState(false);
    const [manualCode, setManualCode] = useState('');
    const [manualPending, setManualPending] = useState(false);
    const [cameraError, setCameraError] = useState<'denied' | 'unavailable' | null>(null);
    const [feedback, setFeedback] = useState<VolunteerFeedback | null>(null);
    const [flashKind, setFlashKind] = useState<FeedbackKind | null>(null);
    const [pendingDeepLink, setPendingDeepLink] = useState(() =>
        claimFromHash(window.location.hash),
    );
    const scanTimesRef = useRef(new Map<string, number>());
    const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useScreenWakeLock(auth === 'loggedIn');

    useEffect(() => {
        function handleHashChange() {
            setPendingDeepLink(claimFromHash(window.location.hash));
        }

        window.addEventListener('hashchange', handleHashChange);
        return () => {
            window.removeEventListener('hashchange', handleHashChange);
        };
    }, []);

    useEffect(() => {
        let active = true;
        setAuth('checking');

        void (async () => {
            try {
                const metadata = await publicApi.fetchProgram(programSlug);
                if (!active) {
                    return;
                }
                setProgramName(metadata.program.name);
            } catch (error) {
                if (!active) {
                    return;
                }
                if (error instanceof ApiError && error.code === 'program_not_found') {
                    setAuth('programMissing');
                    return;
                }
            }

            try {
                const currentSession = await volunteerApi.session();
                if (!active) {
                    return;
                }
                setProgramName(currentSession.program.name);
                setApprovedCount(currentSession.approvedCount);
                setAuth('loggedIn');
            } catch (_error) {
                if (active) {
                    setAuth('loggedOut');
                }
            }
        })();

        return () => {
            active = false;
        };
    }, [programSlug, publicApi, volunteerApi]);

    useEffect(() => {
        return () => {
            if (flashTimerRef.current) {
                clearTimeout(flashTimerRef.current);
            }
            if (bannerTimerRef.current) {
                clearTimeout(bannerTimerRef.current);
            }
        };
    }, []);

    useEffect(() => {
        if (auth !== 'loggingOut') {
            return undefined;
        }

        let active = true;
        void volunteerApi
            .logout()
            .catch(() => undefined)
            .finally(() => {
                if (active) {
                    setAuth('loggedOut');
                }
            });

        return () => {
            active = false;
        };
    }, [auth, volunteerApi]);

    const showFeedback = useCallback((next: VolunteerFeedback) => {
        if (flashTimerRef.current) {
            clearTimeout(flashTimerRef.current);
        }
        if (bannerTimerRef.current) {
            clearTimeout(bannerTimerRef.current);
        }

        setFeedback(next);
        setFlashKind(next.kind);
        flashTimerRef.current = setTimeout(() => {
            setFlashKind(null);
            flashTimerRef.current = null;
        }, RESULT_FLASH_MS);
        bannerTimerRef.current = setTimeout(() => {
            setFeedback(null);
            bannerTimerRef.current = null;
        }, RESULT_BANNER_MS);
    }, []);

    const approve = useCallback(
        async (input: VolunteerApproveInput, displayCode: string): Promise<ApprovalOutcome> => {
            try {
                const result = await volunteerApi.approve(input);
                if (result.already) {
                    showFeedback({
                        kind: 'already',
                        message: `Already in: ${displayCode} was already approved.`,
                    });
                    return { kind: 'already' };
                }

                setApprovedCount((current) => current + 1);
                showFeedback({
                    kind: 'approved',
                    message: `Approved: ${displayCode}`,
                });
                navigator.vibrate?.(50);
                return { kind: 'approved' };
            } catch (error) {
                if (isVolunteerApiError(error)) {
                    if (error.code === 'claim_not_found') {
                        showFeedback({
                            kind: 'notFound',
                            message: 'Not found: Check the code and try again.',
                        });
                        return { kind: 'not_found' };
                    }
                    if (error.code === 'claim_revoked') {
                        showFeedback({
                            kind: 'revoked',
                            message: 'Revoked: This access request was revoked.',
                        });
                        return { kind: 'revoked' };
                    }
                    if (error.code === 'too_many_attempts') {
                        showFeedback({
                            kind: 'rateLimited',
                            message: 'Too many tries — wait a minute.',
                        });
                        return { kind: 'rate_limited' };
                    }
                    if (error.code === 'volunteer_auth_required') {
                        setAuth('loggedOut');
                        setPassword('');
                        setLoginError('Your volunteer session ended. Log in again.');
                        return { kind: 'error' };
                    }
                }

                showFeedback({
                    kind: 'error',
                    message: 'Could not approve: Please try again.',
                });
                return { kind: 'error' };
            }
        },
        [showFeedback, volunteerApi],
    );

    const handleScan = useCallback(
        (scannedValue: string) => {
            const normalizedValue = scannedValue.trim();
            const now = Date.now();
            for (const [value, scannedAt] of scanTimesRef.current) {
                if (now - scannedAt >= SCAN_DEBOUNCE_MS) {
                    scanTimesRef.current.delete(value);
                }
            }
            const previousScan = scanTimesRef.current.get(normalizedValue);
            if (previousScan !== undefined && now - previousScan < SCAN_DEBOUNCE_MS) {
                return;
            }
            scanTimesRef.current.set(normalizedValue, now);

            const claimId = claimFromScannedValue(normalizedValue);
            if (!claimId) {
                showFeedback({
                    kind: 'notFound',
                    message: 'Not found: This QR code has no access request.',
                });
                return;
            }

            void approve({ claimId }, shortDisplayCode(claimId));
        },
        [approve, showFeedback],
    );

    const handleCameraError = useCallback((error: unknown) => {
        setCameraError(
            normalizeQrScannerError(error).kind === 'permission-denied' ? 'denied' : 'unavailable',
        );
    }, []);

    async function submitLogin(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setLoginError(null);
        setLoginPending(true);
        try {
            await volunteerApi.login({
                programSlug,
                loginId: loginId.trim(),
                password,
            });
            const currentSession = await volunteerApi.session();
            setProgramName(currentSession.program.name);
            setApprovedCount(currentSession.approvedCount);
            setPassword('');
            setAuth('loggedIn');
        } catch (error) {
            setLoginError(messageForLoginError(error));
        } finally {
            setLoginPending(false);
        }
    }

    function logout() {
        setApprovedCount(0);
        setPassword('');
        setAuth('loggingOut');
    }

    async function submitManualCode(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!manualCode || manualPending) {
            return;
        }
        setManualPending(true);
        try {
            const outcome = await approve({ shortCode: manualCode }, manualCode);
            if (outcome.kind === 'approved' || outcome.kind === 'already') {
                setManualCode('');
            }
        } finally {
            setManualPending(false);
        }
    }

    function changeManualCode(value: string) {
        setManualCode(value.toUpperCase().replace(CROCKFORD_32, ''));
    }

    async function confirmDeepLink() {
        if (!pendingDeepLink) {
            return;
        }
        const claimId = pendingDeepLink;
        const label = shortDisplayCode(claimId);
        setPendingDeepLink(null);
        clearLocationHash();
        await approve({ claimId }, label);
    }

    function dismissDeepLink() {
        setPendingDeepLink(null);
        clearLocationHash();
    }

    return (
        <main aria-label="Volunteer shell" className="shell shell-volunteer">
            <section className="volunteer-screen">
                {auth === 'checking' ? (
                    <p className="translator-checking">Checking volunteer access...</p>
                ) : null}

                {auth === 'loggingOut' ? (
                    <p className="translator-checking">Logging out...</p>
                ) : null}

                {auth === 'programMissing' ? (
                    <p className="lp-info" role="status">
                        This program does not exist.
                    </p>
                ) : null}

                {auth === 'loggedOut' ? (
                    <>
                        <div className="translator-login-head">
                            <p className="eyebrow">Volunteer access</p>
                            <h1>{programName}</h1>
                        </div>
                        <form className="translator-login" onSubmit={submitLogin}>
                            <h2>Volunteer login</h2>
                            {loginError ? (
                                <p className="translator-alert" role="alert">
                                    {loginError}
                                </p>
                            ) : null}
                            <label>
                                Login ID
                                <input
                                    autoComplete="username"
                                    onChange={(event) => setLoginId(event.target.value)}
                                    required
                                    type="text"
                                    value={loginId}
                                />
                            </label>
                            <label>
                                Password
                                <input
                                    autoComplete="current-password"
                                    onChange={(event) => setPassword(event.target.value)}
                                    required
                                    type="password"
                                    value={password}
                                />
                            </label>
                            <button className="lp-btn" disabled={loginPending} type="submit">
                                {loginPending ? 'Logging in...' : 'Log in'}
                            </button>
                        </form>
                    </>
                ) : null}

                {auth === 'loggedIn' ? (
                    <>
                        <header className="volunteer-topbar">
                            <strong>{approvedCount} approved</strong>
                            <button onClick={() => void logout()} type="button">
                                Log out
                            </button>
                        </header>

                        <div className="volunteer-heading">
                            <p className="eyebrow">{programName}</p>
                            <h1>Approve listener access</h1>
                        </div>

                        {pendingDeepLink ? (
                            <section
                                className="volunteer-deep-link-confirm"
                                aria-label="Confirm approval"
                            >
                                <strong>Approve code {shortDisplayCode(pendingDeepLink)}?</strong>
                                <p>Only approve a code shown to you by someone at the event.</p>
                                <div>
                                    <button
                                        className="lp-btn"
                                        onClick={() => void confirmDeepLink()}
                                        type="button"
                                    >
                                        Approve {shortDisplayCode(pendingDeepLink)}
                                    </button>
                                    <button onClick={dismissDeepLink} type="button">
                                        Cancel
                                    </button>
                                </div>
                            </section>
                        ) : null}

                        {feedback ? (
                            <p
                                className={`volunteer-result-banner volunteer-result-${feedback.kind}`}
                                role="status"
                                aria-live="polite"
                            >
                                {feedback.message}
                            </p>
                        ) : null}

                        <section className="volunteer-scanner-panel" aria-label="Camera scanner">
                            <h2>Scan a listener QR code</h2>
                            <VolunteerScanner
                                onCameraError={handleCameraError}
                                onScan={handleScan}
                            />
                            {cameraError ? (
                                <div className="volunteer-camera-help">
                                    <strong>
                                        {cameraError === 'denied'
                                            ? 'Camera access was denied. Enter the short code instead.'
                                            : "A camera isn't available. Enter the short code instead."}
                                    </strong>
                                    <p>
                                        {inAppBrowser.isInApp
                                            ? 'Open this page in Safari or Chrome to use the camera'
                                            : "You can also use your phone's Camera app to open the volunteer link."}
                                    </p>
                                </div>
                            ) : null}
                        </section>

                        <form
                            className={`volunteer-manual-panel${
                                cameraError ? ' volunteer-manual-primary' : ''
                            }`}
                            data-testid="manual-code-panel"
                            onSubmit={submitManualCode}
                        >
                            <h2>Enter a short code</h2>
                            <label htmlFor="volunteer-short-code">Short code</label>
                            <input
                                autoCapitalize="characters"
                                autoComplete="off"
                                className="volunteer-code-input"
                                id="volunteer-short-code"
                                inputMode="text"
                                maxLength={12}
                                onChange={(event) => changeManualCode(event.target.value)}
                                placeholder="ABC234"
                                spellCheck={false}
                                type="text"
                                value={manualCode}
                            />
                            <button
                                className="lp-btn"
                                disabled={!manualCode || manualPending}
                                type="submit"
                            >
                                {manualPending ? 'Approving...' : 'Approve code'}
                            </button>
                        </form>

                        {flashKind ? (
                            <div
                                aria-hidden="true"
                                className={`volunteer-result-flash volunteer-result-${flashKind}`}
                            />
                        ) : null}
                    </>
                ) : null}
            </section>
        </main>
    );
}

function VolunteerScanner({
    onScan,
    onCameraError,
}: {
    onScan(value: string): void;
    onCameraError(error: unknown): void;
}) {
    const videoRef = useRef<HTMLVideoElement | null>(null);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) {
            return undefined;
        }

        let active = true;
        const scanner = createQrScanner({ video, onScan });
        void scanner.start().catch((error: unknown) => {
            if (active) {
                onCameraError(error);
            }
        });

        return () => {
            active = false;
            scanner.destroy();
        };
    }, [onCameraError, onScan]);

    return (
        <div className="volunteer-video-frame">
            <video
                aria-label="Scan a listener access QR code"
                autoPlay
                muted
                playsInline
                ref={videoRef}
            />
        </div>
    );
}

function useScreenWakeLock(active: boolean) {
    const wakeLockRef = useRef<ScreenWakeLockSentinel | null>(null);

    useEffect(() => {
        if (!active) {
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
                // Wake Lock is best-effort. Scanning must continue if it is unsupported.
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
    }, [active]);
}

function messageForLoginError(error: unknown): string {
    if (isVolunteerApiError(error)) {
        if (error.code === 'invalid_credentials') {
            return "That login or password isn't right. Check with the event organiser.";
        }
        if (error.code === 'too_many_attempts') {
            return 'Too many attempts right now — try again in a minute.';
        }
        if (error.code === 'volunteer_not_configured') {
            return "Volunteer access isn't set up for this program. Check with the event organiser.";
        }
        if (error.code === 'service_unavailable') {
            return 'Volunteer access is unavailable right now. Please try again.';
        }
    }

    return 'Login failed. Please try again.';
}

function claimFromHash(hash: string): string | null {
    if (!hash.startsWith('#')) {
        return null;
    }
    const claimId = new URLSearchParams(hash.slice(1)).get('claim')?.trim();
    return claimId || null;
}

export function claimFromScannedValue(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }

    try {
        const url = new URL(trimmed, window.location.href);
        const claimId = claimFromHash(url.hash);
        if (claimId) {
            return claimId;
        }
    } catch (_error) {
        // A bare claim ID is accepted below for defensive interoperability.
    }

    return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

function shortDisplayCode(value: string): string {
    const safe = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    return safe.slice(-6) || 'UNKNOWN';
}

function clearLocationHash() {
    window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${window.location.search}`,
    );
}
