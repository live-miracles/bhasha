import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Button,
    Checkbox,
    Group,
    Paper,
    SimpleGrid,
    Stack,
    Text,
    Textarea,
    TextInput,
    Title,
} from '@mantine/core';
import { QRCodeSVG } from 'qrcode.react';
import { useNavigate, useParams } from 'react-router-dom';

import {
    createAdminApi,
    type AdminApi,
    type AdminEventFeed,
    type AdminListenerAccessSummary,
    type AdminMe,
    type AdminListenerReport,
    type ListenerReportQuery,
    type ListenerApprovalStatus,
    type AdminProgram,
    type AdminProgramDetail,
    type AdminProgramVolunteerAccess,
    type AdminProgramStatus,
    type AdminReadiness,
    type AdminReportSummary,
    type ReportDateRangeQuery,
    type AdminStream,
    type TranslatorSessionSummary,
    type AdminTranslator,
    type ConfirmableReadinessItemId,
    type ProgramStatus,
    LISTENER_DEVICE_LABELS,
} from '../../api/admin';
import { ApiError } from '../../api/client';
import { getLanguageName, SUPPORTED_LANGUAGES } from './languages';
import { ReadinessPanel } from './readiness/ReadinessPanel';
import { EventFeedPanel, type EventFiltersState } from './reports/EventFeedPanel';
import {
    ReportDateRangeControl,
    type ReportDateRangePreset,
    type ReportDateRangeValue,
} from './reports/ReportDateRangeControl';
import { ReportSummaryPanel } from './reports/ReportSummaryPanel';
import { formatISTDateTime, formatISTTime } from './formatTime';
import { ConfirmDialog } from './ConfirmDialog';
import { AdminDialog } from './AdminDialog';
import { KickConfirmDialog } from './KickConfirmDialog';
import {
    AdminLayout,
    AdminUiProvider,
    KpiTile,
    Sidebar,
    SidebarApp,
    StatusPill,
    TopBar,
} from './AdminShell';
import { UsersPanel } from './UsersPanel';
import { AccountPanel } from './AccountPanel';

interface AdminScreenProps {
    adminApi?: AdminApi;
}

type LoadState = 'checking' | 'login' | 'ready' | 'error';
type AppSection = 'programs' | 'deleted' | 'users' | 'account';
type AdminSection =
    'status' | 'streams' | 'translators' | 'overview' | 'share' | 'readiness' | 'reports';
type ActiveSection = AppSection | AdminSection;
type ReportFiltersState = {
    states: string[];
    approvalStatuses: ListenerApprovalStatus[];
    streamId: string;
    deviceLabel: string;
};
const EMPTY_REPORT_FILTERS: ReportFiltersState = {
    states: [],
    approvalStatuses: [],
    streamId: '',
    deviceLabel: '',
};
const EMPTY_EVENT_FILTERS: EventFiltersState = {
    eventTypes: [],
    translatorId: '',
};
const DEFAULT_EVENT_FILTERS: EventFiltersState = {
    eventTypes: [
        'translator_connected',
        'translator_disconnected',
        'listener_reconnected',
        'listener_left',
    ],
    translatorId: '',
};
const EVENT_FEED_PAGE_SIZE = 20;
const RANGE_WINDOW_MS: Partial<Record<ReportDateRangePreset, number>> = {
    'Last 5 minutes': 5 * 60 * 1000,
    'Last 30 minutes': 30 * 60 * 1000,
    'Last 1 hour': 60 * 60 * 1000,
    'Last 6 hours': 6 * 60 * 60 * 1000,
    'Last 12 hours': 12 * 60 * 60 * 1000,
    'Last 24 hours': 24 * 60 * 60 * 1000,
    'Last 7 days': 7 * 24 * 60 * 60 * 1000,
};
const LISTENER_STATE_OPTIONS = ['requested', 'connected', 'disconnected', 'failed'] as const;
const LISTENER_APPROVAL_STATUS_OPTIONS: ListenerApprovalStatus[] = [
    'pending',
    'approved',
    'revoked',
    'superseded',
];
type ComputedReportRange = { from?: string; to?: string };
type RefetchReportsOptions = { skipIfInFlight?: boolean };

const IST_OFFSET_MS = 330 * 60 * 1000;
const IST_OFFSET_SUFFIX = '+05:30';

function isDateTimeLocalValue(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}T/.test(value) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function reportRangeBoundToIso(value: string): string | undefined {
    const valueWithZone = isDateTimeLocalValue(value) ? `${value}${IST_OFFSET_SUFFIX}` : value;
    const date = new Date(valueWithZone);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function startOfTodayInIST(nowMs: number): string {
    const istNow = new Date(nowMs + IST_OFFSET_MS);
    const startUtcMs =
        Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), 0, 0, 0, 0) -
        IST_OFFSET_MS;
    return new Date(startUtcMs).toISOString();
}

export function computeRange(
    preset: ReportDateRangePreset,
    customFrom: string,
    customTo: string,
): ComputedReportRange {
    if (preset === 'All time') {
        return {};
    }
    if (preset === 'Custom') {
        return { from: customFrom, to: customTo };
    }

    const nowMs = Date.now();
    const now = new Date(nowMs);
    if (preset === 'Today') {
        return { from: startOfTodayInIST(nowMs), to: now.toISOString() };
    }

    const windowMs = RANGE_WINDOW_MS[preset];
    if (!windowMs) {
        return {};
    }
    return {
        from: new Date(nowMs - windowMs).toISOString(),
        to: now.toISOString(),
    };
}

function buildReportQuery(
    filters: ReportFiltersState,
    page: number,
    dateRange: ComputedReportRange,
): ListenerReportQuery {
    const q: ListenerReportQuery = {};
    if (filters.states.length) q.states = filters.states;
    if (filters.approvalStatuses.length) {
        q.approvalStatuses = filters.approvalStatuses;
    }
    if (filters.streamId) q.streamId = filters.streamId;
    if (filters.deviceLabel) q.deviceLabel = filters.deviceLabel;
    if (dateRange.from) {
        const from = reportRangeBoundToIso(dateRange.from);
        if (from) q.createdFrom = from;
    }
    if (dateRange.to) {
        const to = reportRangeBoundToIso(dateRange.to);
        if (to) q.createdTo = to;
    }
    if (page > 1) q.page = page;
    return q;
}

export function buildListenerReportKey(
    programId: string,
    query: ListenerReportQuery,
    preset: ReportDateRangePreset,
    customRange: ReportDateRangeValue,
): string {
    // Exclude the absolute createdFrom/createdTo bounds from the de-dup key:
    // for a relative preset ("Last 5 minutes" etc.) computeRange derives those
    // from Date.now(), so including them would make the key change on every
    // render and defeat the `loadedReportQueryKey` guard. The preset + custom
    // bounds fully determine the intended window, and the freshly computed
    // timestamps are still sent in `query` to the API.
    const { createdFrom: _createdFrom, createdTo: _createdTo, ...stableQuery } = query;
    void _createdFrom;
    void _createdTo;
    return JSON.stringify({ programId, query: stableQuery, preset, customRange });
}

function buildReportDateRange(dateRange: ComputedReportRange): ReportDateRangeQuery | undefined {
    const range: ReportDateRangeQuery = {};
    if (dateRange.from) {
        const from = reportRangeBoundToIso(dateRange.from);
        if (from) range.from = from;
    }
    if (dateRange.to) {
        const to = reportRangeBoundToIso(dateRange.to);
        if (to) range.to = to;
    }
    return range.from || range.to ? range : undefined;
}

function formatRangeChipLabel(dateRange: ComputedReportRange): string | null {
    if (!dateRange.from && !dateRange.to) {
        return null;
    }
    const formatter = new Intl.DateTimeFormat('en-GB', {
        day: '2-digit',
        month: 'short',
    });
    const formatBound = (value: string | undefined, fallback: string) => {
        if (!value) {
            return fallback;
        }
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? fallback : formatter.format(date);
    };
    return `${formatBound(dateRange.from, 'Start')} – ${formatBound(dateRange.to, 'Now')}`;
}

function reportFiltersActive(f: ReportFiltersState): boolean {
    return f.states.length > 0 || f.approvalStatuses.length > 0 || !!f.streamId || !!f.deviceLabel;
}

function errorCode(error: unknown): string {
    if (error instanceof ApiError) {
        if (
            typeof error.body === 'object' &&
            error.body !== null &&
            'error' in error.body &&
            typeof error.body.error === 'string' &&
            'message' in error.body &&
            typeof error.body.message === 'string' &&
            error.body.message.trim() !== ''
        ) {
            return error.body.message;
        }
        return error.code;
    }
    return error instanceof Error ? error.message : String(error);
}

function isAuthRequired(error: unknown): boolean {
    return error instanceof ApiError && error.code === 'admin_auth_required';
}

function urlForProgram(slug: string, suffix = ''): string {
    return `${window.location.origin}/${slug}${suffix}`;
}

export function mapUrlSection(urlSection: string | undefined): AdminSection {
    if (!urlSection) {
        return 'overview';
    }
    if (urlSection === 'report') {
        return 'reports';
    }
    if (
        urlSection === 'status' ||
        urlSection === 'streams' ||
        urlSection === 'translators' ||
        urlSection === 'overview' ||
        urlSection === 'share' ||
        urlSection === 'readiness' ||
        urlSection === 'reports'
    ) {
        return urlSection;
    }
    return 'overview';
}

function adminProgramPath(slug: string, section = 'overview'): string {
    return section === 'overview'
        ? `/manage/programs/${slug}`
        : `/manage/programs/${slug}/${section}`;
}

function formatRelativeTime(iso: string | null | undefined, referenceMs = Date.now()): string {
    const eventMs = Date.parse(iso ?? '');
    if (!Number.isFinite(eventMs)) {
        return '—';
    }
    const deltaMs = Math.max(0, referenceMs - eventMs);
    const totalSeconds = Math.floor(deltaMs / 1000);
    if (totalSeconds < 60) {
        return `${totalSeconds} sec ago`;
    }
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) {
        return `${totalMinutes} min ago`;
    }
    const totalHours = Math.floor(totalMinutes / 60);
    if (totalHours < 24) {
        return `${totalHours} hr ago`;
    }
    const totalDays = Math.floor(totalHours / 24);
    return `${totalDays} day ago`;
}

function formatRelativeTimeFromMs(
    timestampMs: number | null | undefined,
    referenceMs = Date.now(),
) {
    if (timestampMs == null) {
        return '—';
    }
    const deltaMs = Math.max(0, referenceMs - timestampMs);
    const totalSeconds = Math.floor(deltaMs / 1000);
    if (totalSeconds < 60) {
        return `${totalSeconds} sec ago`;
    }
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) {
        return `${totalMinutes} min ago`;
    }
    const totalHours = Math.floor(totalMinutes / 60);
    if (totalHours < 24) {
        return `${totalHours} hr ago`;
    }
    const totalDays = Math.floor(totalHours / 24);
    return `${totalDays} day ago`;
}

const SESSION_POLL_MS = 30_000;
const SESSION_EXPIRES_MS = 30 * 60 * 1000;

function isLikelyExpired(
    session: Pick<TranslatorSessionSummary, 'lastActiveAt' | 'isPublishing'>,
    referenceMs = Date.now(),
) {
    if (session.isPublishing) {
        return false;
    }
    const lastActiveMs = Date.parse(session.lastActiveAt);
    return Number.isFinite(lastActiveMs) ? referenceMs - lastActiveMs > SESSION_EXPIRES_MS : false;
}

type TranslatorSessionState = {
    sessions: TranslatorSessionSummary[];
    loading: boolean;
    error: boolean;
    updatedAt: number | null;
};

type EndSessionConfirmState =
    | {
          kind: 'session';
          translator: AdminTranslator;
          session: TranslatorSessionSummary;
      }
    | {
          kind: 'all';
          translator: AdminTranslator;
      };

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function svgFilename(filename: string): string {
    return filename.replace(/\.[^.]+$/, '') + '.svg';
}

function translatorSvgFilename(filename: string): string {
    return svgFilename(filename).replace(/\.svg$/, '-translator.svg');
}

function volunteerSvgFilename(filename: string): string {
    return svgFilename(filename).replace(/\.svg$/, '-volunteer.svg');
}

function editFormFromProgram(program: AdminProgram) {
    return {
        name: program.name,
        venue: program.venue,
        eventDate: program.eventDate,
        adminNotes: program.adminNotes,
        status: program.status,
        nextSlug: program.slug,
        accessControlEnabled: program.accessControlEnabled,
    };
}

