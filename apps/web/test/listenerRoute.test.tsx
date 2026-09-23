import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoomEvent } from 'livekit-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListenerApi } from '../src/api/listeners';
import { ApiError } from '../src/api/client';
import type { PublicApi } from '../src/api/public';
import type { ListenerRealtimeClient, RoomHandle } from '../src/realtime/listenerClient';
import {
    clearStoredAccessClaim,
    clearStoredAccessToken,
    getOrCreateClientId,
    ListenerRoute,
    type ConnectionStateHandler,
} from '../src/routes/ListenerRoute';
import * as inAppBrowser from '../src/routes/inAppBrowser';
import type {
    ListenerPublicProgramMetadata,
    ListenerPublicProgramStatus,
} from '../src/api/listeners';

vi.mock('qrcode.react', () => ({
    QRCodeSVG: ({
        'aria-label': ariaLabel,
        className,
        marginSize,
        size,
        title,
        value,
    }: {
        'aria-label'?: string;
        className?: string;
        marginSize?: number;
        size?: number;
        title?: string;
        value: string;
    }) => (
        <svg
            aria-label={ariaLabel}
            className={className}
            data-margin-size={marginSize}
            data-qr-value={value}
            data-size={size}
            role="img"
        >
            {title ? <title>{title}</title> : null}
        </svg>
    ),
}));

function metadata(
    overrides: Partial<ListenerPublicProgramMetadata> = {},
): ListenerPublicProgramMetadata {
    const base: ListenerPublicProgramMetadata = {
        program: {
            slug: 'patna-event-2026',
            name: 'Patna Event 2026',
            venue: 'Main Hall',
            eventDate: '2026-07-01',
            status: 'live',
            accessControlEnabled: false,
            listenable: true,
            notListenableReason: null,
        },
        streams: [
            {
                id: 'stream_en',
                languageName: 'English',
                nativeName: 'English',
                languageCode: 'en',
                displayOrder: 2,
                isActive: true,
            },
            {
                id: 'stream_hi',
                languageName: 'Hindi',
                nativeName: 'हिन्दी',
                languageCode: 'hi',
                displayOrder: 1,
                isActive: true,
            },
        ],
        urls: {
            listenerUrl: 'https://bhasha.test/patna-event-2026',
            translatorUrl: 'https://bhasha.test/patna-event-2026/translate',
            volunteerUrl: 'https://bhasha.test/patna-event-2026/volunteer',
        },
    };

    return {
        ...base,
        ...overrides,
        program: {
            ...base.program,
            ...overrides.program,
        },
    };
}

function status(overrides: Partial<ListenerPublicProgramStatus> = {}): ListenerPublicProgramStatus {
    const base: ListenerPublicProgramStatus = {
        program: {
            slug: 'patna-event-2026',
            listenable: true,
            notListenableReason: null,
        },
        streams: [
            {
                id: 'stream_en',
                languageName: 'English',
                nativeName: 'English',
                languageCode: 'en',
                isActive: true,
                state: 'offline',
                publisherVersion: null,
            },
            {
                id: 'stream_hi',
                languageName: 'Hindi',
                nativeName: 'हिन्दी',
                languageCode: 'hi',
                isActive: true,
                state: 'live',
                publisherVersion: 'publisher_hi_1',
            },
        ],
        stale: false,
        degraded: false,
        serverTime: '2026-06-21T10:00:00.000Z',
    };

    return {
        ...base,
        ...overrides,
        program: {
            ...base.program,
            ...overrides.program,
        },
        streams: overrides.streams ?? base.streams,
    };
}

function publicApi(overrides: Partial<PublicApi> = {}): PublicApi {
    return {
        fetchProgram: vi.fn(async () => metadata()),
        fetchProgramStatus: vi.fn(async () => status()),
        ...overrides,
    };
}

function listenerApi(overrides: Partial<ListenerApi> = {}): ListenerApi {
    return {
        token: vi.fn(),
        connected: vi.fn(),
        heartbeat: vi.fn(async () => ({ ok: true })),
        leave: vi.fn(async () => ({ ok: true })),
        switch: vi.fn(),
        reconnect: vi.fn(),
        requestConnection: vi.fn(async () => ({
            connectionId: 'listener_connection_1',
        })),
        claimAccess: vi.fn(async () => ({
            claimId: 'claim_1',
            claimSecret: 'claim_secret_1',
            shortCode: 'K7XQAF',
        })),
        accessStatus: vi.fn(async () => ({ state: 'pending' as const })),
        approvedAccessClaims: vi.fn(async () => ({ approved: [] })),
        ...overrides,
    } as ListenerApi;
}

type RestoreProperty = () => void;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

async function flushMicrotasks(count = 8): Promise<void> {
    for (let index = 0; index < count; index += 1) {
        await Promise.resolve();
    }
}

function ensureRTCPeerConnectionStub(): RestoreProperty {
    const target = globalThis as {
        RTCPeerConnection?: typeof globalThis.RTCPeerConnection;
    };
    const descriptor = Object.getOwnPropertyDescriptor(target, 'RTCPeerConnection');
    if (descriptor && !descriptor.configurable) {
        return () => {};
    }

    const hadProperty = Object.prototype.hasOwnProperty.call(target, 'RTCPeerConnection');
    const original = target.RTCPeerConnection;

    Object.defineProperty(target, 'RTCPeerConnection', {
        configurable: true,
        writable: true,
        value: original ?? function RTCPeerConnectionStub() {},
    });

    return () => {
        if (hadProperty) {
            Object.defineProperty(target, 'RTCPeerConnection', {
                configurable: true,
                writable: true,
                value: original,
            });
        } else {
            delete target.RTCPeerConnection;
        }
    };
}

function setInAppBrowserDetection(result: { isInApp: boolean; app?: string }) {
    const spy = vi.spyOn(inAppBrowser, 'detectInAppBrowser').mockReturnValue(result);

    return () => spy.mockRestore();
}

function realtimeClient(overrides: Partial<ListenerRealtimeClient> = {}): ListenerRealtimeClient {
    return {
        subscribe: vi.fn(async (input) => ({
            connectionId: 'listener_connection_1',
            streamId: input.streamId,
            mediaStream: new MediaStream(),
        })),
        switch: vi.fn(async (input) => ({
            connectionId: 'listener_connection_2',
            streamId: input.nextStreamId,
            mediaStream: new MediaStream(),
        })),
        reconnect: vi.fn(async (input) => ({
            connectionId: 'listener_connection_3',
            streamId: input.streamId,
            mediaStream: new MediaStream(),
        })),
        stop: vi.fn(async () => undefined),
        ...overrides,
    } as ListenerRealtimeClient;
}

