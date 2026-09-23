import { apiClient } from './client';

export type ProgramStatus = 'draft' | 'live' | 'archived';

export interface AdminProgram {
    id: string;
    slug: string;
    name: string;
    venue: string;
    eventDate: string;
    status: ProgramStatus;
    adminNotes: string;
    accessControlEnabled: boolean;
    createdAt: string;
    updatedAt: string;
    firstLiveAt: string | null;
}

export interface AdminStream {
    id: string;
    languageName: string;
    languageCode: string;
    displayOrder: number;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
}

export type AdminRole = 'platform_admin' | 'org_admin' | 'viewer';

export interface AdminMe {
    id: string;
    email: string;
    role: AdminRole;
    orgId: string | null;
    orgName: string | null;
}

export interface AdminOrg {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
}

export interface AdminTranslatorAssignment {
    streamId: string;
    languageName: string;
    languageCode: string;
}

export interface AdminTranslator {
    id: string;
    email: string;
    name: string;
    assignments: AdminTranslatorAssignment[];
}

export interface AdminUser {
    id: string;
    email: string;
    role: AdminRole;
    orgId: string | null;
    isDisabled: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface TranslatorSessionSummary {
    sessionId: string;
    deviceLabel: string;
    loginAt: string;
    lastActiveAt: string;
    isPublishing: boolean;
}

export interface AdminProgramList {
    programs: AdminProgram[];
}

export interface AdminProgramDetail {
    program: AdminProgram;
    streams: AdminStream[];
    translators: AdminTranslator[];
    urls: {
        listenerUrl: string;
        translatorUrl: string;
        volunteerUrl: string;
    };
    qrPayload: string;
    suggestedQrFilename: string;
}

export interface AdminProgramVolunteerAccess {
    configured: boolean;
    loginId: string | null;
    passwordUpdatedAt: string | null;
    activeSessionCount: number;
}

export interface AdminProgramVolunteerAccessUpdate extends AdminProgramVolunteerAccess {
    generatedPassword?: string;
}

export interface AdminProgramStatus {
    programId: string;
    totalActiveListeners: number;
    streams: Array<{
        id: string;
        languageName: string;
        languageCode: string;
        isActive: boolean;
        state: 'live' | 'silent' | 'offline';
        activeListeners: number;
    }>;
    stale: boolean;
    degraded: boolean;
    updatedAt: string | null;
    serverTime: string;
}

export interface AdminListenerReport {
    connections: Array<{
        id: string;
        programId: string;
        streamId: string;
        clientId: string;
        subscriptionStatus: string;
        connectedAt: string | null;
        disconnectedAt: string | null;
        disconnectReason: string | null;
        listenerIp: string;
        userAgent: string;
        lastSeenAt: string | null;
        deviceLabel: string;
        deviceModel: string | null;
        deviceModelName: string | null;
        platform: string | null;
        platformVersion: string | null;
        browserFullVersion: string | null;
        approvalStatus: ListenerApprovalStatus | null;
        approvedAt: string | null;
        approvedVia: 'scan' | 'code' | null;
        hasRevokedHistory: boolean;
    }>;
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

export type ListenerApprovalStatus = 'pending' | 'approved' | 'revoked' | 'superseded';

export interface AdminListenerAccessSummary {
    pending: number;
    approved: number;
    revoked: number;
}

export interface ListenerReportQuery {
    states?: string[];
    approvalStatuses?: ListenerApprovalStatus[];
    streamId?: string;
    deviceLabel?: string;
    createdFrom?: string;
    createdTo?: string;
    page?: number;
}

export interface ReportDateRangeQuery {
    from?: string;
    to?: string;
}

export interface EventFeedQuery {
    range?: ReportDateRangeQuery | undefined;
    eventTypes?: string[] | undefined;
    translatorId?: string | undefined;
    page?: number;
    pageSize?: number;
}

export const LISTENER_DEVICE_LABELS = [
    'Edge on Windows',
    'Chrome on iPhone',
    'Chrome on iPad',
    'Chrome on Windows',
    'Chrome on macOS',
    'Chrome on Android',
    'Firefox on Windows',
    'Safari on iPhone',
    'Safari on iPad',
    'Safari on macOS',
    'Unknown device',
] as const;

export interface AdminReportStreamSummary {
    streamId: string;
    languageName: string;
    languageCode: string;
    activeListeners: number;
    totalConnections: number;
    dropouts: number;
    reconnects: number;
}

export interface AdminReportSummary {
    programId: string;
    totals: {
        activeListeners: number;
        totalConnections: number;
        uniqueDevices: number;
        dropouts: number;
        reconnects: number;
    };
    streams: AdminReportStreamSummary[];
    generatedAt: string;
    presenceSource: 'durable_object' | 'archived_snapshot';
}

export interface AdminEventFeedEntry {
    id: string;
    eventType: string;
    occurredAt: string;
    translatorName: string | null;
    translatorDeviceLabel: string | null;
    stream: {
        id: string;
        languageName: string;
        languageCode: string;
    } | null;
    metadata: {
        reason?: string;
        translatorId?: string;
        connectionId?: string;
    };
}

export interface AdminEventFeed {
    events: AdminEventFeedEntry[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

export type ReadinessItemId =
    | 'program_setup'
    | 'streams'
    | 'translator_assignments'
    | 'qr_generated'
    | 'realtime_configured'
    | 'turn_configured'
    | 'turn_analytics_tagging'
    | 'realtime_smoke_tested'
    | 'mobile_field_tested';

export type ReadinessStatus = 'green' | 'warning' | 'blocker';

export type ConfirmableReadinessItemId = 'realtime_smoke_tested' | 'mobile_field_tested';

export interface AdminReadinessItem {
    id: ReadinessItemId;
    label: string;
    status: ReadinessStatus;
    detail: string;
    checkedAt?: string;
}

export interface AdminReadiness {
    programId: string;
    items: AdminReadinessItem[];
}

export interface AdminRetentionRun {
    programId: string;
    processed: boolean;
    anonymizedConnections: number;
    retentionProcessedAt: string | null;
}

export interface CreateProgramPayload {
    slug: string;
    name: string;
    venue: string;
    eventDate: string;
    adminNotes: string;
    accessControlEnabled: boolean;
}

export interface UpdateProgramPayload {
    name?: string;
    venue?: string;
    eventDate?: string;
    adminNotes?: string;
    status?: ProgramStatus;
    nextSlug?: string;
    accessControlEnabled?: boolean;
}

export interface CreateStreamPayload {
    languageName: string;
    languageCode: string;
    displayOrder: number;
    isActive: boolean;
}

export interface UpdateStreamPayload {
    languageName?: string;
    languageCode?: string;
    displayOrder?: number;
    isActive?: boolean;
}

export interface CreateTranslatorPayload {
    email: string;
    name: string;
    password: string;
}

export interface AdminApi {
    login(email: string, password: string): Promise<{ ok: true }>;
    logout(): Promise<{ ok: true }>;
    me(): Promise<AdminMe>;
    listPrograms(): Promise<AdminProgramList>;
    listDeletedPrograms(): Promise<AdminProgram[]>;
    listOrgs(): Promise<{ orgs: AdminOrg[] }>;
    createOrg(payload: {
        orgName: string;
        email: string;
        tempPassword: string;
    }): Promise<{ org: AdminOrg; admin: AdminUser }>;
    updateOrg(id: string, payload: { name: string }): Promise<AdminOrg>;
    listUsers(): Promise<{ users: AdminUser[] }>;
    createUser(payload: {
        email: string;
        role: AdminRole;
        tempPassword: string;
        orgId?: string | null;
    }): Promise<AdminUser>;
    updateUser(id: string, payload: { isDisabled?: boolean; role?: AdminRole }): Promise<AdminUser>;
    resetUserPassword(id: string, payload: { newPassword: string }): Promise<{ ok: true }>;
    createProgram(payload: CreateProgramPayload): Promise<AdminProgram>;
    updateProgram(programId: string, payload: UpdateProgramPayload): Promise<AdminProgramDetail>;
    archiveProgram(programId: string): Promise<AdminProgramDetail>;
    deleteProgram(programId: string): Promise<void>;
    restoreProgram(programId: string): Promise<void>;
    getProgramDetail(programId: string): Promise<AdminProgramDetail>;
    getVolunteerAccess(programId: string): Promise<AdminProgramVolunteerAccess>;
    updateVolunteerAccess(
        programId: string,
        payload: { loginId: string; password?: string },
    ): Promise<AdminProgramVolunteerAccessUpdate>;
    getProgramStatus(programId: string): Promise<AdminProgramStatus>;
    getListenerReport(programId: string, query?: ListenerReportQuery): Promise<AdminListenerReport>;
    getListenerAccessSummary(programId: string): Promise<AdminListenerAccessSummary>;
    revokeListenerAccess(programId: string, clientId: string): Promise<{ revoked: number }>;
    getReportSummary(programId: string, range?: ReportDateRangeQuery): Promise<AdminReportSummary>;
    getEventFeed(programId: string, opts?: EventFeedQuery | number): Promise<AdminEventFeed>;
    downloadListenerReportCsv(
        programId: string,
        query?: Omit<ListenerReportQuery, 'page'>,
    ): Promise<Blob>;
    runRetention(programId: string): Promise<AdminRetentionRun>;
    changeMyPassword(payload: {
        currentPassword?: string;
        newPassword: string;
    }): Promise<{ ok: true }>;
    getReadiness(programId: string): Promise<AdminReadiness>;
    confirmReadiness(
        programId: string,
        itemId: ConfirmableReadinessItemId,
    ): Promise<AdminReadiness>;
    createStream(programId: string, payload: CreateStreamPayload): Promise<AdminStream>;
    updateStream(
        programId: string,
        streamId: string,
        payload: UpdateStreamPayload,
    ): Promise<AdminStream>;
    deleteStream(programId: string, streamId: string): Promise<void>;
    createTranslator(programId: string, payload: CreateTranslatorPayload): Promise<AdminTranslator>;
    updateTranslator(
        programId: string,
        translatorId: string,
        payload: { name: string },
    ): Promise<AdminTranslator>;
    resetTranslatorPassword(
        programId: string,
        translatorId: string,
        password: string,
    ): Promise<AdminTranslator>;
    deleteTranslator(programId: string, translatorId: string): Promise<void>;
    addTranslatorAssignment(
        programId: string,
        translatorId: string,
        streamId: string,
    ): Promise<AdminTranslator>;
    removeTranslatorAssignment(
        programId: string,
        translatorId: string,
        streamId: string,
    ): Promise<AdminTranslator>;
    getTranslatorSessions?(
        programId: string,
        translatorId: string,
    ): Promise<{ sessions: TranslatorSessionSummary[] }>;
    revokeSession?(
        programId: string,
        translatorId: string,
        sessionId: string,
    ): Promise<{ ok: boolean }>;
    revokeAllSessions?(programId: string, translatorId: string): Promise<{ ok: boolean }>;
    kickPublisher?(
        programId: string,
        streamId: string,
        signOut: boolean,
    ): Promise<{ freed: boolean }>;
}

function programPath(programId: string): string {
    return `/api/admin/programs/${encodeURIComponent(programId)}`;
}

function streamPath(programId: string, streamId: string): string {
    return `${programPath(programId)}/streams/${encodeURIComponent(streamId)}`;
}

function translatorPath(programId: string, translatorId: string): string {
    return `${programPath(programId)}/translators/${encodeURIComponent(translatorId)}`;
}

export interface AdminHttpClient {
    get<T>(path: string, options?: { noStore?: boolean }): Promise<T>;
    post<T>(path: string, body?: unknown): Promise<T>;
    put<T>(path: string, body?: unknown): Promise<T>;
    patch<T>(path: string, body?: unknown): Promise<T>;
    delete<T = void>(path: string): Promise<T>;
    getBlob(path: string): Promise<Blob>;
}

export function createAdminApi(client: AdminHttpClient = apiClient): AdminApi {
    return {
        login(email: string, password: string) {
            return client.post<{ ok: true }>('/api/admin/login', {
                email,
                password,
            });
        },
        logout() {
            return client.post<{ ok: true }>('/api/admin/logout');
        },
        me() {
            return client.get<AdminMe>('/api/admin/me');
        },
        listPrograms() {
            return client.get<AdminProgramList>('/api/admin/programs');
        },
        listDeletedPrograms() {
            return client
                .get<AdminProgramList>('/api/admin/programs?deleted=true')
                .then((response) => response.programs);
        },
        listOrgs() {
            return client.get<{ orgs: AdminOrg[] }>('/api/admin/orgs');
        },
        createOrg(p: { orgName: string; email: string; tempPassword: string }) {
            return client.post<{ org: AdminOrg; admin: AdminUser }>('/api/admin/orgs', p);
        },
        updateOrg(id: string, p: { name: string }) {
            return client.patch<AdminOrg>(`/api/admin/orgs/${encodeURIComponent(id)}`, p);
        },
        listUsers() {
            return client.get<{ users: AdminUser[] }>('/api/admin/users');
        },
        createUser(p: {
            email: string;
            role: AdminRole;
            tempPassword: string;
            orgId?: string | null;
        }) {
            return client.post<AdminUser>('/api/admin/users', p);
        },
        updateUser(id: string, p: { isDisabled?: boolean; role?: AdminRole }) {
            return client.patch<AdminUser>(`/api/admin/users/${encodeURIComponent(id)}`, p);
        },
        resetUserPassword(id: string, p: { newPassword: string }) {
            return client.post<{ ok: true }>(
                `/api/admin/users/${encodeURIComponent(id)}/password`,
                p,
            );
        },
        createProgram(payload: CreateProgramPayload) {
            return client.post<AdminProgram>('/api/admin/programs', payload);
        },
        updateProgram(programId: string, payload: UpdateProgramPayload) {
            return client.patch<AdminProgramDetail>(programPath(programId), payload);
        },
        archiveProgram(programId: string) {
            return client.post<AdminProgramDetail>(`${programPath(programId)}/archive`);
        },
        deleteProgram(programId: string) {
            return client.delete(programPath(programId));
        },
        restoreProgram(programId: string) {
            return client.post<void>(`${programPath(programId)}/restore`);
        },
        getProgramDetail(programId: string) {
            return client.get<AdminProgramDetail>(programPath(programId));
        },
        getVolunteerAccess(programId: string) {
            return client.get<AdminProgramVolunteerAccess>(
                `${programPath(programId)}/volunteer-access`,
            );
        },
        updateVolunteerAccess(programId: string, payload: { loginId: string; password?: string }) {
            return client.put<AdminProgramVolunteerAccessUpdate>(
                `${programPath(programId)}/volunteer-access`,
                payload,
            );
        },
        getProgramStatus(programId: string) {
            return client.get<AdminProgramStatus>(`${programPath(programId)}/status`);
        },
        getListenerReport(programId: string, query?: ListenerReportQuery) {
            const params = new URLSearchParams();
            if (query?.states?.length) {
                for (const state of query.states) {
                    if (state) {
                        params.append('state', state);
                    }
                }
            }
            if (query?.approvalStatuses?.length) {
                for (const status of query.approvalStatuses) {
                    params.append('approvalStatus', status);
                }
            }
            if (query?.streamId) {
                params.append('streamId', query.streamId);
            }
            if (query?.deviceLabel) {
                params.append('device', query.deviceLabel);
            }
            if (query?.createdFrom) {
                params.append('from', query.createdFrom);
            }
            if (query?.createdTo) {
                params.append('to', query.createdTo);
            }
            if (query?.page !== undefined) {
                params.append('page', String(query.page));
            }
            const queryString = params.toString();
            return client.get<AdminListenerReport>(
                `${programPath(programId)}/listener-report${queryString ? `?${queryString}` : ''}`,
            );
        },
        getListenerAccessSummary(programId: string) {
            return client.get<AdminListenerAccessSummary>(
                `${programPath(programId)}/listener-access/summary`,
                { noStore: true },
            );
        },
        revokeListenerAccess(programId: string, clientId: string) {
            return client.post<{ revoked: number }>(
                `${programPath(programId)}/listener-access/revoke`,
                { clientId },
            );
        },
        getReportSummary(programId: string, range?: ReportDateRangeQuery) {
            const params = new URLSearchParams();
            if (range?.from) {
                params.append('from', range.from);
            }
            if (range?.to) {
                params.append('to', range.to);
            }
            const queryString = params.toString();
            return client.get<AdminReportSummary>(
                `${programPath(programId)}/report/summary${queryString ? `?${queryString}` : ''}`,
                { noStore: true },
            );
        },
        getEventFeed(programId: string, opts: EventFeedQuery | number = {}) {
            const options = typeof opts === 'number' ? { pageSize: opts } : opts;
            const params = new URLSearchParams();
            if (options.range?.from) {
                params.append('from', options.range.from);
            }
            if (options.range?.to) {
                params.append('to', options.range.to);
            }
            if (options.eventTypes?.length) {
                for (const eventType of options.eventTypes) {
                    if (eventType) {
                        params.append('eventType', eventType);
                    }
                }
            }
            if (options.translatorId) {
                params.append('translatorId', options.translatorId);
            }
            if (options.page !== undefined) {
                params.append('page', String(options.page));
            }
            if (options.pageSize !== undefined) {
                params.append('pageSize', String(options.pageSize));
            }
            const queryString = params.toString();
            return client.get<AdminEventFeed>(
                `${programPath(programId)}/events${queryString ? `?${queryString}` : ''}`,
                { noStore: true },
            );
        },
        downloadListenerReportCsv(programId: string, query?: Omit<ListenerReportQuery, 'page'>) {
            const params = new URLSearchParams();
            if (query?.states?.length) {
                for (const state of query.states) {
                    if (state) {
                        params.append('state', state);
                    }
                }
            }
            if (query?.approvalStatuses?.length) {
                for (const status of query.approvalStatuses) {
                    params.append('approvalStatus', status);
                }
            }
            if (query?.streamId) {
                params.append('streamId', query.streamId);
            }
            if (query?.deviceLabel) {
                params.append('device', query.deviceLabel);
            }
            if (query?.createdFrom) {
                params.append('from', query.createdFrom);
            }
            if (query?.createdTo) {
                params.append('to', query.createdTo);
            }
            const queryString = params.toString();
            return client.getBlob(
                `${programPath(programId)}/listener-report.csv${queryString ? `?${queryString}` : ''}`,
            );
        },
        runRetention(programId: string) {
            return client.post<AdminRetentionRun>(`${programPath(programId)}/retention/run`);
        },
        changeMyPassword(payload: { currentPassword?: string; newPassword: string }) {
            return client.post<{ ok: true }>('/api/admin/me/password', payload);
        },
        getReadiness(programId: string) {
            return client.get<AdminReadiness>(`${programPath(programId)}/readiness`);
        },
        confirmReadiness(programId: string, itemId: ConfirmableReadinessItemId) {
            return client.post<AdminReadiness>(`${programPath(programId)}/readiness/confirm`, {
                itemId,
            });
        },
        createStream(programId: string, payload: CreateStreamPayload) {
            return client.post<AdminStream>(`${programPath(programId)}/streams`, payload);
        },
        updateStream(programId: string, streamId: string, payload: UpdateStreamPayload) {
            return client.patch<AdminStream>(streamPath(programId, streamId), payload);
        },
        deleteStream(programId: string, streamId: string) {
            return client.delete(streamPath(programId, streamId));
        },
        createTranslator(programId: string, payload: CreateTranslatorPayload) {
            return client.post<AdminTranslator>(`${programPath(programId)}/translators`, payload);
        },
        updateTranslator(programId: string, translatorId: string, payload: { name: string }) {
            return client.patch<AdminTranslator>(translatorPath(programId, translatorId), payload);
        },
        resetTranslatorPassword(programId: string, translatorId: string, password: string) {
            return client.post<AdminTranslator>(
                `${translatorPath(programId, translatorId)}/reset-password`,
                { password },
            );
        },
        deleteTranslator(programId: string, translatorId: string) {
            return client.delete(translatorPath(programId, translatorId));
        },
        addTranslatorAssignment(programId: string, translatorId: string, streamId: string) {
            return client.post<AdminTranslator>(
                `${translatorPath(programId, translatorId)}/assignments`,
                { streamId },
            );
        },
        removeTranslatorAssignment(programId: string, translatorId: string, streamId: string) {
            return client.delete<AdminTranslator>(
                `${translatorPath(programId, translatorId)}/assignments/${encodeURIComponent(
                    streamId,
                )}`,
            );
        },
        getTranslatorSessions(programId: string, translatorId: string) {
            return client.get<{ sessions: TranslatorSessionSummary[] }>(
                `${translatorPath(programId, translatorId)}/sessions`,
            );
        },
        revokeSession(programId: string, translatorId: string, sessionId: string) {
            return client.delete<{ ok: boolean }>(
                `${translatorPath(programId, translatorId)}/sessions/${encodeURIComponent(
                    sessionId,
                )}`,
            );
        },
        revokeAllSessions(programId: string, translatorId: string) {
            return client.delete<{ ok: boolean }>(
                `${translatorPath(programId, translatorId)}/sessions`,
            );
        },
        kickPublisher(programId: string, streamId: string, signOut: boolean) {
            return client.post<{ freed: boolean }>(
                `${streamPath(programId, streamId)}/kick-publisher`,
                { signOut },
            );
        },
    };
}

export const adminApi = createAdminApi();