export function AdminScreen({ adminApi: adminApiProp }: AdminScreenProps) {
    // Memoize the API client so its identity is stable across renders. Without
    // this, the `adminApi = createAdminApi()` default parameter produced a NEW
    // client object every render, and any effect listing `adminApi` in its deps
    // (e.g. the listener-report fetch) re-ran every render — for relative date
    // presets that meant a fresh Date.now() window each time, defeating the
    // de-dup guard and causing an infinite refetch loop ("Updating…" forever).
    const adminApi = useMemo(() => adminApiProp ?? createAdminApi(), [adminApiProp]);
    const navigate = useNavigate();
    const { slug, section } = useParams<{ slug?: string; section?: string }>();
    const loadProgramsRequestId = useRef(0);
    const pendingRouteLoad = useRef<string | null>(null);
    const suppressRouteLoad = useRef(false);
    const reportsReqId = useRef(0);
    const listenerAccessSummaryReqId = useRef(0);
    const reportsInFlight = useRef(false);
    const reportsInFlightCount = useRef(0);
    const loadedReportQueryKey = useRef<string | null>(null);
    const [loadState, setLoadState] = useState<LoadState>('checking');
    const [programs, setPrograms] = useState<AdminProgram[]>([]);
    const [deletedPrograms, setDeletedPrograms] = useState<AdminProgram[]>([]);
    const [selectedProgramId, setSelectedProgramId] = useState<string | null>(null);
    const selectedProgramIdRef = useRef(selectedProgramId);
    selectedProgramIdRef.current = selectedProgramId;
    const [detail, setDetail] = useState<AdminProgramDetail | null>(null);
    const [status, setStatus] = useState<AdminProgramStatus | null>(null);
    const [report, setReport] = useState<AdminListenerReport | null>(null);
    const [reportOpen, setReportOpen] = useState(false);
    const [eventsOpen, setEventsOpen] = useState(false);
    const [reportLastLoadedAt, setReportLastLoadedAt] = useState<string | null>(null);
    const [reportFilters, setReportFilters] = useState<ReportFiltersState>(EMPTY_REPORT_FILTERS);
    const [dateRange, setDateRange] = useState<ReportDateRangeValue>({
        from: '',
        to: '',
    });
    const [dateRangePreset, setDateRangePreset] = useState<ReportDateRangePreset>('All time');
    const [reportPage, setReportPage] = useState(1);
    const [eventFilters, setEventFilters] = useState<EventFiltersState>(DEFAULT_EVENT_FILTERS);
    const [eventPage, setEventPage] = useState(1);
    const [reportFetching, setReportFetching] = useState(false);
    const [listenerAccessSummary, setListenerAccessSummary] =
        useState<AdminListenerAccessSummary | null>(null);
    const [listenerAccessSummaryFetching, setListenerAccessSummaryFetching] = useState(false);
    const [isFetchingReports, setIsFetchingReports] = useState(false);
    const [summary, setSummary] = useState<AdminReportSummary | null>(null);
    const [eventFeed, setEventFeed] = useState<AdminEventFeed | null>(null);
    const [readiness, setReadiness] = useState<AdminReadiness | null>(null);
    const [pendingReadinessItem, setPendingReadinessItem] =
        useState<ConfirmableReadinessItemId | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [kickedStream, setKickedStream] = useState<AdminProgramStatus['streams'][number] | null>(
        null,
    );
    const [kickPending, setKickPending] = useState(false);
    const [kickError, setKickError] = useState<string | null>(null);
    const [loginUsername, setLoginUsername] = useState('');
    const [loginPassword, setLoginPassword] = useState('');
    const [identity, setIdentity] = useState<AdminMe | null>(null);
    const [programForm, setProgramForm] = useState({
        slug: '',
        name: '',
        venue: '',
        eventDate: '',
        adminNotes: '',
        accessControlEnabled: false,
    });
    const [streamForm, setStreamForm] = useState({
        languageName: '',
        languageCode: '',
        displayOrder: '0',
    });
    const [translatorForm, setTranslatorForm] = useState({
        email: '',
        name: '',
        password: '',
    });
    const [editForm, setEditForm] = useState({
        name: '',
        venue: '',
        eventDate: '',
        adminNotes: '',
        status: 'draft' as ProgramStatus,
        nextSlug: '',
        accessControlEnabled: false,
    });
    const [activeSection, setActiveSection] = useState<ActiveSection>('programs');
    const reportDateRangeRef = useRef<HTMLDivElement | null>(null);

    const handleAuthExpired = useCallback(() => {
        // Invalidate any auth/list probes still resolving. React can have an
        // earlier probe in flight when a user submits the login form; its late
        // 401 must not reset the state from the newer authenticated probe.
        loadProgramsRequestId.current += 1;
        pendingRouteLoad.current = null;
        suppressRouteLoad.current = false;
        reportsReqId.current += 1;
        reportsInFlight.current = false;
        reportsInFlightCount.current = 0;
        loadedReportQueryKey.current = null;
        setLoadState('login');
        setError(null);
        setPrograms([]);
        setDeletedPrograms([]);
        setSelectedProgramId(null);
        setDetail(null);
        setStatus(null);
        setReport(null);
        setReportLastLoadedAt(null);
        setReportOpen(false);
        setEventsOpen(false);
        setReportFetching(false);
        setListenerAccessSummary(null);
        setListenerAccessSummaryFetching(false);
        setIsFetchingReports(false);
        setSummary(null);
        setEventFeed(null);
        setReadiness(null);
        setPendingReadinessItem(null);
        setRefreshing(false);
        setActiveSection('programs');
        setIdentity(null);
        setKickedStream(null);
        setKickPending(false);
        setKickError(null);
        setLoginUsername('');
        setLoginPassword('');
    }, []);

    const handleAuthError = useCallback(
        (adminError: unknown): boolean => {
            if (!isAuthRequired(adminError)) {
                return false;
            }
            handleAuthExpired();
            return true;
        },
        [handleAuthExpired],
    );

    const handleSignOut = useCallback(async () => {
        // Best-effort: clear the server session, but reset to the login screen even
        // if the request fails (e.g. offline) so the user is never stuck signed in.
        try {
            await adminApi.logout();
        } catch {
            // ignore — local reset below still signs the user out of this browser.
        }
        handleAuthExpired();
    }, [adminApi, handleAuthExpired]);

    async function loadPrograms() {
        const requestId = ++loadProgramsRequestId.current;
        setError(null);
        try {
            const [response, deletedResponse, me] = await Promise.all([
                adminApi.listPrograms(),
                adminApi.listDeletedPrograms(),
                adminApi.me(),
            ]);
            if (requestId !== loadProgramsRequestId.current) {
                return;
            }
            setPrograms(response.programs);
            setDeletedPrograms(deletedResponse);
            setIdentity(me);
            setLoadState('ready');
        } catch (loadError) {
            if (requestId !== loadProgramsRequestId.current) {
                return;
            }
            if (handleAuthError(loadError)) {
                return;
            }
            setError(errorCode(loadError));
            setLoadState('error');
        }
    }

    const loadDetail = useCallback(
        async function loadDetail(programId: string, targetSection: AdminSection = 'overview') {
            setError(null);
            selectedProgramIdRef.current = programId;
            setSelectedProgramId(programId);
            setReport(null);
            setReportLastLoadedAt(null);
            loadedReportQueryKey.current = null;
            setReportOpen(false);
            setEventsOpen(false);
            setReportFilters(EMPTY_REPORT_FILTERS);
            setReportPage(1);
            setEventFilters(DEFAULT_EVENT_FILTERS);
            setEventPage(1);
            // Clear prior report state so a newly selected program never shows the
            // previous program's counts, events, or status while loading.
            setStatus(null);
            setListenerAccessSummary(null);
            setListenerAccessSummaryFetching(false);
            setSummary(null);
            setEventFeed(null);
            setReadiness(null);
            setPendingReadinessItem(null);
            try {
                const [
                    detailResponse,
                    statusResponse,
                    summaryResponse,
                    eventFeedResponse,
                    readinessResponse,
                ] = await Promise.all([
                    adminApi.getProgramDetail(programId),
                    adminApi.getProgramStatus(programId),
                    adminApi.getReportSummary(programId, undefined),
                    adminApi.getEventFeed(programId, {
                        range: undefined,
                        eventTypes: DEFAULT_EVENT_FILTERS.eventTypes,
                        page: 1,
                        pageSize: EVENT_FEED_PAGE_SIZE,
                    }),
                    adminApi.getReadiness(programId),
                ]);
                setDetail(detailResponse);
                setStatus(statusResponse);
                setSummary(summaryResponse);
                setEventFeed(eventFeedResponse);
                setReadiness(readinessResponse);
                setEditForm(editFormFromProgram(detailResponse.program));
                setActiveSection(targetSection);
            } catch (detailError) {
                if (handleAuthError(detailError)) {
                    return;
                }
                setError(errorCode(detailError));
            }
        },
        [adminApi, handleAuthError],
    );

    const refetchReports = useCallback(
        async function refetchReports(options: RefetchReportsOptions = {}) {
            if (!selectedProgramId) {
                return;
            }
            if (options.skipIfInFlight && reportsInFlight.current) {
                return;
            }
            reportsInFlight.current = true;
            reportsInFlightCount.current += 1;
            const reqId = ++reportsReqId.current;
            setIsFetchingReports(true);
            try {
                const range = buildReportDateRange(
                    computeRange(dateRangePreset, dateRange.from, dateRange.to),
                );
                const [summaryResponse, eventFeedResponse] = await Promise.all([
                    adminApi.getReportSummary(selectedProgramId, range),
                    adminApi.getEventFeed(selectedProgramId, {
                        range,
                        eventTypes:
                            eventFilters.eventTypes.length > 0
                                ? eventFilters.eventTypes
                                : undefined,
                        translatorId: eventFilters.translatorId || undefined,
                        page: eventPage,
                        pageSize: EVENT_FEED_PAGE_SIZE,
                    }),
                ]);
                if (reportsReqId.current !== reqId) {
                    return;
                }
                setSummary(summaryResponse);
                setEventFeed(eventFeedResponse);
                if (eventFeedResponse.page !== eventPage) {
                    setEventPage(eventFeedResponse.page);
                }
                setError(null);
            } catch (reportsError) {
                if (reportsReqId.current !== reqId) {
                    return;
                }
                if (handleAuthError(reportsError)) {
                    return;
                }
                setError(errorCode(reportsError));
            } finally {
                reportsInFlightCount.current = Math.max(0, reportsInFlightCount.current - 1);
                reportsInFlight.current = reportsInFlightCount.current > 0;
                if (reportsReqId.current === reqId) {
                    setIsFetchingReports(false);
                }
            }
        },
        [
            adminApi,
            selectedProgramId,
            dateRange,
            dateRangePreset,
            eventFilters,
            eventPage,
            handleAuthError,
        ],
    );
    const latestRefetchReports = useRef(refetchReports);

    useEffect(() => {
        latestRefetchReports.current = refetchReports;
    }, [refetchReports]);

    useEffect(() => {
        if (activeSection !== 'reports' || !selectedProgramId) {
            return;
        }
        void refetchReports();
    }, [activeSection, selectedProgramId, refetchReports]);

    useEffect(() => {
        if (loadState !== 'ready' || activeSection !== 'reports' || !selectedProgramId) {
            return;
        }
        let cancelled = false;

        const refreshVisibleReports = () => {
            if (cancelled || document.hidden) {
                return;
            }
            void latestRefetchReports.current({ skipIfInFlight: true });
        };

        const intervalId = window.setInterval(refreshVisibleReports, 20_000);
        const handleVisibilityChange = () => {
            if (!document.hidden) {
                refreshVisibleReports();
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            cancelled = true;
            window.clearInterval(intervalId);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [activeSection, selectedProgramId, loadState]);

    useEffect(() => {
        if (loadState !== 'ready') {
            return;
        }
        if (!slug) {
            suppressRouteLoad.current = false;
            return;
        }

        const targetSection = mapUrlSection(section);
        if (suppressRouteLoad.current) {
            if (detail?.program.slug === slug && activeSection === targetSection) {
                suppressRouteLoad.current = false;
            }
            return;
        }
        if (detail?.program.slug === slug && activeSection === targetSection) {
            return;
        }

        const program = programs.find((candidate) => candidate.slug === slug);
        if (!program) {
            console.warn(`Admin program not found for slug: ${slug}`);
            pendingRouteLoad.current = null;
            setSelectedProgramId(null);
            setDetail(null);
            setActiveSection('programs');
            setError(`Program not found: ${slug}`);
            navigate('/manage', { replace: true });
            return;
        }

        const routeLoadKey = `${program.id}:${targetSection}`;
        if (pendingRouteLoad.current === routeLoadKey) {
            return;
        }
        pendingRouteLoad.current = routeLoadKey;
        void loadDetail(program.id, targetSection);
    }, [programs, slug, section, loadState, detail, activeSection, loadDetail, navigate]);

    async function confirmReadiness(itemId: ConfirmableReadinessItemId) {
        // Viewers are read-only; the confirm buttons are hidden, but guard the
        // mutation here too so a stale/forced call never fires a write that 403s.
        if (!selectedProgramId) {
            return;
        }
        setError(null);
        setPendingReadinessItem(itemId);
        try {
            setReadiness(await adminApi.confirmReadiness(selectedProgramId, itemId));
        } catch (confirmError) {
            setError(errorCode(confirmError));
        } finally {
            setPendingReadinessItem(null);
        }
    }

    async function downloadCsv() {
        if (!selectedProgramId || !detail) {
            return;
        }
        const blob = await adminApi.downloadListenerReportCsv(
            selectedProgramId,
            buildReportQuery(
                reportFilters,
                1,
                computeRange(dateRangePreset, dateRange.from, dateRange.to),
            ),
        );
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${detail.program.slug}-listener-report.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    async function refreshDetail(options: { includeStatus?: boolean } = {}) {
        if (selectedProgramId) {
            const [detailResponse, statusResponse] = await Promise.all([
                adminApi.getProgramDetail(selectedProgramId),
                options.includeStatus
                    ? adminApi.getProgramStatus(selectedProgramId)
                    : Promise.resolve(null),
            ]);
            setDetail(detailResponse);
            if (statusResponse) {
                setStatus(statusResponse);
            }
            if (activeSection === 'reports') {
                await refetchReports();
            }
            setEditForm(editFormFromProgram(detailResponse.program));
        }
    }

    async function refreshStatus() {
        setRefreshing(true);
        try {
            await refreshDetail({ includeStatus: true });
        } catch (statusError) {
            if (handleAuthError(statusError)) {
                return;
            }
            setError(errorCode(statusError));
        } finally {
            setRefreshing(false);
        }
    }

    function backToPrograms() {
        pendingRouteLoad.current = null;
        suppressRouteLoad.current = true;
        navigate('/manage');
        selectedProgramIdRef.current = null;
        setSelectedProgramId(null);
        setDetail(null);
        setActiveSection('programs');
    }

    function sectionLabel(section: string) {
        if (section === 'status') {
            return 'Status';
        }
        if (section === 'streams') {
            return 'Streams';
        }
        if (section === 'translators') {
            return 'Translators';
        }
        if (section === 'share') {
            return 'Share / QR';
        }
        if (section === 'readiness') {
            return 'Readiness';
        }
        if (section === 'reports') {
            return 'Reports';
        }
        return 'Overview';
    }

    function handleDateRangeChange(next: ReportDateRangeValue) {
        setDateRange(next);
        setReportPage(1);
        setEventPage(1);
    }

    function handleDateRangePresetChange(next: ReportDateRangePreset) {
        setDateRangePreset(next);
        setReportPage(1);
        setEventPage(1);
    }

    function focusReportDateRange() {
        const target = reportDateRangeRef.current;
        if (!target) {
            return;
        }
        target.scrollIntoView({ block: 'start', behavior: 'smooth' });
        target.querySelector<HTMLElement>('select, input, button')?.focus();
    }

    function renderSection() {
        if (!detail) {
            return null;
        }

        if (activeSection === 'status') {
            return status ? (
                <StatusPanel
                    status={status}
                    readOnly={false}
                    onRefresh={() => void refreshStatus()}
                    refreshing={refreshing}
                    onKickStream={(stream) => {
                        setKickError(null);
                        setKickedStream(stream);
                    }}
                />
            ) : (
                <p>Loading status…</p>
            );
        }

        if (activeSection === 'streams') {
            return (
                <StreamsPanel
                    readOnly={false}
                    form={streamForm}
                    onChange={setStreamForm}
                    onSubmit={submitStream}
                    streams={detail.streams}
                    onDelete={(stream) => void deleteStream(stream)}
                    onToggle={(stream) => void toggleStream(stream)}
                />
            );
        }

        if (activeSection === 'translators') {
            return (
                <TranslatorsPanel
                    adminApi={adminApi}
                    readOnly={false}
                    onAuthExpired={handleAuthExpired}
                    streams={detail.streams}
                    programId={detail.program.id}
                    translatorUrl={detail.urls.translatorUrl}
                    translators={detail.translators}
                    form={translatorForm}
                    onChange={setTranslatorForm}
                    onSubmit={submitTranslator}
                    onAddAssignment={(translator, stream) => void addAssignment(translator, stream)}
                    onRemoveAssignment={(translator, streamId) =>
                        void removeAssignment(translator, streamId)
                    }
                    onRename={(translator) => void renameTranslator(translator)}
                    onDelete={(translator) => void deleteTranslator(translator)}
                    onResetPassword={(translator) => void resetPassword(translator)}
                />
            );
        }

        if (activeSection === 'share') {
            return <QrPanel detail={detail} />;
        }

        if (activeSection === 'readiness') {
            return (
                <ReadinessPanel
                    readiness={readiness}
                    onConfirm={(itemId) => void confirmReadiness(itemId)}
                    pendingItemId={pendingReadinessItem}
                    readOnly={false}
                />
            );
        }

        if (activeSection === 'reports') {
            const computedRange = computeRange(dateRangePreset, dateRange.from, dateRange.to);
            const rangeActive =
                dateRangePreset !== 'All time' &&
                (dateRangePreset !== 'Custom' || !!computedRange.from || !!computedRange.to);
            const rangeLabel =
                rangeActive && dateRangePreset !== 'Custom'
                    ? dateRangePreset
                    : formatRangeChipLabel(computedRange);
            return (
                <>
                    <div className="admin-report-toolbar" ref={reportDateRangeRef}>
                        <ReportDateRangeControl
                            value={dateRange}
                            preset={dateRangePreset}
                            onChange={handleDateRangeChange}
                            onPresetChange={handleDateRangePresetChange}
                        />
                    </div>
                    <div className="admin-report-meta">
                        <button
                            className="admin-btn-secondary"
                            disabled={refreshing}
                            onClick={() => void refreshStatus()}
                            type="button"
                        >
                            {refreshing ? 'Refreshing…' : 'Refresh events'}
                        </button>
                    </div>
                    <ReportSummaryPanel
                        summary={summary}
                        rangeActive={rangeActive}
                        rangeLabel={rangeLabel}
                        onRangeChipClick={focusReportDateRange}
                        isFetching={isFetchingReports}
                    />
                    <details
                        className="admin-report-accordion"
                        open={eventsOpen}
                        onToggle={(event) => setEventsOpen(event.currentTarget.open)}
                    >
                        <summary
                            aria-controls="admin-recent-events-panel"
                            aria-expanded={eventsOpen}
                            className="admin-session-summary"
                            role="button"
                        >
                            <span className="admin-session-chevron" aria-hidden="true">
                                ▸
                            </span>
                            Recent events
                            <span
                                aria-label={`${eventFeed?.total ?? 0} events`}
                                className={`admin-session-count ${
                                    rangeActive ||
                                    eventFilters.eventTypes.length > 0 ||
                                    eventFilters.translatorId
                                        ? 'admin-session-count--active'
                                        : ''
                                }`}
                            >
                                {eventFeed?.total ?? 0}
                            </span>
                        </summary>
                        <div className="admin-session-panel" id="admin-recent-events-panel">
                            <EventFeedPanel
                                detail={detail}
                                feed={eventFeed}
                                filters={eventFilters}
                                onFilterChange={setEventFilter}
                                onClearFilters={clearEventFilters}
                                page={eventPage}
                                onPageChange={setEventPage}
                                rangeLabel={rangeLabel}
                                onRangeChipClick={focusReportDateRange}
                                isFetching={isFetchingReports}
                            />
                        </div>
                    </details>
                    <details
                        className="admin-report-accordion"
                        open={reportOpen}
                        onToggle={(event) => {
                            const isOpen = event.currentTarget.open;
                            if (isOpen) {
                                void openReport();
                            } else {
                                setReportOpen(false);
                            }
                        }}
                    >
                        <summary
                            aria-controls="admin-listener-report-panel"
                            aria-expanded={reportOpen}
                            className="admin-session-summary"
                            role="button"
                        >
                            <span className="admin-session-chevron" aria-hidden="true">
                                ▸
                            </span>
                            Listener report
                            <span
                                aria-label={
                                    report
                                        ? `${report.total} listener connections`
                                        : 'Listener report not loaded'
                                }
                                className="admin-session-count"
                            >
                                {report?.total ?? '—'}
                            </span>
                            {reportLastLoadedAt ? (
                                <span className="admin-hint">
                                    Last loaded: {formatISTTime(reportLastLoadedAt)}
                                </span>
                            ) : null}
                        </summary>
                        <div className="admin-session-panel" id="admin-listener-report-panel">
                            <ListenerReportPanel
                                detail={detail}
                                report={report}
                                reportOpen={reportOpen}
                                filters={reportFilters}
                                onFilterChange={setReportFilter}
                                onClearFilters={clearReportFilters}
                                page={reportPage}
                                onPageChange={setReportPage}
                                isFetching={reportFetching}
                                onDownloadCsv={() => void downloadCsv()}
                                accessSummary={listenerAccessSummary}
                                accessSummaryFetching={listenerAccessSummaryFetching}
                                onRefreshAccessSummary={() => void refreshListenerAccessSummary()}
                                onRevokeAccess={revokeListenerAccess}
                                readOnly={false}
                                rangeLabel={rangeLabel}
                                onRangeChipClick={focusReportDateRange}
                            />
                        </div>
                    </details>
                </>
            );
        }

        return (
            <>
                <div className="admin-kpi-strip">
                    <KpiTile
                        label="Active listeners"
                        value={status ? String(status.totalActiveListeners) : '—'}
                    />
                    <KpiTile
                        label="Freshness"
                        value={status ? (status.stale ? 'Stale' : 'Fresh') : '—'}
                    />
                    <KpiTile
                        label="Service"
                        value={status ? (status.degraded ? 'Degraded' : 'Normal') : '—'}
                    />
                    <KpiTile
                        label="Server time"
                        value={status ? formatISTTime(status.serverTime) : '—'}
                    />
                </div>
                <ProgramDetailForm
                    form={editForm}
                    readOnly={false}
                    slugLocked={detail.program.status !== 'draft' || !!detail.program.firstLiveAt}
                    onChange={setEditForm}
                    onArchive={() => void archiveSelectedProgram()}
                    onDelete={() => void deleteSelectedProgram()}
                    onSubmit={updateSelectedProgram}
                />
                <VolunteerAccessPanel
                    adminApi={adminApi}
                    onAuthExpired={handleAuthExpired}
                    programId={detail.program.id}
                    readOnly={false}
                />
            </>
        );
    }

    useEffect(() => {
        void loadPrograms();
    }, []);

    async function submitLogin(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError(null);
        try {
            await adminApi.login(loginUsername, loginPassword);
            setLoginUsername('');
            setLoginPassword('');
            await loadPrograms();
        } catch (loginError) {
            setError('Invalid username or password');
        }
    }

    async function submitProgram(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError(null);
        try {
            await adminApi.createProgram({
                slug: programForm.slug,
                name: programForm.name,
                venue: programForm.venue,
                eventDate: programForm.eventDate,
                adminNotes: programForm.adminNotes,
                accessControlEnabled: programForm.accessControlEnabled,
            });
            setProgramForm({
                slug: '',
                name: '',
                venue: '',
                eventDate: '',
                adminNotes: '',
                accessControlEnabled: false,
            });
            await loadPrograms();
        } catch (programError) {
            setError(errorCode(programError));
        }
    }

    async function updateSelectedProgram(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!selectedProgramId) {
            return;
        }
        setError(null);
        // The slug is editable in draft until the program ever becomes live; any row
        // with firstLiveAt set is locked, even if status is back to draft.
        // Only send nextSlug when the persisted program is still a draft, so edits
        // to name/venue/date/status keep working after a program goes live.
        const slugEditable = detail?.program.status === 'draft' && !detail?.program.firstLiveAt;
        try {
            const response = await adminApi.updateProgram(selectedProgramId, {
                name: editForm.name,
                venue: editForm.venue,
                eventDate: editForm.eventDate,
                adminNotes: editForm.adminNotes,
                status: editForm.status,
                accessControlEnabled: editForm.accessControlEnabled,
                ...(slugEditable ? { nextSlug: editForm.nextSlug } : {}),
            });
            setDetail(response);
            setEditForm(editFormFromProgram(response.program));
            setPrograms((current) =>
                current.map((program) =>
                    program.id === response.program.id ? response.program : program,
                ),
            );
        } catch (programError) {
            setError(errorCode(programError));
        }
    }

    async function archiveSelectedProgram() {
        if (!selectedProgramId) {
            return;
        }
        setError(null);
        try {
            const response = await adminApi.archiveProgram(selectedProgramId);
            setDetail(response);
            setEditForm(editFormFromProgram(response.program));
            setPrograms((current) =>
                current.map((program) =>
                    program.id === response.program.id ? response.program : program,
                ),
            );
        } catch (programError) {
            setError(errorCode(programError));
        }
    }

    async function deleteSelectedProgram() {
        if (!selectedProgramId) {
            return;
        }
        const selectedProgram =
            programs.find((program) => program.id === selectedProgramId) ?? detail?.program ?? null;
        const message =
            selectedProgram?.status === 'draft'
                ? 'Delete this draft program permanently?'
                : 'Delete this program? It will be moved to Recently deleted and can be restored for 7 days.';
        if (!window.confirm(message)) {
            return;
        }
        setError(null);
        try {
            await adminApi.deleteProgram(selectedProgramId);
            setSelectedProgramId(null);
            setDetail(null);
            setStatus(null);
            setReport(null);
            setReportLastLoadedAt(null);
            loadedReportQueryKey.current = null;
            setReportOpen(false);
            setEventsOpen(false);
            setSummary(null);
            setEventFeed(null);
            setReadiness(null);
            setPendingReadinessItem(null);
            pendingRouteLoad.current = null;
            suppressRouteLoad.current = true;
            navigate('/manage');
            await loadPrograms();
        } catch (programError) {
            setError(errorCode(programError));
        }
    }

    async function restoreProgram(programId: string) {
        setError(null);
        try {
            await adminApi.restoreProgram(programId);
            await loadPrograms();
        } catch (restoreError) {
            setError(errorCode(restoreError));
        }
    }

    async function submitStream(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!selectedProgramId) {
            return;
        }
        setError(null);
        try {
            await adminApi.createStream(selectedProgramId, {
                languageName: streamForm.languageName,
                languageCode: streamForm.languageCode,
                displayOrder: Number(streamForm.displayOrder),
                isActive: true,
            });
            setStreamForm({ languageName: '', languageCode: '', displayOrder: '0' });
            await refreshDetail({ includeStatus: true });
        } catch (streamError) {
            setError(errorCode(streamError));
        }
    }

    async function toggleStream(stream: AdminStream) {
        if (!selectedProgramId) {
            return;
        }
        setError(null);
        try {
            await adminApi.updateStream(selectedProgramId, stream.id, {
                isActive: !stream.isActive,
            });
            await refreshDetail({ includeStatus: true });
        } catch (streamError) {
            setError(errorCode(streamError));
        }
    }

    async function deleteStream(stream: AdminStream) {
        if (!selectedProgramId) {
            return;
        }
        setError(null);
        try {
            await adminApi.deleteStream(selectedProgramId, stream.id);
            await refreshDetail({ includeStatus: true });
        } catch (streamError) {
            setError(errorCode(streamError));
        }
    }

    async function submitTranslator(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!selectedProgramId) {
            return;
        }
        setError(null);
        try {
            await adminApi.createTranslator(selectedProgramId, {
                email: translatorForm.email,
                name: translatorForm.name,
                password: translatorForm.password,
            });
            setTranslatorForm({ email: '', name: '', password: '' });
            await refreshDetail();
        } catch (translatorError) {
            setError(errorCode(translatorError));
        }
    }

    async function addAssignment(translator: AdminTranslator, stream: AdminStream) {
        if (!selectedProgramId) {
            return;
        }
        setError(null);
        try {
            await adminApi.addTranslatorAssignment(selectedProgramId, translator.id, stream.id);
            await refreshDetail();
        } catch (assignmentError) {
            setError(errorCode(assignmentError));
        }
    }

    async function renameTranslator(translator: AdminTranslator) {
        if (!selectedProgramId) {
            return;
        }
        const name = window.prompt(`New name for ${translator.name}`, translator.name);
        if (!name) {
            return;
        }
        setError(null);
        try {
            await adminApi.updateTranslator(selectedProgramId, translator.id, {
                name,
            });
            await refreshDetail();
        } catch (translatorError) {
            setError(errorCode(translatorError));
        }
    }

    async function deleteTranslator(translator: AdminTranslator) {
        if (!selectedProgramId) {
            return;
        }
        setError(null);
        try {
            await adminApi.deleteTranslator(selectedProgramId, translator.id);
            await refreshDetail();
        } catch (translatorError) {
            setError(errorCode(translatorError));
        }
    }

    async function removeAssignment(translator: AdminTranslator, assignmentStreamId: string) {
        if (!selectedProgramId) {
            return;
        }
        setError(null);
        try {
            await adminApi.removeTranslatorAssignment(
                selectedProgramId,
                translator.id,
                assignmentStreamId,
            );
            await refreshDetail();
        } catch (assignmentError) {
            setError(errorCode(assignmentError));
        }
    }

    async function resetPassword(translator: AdminTranslator) {
        if (!selectedProgramId) {
            return;
        }
        const password = window.prompt(`New password for ${translator.name}`);
        if (!password) {
            return;
        }
        setError(null);
        try {
            await adminApi.resetTranslatorPassword(selectedProgramId, translator.id, password);
            await refreshDetail();
        } catch (passwordError) {
            setError(errorCode(passwordError));
        }
    }

    async function openReport() {
        if (!selectedProgramId) {
            return;
        }
        setReportOpen(true);
        setError(null);
        void refreshListenerAccessSummary();
    }

    async function refreshListenerAccessSummary() {
        if (!selectedProgramId) {
            return;
        }
        const programId = selectedProgramId;
        const requestId = ++listenerAccessSummaryReqId.current;
        setListenerAccessSummaryFetching(true);
        try {
            const response = await adminApi.getListenerAccessSummary(programId);
            if (
                selectedProgramIdRef.current !== programId ||
                listenerAccessSummaryReqId.current !== requestId
            ) {
                return;
            }
            setListenerAccessSummary(response);
        } catch (summaryError) {
            if (
                selectedProgramIdRef.current !== programId ||
                listenerAccessSummaryReqId.current !== requestId
            ) {
                return;
            }
            if (handleAuthError(summaryError)) {
                return;
            }
            setError(errorCode(summaryError));
        } finally {
            if (
                selectedProgramIdRef.current === programId &&
                listenerAccessSummaryReqId.current === requestId
            ) {
                setListenerAccessSummaryFetching(false);
            }
        }
    }

    async function revokeListenerAccess(clientId: string) {
        if (!selectedProgramId) {
            return;
        }

        try {
            await adminApi.revokeListenerAccess(selectedProgramId, clientId);
            const query = buildReportQuery(
                reportFilters,
                reportPage,
                computeRange(dateRangePreset, dateRange.from, dateRange.to),
            );
            const [accessSummaryResponse, reportResponse] = await Promise.all([
                adminApi.getListenerAccessSummary(selectedProgramId),
                adminApi.getListenerReport(selectedProgramId, query),
            ]);
            setListenerAccessSummary(accessSummaryResponse);
            setReport(reportResponse);
            setReportLastLoadedAt(new Date().toISOString());
            loadedReportQueryKey.current = buildListenerReportKey(
                selectedProgramId,
                query,
                dateRangePreset,
                dateRange,
            );
            if (reportResponse.page !== reportPage) {
                setReportPage(reportResponse.page);
            }
            setError(null);
        } catch (revokeError) {
            if (!handleAuthError(revokeError)) {
                setError(errorCode(revokeError));
            }
            throw revokeError;
        }
    }

    function setReportFilter(partial: Partial<ReportFiltersState>) {
        setReportFilters((prev) => ({ ...prev, ...partial }));
        setReportPage(1);
    }

    function clearReportFilters() {
        setReportFilters(EMPTY_REPORT_FILTERS);
        setReportPage(1);
    }

    function setEventFilter(partial: Partial<EventFiltersState>) {
        setEventFilters((prev) => ({ ...prev, ...partial }));
        setEventPage(1);
    }

    function clearEventFilters() {
        setEventFilters(EMPTY_EVENT_FILTERS);
        setEventPage(1);
    }

    useEffect(() => {
        if (loadState !== 'ready' || !reportOpen || !selectedProgramId) return;
        const query = buildReportQuery(
            reportFilters,
            reportPage,
            computeRange(dateRangePreset, dateRange.from, dateRange.to),
        );
        const queryKey = buildListenerReportKey(
            selectedProgramId,
            query,
            dateRangePreset,
            dateRange,
        );
        if (loadedReportQueryKey.current === queryKey) return;
        let cancelled = false;
        setReportFetching(true);
        adminApi
            .getListenerReport(selectedProgramId, query)
            .then((r) => {
                if (cancelled) return;
                setReport(r);
                setReportLastLoadedAt(new Date().toISOString());
                loadedReportQueryKey.current = queryKey;
                if (r.page !== reportPage) setReportPage(r.page);
            })
            .catch((reportError) => {
                if (cancelled) return;
                if (handleAuthError(reportError)) return;
                setError(errorCode(reportError));
            })
            .finally(() => {
                if (!cancelled) setReportFetching(false);
            });
        return () => {
            cancelled = true;
        };
    }, [
        reportOpen,
        selectedProgramId,
        reportFilters,
        reportPage,
        dateRange,
        dateRangePreset,
        loadState,
        adminApi,
        handleAuthError,
    ]);

    async function handleKickPublisher(signOut: boolean) {
        if (!selectedProgramId || !kickedStream) {
            return;
        }
        setKickError(null);
        setKickPending(true);
        try {
            const result = await adminApi.kickPublisher?.(
                selectedProgramId,
                kickedStream.id,
                signOut,
            );
            if (!result) {
                throw new Error('Kick publisher action is unavailable.');
            }
            setKickedStream(null);
            await refreshDetail({ includeStatus: true });
        } catch (kickActionError) {
            setKickError(errorCode(kickActionError));
        } finally {
            setKickPending(false);
        }
    }

    function closeKickDialog() {
        setKickedStream(null);
        setKickError(null);
    }

    return (
        <main aria-label="Management workspace" className="shell shell-admin admin-screen">
            {error ? (
                <p className="admin-alert" role="alert">
                    {error}
                </p>
            ) : null}

            {loadState === 'checking' ? <p>Checking management access...</p> : null}
            {loadState === 'login' ? (
                <form className="admin-panel admin-login" onSubmit={submitLogin}>
                    <h2>Management login</h2>
                    <label>
                        Username
                        <input
                            autoComplete="username"
                            onChange={(event) => setLoginUsername(event.target.value)}
                            required
                            type="text"
                            value={loginUsername}
                        />
                    </label>
                    <label>
                        Management password
                        <input
                            autoComplete="current-password"
                            required
                            onChange={(event) => setLoginPassword(event.target.value)}
                            type="password"
                            value={loginPassword}
                        />
                    </label>
                    <button type="submit">Log in</button>
                </form>
            ) : null}
            {loadState === 'error' ? (
                <button onClick={() => void loadPrograms()} type="button">
                    Retry
                </button>
            ) : null}
            {loadState === 'ready' ? (
                <>
                    {detail === null ? (
                        <AdminLayout
                            sidebar={
                                <SidebarApp
                                    activeSection={
                                        activeSection === 'programs' ||
                                        activeSection === 'deleted' ||
                                        activeSection === 'users' ||
                                        activeSection === 'account'
                                            ? activeSection
                                            : 'programs'
                                    }
                                    onNavigate={setActiveSection}
                                    {...(identity ? { role: identity.role } : {})}
                                />
                            }
                        >
                            <TopBar crumbs={['Programs']} action={null} />
                            <div className="admin-content">
                                {activeSection === 'deleted' ? (
                                    <section
                                        aria-label="Recently deleted"
                                        className="admin-section"
                                    >
                                        <div className="admin-section-head">
                                            <h2>Recently deleted</h2>
                                        </div>
                                        <DeletedProgramList
                                            programs={deletedPrograms}
                                            onRestore={(programId: string) => {
                                                void restoreProgram(programId);
                                            }}
                                        />
                                    </section>
                                ) : activeSection === 'users' && identity?.role === 'admin' ? (
                                    <UsersPanel adminApi={adminApi} />
                                ) : activeSection === 'account' ? (
                                    <AccountPanel
                                        adminApi={adminApi}
                                        username={identity?.username}
                                        onSignOut={handleSignOut}
                                    />
                                ) : (
                                    <section aria-label="Programs" className="admin-section">
                                        <div className="admin-section-head">
                                            <h2>Programs</h2>
                                        </div>
                                        <ProgramCreateForm
                                            form={programForm}
                                            onChange={setProgramForm}
                                            onSubmit={submitProgram}
                                            readOnly={false}
                                        />
                                        <ProgramList
                                            programs={programs}
                                            onOpen={(program) =>
                                                navigate(adminProgramPath(program.slug))
                                            }
                                        />
                                    </section>
                                )}
                            </div>
                        </AdminLayout>
                    ) : (
                        <AdminLayout
                            sidebar={
                                <Sidebar
                                    programName={detail.program.name}
                                    activeSection={activeSection}
                                    onNavigate={(nextSection) => {
                                        suppressRouteLoad.current = true;
                                        setActiveSection(nextSection);
                                        navigate(
                                            adminProgramPath(detail.program.slug, nextSection),
                                        );
                                    }}
                                    onBack={backToPrograms}
                                />
                            }
                        >
                            <TopBar
                                crumbs={[
                                    'Programs',
                                    detail.program.name,
                                    sectionLabel(activeSection),
                                ]}
                                action={null}
                            />
                            <div className="admin-content">{renderSection()}</div>
                        </AdminLayout>
                    )}
                    <KickConfirmDialog
                        open={kickedStream !== null}
                        onClose={closeKickDialog}
                        onConfirm={handleKickPublisher}
                        title={
                            kickedStream ? `End the ${kickedStream.languageName} broadcast?` : ''
                        }
                        listenerImpactLine={
                            kickedStream
                                ? `${kickedStream.languageName} has ${kickedStream.activeListeners} active listener${kickedStream.activeListeners === 1 ? '' : 's'}. They'll keep hearing silence — the stream stays connected.`
                                : ''
                        }
                        pending={kickPending}
                        error={kickError}
                    />
                </>
            ) : null}
        </main>
    );
}

function ProgramCreateForm({
    form,
    onChange,
    onSubmit,
    readOnly,
}: {
    form: {
        slug: string;
        name: string;
        venue: string;
        eventDate: string;
        adminNotes: string;
        accessControlEnabled: boolean;
    };
    onChange: (form: {
        slug: string;
        name: string;
        venue: string;
        eventDate: string;
        adminNotes: string;
        accessControlEnabled: boolean;
    }) => void;
    onSubmit: (event: FormEvent<HTMLFormElement>) => void;
    readOnly: boolean;
}) {
    if (readOnly) {
        return null;
    }

    return (
        <Paper p="lg" radius="md" withBorder>
            <form onSubmit={onSubmit}>
                <Stack gap="md">
                    <div>
                        <Title order={3}>Create program</Title>
                        <Text c="dimmed" size="sm">
                            Set up the event before adding language streams and translators.
                        </Text>
                    </div>
                    <Checkbox
                        aria-label="Require listener approval before they can listen"
                        checked={form.accessControlEnabled}
                        description="Listeners must be approved by a volunteer before they can listen"
                        label="Require listener approval"
                        onChange={(event) =>
                            onChange({
                                ...form,
                                accessControlEnabled: event.currentTarget.checked,
                            })
                        }
                    />
                    <SimpleGrid cols={{ base: 1, sm: 2 }}>
                        <TextInput
                            label="Program name"
                            onChange={(event) => onChange({ ...form, name: event.target.value })}
                            value={form.name}
                        />
                        <TextInput
                            label="Program slug"
                            onChange={(event) => onChange({ ...form, slug: event.target.value })}
                            value={form.slug}
                        />
                        <TextInput
                            label="Program venue"
                            onChange={(event) => onChange({ ...form, venue: event.target.value })}
                            value={form.venue}
                        />
                        <TextInput
                            label="Program date"
                            onChange={(event) =>
                                onChange({ ...form, eventDate: event.target.value })
                            }
                            type="date"
                            value={form.eventDate}
                        />
                    </SimpleGrid>
                    <Textarea
                        label="Admin notes"
                        onChange={(event) => onChange({ ...form, adminNotes: event.target.value })}
                        value={form.adminNotes}
                    />
                    <Group justify="flex-end">
                        <Button type="submit">Create program</Button>
                    </Group>
                </Stack>
            </form>
        </Paper>
    );
}

function ProgramList({
    programs,
    onOpen,
}: {
    programs: AdminProgram[];
    onOpen: (program: AdminProgram) => void;
}) {
    if (programs.length === 0) {
        return <p>No programs yet.</p>;
    }

    return (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
            {programs.map((program) => {
                function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onOpen(program);
                    }
                }

                return (
                    <Paper
                        className="admin-card admin-card-clickable"
                        component="article"
                        key={program.id}
                        onClick={() => onOpen(program)}
                        onKeyDown={handleKeyDown}
                        p="lg"
                        radius="md"
                        role="button"
                        tabIndex={0}
                        withBorder
                    >
                        <Stack gap="xs">
                            <Title order={3} size="h4">
                                {program.name}
                            </Title>
                            <Text c="dimmed" size="sm">
                                {program.venue}
                            </Text>
                            <Text c="dimmed" size="sm">
                                {program.eventDate}
                            </Text>
                            <StatusPill tone={program.status}>
                                {program.status.toUpperCase()}
                            </StatusPill>
                            <Text className="admin-card-url" size="xs">
                                {urlForProgram(program.slug)}
                            </Text>
                            <Text className="admin-card-url" size="xs">
                                {urlForProgram(program.slug, '/translate')}
                            </Text>
                        </Stack>
                    </Paper>
                );
            })}
        </SimpleGrid>
    );
}

