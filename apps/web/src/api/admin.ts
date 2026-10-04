import { apiClient } from './client';

export interface AdminProgram {
    id: string;
    slug: string;
    name: string;
    startDate?: string;
    endDate?: string | null;
    accessControlEnabled: boolean;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
    deletedAt?: string | null;
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

export type AdminRole = 'admin' | 'user';

export interface AdminMe {
    id: string;
    username: string;
    role: AdminRole;
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
    username: string;
    role: AdminRole;
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
        approverUrl: string;
    };
    qrPayload: string;
    suggestedQrFilename: string;
}

export interface AdminProgramApproverAccess {
    configured: boolean;
    passwordUpdatedAt: string | null;
    activeSessionCount: number;
}

export interface AdminProgramApproverAccessUpdate extends AdminProgramApproverAccess {
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
    presenceSource: 'durable_object';
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

export interface AdminRetentionRun {
    programId: string;
    processed: boolean;
    anonymizedConnections: number;
    retentionProcessedAt: string | null;
}

export interface CreateProgramPayload {
    slug: string;
    name: string;
    startDate?: string;
    endDate?: string;
    accessControlEnabled: boolean;
    createdBy?: string;
}

export interface UpdateProgramPayload {
    name?: string;
    startDate?: string;
    endDate?: string;
    slug?: string;
    accessControlEnabled?: boolean;
    createdBy?: string;
}

export interface CreateStreamPayload {
    languageName: string;
    languageCode: string;
    displayOrder: number;
    isActive: boolean;
    translatorPassword?: string;
}

export interface UpdateStreamPayload {
    languageName?: string;
    languageCode?: string;
    displayOrder?: number;
    isActive?: boolean;
}

export interface AdminApi {
    login(username: string, password: string): Promise<{ ok: true }>;
    logout(): Promise<{ ok: true }>;
    me(): Promise<AdminMe>;
    listPrograms(): Promise<AdminProgramList>;
    listDeletedPrograms(): Promise<AdminProgram[]>;
    listUsers(): Promise<{ users: AdminUser[] }>;
    createUser(payload: {
        username: string;
        role: AdminRole;
        password: string;
    }): Promise<AdminUser>;
    updateUser(id: string, payload: { username?: string; role?: AdminRole }): Promise<AdminUser>;
    deleteUser(id: string): Promise<void>;
    resetUserPassword(id: string, payload: { newPassword: string }): Promise<{ ok: true }>;
    createProgram(payload: CreateProgramPayload): Promise<AdminProgram>;
    updateProgram(programId: string, payload: UpdateProgramPayload): Promise<AdminProgramDetail>;
    deleteProgram(programId: string): Promise<void>;
    restoreProgram(programId: string): Promise<void>;
    getProgramDetail(programId: string): Promise<AdminProgramDetail>;
    getApproverAccess(programId: string): Promise<AdminProgramApproverAccess>;
    updateApproverAccess(
        programId: string,
        payload: { password?: string },
    ): Promise<AdminProgramApproverAccessUpdate>;
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
    createStream(programId: string, payload: CreateStreamPayload): Promise<AdminStream>;
    updateStream(
        programId: string,
        streamId: string,
        payload: UpdateStreamPayload,
    ): Promise<AdminStream>;
    deleteStream(programId: string, streamId: string): Promise<void>;
    resetLanguagePassword(
        programId: string,
        streamId: string,
        password: string,
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
        login(username: string, password: string) {
            return client.post<{ ok: true }>('/api/admin/login', {
                username,
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
        listUsers() {
            return client.get<{ users: AdminUser[] }>('/api/admin/users');
        },
        createUser(p: { username: string; role: AdminRole; password: string }) {
            return client.post<AdminUser>('/api/admin/users', p);
        },
        updateUser(id: string, p: { username?: string; role?: AdminRole }) {
            return client.patch<AdminUser>(`/api/admin/users/${encodeURIComponent(id)}`, p);
        },
        deleteUser(id: string) {
            return client.delete(`/api/admin/users/${encodeURIComponent(id)}`);
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
        deleteProgram(programId: string) {
            return client.delete(programPath(programId));
        },
        restoreProgram(programId: string) {
            return client.post<void>(`${programPath(programId)}/restore`);
        },
        getProgramDetail(programId: string) {
            return client.get<AdminProgramDetail>(programPath(programId));
        },
        getApproverAccess(programId: string) {
            return client.get<AdminProgramApproverAccess>(
                `${programPath(programId)}/approver-access`,
            );
        },
        updateApproverAccess(programId: string, payload: { password?: string }) {
            return client.put<AdminProgramApproverAccessUpdate>(
                `${programPath(programId)}/approver-access`,
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
        createStream(programId: string, payload: CreateStreamPayload) {
            return client.post<AdminStream>(`${programPath(programId)}/streams`, payload);
        },
        updateStream(programId: string, streamId: string, payload: UpdateStreamPayload) {
            return client.patch<AdminStream>(streamPath(programId, streamId), payload);
        },
        deleteStream(programId: string, streamId: string) {
            return client.delete(streamPath(programId, streamId));
        },
        resetLanguagePassword(programId: string, streamId: string, password: string) {
            return client.post<AdminTranslator>(
                `${streamPath(programId, streamId)}/reset-password`,
                { password },
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
