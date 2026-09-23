import type { ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/api/client';
import type {
    AdminApi,
    AdminMe,
    AdminEventFeed,
    AdminListenerReport,
    AdminProgram,
    AdminProgramDetail,
    AdminProgramVolunteerAccess,
    AdminProgramList,
    AdminProgramStatus,
    AdminReadiness,
    AdminRole,
    AdminReportSummary,
    AdminRetentionRun,
    AdminUser,
    TranslatorSessionSummary,
    UpdateProgramPayload,
} from '../src/api/admin';
import { AdminScreen } from '../src/features/admin/AdminScreen';
import * as adminApiModule from '../src/api/admin';

vi.mock('qrcode.react', () => ({
    QRCodeSVG: ({
        'aria-label': ariaLabel,
        title,
        value,
    }: {
        'aria-label'?: string;
        title?: string;
        value: string;
    }) => (
        <svg aria-label={ariaLabel} data-qr-value={value} role="img">
            {title ? <title>{title}</title> : null}
        </svg>
    ),
}));

const DEFAULT_EVENT_TYPES = [
    'translator_connected',
    'translator_disconnected',
    'listener_reconnected',
    'listener_left',
];

const originalLocation = window.location;

beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'location', {
        configurable: true,
        value: {
            ...originalLocation,
            origin: 'https://bhasha.test',
        },
    });
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

function renderAdmin(ui: ReactElement) {
    return render(
        <MemoryRouter initialEntries={['/admin']}>
            <Routes>
                <Route path="/admin" element={ui} />
                <Route path="/admin/programs/:slug" element={ui} />
                <Route path="/admin/programs/:slug/:section" element={ui} />
            </Routes>
        </MemoryRouter>,
    );
}

function authRequired(): ApiError {
    return new ApiError({
        status: 401,
        code: 'admin_auth_required',
        body: { error: 'admin_auth_required' },
    });
}

function apiError(code: string, status = 400): ApiError {
    return new ApiError({ status, code, body: { error: code } });
}

function programList(): AdminProgramList {
    return {
        programs: [
            {
                id: 'program_1',
                slug: 'patna-event-2026',
                name: 'Patna Event 2026',
                venue: 'Main Hall',
                eventDate: '2026-07-01',
                status: 'draft',
                adminNotes: 'Doors at 6',
                accessControlEnabled: false,
                createdAt: '2026-06-01T10:00:00.000Z',
                updatedAt: '2026-06-01T10:00:00.000Z',
                firstLiveAt: null,
            },
        ],
    };
}

function firstProgram(): AdminProgram {
    return programList().programs[0]!;
}

function programDetail(): AdminProgramDetail {
    return {
        program: firstProgram(),
        streams: [
            {
                id: 'stream_hi',
                languageName: 'Hindi',
                languageCode: 'hi',
                displayOrder: 1,
                isActive: true,
                createdAt: '2026-06-01T10:00:00.000Z',
                updatedAt: '2026-06-01T10:00:00.000Z',
            },
            {
                id: 'stream_en',
                languageName: 'English',
                languageCode: 'en',
                displayOrder: 2,
                isActive: true,
                createdAt: '2026-06-01T10:00:00.000Z',
                updatedAt: '2026-06-01T10:00:00.000Z',
            },
        ],
        translators: [
            {
                id: 'translator_hindi',
                email: 'hindi@example.com',
                name: 'Hindi Translator',
                assignments: [
                    {
                        streamId: 'stream_hi',
                        languageName: 'Hindi',
                        languageCode: 'hi',
                    },
                ],
            },
        ],
        urls: {
            listenerUrl: 'https://api.example.invalid/ignored',
            translatorUrl: 'https://api.example.invalid/ignored/translate',
            volunteerUrl: 'https://api.example.invalid/ignored/volunteer',
        },
        qrPayload: 'https://bhasha.test/patna-event-2026',
        suggestedQrFilename: 'patna-event-2026-listener-qr.png',
    };
}

function status(): AdminProgramStatus {
    return {
        programId: 'program_1',
        totalActiveListeners: 42,
        streams: [
            {
                id: 'stream_hi',
                languageName: 'Hindi',
                languageCode: 'hi',
                isActive: true,
                state: 'live',
                activeListeners: 30,
            },
            {
                id: 'stream_en',
                languageName: 'English',
                languageCode: 'en',
                isActive: true,
                state: 'silent',
                activeListeners: 12,
            },
        ],
        stale: false,
        degraded: true,
        updatedAt: '2026-06-20T12:00:00.000Z',
        serverTime: '2026-06-20T12:00:05.000Z',
    };
}

function listenerReport(): AdminListenerReport {
    return {
        total: 1,
        page: 1,
        pageSize: 100,
        totalPages: 1,
        connections: [
            {
                id: 'listener_1',
                programId: 'program_1',
                streamId: 'stream_hi',
                clientId: 'client_1',
                subscriptionStatus: 'connected',
                connectedAt: '2026-06-20T12:00:00.000Z',
                disconnectedAt: null,
                disconnectReason: null,
                listenerIp: '203.0.113.10',
                userAgent: 'Mobile Safari',
                lastSeenAt: '2026-06-20T12:05:00.000Z',
                deviceLabel: 'Safari on iPhone',
                deviceModel: 'iPhone',
                deviceModelName: 'Apple iPhone',
                platform: 'iOS',
                platformVersion: '17.0',
                browserFullVersion: '17.0.1',
                approvalStatus: 'approved',
                approvedAt: '2026-06-20T11:55:00.000Z',
                approvedVia: 'scan',
                hasRevokedHistory: false,
            },
        ],
    };
}

function reportSummary(): AdminReportSummary {
    return {
        programId: 'program_1',
        totals: {
            activeListeners: 42,
            totalConnections: 120,
            uniqueDevices: 84,
            dropouts: 7,
            reconnects: 13,
        },
        streams: [
            {
                streamId: 'stream_hi',
                languageName: 'Hindi',
                languageCode: 'hi',
                activeListeners: 30,
                totalConnections: 80,
                dropouts: 4,
                reconnects: 9,
            },
        ],
        generatedAt: '2026-06-21T10:00:00.000Z',
        presenceSource: 'durable_object',
    };
}

function eventFeed(): AdminEventFeed {
    return {
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        events: [
            {
                id: 'ev_1',
                eventType: 'connection_failed',
                occurredAt: '2026-06-21T10:00:00.000Z',
                stream: {
                    id: 'stream_hi',
                    languageName: 'Hindi',
                    languageCode: 'hi',
                },
                translatorName: null,
                translatorDeviceLabel: null,
                metadata: { reason: 'ice_failed', connectionId: 'lc_1' },
            },
        ],
    };
}

function adminMe(role: AdminRole = 'admin'): AdminMe {
    return {
        id: `user-${role}`,
        username: `${role}_user`,
        role,
    };
}