function DeletedProgramList({
    programs,
    onRestore,
}: {
    programs: AdminProgram[];
    onRestore?: (programId: string) => void;
}) {
    if (programs.length === 0) {
        return <p>No recently deleted programs.</p>;
    }

    return (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
            {programs.map((program) => (
                <Paper className="admin-card" key={program.id} p="lg" radius="md" withBorder>
                    <Stack gap="xs">
                        <Title order={3} size="h4">
                            {program.name}
                        </Title>
                        <Text c="dimmed" size="sm">
                            {program.venue}
                        </Text>
                        <Text c="dimmed" size="sm">
                            {program.eventDate}
                        </Text>
                    </Stack>
                    {onRestore ? (
                        <Button mt="md" onClick={() => onRestore(program.id)} type="button">
                            Restore
                        </Button>
                    ) : null}
                </Paper>
            ))}
        </SimpleGrid>
    );
}

function ProgramDetailForm({
    form,
    slugLocked,
    onChange,
    onArchive,
    onDelete,
    onSubmit,
    readOnly,
}: {
    form: {
        name: string;
        venue: string;
        eventDate: string;
        adminNotes: string;
        status: ProgramStatus;
        nextSlug: string;
        accessControlEnabled: boolean;
    };
    slugLocked: boolean;
    onChange: (form: {
        name: string;
        venue: string;
        eventDate: string;
        adminNotes: string;
        status: ProgramStatus;
        nextSlug: string;
        accessControlEnabled: boolean;
    }) => void;
    onArchive: () => void;
    onDelete: () => void;
    onSubmit: (event: FormEvent<HTMLFormElement>) => void;
    readOnly: boolean;
}) {
    return (
        <div className="admin-card">
            <form className="admin-form" onSubmit={onSubmit}>
                <h2>Program detail</h2>
                <label className="admin-access-toggle">
                    <input
                        aria-describedby="edit-listener-approval-hint"
                        checked={form.accessControlEnabled}
                        disabled={readOnly}
                        onChange={(event) =>
                            onChange({
                                ...form,
                                accessControlEnabled: event.target.checked,
                            })
                        }
                        type="checkbox"
                    />
                    <span className="admin-access-toggle-copy">
                        <strong>Require listener approval</strong>
                        <span className="admin-hint" id="edit-listener-approval-hint">
                            Listeners must be approved by a volunteer before they can listen
                        </span>
                    </span>
                </label>
                <label>
                    Detail program name
                    <input
                        disabled={readOnly}
                        onChange={(event) => onChange({ ...form, name: event.target.value })}
                        value={form.name}
                    />
                </label>
                <label>
                    Detail venue
                    <input
                        disabled={readOnly}
                        onChange={(event) => onChange({ ...form, venue: event.target.value })}
                        value={form.venue}
                    />
                </label>
                <label>
                    Detail date
                    <input
                        onChange={(event) => onChange({ ...form, eventDate: event.target.value })}
                        disabled={readOnly}
                        type="date"
                        value={form.eventDate}
                    />
                </label>
                <label>
                    Next slug
                    <input
                        aria-describedby={slugLocked ? 'next-slug-hint' : undefined}
                        disabled={readOnly || slugLocked}
                        onChange={(event) => onChange({ ...form, nextSlug: event.target.value })}
                        value={form.nextSlug}
                    />
                </label>
                {slugLocked ? (
                    <p className="admin-hint" id="next-slug-hint">
                        Slug is locked once the program leaves draft.
                    </p>
                ) : null}
                <label>
                    Detail status
                    <select
                        disabled={readOnly}
                        onChange={(event) =>
                            onChange({ ...form, status: event.target.value as ProgramStatus })
                        }
                        value={form.status}
                    >
                        <option value="draft">draft</option>
                        <option value="live">live</option>
                        <option value="archived">archived</option>
                    </select>
                </label>
                <label>
                    Detail notes
                    <textarea
                        disabled={readOnly}
                        onChange={(event) => onChange({ ...form, adminNotes: event.target.value })}
                        value={form.adminNotes}
                    />
                </label>
                {readOnly ? null : (
                    <>
                        <div className="admin-actions">
                            <button type="submit">Update program</button>
                        </div>
                        <div className="admin-danger-zone">
                            <h3>Danger zone</h3>
                            <button onClick={onArchive} type="button">
                                Archive program
                            </button>
                            <button onClick={onDelete} type="button">
                                Delete program
                            </button>
                        </div>
                    </>
                )}
            </form>
        </div>
    );
}

