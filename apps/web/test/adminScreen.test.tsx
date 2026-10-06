import type { ReactElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/api/client';
import type {
    AdminApi,
    AdminMe,
    AdminEventFeed,
    AdminListenerReport,
    AdminProgram,
    AdminProgramDetail,
    AdminProgramApproverAccess,
    AdminProgramList,
    AdminProgramStatus,
    AdminRole,
    AdminReportSummary,
    AdminRetentionRun,
    AdminUser,
    TranslatorSessionSummary,
} from '../src/api/admin';
import { AdminScreen } from '../src/features/admin/AdminScreen';

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
        <MemoryRouter initialEntries={['/manage']}>
            <Routes>
                <Route path="/manage" element={ui} />
                <Route path="/manage/programs/:slug" element={ui} />
                <Route path="/manage/programs/:slug/:section" element={ui} />
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
                startDate: '2027-07-01',
                endDate: '2027-07-01',
                accessControlEnabled: true,
                createdBy: null,
                createdAt: '2026-06-01T10:00:00.000Z',
                updatedAt: '2026-06-01T10:00:00.000Z',
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
            approverUrl: 'https://api.example.invalid/ignored/approver',
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
        series: { bucket: 'day', points: [] },
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
        createdAt: '2026-06-01T10:00:00.000Z',
        updatedAt: '2026-06-01T10:00:00.000Z',
        ...overrides,
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

function approverAccess(
    overrides: Partial<AdminProgramApproverAccess> = {},
): AdminProgramApproverAccess {
    return {
        configured: true,
        loginId: 'approver@example.com',
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

type LegacyTranslatorAdminApi = {
    createTranslator: (...args: unknown[]) => Promise<unknown>;
    updateTranslator: (...args: unknown[]) => Promise<unknown>;
    resetTranslatorPassword: (...args: unknown[]) => Promise<unknown>;
    deleteTranslator: (...args: unknown[]) => Promise<unknown>;
    addTranslatorAssignment: (...args: unknown[]) => Promise<unknown>;
    removeTranslatorAssignment: (...args: unknown[]) => Promise<unknown>;
};

function makeApi(
    overrides: Partial<AdminApi & LegacyTranslatorAdminApi> = {},
): AdminApi & LegacyTranslatorAdminApi {
    return {
        addTranslatorAssignment: vi.fn(async () => programDetail().translators[0]!),
        me: vi.fn(async () => adminMe()),
        createProgram: vi.fn(async () => firstProgram()),
        createStream: vi.fn(async () => programDetail().streams[0]!),
        createTranslator: vi.fn(async () => programDetail().translators[0]!),
        deleteProgram: vi.fn(async () => undefined),
        deleteUser: vi.fn(async () => undefined),
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
        getApproverAccess: vi.fn(async () => approverAccess()),
        getProgramStatus: vi.fn(async () => status()),
        getReportSummary: vi.fn(async () => reportSummary()),
        getReportSeries: vi.fn(async () => ({
            series: reportSummary().series,
            activeListeners: { total: 0, streams: [] },
            generatedAt: new Date().toISOString(),
        })),
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
        resetLanguagePassword: vi.fn(async () => programDetail().translators[0]!),
        updateApproverAccess: vi.fn(async () => approverAccess()),
        updateProgram: vi.fn(async () => programDetail()),
        updateStream: vi.fn(async () => programDetail().streams[0]!),
        updateTranslator: vi.fn(async () => programDetail().translators[0]!),
        ...overrides,
    };
}

async function goToSection(name: string) {
    const headingName =
        name === 'Reports'
            ? 'Report summary'
            : name === 'Status'
              ? 'Listeners'
              : name === 'Translators' || name === 'Streams'
                ? 'Languages'
                : name;
    await screen.findByRole('heading', { name: headingName });
}

async function openFirstProgram() {
    const card = await screen.findByRole('link', {
        name: /Patna Event 2026/,
    });
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

        expect(
            await screen.findByRole('heading', { name: 'Management login' }),
        ).toBeInTheDocument();
        expect(screen.getByLabelText('Username')).toBeInTheDocument();
        expect(screen.getByLabelText('Password')).toBeInTheDocument();
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
        fireEvent.change(await screen.findByLabelText('Password'), {
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
        fireEvent.change(await screen.findByLabelText('Password'), {
            target: { value: 'admin-pass' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

        expect(await screen.findByText('Patna Event 2026')).toBeInTheDocument();
        expect(api.login).toHaveBeenCalledWith('admin', 'admin-pass');
        expect(listPrograms).toHaveBeenCalledTimes(2);
    });

    it('calls changeMyPassword from the Account panel', async () => {
        const changeMyPassword = vi.fn(async () => ({ ok: true as const }));
        const api = makeApi({
            me: vi.fn(async () => adminMe('admin')),
            changeMyPassword,
        });

        renderAdmin(<AdminScreen adminApi={api} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Reset' }));

        fireEvent.change(await screen.findByLabelText('Current password'), {
            target: { value: 'old-pass' },
        });
        fireEvent.change(screen.getByLabelText('New password'), {
            target: { value: 'new-pass' },
        });
        fireEvent.change(screen.getByLabelText('Confirm new password'), {
            target: { value: 'new-pass' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

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
        fireEvent.click(await screen.findByRole('button', { name: 'Log out' }));

        expect(logout).toHaveBeenCalled();
        // Back to the login screen (username/password fields visible again).
        expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    });

    it('derives the listener URL from the program slug and browser origin', async () => {
        renderAdmin(<AdminScreen adminApi={makeApi()} />);

        expect(await screen.findByText('Patna Event 2026')).toBeInTheDocument();
        expect(screen.getByText('patna-event-2026')).toBeInTheDocument();
        expect(
            screen.queryByText('https://bhasha.test/patna-event-2026/translate'),
        ).not.toBeInTheDocument();
    });

    it('sorts current program cards by start date ascending', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-01-16T10:00:00.000Z'));

        const earlyProgram = {
            ...firstProgram(),
            id: 'program_early',
            name: 'Early Event',
            slug: 'early-event',
            startDate: '2026-01-15',
            endDate: '2026-01-16',
        };
        const lateProgram = {
            ...firstProgram(),
            id: 'program_late',
            name: 'Late Event',
            slug: 'late-event',
            startDate: '2026-12-15',
        };

        renderAdmin(
            <AdminScreen
                adminApi={makeApi({
                    listPrograms: vi.fn(async () => ({
                        programs: [lateProgram, earlyProgram],
                    })),
                })}
            />,
        );

        const currentSection = await screen.findByRole('region', { name: 'Current programs' });
        const cards = within(currentSection).getAllByRole('link');
        const cardNames = cards
            .map((card) => card.textContent ?? '')
            .filter((text) => text.includes('Early Event') || text.includes('Late Event'));
        expect(cardNames).toHaveLength(2);
        expect(cardNames[0]).toContain('2026-01-15 – 16');
        expect(cardNames[0]).toContain('Early Event');
        expect(cardNames[1]).toContain('Late Event');
    });

    it('sorts past program cards by start date descending', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-09-28T10:00:00.000Z'));

        const earlyPastProgram = {
            ...firstProgram(),
            id: 'program_past_early',
            name: 'Early Past Event',
            slug: 'early-past-event',
            startDate: '2026-01-15',
            endDate: '2026-01-16',
        };
        const latePastProgram = {
            ...firstProgram(),
            id: 'program_past_late',
            name: 'Late Past Event',
            slug: 'late-past-event',
            startDate: '2026-08-15',
            endDate: '2026-08-16',
        };

        renderAdmin(
            <AdminScreen
                adminApi={makeApi({
                    listPrograms: vi.fn(async () => ({
                        programs: [earlyPastProgram, latePastProgram],
                    })),
                })}
            />,
        );

        const pastSection = await screen.findByRole('region', { name: 'Past programs' });
        const cards = within(pastSection).getAllByRole('link');
        const cardNames = cards
            .map((card) => card.textContent ?? '')
            .filter((text) => text.includes('Past Event'));
        expect(cardNames).toHaveLength(2);
        expect(cardNames[0]).toContain('Late Past Event');
        expect(cardNames[1]).toContain('Early Past Event');
    });

    it('keeps a program current through a 2-day grace period after its end date, then moves it to Past', async () => {
        const gracePeriodProgram = {
            ...firstProgram(),
            id: 'program_grace',
            name: 'Grace Period Event',
            slug: 'grace-period-event',
            startDate: '2026-09-20',
            endDate: '2026-09-21',
        };

        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date('2026-09-22T10:00:00.000Z'));
        const { unmount } = renderAdmin(
            <AdminScreen
                adminApi={makeApi({
                    listPrograms: vi.fn(async () => ({ programs: [gracePeriodProgram] })),
                })}
            />,
        );
        const currentSection = await screen.findByRole('region', { name: 'Current programs' });
        expect(within(currentSection).getByText('Grace Period Event')).toBeInTheDocument();
        unmount();

        vi.setSystemTime(new Date('2026-09-23T00:00:00.000Z'));
        renderAdmin(
            <AdminScreen
                adminApi={makeApi({
                    listPrograms: vi.fn(async () => ({ programs: [gracePeriodProgram] })),
                })}
            />,
        );
        const pastSection = await screen.findByRole('region', { name: 'Past programs' });
        expect(within(pastSection).getByText('Grace Period Event')).toBeInTheDocument();
    });

    it('opens a program by clicking the program card instead of an Open button', async () => {
        const api = makeApi();

        renderAdmin(<AdminScreen adminApi={api} />);

        await screen.findByText('Patna Event 2026');
        expect(
            screen.queryByRole('button', { name: 'Open Patna Event 2026' }),
        ).not.toBeInTheDocument();

        fireEvent.click(
            screen.getByRole('link', {
                name: /2027-07-01[\s\S]*Patna Event 2026/,
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
        fireEvent.click(screen.getByRole('button', { name: 'Add program' }));
        fireEvent.change(await screen.findByLabelText('Program name'), {
            target: { value: 'Bad Slug Event' },
        });
        fireEvent.change(screen.getByLabelText('Program slug'), {
            target: { value: 'Bad Slug' },
        });
        fireEvent.change(await screen.findByLabelText('Start date'), {
            target: { value: '2026-07-01' },
        });
        fireEvent.change(await screen.findByLabelText('End date'), {
            target: { value: '2026-07-01' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Create program' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'slug must use lowercase letters, numbers, and hyphens',
        );
        expect(screen.queryByText('validation_error')).not.toBeInTheDocument();
    });

    it.each(['admin', 'user'] as const)(
        'shows the add-program action for %s accounts (both roles can now create programs)',
        async (role) => {
            const api = makeApi({ me: vi.fn(async () => adminMe(role)) });

            renderAdmin(<AdminScreen adminApi={api} />);

            await screen.findByText('Patna Event 2026');
            expect(await screen.findByRole('button', { name: 'Add program' })).toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: 'Add program' }));
            expect(await screen.findByLabelText('Program name')).toBeInTheDocument();
            if (role === 'admin') {
                expect(screen.getByLabelText('Program owner')).toBeInTheDocument();
            } else {
                expect(screen.queryByLabelText('Program owner')).not.toBeInTheDocument();
            }
        },
    );

    it('includes the listener access toggle in the create-program payload', async () => {
        const createProgram = vi.fn(async () => firstProgram());
        const api = makeApi({ createProgram });

        renderAdmin(<AdminScreen adminApi={api} />);

        await screen.findByRole('button', { name: 'Add program' });
        fireEvent.click(screen.getByRole('button', { name: 'Add program' }));
        fireEvent.change(await screen.findByLabelText('Program name'), {
            target: { value: 'Gaya Event 2026' },
        });
        fireEvent.change(screen.getByLabelText('Program slug'), {
            target: { value: 'gaya-event-2026' },
        });
        fireEvent.change(await screen.findByLabelText('Start date'), {
            target: { value: '2026-09-01' },
        });
        fireEvent.change(await screen.findByLabelText('End date'), {
            target: { value: '2026-09-01' },
        });
        fireEvent.change(screen.getByLabelText('Program owner'), {
            target: { value: 'user_1' },
        });
        const accessToggle = screen.getByRole('checkbox', {
            name: /Require listener approval.*before they can listen/i,
        });
        fireEvent.click(accessToggle);
        fireEvent.click(screen.getByRole('button', { name: 'Create program' }));

        await waitFor(() => expect(createProgram).toHaveBeenCalledTimes(1));
        expect(createProgram).toHaveBeenCalledWith(
            expect.objectContaining({
                slug: 'gaya-event-2026',
                accessControlEnabled: true,
                createdBy: 'user_1',
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
        expect(screen.getByText('Listeners')).toBeInTheDocument();
    });

    it('hides approver access when listener approval is not required', async () => {
        const detail = programDetail();
        const api = makeApi({
            getProgramDetail: vi.fn(async () => ({
                ...detail,
                program: { ...detail.program, accessControlEnabled: false },
            })),
        });

        renderAdmin(<AdminScreen adminApi={api} />);
        await openFirstProgram();

        expect(screen.queryByRole('heading', { name: 'Approver access' })).not.toBeInTheDocument();
        expect(api.getApproverAccess).not.toHaveBeenCalled();
    });
});