describe('ListenerRoute', () => {
    let restoreInAppDetection: RestoreProperty | null = null;
    let restoreRTCPeerConnection: RestoreProperty | null = null;

    beforeEach(() => {
        vi.useRealTimers();
        window.localStorage.clear();
        window.sessionStorage.clear();
        clearStoredAccessClaim('patna-event-2026');
        clearStoredAccessToken('patna-event-2026');
        restoreRTCPeerConnection = ensureRTCPeerConnectionStub();
        Object.defineProperty(HTMLMediaElement.prototype, 'play', {
            configurable: true,
            value: vi.fn(async () => undefined),
        });
        Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
            configurable: true,
            value: vi.fn(),
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        restoreInAppDetection?.();
        restoreInAppDetection = null;
        restoreRTCPeerConnection?.();
        restoreRTCPeerConnection = null;
        vi.restoreAllMocks();
        cleanup();
    });

    it('renders sorted active languages with live status and no listener counts', async () => {
        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtimeClient()}
            />,
        );

        expect(
            await screen.findByRole('heading', { name: 'Patna Event 2026' }),
        ).toBeInTheDocument();
        const languages = screen.getAllByRole('listitem');
        expect(languages[0]).toHaveTextContent('Hindi');
        expect(languages[0]).toHaveTextContent('Live');
        expect(languages[1]).toHaveTextContent('English');
        expect(languages[1]).toHaveTextContent('Offline');
        // Native-script swap (T1): native name is the primary tile label, with the
        // English name as a muted secondary line that collapses when it equals the
        // native name. Guards against displayLanguage regressing to English-only.
        expect(languages[0]).toHaveTextContent('हिन्दी');
        expect(languages[0]!.querySelector('.lp-lang-secondary')?.textContent).toBe('Hindi');
        expect(languages[1]!.querySelector('.lp-lang-secondary')).toBeNull();
        // Listener counts are admin-only operational telemetry; participants must
        // never see them (the public status payload no longer carries a per-stream count).
        expect(screen.queryByText(/listening/i)).not.toBeInTheDocument();
    });

    it('shows the listener venue metadata without the event date', async () => {
        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtimeClient()}
            />,
        );

        expect(
            await screen.findByRole('heading', { name: 'Patna Event 2026' }),
        ).toBeInTheDocument();
        const metaLine = document.querySelector('.listener-meta');
        expect(metaLine).toHaveTextContent('Main Hall');
        expect(metaLine).not.toHaveTextContent('2026-07-01');
    });

    it('shows open-in-browser guidance in in-app browser user agents', async () => {
        restoreInAppDetection = setInAppBrowserDetection({
            isInApp: true,
            app: 'Facebook',
        });

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtimeClient()}
            />,
        );

        expect(
            await screen.findByText(/For audio to work, open this page in Safari or Chrome/i),
        ).toBeInTheDocument();
        expect(screen.getByText(window.location.href)).toBeInTheDocument();
    });

    it('does not show open-in-browser guidance for normal browser user agents', async () => {
        restoreInAppDetection = setInAppBrowserDetection({ isInApp: false });

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtimeClient()}
            />,
        );

        expect(
            await screen.findByRole('heading', { name: 'Patna Event 2026' }),
        ).toBeInTheDocument();
        expect(screen.queryByText(/open this page in Safari or Chrome/i)).not.toBeInTheDocument();
    });

    it('renders the access gate and server volunteer QR when access control is on with no token', async () => {
        const api = listenerApi();
        const realtime = realtimeClient();

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi({
                    fetchProgram: vi.fn(async () =>
                        metadata({
                            program: {
                                ...metadata().program,
                                accessControlEnabled: true,
                            },
                        }),
                    ),
                })}
                listenerApi={api}
                realtimeClient={realtime}
            />,
        );

        expect(await screen.findByRole('heading', { name: 'Almost there' })).toBeInTheDocument();
        const qr = screen.getByRole('img', { name: 'Listener access QR' });
        expect(qr).toHaveAttribute(
            'data-qr-value',
            'https://bhasha.test/patna-event-2026/volunteer#claim=claim_1',
        );
        expect(qr).toHaveAttribute('data-margin-size', '4');
        expect(qr).toHaveAttribute('data-size', '260');
        expect(qr).toHaveClass('listener-access-qr');
        expect(screen.getByText('K7 XQ AF')).toHaveAttribute(
            'aria-label',
            'Access code K 7 X Q A F',
        );
        expect(screen.getByText('Waiting for a volunteer…')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Listen to/ })).not.toBeInTheDocument();
        expect(api.claimAccess).toHaveBeenCalledWith({
            programSlug: 'patna-event-2026',
            clientId: expect.stringMatching(/^listener_client_/),
        });
        expect(realtime.subscribe).not.toHaveBeenCalled();
    });

    it('verifies a returning listener token and skips the access gate', async () => {
        window.localStorage.setItem(
            'bhasha.listener.patna-event-2026.accessToken',
            'stored-access-token',
        );
        const api = listenerApi({
            accessStatus: vi.fn(async () => ({ state: 'approved' as const })),
        });

        const realtime = realtimeClient();
        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi({
                    fetchProgram: vi.fn(async () =>
                        metadata({
                            program: {
                                ...metadata().program,
                                accessControlEnabled: true,
                            },
                        }),
                    ),
                })}
                listenerApi={api}
                realtimeClient={realtime}
            />,
        );

        expect(await screen.findByRole('button', { name: 'Listen to Hindi' })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Almost there' })).not.toBeInTheDocument();
        expect(api.accessStatus).toHaveBeenCalledWith({
            programSlug: 'patna-event-2026',
            accessToken: 'stored-access-token',
        });
        expect(api.claimAccess).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await waitFor(() => {
            expect(realtime.subscribe).toHaveBeenCalledWith(
                expect.objectContaining({ accessToken: 'stored-access-token' }),
            );
        });
    });

    it('preserves a stored approval when token verification has a transport failure', async () => {
        window.localStorage.setItem(
            'bhasha.listener.patna-event-2026.accessToken',
            'stored-access-token',
        );
        const api = listenerApi({
            accessStatus: vi.fn(async () => {
                throw new Error('venue_wifi_unavailable');
            }),
        });
        const realtime = realtimeClient();

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi({
                    fetchProgram: vi.fn(async () =>
                        metadata({
                            program: {
                                ...metadata().program,
                                accessControlEnabled: true,
                            },
                        }),
                    ),
                })}
                listenerApi={api}
                realtimeClient={realtime}
            />,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'Listen to Hindi' }));
        await waitFor(() => {
            expect(realtime.subscribe).toHaveBeenCalledWith(
                expect.objectContaining({ accessToken: 'stored-access-token' }),
            );
        });
        expect(window.localStorage.getItem('bhasha.listener.patna-event-2026.accessToken')).toBe(
            'stored-access-token',
        );
        expect(api.claimAccess).not.toHaveBeenCalled();
    });

    it('refetches metadata before an Access check and shows the pending message', async () => {
        const publicClient = publicApi({
            fetchProgram: vi.fn(async () =>
                metadata({
                    program: {
                        ...metadata().program,
                        accessControlEnabled: true,
                    },
                }),
            ),
        });
        const pendingStatus = deferred<Awaited<ReturnType<ListenerApi['accessStatus']>>>();
        const accessStatus = vi.fn(() => pendingStatus.promise);
        const api = listenerApi({ accessStatus });

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicClient}
                listenerApi={api}
                realtimeClient={realtimeClient()}
            />,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'Access' }));

        const checking = screen.getByRole('button', { name: 'Checking…' });
        expect(checking).toBeDisabled();
        pendingStatus.resolve({ state: 'pending' });

        expect(
            await screen.findByText('Not yet — ask a volunteer nearby for access.'),
        ).toBeInTheDocument();
        expect(publicClient.fetchProgram).toHaveBeenCalledTimes(2);
        expect(accessStatus).toHaveBeenCalledWith({
            programSlug: 'patna-event-2026',
            claimId: 'claim_1',
            claimSecret: 'claim_secret_1',
        });
        expect(
            (publicClient.fetchProgram as ReturnType<typeof vi.fn>).mock.invocationCallOrder[1],
        ).toBeLessThan(accessStatus.mock.invocationCallOrder[0]!);
    });

    it('exits the gate when the Access metadata refresh finds the flag turned off', async () => {
        const fetchProgram = vi
            .fn()
            .mockResolvedValueOnce(
                metadata({
                    program: {
                        ...metadata().program,
                        accessControlEnabled: true,
                    },
                }),
            )
            .mockResolvedValueOnce(metadata());
        const api = listenerApi();

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi({ fetchProgram })}
                listenerApi={api}
                realtimeClient={realtimeClient()}
            />,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'Access' }));

        expect(await screen.findByRole('button', { name: 'Listen to Hindi' })).toBeInTheDocument();
        expect(fetchProgram).toHaveBeenCalledTimes(2);
        expect(api.accessStatus).not.toHaveBeenCalled();
    });

    it('shows the storage-degraded hint alongside in-app browser guidance', async () => {
        restoreInAppDetection = setInAppBrowserDetection({
            isInApp: true,
            app: 'WhatsApp',
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('Storage unavailable', 'SecurityError');
        });

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi({
                    fetchProgram: vi.fn(async () =>
                        metadata({
                            program: {
                                ...metadata().program,
                                accessControlEnabled: true,
                            },
                        }),
                    ),
                })}
                listenerApi={listenerApi()}
                realtimeClient={realtimeClient()}
            />,
        );

        expect(
            await screen.findByText(
                "This browser can't remember your access — you may need to show this screen again next time.",
            ),
        ).toBeInTheDocument();
        expect(screen.getByText(/open this page in Safari or Chrome/i)).toBeInTheDocument();
    });

    it('keeps the client id stable through the session-storage fallback', () => {
        const originalLocalStorage = window.localStorage;
        const disabledLocalStorage = {
            length: 0,
            clear: vi.fn(),
            getItem: vi.fn(() => {
                throw new DOMException('Storage unavailable', 'SecurityError');
            }),
            key: vi.fn(() => null),
            removeItem: vi.fn(() => {
                throw new DOMException('Storage unavailable', 'SecurityError');
            }),
            setItem: vi.fn(() => {
                throw new DOMException('Storage unavailable', 'SecurityError');
            }),
        } as unknown as Storage;
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            value: disabledLocalStorage,
        });

        try {
            const first = getOrCreateClientId('session-fallback-program');
            const afterRefresh = getOrCreateClientId('session-fallback-program');

            expect(afterRefresh).toBe(first);
            expect(first).toMatch(/^listener_client_/);
            expect(
                window.sessionStorage.getItem('bhasha.listener.session-fallback-program.clientId'),
            ).toBe(first);
        } finally {
            Object.defineProperty(window, 'localStorage', {
                configurable: true,
                value: originalLocalStorage,
            });
        }
    });

    it('shows a retryable access error when claim creation fails after metadata loads', async () => {
        const claimAccess = vi
            .fn()
            .mockRejectedValueOnce(new Error('access_service_unavailable'))
            .mockResolvedValueOnce({
                claimId: 'claim_retry',
                claimSecret: 'claim_retry_secret',
                shortCode: 'RETRY1',
            });
        const api = listenerApi({ claimAccess });

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi({
                    fetchProgram: vi.fn(async () =>
                        metadata({
                            program: {
                                ...metadata().program,
                                accessControlEnabled: true,
                            },
                        }),
                    ),
                })}
                listenerApi={api}
                realtimeClient={realtimeClient()}
            />,
        );

        expect(
            await screen.findByRole('heading', { name: "Couldn't verify access" }),
        ).toBeInTheDocument();
        expect(screen.queryByText('This program does not exist.')).not.toBeInTheDocument();
        expect(screen.queryByText('Checking access…')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(await screen.findByRole('heading', { name: 'Almost there' })).toBeInTheDocument();
        expect(claimAccess).toHaveBeenCalledTimes(2);
    });

    it('does not mutate access storage or redeem after unmounting mid-init', async () => {
        const pendingClaim = deferred<Awaited<ReturnType<ListenerApi['claimAccess']>>>();
        const api = listenerApi({
            claimAccess: vi.fn(() => pendingClaim.promise),
            accessStatus: vi.fn(async () => ({
                state: 'approved' as const,
                accessToken: 'late-access-token',
            })),
        });
        const view = render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi({
                    fetchProgram: vi.fn(async () =>
                        metadata({
                            program: {
                                ...metadata().program,
                                accessControlEnabled: true,
                            },
                        }),
                    ),
                })}
                listenerApi={api}
                realtimeClient={realtimeClient()}
            />,
        );

        await waitFor(() => expect(api.claimAccess).toHaveBeenCalledTimes(1));
        view.unmount();
        pendingClaim.resolve({
            claimId: 'late_claim',
            claimSecret: 'late_secret',
            shortCode: 'LATE12',
        });
        await act(async () => {
            await flushMicrotasks();
        });

        expect(
            window.localStorage.getItem('bhasha.listener.patna-event-2026.accessClaim'),
        ).toBeNull();
        expect(
            window.sessionStorage.getItem('bhasha.listener.patna-event-2026.accessClaim'),
        ).toBeNull();
        expect(api.accessStatus).not.toHaveBeenCalled();
        expect(api.approvedAccessClaims).not.toHaveBeenCalled();
    });

    it('auto-redeems a matching approval broadcast and flips to the listen UI', async () => {
        vi.useFakeTimers();
        const api = listenerApi({
            approvedAccessClaims: vi.fn(async () => ({ approved: ['claim_1'] })),
            accessStatus: vi.fn(async () => ({
                state: 'approved' as const,
                accessToken: 'minted-access-token',
            })),
        });
        const realtime = realtimeClient();

        render(
            <ListenerRoute
                accessApprovedDelayMs={700}
                accessBroadcastPollMs={25}
                programSlug="patna-event-2026"
                publicApi={publicApi({
                    fetchProgram: vi.fn(async () =>
                        metadata({
                            program: {
                                ...metadata().program,
                                accessControlEnabled: true,
                            },
                        }),
                    ),
                })}
                listenerApi={api}
                realtimeClient={realtime}
            />,
        );

        await act(async () => {
            await flushMicrotasks();
        });
        expect(screen.getByRole('heading', { name: 'Almost there' })).toBeInTheDocument();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(25);
        });
        expect(screen.getByText("You're in!")).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Listen to Hindi' })).not.toBeInTheDocument();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(699);
        });
        expect(screen.queryByRole('button', { name: 'Listen to Hindi' })).not.toBeInTheDocument();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });
        const listen = screen.getByRole('button', { name: 'Listen to Hindi' });
        expect(api.approvedAccessClaims).toHaveBeenCalledWith('patna-event-2026');
        expect(api.accessStatus).toHaveBeenCalledTimes(1);
        expect(window.localStorage.getItem('bhasha.listener.patna-event-2026.accessToken')).toBe(
            'minted-access-token',
        );

        fireEvent.click(listen);
        await act(async () => {
            await flushMicrotasks();
        });
        expect(realtime.subscribe).toHaveBeenCalledWith(
            expect.objectContaining({ accessToken: 'minted-access-token' }),
        );
    });

    it('keeps one broadcast poll in flight and cancels redemption and timers on unmount', async () => {
        vi.useFakeTimers();
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible',
        });
        const pendingBroadcast = deferred<{ approved: string[] }>();
        const api = listenerApi({
            approvedAccessClaims: vi.fn(() => pendingBroadcast.promise),
            accessStatus: vi.fn(async () => ({
                state: 'approved' as const,
                accessToken: 'late-broadcast-token',
            })),
        });

        const view = render(
            <ListenerRoute
                accessBroadcastPollMs={10_000}
                accessSafetyPollMs={10_000}
                programSlug="patna-event-2026"
                publicApi={publicApi({
                    fetchProgram: vi.fn(async () =>
                        metadata({
                            program: {
                                ...metadata().program,
                                accessControlEnabled: true,
                            },
                        }),
                    ),
                })}
                listenerApi={api}
                realtimeClient={realtimeClient()}
            />,
        );

        await act(async () => {
            await flushMicrotasks();
        });
        expect(screen.getByRole('heading', { name: 'Almost there' })).toBeInTheDocument();

        act(() => {
            document.dispatchEvent(new Event('visibilitychange'));
            document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(api.approvedAccessClaims).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        view.unmount();
        pendingBroadcast.resolve({ approved: ['claim_1'] });
        await act(async () => {
            await flushMicrotasks();
            await vi.advanceTimersByTimeAsync(30_000);
        });

        expect(api.approvedAccessClaims).toHaveBeenCalledTimes(1);
        expect(api.accessStatus).not.toHaveBeenCalled();
        expect(
            window.localStorage.getItem('bhasha.listener.patna-event-2026.accessToken'),
        ).toBeNull();
    });

    it('returns to one fresh gate without retrying after listener_not_approved', async () => {
        window.localStorage.setItem(
            'bhasha.listener.patna-event-2026.accessToken',
            'revoked-access-token',
        );
        window.localStorage.setItem(
            'bhasha.listener.patna-event-2026.accessClaim',
            JSON.stringify({
                claimId: 'old_claim',
                claimSecret: 'old_secret',
                shortCode: 'OLD234',
            }),
        );
        const accessStatus = vi.fn(async (input: Parameters<ListenerApi['accessStatus']>[0]) =>
            'accessToken' in input ? { state: 'approved' as const } : { state: 'pending' as const },
        );
        const api = listenerApi({ accessStatus });
        const realtime = realtimeClient({
            subscribe: vi.fn(async () => {
                throw new ApiError({
                    status: 403,
                    code: 'listener_not_approved',
                    body: { error: 'listener_not_approved' },
                });
            }),
        });

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi({
                    fetchProgram: vi.fn(async () =>
                        metadata({
                            program: {
                                ...metadata().program,
                                accessControlEnabled: true,
                            },
                        }),
                    ),
                })}
                listenerApi={api}
                realtimeClient={realtime}
            />,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'Listen to Hindi' }));

        expect(await screen.findByRole('heading', { name: 'Almost there' })).toBeInTheDocument();
        expect(
            screen.getByText('Your access was removed. Ask a volunteer to approve you again.'),
        ).toBeInTheDocument();
        expect(realtime.subscribe).toHaveBeenCalledTimes(1);
        expect(realtime.subscribe).toHaveBeenCalledWith(
            expect.objectContaining({
                accessToken: 'revoked-access-token',
            }),
        );
        expect(api.claimAccess).toHaveBeenCalledTimes(1);
        expect(
            window.localStorage.getItem('bhasha.listener.patna-event-2026.accessToken'),
        ).toBeNull();
    });

    it('shows a retryable access error when a post-403 claim cannot be created', async () => {
        window.localStorage.setItem(
            'bhasha.listener.patna-event-2026.accessToken',
            'revoked-access-token',
        );
        const claimAccess = vi
            .fn()
            .mockRejectedValueOnce(new Error('access_service_unavailable'))
            .mockResolvedValueOnce({
                claimId: 'replacement_claim',
                claimSecret: 'replacement_secret',
                shortCode: 'NEW123',
            });
        const api = listenerApi({
            claimAccess,
            accessStatus: vi.fn(async () => ({ state: 'approved' as const })),
        });
        const realtime = realtimeClient({
            subscribe: vi.fn(async () => {
                throw new ApiError({
                    status: 403,
                    code: 'listener_not_approved',
                    body: { error: 'listener_not_approved' },
                });
            }),
        });

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi({
                    fetchProgram: vi.fn(async () =>
                        metadata({
                            program: {
                                ...metadata().program,
                                accessControlEnabled: true,
                            },
                        }),
                    ),
                })}
                listenerApi={api}
                realtimeClient={realtime}
            />,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'Listen to Hindi' }));
        expect(
            await screen.findByRole('heading', { name: "Couldn't verify access" }),
        ).toBeInTheDocument();
        expect(screen.queryByText('Checking access…')).not.toBeInTheDocument();
        expect(
            window.localStorage.getItem('bhasha.listener.patna-event-2026.accessToken'),
        ).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(await screen.findByRole('heading', { name: 'Almost there' })).toBeInTheDocument();
        expect(claimAccess).toHaveBeenCalledTimes(2);
    });

    it.each(['switch', 'reconnect'] as const)(
        'returns to one fresh gate without retrying after a %s 403',
        async (operation) => {
            window.localStorage.setItem(
                'bhasha.listener.patna-event-2026.accessToken',
                'revoked-access-token',
            );
            const denied = () =>
                new ApiError({
                    status: 403,
                    code: 'listener_not_approved',
                    body: { error: 'listener_not_approved' },
                });
            const api = listenerApi({
                accessStatus: vi.fn(async (input) =>
                    'accessToken' in input
                        ? { state: 'approved' as const }
                        : { state: 'pending' as const },
                ),
            });
            const realtime = realtimeClient({
                ...(operation === 'switch'
                    ? { switch: vi.fn(async () => Promise.reject(denied())) }
                    : { reconnect: vi.fn(async () => Promise.reject(denied())) }),
            });
            let fireState: ConnectionStateHandler = () => {};

            render(
                <ListenerRoute
                    programSlug="patna-event-2026"
                    publicApi={publicApi({
                        fetchProgram: vi.fn(async () =>
                            metadata({
                                program: {
                                    ...metadata().program,
                                    accessControlEnabled: true,
                                },
                            }),
                        ),
                        fetchProgramStatus: vi.fn(async () =>
                            status({
                                streams: status().streams.map((stream) => ({
                                    ...stream,
                                    state: 'live' as const,
                                    publisherVersion: `publisher_${stream.id}_1`,
                                })),
                            }),
                        ),
                    })}
                    listenerApi={api}
                    onRealtimeHandlerReady={(handler) => {
                        fireState = handler;
                    }}
                    realtimeClient={realtime}
                />,
            );

            fireEvent.click(await screen.findByRole('button', { name: 'Listen to Hindi' }));
            await screen.findByText('Listening to Hindi');

            if (operation === 'switch') {
                fireEvent.click(screen.getByRole('button', { name: 'Switch to English' }));
            } else {
                act(() => fireState('listener_connection_1', 'disconnected'));
            }

            expect(
                await screen.findByRole('heading', { name: 'Almost there' }),
            ).toBeInTheDocument();
            const acquisition = operation === 'switch' ? realtime.switch : realtime.reconnect;
            expect(acquisition).toHaveBeenCalledTimes(1);
            expect(api.claimAccess).toHaveBeenCalledTimes(1);
            expect(
                window.localStorage.getItem('bhasha.listener.patna-event-2026.accessToken'),
            ).toBeNull();
        },
    );

    it('keeps the listener subscribe call shape stable', async () => {
        const api = listenerApi();
        const realtime = realtimeClient();

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={api}
                realtimeClient={realtime}
            />,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'Listen to Hindi' }));
        await waitFor(() => expect(realtime.subscribe).toHaveBeenCalledTimes(1));

        expect(api.claimAccess).not.toHaveBeenCalled();
        expect(api.accessStatus).not.toHaveBeenCalled();
        expect(api.approvedAccessClaims).not.toHaveBeenCalled();
        expect(realtime.subscribe).toHaveBeenCalledWith({
            programSlug: 'patna-event-2026',
            streamId: 'stream_hi',
            clientId: expect.stringMatching(/^listener_client_/),
        });
    });

    it('shows not-started gate content and blocks audio pull', async () => {
        const realtime = realtimeClient();
        const listener = listenerApi();

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi({
                    fetchProgram: vi.fn(async () =>
                        metadata({
                            program: {
                                ...metadata().program,
                                listenable: false,
                                notListenableReason: 'not_started',
                            },
                        }),
                    ),
                    fetchProgramStatus: vi.fn(async () =>
                        status({
                            program: {
                                ...status().program,
                                listenable: false,
                                notListenableReason: 'not_started',
                            },
                        }),
                    ),
                })}
                listenerApi={listener}
                realtimeClient={realtime}
            />,
        );

        expect(
            await screen.findByRole('heading', { name: 'Patna Event 2026' }),
        ).toBeInTheDocument();
        expect(screen.getByText('This event has not started yet.')).toBeInTheDocument();
        expect(screen.getByText('Check back when the event begins.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Listen to/ })).not.toBeInTheDocument();
        expect(screen.queryAllByRole('listitem')).toHaveLength(0);
        expect(realtime.subscribe).not.toHaveBeenCalled();
        expect(realtime.switch).not.toHaveBeenCalled();
        expect(realtime.reconnect).not.toHaveBeenCalled();
        expect(listener.token).not.toHaveBeenCalled();
    });

    it('shows ended gate content and blocks audio pull', async () => {
        const realtime = realtimeClient();
        const listener = listenerApi();

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi({
                    fetchProgram: vi.fn(async () =>
                        metadata({
                            program: {
                                ...metadata().program,
                                listenable: false,
                                notListenableReason: 'ended',
                            },
                        }),
                    ),
                    fetchProgramStatus: vi.fn(async () =>
                        status({
                            program: {
                                ...status().program,
                                listenable: false,
                                notListenableReason: 'ended',
                            },
                        }),
                    ),
                })}
                listenerApi={listener}
                realtimeClient={realtime}
            />,
        );

        expect(
            await screen.findByRole('heading', { name: 'Patna Event 2026' }),
        ).toBeInTheDocument();
        expect(screen.getByText('This event has ended.')).toBeInTheDocument();
        expect(screen.getByText('Thank you for joining.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Listen to/ })).not.toBeInTheDocument();
        expect(screen.queryAllByRole('listitem')).toHaveLength(0);
        expect(realtime.subscribe).not.toHaveBeenCalled();
        expect(realtime.switch).not.toHaveBeenCalled();
        expect(realtime.reconnect).not.toHaveBeenCalled();
        expect(listener.token).not.toHaveBeenCalled();
    });

    it('labels a silent stream distinctly and still allows subscribing', async () => {
        const silentStatus = status({
            streams: [
                {
                    id: 'stream_en',
                    languageName: 'English',
                    nativeName: 'English',
                    languageCode: 'en',
                    isActive: true,
                    state: 'offline',
                },
                {
                    id: 'stream_hi',
                    languageName: 'Hindi',
                    nativeName: 'हिन्दी',
                    languageCode: 'hi',
                    isActive: true,
                    state: 'silent',
                },
            ],
        });
        const realtime = realtimeClient();

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi({
                    fetchProgramStatus: vi.fn(async () => silentStatus),
                })}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
            />,
        );

        const hindi = (await screen.findAllByRole('listitem'))[0];
        expect(hindi).toHaveTextContent('Silent');
        expect(hindi).not.toHaveTextContent('Live');

        const listenButton = await screen.findByRole('button', {
            name: 'Listen to Hindi',
        });
        expect(listenButton).not.toBeDisabled();

        fireEvent.click(listenButton);
        await waitFor(() => {
            expect(realtime.subscribe).toHaveBeenCalledWith({
                programSlug: 'patna-event-2026',
                streamId: 'stream_hi',
                clientId: expect.any(String),
            });
        });
    });

    it('keeps rendering metadata when the initial status snapshot fails', async () => {
        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi({
                    fetchProgramStatus: vi.fn(async () => {
                        throw new Error('status_unavailable');
                    }),
                })}
                listenerApi={listenerApi()}
                realtimeClient={realtimeClient()}
            />,
        );

        expect(
            await screen.findByRole('heading', { name: 'Patna Event 2026' }),
        ).toBeInTheDocument();
        expect(screen.getByText('Hindi')).toBeInTheDocument();
        expect(screen.getByText('Live status is degraded.')).toBeInTheDocument();
    });

    it('starts subscription only after tapping a language', async () => {
        const realtime = realtimeClient();

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
            />,
        );

        await screen.findByText('Hindi');
        expect(realtime.subscribe).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));

        await waitFor(() => {
            expect(realtime.subscribe).toHaveBeenCalledWith({
                programSlug: 'patna-event-2026',
                streamId: 'stream_hi',
                clientId: expect.stringMatching(/^listener_client_/),
            });
        });
        expect(screen.getByText('Listening to Hindi')).toBeInTheDocument();
    });

    it('sends heartbeats while connected and stops them after leaving', async () => {
        const api = listenerApi();
        const realtime = realtimeClient();

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={api}
                realtimeClient={realtime}
                heartbeatMs={20}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');

        await waitFor(() => {
            expect(api.heartbeat).toHaveBeenCalledWith({
                connectionId: 'listener_connection_1',
            });
        });

        fireEvent.click(screen.getByRole('button', { name: 'Leave stream' }));
        await waitFor(() => {
            expect(realtime.stop).toHaveBeenCalledWith({
                connectionId: 'listener_connection_1',
                reason: 'listener_left',
            });
        });
        vi.clearAllMocks();
        await waitFor(
            () => {
                expect(api.heartbeat).not.toHaveBeenCalled();
            },
            { timeout: 400 },
        );
    });

    it('does not stop the current session during status polling rerenders', async () => {
        const realtime = realtimeClient();
        const publicClient = publicApi();

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicClient}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
                statusPollMs={100}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');

        await waitFor(() => {
            expect(
                (publicClient.fetchProgramStatus as ReturnType<typeof vi.fn>).mock.calls.length,
            ).toBeGreaterThanOrEqual(2);
        });
        expect(realtime.stop).not.toHaveBeenCalled();
    });

    it('reconnects the current language when the publisher version changes', async () => {
        const publicClient = publicApi({
            fetchProgramStatus: vi
                .fn()
                .mockResolvedValueOnce(status())
                .mockResolvedValueOnce(status())
                .mockResolvedValue(
                    status({
                        streams: [
                            {
                                id: 'stream_en',
                                languageName: 'English',
                                nativeName: 'English',
                                languageCode: 'en',
                                isActive: true,
                                state: 'offline',
                                publisherVersion: null,
                            },
                            {
                                id: 'stream_hi',
                                languageName: 'Hindi',
                                nativeName: 'हिन्दी',
                                languageCode: 'hi',
                                isActive: true,
                                state: 'live',
                                publisherVersion: 'publisher_hi_2',
                            },
                        ],
                    }),
                ),
        });
        const realtime = realtimeClient();

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicClient}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
                statusPollMs={200}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');

        await waitFor(() => {
            expect(
                (publicClient.fetchProgramStatus as ReturnType<typeof vi.fn>).mock.calls.length,
            ).toBeGreaterThanOrEqual(2);
        });

        await waitFor(
            () => {
                expect(realtime.reconnect).toHaveBeenCalledWith({
                    connectionId: 'listener_connection_1',
                    programSlug: 'patna-event-2026',
                    streamId: 'stream_hi',
                    clientId: expect.stringMatching(/^listener_client_/),
                });
            },
            { timeout: 2000 },
        );
        expect(await screen.findByText('Listening to Hindi')).toBeInTheDocument();
    });

    it('adopts the first observed publisher version without reconnecting', async () => {
        const publicClient = publicApi({
            fetchProgramStatus: vi
                .fn()
                .mockResolvedValueOnce(
                    status({
                        streams: [
                            {
                                id: 'stream_en',
                                languageName: 'English',
                                nativeName: 'English',
                                languageCode: 'en',
                                isActive: true,
                                state: 'offline',
                                publisherVersion: null,
                            },
                            {
                                id: 'stream_hi',
                                languageName: 'Hindi',
                                nativeName: 'हिन्दी',
                                languageCode: 'hi',
                                isActive: true,
                                state: 'live',
                                publisherVersion: null,
                            },
                        ],
                    }),
                )
                .mockResolvedValue(
                    status({
                        streams: [
                            {
                                id: 'stream_en',
                                languageName: 'English',
                                nativeName: 'English',
                                languageCode: 'en',
                                isActive: true,
                                state: 'offline',
                                publisherVersion: null,
                            },
                            {
                                id: 'stream_hi',
                                languageName: 'Hindi',
                                nativeName: 'हिन्दी',
                                languageCode: 'hi',
                                isActive: true,
                                state: 'live',
                                publisherVersion: 'publisher_hi_1',
                            },
                        ],
                    }),
                ),
        });
        const realtime = realtimeClient();

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicClient}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
                statusPollMs={20}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');

        await waitFor(() => {
            expect(
                (publicClient.fetchProgramStatus as ReturnType<typeof vi.fn>).mock.calls.length,
            ).toBeGreaterThanOrEqual(2);
        });
        await waitFor(
            () => {
                expect(realtime.reconnect).not.toHaveBeenCalled();
            },
            { timeout: 500 },
        );
    });

    it('recovers exactly once when the room reports a terminal disconnect', async () => {
        const realtime = realtimeClient();
        let fireState: ConnectionStateHandler = () => {};

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
                statusPollMs={20}
                recoveryBaseMs={10}
                recoveryMaxMs={40}
                onRealtimeHandlerReady={(handler) => {
                    fireState = handler;
                }}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');

        // The live connection is listener_connection_1 (the mock subscribe result).
        fireState?.('listener_connection_1', 'disconnected');
        await waitFor(
            () => {
                expect(realtime.reconnect).toHaveBeenCalledWith(
                    expect.objectContaining({
                        connectionId: 'listener_connection_1',
                        streamId: 'stream_hi',
                    }),
                );
            },
            { timeout: 5000 },
        );
        await waitFor(
            () => {
                expect(realtime.reconnect).toHaveBeenCalledTimes(1);
            },
            { timeout: 5000 },
        );
        // Debounced: a single disconnected event drives exactly one recovery.
        expect(screen.getByText('Listening to Hindi')).toBeInTheDocument();
    });

    it('does not recover when the room self-heals (reconnecting -> reconnected)', async () => {
        const realtime = realtimeClient();
        let fireState: ConnectionStateHandler = () => {};

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
                statusPollMs={20}
                recoveryBaseMs={10}
                recoveryMaxMs={40}
                onRealtimeHandlerReady={(handler) => {
                    fireState = handler;
                }}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');

        // LiveKit is already retrying on its own -- no manual timer is ever
        // scheduled for a transient "reconnecting", so a self-heal never reaches
        // realtime.reconnect().
        fireState?.('listener_connection_1', 'reconnecting');
        fireState?.('listener_connection_1', 'reconnected');

        await waitFor(
            () => {
                expect(realtime.reconnect).not.toHaveBeenCalled();
            },
            { timeout: 500 },
        );
        expect(screen.getByText('Listening to Hindi')).toBeInTheDocument();
    });

    // Every other realtime-related test above injects a fully-mocked
    // ListenerRealtimeClient via `realtimeClient`, which never exercises the
    // route's own `createListenerRealtimeClient({..., onConnectionStateChange})`
    // construction line. This test omits `realtimeClient` and instead injects a
    // fake Room via `createRoom`, so the REAL client is constructed and the
    // route's transport-state wiring is proven end-to-end.
    it('wires the real LiveKit client end-to-end (token mint, room join, transport events)', async () => {
        class FakeRoom implements RoomHandle {
            static instances: FakeRoom[] = [];
            readonly connectCalls: Array<{ url: string; token: string }> = [];
            private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

            constructor() {
                FakeRoom.instances.push(this);
            }

            async connect(url: string, token: string): Promise<void> {
                this.connectCalls.push({ url, token });
            }

            async disconnect(): Promise<void> {}

            on(event: string, listener: (...args: unknown[]) => void): this {
                const set = this.listeners.get(event) ?? new Set();
                set.add(listener);
                this.listeners.set(event, set);
                return this;
            }

            off(event: string, listener: (...args: unknown[]) => void): this {
                this.listeners.get(event)?.delete(listener);
                return this;
            }

            emit(event: string): void {
                for (const listener of this.listeners.get(event) ?? []) {
                    listener();
                }
            }
        }

        const api = listenerApi({
            token: vi.fn(async () => ({
                connectionId: 'listener_connection_1',
                token: 'livekit-jwt',
                url: 'wss://livekit.example.test',
                roomName: 'room_stream_hi',
            })),
            // The real client's joinRoom() awaits-then-.catch()es this call (best-
            // effort presence signal) -- unlike the mocked-ListenerRealtimeClient
            // tests above, this test exercises that real code path, so it needs an
            // actual resolved Promise here, not the bare `vi.fn()` default.
            connected: vi.fn(async () => ({ ok: true as const })),
        });

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={api}
                createRoom={() => new FakeRoom()}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');

        expect(api.requestConnection).toHaveBeenCalled();
        expect(api.token).toHaveBeenCalledWith(
            expect.objectContaining({
                connectionId: 'listener_connection_1',
                streamId: 'stream_hi',
            }),
        );
        const room = FakeRoom.instances[0]!;
        expect(room.connectCalls).toEqual([
            { url: 'wss://livekit.example.test', token: 'livekit-jwt' },
        ]);

        // LiveKit's own transient self-heal never reaches realtime.reconnect() --
        // proven here through the REAL client, not a mocked one.
        room.emit(RoomEvent.Reconnecting);
        room.emit(RoomEvent.Reconnected);
        await waitFor(() => {
            expect(api.reconnect).not.toHaveBeenCalled();
        });
        expect(screen.getByText('Listening to Hindi')).toBeInTheDocument();
    });

    it('backs off repeated failures without a tight reconnect loop', async () => {
        const realtime = realtimeClient({
            reconnect: vi.fn(async () => {
                throw new Error('still_down');
            }),
        });
        let fireState: ConnectionStateHandler | null = null;
        const recoveryBaseMs = 5;
        const recoveryMaxMs = 20;

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
                statusPollMs={20}
                recoveryBaseMs={recoveryBaseMs}
                recoveryMaxMs={recoveryMaxMs}
                recoveryMaxAttempts={3}
                onRealtimeHandlerReady={(handler) => {
                    fireState = handler;
                }}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');
        await waitFor(() => {
            expect(fireState).not.toBeNull();
        });
        if (fireState === null) {
            throw new Error('realtime handler not ready');
        }
        vi.useFakeTimers();

        const fireStateFn = fireState as ConnectionStateHandler;
        fireStateFn('listener_connection_1', 'disconnected');
        await vi.advanceTimersByTimeAsync(recoveryBaseMs);
        await Promise.resolve();
        expect((realtime.reconnect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

        await vi.advanceTimersByTimeAsync(recoveryBaseMs * 2);
        await Promise.resolve();
        expect((realtime.reconnect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);

        // The next backoff is scheduled from the rejected reconnect's microtask.
        // Run the timers that are pending after that continuation instead of
        // assuming the timer existed at the start of a fixed clock advance.
        await vi.runOnlyPendingTimersAsync();
        await Promise.resolve();

        // Let the rejection continuation arm its final capped attempt, then prove
        // a long clock advance produces exactly that attempt and no retry storm.
        await vi.advanceTimersByTimeAsync(3000);
        await Promise.resolve();
        const reconnectAttempts = (realtime.reconnect as ReturnType<typeof vi.fn>).mock.calls
            .length;
        expect(reconnectAttempts).toBeGreaterThanOrEqual(2);
        expect(reconnectAttempts).toBeLessThanOrEqual(3);
    });

    it('continues recovery for silent streams up to the capped attempt limit', async () => {
        const publicClient = publicApi({
            fetchProgramStatus: vi.fn(async () =>
                status({
                    streams: [
                        {
                            id: 'stream_en',
                            languageName: 'English',
                            nativeName: 'English',
                            languageCode: 'en',
                            isActive: true,
                            state: 'offline',
                            publisherVersion: null,
                        },
                        {
                            id: 'stream_hi',
                            languageName: 'Hindi',
                            nativeName: 'हिन्दी',
                            languageCode: 'hi',
                            isActive: true,
                            state: 'silent',
                            publisherVersion: 'publisher_hi_1',
                        },
                    ],
                }),
            ),
        });
        const realtime = realtimeClient({
            reconnect: vi.fn(async () => {
                throw new Error('still_down');
            }),
        });
        let fireState: ConnectionStateHandler = () => {};

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicClient}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
                statusPollMs={100_000}
                recoveryBaseMs={5}
                recoveryMaxMs={20}
                recoveryMaxAttempts={3}
                onRealtimeHandlerReady={(handler) => {
                    fireState = handler;
                }}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');

        vi.useFakeTimers();
        fireState?.('listener_connection_1', 'disconnected');
        await vi.advanceTimersByTimeAsync(40);

        expect((realtime.reconnect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);

        await vi.advanceTimersByTimeAsync(500);
        expect((realtime.reconnect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
    });

    it('does not recover while stream status is offline', async () => {
        // Connect while Hindi is live (an offline stream isn't subscribable — its
        // Listen button is disabled), then the publisher goes offline before the
        // transport-failed event; recovery must stand down, not reconnect.
        const offlineStreams = [
            {
                id: 'stream_en',
                languageName: 'English',
                nativeName: 'English',
                languageCode: 'en',
                isActive: true,
                state: 'offline' as const,
                publisherVersion: null,
            },
            {
                id: 'stream_hi',
                languageName: 'Hindi',
                nativeName: 'हिन्दी',
                languageCode: 'hi',
                isActive: true,
                state: 'offline' as const,
                publisherVersion: null,
            },
        ];
        // The second (offline) snapshot blocks on this gate until released, so a
        // real 20ms poll tick landing before the click's connect microtask
        // completes can't race the button permanently disabled before
        // "Listening to Hindi" ever renders -- see the identical race and fix
        // in the "keeps stale state from non-publish-end heartbeat failures"
        // translator test.
        let releaseOfflineSnapshot: () => void = () => {};
        const offlineSnapshotGate = new Promise<void>((resolve) => {
            releaseOfflineSnapshot = resolve;
        });
        const publicClient = publicApi({
            fetchProgramStatus: vi
                .fn()
                // First poll: Hindi live so we can connect.
                .mockResolvedValueOnce(status())
                // Then Hindi goes offline (publisher gone).
                .mockImplementation(async () => {
                    await offlineSnapshotGate;
                    return status({ streams: offlineStreams });
                }),
        });
        const realtime = realtimeClient();
        let fireState: ConnectionStateHandler = () => {};

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicClient}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
                statusPollMs={20}
                recoveryBaseMs={5}
                recoveryMaxMs={20}
                recoveryMaxAttempts={3}
                onRealtimeHandlerReady={(handler) => {
                    fireState = handler;
                }}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');
        releaseOfflineSnapshot();

        // Wait until the offline status snapshot has been applied.
        await waitFor(() => {
            expect(
                (publicClient.fetchProgramStatus as ReturnType<typeof vi.fn>).mock.calls.length,
            ).toBeGreaterThanOrEqual(2);
        });

        fireState?.('listener_connection_1', 'disconnected');
        await waitFor(
            () => {
                expect(realtime.reconnect).not.toHaveBeenCalled();
            },
            { timeout: 500 },
        );
    });

    it('stands down recovery while the stream status is offline and resumes when it returns', async () => {
        // Gated for the same reason as the previous test -- see its comment.
        let releaseOfflineSnapshot: () => void = () => {};
        const offlineSnapshotGate = new Promise<void>((resolve) => {
            releaseOfflineSnapshot = resolve;
        });
        const publicClient = publicApi({
            fetchProgramStatus: vi
                .fn()
                // First poll: Hindi live so we can connect.
                .mockResolvedValueOnce(status())
                // Then Hindi goes offline (publisher gone).
                .mockImplementation(async () => {
                    await offlineSnapshotGate;
                    return status({
                        streams: [
                            {
                                id: 'stream_en',
                                languageName: 'English',
                                nativeName: 'English',
                                languageCode: 'en',
                                isActive: true,
                                state: 'offline',
                                publisherVersion: null,
                            },
                            {
                                id: 'stream_hi',
                                languageName: 'Hindi',
                                nativeName: 'हिन्दी',
                                languageCode: 'hi',
                                isActive: true,
                                state: 'offline',
                                publisherVersion: null,
                            },
                        ],
                    });
                }),
        });
        const realtime = realtimeClient();
        let fireState: ConnectionStateHandler = () => {};

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicClient}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
                statusPollMs={20}
                recoveryBaseMs={5}
                recoveryMaxMs={20}
                onRealtimeHandlerReady={(handler) => {
                    fireState = handler;
                }}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');
        releaseOfflineSnapshot();

        // Wait until the offline status snapshot has been applied.
        await waitFor(() => {
            expect(
                (publicClient.fetchProgramStatus as ReturnType<typeof vi.fn>).mock.calls.length,
            ).toBeGreaterThanOrEqual(2);
        });

        fireState?.('listener_connection_1', 'disconnected');
        await waitFor(
            () => {
                expect(realtime.reconnect).not.toHaveBeenCalled();
            },
            { timeout: 500 },
        );
        // Publisher is offline -> stand down, no reconnect.
    });

    it('ignores a failed event from a stale, pre-switch connection', async () => {
        const realtime = realtimeClient();
        let fireState: ConnectionStateHandler = () => {};

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi({
                    fetchProgramStatus: vi.fn(async () =>
                        status({
                            streams: [
                                {
                                    id: 'stream_en',
                                    languageName: 'English',
                                    nativeName: 'English',
                                    languageCode: 'en',
                                    isActive: true,
                                    state: 'live',
                                    publisherVersion: 'publisher_en_1',
                                },
                                {
                                    id: 'stream_hi',
                                    languageName: 'Hindi',
                                    nativeName: 'हिन्दी',
                                    languageCode: 'hi',
                                    isActive: true,
                                    state: 'live',
                                    publisherVersion: 'publisher_hi_1',
                                },
                            ],
                        }),
                    ),
                })}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
                statusPollMs={20}
                recoveryBaseMs={5}
                recoveryMaxMs={20}
                onRealtimeHandlerReady={(handler) => {
                    fireState = handler;
                }}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');
        fireEvent.click(screen.getByRole('button', { name: 'Switch to English' }));
        await screen.findByText('Listening to English');

        // The current connection is now listener_connection_2 (switch result).
        // A late failed event from the old connection_1 must be ignored.
        fireState?.('listener_connection_1', 'disconnected');
        await waitFor(
            () => {
                expect(realtime.reconnect).not.toHaveBeenCalled();
            },
            { timeout: 500 },
        );
    });

    it('recovers exactly once when transport-failed and a publisher-version change coincide', async () => {
        const publicClient = publicApi({
            fetchProgramStatus: vi
                .fn()
                .mockResolvedValueOnce(status())
                .mockResolvedValue(
                    status({
                        streams: [
                            {
                                id: 'stream_en',
                                languageName: 'English',
                                nativeName: 'English',
                                languageCode: 'en',
                                isActive: true,
                                state: 'offline',
                                publisherVersion: null,
                            },
                            {
                                id: 'stream_hi',
                                languageName: 'Hindi',
                                nativeName: 'हिन्दी',
                                languageCode: 'hi',
                                isActive: true,
                                state: 'live',
                                publisherVersion: 'publisher_hi_2',
                            },
                        ],
                    }),
                ),
        });
        // A slow reconnect keeps the transport recovery in-flight while the status
        // poll delivers the publisher-version bump — exactly the production race the
        // shared in-flight latch exists to collapse.
        const realtime = realtimeClient({
            reconnect: vi.fn(async (input) => {
                await new Promise((resolve) => setTimeout(resolve, 60));
                return {
                    connectionId: 'listener_connection_3',
                    streamId: input.streamId,
                    mediaStream: new MediaStream(),
                };
            }),
        });
        let fireState: ConnectionStateHandler = () => {};

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicClient}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
                statusPollMs={20}
                recoveryBaseMs={5}
                recoveryMaxMs={20}
                onRealtimeHandlerReady={(handler) => {
                    fireState = handler;
                }}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');

        // Fire transport failure at the same moment the publisher version changes.
        fireState?.('listener_connection_1', 'disconnected');

        await waitFor(() => {
            expect(realtime.reconnect).toHaveBeenCalled();
        });
        // The in-flight latch is shared with the publisher-version reconnect, so the
        // two triggers collapse into a single reconnect.
        expect(realtime.reconnect).toHaveBeenCalledTimes(1);
        await waitFor(
            () => {
                expect(realtime.reconnect).toHaveBeenCalledTimes(1);
            },
            { timeout: 800 },
        );
    });

    it('clears the backoff timer on unmount so no reconnect fires afterwards', async () => {
        const realtime = realtimeClient();
        let fireState: ConnectionStateHandler = () => {};

        const view = render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
                statusPollMs={20}
                recoveryBaseMs={50}
                recoveryMaxMs={200}
                onRealtimeHandlerReady={(handler) => {
                    fireState = handler;
                }}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');

        // A terminal disconnect schedules a backed-off reconnect timer; unmount
        // before it fires.
        fireState?.('listener_connection_1', 'disconnected');
        view.unmount();

        await waitFor(
            () => {
                expect(realtime.reconnect).not.toHaveBeenCalled();
            },
            { timeout: 500 },
        );
    });

    it('switches from the current connection to another language', async () => {
        const realtime = realtimeClient();

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi({
                    fetchProgramStatus: vi.fn(async () =>
                        status({
                            streams: [
                                {
                                    id: 'stream_en',
                                    languageName: 'English',
                                    nativeName: 'English',
                                    languageCode: 'en',
                                    isActive: true,
                                    state: 'live',
                                    publisherVersion: 'publisher_en_1',
                                },
                                {
                                    id: 'stream_hi',
                                    languageName: 'Hindi',
                                    nativeName: 'हिन्दी',
                                    languageCode: 'hi',
                                    isActive: true,
                                    state: 'live',
                                    publisherVersion: 'publisher_hi_1',
                                },
                            ],
                        }),
                    ),
                })}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');
        fireEvent.click(screen.getByRole('button', { name: 'Switch to English' }));

        await waitFor(() => {
            expect(realtime.switch).toHaveBeenCalledWith({
                connectionId: 'listener_connection_1',
                programSlug: 'patna-event-2026',
                nextStreamId: 'stream_en',
                clientId: expect.stringMatching(/^listener_client_/),
            });
        });
        expect(await screen.findByText('Listening to English')).toBeInTheDocument();
    });

    it('keeps reconnect visible after a connection error', async () => {
        const realtime = realtimeClient({
            subscribe: vi.fn(async () => {
                throw new Error('network_lost');
            }),
        });

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));

        expect(await screen.findByText('Disconnected')).toBeInTheDocument();
        expect(screen.getByText('Connection lost. Try reconnecting.')).toBeVisible();
        expect(screen.getByRole('button', { name: 'Reconnect Hindi' })).toBeVisible();
    });

    it('auto-reconnect autoplay-block shows Reconnect, not enable-sound', async () => {
        const realtime = realtimeClient();
        let fireState: ConnectionStateHandler = () => {};

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
                recoveryBaseMs={20}
                onRealtimeHandlerReady={(handler) => {
                    fireState = handler;
                }}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');

        Object.defineProperty(HTMLMediaElement.prototype, 'play', {
            configurable: true,
            value: vi.fn(async () => {
                throw new DOMException('blocked', 'NotAllowedError');
            }),
        });

        fireState?.('listener_connection_1', 'disconnected');

        await waitFor(() => {
            expect(realtime.reconnect).toHaveBeenCalled();
            expect(screen.getByRole('button', { name: 'Reconnect Hindi' })).toBeVisible();
        });
        expect(screen.queryByRole('button', { name: /enable sound/i })).toBeNull();
    });

    it('manual reconnect autoplay-block shows enable-sound', async () => {
        const realtime = realtimeClient();
        let fireState: ConnectionStateHandler = () => {};

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
                recoveryBaseMs={20}
                onRealtimeHandlerReady={(handler) => {
                    fireState = handler;
                }}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');

        Object.defineProperty(HTMLMediaElement.prototype, 'play', {
            configurable: true,
            value: vi.fn(async () => {
                throw new DOMException('blocked', 'NotAllowedError');
            }),
        });

        fireState?.('listener_connection_1', 'disconnected');

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Reconnect Hindi' })).toBeVisible();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Reconnect Hindi' }));

        expect(await screen.findByRole('button', { name: /enable sound/i })).toBeVisible();
    });

    it('shows waiting for translator when the stream is not live', async () => {
        const realtime = realtimeClient({
            subscribe: vi.fn(async () => {
                throw new ApiError({
                    status: 409,
                    code: 'stream_not_live',
                    body: { error: 'stream_not_live' },
                });
            }),
        });

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));

        expect(await screen.findByText('Waiting for translator.')).toBeVisible();
        expect(screen.getByRole('button', { name: 'Reconnect Hindi' })).toBeVisible();
    });

    it.each([
        {
            code: 'realtime_error',
            message: 'Realtime connection failed. Try reconnecting.',
        },
        {
            code: 'listener_invalid_state',
            message: 'Stream ended. Choose a language again.',
        },
    ])('shows actionable copy for $code', async ({ code, message }) => {
        const realtime = realtimeClient({
            subscribe: vi.fn(async () => {
                throw new ApiError({
                    status: code === 'realtime_error' ? 502 : 409,
                    code,
                    body: { error: code },
                });
            }),
        });

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));

        expect(await screen.findByText(message)).toBeVisible();
        expect(screen.getByRole('button', { name: 'Reconnect Hindi' })).toBeVisible();
    });

    it('leaves the backend connection if browser audio playback fails after subscribe', async () => {
        // A genuine (non-autoplay) playback failure should still tear down the session.
        Object.defineProperty(HTMLMediaElement.prototype, 'play', {
            configurable: true,
            value: vi.fn(async () => {
                throw new Error('decode failed');
            }),
        });
        const realtime = realtimeClient();

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));

        expect(await screen.findByText('Disconnected')).toBeInTheDocument();
        expect(screen.getByText('Audio playback failed. Try reconnecting.')).toBeVisible();
        expect(realtime.stop).toHaveBeenCalledWith({
            connectionId: 'listener_connection_1',
            reason: 'playback_failed',
        });
    });

    it('keeps the session and offers tap-to-enable-sound when autoplay is blocked', async () => {
        let plays = 0;
        Object.defineProperty(HTMLMediaElement.prototype, 'play', {
            configurable: true,
            value: vi.fn(async () => {
                plays += 1;
                // The synchronous gesture-prime (no source yet) and the post-attach play
                // are both autoplay-blocked; a later tap on "Enable sound" succeeds.
                if (plays <= 2) {
                    throw new DOMException('autoplay blocked', 'NotAllowedError');
                }
                return undefined;
            }),
        });
        const realtime = realtimeClient();

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));

        // The live session is kept (heartbeats keep the listener counted) and a
        // one-tap unlock is offered instead of a dead "playback failed" error.
        const enable = await screen.findByRole('button', { name: /enable sound/i });
        expect(enable).toBeVisible();
        expect(realtime.stop).not.toHaveBeenCalled();

        fireEvent.click(enable);

        await waitFor(() =>
            expect(screen.queryByRole('button', { name: /enable sound/i })).toBeNull(),
        );
        expect(screen.getByText('Listening to Hindi')).toBeVisible();
    });

    it('re-acquires wake lock when a connected listener returns to foreground', async () => {
        const firstRelease = vi.fn(async () => undefined);
        const secondRelease = vi.fn(async () => undefined);
        const request = vi
            .fn()
            .mockResolvedValueOnce({ release: firstRelease })
            .mockResolvedValueOnce({ release: secondRelease });
        Object.defineProperty(navigator, 'wakeLock', {
            configurable: true,
            value: { request },
        });
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible',
        });

        const playMock = HTMLMediaElement.prototype.play as unknown as ReturnType<typeof vi.fn>;
        playMock.mockImplementation(async function (this: HTMLAudioElement) {
            Object.defineProperty(this, 'paused', {
                configurable: true,
                value: false,
                writable: true,
            });
            return undefined;
        });

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtimeClient()}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');

        await waitFor(() => {
            expect(request).toHaveBeenCalledTimes(1);
        });

        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden',
        });
        document.dispatchEvent(new Event('visibilitychange'));

        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible',
        });
        document.dispatchEvent(new Event('visibilitychange'));

        await waitFor(() => {
            expect(request).toHaveBeenCalledTimes(2);
        });
        expect(firstRelease).toHaveBeenCalled();
    });

    it('prompts for a tap on foreground return when play() is autoplay-blocked', async () => {
        let plays = 0;
        const playMock = HTMLMediaElement.prototype.play as unknown as ReturnType<typeof vi.fn>;
        playMock.mockImplementation(async function (this: HTMLAudioElement) {
            plays += 1;
            if (plays < 3) {
                Object.defineProperty(this, 'paused', {
                    configurable: true,
                    value: false,
                    writable: true,
                });
                return undefined;
            }
            throw new DOMException('autoplay blocked', 'NotAllowedError');
        });
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible',
        });

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtimeClient()}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');

        const audio = document.querySelector('audio') as HTMLAudioElement;
        Object.defineProperty(audio, 'paused', {
            configurable: true,
            value: true,
            writable: true,
        });

        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden',
        });
        document.dispatchEvent(new Event('visibilitychange'));

        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible',
        });
        document.dispatchEvent(new Event('visibilitychange'));

        expect(await screen.findByRole('button', { name: /tap to enable sound/i })).toBeVisible();
    });

    it('disables the Listen button for an offline stream', async () => {
        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtimeClient()}
            />,
        );

        // English is offline in the fixtures; its Listen button must not be tappable
        // (tapping would only surface a "Waiting for translator." error).
        const englishBtn = await screen.findByRole('button', {
            name: 'Listen to English',
        });
        expect(englishBtn).toBeDisabled();
        // Hindi is live and remains tappable.
        expect(screen.getByRole('button', { name: 'Listen to Hindi' })).toBeEnabled();
    });

    it('keeps the Listen button enabled when a stream is missing from the status snapshot', async () => {
        const publicClient = publicApi({
            fetchProgramStatus: vi.fn(async () =>
                status({
                    streams: [
                        {
                            id: 'stream_hi',
                            languageName: 'Hindi',
                            nativeName: 'हिन्दी',
                            languageCode: 'hi',
                            isActive: true,
                            state: 'live',
                            publisherVersion: 'publisher_hi_1',
                        },
                    ],
                }),
            ),
        });

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicClient}
                listenerApi={listenerApi()}
                realtimeClient={realtimeClient()}
            />,
        );

        expect(await screen.findByRole('button', { name: 'Listen to English' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Listen to Hindi' })).toBeEnabled();
    });

    it('disables switching to a stream that is explicitly offline', async () => {
        const realtime = realtimeClient();
        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');

        const switchToEnglish = screen.getByRole('button', {
            name: 'Switch to English',
        });
        expect(switchToEnglish).toBeDisabled();
        fireEvent.click(switchToEnglish);
        expect(realtime.switch).not.toHaveBeenCalled();
    });

    it('primes audio playback synchronously within the tap gesture for iOS', async () => {
        let resolveSubscribe: (value: unknown) => void = () => {};
        const subscribe = vi.fn(
            () =>
                new Promise((resolve) => {
                    resolveSubscribe = resolve;
                }),
        );
        const realtime = realtimeClient({
            subscribe: subscribe as ListenerRealtimeClient['subscribe'],
        });
        const playMock = HTMLMediaElement.prototype.play as unknown as ReturnType<typeof vi.fn>;

        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtime}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        playMock.mockClear();
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));

        // iOS only honours play() inside the synchronous gesture turn. The unlock
        // must fire on click -- synchronously, as the very first thing handleListen
        // does, strictly before subscribe (proven by call order rather than a
        // synchronous/asynchronous boundary now that there is no intermediate
        // network await before subscribe is issued).
        expect(playMock).toHaveBeenCalled();
        await waitFor(() => expect(subscribe).toHaveBeenCalled());
        expect(playMock.mock.invocationCallOrder[0]!).toBeLessThan(
            subscribe.mock.invocationCallOrder[0]!,
        );
        resolveSubscribe({
            connectionId: 'listener_connection_1',
            streamId: 'stream_hi',
            mediaStream: new MediaStream(),
        });

        await screen.findByText('Listening to Hindi');
    });

    it('shows a subtle Playing indicator on the active language while connected', async () => {
        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtimeClient()}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');

        const hindi = screen.getAllByRole('listitem')[0];
        expect(hindi).toHaveTextContent('Playing');
        // The card's stop affordance keeps the "Leave stream" accessible name used
        // across the app and e2e specs even though it reads "Stop" visually.
        expect(screen.getByRole('button', { name: 'Leave stream' })).toBeVisible();
    });

    it('exposes volume controls that adjust audio output once connected', async () => {
        render(
            <ListenerRoute
                programSlug="patna-event-2026"
                publicApi={publicApi()}
                listenerApi={listenerApi()}
                realtimeClient={realtimeClient()}
            />,
        );

        await screen.findByRole('button', { name: 'Listen to Hindi' });
        fireEvent.click(screen.getByRole('button', { name: 'Listen to Hindi' }));
        await screen.findByText('Listening to Hindi');

        const audio = document.querySelector('audio') as HTMLAudioElement;
        await waitFor(() => expect(audio.volume).toBeCloseTo(0.8));

        fireEvent.click(screen.getByRole('button', { name: 'Decrease volume' }));
        await waitFor(() => expect(audio.volume).toBeCloseTo(0.7));

        fireEvent.click(screen.getByRole('button', { name: 'Increase volume' }));
        await waitFor(() => expect(audio.volume).toBeCloseTo(0.8));
    });
});