const VOLUNTEER_PASSWORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function generatedVolunteerPassword(): string {
    const bytes = new Uint8Array(10);
    crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => VOLUNTEER_PASSWORD_ALPHABET[byte & 31]).join('');
}

function VolunteerAccessPanel({
    adminApi,
    programId,
    readOnly,
    onAuthExpired,
}: {
    adminApi: AdminApi;
    programId: string;
    readOnly: boolean;
    onAuthExpired: () => void;
}) {
    const [access, setAccess] = useState<AdminProgramVolunteerAccess | null>(null);
    const [loginId, setLoginId] = useState('');
    const [password, setPassword] = useState('');
    const [pending, setPending] = useState(false);
    const [panelError, setPanelError] = useState<string | null>(null);
    const [shownPassword, setShownPassword] = useState<string | null>(null);
    const currentProgramId = useRef(programId);
    currentProgramId.current = programId;

    useEffect(() => {
        let cancelled = false;
        setAccess(null);
        setLoginId('');
        setPassword('');
        setPending(false);
        setPanelError(null);
        setShownPassword(null);

        void adminApi
            .getVolunteerAccess(programId)
            .then((response) => {
                if (cancelled) return;
                setAccess(response);
                setLoginId(response.loginId ?? '');
            })
            .catch((loadError: unknown) => {
                if (cancelled) return;
                if (isAuthRequired(loadError)) {
                    onAuthExpired();
                    return;
                }
                setPanelError(errorCode(loadError));
            });

        return () => {
            cancelled = true;
        };
    }, [adminApi, onAuthExpired, programId]);

    async function save(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (readOnly || pending || loginId.trim().length === 0) return;

        const submittedProgramId = programId;
        const submittedPassword = password;
        setPending(true);
        setPanelError(null);
        try {
            const response = await adminApi.updateVolunteerAccess(programId, {
                loginId: loginId.trim(),
                ...(submittedPassword ? { password: submittedPassword } : {}),
            });
            if (currentProgramId.current !== submittedProgramId) return;
            setAccess(response);
            setLoginId(response.loginId ?? '');
            setPassword('');
            const passwordToShow = response.generatedPassword ?? submittedPassword;
            if (passwordToShow) {
                setShownPassword(passwordToShow);
            }
        } catch (saveError) {
            if (isAuthRequired(saveError)) {
                onAuthExpired();
                return;
            }
            if (currentProgramId.current !== submittedProgramId) return;
            setPanelError(errorCode(saveError));
        } finally {
            if (currentProgramId.current === submittedProgramId) {
                setPending(false);
            }
        }
    }

    return (
        <section aria-label="Volunteer access" className="admin-subsection">
            <div className="admin-subsection-head">
                <div>
                    <h2>Volunteer access</h2>
                    <p className="admin-hint">
                        Shared credentials for event volunteers who approve listener access.
                    </p>
                </div>
            </div>
            {access ? (
                <form className="admin-card admin-form" onSubmit={save}>
                    <div className="admin-kpi" aria-label="Active volunteer sessions">
                        <span className="admin-kpi-value">
                            {access.activeSessionCount} active sessions
                        </span>
                        <span className="admin-kpi-label">Volunteer sessions</span>
                    </div>
                    <label>
                        Volunteer login ID
                        <input
                            autoComplete="username"
                            disabled={readOnly || pending}
                            onChange={(event) => setLoginId(event.target.value)}
                            required
                            value={loginId}
                        />
                    </label>
                    <label>
                        Volunteer password
                        <input
                            autoComplete="new-password"
                            disabled={readOnly || pending}
                            minLength={8}
                            onChange={(event) => setPassword(event.target.value)}
                            placeholder={
                                access.configured
                                    ? 'Leave blank to generate a new password'
                                    : 'Leave blank to generate'
                            }
                            type="password"
                            value={password}
                        />
                    </label>
                    {access.passwordUpdatedAt ? (
                        <p className="admin-hint">
                            Password last updated {formatISTDateTime(access.passwordUpdatedAt)}
                        </p>
                    ) : null}
                    <p className="admin-alert">Saving changes resets all volunteer sessions.</p>
                    {panelError ? <p className="admin-alert">{panelError}</p> : null}
                    {readOnly ? null : (
                        <div className="admin-actions">
                            <button
                                className="admin-btn-secondary"
                                disabled={pending}
                                onClick={() => setPassword(generatedVolunteerPassword())}
                                type="button"
                            >
                                Generate
                            </button>
                            <button disabled={pending || loginId.trim().length === 0} type="submit">
                                {pending ? 'Saving…' : 'Save volunteer access'}
                            </button>
                        </div>
                    )}
                </form>
            ) : panelError ? (
                <p className="admin-alert">{panelError}</p>
            ) : (
                <p>Loading volunteer access…</p>
            )}
            <VolunteerPasswordOnceDialog
                onClose={() => setShownPassword(null)}
                password={shownPassword}
            />
        </section>
    );
}

