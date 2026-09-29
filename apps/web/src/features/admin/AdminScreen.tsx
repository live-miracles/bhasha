import {
    FormEvent,
    KeyboardEvent,
    ReactNode,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import {
    Alert,
    Badge,
    Button,
    Checkbox,
    Group,
    Paper,
    NativeSelect,
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
    type AdminUser,
    type AdminListenerReport,
    type ListenerReportQuery,
    type ListenerApprovalStatus,
    type AdminProgram,
    type AdminProgramDetail,
    type AdminProgramApproverAccess,
    type AdminProgramStatus,
    type AdminReadiness,
    type AdminReportSummary,
    type ReportDateRangeQuery,
    type AdminStream,
    type TranslatorSessionSummary,
    type AdminTranslator,
    type ConfirmableReadinessItemId,
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
import { formatISTDateTime, formatISTTime, formatLocalTime } from './formatTime';
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
} from './AdminShell';
import { UsersPanel } from './UsersPanel';
import { AccountPanel } from './AccountPanel';
import { LoginPage } from '../../components/LoginPage';

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

function PlusIcon() {
    return (
        <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
            <path
                d="M12 5v14M5 12h14"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="2"
            />
        </svg>
    );
}

function RestoreIcon() {
    return (
        <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
            <path
                d="M3 12a9 9 0 1 0 3-6.7M3 4v6h6"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
            />
            <path
                d="M12 8v4l2.5 2"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
            />
        </svg>
    );
}

function EditIcon() {
    return (
        <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
            <path
                d="m4 16.5-.8 3.3 3.3-.8L18.7 6.8a2.1 2.1 0 0 0-3-3L3.5 16.5Z"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
            />
            <path d="m14.5 5.5 4 4" stroke="currentColor" strokeWidth="1.8" />
        </svg>
    );
}

function TrashIcon() {
    return (
        <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
            <path
                d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7l1-3h4l1 3"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
            />
        </svg>
    );
}

function ListenerApprovalIcon() {
    return (
        <span
            aria-label="Listener approval required"
            className="admin-listener-approval-icon"
            role="img"
            title="Listener approval required"
        >
            <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
                <path
                    d="M12 3.5 19 6v5.1c0 4.8-2.9 7.8-7 9.4-4.1-1.6-7-4.6-7-9.4V6l7-2.5Z"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.8"
                />
                <path
                    d="m9.2 12 1.8 1.8 3.8-4"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.8"
                />
            </svg>
        </span>
    );
}

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

function approverSvgFilename(filename: string): string {
    return svgFilename(filename).replace(/\.svg$/, '-approver.svg');
}

function editFormFromProgram(program: AdminProgram) {
    const startDate = program.startDate ?? '';
    return {
        name: program.name,
        startDate,
        endDate: program.endDate ?? startDate,
        slug: program.slug,
        accessControlEnabled: program.accessControlEnabled,
        createdBy: program.createdBy ?? '',
    };
}

function programDateRange(program: AdminProgram): string {
    const startDate = program.startDate ?? '';
    const endDate = program.endDate ?? '';
    if (!endDate || endDate === startDate) {
        return startDate;
    }

    const endDay = endDate.split('-').pop();
    return endDay ? `${startDate} – ${endDay}` : `${startDate} – ${endDate}`;
}

// Same grace period as apps/api/src/domain/programExpiry.ts's isProgramExpired,
// so a program only moves to "Past" here exactly when listeners/translators/
// approvers would actually see it as expired.
const PROGRAM_PAST_GRACE_DAYS = 2;

function isPastProgram(endDate: string | null | undefined, now = new Date()): boolean {
    if (!endDate) {
        return false;
    }
    const today = now.toISOString().slice(0, 10);
    const pastOn = new Date(`${endDate}T00:00:00.000Z`);
    pastOn.setUTCDate(pastOn.getUTCDate() + PROGRAM_PAST_GRACE_DAYS);
    return today >= pastOn.toISOString().slice(0, 10);
}

function sortProgramsByStartDate(
    programs: AdminProgram[],
    direction: 'asc' | 'desc',
): AdminProgram[] {
    const sign = direction === 'asc' ? 1 : -1;
    return [...programs].sort((left, right) => {
        const leftStartDate = left.startDate ?? '';
        const rightStartDate = right.startDate ?? '';

        if (!leftStartDate) return rightStartDate ? 1 : 0;
        if (!rightStartDate) return -1;
        return (
            sign * leftStartDate.localeCompare(rightStartDate) ||
            left.name.localeCompare(right.name)
        );
    });
}

function sortProgramsByDeletedAtDesc(programs: AdminProgram[]): AdminProgram[] {
    return [...programs].sort((left, right) => {
        const leftDeletedAt = left.deletedAt ?? '';
        const rightDeletedAt = right.deletedAt ?? '';
        return rightDeletedAt.localeCompare(leftDeletedAt) || left.name.localeCompare(right.name);
    });
}

// Same grace period as apps/api/src/domain/retentionService.ts's
// GRACE_DAYS_MS, so this matches when a deleted program is actually pruned.
const PROGRAM_PURGE_GRACE_DAYS = 7;

function daysUntilProgramPurge(
    deletedAt: string | null | undefined,
    now = new Date(),
): number | null {
    if (!deletedAt) {
        return null;
    }
    const deletedAtMs = new Date(deletedAt).getTime();
    if (Number.isNaN(deletedAtMs)) {
        return null;
    }
    const dayMs = 24 * 60 * 60 * 1000;
    const daysElapsed = Math.floor((now.getTime() - deletedAtMs) / dayMs);
    return Math.max(0, PROGRAM_PURGE_GRACE_DAYS - daysElapsed);
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
    const [createProgramOpen, setCreateProgramOpen] = useState(false);
    const [editProgramOpen, setEditProgramOpen] = useState(false);
    const [identity, setIdentity] = useState<AdminMe | null>(null);
    const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
    const [programForm, setProgramForm] = useState({
        slug: '',
        name: '',
        startDate: '',
        endDate: '',
        accessControlEnabled: false,
        createdBy: '',
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
        startDate: '',
        endDate: '',
        slug: '',
        accessControlEnabled: false,
        createdBy: '',
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
        setAdminUsers([]);
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
            if (me.role === 'admin') {
                const usersResponse = await adminApi.listUsers();
                setAdminUsers(usersResponse.users);
            }
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
                        <Button
                            disabled={refreshing}
                            loading={refreshing}
                            onClick={() => void refreshStatus()}
                            type="button"
                            variant="default"
                        >
                            Refresh events
                        </Button>
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
                </div>
                <ProgramDetailForm
                    currentOwnerId={identity?.id ?? null}
                    currentOwnerName={identity?.username ?? null}
                    form={editForm}
                    isAdmin={identity?.role === 'admin'}
                    onEdit={() => {
                        setError(null);
                        setEditProgramOpen(true);
                    }}
                    readOnly
                    slugLocked={false}
                    onChange={setEditForm}
                    onDelete={() => void deleteSelectedProgram()}
                    onSubmit={updateSelectedProgram}
                    ownerOptions={adminUsers}
                />
                <ApproverAccessPanel
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
                startDate: programForm.startDate,
                endDate: programForm.endDate,
                accessControlEnabled: programForm.accessControlEnabled,
                ...(identity?.role === 'admin' && programForm.createdBy
                    ? { createdBy: programForm.createdBy }
                    : {}),
            });
            setProgramForm({
                slug: '',
                name: '',
                startDate: '',
                endDate: '',
                accessControlEnabled: false,
                createdBy: '',
            });
            setCreateProgramOpen(false);
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
        try {
            const response = await adminApi.updateProgram(selectedProgramId, {
                name: editForm.name,
                startDate: editForm.startDate,
                endDate: editForm.endDate,
                ...(identity?.role === 'admin' && editForm.createdBy
                    ? { createdBy: editForm.createdBy }
                    : {}),
                accessControlEnabled: editForm.accessControlEnabled,
                slug: editForm.slug,
            });
            setDetail(response);
            setEditForm(editFormFromProgram(response.program));
            setPrograms((current) =>
                current.map((program) =>
                    program.id === response.program.id ? response.program : program,
                ),
            );
            setEditProgramOpen(false);
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
            'Delete this program? It will be moved to Recently deleted and can be restored for 7 days.';
        if (!window.confirm(message)) {
            return;
        }
        setError(null);
        try {
            await adminApi.deleteProgram(selectedProgramId);
            setEditProgramOpen(false);
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
        <AdminUiProvider>
            <main aria-label="Management workspace" className="shell shell-admin admin-screen">
                {error && loadState === 'error' ? (
                    <Alert color="red" role="alert">
                        {error}
                    </Alert>
                ) : null}

                {loadState === 'checking' ? <p>Checking management access...</p> : null}
                {loadState === 'login' ? (
                    <LoginPage
                        identityLabel="Username"
                        identityValue={loginUsername}
                        onIdentityChange={setLoginUsername}
                        onPasswordChange={setLoginPassword}
                        onSubmit={submitLogin}
                        passwordValue={loginPassword}
                        error={error}
                        title="Management login"
                    />
                ) : null}
                {loadState === 'error' ? (
                    <Button onClick={() => void loadPrograms()} type="button">
                        Retry
                    </Button>
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
                                {error && !createProgramOpen ? (
                                    <Alert color="red" role="alert">
                                        {error}
                                    </Alert>
                                ) : null}
                                <div className="admin-content">
                                    {activeSection === 'deleted' ? (
                                        <section
                                            aria-label="Recently deleted"
                                            className="admin-section"
                                        >
                                            <div className="admin-section-head">
                                                <h2>Recently deleted</h2>
                                            </div>
                                            <ProgramGrid
                                                adminUsers={adminUsers}
                                                currentOwnerId={identity?.id ?? null}
                                                currentOwnerName={identity?.username ?? null}
                                                emptyMessage="No recently deleted programs."
                                                programs={sortProgramsByDeletedAtDesc(
                                                    deletedPrograms,
                                                )}
                                                onRestore={(programId: string) => {
                                                    void restoreProgram(programId);
                                                }}
                                            />
                                        </section>
                                    ) : activeSection === 'users' && identity?.role === 'admin' ? (
                                        <UsersPanel
                                            adminApi={adminApi}
                                            currentUserId={identity?.id ?? ''}
                                        />
                                    ) : activeSection === 'account' ? (
                                        <AccountPanel
                                            adminApi={adminApi}
                                            username={identity?.username}
                                            role={identity?.role}
                                            onSignOut={handleSignOut}
                                        />
                                    ) : (
                                        <section aria-label="Programs" className="admin-section">
                                            <div className="admin-section-head">
                                                <h2>Programs</h2>
                                                <Button
                                                    aria-label="Add program"
                                                    className="admin-add-program-button"
                                                    leftSection={<PlusIcon />}
                                                    onClick={() => {
                                                        setError(null);
                                                        if (identity?.role === 'admin') {
                                                            setProgramForm((current) => ({
                                                                ...current,
                                                                createdBy: identity.id,
                                                            }));
                                                        }
                                                        setCreateProgramOpen(true);
                                                    }}
                                                    type="button"
                                                >
                                                    <span className="admin-add-program-label">
                                                        Add program
                                                    </span>
                                                </Button>
                                            </div>
                                            {programs.length === 0 ? (
                                                <p>No programs yet.</p>
                                            ) : (
                                                <>
                                                    <section aria-label="Current programs">
                                                        <Stack gap="md" mt="md">
                                                            <Title order={3}>
                                                                Current programs
                                                            </Title>
                                                            <ProgramGrid
                                                                adminUsers={adminUsers}
                                                                currentOwnerId={
                                                                    identity?.id ?? null
                                                                }
                                                                currentOwnerName={
                                                                    identity?.username ?? null
                                                                }
                                                                emptyMessage="No current programs."
                                                                programs={sortProgramsByStartDate(
                                                                    programs.filter(
                                                                        (program) =>
                                                                            !isPastProgram(
                                                                                program.endDate,
                                                                            ),
                                                                    ),
                                                                    'asc',
                                                                )}
                                                                onOpen={(program) =>
                                                                    navigate(
                                                                        adminProgramPath(
                                                                            program.slug,
                                                                        ),
                                                                    )
                                                                }
                                                            />
                                                        </Stack>
                                                    </section>
                                                    <section aria-label="Past programs">
                                                        <Stack gap="md" mt="xl">
                                                            <Title order={3}>Past programs</Title>
                                                            <ProgramGrid
                                                                adminUsers={adminUsers}
                                                                currentOwnerId={
                                                                    identity?.id ?? null
                                                                }
                                                                currentOwnerName={
                                                                    identity?.username ?? null
                                                                }
                                                                emptyMessage="No past programs."
                                                                programs={sortProgramsByStartDate(
                                                                    programs.filter((program) =>
                                                                        isPastProgram(
                                                                            program.endDate,
                                                                        ),
                                                                    ),
                                                                    'desc',
                                                                )}
                                                                onOpen={(program) =>
                                                                    navigate(
                                                                        adminProgramPath(
                                                                            program.slug,
                                                                        ),
                                                                    )
                                                                }
                                                            />
                                                        </Stack>
                                                    </section>
                                                </>
                                            )}
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
                                {error ? (
                                    <Alert color="red" role="alert">
                                        {error}
                                    </Alert>
                                ) : null}
                                <div className="admin-content">{renderSection()}</div>
                            </AdminLayout>
                        )}
                        <AdminDialog
                            onClose={() => {
                                setError(null);
                                setCreateProgramOpen(false);
                            }}
                            open={createProgramOpen}
                            title="Create program"
                        >
                            <ProgramCreateForm
                                error={error}
                                form={programForm}
                                onChange={setProgramForm}
                                isAdmin={identity?.role === 'admin'}
                                ownerOptions={adminUsers}
                                onSubmit={submitProgram}
                                readOnly={false}
                            />
                        </AdminDialog>
                        <AdminDialog
                            onClose={() => {
                                setError(null);
                                setEditProgramOpen(false);
                            }}
                            open={editProgramOpen}
                            title="Edit program details"
                        >
                            <ProgramDetailForm
                                currentOwnerId={identity?.id ?? null}
                                currentOwnerName={identity?.username ?? null}
                                error={error}
                                form={editForm}
                                isAdmin={identity?.role === 'admin'}
                                onChange={setEditForm}
                                onSubmit={updateSelectedProgram}
                                ownerOptions={adminUsers}
                                readOnly={false}
                                showHeader={false}
                                slugLocked={false}
                            />
                        </AdminDialog>
                        <KickConfirmDialog
                            open={kickedStream !== null}
                            onClose={closeKickDialog}
                            onConfirm={handleKickPublisher}
                            title={
                                kickedStream
                                    ? `End the ${kickedStream.languageName} broadcast?`
                                    : ''
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
        </AdminUiProvider>
    );
}

function AdminFormShell({
    children,
    error,
    onSubmit,
    withBorder = false,
}: {
    children: ReactNode;
    error?: string | null | undefined;
    onSubmit: (event: FormEvent<HTMLFormElement>) => void;
    withBorder?: boolean;
}) {
    const form = (
        <form onSubmit={onSubmit}>
            <Stack gap="md">
                {error ? (
                    <Alert color="red" role="alert">
                        {error}
                    </Alert>
                ) : null}
                {children}
            </Stack>
        </form>
    );

    return withBorder ? (
        <Paper p="lg" radius="md" withBorder>
            {form}
        </Paper>
    ) : (
        form
    );
}

function ProgramCreateForm({
    form,
    isAdmin,
    onChange,
    onSubmit,
    ownerOptions,
    error,
    readOnly,
}: {
    form: {
        slug: string;
        name: string;
        startDate: string;
        endDate: string;
        accessControlEnabled: boolean;
        createdBy: string;
    };
    onChange: (form: {
        slug: string;
        name: string;
        startDate: string;
        endDate: string;
        accessControlEnabled: boolean;
        createdBy: string;
    }) => void;
    onSubmit: (event: FormEvent<HTMLFormElement>) => void;
    isAdmin: boolean;
    ownerOptions: AdminUser[];
    error?: string | null;
    readOnly: boolean;
}) {
    if (readOnly) {
        return null;
    }

    return (
        <AdminFormShell error={error} onSubmit={onSubmit}>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput
                    aria-label="Program name"
                    label="Program name"
                    onChange={(event) => onChange({ ...form, name: event.target.value })}
                    required
                    value={form.name}
                />
                <TextInput
                    aria-label="Program slug"
                    label="Program slug"
                    onChange={(event) => onChange({ ...form, slug: event.target.value })}
                    required
                    value={form.slug}
                />
                <TextInput
                    aria-label="Start date"
                    label="Start date"
                    onChange={(event) => onChange({ ...form, startDate: event.target.value })}
                    type="date"
                    required
                    value={form.startDate}
                />
                <TextInput
                    aria-label="End date"
                    label="End date"
                    onChange={(event) => onChange({ ...form, endDate: event.target.value })}
                    type="date"
                    required
                    value={form.endDate}
                />
                {isAdmin ? (
                    <NativeSelect
                        data={[
                            { value: '', label: 'Unassigned' },
                            ...ownerOptions.map((user) => ({
                                value: user.id,
                                label: user.username,
                            })),
                        ]}
                        label="Program owner"
                        onChange={(event) =>
                            onChange({ ...form, createdBy: event.currentTarget.value })
                        }
                        value={form.createdBy}
                    />
                ) : null}
            </SimpleGrid>
            <Checkbox
                aria-label="Require listener approval before they can listen"
                checked={form.accessControlEnabled}
                label="Require listener approval"
                onChange={(event) =>
                    onChange({
                        ...form,
                        accessControlEnabled: event.currentTarget.checked,
                    })
                }
            />
            <Group justify="flex-end">
                <Button type="submit">Create program</Button>
            </Group>
        </AdminFormShell>
    );
}

function ProgramCard({
    adminUsers,
    currentOwnerId,
    currentOwnerName,
    program,
    onOpen,
    onRestore,
}: {
    adminUsers: AdminUser[];
    currentOwnerId: string | null;
    currentOwnerName: string | null;
    program: AdminProgram;
    onOpen?: ((program: AdminProgram) => void) | undefined;
    onRestore?: ((programId: string) => void) | undefined;
}) {
    function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (!onOpen) return;
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen(program);
        }
    }

    return (
        <Paper
            className={`admin-card admin-program-card${onOpen ? ' admin-card-clickable' : ''}`}
            component="article"
            onClick={onOpen ? () => onOpen(program) : undefined}
            onKeyDown={onOpen ? handleKeyDown : undefined}
            p="lg"
            radius="md"
            role={onOpen ? 'button' : undefined}
            tabIndex={onOpen ? 0 : undefined}
            withBorder
        >
            <Text className="admin-program-slug" component="span" size="sm">
                {program.slug}
            </Text>
            <Stack gap="xs">
                <Group className="admin-program-meta" justify="space-between" wrap="nowrap">
                    <Text c="dimmed" size="sm">
                        {programDateRange(program)}
                    </Text>
                </Group>
                <Group className="admin-program-heading" gap="xs" wrap="nowrap">
                    {program.accessControlEnabled ? <ListenerApprovalIcon /> : null}
                    <Title order={3} size="h4">
                        {program.name}
                    </Title>
                </Group>
                <Text c="dimmed" size="sm">
                    {adminUsers.find((user) => user.id === program.createdBy)?.username ??
                        (program.createdBy === currentOwnerId ? currentOwnerName : null) ??
                        'Unassigned'}
                </Text>
            </Stack>
            {onRestore ? (
                <Group align="center" gap="sm" mt="md" wrap="nowrap">
                    <Button
                        leftSection={<RestoreIcon />}
                        onClick={(event) => {
                            event.stopPropagation();
                            onRestore(program.id);
                        }}
                        type="button"
                    >
                        Restore
                    </Button>
                    {(() => {
                        const daysLeft = daysUntilProgramPurge(program.deletedAt);
                        if (daysLeft === null) {
                            return null;
                        }
                        return (
                            <Text c="dimmed" size="xs">
                                {daysLeft <= 0
                                    ? 'Deletes today'
                                    : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`}
                            </Text>
                        );
                    })()}
                </Group>
            ) : null}
        </Paper>
    );
}

function ProgramGrid({
    adminUsers,
    currentOwnerId,
    currentOwnerName,
    programs,
    emptyMessage,
    onOpen,
    onRestore,
}: {
    adminUsers: AdminUser[];
    currentOwnerId: string | null;
    currentOwnerName: string | null;
    programs: AdminProgram[];
    emptyMessage: string;
    onOpen?: ((program: AdminProgram) => void) | undefined;
    onRestore?: ((programId: string) => void) | undefined;
}) {
    if (programs.length === 0) {
        return <p>{emptyMessage}</p>;
    }

    return (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
            {programs.map((program) => (
                <ProgramCard
                    adminUsers={adminUsers}
                    currentOwnerId={currentOwnerId}
                    currentOwnerName={currentOwnerName}
                    key={program.id}
                    onOpen={onOpen}
                    onRestore={onRestore}
                    program={program}
                />
            ))}
        </SimpleGrid>
    );
}

function ProgramDetailForm({
    currentOwnerId,
    currentOwnerName,
    error,
    form,
    isAdmin,
    onEdit,
    slugLocked,
    onChange,
    onDelete,
    onSubmit,
    readOnly,
    ownerOptions,
    showHeader,
}: {
    currentOwnerId: string | null;
    currentOwnerName: string | null;
    error?: string | null;
    form: {
        name: string;
        startDate: string;
        endDate: string;
        slug: string;
        accessControlEnabled: boolean;
        createdBy: string;
    };
    slugLocked: boolean;
    onChange: (form: {
        name: string;
        startDate: string;
        endDate: string;
        slug: string;
        accessControlEnabled: boolean;
        createdBy: string;
    }) => void;
    onDelete?: () => void;
    onEdit?: () => void;
    onSubmit: (event: FormEvent<HTMLFormElement>) => void;
    isAdmin: boolean;
    readOnly: boolean;
    ownerOptions: AdminUser[];
    showHeader?: boolean;
}) {
    const shouldShowHeader = showHeader ?? true;

    return (
        <AdminFormShell error={error} onSubmit={onSubmit} withBorder={readOnly}>
            {shouldShowHeader ? (
                <Group justify="space-between">
                    <Title order={2}>Program details</Title>
                    {readOnly ? (
                        <Group gap="xs">
                            {onEdit ? (
                                <Button
                                    aria-label="Edit program details"
                                    className="admin-add-program-button"
                                    leftSection={<EditIcon />}
                                    onClick={onEdit}
                                    type="button"
                                >
                                    <span className="admin-add-program-label">Edit</span>
                                </Button>
                            ) : null}
                            {onDelete ? (
                                <Button
                                    aria-label="Delete program"
                                    className="admin-add-program-button admin-delete-program-button"
                                    leftSection={<TrashIcon />}
                                    onClick={onDelete}
                                    type="button"
                                >
                                    <span className="admin-add-program-label">Delete</span>
                                </Button>
                            ) : null}
                        </Group>
                    ) : null}
                </Group>
            ) : null}
            {readOnly ? (
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                    <Stack gap={2}>
                        <Text c="dimmed" size="xs">
                            Program name
                        </Text>
                        <Text>{form.name || '—'}</Text>
                    </Stack>
                    <Stack gap={2}>
                        <Text c="dimmed" size="xs">
                            Start date
                        </Text>
                        <Text>{form.startDate || '—'}</Text>
                    </Stack>
                    <Stack gap={2}>
                        <Text c="dimmed" size="xs">
                            End date
                        </Text>
                        <Text>{form.endDate || '—'}</Text>
                    </Stack>
                    <Stack gap={2}>
                        <Text c="dimmed" size="xs">
                            Program slug
                        </Text>
                        <Text>{form.slug || '—'}</Text>
                    </Stack>
                    <Stack gap={2}>
                        <Text c="dimmed" size="xs">
                            Program owner
                        </Text>
                        <Text>
                            {ownerOptions.find((user) => user.id === form.createdBy)?.username ??
                                (form.createdBy === currentOwnerId ? currentOwnerName : null) ??
                                'Unassigned'}
                        </Text>
                    </Stack>
                    <Stack gap={2}>
                        <Text c="dimmed" size="xs">
                            Listener approval
                        </Text>
                        <Text>{form.accessControlEnabled ? 'Required' : 'Not required'}</Text>
                    </Stack>
                </SimpleGrid>
            ) : (
                <>
                    <SimpleGrid cols={{ base: 1, sm: 2 }}>
                        <TextInput
                            aria-label="Detail program name"
                            label="Detail program name"
                            onChange={(event) => onChange({ ...form, name: event.target.value })}
                            required
                            value={form.name}
                        />
                        <TextInput
                            aria-describedby={slugLocked ? 'slug-hint' : undefined}
                            aria-label="Program slug"
                            label="Program slug"
                            onChange={(event) => onChange({ ...form, slug: event.target.value })}
                            disabled={slugLocked}
                            required={!slugLocked}
                            value={form.slug}
                        />
                        <TextInput
                            aria-label="Detail start date"
                            label="Detail start date"
                            onChange={(event) =>
                                onChange({ ...form, startDate: event.target.value })
                            }
                            type="date"
                            required
                            value={form.startDate}
                        />
                        <TextInput
                            aria-label="Detail end date"
                            label="Detail end date"
                            onChange={(event) => onChange({ ...form, endDate: event.target.value })}
                            type="date"
                            required
                            value={form.endDate}
                        />
                        {isAdmin ? (
                            <NativeSelect
                                data={[
                                    { value: '', label: 'Unassigned' },
                                    ...ownerOptions.map((user) => ({
                                        value: user.id,
                                        label: user.username,
                                    })),
                                ]}
                                label="Program owner"
                                onChange={(event) =>
                                    onChange({
                                        ...form,
                                        createdBy: event.currentTarget.value,
                                    })
                                }
                                value={form.createdBy}
                            />
                        ) : null}
                    </SimpleGrid>
                    <Checkbox
                        aria-label="Require listener approval before they can listen"
                        checked={form.accessControlEnabled}
                        label="Require listener approval"
                        onChange={(event) =>
                            onChange({
                                ...form,
                                accessControlEnabled: event.currentTarget.checked,
                            })
                        }
                    />
                    <Group justify="flex-end">
                        <Button type="submit">Update program</Button>
                    </Group>
                </>
            )}
        </AdminFormShell>
    );
}

const APPROVER_PASSWORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function generatedApproverPassword(): string {
    const bytes = new Uint8Array(10);
    crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => APPROVER_PASSWORD_ALPHABET[byte & 31]).join('');
}

function ApproverAccessPanel({
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
    const [access, setAccess] = useState<AdminProgramApproverAccess | null>(null);
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
            .getApproverAccess(programId)
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
            const response = await adminApi.updateApproverAccess(programId, {
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
        <section aria-label="Approver access" className="admin-subsection">
            <Stack gap="xs">
                <Group align="center" gap="sm">
                    <Title order={2}>Approver access</Title>
                    {access ? (
                        <Badge
                            aria-label={`${access.activeSessionCount} active approver sessions`}
                            color={access.activeSessionCount > 0 ? 'green' : 'gray'}
                            variant="light"
                        >
                            {access.activeSessionCount} active
                        </Badge>
                    ) : null}
                </Group>
                <Text c="dimmed" size="sm">
                    Shared credentials for event approvers who approve listener access.
                </Text>
            </Stack>
            {access ? (
                <Paper component="form" mt="md" onSubmit={save} p="md" radius="md" withBorder>
                    <Stack gap="md">
                        <TextInput
                            aria-label="Approver login ID"
                            autoComplete="username"
                            disabled={readOnly || pending}
                            label="Approver login ID"
                            onChange={(event) => setLoginId(event.target.value)}
                            required
                            value={loginId}
                        />
                        <TextInput
                            aria-label="Approver password"
                            autoComplete="new-password"
                            disabled={readOnly || pending}
                            label="Approver password"
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

                        {access.passwordUpdatedAt ? (
                            <Text c="dimmed" size="sm">
                                Password last updated {formatISTDateTime(access.passwordUpdatedAt)}
                            </Text>
                        ) : null}
                        <Alert color="yellow">Saving changes resets all approver sessions.</Alert>
                        {panelError ? <Alert color="red">{panelError}</Alert> : null}
                        {readOnly ? null : (
                            <Group>
                                <Button
                                    disabled={pending}
                                    onClick={() => setPassword(generatedApproverPassword())}
                                    type="button"
                                    variant="default"
                                >
                                    Generate
                                </Button>
                                <Button disabled={pending} loading={pending} type="submit">
                                    Save approver access
                                </Button>
                            </Group>
                        )}
                    </Stack>
                </Paper>
            ) : panelError ? (
                <Alert color="red" mt="md">
                    {panelError}
                </Alert>
            ) : (
                <Text mt="md">Loading approver access…</Text>
            )}
            <ApproverPasswordOnceDialog
                onClose={() => setShownPassword(null)}
                password={shownPassword}
            />
        </section>
    );
}

function ApproverPasswordOnceDialog({
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
        <AdminDialog onClose={onClose} open title="Approver password">
            <Stack gap="md">
                <Text>You won't be able to see it again.</Text>
                <Paper component="code" p="sm" withBorder>
                    {visiblePassword}
                </Paper>
                <Group>
                    <Button onClick={() => void copyPassword()} type="button">
                        Copy password
                    </Button>
                    <Button onClick={onClose} type="button" variant="default">
                        Done
                    </Button>
                </Group>
                <span aria-live="polite" role="status">
                    {copied ? 'Copied' : ''}
                </span>
            </Stack>
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
        <Paper ref={qrRef} p="md" radius="md" withBorder>
            <Stack align="center" gap="md">
                <Title order={3}>{title}</Title>
                <QRCodeSVG
                    aria-label={title}
                    marginSize={4}
                    size={192}
                    title={value}
                    value={value}
                />
                <Text c="dimmed" size="xs" ta="center" style={{ wordBreak: 'break-all' }}>
                    {value}
                </Text>
                <Group>
                    <Button onClick={downloadQr} type="button" variant="default">
                        Download QR SVG
                    </Button>
                    <Button onClick={printQr} type="button" variant="default">
                        Print QR
                    </Button>
                </Group>
            </Stack>
        </Paper>
    );
}

function QrPanel({ detail }: { detail: AdminProgramDetail }) {
    return (
        <section aria-label="Share QR" className="admin-subsection">
            <Title order={2}>Share / QR</Title>
            <SimpleGrid cols={{ base: 1, sm: 3 }} mt="md">
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
                    filename={approverSvgFilename(detail.suggestedQrFilename)}
                    title="Approver QR"
                    value={detail.urls.approverUrl}
                />
            </SimpleGrid>
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
            <Group justify="space-between" mb="md">
                <Title order={2}>Listener counts</Title>
                <Button disabled={refreshing} onClick={onRefresh} type="button" variant="default">
                    {refreshing ? 'Refreshing…' : 'Refresh'}
                </Button>
            </Group>
            <div className="admin-kpi-strip">
                <KpiTile label="Total" value={status.totalActiveListeners.toString()} />
                <KpiTile label="Freshness" value={status.stale ? 'Stale' : 'Fresh'} />
                <KpiTile label="Service" value={status.degraded ? 'Degraded' : 'Normal'} />
                <KpiTile
                    label="Updated"
                    value={status.updatedAt ? formatISTDateTime(status.updatedAt) : 'Not available'}
                />
                <KpiTile label="Server time" value={formatLocalTime(status.serverTime)} />
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
                                        <Button
                                            color="red"
                                            onClick={() => onKickStream(stream)}
                                            size="compact-sm"
                                            type="button"
                                            variant="subtle"
                                        >
                                            Kick publisher
                                        </Button>
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
            <Title order={2}>Streams</Title>
            {readOnly ? null : (
                <Paper p="md" radius="md" withBorder>
                    <form onSubmit={onSubmit}>
                        <Stack gap="md">
                            <SimpleGrid cols={{ base: 1, sm: 3 }}>
                                <NativeSelect
                                    aria-label="Stream language"
                                    label="Stream language"
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
                                </NativeSelect>
                                <TextInput
                                    aria-label="Stream display order"
                                    label="Stream display order"
                                    onChange={(event) =>
                                        onChange({ ...form, displayOrder: event.target.value })
                                    }
                                    type="number"
                                    required
                                    value={form.displayOrder}
                                />
                                <Group align="end">
                                    <Button disabled={!form.languageCode} type="submit">
                                        Create stream
                                    </Button>
                                </Group>
                            </SimpleGrid>
                        </Stack>
                    </form>
                </Paper>
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
                                    <Button
                                        onClick={() => onToggle(stream)}
                                        size="compact-sm"
                                        variant="light"
                                        type="button"
                                    >
                                        {stream.isActive ? 'Deactivate' : 'Activate'}{' '}
                                        {stream.languageName}
                                    </Button>
                                </td>
                            )}
                            {readOnly ? null : (
                                <td>
                                    <Button
                                        color="red"
                                        onClick={() => onDelete(stream)}
                                        size="compact-sm"
                                        type="button"
                                        variant="subtle"
                                    >
                                        Delete {stream.languageName} stream
                                    </Button>
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
            <Group justify="space-between" mb="md">
                <Title order={2}>Translators</Title>
                <Group gap="xs">
                    <Text c="dimmed" size="xs" style={{ wordBreak: 'break-all' }}>
                        {translatorUrl}
                    </Text>
                    <Button
                        onClick={() => void navigator.clipboard.writeText(translatorUrl)}
                        type="button"
                        variant="default"
                    >
                        Copy
                    </Button>
                </Group>
            </Group>
            {readOnly ? null : (
                <Paper p="md" radius="md" withBorder>
                    <form onSubmit={onSubmit}>
                        <SimpleGrid cols={{ base: 1, sm: 4 }}>
                            <TextInput
                                aria-label="Translator email"
                                autoComplete="off"
                                label="Translator email"
                                onChange={(event) =>
                                    onChange({ ...form, email: event.target.value })
                                }
                                placeholder="name@example.com"
                                required
                                type="email"
                                value={form.email}
                            />
                            <TextInput
                                aria-label="Translator name"
                                label="Translator name"
                                onChange={(event) =>
                                    onChange({ ...form, name: event.target.value })
                                }
                                required
                                value={form.name}
                            />
                            <TextInput
                                aria-label="Translator password"
                                autoComplete="new-password"
                                label="Translator password"
                                onChange={(event) =>
                                    onChange({ ...form, password: event.target.value })
                                }
                                required
                                type="password"
                                value={form.password}
                            />
                            <Group align="end">
                                <Button type="submit">Create translator</Button>
                            </Group>
                        </SimpleGrid>
                    </form>
                </Paper>
            )}
            <div className="admin-list">
                {translators.map((translator) => (
                    <Paper
                        component="article"
                        className={`admin-translator-card ${
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
                        p="md"
                        radius="md"
                        withBorder
                    >
                        <Title order={3}>{translator.name}</Title>
                        {sessionStateByTranslator[translator.id]?.sessions.some(
                            (session) => session.isPublishing,
                        ) ? (
                            <span className="admin-sr-only">Currently publishing</span>
                        ) : null}
                        <Text c="dimmed" size="sm">
                            {translator.email}
                        </Text>
                        {translator.assignments.length === 0 ? (
                            <Text>No assignments</Text>
                        ) : (
                            <Group gap="xs">
                                {translator.assignments.map((assignment) => (
                                    <Badge
                                        key={assignment.streamId}
                                        rightSection={
                                            readOnly ? null : (
                                                <button
                                                    aria-label={`Remove ${assignment.languageName} from ${translator.name}`}
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
                                            )
                                        }
                                        variant="light"
                                    >
                                        {assignment.languageName}
                                    </Badge>
                                ))}
                            </Group>
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
                                                                    <Button
                                                                        color="red"
                                                                        onClick={() =>
                                                                            void handleEndSession(
                                                                                translator,
                                                                                session,
                                                                            )
                                                                        }
                                                                        size="compact-sm"
                                                                        type="button"
                                                                        variant="subtle"
                                                                    >
                                                                        End session
                                                                    </Button>
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
                                                <Button
                                                    color="red"
                                                    onClick={() =>
                                                        void handleEndAllSessions(translator)
                                                    }
                                                    size="compact-sm"
                                                    type="button"
                                                    variant="subtle"
                                                >
                                                    End all sessions
                                                </Button>
                                            )}
                                        </div>
                                    </>
                                ) : null}
                            </div>
                        </details>
                        {readOnly ? null : (
                            <div className="admin-actions">
                                <Button
                                    onClick={() => onRename(translator)}
                                    type="button"
                                    variant="default"
                                >
                                    Rename {translator.name}
                                </Button>
                                <Button
                                    onClick={() => onResetPassword(translator)}
                                    type="button"
                                    variant="default"
                                >
                                    Reset password
                                </Button>
                                <Button
                                    color="red"
                                    onClick={() => onDelete(translator)}
                                    type="button"
                                    variant="subtle"
                                >
                                    Delete {translator.name}
                                </Button>
                                {streams
                                    .filter(
                                        (stream) =>
                                            !translator.assignments.some(
                                                (assignment) => assignment.streamId === stream.id,
                                            ),
                                    )
                                    .map((stream) => (
                                        <Button
                                            key={stream.id}
                                            onClick={() => onAddAssignment(translator, stream)}
                                            type="button"
                                            variant="default"
                                        >
                                            Assign {stream.languageName} to {translator.name}
                                        </Button>
                                    ))}
                            </div>
                        )}
                    </Paper>
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
                <Group justify="space-between" mb="md">
                    <Title order={2}>Listener report</Title>
                    {rangeLabel ? (
                        <Button
                            size="compact-sm"
                            type="button"
                            onClick={onRangeChipClick}
                            variant="light"
                        >
                            {rangeLabel}
                        </Button>
                    ) : null}
                </Group>
                <Group justify="space-between" mb="md">
                    <Title order={3}>Listener access</Title>
                    <Button
                        aria-label="Refresh access counts"
                        disabled={accessSummaryFetching}
                        loading={accessSummaryFetching}
                        onClick={onRefreshAccessSummary}
                        type="button"
                        variant="default"
                    >
                        Refresh
                    </Button>
                </Group>
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
                <Paper p="md" radius="md" withBorder>
                    {reportOpen && !report ? <p>Loading listener report...</p> : null}
                    {reportOpen && report ? (
                        <>
                            <div className="admin-filter-bar">
                                <div className="admin-filter-row">
                                    <Stack
                                        component="fieldset"
                                        className="admin-filter-states"
                                        gap="xs"
                                    >
                                        <legend>State</legend>
                                        {LISTENER_STATE_OPTIONS.map((s) => (
                                            <Checkbox
                                                key={s}
                                                label={s}
                                                checked={filters.states.includes(s)}
                                                onChange={(e) =>
                                                    toggleState(s, e.currentTarget.checked)
                                                }
                                            />
                                        ))}
                                    </Stack>
                                    <Stack
                                        component="fieldset"
                                        className="admin-filter-states"
                                        gap="xs"
                                    >
                                        <legend>Approval status</legend>
                                        {LISTENER_APPROVAL_STATUS_OPTIONS.map((status) => (
                                            <Checkbox
                                                key={status}
                                                label={status}
                                                checked={filters.approvalStatuses.includes(status)}
                                                onChange={(event) =>
                                                    toggleApprovalStatus(
                                                        status,
                                                        event.currentTarget.checked,
                                                    )
                                                }
                                            />
                                        ))}
                                    </Stack>
                                    {filtersActive ? (
                                        <Button
                                            type="button"
                                            onClick={onClearFilters}
                                            variant="default"
                                        >
                                            Clear all filters
                                        </Button>
                                    ) : null}
                                </div>
                                <div className="admin-filter-row">
                                    <NativeSelect
                                        aria-label="Language"
                                        label="Language"
                                        value={filters.streamId}
                                        onChange={(e) =>
                                            onFilterChange({ streamId: e.target.value })
                                        }
                                        data={[
                                            { label: 'All languages', value: '' },
                                            ...detail.streams.map((stream) => ({
                                                label: stream.languageName,
                                                value: stream.id,
                                            })),
                                        ]}
                                    />
                                    <NativeSelect
                                        aria-label="Device"
                                        label="Device"
                                        value={filters.deviceLabel}
                                        onChange={(e) =>
                                            onFilterChange({ deviceLabel: e.target.value })
                                        }
                                        data={[
                                            { label: 'All devices', value: '' },
                                            ...LISTENER_DEVICE_LABELS.map((d) => ({
                                                label: d,
                                                value: d,
                                            })),
                                        ]}
                                    />
                                </div>
                            </div>

                            <div className="admin-report-meta">
                                <p role="status" aria-live="polite">
                                    {countText}
                                </p>
                                <Button type="button" onClick={onDownloadCsv} variant="default">
                                    Download CSV
                                </Button>
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
                                                            ? `${connection.approvedVia ?? '—'} · approver`
                                                            : '—'}
                                                    </td>
                                                    {readOnly ? null : (
                                                        <td>
                                                            {connection.approvalStatus &&
                                                            connection.approvalStatus !==
                                                                'revoked' ? (
                                                                <Button
                                                                    color="red"
                                                                    onClick={() => {
                                                                        setRevokeError(null);
                                                                        setRevokeTarget(connection);
                                                                    }}
                                                                    size="compact-sm"
                                                                    type="button"
                                                                    variant="subtle"
                                                                >
                                                                    Revoke
                                                                </Button>
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
                                <Button
                                    type="button"
                                    onClick={() => onPageChange(page - 1)}
                                    disabled={page <= 1}
                                >
                                    &larr; Prev
                                </Button>
                                <Text className="admin-pagination-info">
                                    Page {page} of {totalPages}
                                </Text>
                                <Button
                                    type="button"
                                    onClick={() => onPageChange(page + 1)}
                                    disabled={page >= totalPages}
                                >
                                    Next &rarr;
                                </Button>
                            </div>
                        </>
                    ) : null}
                </Paper>
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
                    message="Revoke access for this device? They'll need a approver to re-approve them."
                    confirmLabel="Revoke access"
                    pending={revokePending}
                    error={revokeError}
                />
            </section>
        </AdminUiProvider>
    );
}