function adminUser(overrides: Partial<AdminUser> = {}): AdminUser {
    return {
        id: 'user_1',
        username: 'plain_user',
        role: 'user',
        isDisabled: false,
        createdAt: '2026-06-01T10:00:00.000Z',
        updatedAt: '2026-06-01T10:00:00.000Z',
        ...overrides,
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

function readiness(): AdminReadiness {
    return {
        programId: 'program_1',
        items: [
            {
                id: 'program_setup',
                label: 'Program setup',
                status: 'green',
                detail: 'Program details are configured.',
            },
            {
                id: 'turn_configured',
                label: 'TURN credentials configured',
                status: 'blocker',
                detail: 'Cloudflare TURN is not configured.',
            },
            {
                id: 'turn_analytics_tagging',
                label: 'TURN analytics tagging',
                status: 'warning',
                detail: 'TURN usage analytics tagging is not enabled.',
            },
            {
                id: 'realtime_smoke_tested',
                label: 'Realtime smoke tested',
                status: 'blocker',
                detail: 'No realtime smoke test has been confirmed yet.',
            },
            {
                id: 'mobile_field_tested',
                label: 'Mobile field tested',
                status: 'blocker',
                detail: 'No mobile field test has been confirmed yet.',
            },
        ],
    };
}

function readinessConfirmed(): AdminReadiness {
    const base = readiness();
    return {
        programId: base.programId,
        items: base.items.map((item) =>
            item.id === 'realtime_smoke_tested'
                ? {
                      ...item,
                      status: 'green',
                      detail: 'Operator confirmed a realtime smoke test.',
                      checkedAt: '2026-06-21T11:00:00.000Z',
                  }
                : item,
        ),
    };
}

function retentionRun(): AdminRetentionRun {
    return {
        programId: 'program_1',
        processed: false,
        anonymizedConnections: 0,
        retentionProcessedAt: null,
    };
}

function volunteerAccess(
    overrides: Partial<AdminProgramVolunteerAccess> = {},
): AdminProgramVolunteerAccess {
    return {
        configured: true,
        loginId: 'volunteer@example.com',
        passwordUpdatedAt: '2026-08-26T12:00:00.000Z',
        activeSessionCount: 3,
        ...overrides,
    };
}

function translatorSession(
    now: number,
    overrides: Partial<TranslatorSessionSummary> = {},
): TranslatorSessionSummary {
    return {
        sessionId: 'session_live',
        deviceLabel: 'Desktop Mic',
        loginAt: new Date(now - 4 * 60 * 1000).toISOString(),
        lastActiveAt: new Date(now - 5 * 1000).toISOString(),
        isPublishing: false,
        ...overrides,
    };
}

function makeApi(overrides: Partial<AdminApi> = {}): AdminApi {
    return {
        addTranslatorAssignment: vi.fn(async () => programDetail().translators[0]!),
        me: vi.fn(async () => adminMe()),
        archiveProgram: vi.fn(async () => programDetail()),
        createProgram: vi.fn(async () => firstProgram()),
        createStream: vi.fn(async () => programDetail().streams[0]!),
        createTranslator: vi.fn(async () => programDetail().translators[0]!),
        deleteProgram: vi.fn(async () => undefined),
        deleteStream: vi.fn(async () => undefined),
        deleteTranslator: vi.fn(async () => undefined),
        listUsers: vi.fn(async () => ({ users: [adminUser()] })),
        downloadListenerReportCsv: vi.fn(
            async () => new Blob(['connectionId\r\n'], { type: 'text/csv' }),
        ),
        listDeletedPrograms: vi.fn(async () => []),
        createUser: vi.fn(async () => adminUser({ role: 'user' })),
        updateUser: vi.fn(async () => adminUser()),
        resetUserPassword: vi.fn(async () => ({ ok: true as const })),
        getEventFeed: vi.fn(async () => eventFeed()),
        getListenerReport: vi.fn(async () => listenerReport()),
        getListenerAccessSummary: vi.fn(async () => ({
            pending: 2,
            approved: 3,
            revoked: 1,
        })),
        revokeListenerAccess: vi.fn(async () => ({ revoked: 1 })),
        getProgramDetail: vi.fn(async () => programDetail()),
        getVolunteerAccess: vi.fn(async () => volunteerAccess()),
        getProgramStatus: vi.fn(async () => status()),
        getReadiness: vi.fn(async () => readiness()),
        confirmReadiness: vi.fn(async () => readinessConfirmed()),
        getReportSummary: vi.fn(async () => reportSummary()),
        listPrograms: vi.fn(async () => programList()),
        restoreProgram: vi.fn(async () => undefined),
        login: vi.fn(async () => ({ ok: true as const })),
        logout: vi.fn(async () => ({ ok: true as const })),
        changeMyPassword: vi.fn(async () => ({ ok: true as const })),
        removeTranslatorAssignment: vi.fn(async () => programDetail().translators[0]!),
        resetTranslatorPassword: vi.fn(async () => programDetail().translators[0]!),
        getTranslatorSessions: vi.fn(async () => ({
            sessions: [translatorSession(Date.parse('2026-06-24T10:00:00.000Z'))],
        })),
        revokeSession: vi.fn(async () => ({ ok: true })),
        revokeAllSessions: vi.fn(async () => ({ ok: true })),
        runRetention: vi.fn(async () => retentionRun()),
        kickPublisher: vi.fn(async () => ({ freed: true })),
        updateVolunteerAccess: vi.fn(async () => volunteerAccess()),
        updateProgram: vi.fn(async () => programDetail()),
        updateStream: vi.fn(async () => programDetail().streams[0]!),
        updateTranslator: vi.fn(async () => programDetail().translators[0]!),
        ...overrides,
    };
}

async function goToSection(name: string) {
    await screen.findByRole('button', { name });
    fireEvent.click(screen.getByRole('button', { name }));
    const headingName =
        name === 'Reports'
            ? 'Report summary'
            : name === 'Status'
              ? 'Listener counts'
              : name === 'Readiness'
                ? 'Event readiness'
                : name;
    await screen.findByRole('heading', { name: headingName });
}

async function openFirstProgram() {
    const card = await screen.findByRole('button', {
        name: /Patna Event 2026/,
    });
    fireEvent.click(card);
    return card;
}

async function openProgramCard(name: RegExp) {
    const card = await screen.findByRole('button', { name });
    fireEvent.click(card);
    return card;
}

describe('AdminScreen', () => {
    it('shows login when the auth probe returns admin_auth_required', async () => {
        const api = makeApi({
            listPrograms: vi.fn(async () => {
                throw authRequired();
            }),
        });

        renderAdmin(<AdminScreen adminApi={api} />);

        expect(await screen.findByRole('heading', { name: 'Admin login' })).toBeInTheDocument();
        expect(screen.getByLabelText('Username')).toBeInTheDocument();
        expect(screen.getByLabelText('Admin password')).toBeInTheDocument();
    });

    it('shows invalid login errors', async () => {
        const api = makeApi({
            listPrograms: vi.fn(async () => {
                throw authRequired();
            }),
            login: vi.fn(async () => {
                throw apiError('invalid_admin_password', 401);
            }),
        });

        renderAdmin(<AdminScreen adminApi={api} />);

        fireEvent.change(await screen.findByLabelText('Username'), {
            target: { value: 'admin' },
        });
        fireEvent.change(await screen.findByLabelText('Admin password'), {
            target: { value: 'wrong-pass' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password');
    });

    it('reprobes after successful login and loads the program list', async () => {
        const listPrograms = vi
            .fn()
            .mockRejectedValueOnce(authRequired())
            .mockResolvedValueOnce(programList());
        const api = makeApi({ listPrograms });

        renderAdmin(<AdminScreen adminApi={api} />);

        fireEvent.change(await screen.findByLabelText('Username'), {
            target: { value: 'admin' },
        });
        fireEvent.change(await screen.findByLabelText('Admin password'), {
            target: { value: 'admin-pass' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

        expect(await screen.findByText('Patna Event 2026')).toBeInTheDocument();
        expect(api.login).toHaveBeenCalledWith('admin', 'admin-pass');
        expect(listPrograms).toHaveBeenCalledTimes(2);
    });

    it('renders role-aware app navigation for admins', async () => {
        const api = makeApi({ me: vi.fn(async () => adminMe('admin')) });

        renderAdmin(<AdminScreen adminApi={api} />);

        expect(await screen.findByRole('button', { name: 'Programs' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Recently deleted' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Users' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Account' })).toBeInTheDocument();
    });

    it("renders role-aware app navigation for plain 'user' accounts (no Users nav)", async () => {
        const api = makeApi({ me: vi.fn(async () => adminMe('user')) });

        renderAdmin(<AdminScreen adminApi={api} />);

        expect(await screen.findByRole('button', { name: 'Programs' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Recently deleted' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Account' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Users' })).not.toBeInTheDocument();
    });

    it('renders Users and posts create-user (admin only, hardcoded to the user role)', async () => {
        const createUser = vi.fn(async () => adminUser({ id: 'user_2', username: 'new_user' }));
        const api = makeApi({
            me: vi.fn(async () => adminMe('admin')),
            createUser,
            listUsers: vi.fn(async () => ({
                users: [adminUser({ id: 'user_1', username: 'existing_user' })],
            })),
        });

        renderAdmin(<AdminScreen adminApi={api} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Users' }));

        expect(await screen.findByRole('heading', { name: 'Users' })).toBeInTheDocument();
        expect(screen.getByText('existing_user')).toBeInTheDocument();

        fireEvent.change(await screen.findByLabelText('Username'), {
            target: { value: 'new_user' },
        });
        fireEvent.change(screen.getByLabelText('Temp password'), {
            target: { value: 'new-user-pass' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Create user' }));

        await waitFor(() => {
            expect(createUser).toHaveBeenCalledWith({
                username: 'new_user',
                role: 'user',
                tempPassword: 'new-user-pass',
            });
        });
    });

    it('calls changeMyPassword from the Account panel', async () => {
        const changeMyPassword = vi.fn(async () => ({ ok: true as const }));
        const api = makeApi({
            me: vi.fn(async () => adminMe('admin')),
            changeMyPassword,
        });

        renderAdmin(<AdminScreen adminApi={api} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Account' }));

        fireEvent.change(await screen.findByLabelText('Current password'), {
            target: { value: 'old-pass' },
        });
        fireEvent.change(screen.getByLabelText('New password'), {
            target: { value: 'new-pass' },
        });
        fireEvent.change(screen.getByLabelText('Confirm new password'), {
            target: { value: 'new-pass' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

        expect(await screen.findByText('Password updated successfully.')).toBeInTheDocument();
        expect(changeMyPassword).toHaveBeenCalledWith({
            currentPassword: 'old-pass',
            newPassword: 'new-pass',
        });
    });

    it('signs out from the Account panel and returns to the login screen', async () => {
        const logout = vi.fn(async () => ({ ok: true as const }));
        const api = makeApi({
            me: vi.fn(async () => adminMe('admin')),
            logout,
        });

        renderAdmin(<AdminScreen adminApi={api} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Account' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

        expect(logout).toHaveBeenCalled();
        // Back to the login screen (username/password fields visible again).
        expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    });

    it('derives listener and translator URLs from the program slug and browser origin', async () => {
        renderAdmin(<AdminScreen adminApi={makeApi()} />);

        expect(await screen.findByText('Patna Event 2026')).toBeInTheDocument();
        expect(screen.getByText('DRAFT')).toBeInTheDocument();
        expect(screen.getByText('https://bhasha.test/patna-event-2026')).toBeInTheDocument();
        expect(
            screen.getByText('https://bhasha.test/patna-event-2026/translate'),
        ).toBeInTheDocument();
    });

    it('opens a program by clicking the program card instead of an Open button', async () => {
        const api = makeApi();

        renderAdmin(<AdminScreen adminApi={api} />);

        await screen.findByText('Patna Event 2026');
        expect(
            screen.queryByRole('button', { name: 'Open Patna Event 2026' }),
        ).not.toBeInTheDocument();

        fireEvent.click(
            screen.getByRole('button', {
                name: /Patna Event 2026[\s\S]*Main Hall/,
            }),
        );

        await waitFor(() => {
            expect(api.getProgramDetail).toHaveBeenCalledWith('program_1');
        });
    });

    it('surfaces server validation messages when program creation fails', async () => {
        const createProgram = vi.fn(async () => {
            throw new ApiError({
                status: 400,
                code: 'validation_error',
                body: {
                    error: 'validation_error',
                    message: 'slug must use lowercase letters, numbers, and hyphens',
                },
            });
        });
        const api = makeApi({ createProgram });

        renderAdmin(<AdminScreen adminApi={api} />);

        await screen.findByText('Patna Event 2026');
        fireEvent.change(screen.getByLabelText('Program name'), {
            target: { value: 'Bad Slug Event' },
        });
        fireEvent.change(screen.getByLabelText('Program slug'), {
            target: { value: 'Bad Slug' },
        });
        fireEvent.change(screen.getByLabelText('Program venue'), {
            target: { value: 'Main Hall' },
        });
        fireEvent.change(screen.getByLabelText('Program date'), {
            target: { value: '2026-07-01' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Create program' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'slug must use lowercase letters, numbers, and hyphens',
        );
        expect(screen.queryByText('validation_error')).not.toBeInTheDocument();
    });

    it.each(['admin', 'user'] as const)(
        'shows the create-program form for %s accounts (both roles can now create programs)',
        async (role) => {
            const api = makeApi({ me: vi.fn(async () => adminMe(role)) });

            renderAdmin(<AdminScreen adminApi={api} />);

            await screen.findByText('Patna Event 2026');
            expect(
                await screen.findByRole('button', { name: 'Create program' }),
            ).toBeInTheDocument();
            expect(screen.getByLabelText('Program name')).toBeInTheDocument();
        },
    );

    it('includes the listener access toggle in the create-program payload', async () => {
        const createProgram = vi.fn(async () => firstProgram());
        const api = makeApi({ createProgram });

        renderAdmin(<AdminScreen adminApi={api} />);

        await screen.findByRole('button', { name: 'Create program' });
        fireEvent.change(screen.getByLabelText('Program name'), {
            target: { value: 'Gaya Event 2026' },
        });
        fireEvent.change(screen.getByLabelText('Program slug'), {
            target: { value: 'gaya-event-2026' },
        });
        fireEvent.change(screen.getByLabelText('Program venue'), {
            target: { value: 'Main Hall' },
        });
        fireEvent.change(screen.getByLabelText('Program date'), {
            target: { value: '2026-09-01' },
        });
        expect(
            screen.getByText('Listeners must be approved by a volunteer before they can listen'),
        ).toBeInTheDocument();
        const accessToggle = screen.getByRole('checkbox', {
            name: /Require listener approval.*before they can listen/i,
        });
        expect(accessToggle).toHaveAccessibleDescription(
            'Listeners must be approved by a volunteer before they can listen',
        );
        fireEvent.click(accessToggle);
        fireEvent.click(screen.getByRole('button', { name: 'Create program' }));

        await waitFor(() => expect(createProgram).toHaveBeenCalledTimes(1));
        expect(createProgram).toHaveBeenCalledWith(
            expect.objectContaining({
                slug: 'gaya-event-2026',
                accessControlEnabled: true,
            }),
        );
    });

    it('selecting a program fetches detail and status separately', async () => {
        const api = makeApi();

        renderAdmin(<AdminScreen adminApi={api} />);

        await openFirstProgram();

        await waitFor(() => {
            expect(api.getProgramDetail).toHaveBeenCalledWith('program_1');
            expect(api.getProgramStatus).toHaveBeenCalledWith('program_1');
        });
        await goToSection('Status');
        expect((await screen.findAllByText('Hindi')).length).toBeGreaterThan(0);
        expect(screen.getByText('Listener counts')).toBeInTheDocument();
    });

    it('renders volunteer access in Overview and renders the QR panel only in Share', async () => {
        const api = makeApi();

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();

        const programNameInput = await screen.findByLabelText('Detail program name');
        const volunteerHeading = await screen.findByRole('heading', {
            name: 'Volunteer access',
        });
        expect(
            programNameInput.compareDocumentPosition(volunteerHeading) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(screen.queryByRole('heading', { name: 'Share / QR' })).not.toBeInTheDocument();
        expect(screen.queryByRole('img', { name: 'Listener QR' })).not.toBeInTheDocument();

        await goToSection('Share / QR');
        expect(screen.getAllByRole('heading', { name: 'Share / QR' })).toHaveLength(1);
        expect(screen.getAllByRole('img', { name: 'Listener QR' })).toHaveLength(1);
    });

    it('shows the submitted custom volunteer password in the password-once dialog', async () => {
        const updateVolunteerAccess = vi.fn<AdminApi['updateVolunteerAccess']>(async () => ({
            configured: true,
            loginId: 'desk-team@example.com',
            passwordUpdatedAt: '2026-08-26T12:30:00.000Z',
            activeSessionCount: 0,
        }));
        const api = makeApi({ updateVolunteerAccess });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();

        fireEvent.change(await screen.findByLabelText('Volunteer login ID'), {
            target: { value: 'desk-team@example.com' },
        });
        fireEvent.change(screen.getByLabelText('Volunteer password'), {
            target: { value: 'custom-pass-1' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Save volunteer access' }));

        await waitFor(() => {
            expect(updateVolunteerAccess).toHaveBeenCalledWith('program_1', {
                loginId: 'desk-team@example.com',
                password: 'custom-pass-1',
            });
        });
        expect(await screen.findByText('custom-pass-1')).toBeInTheDocument();
        expect(screen.getByRole('dialog', { name: 'Volunteer password' })).toBeInTheDocument();
    });

    it('shows a server-generated volunteer password when the password is omitted', async () => {
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText },
        });
        const updateVolunteerAccess = vi.fn<AdminApi['updateVolunteerAccess']>(async () => ({
            configured: true,
            loginId: 'desk-team@example.com',
            passwordUpdatedAt: '2026-08-26T12:30:00.000Z',
            activeSessionCount: 0,
            generatedPassword: 'ABCD2345EF',
        }));
        const api = makeApi({ updateVolunteerAccess });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();

        expect(await screen.findByText('3 active sessions')).toBeInTheDocument();
        expect(
            screen.getByText('Saving changes resets all volunteer sessions.'),
        ).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Volunteer login ID'), {
            target: { value: 'desk-team@example.com' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Save volunteer access' }));

        await waitFor(() => {
            expect(updateVolunteerAccess).toHaveBeenCalledWith('program_1', {
                loginId: 'desk-team@example.com',
            });
        });

        expect(await screen.findByText('ABCD2345EF')).toBeInTheDocument();
        expect(screen.getByText("You won't be able to see it again.")).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Copy password' }));
        await waitFor(() => {
            expect(writeText).toHaveBeenCalledWith('ABCD2345EF');
        });
        expect(screen.getByRole('status')).toHaveTextContent('Copied');
    });

    it('clears a shown-once volunteer password when the selected program changes', async () => {
        const secondProgram: AdminProgram = {
            ...firstProgram(),
            id: 'program_2',
            slug: 'delhi-event-2026',
            name: 'Delhi Event 2026',
        };
        const getVolunteerAccess = vi.fn(async (programId: string) =>
            volunteerAccess({
                loginId: programId === 'program_2' ? 'delhi-team' : 'patna-team',
            }),
        );
        const api = makeApi({
            listPrograms: vi.fn(async () => ({
                programs: [firstProgram(), secondProgram],
            })),
            getProgramDetail: vi.fn(async (programId: string) => ({
                ...programDetail(),
                program: programId === 'program_2' ? secondProgram : firstProgram(),
            })),
            getVolunteerAccess,
            updateVolunteerAccess: vi.fn(async () => ({
                ...volunteerAccess({ loginId: 'patna-team', activeSessionCount: 0 }),
                generatedPassword: 'PATNA2345A',
            })),
        });

        render(
            <MemoryRouter initialEntries={['/admin/programs/patna-event-2026']}>
                <Link to="/admin/programs/delhi-event-2026">Switch to Delhi</Link>
                <Routes>
                    <Route path="/admin/programs/:slug" element={<AdminScreen adminApi={api} />} />
                </Routes>
            </MemoryRouter>,
        );

        await screen.findByDisplayValue('patna-team');
        fireEvent.click(screen.getByRole('button', { name: 'Save volunteer access' }));
        expect(await screen.findByText('PATNA2345A')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('link', { name: 'Switch to Delhi' }));
        await waitFor(() => {
            expect(getVolunteerAccess).toHaveBeenCalledWith('program_2');
        });
        expect(screen.queryByText('PATNA2345A')).not.toBeInTheDocument();
        expect(
            screen.queryByRole('dialog', { name: 'Volunteer password' }),
        ).not.toBeInTheDocument();
    });

    it('refreshes listener counts from the Status tab', async () => {
        const getProgramDetail = vi.fn(async () => programDetail());
        const getProgramStatus = vi.fn(async () => status());
        const api = makeApi({ getProgramDetail, getProgramStatus });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Status');

        const before = getProgramStatus.mock.calls.length;
        fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));

        await waitFor(() => {
            expect(getProgramStatus).toHaveBeenCalledTimes(before + 1);
        });
        expect(getProgramDetail).toHaveBeenLastCalledWith('program_1');
    });

    it('loads and renders report summary, recent events, and CSV download on select', async () => {
        const api = makeApi();

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();

        await waitFor(() => {
            expect(api.getReportSummary).toHaveBeenCalledWith('program_1', undefined);
            expect(api.getEventFeed).toHaveBeenCalledWith('program_1', {
                range: undefined,
                eventTypes: DEFAULT_EVENT_TYPES,
                page: 1,
                pageSize: 20,
            });
        });
        await goToSection('Reports');

        const summaryPanel = await screen.findByLabelText('Report summary');
        expect(summaryPanel).toHaveTextContent('42');
        expect(summaryPanel).toHaveTextContent('7');

        const summaryPanelAfterReports = screen.getByLabelText('Report summary');
        expect(summaryPanelAfterReports).toHaveTextContent('42');

        const eventsSummary = screen.getByRole('button', { name: /Recent events/ });
        expect(eventsSummary).toHaveAttribute('aria-expanded', 'false');
        expect(eventsSummary).toHaveTextContent('1');
        fireEvent.click(eventsSummary);
        await waitFor(() => expect(eventsSummary).toHaveAttribute('aria-expanded', 'true'));

        const eventsPanel = screen.getByLabelText('Recent events');
        expect(eventsPanel).toHaveTextContent('Listener connection failed — ice_failed');
        expect(eventsPanel).toHaveTextContent('ice_failed');

        expect(
            screen.queryByRole('button', { name: 'Open listener report' }),
        ).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Listener report/ }));

        expect(await screen.findByRole('button', { name: 'Download CSV' })).toBeInTheDocument();
    });

    it('refetches summary, events, and listener report when the report date range changes', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-06-21T10:30:00.000Z'));
        const getReportSummary = vi.fn<AdminApi['getReportSummary']>(async () => reportSummary());
        const getEventFeed = vi.fn<AdminApi['getEventFeed']>(async () => eventFeed());
        const getListenerReport = vi.fn<AdminApi['getListenerReport']>(async () =>
            listenerReport(),
        );
        const getListenerAccessSummary = vi.fn<AdminApi['getListenerAccessSummary']>(async () => ({
            pending: 2,
            approved: 3,
            revoked: 1,
        }));
        const api = makeApi({
            getReportSummary,
            getEventFeed,
            getListenerReport,
            getListenerAccessSummary,
        });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');
        fireEvent.click(screen.getByRole('button', { name: /Listener report/ }));
        await screen.findByRole('button', { name: 'Download CSV' });

        const beforeSummaryCalls = getReportSummary.mock.calls.length;
        const beforeEventCalls = getEventFeed.mock.calls.length;
        const beforeListenerCalls = getListenerReport.mock.calls.length;

        fireEvent.change(screen.getByLabelText('Range'), {
            target: { value: 'Last 24 hours' },
        });

        await waitFor(() => {
            expect(getReportSummary.mock.calls.length).toBeGreaterThan(beforeSummaryCalls);
            expect(getEventFeed.mock.calls.length).toBeGreaterThan(beforeEventCalls);
            expect(getListenerReport.mock.calls.length).toBeGreaterThan(beforeListenerCalls);
        });
        const summaryRange = getReportSummary.mock.calls.at(-1)?.[1];
        const eventOptions = getEventFeed.mock.calls.at(-1)?.[1];
        const listenerQuery = getListenerReport.mock.calls.at(-1)?.[1];
        expect(summaryRange?.from).toBeDefined();
        expect(summaryRange?.to).toBeDefined();
        expect(eventOptions).toMatchObject({
            range: summaryRange,
            page: 1,
            pageSize: 20,
        });
        expect(listenerQuery).toMatchObject({
            createdFrom: summaryRange?.from,
            createdTo: summaryRange?.to,
        });
    });

    it('interprets custom report datetime inputs as IST when building report queries', async () => {
        const originalTimeZone = process.env.TZ;
        process.env.TZ = 'America/New_York';
        try {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            vi.setSystemTime(new Date('2026-06-21T10:30:00.000Z'));
            const getReportSummary = vi.fn<AdminApi['getReportSummary']>(async () =>
                reportSummary(),
            );
            const getEventFeed = vi.fn<AdminApi['getEventFeed']>(async () => eventFeed());
            const getListenerReport = vi.fn<AdminApi['getListenerReport']>(async () =>
                listenerReport(),
            );
            const api = makeApi({
                getReportSummary,
                getEventFeed,
                getListenerReport,
            });

            renderAdmin(<AdminScreen adminApi={api} />);
            await openFirstProgram();
            await goToSection('Reports');

            fireEvent.change(screen.getByLabelText('Range'), {
                target: { value: 'Custom' },
            });
            fireEvent.change(await screen.findByLabelText('From'), {
                target: { value: '2026-06-21T09:15' },
            });
            fireEvent.click(screen.getByRole('button', { name: /Listener report/ }));

            await waitFor(() => {
                expect(getReportSummary.mock.calls.at(-1)?.[1]).toMatchObject({
                    from: '2026-06-21T03:45:00.000Z',
                });
                expect(getEventFeed.mock.calls.at(-1)?.[1]).toMatchObject({
                    range: { from: '2026-06-21T03:45:00.000Z' },
                });
                expect(getListenerReport.mock.calls.at(-1)?.[1]).toMatchObject({
                    createdFrom: '2026-06-21T03:45:00.000Z',
                });
            });
        } finally {
            process.env.TZ = originalTimeZone;
        }
    });

    it('computes Today as the current Asia/Kolkata calendar day', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-06-21T10:30:00.000Z'));
        const getReportSummary = vi.fn<AdminApi['getReportSummary']>(async () => reportSummary());
        const getEventFeed = vi.fn<AdminApi['getEventFeed']>(async () => eventFeed());
        const api = makeApi({ getReportSummary, getEventFeed });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');

        fireEvent.change(screen.getByLabelText('Range'), {
            target: { value: 'Today' },
        });

        await waitFor(() => {
            expect(getReportSummary.mock.calls.at(-1)?.[1]).toMatchObject({
                from: '2026-06-20T18:30:00.000Z',
                to: expect.any(String),
            });
        });
        const summaryRange = getReportSummary.mock.calls.at(-1)?.[1];
        const eventOptions = getEventFeed.mock.calls.at(-1)?.[1];
        const selectedAt = Date.parse('2026-06-21T10:30:00.000Z');
        const selectedTo = Date.parse(summaryRange?.to ?? '');
        expect(selectedTo).toBeGreaterThanOrEqual(selectedAt);
        expect(selectedTo).toBeLessThan(selectedAt + 1000);
        expect(eventOptions).toMatchObject({
            range: summaryRange,
        });
    });

    it('uses a fresh sliding range for each relative summary and events fetch', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-06-21T10:30:00.000Z'));
        const getReportSummary = vi.fn<AdminApi['getReportSummary']>(async () => reportSummary());
        const getEventFeed = vi.fn<AdminApi['getEventFeed']>(async () => eventFeed());
        const api = makeApi({ getReportSummary, getEventFeed });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');

        fireEvent.change(screen.getByLabelText('Range'), {
            target: { value: 'Last 5 minutes' },
        });

        await waitFor(() => {
            expect(getReportSummary.mock.calls.at(-1)?.[1]).toEqual(
                expect.objectContaining({
                    from: expect.any(String),
                    to: expect.any(String),
                }),
            );
        });
        const firstSummaryRange = getReportSummary.mock.calls.at(-1)?.[1];
        const firstEventRange = getEventFeed.mock.calls.at(-1)?.[1];
        expect(firstEventRange).toMatchObject({
            range: firstSummaryRange,
            page: 1,
            pageSize: 20,
        });

        const beforePollSummaryCalls = getReportSummary.mock.calls.length;
        const beforePollEventCalls = getEventFeed.mock.calls.length;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(20_000);
        });

        await waitFor(() => {
            expect(getReportSummary.mock.calls.length).toBe(beforePollSummaryCalls + 1);
            expect(getEventFeed.mock.calls.length).toBe(beforePollEventCalls + 1);
        });
        const secondSummaryRange = getReportSummary.mock.calls.at(-1)?.[1];
        const secondEventRange = getEventFeed.mock.calls.at(-1)?.[1];
        expect(secondEventRange).toMatchObject({
            range: secondSummaryRange,
            page: 1,
            pageSize: 20,
        });
        expect(secondSummaryRange?.to).not.toBe(firstSummaryRange?.to);
        expect(Date.parse(secondSummaryRange?.to ?? '')).toBeGreaterThan(
            Date.parse(firstSummaryRange?.to ?? ''),
        );
        expect(Date.parse(secondSummaryRange?.from ?? '')).toBeGreaterThan(
            Date.parse(firstSummaryRange?.from ?? ''),
        );
    });

    it('auto-refreshes reports every 20 seconds only while visible and mounted', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const getReportSummary = vi.fn<AdminApi['getReportSummary']>(async () => reportSummary());
        const getEventFeed = vi.fn<AdminApi['getEventFeed']>(async () => eventFeed());
        const getListenerReport = vi.fn<AdminApi['getListenerReport']>(async () =>
            listenerReport(),
        );
        const getListenerAccessSummary = vi.fn<AdminApi['getListenerAccessSummary']>(async () => ({
            pending: 2,
            approved: 3,
            revoked: 1,
        }));
        const api = makeApi({
            getReportSummary,
            getEventFeed,
            getListenerReport,
            getListenerAccessSummary,
        });

        const { unmount } = renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');

        const beforePollSummaryCalls = getReportSummary.mock.calls.length;
        const beforePollEventCalls = getEventFeed.mock.calls.length;
        const beforePollListenerCalls = getListenerReport.mock.calls.length;
        const beforePollAccessCalls = getListenerAccessSummary.mock.calls.length;

        await act(async () => {
            await vi.advanceTimersByTimeAsync(20_000);
        });

        await waitFor(() => {
            expect(getReportSummary.mock.calls.length).toBe(beforePollSummaryCalls + 1);
            expect(getEventFeed.mock.calls.length).toBe(beforePollEventCalls + 1);
        });
        expect(getListenerReport.mock.calls.length).toBe(beforePollListenerCalls);
        expect(getListenerAccessSummary.mock.calls.length).toBe(beforePollAccessCalls);

        Object.defineProperty(document, 'hidden', {
            configurable: true,
            value: true,
        });
        await act(async () => {
            document.dispatchEvent(new Event('visibilitychange'));
            await vi.advanceTimersByTimeAsync(20_000);
        });

        expect(getReportSummary.mock.calls.length).toBe(beforePollSummaryCalls + 1);
        expect(getEventFeed.mock.calls.length).toBe(beforePollEventCalls + 1);
        expect(getListenerAccessSummary.mock.calls.length).toBe(beforePollAccessCalls);

        Object.defineProperty(document, 'hidden', {
            configurable: true,
            value: false,
        });
        await act(async () => {
            document.dispatchEvent(new Event('visibilitychange'));
        });

        await waitFor(() => {
            expect(getReportSummary.mock.calls.length).toBe(beforePollSummaryCalls + 2);
            expect(getEventFeed.mock.calls.length).toBe(beforePollEventCalls + 2);
        });

        unmount();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(20_000);
        });

        expect(getReportSummary.mock.calls.length).toBe(beforePollSummaryCalls + 2);
        expect(getEventFeed.mock.calls.length).toBe(beforePollEventCalls + 2);
    });

    it('memoizes the API client so a relative preset does not loop the listener report (no adminApi prop)', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-06-21T10:30:00.000Z'));
        const getListenerReport = vi.fn<AdminApi['getListenerReport']>(async () =>
            listenerReport(),
        );
        const api = makeApi({ getListenerReport });
        // Render WITHOUT an adminApi prop so AdminScreen falls back to its
        // createAdminApi() default — the path that caused the production infinite
        // "Updating…" refetch loop (a fresh client every render gave the
        // listener-report effect a new dependency identity each render). The
        // memoized client must be constructed exactly once.
        const createAdminApiSpy = vi.spyOn(adminApiModule, 'createAdminApi').mockReturnValue(api);

        renderAdmin(<AdminScreen />);
        await openFirstProgram();
        await goToSection('Reports');
        fireEvent.change(screen.getByLabelText('Range'), {
            target: { value: 'Last 5 minutes' },
        });
        fireEvent.click(screen.getByRole('button', { name: /Listener report/ }));
        await screen.findByRole('button', { name: 'Download CSV' });

        const afterOpenListenerCalls = getListenerReport.mock.calls.length;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1000);
        });

        expect(createAdminApiSpy).toHaveBeenCalledTimes(1);
        // Idle on a relative preset: the time-invariant de-dup key + stable client
        // means no further listener-report fetches once nothing has changed.
        expect(getListenerReport.mock.calls.length).toBe(afterOpenListenerCalls);
    });

    it('routes to admin login and stops report polling when reports refresh returns admin_auth_required', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const getReportSummary = vi
            .fn<AdminApi['getReportSummary']>()
            .mockResolvedValueOnce(reportSummary())
            .mockRejectedValue(authRequired());
        const getEventFeed = vi.fn<AdminApi['getEventFeed']>(async () => eventFeed());
        const api = makeApi({ getReportSummary, getEventFeed });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');

        expect(await screen.findByRole('heading', { name: 'Admin login' })).toBeInTheDocument();
        expect(screen.getByLabelText('Admin password')).toBeInTheDocument();

        const summaryCallsAfterExpiry = getReportSummary.mock.calls.length;
        const eventCallsAfterExpiry = getEventFeed.mock.calls.length;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(20_000);
        });

        expect(getReportSummary).toHaveBeenCalledTimes(summaryCallsAfterExpiry);
        expect(getEventFeed).toHaveBeenCalledTimes(eventCallsAfterExpiry);
    });

    it('skips a scheduled report poll while a previous report refetch is still in flight', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const summaryRequests: Array<ReturnType<typeof deferred<AdminReportSummary>>> = [];
        let deferNextSummary = false;
        const getReportSummary = vi.fn<AdminApi['getReportSummary']>(async () => {
            if (!deferNextSummary) {
                return reportSummary();
            }
            deferNextSummary = false;
            const request = deferred<AdminReportSummary>();
            summaryRequests.push(request);
            return request.promise;
        });
        const getEventFeed = vi.fn<AdminApi['getEventFeed']>(async () => eventFeed());
        const api = makeApi({ getReportSummary, getEventFeed });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');
        await waitFor(() => {
            expect(getReportSummary.mock.calls.length).toBeGreaterThan(1);
        });

        deferNextSummary = true;
        const beforePollSummaryCalls = getReportSummary.mock.calls.length;
        const beforePollEventCalls = getEventFeed.mock.calls.length;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(20_000);
        });
        await waitFor(() => {
            expect(summaryRequests).toHaveLength(1);
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(20_000);
        });

        expect(getReportSummary.mock.calls.length).toBe(beforePollSummaryCalls + 1);
        expect(getEventFeed.mock.calls.length).toBe(beforePollEventCalls + 1);

        summaryRequests[0]!.resolve(reportSummary());
    });

    it('does not refetch the listener report on a relative-range poll but does when the selection changes', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-06-21T10:30:00.000Z'));
        const getReportSummary = vi.fn<AdminApi['getReportSummary']>(async () => reportSummary());
        const getEventFeed = vi.fn<AdminApi['getEventFeed']>(async () => eventFeed());
        const getListenerReport = vi.fn<AdminApi['getListenerReport']>(async () =>
            listenerReport(),
        );
        const api = makeApi({ getReportSummary, getEventFeed, getListenerReport });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');
        fireEvent.change(screen.getByLabelText('Range'), {
            target: { value: 'Last 5 minutes' },
        });

        const listenerSummary = screen.getByRole('button', {
            name: /Listener report/,
        });
        fireEvent.click(listenerSummary);
        await screen.findByRole('button', { name: 'Download CSV' });
        const beforePollListenerCalls = getListenerReport.mock.calls.length;
        const beforePollSummaryCalls = getReportSummary.mock.calls.length;
        const beforePollEventCalls = getEventFeed.mock.calls.length;

        await act(async () => {
            await vi.advanceTimersByTimeAsync(20_000);
        });

        await waitFor(() => {
            expect(getReportSummary.mock.calls.length).toBe(beforePollSummaryCalls + 1);
            expect(getEventFeed.mock.calls.length).toBe(beforePollEventCalls + 1);
        });
        expect(getListenerReport).toHaveBeenCalledTimes(beforePollListenerCalls);

        fireEvent.change(screen.getByLabelText('Range'), {
            target: { value: 'Last 30 minutes' },
        });
        await waitFor(() => {
            expect(getListenerReport).toHaveBeenCalledTimes(beforePollListenerCalls + 1);
        });

        fireEvent.change(screen.getByLabelText('Range'), {
            target: { value: 'Custom' },
        });
        await waitFor(() => {
            expect(getListenerReport).toHaveBeenCalledTimes(beforePollListenerCalls + 2);
        });

        fireEvent.change(screen.getByLabelText('From'), {
            target: { value: '2026-06-21T09:15' },
        });
        await waitFor(() => {
            expect(getListenerReport).toHaveBeenCalledTimes(beforePollListenerCalls + 3);
        });
    });

    it('keeps the selected report date preset when leaving and returning to Reports', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-06-21T10:30:00.000Z'));
        const api = makeApi();

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');

        fireEvent.change(screen.getByLabelText('Range'), {
            target: { value: 'Last 24 hours' },
        });
        await waitFor(() => {
            expect(screen.getByLabelText('Range')).toHaveValue('Last 24 hours');
        });

        await goToSection('Status');
        await goToSection('Reports');

        expect(screen.getByLabelText('Range')).toHaveValue('Last 24 hours');
    });

    it('sets the report date preset to Custom when a date input is edited', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-06-21T10:30:00.000Z'));
        const api = makeApi();

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');

        fireEvent.change(screen.getByLabelText('Range'), {
            target: { value: 'Custom' },
        });
        await screen.findByLabelText('From');

        fireEvent.change(screen.getByLabelText('From'), {
            target: { value: '2026-06-20T11:00' },
        });

        expect(screen.getByLabelText('Range')).toHaveValue('Custom');
    });

    it('focuses the report range select when the active range chip is clicked', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-06-21T10:30:00.000Z'));
        Element.prototype.scrollIntoView = vi.fn();
        const api = makeApi();

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');

        fireEvent.change(screen.getByLabelText('Range'), {
            target: { value: 'Last 24 hours' },
        });
        await waitFor(() => {
            expect(screen.getAllByRole('button', { name: 'Last 24 hours' }).length).toBeGreaterThan(
                0,
            );
        });
        fireEvent.click(screen.getAllByRole('button', { name: 'Last 24 hours' })[0]!);

        expect(screen.getByLabelText('Range')).toHaveFocus();
    });

    it('refetches events with filter and page params from the reports tab', async () => {
        const getEventFeed = vi.fn<AdminApi['getEventFeed']>(async () => ({
            ...eventFeed(),
            total: 150,
            totalPages: 2,
        }));
        const api = makeApi({ getEventFeed });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');

        const beforeFilterCalls = getEventFeed.mock.calls.length;
        fireEvent.click(screen.getByText(/Event type/));
        fireEvent.click(screen.getByRole('checkbox', { name: 'Listener switched' }));
        fireEvent.click(screen.getByRole('checkbox', { name: 'Connection failed' }));

        await waitFor(() => {
            expect(getEventFeed.mock.calls.length).toBeGreaterThan(beforeFilterCalls);
        });
        expect(getEventFeed.mock.calls.at(-1)).toEqual([
            'program_1',
            {
                range: undefined,
                eventTypes: [...DEFAULT_EVENT_TYPES, 'listener_switched', 'connection_failed'],
                translatorId: undefined,
                page: 1,
                pageSize: 20,
            },
        ]);

        const beforePageCalls = getEventFeed.mock.calls.length;
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

        await waitFor(() => {
            expect(getEventFeed.mock.calls.length).toBeGreaterThan(beforePageCalls);
        });
        expect(getEventFeed.mock.calls.at(-1)).toEqual([
            'program_1',
            {
                range: undefined,
                eventTypes: [...DEFAULT_EVENT_TYPES, 'listener_switched', 'connection_failed'],
                translatorId: undefined,
                page: 2,
                pageSize: 20,
            },
        ]);
    });

    it('starts Recent events with default event types and clear all shows every event', async () => {
        const getEventFeed = vi.fn<AdminApi['getEventFeed']>(async () => ({
            ...eventFeed(),
            total: 150,
            totalPages: 2,
        }));
        const api = makeApi({ getEventFeed });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();

        expect(getEventFeed.mock.calls.at(-1)).toEqual([
            'program_1',
            {
                range: undefined,
                eventTypes: DEFAULT_EVENT_TYPES,
                page: 1,
                pageSize: 20,
            },
        ]);

        await goToSection('Reports');
        await waitFor(() => {
            expect(getEventFeed.mock.calls.at(-1)?.[1]).toMatchObject({
                eventTypes: DEFAULT_EVENT_TYPES,
                page: 1,
                pageSize: 20,
            });
        });

        fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
        await waitFor(() => {
            expect(getEventFeed.mock.calls.at(-1)).toEqual([
                'program_1',
                {
                    range: undefined,
                    eventTypes: undefined,
                    translatorId: undefined,
                    page: 1,
                    pageSize: 20,
                },
            ]);
        });
    });

    it('keeps the event count active for default filters and date range', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-06-21T10:30:00.000Z'));
        const api = makeApi();

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');

        const eventsSummary = screen.getByRole('button', { name: /Recent events/ });
        const eventsCount = within(eventsSummary).getByLabelText('1 events');
        expect(eventsCount).toHaveClass('admin-session-count--active');

        fireEvent.change(screen.getByLabelText('Range'), {
            target: { value: 'Last 24 hours' },
        });

        await waitFor(() => {
            expect(eventsCount).toHaveClass('admin-session-count--active');
        });
    });

    it('treats blank Custom as an inactive report range', async () => {
        const api = makeApi();

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');

        fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
        fireEvent.change(screen.getByLabelText('Range'), {
            target: { value: 'Custom' },
        });

        await waitFor(() => {
            expect(screen.getByLabelText('Range')).toHaveValue('Custom');
        });
        expect(screen.queryByText('(not windowed)')).not.toBeInTheDocument();
        const eventsSummary = screen.getByRole('button', { name: /Recent events/ });
        expect(within(eventsSummary).getByLabelText('1 events')).not.toHaveClass(
            'admin-session-count--active',
        );
    });

    it('resets event pagination when the report date range changes', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-06-21T10:30:00.000Z'));
        const getEventFeed = vi.fn<AdminApi['getEventFeed']>(async () => ({
            ...eventFeed(),
            total: 150,
            totalPages: 8,
        }));
        const api = makeApi({ getEventFeed });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');

        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        await waitFor(() => {
            expect(getEventFeed.mock.calls.at(-1)?.[1]).toMatchObject({
                page: 2,
                pageSize: 20,
            });
        });

        const beforeRangeCalls = getEventFeed.mock.calls.length;
        fireEvent.change(screen.getByLabelText('Range'), {
            target: { value: 'Last 24 hours' },
        });

        await waitFor(() => {
            expect(getEventFeed.mock.calls.length).toBeGreaterThan(beforeRangeCalls);
            expect(getEventFeed.mock.calls.at(-1)?.[1]).toMatchObject({
                page: 1,
                pageSize: 20,
            });
        });
    });

    it('a superseded refetchReports response does not overwrite the newer range', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-06-21T10:30:00.000Z'));
        const summaryRequests: Array<ReturnType<typeof deferred<AdminReportSummary>>> = [];
        const eventRequests: Array<ReturnType<typeof deferred<AdminEventFeed>>> = [];
        const getReportSummary = vi.fn<AdminApi['getReportSummary']>((_programId, range) => {
            if (!range) {
                return Promise.resolve(reportSummary());
            }
            const request = deferred<AdminReportSummary>();
            summaryRequests.push(request);
            return request.promise;
        });
        const getEventFeed = vi.fn<AdminApi['getEventFeed']>((_programId, options) => {
            if (!options || typeof options === 'number' || !options.range) {
                return Promise.resolve(eventFeed());
            }
            const request = deferred<AdminEventFeed>();
            eventRequests.push(request);
            return request.promise;
        });
        const api = makeApi({ getReportSummary, getEventFeed });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');

        fireEvent.change(screen.getByLabelText('Range'), {
            target: { value: 'Last 24 hours' },
        });
        await waitFor(() => {
            expect(summaryRequests).toHaveLength(1);
            expect(eventRequests).toHaveLength(1);
        });

        fireEvent.change(screen.getByLabelText('Range'), {
            target: { value: 'Last 7 days' },
        });
        await waitFor(() => {
            expect(summaryRequests).toHaveLength(2);
            expect(eventRequests).toHaveLength(2);
        });

        summaryRequests[1]!.resolve({
            ...reportSummary(),
            totals: {
                activeListeners: 71,
                totalConnections: 171,
                uniqueDevices: 119,
                dropouts: 11,
                reconnects: 19,
            },
        });
        eventRequests[1]!.resolve({
            total: 1,
            page: 1,
            pageSize: 20,
            totalPages: 1,
            events: [
                {
                    id: 'ev_latest',
                    eventType: 'listener_connected',
                    occurredAt: '2026-06-21T10:05:00.000Z',
                    stream: {
                        id: 'stream_hi',
                        languageName: 'Hindi',
                        languageCode: 'hi',
                    },
                    translatorName: null,
                    translatorDeviceLabel: null,
                    metadata: { reason: 'latest_range', connectionId: 'lc_latest' },
                },
            ],
        });

        const summaryPanel = await screen.findByLabelText('Report summary');
        expect(await within(summaryPanel).findByText('71')).toBeInTheDocument();
        expect(screen.getByLabelText('Recent events')).toHaveTextContent('latest_range');

        await act(async () => {
            summaryRequests[0]!.resolve({
                ...reportSummary(),
                totals: {
                    activeListeners: 13,
                    totalConnections: 113,
                    uniqueDevices: 79,
                    dropouts: 3,
                    reconnects: 5,
                },
            });
            eventRequests[0]!.resolve({
                total: 1,
                page: 1,
                pageSize: 20,
                totalPages: 1,
                events: [
                    {
                        id: 'ev_stale',
                        eventType: 'connection_failed',
                        occurredAt: '2026-06-21T09:05:00.000Z',
                        stream: {
                            id: 'stream_hi',
                            languageName: 'Hindi',
                            languageCode: 'hi',
                        },
                        translatorName: null,
                        translatorDeviceLabel: null,
                        metadata: { reason: 'stale_range', connectionId: 'lc_stale' },
                    },
                ],
            });
            await Promise.all([summaryRequests[0]!.promise, eventRequests[0]!.promise]);
        });

        expect(summaryPanel).toHaveTextContent('71');
        expect(summaryPanel).not.toHaveTextContent('13');
        expect(screen.getByLabelText('Recent events')).toHaveTextContent('latest_range');
        expect(screen.getByLabelText('Recent events')).not.toHaveTextContent('stale_range');
    });

    it('ignores a stale scheduled report auth rejection after a newer refetch succeeds', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-06-21T10:30:00.000Z'));
        const scheduledSummaryRequests: Array<ReturnType<typeof deferred<AdminReportSummary>>> = [];
        let deferNextSummary = false;
        const getReportSummary = vi.fn<AdminApi['getReportSummary']>(async () => {
            if (!deferNextSummary) {
                return reportSummary();
            }
            deferNextSummary = false;
            const request = deferred<AdminReportSummary>();
            scheduledSummaryRequests.push(request);
            return request.promise;
        });
        const getEventFeed = vi.fn<AdminApi['getEventFeed']>(async () => eventFeed());
        const api = makeApi({ getReportSummary, getEventFeed });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');
        await waitFor(() => {
            expect(getReportSummary.mock.calls.length).toBeGreaterThan(1);
        });

        deferNextSummary = true;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(20_000);
        });
        await waitFor(() => {
            expect(scheduledSummaryRequests).toHaveLength(1);
        });

        fireEvent.change(screen.getByLabelText('Range'), {
            target: { value: 'Last 7 days' },
        });
        await waitFor(() => {
            expect(getReportSummary.mock.calls.at(-1)?.[1]).toMatchObject({
                from: expect.any(String),
                to: expect.any(String),
            });
        });

        await act(async () => {
            scheduledSummaryRequests[0]!.reject(authRequired());
            await Promise.resolve();
        });

        expect(screen.queryByRole('heading', { name: 'Admin login' })).not.toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.getByLabelText('Report summary')).toHaveTextContent('42');
    });

    it('loads event readiness and confirms operator checks', async () => {
        const api = makeApi();

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();

        await waitFor(() => {
            expect(api.getReadiness).toHaveBeenCalledWith('program_1');
        });
        await goToSection('Readiness');

        const readinessPanel = await screen.findByRole('region', {
            name: 'Event readiness',
        });
        expect(readinessPanel).toHaveTextContent('Blocker');
        expect(readinessPanel).toHaveTextContent('Warning');

        fireEvent.click(
            within(readinessPanel).getByRole('button', {
                name: /confirm realtime smoke test/i,
            }),
        );

        await waitFor(() => {
            expect(api.confirmReadiness).toHaveBeenCalledWith('program_1', 'realtime_smoke_tested');
        });

        await waitFor(() => {
            expect(
                within(screen.getByRole('region', { name: 'Event readiness' })).getByText(
                    'Operator confirmed a realtime smoke test.',
                ),
            ).toBeInTheDocument();
        });
    });

    it('clears the previous report summary before showing a newly selected program', async () => {
        const secondProgram: AdminProgram = {
            ...firstProgram(),
            id: 'program_2',
            slug: 'delhi-event-2026',
            name: 'Delhi Event 2026',
        };
        let resolveSecondSummary: (value: AdminReportSummary) => void = () => {};
        const api = makeApi({
            listPrograms: vi.fn(async () => ({
                programs: [firstProgram(), secondProgram],
            })),
            getProgramDetail: vi.fn(async (programId: string) => ({
                ...programDetail(),
                program: programId === 'program_2' ? secondProgram : firstProgram(),
            })),
            getReportSummary: vi.fn(async (programId: string) => {
                if (programId === 'program_2') {
                    return new Promise<AdminReportSummary>((resolve) => {
                        resolveSecondSummary = resolve;
                    });
                }
                return reportSummary();
            }),
        });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');
        expect(await screen.findByLabelText('Report summary')).toHaveTextContent('42');

        fireEvent.click(screen.getByRole('button', { name: '← Programs' }));
        await screen.findByRole('region', { name: 'Programs' });
        await openProgramCard(/Delhi Event 2026/);
        await waitFor(() => {
            expect(api.getProgramDetail).toHaveBeenCalledWith('program_2');
        });
        expect(screen.queryByText('42')).not.toBeInTheDocument();

        resolveSecondSummary({
            ...reportSummary(),
            programId: 'program_2',
            totals: {
                activeListeners: 5,
                totalConnections: 9,
                uniqueDevices: 6,
                dropouts: 1,
                reconnects: 2,
            },
        });

        await goToSection('Reports');
        const newSummaryPanel = await screen.findByLabelText('Report summary');
        expect(await within(newSummaryPanel).findByText('5')).toBeInTheDocument();
        expect(within(newSummaryPanel).queryByText('42')).not.toBeInTheDocument();
    });

    it('does not fetch the listener report until the report panel is opened', async () => {
        const api = makeApi();

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');

        expect(api.getListenerReport).not.toHaveBeenCalled();
        expect(
            screen.queryByRole('button', { name: 'Open listener report' }),
        ).not.toBeInTheDocument();

        const listenerSummary = screen.getByRole('button', {
            name: /Listener report/,
        });
        expect(listenerSummary).toHaveAttribute('aria-expanded', 'false');
        expect(listenerSummary).toHaveTextContent('—');
        fireEvent.click(listenerSummary);
        await waitFor(() => expect(listenerSummary).toHaveAttribute('aria-expanded', 'true'));

        expect(await screen.findByText('203.0.113.10')).toBeInTheDocument();
        expect(api.getListenerAccessSummary).toHaveBeenCalledTimes(1);
        expect(screen.getByText('Pending').closest('div')).toHaveTextContent('2');
        expect(listenerSummary).toHaveTextContent('1');
        expect(listenerSummary).toHaveTextContent('Last loaded: ');
        // Device column now shows the friendly label; the raw UA moved to the cell title.
        const reportRow = screen.getByText('203.0.113.10').closest('tr');
        expect(reportRow).toBeInstanceOf(HTMLTableRowElement);
        expect(within(reportRow as HTMLElement).getByText('Safari on iPhone')).toBeInTheDocument();
        expect(screen.getByTitle('Mobile Safari')).toBeInTheDocument();
        expect(screen.getAllByText('Hindi').length).toBeGreaterThan(0);
        await waitFor(() =>
            expect(api.getListenerReport).toHaveBeenCalledWith('program_1', expect.any(Object)),
        );
    });

    it('ignores a stale listener access summary after switching programs', async () => {
        const secondProgram: AdminProgram = {
            ...firstProgram(),
            id: 'program_2',
            slug: 'delhi-event-2026',
            name: 'Delhi Event 2026',
        };
        const firstProgramSummary = deferred<{
            pending: number;
            approved: number;
            revoked: number;
        }>();
        const getListenerAccessSummary = vi.fn<AdminApi['getListenerAccessSummary']>(
            async (programId: string) => {
                if (programId === 'program_1') {
                    return firstProgramSummary.promise;
                }
                return { pending: 20, approved: 30, revoked: 10 };
            },
        );
        const api = makeApi({
            listPrograms: vi.fn(async () => ({
                programs: [firstProgram(), secondProgram],
            })),
            getProgramDetail: vi.fn(async (programId: string) => ({
                ...programDetail(),
                program: programId === 'program_2' ? secondProgram : firstProgram(),
            })),
            getListenerAccessSummary,
        });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');
        fireEvent.click(screen.getByRole('button', { name: /Listener report/ }));
        await waitFor(() => {
            expect(getListenerAccessSummary).toHaveBeenCalledWith('program_1');
        });

        fireEvent.click(screen.getByRole('button', { name: '← Programs' }));
        await screen.findByRole('region', { name: 'Programs' });
        await openProgramCard(/Delhi Event 2026/);
        await waitFor(() => {
            expect(api.getProgramDetail).toHaveBeenCalledWith('program_2');
        });
        await goToSection('Reports');

        const pendingTile = screen.getByText('Pending').closest('div');
        expect(pendingTile).toHaveTextContent('—');
        expect(getListenerAccessSummary).not.toHaveBeenCalledWith('program_2');

        await act(async () => {
            firstProgramSummary.resolve({ pending: 91, approved: 92, revoked: 93 });
            await firstProgramSummary.promise;
        });

        expect(pendingTile).toHaveTextContent('—');
        expect(screen.queryByText('91')).not.toBeInTheDocument();
    });

    it('does not refetch the listener report on reopen until the query changes', async () => {
        const getListenerReport = vi.fn<AdminApi['getListenerReport']>(async () =>
            listenerReport(),
        );
        const api = makeApi({ getListenerReport });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Reports');

        const listenerSummary = screen.getByRole('button', {
            name: /Listener report/,
        });
        fireEvent.click(listenerSummary);
        await screen.findByText('203.0.113.10');
        expect(getListenerReport).toHaveBeenCalledTimes(1);
        const lastLoaded = listenerSummary.textContent?.match(/Last loaded: .+$/)?.[0];
        expect(lastLoaded).toBeDefined();

        fireEvent.click(listenerSummary);
        await waitFor(() => expect(listenerSummary).toHaveAttribute('aria-expanded', 'false'));
        fireEvent.click(listenerSummary);
        await waitFor(() => expect(listenerSummary).toHaveAttribute('aria-expanded', 'true'));

        expect(getListenerReport).toHaveBeenCalledTimes(1);
        expect(listenerSummary.textContent).toContain(lastLoaded);

        fireEvent.click(screen.getByRole('checkbox', { name: 'connected' }));

        await waitFor(() => {
            expect(getListenerReport).toHaveBeenCalledTimes(2);
        });
        expect(getListenerReport.mock.calls.at(-1)).toEqual([
            'program_1',
            expect.objectContaining({ states: ['connected'] }),
        ]);
    });

    it('shows listener counts, freshness, and per-stream audio state', async () => {
        renderAdmin(<AdminScreen adminApi={makeApi()} />);

        await openFirstProgram();
        await goToSection('Status');

        const panel = await screen.findByLabelText('Listener counts');
        expect(panel).toHaveTextContent('42');
        expect(panel).toHaveTextContent('Hindi');
        expect(panel).toHaveTextContent('30');
        expect(panel).toHaveTextContent('Fresh');
        expect(panel).toHaveTextContent('Degraded');
        expect(panel).toHaveTextContent('20 Jun 2026, 17:30:00 IST');

        const hindiRow = within(panel).getByText('Hindi').closest('tr');
        expect(hindiRow).toHaveTextContent('LIVE');
        const englishRow = within(panel).getByText('English').closest('tr');
        expect(englishRow).toHaveTextContent('SILENT');
    });

    it('renders a Kick publisher action only for live streams', async () => {
        renderAdmin(<AdminScreen adminApi={makeApi()} />);

        await openFirstProgram();
        await goToSection('Status');

        const panel = await screen.findByLabelText('Listener counts');
        const hindiRow = within(panel).getByText('Hindi').closest('tr');
        const englishRow = within(panel).getByText('English').closest('tr');

        expect(
            within(hindiRow!).getByRole('button', { name: 'Kick publisher' }),
        ).toBeInTheDocument();
        expect(
            within(englishRow!).queryByRole('button', { name: 'Kick publisher' }),
        ).not.toBeInTheDocument();
    });

    it('opens kick confirmation with stream language and listener impact', async () => {
        renderAdmin(<AdminScreen adminApi={makeApi()} />);

        await openFirstProgram();
        await goToSection('Status');

        const panel = await screen.findByLabelText('Listener counts');
        const hindiRow = within(panel).getByText('Hindi').closest('tr');
        fireEvent.click(within(hindiRow!).getByRole('button', { name: 'Kick publisher' }));

        expect(await screen.findByRole('dialog')).toHaveTextContent('End the Hindi broadcast?');
        expect(
            screen.getByText(
                "Hindi has 30 active listeners. They'll keep hearing silence — the stream stays connected.",
            ),
        ).toBeInTheDocument();
    });

    it('calls kickPublisher and refreshes status after confirming', async () => {
        const getProgramStatus = vi.fn(async () => status());
        const kickPublisher = vi.fn(async () => ({ freed: true }));
        const api = makeApi({
            getProgramStatus,
            kickPublisher,
        });

        renderAdmin(<AdminScreen adminApi={api} />);

        await openFirstProgram();
        await goToSection('Status');

        const panel = await screen.findByLabelText('Listener counts');
        const hindiRow = within(panel).getByText('Hindi').closest('tr');
        fireEvent.click(within(hindiRow!).getByRole('button', { name: 'Kick publisher' }));

        const signOutCheckbox = screen.getByRole('checkbox', {
            name: 'Also sign this device out',
        });
        fireEvent.click(signOutCheckbox);

        const before = getProgramStatus.mock.calls.length;
        fireEvent.click(screen.getByRole('button', { name: 'End broadcast' }));

        await waitFor(() => {
            expect(kickPublisher).toHaveBeenCalledWith('program_1', 'stream_hi', true);
        });
        await waitFor(() => {
            expect(getProgramStatus).toHaveBeenCalledTimes(before + 1);
        });
    });

    it('keeps the kick dialog open and shows API errors', async () => {
        const api = makeApi({
            kickPublisher: vi.fn(async () => {
                throw apiError('kick_publisher_failed', 500);
            }),
        });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Status');

        const panel = await screen.findByLabelText('Listener counts');
        const hindiRow = within(panel).getByText('Hindi').closest('tr');
        fireEvent.click(within(hindiRow!).getByRole('button', { name: 'Kick publisher' }));

        fireEvent.click(screen.getByRole('button', { name: 'End broadcast' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('kick_publisher_failed');
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('shows unavailable freshness time when the status endpoint is degraded', async () => {
        const api = makeApi({
            getProgramStatus: vi.fn(
                async () =>
                    ({
                        ...status(),
                        stale: true,
                        degraded: true,
                        updatedAt: null,
                    }) as unknown as AdminProgramStatus,
            ),
        });

        renderAdmin(<AdminScreen adminApi={api} />);

        await openFirstProgram();
        await goToSection('Status');

        const panel = await screen.findByLabelText('Listener counts');
        expect(panel).toHaveTextContent('Stale');
        expect(panel).toHaveTextContent('Degraded');
        expect(panel).toHaveTextContent('Not available');
    });

    it('renders QR from the exact payload, exposes the URL, pins SVG filename, and prints the same payload', async () => {
        const createObjectURL = vi.fn((_blob: Blob) => 'blob:qr');
        const revokeObjectURL = vi.fn();
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: createObjectURL,
        });
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            value: revokeObjectURL,
        });
        const open = vi.fn(() => ({
            document: {
                close: vi.fn(),
                write: vi.fn(),
            },
            focus: vi.fn(),
            print: vi.fn(),
        }));
        vi.spyOn(window, 'open').mockImplementation(open as never);

        renderAdmin(<AdminScreen adminApi={makeApi()} />);
        await openFirstProgram();
        await goToSection('Share / QR');

        const qr = await screen.findByRole('img', { name: 'Listener QR' });
        expect(qr).toHaveAttribute('data-qr-value', 'https://bhasha.test/patna-event-2026');
        expect(screen.getAllByText('https://bhasha.test/patna-event-2026').length).toBeGreaterThan(
            0,
        );
        const translatorQr = screen.getByRole('img', { name: 'Translator QR' });
        expect(translatorQr).toHaveAttribute(
            'data-qr-value',
            'https://api.example.invalid/ignored/translate',
        );
        expect(
            screen.getAllByText('https://api.example.invalid/ignored/translate').length,
        ).toBeGreaterThan(0);
        const volunteerQr = screen.getByRole('img', { name: 'Volunteer QR' });
        expect(volunteerQr).toHaveAttribute(
            'data-qr-value',
            'https://api.example.invalid/ignored/volunteer',
        );

        const createdAnchors: HTMLAnchorElement[] = [];
        const createElement = document.createElement.bind(document);
        vi.spyOn(document, 'createElement').mockImplementation((tagName, options) => {
            const element = createElement(tagName, options);
            if (tagName.toLowerCase() === 'a') {
                createdAnchors.push(element as HTMLAnchorElement);
                vi.spyOn(element as HTMLAnchorElement, 'click').mockImplementation(() => undefined);
            }
            return element;
        });

        fireEvent.click(screen.getAllByRole('button', { name: 'Download QR SVG' })[0]!);
        expect(createdAnchors[0]).toHaveAttribute('download', 'patna-event-2026-listener-qr.svg');
        expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
        const downloadedBlob = createObjectURL.mock.calls[0]?.[0];
        expect(downloadedBlob).toBeInstanceOf(Blob);
        if (!downloadedBlob) {
            throw new Error('QR download did not create a blob');
        }
        const downloadedSvg = await downloadedBlob.text();
        expect(downloadedSvg).toContain('data-qr-value="https://bhasha.test/patna-event-2026"');
        expect(downloadedSvg).not.toContain('<text');

        fireEvent.click(screen.getAllByRole('button', { name: 'Print QR' })[0]!);
        const popup = open.mock.results[0]?.value;
        expect(popup.document.write).toHaveBeenCalledWith(
            expect.stringContaining('https://bhasha.test/patna-event-2026'),
        );
    });

    it('shows the translator URL on the Translators tab', async () => {
        renderAdmin(<AdminScreen adminApi={makeApi()} />);
        await openFirstProgram();
        await goToSection('Translators');

        expect(
            screen.getByText('https://api.example.invalid/ignored/translate'),
        ).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    });

    it('submits stream, translator, and assignment mutations then refreshes detail', async () => {
        const api = makeApi();

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Streams');

        fireEvent.change(screen.getByLabelText('Stream language'), {
            target: { value: 'ta' },
        });
        fireEvent.change(screen.getByLabelText('Stream display order'), {
            target: { value: '3' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Create stream' }));

        await waitFor(() => {
            expect(api.createStream).toHaveBeenCalledWith('program_1', {
                languageName: 'Tamil',
                languageCode: 'ta',
                displayOrder: 3,
                isActive: true,
            });
        });

        fireEvent.click(screen.getByRole('button', { name: 'Deactivate Hindi' }));
        await waitFor(() => {
            expect(api.updateStream).toHaveBeenCalledWith('program_1', 'stream_hi', {
                isActive: false,
            });
            expect(api.getProgramStatus).toHaveBeenCalledTimes(3);
        });

        await goToSection('Translators');

        fireEvent.change(screen.getByLabelText('Translator email'), {
            target: { value: 'tamil@example.com' },
        });
        fireEvent.change(screen.getByLabelText('Translator name'), {
            target: { value: 'Tamil Translator' },
        });
        fireEvent.change(screen.getByLabelText('Translator password'), {
            target: { value: 'plain-pass' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Create translator' }));
        await waitFor(() => {
            expect(api.createTranslator).toHaveBeenCalledWith('program_1', {
                email: 'tamil@example.com',
                name: 'Tamil Translator',
                password: 'plain-pass',
            });
        });
        expect(screen.getByLabelText('Translator password')).toHaveValue('');

        fireEvent.click(
            screen.getByRole('button', {
                name: 'Assign English to Hindi Translator',
            }),
        );
        await waitFor(() => {
            expect(api.addTranslatorAssignment).toHaveBeenCalledWith(
                'program_1',
                'translator_hindi',
                'stream_en',
            );
            expect(api.getProgramDetail).toHaveBeenCalledTimes(5);
        });
    });

    it('offers a grouped language dropdown and disables create until chosen', async () => {
        const api = makeApi();

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Streams');

        const select = screen.getByLabelText('Stream language');
        expect(within(select).getByRole('option', { name: 'Hindi (hi)' })).toBeInTheDocument();
        expect(within(select).getByRole('option', { name: 'Kannada (kn)' })).toBeInTheDocument();
        expect(within(select).getByRole('option', { name: 'Portuguese (pt)' })).toBeInTheDocument();
        expect(within(select).getByRole('option', { name: 'Mandarin (zh)' })).toBeInTheDocument();
        expect(within(select).getByRole('option', { name: 'Filipino (tl)' })).toBeInTheDocument();
        expect(select.querySelectorAll('optgroup')).toHaveLength(4);

        expect(screen.getByRole('button', { name: 'Create stream' })).toBeDisabled();
        fireEvent.change(select, { target: { value: 'hi' } });
        expect(screen.getByRole('button', { name: 'Create stream' })).toBeEnabled();
    });

    it('archives the selected program', async () => {
        const api = makeApi({
            archiveProgram: vi.fn(async () => ({
                ...programDetail(),
                program: { ...firstProgram(), status: 'archived' as const },
            })),
        });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await screen.findByRole('button', { name: 'Archive program' });

        fireEvent.click(screen.getByRole('button', { name: 'Archive program' }));
        await waitFor(() => {
            expect(api.archiveProgram).toHaveBeenCalledWith('program_1');
        });
        expect(screen.getByLabelText('Detail status')).toHaveValue('archived');
    });

    it('moves a live program to Recently deleted and restores it', async () => {
        let programs: AdminProgram[] = [
            { ...firstProgram(), id: 'program_1', status: 'live' as const },
        ];
        let deletedPrograms: AdminProgram[] = [];
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const api = makeApi({
            listPrograms: vi.fn(async () => ({ programs })),
            listDeletedPrograms: vi.fn(async () => deletedPrograms),
            getProgramDetail: vi.fn(async () => ({
                ...programDetail(),
                program: {
                    ...firstProgram(),
                    id: 'program_1',
                    status: 'live' as const,
                },
            })),
            deleteProgram: vi.fn(async () => {
                const deletedProgram = programs.find((program) => program.id === 'program_1');
                if (deletedProgram) {
                    programs = programs.filter((program) => program.id !== 'program_1');
                    deletedPrograms = [...deletedPrograms, deletedProgram];
                }
            }),
            restoreProgram: vi.fn(async () => {
                const restoredProgram = deletedPrograms.find(
                    (program) => program.id === 'program_1',
                );
                if (restoredProgram) {
                    deletedPrograms = deletedPrograms.filter(
                        (program) => program.id !== 'program_1',
                    );
                    programs = [restoredProgram, ...programs];
                }
            }),
        });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await screen.findByText('Patna Event 2026');

        fireEvent.click(screen.getByRole('button', { name: 'Delete program' }));
        await waitFor(() => {
            expect(confirm).toHaveBeenCalledTimes(1);
            expect(confirm).toHaveBeenCalled();
            expect(confirm.mock.calls[0]?.[0]).toContain('can be restored for 7 days.');
            expect(api.deleteProgram).toHaveBeenCalledWith('program_1');
            expect(api.listPrograms).toHaveBeenCalledTimes(2);
            expect(api.listDeletedPrograms).toHaveBeenCalledTimes(2);
        });

        await goToSection('Recently deleted');
        const deletedSection = screen.getByRole('region', {
            name: 'Recently deleted',
        });
        expect(deletedSection).toHaveTextContent('Patna Event 2026');

        fireEvent.click(within(deletedSection).getByRole('button', { name: 'Restore' }));
        await waitFor(() => {
            expect(api.restoreProgram).toHaveBeenCalledWith('program_1');
        });
        await goToSection('Programs');
        const programSection = screen.getByRole('region', { name: 'Programs' });
        expect(programSection).toHaveTextContent('Patna Event 2026');

        await goToSection('Recently deleted');
        expect(screen.getByText('No recently deleted programs.')).toBeInTheDocument();

        confirm.mockRestore();
    });

    it('deletes streams and edits or deletes translators', async () => {
        const api = makeApi();
        vi.spyOn(window, 'prompt').mockReturnValue('Lead Hindi Translator');

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Streams');

        fireEvent.click(screen.getByRole('button', { name: 'Delete Hindi stream' }));
        await waitFor(() => {
            expect(api.deleteStream).toHaveBeenCalledWith('program_1', 'stream_hi');
        });

        await goToSection('Translators');

        fireEvent.click(screen.getByRole('button', { name: 'Rename Hindi Translator' }));
        await waitFor(() => {
            expect(api.updateTranslator).toHaveBeenCalledWith('program_1', 'translator_hindi', {
                name: 'Lead Hindi Translator',
            });
        });

        fireEvent.click(screen.getByRole('button', { name: 'Delete Hindi Translator' }));
        await waitFor(() => {
            expect(api.deleteTranslator).toHaveBeenCalledWith('program_1', 'translator_hindi');
        });
    });

    it('surfaces assignment API errors', async () => {
        const api = makeApi({
            addTranslatorAssignment: vi.fn(async () => {
                throw apiError('translator_assignment_exists', 409);
            }),
        });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Translators');

        fireEvent.click(
            screen.getByRole('button', {
                name: 'Assign English to Hindi Translator',
            }),
        );

        expect(await screen.findByRole('alert')).toHaveTextContent('translator_assignment_exists');
    });

    it('expands translator sessions and renders device/login/last-active details', async () => {
        const fixedNow = Date.now();
        const getTranslatorSessions = vi.fn(async () => ({
            sessions: [
                translatorSession(fixedNow, {
                    sessionId: 'session_1',
                    deviceLabel: 'Office Mic',
                    loginAt: new Date(fixedNow - 4 * 60 * 1000).toISOString(),
                    lastActiveAt: new Date(fixedNow - 45 * 1000).toISOString(),
                    isPublishing: false,
                }),
            ],
        }));
        const api = makeApi({ getTranslatorSessions });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Translators');

        const card = screen
            .getByRole('heading', {
                name: 'Hindi Translator',
            })
            .closest('article')!;
        fireEvent.click(within(card).getByRole('button', { name: /Sessions/ }));

        await waitFor(() => {
            expect(getTranslatorSessions).toHaveBeenCalledWith('program_1', 'translator_hindi');
        });
        const row = within(card).getByText('Office Mic').closest('tr')!;
        expect(row).toHaveTextContent('ago');
        expect(within(card).getByText(/Updated .* ago/)).toBeInTheDocument();
    });

    it('shows publishing sessions with LIVE pill and publishing card flag', async () => {
        const fixedNow = Date.now();
        const api = makeApi({
            getTranslatorSessions: vi.fn(async () => ({
                sessions: [
                    translatorSession(fixedNow, {
                        sessionId: 'session_live',
                        deviceLabel: 'Studio Mic',
                        isPublishing: true,
                    }),
                ],
            })),
        });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Translators');

        const card = screen
            .getByRole('heading', {
                name: 'Hindi Translator',
            })
            .closest('article')!;
        fireEvent.click(within(card).getByRole('button', { name: /Sessions/ }));

        await waitFor(() => {
            expect(card).toHaveAttribute('data-publishing', 'true');
            expect(within(card).getByText('LIVE')).toBeInTheDocument();
        });
    });

    it('marks likely expired sessions when last-active is older than 30 minutes', async () => {
        const fixedNow = Date.now();
        const api = makeApi({
            getTranslatorSessions: vi.fn(async () => ({
                sessions: [
                    translatorSession(fixedNow, {
                        sessionId: 'session_stale',
                        deviceLabel: 'Old Mic',
                        lastActiveAt: new Date(fixedNow - 31 * 60 * 1000).toISOString(),
                    }),
                ],
            })),
        });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Translators');

        const card = screen
            .getByRole('heading', {
                name: 'Hindi Translator',
            })
            .closest('article')!;
        fireEvent.click(within(card).getByRole('button', { name: /Sessions/ }));

        await waitFor(() => {
            const row = within(card).getByText('Old Mic').closest('tr');
            expect(row).toHaveClass('admin-session-row--likely-expired');
            expect(row!.querySelector('.admin-session-expired')).not.toBeNull();
        });
    });

    it('opens a confirm dialog before ending a single session', async () => {
        const fixedNow = Date.now();
        const getTranslatorSessions = vi
            .fn()
            .mockResolvedValueOnce({
                sessions: [translatorSession(fixedNow, { sessionId: 'session_1' })],
            })
            .mockResolvedValueOnce({
                sessions: [],
            });
        const revokeSession = vi.fn(async () => ({ ok: true }));

        const api = makeApi({ getTranslatorSessions, revokeSession });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Translators');

        const card = screen
            .getByRole('heading', {
                name: 'Hindi Translator',
            })
            .closest('article')!;
        fireEvent.click(within(card).getByRole('button', { name: /Sessions/ }));
        await waitFor(() => {
            expect(within(card).getByRole('button', { name: 'End session' })).toBeInTheDocument();
        });

        fireEvent.click(within(card).getByRole('button', { name: 'End session' }));
        expect(
            await screen.findByRole('heading', {
                name: 'End session for Hindi Translator?',
            }),
        ).toBeInTheDocument();
        expect(screen.getByText('This will end the Desktop Mic session.')).toBeInTheDocument();

        expect(revokeSession).toHaveBeenCalledTimes(0);

        const dialog = screen.getByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'End session' }));

        await waitFor(() => {
            expect(revokeSession).toHaveBeenCalledWith(
                'program_1',
                'translator_hindi',
                'session_1',
            );
        });
        await waitFor(() => {
            expect(getTranslatorSessions).toHaveBeenCalledTimes(2);
        });
        expect(within(card).getByText('No active sessions')).toBeInTheDocument();
    });

    it('closes the confirm dialog when cancel is clicked for one session', async () => {
        const fixedNow = Date.now();
        const getTranslatorSessions = vi
            .fn()
            .mockResolvedValueOnce({
                sessions: [translatorSession(fixedNow, { sessionId: 'session_1' })],
            })
            .mockResolvedValueOnce({
                sessions: [],
            });
        const revokeSession = vi.fn(async () => ({ ok: true }));
        const api = makeApi({ getTranslatorSessions, revokeSession });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Translators');

        const card = screen
            .getByRole('heading', {
                name: 'Hindi Translator',
            })
            .closest('article')!;
        fireEvent.click(within(card).getByRole('button', { name: /Sessions/ }));
        await waitFor(() => {
            expect(within(card).getByRole('button', { name: 'End session' })).toBeInTheDocument();
        });

        fireEvent.click(within(card).getByRole('button', { name: 'End session' }));
        await screen.findByRole('heading', {
            name: 'End session for Hindi Translator?',
        });

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(revokeSession).toHaveBeenCalledTimes(0);
        expect(
            screen.queryByRole('heading', {
                name: 'End session for Hindi Translator?',
            }),
        ).toBeNull();
    });

    it('shows an error in the confirm dialog when ending a session fails', async () => {
        const fixedNow = Date.now();
        const getTranslatorSessions = vi
            .fn()
            .mockResolvedValueOnce({
                sessions: [translatorSession(fixedNow, { sessionId: 'session_1' })],
            })
            .mockResolvedValueOnce({
                sessions: [translatorSession(fixedNow, { sessionId: 'session_1' })],
            });
        const revokeSession = vi.fn(async () => {
            throw apiError('revoke_session_failed', 500);
        });

        const api = makeApi({ getTranslatorSessions, revokeSession });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Translators');

        const card = screen
            .getByRole('heading', {
                name: 'Hindi Translator',
            })
            .closest('article')!;
        fireEvent.click(within(card).getByRole('button', { name: /Sessions/ }));
        await waitFor(() => {
            expect(within(card).getByRole('button', { name: 'End session' })).toBeInTheDocument();
        });

        fireEvent.click(within(card).getByRole('button', { name: 'End session' }));
        const dialog = screen.getByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'End session' }));
        await waitFor(() => {
            expect(screen.getByRole('alert')).toHaveTextContent('revoke_session_failed');
        });
        expect(screen.getByText('Could not load sessions. Retrying…')).toBeInTheDocument();
        expect(within(card).getByRole('button', { name: 'End session' })).toBeInTheDocument();
    });

    it('opens a confirm dialog before ending all sessions', async () => {
        const fixedNow = Date.now();
        const getTranslatorSessions = vi
            .fn()
            .mockResolvedValueOnce({
                sessions: [
                    translatorSession(fixedNow, {
                        sessionId: 'session_1',
                        deviceLabel: 'Studio Mic 1',
                    }),
                    translatorSession(fixedNow, {
                        sessionId: 'session_2',
                        deviceLabel: 'Studio Mic 2',
                    }),
                ],
            })
            .mockResolvedValueOnce({
                sessions: [],
            });
        const revokeAllSessions = vi.fn(async () => ({ ok: true }));

        const api = makeApi({ getTranslatorSessions, revokeAllSessions });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Translators');

        const card = screen
            .getByRole('heading', {
                name: 'Hindi Translator',
            })
            .closest('article')!;
        fireEvent.click(within(card).getByRole('button', { name: /Sessions/ }));
        await waitFor(() => {
            expect(
                within(card).getByRole('button', { name: 'End all sessions' }),
            ).toBeInTheDocument();
        });

        fireEvent.click(within(card).getByRole('button', { name: 'End all sessions' }));

        expect(
            await screen.findByRole('heading', {
                name: 'End all sessions for Hindi Translator?',
            }),
        ).toBeInTheDocument();
        expect(screen.getByText('This will end all 2 active sessions.')).toBeInTheDocument();
        expect(revokeAllSessions).toHaveBeenCalledTimes(0);

        const dialog = screen.getByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'End all sessions' }));

        await waitFor(() => {
            expect(revokeAllSessions).toHaveBeenCalledWith('program_1', 'translator_hindi');
        });
        await waitFor(() => {
            expect(getTranslatorSessions).toHaveBeenCalledTimes(2);
        });

        expect(within(card).getByText('No active sessions')).toBeInTheDocument();
    });

    it('closes the confirm dialog when cancel is clicked for all sessions', async () => {
        const fixedNow = Date.now();
        const getTranslatorSessions = vi
            .fn()
            .mockResolvedValueOnce({
                sessions: [
                    translatorSession(fixedNow, { sessionId: 'session_1' }),
                    translatorSession(fixedNow, { sessionId: 'session_2' }),
                ],
            })
            .mockResolvedValueOnce({
                sessions: [],
            });
        const revokeAllSessions = vi.fn(async () => ({ ok: true }));
        const api = makeApi({ getTranslatorSessions, revokeAllSessions });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Translators');

        const card = screen
            .getByRole('heading', {
                name: 'Hindi Translator',
            })
            .closest('article')!;
        fireEvent.click(within(card).getByRole('button', { name: /Sessions/ }));
        await waitFor(() => {
            expect(
                within(card).getByRole('button', { name: 'End all sessions' }),
            ).toBeInTheDocument();
        });

        fireEvent.click(within(card).getByRole('button', { name: 'End all sessions' }));
        await screen.findByRole('heading', {
            name: 'End all sessions for Hindi Translator?',
        });

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(revokeAllSessions).toHaveBeenCalledTimes(0);
        expect(
            screen.queryByRole('heading', {
                name: 'End all sessions for Hindi Translator?',
            }),
        ).toBeNull();
    });

    it('shows an empty translator sessions state', async () => {
        const getTranslatorSessions = vi.fn(async () => ({ sessions: [] }));

        renderAdmin(<AdminScreen adminApi={makeApi({ getTranslatorSessions })} />);
        await openFirstProgram();
        await goToSection('Translators');
        const card = screen.getByRole('heading', { name: 'Hindi Translator' }).closest('article')!;
        fireEvent.click(within(card).getByRole('button', { name: /Sessions/ }));
        expect(await within(card).findByText('No active sessions')).toBeInTheDocument();
    });

    it('shows retry error messaging when translator sessions cannot be loaded', async () => {
        const failSessions = vi.fn(async () => {
            throw apiError('translator_sessions_fetch_failed', 500);
        });

        renderAdmin(<AdminScreen adminApi={makeApi({ getTranslatorSessions: failSessions })} />);
        await openFirstProgram();
        await goToSection('Translators');
        const card = screen.getByRole('heading', { name: 'Hindi Translator' }).closest('article')!;
        fireEvent.click(within(card).getByRole('button', { name: /Sessions/ }));
        expect(
            await within(card).findByText('Could not load sessions. Retrying…'),
        ).toBeInTheDocument();
    });

    it('routes to admin login instead of showing retry messaging when translator sessions return admin_auth_required', async () => {
        const getTranslatorSessions = vi.fn(async () => {
            throw authRequired();
        });

        renderAdmin(<AdminScreen adminApi={makeApi({ getTranslatorSessions })} />);
        await openFirstProgram();
        await goToSection('Translators');
        const card = screen.getByRole('heading', { name: 'Hindi Translator' }).closest('article')!;
        fireEvent.click(within(card).getByRole('button', { name: /Sessions/ }));

        expect(await screen.findByRole('heading', { name: 'Admin login' })).toBeInTheDocument();
        expect(screen.getByLabelText('Admin password')).toBeInTheDocument();
        expect(screen.queryByText('Could not load sessions. Retrying…')).not.toBeInTheDocument();
    });

    it('polls translator sessions every 30 seconds while expanded', async () => {
        const setIntervalSpy = vi.spyOn(window, 'setInterval');
        const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

        const getTranslatorSessions = vi.fn(async () => ({ sessions: [] }));
        const api = makeApi({ getTranslatorSessions });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Translators');

        const card = screen
            .getByRole('heading', {
                name: 'Hindi Translator',
            })
            .closest('article')!;
        fireEvent.click(within(card).getByRole('button', { name: /Sessions/ }));

        await waitFor(() => {
            expect(getTranslatorSessions).toHaveBeenCalledTimes(1);
        });

        const intervalCall = setIntervalSpy.mock.calls.find(
            ([_callback, delay]) => delay === 30_000,
        );
        expect(intervalCall).toBeDefined();
        const poller = intervalCall?.[0];
        if (typeof poller === 'function') {
            poller();
        }

        await waitFor(() => {
            expect(getTranslatorSessions).toHaveBeenCalledTimes(2);
        });

        fireEvent.click(within(card).getByRole('button', { name: /Sessions/ }));
        await waitFor(() => {
            expect(clearIntervalSpy).toHaveBeenCalled();
        });
    });

    it('stops polling when an expanded translator is removed from the current list', async () => {
        const setIntervalSpy = vi.spyOn(window, 'setInterval');
        const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
        const originalDetail = programDetail();
        const getProgramDetail = vi
            .fn()
            .mockResolvedValueOnce(originalDetail)
            .mockResolvedValueOnce({ ...originalDetail, translators: [] });
        const getTranslatorSessions = vi.fn(async () => ({ sessions: [] }));
        const deleteTranslator = vi.fn(async () => undefined);
        const api = makeApi({
            getProgramDetail,
            deleteTranslator,
            getTranslatorSessions,
        });

        try {
            renderAdmin(<AdminScreen adminApi={api} />);
            await openFirstProgram();
            await goToSection('Translators');

            const card = screen
                .getByRole('heading', {
                    name: 'Hindi Translator',
                })
                .closest('article')!;
            fireEvent.click(within(card).getByRole('button', { name: /Sessions/ }));
            await waitFor(() => {
                expect(getTranslatorSessions).toHaveBeenCalledTimes(1);
            });

            vi.useFakeTimers();

            const intervalCall = setIntervalSpy.mock.calls.find(
                ([_callback, delay]) => delay === 30_000,
            );
            expect(intervalCall).toBeDefined();
            const poller = intervalCall?.[0];
            if (typeof poller === 'function') {
                poller();
            }
            expect(getTranslatorSessions).toHaveBeenCalledTimes(2);

            fireEvent.click(within(card).getByRole('button', { name: 'Delete Hindi Translator' }));
            await Promise.resolve();
            expect(deleteTranslator).toHaveBeenCalledWith('program_1', 'translator_hindi');
            await Promise.resolve();
            expect(getProgramDetail).toHaveBeenCalledTimes(2);

            const callCountAfterRemoval = getTranslatorSessions.mock.calls.length;
            expect(clearIntervalSpy).toHaveBeenCalled();
            vi.advanceTimersByTime(90_000);
            await Promise.resolve();
            expect(getTranslatorSessions).toHaveBeenCalledTimes(callCountAfterRemoval);
        } finally {
            vi.useRealTimers();
        }
    });

    it('shows an error in the confirm dialog when ending a session fails', async () => {
        const fixedNow = Date.now();
        const getTranslatorSessions = vi.fn(async () => ({
            sessions: [translatorSession(fixedNow, { sessionId: 'session_1' })],
        }));
        const revokeSession = vi.fn(async () => {
            throw apiError('revoke_session_failed', 500);
        });
        const api = makeApi({ getTranslatorSessions, revokeSession });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();
        await goToSection('Translators');

        const card = screen
            .getByRole('heading', {
                name: 'Hindi Translator',
            })
            .closest('article')!;
        fireEvent.click(within(card).getByRole('button', { name: /Sessions/ }));
        await waitFor(() => {
            expect(getTranslatorSessions).toHaveBeenCalledTimes(1);
        });
        expect(within(card).getByRole('button', { name: 'End session' })).toBeInTheDocument();

        fireEvent.click(within(card).getByRole('button', { name: 'End session' }));
        const dialog = screen.getByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'End session' }));

        await waitFor(() => {
            expect(revokeSession).toHaveBeenCalledWith(
                'program_1',
                'translator_hindi',
                'session_1',
            );
        });
        expect(
            await within(card).findByText('Could not load sessions. Retrying…'),
        ).toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent('revoke_session_failed');
    });

    it('omits nextSlug when saving a non-draft program so other details still save', async () => {
        const liveProgram: AdminProgram = { ...firstProgram(), status: 'live' };
        const liveDetail: AdminProgramDetail = {
            ...programDetail(),
            program: liveProgram,
        };
        const updateProgram = vi.fn(
            async (_programId: string, _payload: UpdateProgramPayload) => liveDetail,
        );
        const api = makeApi({
            listPrograms: vi.fn(async () => ({ programs: [liveProgram] })),
            getProgramDetail: vi.fn(async () => liveDetail),
            updateProgram,
        });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();

        fireEvent.change(await screen.findByLabelText('Detail program name'), {
            target: { value: 'Patna Event 2026 Updated' },
        });
        fireEvent.change(screen.getByLabelText('Detail venue'), {
            target: { value: 'New Hall' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Update program' }));

        await waitFor(() => {
            expect(updateProgram).toHaveBeenCalledTimes(1);
        });
        const [, payload] = updateProgram.mock.calls[0]!;
        expect(payload).not.toHaveProperty('nextSlug');
        expect(payload).toMatchObject({
            name: 'Patna Event 2026 Updated',
            venue: 'New Hall',
            status: 'live',
        });
    });

    it('renders and submits the listener access toggle from program detail', async () => {
        const updateProgram = vi.fn(async (_programId: string, _payload: UpdateProgramPayload) =>
            programDetail(),
        );
        const api = makeApi({ updateProgram });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();

        await screen.findByRole('checkbox', {
            name: /Require listener approval.*before they can listen/i,
        });
        // The detail form remounts (React key={program.id}) once the program
        // detail fetch resolves, so re-query for a live node right before
        // asserting instead of reusing the handle captured by findByRole --
        // otherwise an in-flight remount can leave `toggle` pointing at an
        // already-detached element.
        await waitFor(() => {
            expect(
                screen.getByRole('checkbox', {
                    name: /Require listener approval.*before they can listen/i,
                }),
            ).not.toBeChecked();
        });
        const toggle = screen.getByRole('checkbox', {
            name: /Require listener approval.*before they can listen/i,
        });
        expect(toggle).toHaveAccessibleDescription(
            'Listeners must be approved by a volunteer before they can listen',
        );
        fireEvent.click(toggle);
        fireEvent.click(screen.getByRole('button', { name: 'Update program' }));

        await waitFor(() => expect(updateProgram).toHaveBeenCalledTimes(1));
        expect(updateProgram).toHaveBeenCalledWith(
            'program_1',
            expect.objectContaining({ accessControlEnabled: true }),
        );
    });

    it('locks the slug input for non-draft programs', async () => {
        const liveProgram: AdminProgram = { ...firstProgram(), status: 'live' };
        const liveDetail: AdminProgramDetail = {
            ...programDetail(),
            program: liveProgram,
        };
        const api = makeApi({
            listPrograms: vi.fn(async () => ({ programs: [liveProgram] })),
            getProgramDetail: vi.fn(async () => liveDetail),
        });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();

        expect(await screen.findByLabelText('Next slug')).toBeDisabled();
    });

    it('still sends nextSlug when saving a draft program', async () => {
        const updateProgram = vi.fn(async (_programId: string, _payload: UpdateProgramPayload) =>
            programDetail(),
        );
        const api = makeApi({ updateProgram });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();

        fireEvent.change(await screen.findByLabelText('Detail program name'), {
            target: { value: 'Patna Event 2026 Draft Edit' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Update program' }));

        await waitFor(() => {
            expect(updateProgram).toHaveBeenCalledTimes(1);
        });
        const [, payload] = updateProgram.mock.calls[0]!;
        expect(payload).toMatchObject({ nextSlug: 'patna-event-2026' });
        expect(await screen.findByLabelText('Next slug')).not.toBeDisabled();
    });

    it("still sends nextSlug when a draft's status is switched to live before saving", async () => {
        // Guards the decision to key slug-editability on the persisted status
        // (detail.program.status), not the unsaved dropdown value (editForm.status).
        // A draft is still editable, so flipping the dropdown to live and saving in
        // one PATCH must carry nextSlug — the backend accepts it because the row is
        // still a draft at write time.
        const updateProgram = vi.fn(async (_programId: string, _payload: UpdateProgramPayload) =>
            programDetail(),
        );
        const api = makeApi({ updateProgram });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();

        await screen.findByLabelText('Detail program name');
        fireEvent.change(screen.getByLabelText('Detail status'), {
            target: { value: 'live' },
        });
        expect(screen.getByLabelText('Next slug')).not.toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Update program' }));

        await waitFor(() => {
            expect(updateProgram).toHaveBeenCalledTimes(1);
        });
        const [, payload] = updateProgram.mock.calls[0]!;
        expect(payload).toMatchObject({
            status: 'live',
            nextSlug: 'patna-event-2026',
        });
    });

    it('locks nextSlug for draft programs that have ever been live', async () => {
        const livedDraft: AdminProgram = {
            ...firstProgram(),
            status: 'draft',
            firstLiveAt: '2026-06-01T10:00:00.000Z',
        };
        const livedDraftDetail: AdminProgramDetail = {
            ...programDetail(),
            program: livedDraft,
        };
        const updateProgram = vi.fn(
            async (_programId: string, _payload: UpdateProgramPayload) => livedDraftDetail,
        );
        const api = makeApi({
            listPrograms: vi.fn(async () => ({ programs: [livedDraft] })),
            getProgramDetail: vi.fn(async () => livedDraftDetail),
            updateProgram,
        });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();

        await screen.findByLabelText('Next slug');
        expect(screen.getByLabelText('Next slug')).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Detail program name'), {
            target: { value: 'Patna Event 2026 Draft' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Update program' }));

        await waitFor(() => {
            expect(updateProgram).toHaveBeenCalledTimes(1);
        });
        const [, payload] = updateProgram.mock.calls[0]!;
        expect(payload).not.toHaveProperty('nextSlug');
    });
});