function VolunteerPasswordOnceDialog({
    password,
    onClose,
}: {
    password: string | null;
    onClose: () => void;
}) {
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (password) setCopied(false);
    }, [password]);

    if (!password) return null;
    const visiblePassword = password;

    async function copyPassword() {
        await navigator.clipboard.writeText(visiblePassword);
        setCopied(true);
    }

    return (
        <AdminDialog onClose={onClose} open title="Volunteer password">
            <div className="admin-card">
                <p>You won't be able to see it again.</p>
                <code>{visiblePassword}</code>
                <div className="admin-actions">
                    <button onClick={() => void copyPassword()} type="button">
                        Copy password
                    </button>
                    <button onClick={onClose} type="button">
                        Done
                    </button>
                </div>
                <span aria-live="polite" role="status">
                    {copied ? 'Copied' : ''}
                </span>
            </div>
        </AdminDialog>
    );
}

function QrCard({ title, value, filename }: { title: string; value: string; filename: string }) {
    const qrRef = useRef<HTMLDivElement | null>(null);

    function currentQrSvg(): string {
        const svg = qrRef.current?.querySelector('svg');
        if (!svg) {
            return '';
        }
        return new XMLSerializer().serializeToString(svg);
    }

    function downloadQr() {
        const svg = currentQrSvg();
        const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    }

    function printQr() {
        const popup = window.open('', `admin-${filename}`, 'width=420,height=520');
        if (!popup) {
            return;
        }
        const svg = currentQrSvg();
        popup.document.write(`<html><body><p>${escapeHtml(value)}</p>${svg}</body></html>`);
        popup.document.close();
        popup.focus();
        popup.print();
    }

    return (
        <div className="admin-card" ref={qrRef}>
            <h3>{title}</h3>
            <QRCodeSVG
                aria-label={title}
                className="admin-qr"
                marginSize={4}
                size={192}
                title={value}
                value={value}
            />
            <p className="admin-card-url">{value}</p>
            <div className="admin-actions">
                <button className="admin-btn-secondary" onClick={downloadQr} type="button">
                    Download QR SVG
                </button>
                <button className="admin-btn-secondary" onClick={printQr} type="button">
                    Print QR
                </button>
            </div>
        </div>
    );
}

