import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/api/client';
import type { PublicApi } from '../src/api/public';
import type { VolunteerApi, VolunteerSessionResponse } from '../src/api/volunteer';
import { VolunteerRoute } from '../src/routes/VolunteerRoute';
import { normalizeQrScannerError } from '../src/routes/qrScanner';

const scannerTestState = vi.hoisted(() => ({
    onScan: null as ((value: string) => void) | null,
    start: vi.fn(async () => undefined),
    destroy: vi.fn(),
}));

vi.mock('../src/routes/qrScanner', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/routes/qrScanner')>();
    return {
        ...actual,
        createQrScanner: vi.fn((options: { onScan: (value: string) => void }) => {
            scannerTestState.onScan = options.onScan;
            return {
                start: scannerTestState.start,
                destroy: scannerTestState.destroy,
            };
        }),
    };
});

const programMetadata = {
    program: {
        slug: 'patna-event-2026',
        name: 'Patna Event 2026',
        venue: 'Main Hall',
        eventDate: '2026-08-26',
        status: 'live',
        accessControlEnabled: true,
    },
    streams: [],
    urls: {
        listenerUrl: '/patna-event-2026',
        translatorUrl: '/patna-event-2026/translate',
        volunteerUrl: '/patna-event-2026/volunteer',
    },
};

function authError(code = 'volunteer_auth_required', status = 401) {
    return new ApiError({ status, code, body: { error: code } });
}

function session(approvedCount = 7): VolunteerSessionResponse {
    return {
        program: { slug: 'patna-event-2026', name: 'Patna Event 2026' },
        approvedCount,
    };
}

function publicApi(): PublicApi {
    return {
        fetchProgram: vi.fn(async () => programMetadata),
        fetchProgramStatus: vi.fn(),
    } as PublicApi;
}

function volunteerApi(overrides: Partial<VolunteerApi> = {}): VolunteerApi {
    return {
        login: vi.fn(async () => ({ ok: true as const })),
        logout: vi.fn(async () => ({ ok: true as const })),
        session: vi.fn(async () => session()),
        approve: vi.fn(async () => ({
            status: 'approved' as const,
            already: false,
        })),
        ...overrides,
    };
}

function renderRoute(api: VolunteerApi) {
    return render(
        <VolunteerRoute
            programSlug="patna-event-2026"
            publicApi={publicApi()}
            volunteerApi={api}
        />,
    );
}