function QrPanel({ detail }: { detail: AdminProgramDetail }) {
    return (
        <section aria-label="Share QR" className="admin-subsection">
            <h2>Share / QR</h2>
            <div className="admin-card-grid">
                <QrCard
                    filename={svgFilename(detail.suggestedQrFilename)}
                    title="Listener QR"
                    value={detail.qrPayload}
                />
                <QrCard
                    filename={translatorSvgFilename(detail.suggestedQrFilename)}
                    title="Translator QR"
                    value={detail.urls.translatorUrl}
                />
                <QrCard
                    filename={volunteerSvgFilename(detail.suggestedQrFilename)}
                    title="Volunteer QR"
                    value={detail.urls.volunteerUrl}
                />
            </div>
        </section>
    );
}

function adminStreamStateLabel(state: 'live' | 'silent' | 'offline'): string {
    if (state === 'live') {
        return 'Live';
    }
    if (state === 'silent') {
        return 'Silent';
    }
    return 'Offline';
}

function StatusPanel({
    status,
    onRefresh,
    refreshing,
    onKickStream,
    readOnly,
}: {
    status: AdminProgramStatus;
    onRefresh: () => void;
    refreshing: boolean;
    onKickStream: (stream: AdminProgramStatus['streams'][number]) => void;
    readOnly: boolean;
}) {
    return (
        <section aria-label="Listener counts" className="admin-subsection">
            <div className="admin-subsection-head">
                <h2>Listener counts</h2>
                <button
                    className="admin-btn-secondary"
                    disabled={refreshing}
                    onClick={onRefresh}
                    type="button"
                >
                    {refreshing ? 'Refreshing…' : 'Refresh'}
                </button>
            </div>
            <div className="admin-kpi-strip">
                <KpiTile label="Total" value={status.totalActiveListeners.toString()} />
                <KpiTile label="Freshness" value={status.stale ? 'Stale' : 'Fresh'} />
                <KpiTile label="Service" value={status.degraded ? 'Degraded' : 'Normal'} />
                <KpiTile
                    label="Updated"
                    value={status.updatedAt ? formatISTDateTime(status.updatedAt) : 'Not available'}
                />
                <KpiTile label="Server time" value={formatISTTime(status.serverTime)} />
            </div>
            <table className="admin-table">
                <thead>
                    <tr>
                        <th>Language</th>
                        <th>State</th>
                        <th>Count</th>
                        {readOnly ? null : <th>Kick</th>}
                    </tr>
                </thead>
                <tbody>
                    {status.streams.map((stream) => (
                        <tr key={stream.id}>
                            <td>{stream.languageName}</td>
                            <td>
                                <StatusPill tone={stream.state}>
                                    {adminStreamStateLabel(stream.state).toUpperCase()}
                                </StatusPill>
                            </td>
                            <td>{stream.activeListeners}</td>
                            {readOnly ? null : (
                                <td>
                                    {stream.state === 'live' ? (
                                        <button
                                            className="admin-link-danger"
                                            onClick={() => onKickStream(stream)}
                                            type="button"
                                        >
                                            Kick publisher
                                        </button>
                                    ) : (
                                        '—'
                                    )}
                                </td>
                            )}
                        </tr>
                    ))}
                </tbody>
            </table>
        </section>
    );
}

function StreamsPanel({
    form,
    streams,
    onChange,
    onSubmit,
    onDelete,
    onToggle,
    readOnly,
}: {
    form: { languageName: string; languageCode: string; displayOrder: string };
    streams: AdminStream[];
    onChange: (form: { languageName: string; languageCode: string; displayOrder: string }) => void;
    onSubmit: (event: FormEvent<HTMLFormElement>) => void;
    onDelete: (stream: AdminStream) => void;
    onToggle: (stream: AdminStream) => void;
    readOnly: boolean;
}) {
    return (
        <section className="admin-subsection">
            <h2>Streams</h2>
            {readOnly ? null : (
                <section className="admin-card">
                    <form className="admin-form admin-inline-form" onSubmit={onSubmit}>
                        <label>
                            Stream language
                            <select
                                aria-label="Stream language"
                                onChange={(event) => {
                                    const languageCode = event.target.value;
                                    onChange({
                                        ...form,
                                        languageCode,
                                        languageName: getLanguageName(languageCode) ?? '',
                                    });
                                }}
                                required
                                value={form.languageCode}
                            >
                                <option disabled value="">
                                    Select language
                                </option>
                                <optgroup label="Indian">
                                    {SUPPORTED_LANGUAGES.filter(
                                        (language) => language.region === 'Indian',
                                    ).map((language) => (
                                        <option key={language.code} value={language.code}>
                                            {language.name} ({language.code})
                                        </option>
                                    ))}
                                </optgroup>
                                <optgroup label="European">
                                    {SUPPORTED_LANGUAGES.filter(
                                        (language) => language.region === 'European',
                                    ).map((language) => (
                                        <option key={language.code} value={language.code}>
                                            {language.name} ({language.code})
                                        </option>
                                    ))}
                                </optgroup>
                                <optgroup label="East Asian">
                                    {SUPPORTED_LANGUAGES.filter(
                                        (language) => language.region === 'East Asian',
                                    ).map((language) => (
                                        <option key={language.code} value={language.code}>
                                            {language.name} ({language.code})
                                        </option>
                                    ))}
                                </optgroup>
                                <optgroup label="Southeast Asian">
                                    {SUPPORTED_LANGUAGES.filter(
                                        (language) => language.region === 'Southeast Asian',
                                    ).map((language) => (
                                        <option key={language.code} value={language.code}>
                                            {language.name} ({language.code})
                                        </option>
                                    ))}
                                </optgroup>
                            </select>
                        </label>
                        <label>
                            Stream display order
                            <input
                                onChange={(event) =>
                                    onChange({ ...form, displayOrder: event.target.value })
                                }
                                type="number"
                                value={form.displayOrder}
                            />
                        </label>
                        <button disabled={!form.languageCode} type="submit">
                            Create stream
                        </button>
                    </form>
                </section>
            )}
            <table className="admin-table">
                <thead>
                    <tr>
                        <th>Language</th>
                        <th>Order</th>
                        {readOnly ? null : <th>Active</th>}
                        {readOnly ? null : <th>Delete</th>}
                    </tr>
                </thead>
                <tbody>
                    {streams.map((stream) => (
                        <tr key={stream.id}>
                            <td>
                                {stream.languageName} ({stream.languageCode})
                            </td>
                            <td>{stream.displayOrder ?? ''}</td>
                            {readOnly ? null : (
                                <td>
                                    <button
                                        className="admin-toggle-btn"
                                        onClick={() => onToggle(stream)}
                                        type="button"
                                    >
                                        {stream.isActive ? 'Deactivate' : 'Activate'}{' '}
                                        {stream.languageName}
                                    </button>
                                </td>
                            )}
                            {readOnly ? null : (
                                <td>
                                    <button
                                        className="admin-link-danger"
                                        onClick={() => onDelete(stream)}
                                        type="button"
                                    >
                                        Delete {stream.languageName} stream
                                    </button>
                                </td>
                            )}
                        </tr>
                    ))}
                </tbody>
            </table>
        </section>
    );
}