async function submitManualCode(code: string) {
    const input = await screen.findByRole('textbox', { name: 'Short code' });
    fireEvent.change(input, { target: { value: code } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve code' }));
}

describe('VolunteerRoute', () => {
    beforeEach(() => {
        window.history.replaceState(null, '', '/patna-event-2026/volunteer');
        scannerTestState.onScan = null;
        scannerTestState.start.mockReset().mockResolvedValue(undefined);
        scannerTestState.destroy.mockReset();
    });

    afterEach(() => {
        cleanup();
        Reflect.deleteProperty(navigator, 'wakeLock');
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('shows the program name and logs in with a text login ID', async () => {
        const sessionMock = vi
            .fn()
            .mockRejectedValueOnce(authError())
            .mockResolvedValueOnce(session(4));
        const login = vi.fn(async () => ({ ok: true as const }));
        const api = volunteerApi({ login, session: sessionMock });
        renderRoute(api);

        expect(await screen.findByText('Patna Event 2026')).toBeInTheDocument();
        const loginId = screen.getByRole('textbox', { name: 'Login ID' });
        expect(loginId).toHaveAttribute('type', 'text');
        expect(loginId).toHaveAttribute('autocomplete', 'username');

        fireEvent.change(loginId, { target: { value: 'front-gate' } });
        fireEvent.change(screen.getByLabelText('Password'), {
            target: { value: 'secret-pass' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

        await screen.findByRole('heading', { name: 'Approve listener access' });
        expect(login).toHaveBeenCalledWith({
            programSlug: 'patna-event-2026',
            loginId: 'front-gate',
            password: 'secret-pass',
        });
        expect(screen.getByText('4 approved')).toBeInTheDocument();
    });

    it.each([
        [
            authError('invalid_credentials', 401),
            "That login or password isn't right. Check with the event organiser.",
        ],
        [
            authError('too_many_attempts', 429),
            'Too many attempts right now — try again in a minute.',
        ],
        [
            authError('volunteer_not_configured', 409),
            "Volunteer access isn't set up for this program. Check with the event organiser.",
        ],
    ])('shows a friendly login error for %s', async (error, message) => {
        const api = volunteerApi({
            session: vi.fn(async () => {
                throw authError();
            }),
            login: vi.fn(async () => {
                throw error;
            }),
        });
        renderRoute(api);

        fireEvent.change(await screen.findByRole('textbox', { name: 'Login ID' }), {
            target: { value: 'front-gate' },
        });
        fireEvent.change(screen.getByLabelText('Password'), {
            target: { value: 'wrong' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(message);
    });

    it('filters Crockford-32 input and increments the fetched count only for a new approval', async () => {
        const approve = vi
            .fn()
            .mockResolvedValueOnce({ status: 'approved', already: false })
            .mockResolvedValueOnce({ status: 'approved', already: true });
        renderRoute(volunteerApi({ approve }));

        const input = await screen.findByRole('textbox', { name: 'Short code' });
        fireEvent.change(input, { target: { value: 'abci-lou234' } });
        expect(input).toHaveValue('ABC234');
        fireEvent.click(screen.getByRole('button', { name: 'Approve code' }));

        expect(await screen.findByRole('status')).toHaveTextContent('Approved:');
        expect(screen.getByText('8 approved')).toBeInTheDocument();
        expect(approve).toHaveBeenNthCalledWith(1, { shortCode: 'ABC234' });

        await submitManualCode('DEF567');
        expect(await screen.findByRole('status')).toHaveTextContent('Already in:');
        expect(screen.getByText('8 approved')).toBeInTheDocument();
    });

    it.each([
        ['claim_not_found', 404, 'Not found:'],
        ['claim_revoked', 409, 'Revoked:'],
        ['too_many_attempts', 429, 'Too many tries — wait a minute.'],
    ])('shows non-blocking %s feedback', async (code, status, copy) => {
        const api = volunteerApi({
            approve: vi.fn(async () => {
                throw authError(code, status);
            }),
        });
        renderRoute(api);

        await submitManualCode('ABC234');

        expect(await screen.findByRole('status')).toHaveTextContent(copy);
        expect(screen.getByRole('textbox', { name: 'Short code' })).toHaveValue('ABC234');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.getByLabelText('Scan a listener access QR code')).toBeInTheDocument();
    });

    it('approves URL and bare-ID scans instantly and debounces by scanned value', async () => {
        const approve = vi.fn(async () => ({
            status: 'approved' as const,
            already: false,
        }));
        renderRoute(volunteerApi({ approve }));
        await screen.findByRole('heading', { name: 'Approve listener access' });

        scannerTestState.onScan?.('https://bhasha.test/patna-event-2026/volunteer#claim=claim_123');
        scannerTestState.onScan?.('https://bhasha.test/patna-event-2026/volunteer#claim=claim_123');

        await waitFor(() => {
            expect(approve).toHaveBeenCalledTimes(1);
        });
        expect(approve).toHaveBeenNthCalledWith(1, { claimId: 'claim_123' });

        scannerTestState.onScan?.('claim_456');
        await waitFor(() => {
            expect(approve).toHaveBeenCalledTimes(2);
        });
        expect(approve).toHaveBeenNthCalledWith(2, { claimId: 'claim_456' });
    });

    it('preserves a claim hash through login and requires one confirmation tap', async () => {
        window.history.replaceState(null, '', '/patna-event-2026/volunteer#claim=claim_ABC234');
        const sessionMock = vi
            .fn()
            .mockRejectedValueOnce(authError())
            .mockResolvedValueOnce(session(2));
        const approve = vi.fn(async () => ({
            status: 'approved' as const,
            already: false,
        }));
        const api = volunteerApi({ session: sessionMock, approve });
        renderRoute(api);

        fireEvent.change(await screen.findByRole('textbox', { name: 'Login ID' }), {
            target: { value: 'front-gate' },
        });
        fireEvent.change(screen.getByLabelText('Password'), {
            target: { value: 'secret-pass' },
        });
        expect(window.location.hash).toBe('#claim=claim_ABC234');
        fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

        expect(await screen.findByText('Approve code ABC234?')).toBeInTheDocument();
        expect(approve).not.toHaveBeenCalled();
        expect(window.location.hash).toBe('#claim=claim_ABC234');
        fireEvent.click(screen.getByRole('button', { name: 'Approve ABC234' }));

        await waitFor(() => {
            expect(approve).toHaveBeenCalledWith({ claimId: 'claim_ABC234' });
        });
        expect(window.location.hash).toBe('');
        expect(await screen.findByRole('status')).toHaveTextContent('Approved:');
    });

    it('requires confirmation for a claim hash received after mount', async () => {
        const approve = vi.fn(async () => ({
            status: 'approved' as const,
            already: false,
        }));
        renderRoute(volunteerApi({ approve }));
        await screen.findByRole('heading', { name: 'Approve listener access' });

        window.location.hash = '#claim=claim_LATE42';
        fireEvent(window, new Event('hashchange'));

        expect(await screen.findByText('Approve code LATE42?')).toBeInTheDocument();
        expect(approve).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Approve LATE42' }));
        await waitFor(() => {
            expect(approve).toHaveBeenCalledWith({ claimId: 'claim_LATE42' });
        });
    });

    it('releases scanner and wake lock before a pending logout resolves', async () => {
        const release = vi.fn(async () => undefined);
        const request = vi.fn(async () => ({ release }));
        Object.defineProperty(navigator, 'wakeLock', {
            configurable: true,
            value: { request },
        });
        let resolveLogout!: (value: { ok: true }) => void;
        const pendingLogout = new Promise<{ ok: true }>((resolve) => {
            resolveLogout = resolve;
        });
        const logout = vi.fn(() => pendingLogout);
        renderRoute(volunteerApi({ logout }));

        await screen.findByRole('heading', { name: 'Approve listener access' });
        await waitFor(() => expect(request).toHaveBeenCalledWith('screen'));
        fireEvent.click(screen.getByRole('button', { name: 'Log out' }));

        await waitFor(() => expect(scannerTestState.destroy).toHaveBeenCalled());
        await waitFor(() => expect(release).toHaveBeenCalled());
        expect(screen.queryByRole('textbox', { name: 'Login ID' })).not.toBeInTheDocument();

        resolveLogout({ ok: true });
        expect(await screen.findByRole('textbox', { name: 'Login ID' })).toBeInTheDocument();
    });

    it('promotes manual entry and gives an in-app hint when camera permission is denied', async () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
            'Mozilla/5.0 Instagram 309.0.0 Mobile',
        );
        const permissionError = normalizeQrScannerError(
            new DOMException('Permission denied', 'NotAllowedError'),
        );
        scannerTestState.start.mockRejectedValueOnce(permissionError);
        renderRoute(volunteerApi());

        expect(
            await screen.findByText('Camera access was denied. Enter the short code instead.'),
        ).toBeInTheDocument();
        expect(
            screen.getByText('Open this page in Safari or Chrome to use the camera'),
        ).toBeInTheDocument();
        expect(screen.queryByText(/phone's Camera app/)).not.toBeInTheDocument();
        expect(screen.getByTestId('manual-code-panel')).toHaveClass('volunteer-manual-primary');
    });

    it('shows the generic camera hint outside an in-app browser', async () => {
        vi.stubGlobal('RTCPeerConnection', class {});
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
            'Mozilla/5.0 Version/17.5 Mobile Safari/604.1',
        );
        scannerTestState.start.mockRejectedValueOnce(
            normalizeQrScannerError(
                new DOMException('Requested device not found', 'NotFoundError'),
            ),
        );
        renderRoute(volunteerApi());

        expect(
            await screen.findByText("A camera isn't available. Enter the short code instead."),
        ).toBeInTheDocument();
        expect(screen.getByText(/phone's Camera app/)).toBeInTheDocument();
        expect(
            screen.queryByText('Open this page in Safari or Chrome to use the camera'),
        ).not.toBeInTheDocument();
    });
});