function TranslatorsPanel({
    adminApi,
    onAuthExpired,
    programId,
    translatorUrl,
    streams,
    translators,
    form,
    onChange,
    onSubmit,
    onAddAssignment,
    onRemoveAssignment,
    onRename,
    onDelete,
    onResetPassword,
    readOnly,
}: {
    streams: AdminStream[];
    translators: AdminTranslator[];
    adminApi: AdminApi;
    onAuthExpired: () => void;
    programId: string;
    translatorUrl: string;
    form: { email: string; name: string; password: string };
    onChange: (form: { email: string; name: string; password: string }) => void;
    onSubmit: (event: FormEvent<HTMLFormElement>) => void;
    onAddAssignment: (translator: AdminTranslator, stream: AdminStream) => void;
    onRemoveAssignment: (translator: AdminTranslator, streamId: string) => void;
    onRename: (translator: AdminTranslator) => void;
    onDelete: (translator: AdminTranslator) => void;
    onResetPassword: (translator: AdminTranslator) => void;
    readOnly: boolean;
}) {
    const [expandedTranslators, setExpandedTranslators] = useState<Record<string, boolean>>({});
    const [sessionStateByTranslator, setSessionStateByTranslator] = useState<
        Record<string, TranslatorSessionState>
    >({});
    const [endConfirm, setEndConfirm] = useState<EndSessionConfirmState | null>(null);
    const [endConfirmPending, setEndConfirmPending] = useState(false);
    const [endConfirmError, setEndConfirmError] = useState<string | null>(null);
    const isMountedRef = useRef(true);
    const pollIntervals = useRef<Record<string, ReturnType<typeof setInterval>>>({});
    const setTranslatorSessionState = useCallback(
        (
            translatorId: string,
            update: (previous: TranslatorSessionState) => TranslatorSessionState,
        ) => {
            if (!isMountedRef.current) {
                return;
            }
            setSessionStateByTranslator((previous) => ({
                ...previous,
                [translatorId]: update(
                    previous[translatorId] ?? {
                        sessions: [],
                        loading: false,
                        error: false,
                        updatedAt: null,
                    },
                ),
            }));
        },
        [],
    );
    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    const fetchSessions = useCallback(
        async (translatorId: string) => {
            if (!isMountedRef.current) {
                return;
            }
            setTranslatorSessionState(translatorId, (previous) => ({
                ...previous,
                loading: true,
                error: false,
            }));

            if (!adminApi.getTranslatorSessions) {
                setTranslatorSessionState(translatorId, (previous) => ({
                    ...previous,
                    loading: false,
                    error: true,
                }));
                return;
            }

            try {
                const response = await adminApi.getTranslatorSessions(programId, translatorId);
                if (!isMountedRef.current) {
                    return;
                }
                setTranslatorSessionState(translatorId, () => ({
                    sessions: response.sessions,
                    loading: false,
                    error: false,
                    updatedAt: Date.now(),
                }));
            } catch (sessionError) {
                if (!isMountedRef.current) {
                    return;
                }
                if (isAuthRequired(sessionError)) {
                    onAuthExpired();
                    return;
                }
                setTranslatorSessionState(translatorId, (previous) => ({
                    ...previous,
                    loading: false,
                    error: true,
                }));
            }
        },
        [adminApi, onAuthExpired, programId, setTranslatorSessionState],
    );

    const stopTranslatorPoll = useCallback((translatorId: string) => {
        const interval = pollIntervals.current[translatorId];
        if (interval != null) {
            clearInterval(interval);
            delete pollIntervals.current[translatorId];
        }
    }, []);

    const handleSessionsToggle = useCallback(
        (translatorId: string, isOpen: boolean) => {
            setExpandedTranslators((previous) => ({
                ...previous,
                [translatorId]: isOpen,
            }));
            if (isOpen) {
                void fetchSessions(translatorId);
            } else {
                stopTranslatorPoll(translatorId);
            }
        },
        [fetchSessions, stopTranslatorPoll],
    );

    const handleEndSession = useCallback(
        async (translator: AdminTranslator, session: TranslatorSessionSummary) => {
            if (!adminApi.revokeSession) {
                return;
            }
            setEndConfirm({ kind: 'session', translator, session });
            setEndConfirmError(null);
        },
        [adminApi.revokeSession],
    );

    const handleEndAllSessions = useCallback(
        async (translator: AdminTranslator) => {
            if (!adminApi.revokeAllSessions) {
                return;
            }
            setEndConfirm({ kind: 'all', translator });
            setEndConfirmError(null);
        },
        [adminApi.revokeAllSessions],
    );

    const confirmEndSession = useCallback(async () => {
        if (endConfirm == null) {
            return;
        }
        setEndConfirmPending(true);
        setEndConfirmError(null);

        try {
            if (endConfirm.kind === 'session') {
                if (!adminApi.revokeSession) {
                    setEndConfirm(null);
                    return;
                }
                await adminApi.revokeSession(
                    programId,
                    endConfirm.translator.id,
                    endConfirm.session.sessionId,
                );
                await fetchSessions(endConfirm.translator.id);
            } else {
                if (!adminApi.revokeAllSessions) {
                    setEndConfirm(null);
                    return;
                }
                await adminApi.revokeAllSessions(programId, endConfirm.translator.id);
                await fetchSessions(endConfirm.translator.id);
            }

            if (!isMountedRef.current) {
                return;
            }
            setEndConfirm(null);
            setEndConfirmError(null);
        } catch (error) {
            if (!isMountedRef.current) {
                return;
            }
            if (isAuthRequired(error)) {
                onAuthExpired();
                return;
            }
            const nextError = errorCode(error);
            setTranslatorSessionState(endConfirm.translator.id, (previous) => ({
                ...previous,
                loading: false,
                error: true,
            }));
            setEndConfirmError(nextError);
        } finally {
            if (isMountedRef.current) {
                setEndConfirmPending(false);
            }
        }
    }, [adminApi, endConfirm, fetchSessions, onAuthExpired, programId, setTranslatorSessionState]);

    function closeEndConfirm() {
        if (endConfirmPending) {
            return;
        }
        setEndConfirm(null);
        setEndConfirmError(null);
    }

    const endConfirmTitle =
        endConfirm?.kind === 'session'
            ? `End session for ${endConfirm.translator.name}?`
            : endConfirm?.kind === 'all'
              ? `End all sessions for ${endConfirm.translator.name}?`
              : '';

    const endConfirmMessage =
        endConfirm?.kind === 'session'
            ? `This will end the ${endConfirm.session.deviceLabel} session.`
            : endConfirm?.kind === 'all'
              ? `This will end all ${sessionStateByTranslator[endConfirm.translator.id]?.sessions.length ?? 0} active sessions.`
              : '';

    const endConfirmConfirmLabel = endConfirm?.kind === 'all' ? 'End all sessions' : 'End session';

    useEffect(() => {
        return () => {
            Object.keys(pollIntervals.current).forEach((translatorId) => {
                stopTranslatorPoll(translatorId);
            });
        };
    }, [stopTranslatorPoll]);

    useEffect(() => {
        const currentTranslatorIds = new Set<string>(
            translators.map((translator) => translator.id),
        );

        setExpandedTranslators((previous) => {
            let didUpdate = false;
            const next = { ...previous };
            for (const translatorId of Object.keys(next)) {
                if (!currentTranslatorIds.has(translatorId)) {
                    delete next[translatorId];
                    didUpdate = true;
                }
            }
            return didUpdate ? next : previous;
        });

        setSessionStateByTranslator((previous) => {
            let didUpdate = false;
            const next = { ...previous };
            for (const translatorId of Object.keys(next)) {
                if (!currentTranslatorIds.has(translatorId)) {
                    delete next[translatorId];
                    didUpdate = true;
                }
            }
            return didUpdate ? next : previous;
        });

        Object.entries(pollIntervals.current).forEach(([translatorId, interval]) => {
            const isOpen = expandedTranslators[translatorId];
            if (!currentTranslatorIds.has(translatorId) || !isOpen) {
                clearInterval(interval);
                delete pollIntervals.current[translatorId];
            }
        });

        Object.entries(expandedTranslators).forEach(([translatorId, isOpen]) => {
            if (!isOpen) {
                return;
            }
            if (!currentTranslatorIds.has(translatorId)) {
                return;
            }
            if (pollIntervals.current[translatorId] != null) {
                return;
            }
            pollIntervals.current[translatorId] = setInterval(() => {
                void fetchSessions(translatorId);
            }, SESSION_POLL_MS);
        });
    }, [expandedTranslators, fetchSessions, translators]);

    return (
        <section className="admin-subsection">
            <div className="admin-subsection-head">
                <h2>Translators</h2>
                <div className="admin-copy-line">
                    <span className="admin-card-url">{translatorUrl}</span>
                    <button
                        className="admin-btn-secondary"
                        onClick={() => void navigator.clipboard.writeText(translatorUrl)}
                        type="button"
                    >
                        Copy
                    </button>
                </div>
            </div>
            {readOnly ? null : (
                <div className="admin-card">
                    <form className="admin-form admin-inline-form" onSubmit={onSubmit}>
                        <label>
                            Translator email
                            <input
                                autoComplete="off"
                                onChange={(event) =>
                                    onChange({ ...form, email: event.target.value })
                                }
                                placeholder="name@example.com"
                                required
                                type="email"
                                value={form.email}
                            />
                        </label>
                        <label>
                            Translator name
                            <input
                                onChange={(event) =>
                                    onChange({ ...form, name: event.target.value })
                                }
                                value={form.name}
                            />
                        </label>
                        <label>
                            Translator password
                            <input
                                autoComplete="new-password"
                                onChange={(event) =>
                                    onChange({ ...form, password: event.target.value })
                                }
                                type="password"
                                value={form.password}
                            />
                        </label>
                        <button type="submit">Create translator</button>
                    </form>
                </div>
            )}
            <div className="admin-list">
                {translators.map((translator) => (
                    <article
                        className={`admin-card admin-translator-card ${
                            sessionStateByTranslator[translator.id]?.sessions.some(
                                (session) => session.isPublishing,
                            )
                                ? 'admin-translator-card--publishing'
                                : ''
                        }`}
                        data-publishing={
                            sessionStateByTranslator[translator.id]?.sessions.some(
                                (session) => session.isPublishing,
                            )
                                ? 'true'
                                : undefined
                        }
                        key={translator.id}
                    >
                        <h3>{translator.name}</h3>
                        {sessionStateByTranslator[translator.id]?.sessions.some(
                            (session) => session.isPublishing,
                        ) ? (
                            <span className="admin-sr-only">Currently publishing</span>
                        ) : null}
                        <p className="admin-translator-email">{translator.email}</p>
                        {translator.assignments.length === 0 ? (
                            <p>No assignments</p>
                        ) : (
                            <div className="admin-chip-row">
                                {translator.assignments.map((assignment) => (
                                    <span className="admin-chip" key={assignment.streamId}>
                                        {assignment.languageName}
                                        {readOnly ? null : (
                                            <button
                                                aria-label={`Remove ${assignment.languageName} from ${translator.name}`}
                                                className="admin-chip-remove"
                                                onClick={() =>
                                                    onRemoveAssignment(
                                                        translator,
                                                        assignment.streamId,
                                                    )
                                                }
                                                type="button"
                                            >
                                                ×
                                            </button>
                                        )}
                                    </span>
                                ))}
                            </div>
                        )}
                        <details
                            className="admin-translator-sessions"
                            id={`translator-sessions-${translator.id}`}
                            onToggle={(event) => {
                                const isOpen = event.currentTarget.open;
                                handleSessionsToggle(translator.id, isOpen);
                            }}
                        >
                            <summary
                                aria-controls={`translator-sessions-${translator.id}`}
                                aria-expanded={Boolean(expandedTranslators[translator.id])}
                                className="admin-session-summary"
                                role="button"
                            >
                                <span className="admin-session-chevron" aria-hidden="true">
                                    ▸
                                </span>
                                Sessions
                                <span
                                    aria-label={`${sessionStateByTranslator[translator.id]?.sessions.length ?? 0} sessions`}
                                    className={`admin-session-count ${
                                        (sessionStateByTranslator[translator.id]?.sessions.length ??
                                            0) > 0
                                            ? 'admin-session-count--active'
                                            : ''
                                    }`}
                                >
                                    {sessionStateByTranslator[translator.id]?.sessions.length ?? 0}
                                </span>
                            </summary>
                            <div className="admin-session-panel">
                                {!sessionStateByTranslator[translator.id]?.loading &&
                                sessionStateByTranslator[translator.id]?.error ? (
                                    <p className="admin-alert">
                                        Could not load sessions. Retrying…
                                    </p>
                                ) : null}

                                {sessionStateByTranslator[translator.id]?.loading ? (
                                    <p>Loading sessions…</p>
                                ) : null}

                                {sessionStateByTranslator[translator.id]?.sessions.length === 0 ? (
                                    !sessionStateByTranslator[translator.id]?.loading ? (
                                        <p>No active sessions</p>
                                    ) : null
                                ) : null}

                                {sessionStateByTranslator[translator.id]?.sessions.length ? (
                                    <>
                                        <table
                                            aria-label={`${translator.name} sessions`}
                                            className="admin-table"
                                        >
                                            <thead>
                                                <tr>
                                                    <th>Device</th>
                                                    <th>Signed in</th>
                                                    <th>Last active</th>
                                                    <th>State</th>
                                                    {readOnly ? null : <th>Action</th>}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {sessionStateByTranslator[
                                                    translator.id
                                                ]?.sessions.map((session) => {
                                                    const expired = isLikelyExpired(session);
                                                    return (
                                                        <tr
                                                            key={session.sessionId}
                                                            className={
                                                                expired
                                                                    ? 'admin-session-row--likely-expired'
                                                                    : ''
                                                            }
                                                        >
                                                            <td>{session.deviceLabel}</td>
                                                            <td>
                                                                {formatISTDateTime(session.loginAt)}
                                                            </td>
                                                            <td>
                                                                {formatRelativeTime(
                                                                    session.lastActiveAt,
                                                                )}
                                                            </td>
                                                            <td>
                                                                {session.isPublishing ? (
                                                                    <StatusPill tone="live">
                                                                        LIVE
                                                                    </StatusPill>
                                                                ) : (
                                                                    <span className="admin-session-idle">
                                                                        idle
                                                                    </span>
                                                                )}
                                                                {expired ? (
                                                                    <span className="admin-session-expired">
                                                                        <span aria-hidden="true">
                                                                            Likely expired
                                                                        </span>
                                                                        <span className="admin-sr-only">
                                                                            Likely expired
                                                                        </span>
                                                                    </span>
                                                                ) : null}
                                                            </td>
                                                            {readOnly ? null : (
                                                                <td>
                                                                    <button
                                                                        className="admin-link-danger"
                                                                        onClick={() =>
                                                                            void handleEndSession(
                                                                                translator,
                                                                                session,
                                                                            )
                                                                        }
                                                                        type="button"
                                                                    >
                                                                        End session
                                                                    </button>
                                                                </td>
                                                            )}
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                        <div className="admin-session-footer">
                                            <p>
                                                Updated{' '}
                                                {formatRelativeTimeFromMs(
                                                    sessionStateByTranslator[translator.id]
                                                        ?.updatedAt,
                                                )}
                                            </p>
                                            {readOnly ? null : (
                                                <button
                                                    className="admin-link-danger"
                                                    onClick={() =>
                                                        void handleEndAllSessions(translator)
                                                    }
                                                    type="button"
                                                >
                                                    End all sessions
                                                </button>
                                            )}
                                        </div>
                                    </>
                                ) : null}
                            </div>
                        </details>
                        {readOnly ? null : (
                            <div className="admin-actions">
                                <button
                                    className="admin-btn-secondary"
                                    onClick={() => onRename(translator)}
                                    type="button"
                                >
                                    Rename {translator.name}
                                </button>
                                <button
                                    className="admin-btn-secondary"
                                    onClick={() => onResetPassword(translator)}
                                    type="button"
                                >
                                    Reset password
                                </button>
                                <button
                                    className="admin-link-danger"
                                    onClick={() => onDelete(translator)}
                                    type="button"
                                >
                                    Delete {translator.name}
                                </button>
                                {streams
                                    .filter(
                                        (stream) =>
                                            !translator.assignments.some(
                                                (assignment) => assignment.streamId === stream.id,
                                            ),
                                    )
                                    .map((stream) => (
                                        <button
                                            className="admin-btn-secondary"
                                            key={stream.id}
                                            onClick={() => onAddAssignment(translator, stream)}
                                            type="button"
                                        >
                                            Assign {stream.languageName} to {translator.name}
                                        </button>
                                    ))}
                            </div>
                        )}
                    </article>
                ))}
            </div>
            <ConfirmDialog
                open={endConfirm !== null}
                onClose={closeEndConfirm}
                onConfirm={confirmEndSession}
                title={endConfirmTitle}
                message={endConfirmMessage}
                confirmLabel={endConfirmConfirmLabel}
                pending={endConfirmPending}
                error={endConfirmError}
            />
        </section>
    );
}

export function ListenerReportPanel({
    detail,
    report,
    reportOpen,
    filters,
    onFilterChange,
    onClearFilters,
    page,
    onPageChange,
    isFetching,
    onDownloadCsv,
    accessSummary,
    accessSummaryFetching,
    onRefreshAccessSummary,
    onRevokeAccess,
    readOnly,
    rangeLabel = null,
    onRangeChipClick,
}: {
    detail: AdminProgramDetail;
    report: AdminListenerReport | null;
    reportOpen: boolean;
    filters: ReportFiltersState;
    onFilterChange: (partial: Partial<ReportFiltersState>) => void;
    onClearFilters: () => void;
    page: number;
    onPageChange: (page: number) => void;
    isFetching: boolean;
    onDownloadCsv: () => void;
    accessSummary: AdminListenerAccessSummary | null;
    accessSummaryFetching: boolean;
    onRefreshAccessSummary: () => void;
    onRevokeAccess: (clientId: string) => Promise<void>;
    readOnly: boolean;
    rangeLabel?: string | null;
    onRangeChipClick?: () => void;
}) {
    const [revokeTarget, setRevokeTarget] = useState<
        AdminListenerReport['connections'][number] | null
    >(null);
    const [revokePending, setRevokePending] = useState(false);
    const [revokeError, setRevokeError] = useState<string | null>(null);
    const streamLabel = new Map(detail.streams.map((stream) => [stream.id, stream.languageName]));
    const total = report?.total ?? 0;
    const totalPages = report?.totalPages ?? 1;
    const pageSize = report?.pageSize ?? 100;
    const filtersActive = reportFiltersActive(filters);
    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    const countText =
        total === 0
            ? 'No connections'
            : `Showing ${start}–${end} of ${total} connections${filtersActive ? ' (filtered)' : ''}`;

    function toggleState(s: string, checked: boolean) {
        const next = checked ? [...filters.states, s] : filters.states.filter((x) => x !== s);
        onFilterChange({ states: next });
    }

    function toggleApprovalStatus(status: ListenerApprovalStatus, checked: boolean) {
        const next = checked
            ? [...filters.approvalStatuses, status]
            : filters.approvalStatuses.filter((value) => value !== status);
        onFilterChange({ approvalStatuses: next });
    }

    async function confirmRevoke() {
        if (!revokeTarget || readOnly) {
            return;
        }
        setRevokePending(true);
        setRevokeError(null);
        try {
            await onRevokeAccess(revokeTarget.clientId);
            setRevokeTarget(null);
        } catch (error) {
            setRevokeError(errorCode(error));
        } finally {
            setRevokePending(false);
        }
    }

    return (
        <AdminUiProvider>
            <section className="admin-subsection">
                <div className="admin-panel-heading">
                    <h2>Listener report</h2>
                    {rangeLabel ? (
                        <button
                            className="admin-pill admin-range-chip"
                            type="button"
                            onClick={onRangeChipClick}
                        >
                            {rangeLabel}
                        </button>
                    ) : null}
                </div>
                <div className="admin-subsection-head">
                    <h3>Listener access</h3>
                    <button
                        aria-label="Refresh access counts"
                        className="admin-btn-secondary"
                        disabled={accessSummaryFetching}
                        onClick={onRefreshAccessSummary}
                        type="button"
                    >
                        {accessSummaryFetching ? 'Refreshing…' : 'Refresh'}
                    </button>
                </div>
                <div className="admin-kpi-strip">
                    <KpiTile
                        label="Pending"
                        value={accessSummary ? String(accessSummary.pending) : '—'}
                    />
                    <KpiTile
                        label="Approved"
                        value={accessSummary ? String(accessSummary.approved) : '—'}
                    />
                    <KpiTile
                        label="Revoked"
                        value={accessSummary ? String(accessSummary.revoked) : '—'}
                    />
                </div>
                <div className="admin-card">
                    {reportOpen && !report ? <p>Loading listener report...</p> : null}
                    {reportOpen && report ? (
                        <>
                            <div className="admin-filter-bar">
                                <div className="admin-filter-row">
                                    <fieldset className="admin-filter-states">
                                        <legend>State</legend>
                                        {LISTENER_STATE_OPTIONS.map((s) => (
                                            <label key={s} className="admin-filter-check">
                                                <input
                                                    type="checkbox"
                                                    checked={filters.states.includes(s)}
                                                    onChange={(e) =>
                                                        toggleState(s, e.target.checked)
                                                    }
                                                />
                                                {s}
                                            </label>
                                        ))}
                                    </fieldset>
                                    <fieldset className="admin-filter-states">
                                        <legend>Approval status</legend>
                                        {LISTENER_APPROVAL_STATUS_OPTIONS.map((status) => (
                                            <label key={status} className="admin-filter-check">
                                                <input
                                                    type="checkbox"
                                                    checked={filters.approvalStatuses.includes(
                                                        status,
                                                    )}
                                                    onChange={(event) =>
                                                        toggleApprovalStatus(
                                                            status,
                                                            event.target.checked,
                                                        )
                                                    }
                                                />
                                                {status}
                                            </label>
                                        ))}
                                    </fieldset>
                                    {filtersActive ? (
                                        <button
                                            className="admin-btn-secondary"
                                            type="button"
                                            onClick={onClearFilters}
                                        >
                                            Clear all filters
                                        </button>
                                    ) : null}
                                </div>
                                <div className="admin-filter-row">
                                    <label className="admin-filter-field">
                                        <span className="admin-filter-field-label">Language</span>
                                        <select
                                            value={filters.streamId}
                                            onChange={(e) =>
                                                onFilterChange({ streamId: e.target.value })
                                            }
                                        >
                                            <option value="">All languages</option>
                                            {detail.streams.map((stream) => (
                                                <option key={stream.id} value={stream.id}>
                                                    {stream.languageName}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <label className="admin-filter-field">
                                        <span className="admin-filter-field-label">Device</span>
                                        <select
                                            value={filters.deviceLabel}
                                            onChange={(e) =>
                                                onFilterChange({ deviceLabel: e.target.value })
                                            }
                                        >
                                            <option value="">All devices</option>
                                            {LISTENER_DEVICE_LABELS.map((d) => (
                                                <option key={d} value={d}>
                                                    {d}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                </div>
                            </div>

                            <div className="admin-report-meta">
                                <p role="status" aria-live="polite">
                                    {countText}
                                </p>
                                <button
                                    className="admin-btn-secondary"
                                    type="button"
                                    onClick={onDownloadCsv}
                                >
                                    Download CSV
                                </button>
                            </div>

                            {isFetching ? (
                                <p className="admin-report-loading">Updating&hellip;</p>
                            ) : null}

                            <div className="admin-table-scroll">
                                <table className="admin-table">
                                    <thead>
                                        <tr>
                                            <th>Language</th>
                                            <th>Connected</th>
                                            <th>Last active</th>
                                            <th>IP address</th>
                                            <th>Device</th>
                                            <th title="Phone model from browser hint (Android only)">
                                                Model
                                            </th>
                                            <th>State</th>
                                            <th>Approval status</th>
                                            <th>Approved at</th>
                                            <th>Approved via</th>
                                            {readOnly ? null : <th>Action</th>}
                                        </tr>
                                    </thead>
                                    <tbody style={{ opacity: isFetching ? 0.6 : 1 }}>
                                        {report.connections.length === 0 ? (
                                            <tr>
                                                <td
                                                    colSpan={readOnly ? 10 : 11}
                                                    className="admin-table-empty"
                                                >
                                                    No connections match the current filters.
                                                </td>
                                            </tr>
                                        ) : (
                                            report.connections.map((connection) => (
                                                <tr key={connection.id}>
                                                    <td>
                                                        {streamLabel.get(connection.streamId) ??
                                                            connection.streamId}
                                                    </td>
                                                    <td>
                                                        {formatISTDateTime(connection.connectedAt)}
                                                    </td>
                                                    <td>
                                                        {formatRelativeTime(connection.lastSeenAt)}
                                                    </td>
                                                    <td>{connection.listenerIp}</td>
                                                    <td title={connection.userAgent}>
                                                        {connection.deviceLabel}
                                                    </td>
                                                    <td title={connection.deviceModel ?? undefined}>
                                                        {connection.deviceModelName ?? '—'}
                                                    </td>
                                                    <td>{connection.subscriptionStatus}</td>
                                                    <td>{connection.approvalStatus ?? '—'}</td>
                                                    <td>
                                                        {formatISTDateTime(connection.approvedAt)}
                                                    </td>
                                                    <td>
                                                        {connection.approvedAt
                                                            ? `${connection.approvedVia ?? '—'} · volunteer`
                                                            : '—'}
                                                    </td>
                                                    {readOnly ? null : (
                                                        <td>
                                                            {connection.approvalStatus &&
                                                            connection.approvalStatus !==
                                                                'revoked' ? (
                                                                <button
                                                                    className="admin-link-danger"
                                                                    onClick={() => {
                                                                        setRevokeError(null);
                                                                        setRevokeTarget(connection);
                                                                    }}
                                                                    type="button"
                                                                >
                                                                    Revoke
                                                                </button>
                                                            ) : (
                                                                '—'
                                                            )}
                                                        </td>
                                                    )}
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>

                            <div className="admin-pagination">
                                <button
                                    className="admin-btn-secondary"
                                    type="button"
                                    onClick={() => onPageChange(page - 1)}
                                    disabled={page <= 1}
                                >
                                    &larr; Prev
                                </button>
                                <span className="admin-pagination-info">
                                    Page {page} of {totalPages}
                                </span>
                                <button
                                    className="admin-btn-secondary"
                                    type="button"
                                    onClick={() => onPageChange(page + 1)}
                                    disabled={page >= totalPages}
                                >
                                    Next &rarr;
                                </button>
                            </div>
                        </>
                    ) : null}
                </div>
                <ConfirmDialog
                    open={revokeTarget !== null}
                    onClose={() => {
                        if (!revokePending) {
                            setRevokeTarget(null);
                            setRevokeError(null);
                        }
                    }}
                    onConfirm={() => void confirmRevoke()}
                    title="Revoke listener access"
                    message="Revoke access for this device? They'll need a volunteer to re-approve them."
                    confirmLabel="Revoke access"
                    pending={revokePending}
                    error={revokeError}
                />
            </section>
        </AdminUiProvider>
    );
}
