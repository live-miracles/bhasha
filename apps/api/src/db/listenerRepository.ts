import {
    type AdminEventFeedResponse,
    parseMetadataObject,
    RETENTION_REDACTED_VALUE,
    sanitizeEventMetadata,
} from '../domain/reports';
import { deviceLabelFromUserAgent } from '../domain/deviceLabel';
import { deviceModelNameFromCode } from '../domain/deviceModelName';
import type { ListenerAccessStatus } from './listenerAccessRepository';
import type { Database } from './sqlite';

export type ListenerSubscriptionStatus = 'requested' | 'connected' | 'disconnected' | 'failed';

export interface ListenerConnectionRecord {
    id: string;
    programId: string;
    streamId: string;
    clientId: string;
    subscriptionStatus: ListenerSubscriptionStatus;
    connectedAt: string | null;
    disconnectedAt: string | null;
    disconnectReason: string | null;
    cloudflareSessionId: string | null;
    cloudflareTrackMid: string | null;
    listenerIp: string;
    userAgent: string;
    switchFromConnectionId: string | null;
    reconnectOfConnectionId: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface ListenerReportConnection {
    id: string;
    programId: string;
    streamId: string;
    clientId: string;
    subscriptionStatus: ListenerSubscriptionStatus;
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
    approvalStatus: ListenerAccessStatus | null;
    approvedAt: string | null;
    approvedVia: 'scan' | 'code' | null;
    hasRevokedHistory: boolean;
}

export interface ListenerClientHints {
    deviceModel?: string;
    platform?: string;
    platformVersion?: string;
    browserFullVersion?: string;
}

export interface ListenerReportFilters {
    states?: ListenerSubscriptionStatus[];
    streamId?: string;
    deviceLabel?: string;
    createdFrom?: string;
    createdTo?: string;
    approvalStatuses?: ListenerAccessStatus[];
}

export interface ReportDateRange {
    from?: string;
    to?: string;
}

export interface ProgramEventPageOptions {
    range?: ReportDateRange;
    eventTypes?: string[];
    translatorId?: string;
    page?: number;
    pageSize?: number;
}

export interface ProgramEventPage {
    events: AdminEventFeedResponse['events'];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

export interface ListenerReportCsvResult {
    connections: ListenerReportConnection[];
    truncated: boolean;
}

export interface ActiveListenerStreamCount {
    streamId: string;
    count: number;
}

export interface ActiveListenerCounts {
    total: number;
    streams: ActiveListenerStreamCount[];
}

export interface ListenerRealtimeCleanupTarget {
    id: string;
    programId: string;
    streamId: string;
    cloudflareSessionId: string | null;
    cloudflareTrackMid: string | null;
    subscriptionStatus: ListenerSubscriptionStatus;
}

// Must be >= ~2.5x the client heartbeat interval (90s) so a missed beat never false-drops a
// live listener. Widened to 240s in Phase 10 alongside the 90s heartbeat (request-rate cut);
// only consumed by the admin count, so this just sets admin count staleness to ~4 min (admin-only).
export const ACTIVE_LISTENER_WINDOW_SECONDS = 240;
export const MAX_CSV_ROWS = 50000;

const LISTENER_ACCESS_REPORT_JOIN = `LEFT JOIN (
  SELECT
    la.program_id,
    la.client_id,
    la.status,
    la.approved_at,
    la.approved_via,
    MAX(CASE WHEN la.status = 'revoked' THEN 1 ELSE 0 END) OVER (
      PARTITION BY la.program_id, la.client_id
    ) AS has_revoked_history,
    ROW_NUMBER() OVER (
      PARTITION BY la.program_id, la.client_id
      ORDER BY
        CASE
          WHEN la.status = 'approved' AND la.access_token_hash IS NOT NULL THEN 0
          WHEN la.status = 'revoked' THEN 1
          WHEN la.status = 'pending' THEN 2
          WHEN la.status = 'superseded' THEN 3
          ELSE 4
        END,
        la.created_at DESC,
        la.id DESC
    ) AS report_rank
  FROM listener_access la
  WHERE la.program_id = ?
) report_access
  ON report_access.program_id = lc.program_id
  AND report_access.client_id = lc.client_id
  AND report_access.report_rank = 1`;

type ListenerReportQueryRow = Omit<
    ListenerReportConnection,
    'deviceLabel' | 'hasRevokedHistory'
> & {
    deviceLabel: string | null;
    hasRevokedHistory: number | null;
};

function mapListenerReportRow(row: ListenerReportQueryRow): ListenerReportConnection {
    return {
        ...row,
        deviceLabel: row.deviceLabel ?? deviceLabelFromUserAgent(row.userAgent),
        deviceModelName: deviceModelNameFromCode(row.deviceModel),
        hasRevokedHistory: row.hasRevokedHistory === 1,
    };
}

type RealtimeCleanupMarker = {
    cloudflareSessionId: string;
    cloudflareTrackMid: string;
    cleanupState: 'pending' | 'closed';
};

export interface CreateListenerConnectionInput {
    programId: string;
    streamId: string;
    clientId: string;
    listenerIp: string;
    userAgent: string;
    switchFromConnectionId?: string;
    reconnectOfConnectionId?: string;
}

interface FindListenerReplacementInput {
    previousConnectionId: string;
    programId: string;
    streamId: string;
    clientId: string;
}

type ApplyConnectedUpdateResult =
    { changes: 0 } | { changes: number; connection: ListenerConnectionRecord };
type ApplyConnectedUpdateFastPathResult = { changes: number };

export class ListenerProgramNotFoundError extends Error {
    constructor() {
        super('program not found');
    }
}

export class ListenerStreamNotFoundError extends Error {
    constructor() {
        super('language stream not found');
    }
}

export class ListenerConnectionNotFoundError extends Error {
    constructor() {
        super('listener connection not found');
    }
}

export class ListenerInvalidStateError extends Error {
    constructor() {
        super('listener connection state does not allow this operation');
    }
}

export class ListenerReplacementSuccessorExistsError extends Error {
    constructor() {
        super('listener replacement successor already exists');
    }
}

export class ListenerRepository {
    constructor(private readonly db: Database) {}

    async validateRequestedConnection(input: CreateListenerConnectionInput): Promise<void> {
        await this.requireStream(input.programId, input.streamId);

        if (
            input.switchFromConnectionId &&
            !(await this.connectionExists(input.switchFromConnectionId))
        ) {
            throw new ListenerConnectionNotFoundError();
        }

        if (
            input.reconnectOfConnectionId &&
            !(await this.connectionExists(input.reconnectOfConnectionId))
        ) {
            throw new ListenerConnectionNotFoundError();
        }
    }

    async createRequestedConnection(
        input: CreateListenerConnectionInput,
    ): Promise<ListenerConnectionRecord> {
        await this.validateRequestedConnection(input);

        const connection = buildRequestedConnectionRecord(input);
        const deviceLabel = deviceLabelFromUserAgent(input.userAgent);

        try {
            this.db
                .prepare(
                    `INSERT INTO listener_connections
          (id, program_id, language_stream_id, client_id, token_issued_at,
           subscription_status, connected_at, disconnected_at, disconnect_reason,
           switch_from_connection_id, reconnect_of_connection_id, listener_ip,
           user_agent, device_label, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    connection.id,
                    connection.programId,
                    connection.streamId,
                    connection.clientId,
                    connection.createdAt,
                    connection.subscriptionStatus,
                    connection.connectedAt,
                    connection.disconnectedAt,
                    connection.disconnectReason,
                    connection.switchFromConnectionId,
                    connection.reconnectOfConnectionId,
                    connection.listenerIp,
                    connection.userAgent,
                    deviceLabel,
                    connection.createdAt,
                    connection.updatedAt,
                );
        } catch (error) {
            if (isReplacementSuccessorConstraintError(error)) {
                throw new ListenerReplacementSuccessorExistsError();
            }

            if (isReferenceConstraintError(error)) {
                throw new ListenerStreamNotFoundError();
            }
            throw error;
        }

        return connection;
    }

    async backfillDeviceLabels(batchSize = 200): Promise<{ updated: number; remaining: number }> {
        const rowsToBackfill = this.db
            .prepare(
                `SELECT id, user_agent as userAgent
        FROM listener_connections
        WHERE device_label IS NULL
        LIMIT ?`,
            )
            .all(batchSize) as Array<{ id: string; userAgent: string }>;

        if (rowsToBackfill.length > 0) {
            const backfill = this.db.transaction(() => {
                for (const row of rowsToBackfill) {
                    this.db
                        .prepare(`UPDATE listener_connections SET device_label = ? WHERE id = ?`)
                        .run(deviceLabelFromUserAgent(row.userAgent), row.id);
                }
            });
            backfill();
        }

        const remainingRow = this.db
            .prepare(
                `SELECT COUNT(*) as remaining
        FROM listener_connections
        WHERE device_label IS NULL`,
            )
            .get() as { remaining: number } | undefined;

        return {
            updated: rowsToBackfill.length,
            remaining: remainingRow?.remaining ?? 0,
        };
    }

    async markConnected(
        connectionId: string,
        clientHints: ListenerClientHints = {},
    ): Promise<{
        connection: ListenerConnectionRecord;
        changed: boolean;
    }> {
        const result = applyConnectedUpdate(this.db, connectionId, clientHints, false);

        if (!connectedUpdateChanged(result)) {
            // The ONE disambiguating read on the contended/error path.
            const existing = await this.getConnection(connectionId);
            if (!existing) {
                throw new ListenerConnectionNotFoundError();
            }

            if (existing.subscriptionStatus === 'connected') {
                return { connection: existing, changed: false };
            }

            throw new ListenerInvalidStateError();
        }

        return { connection: result.connection, changed: true };
    }

    /**
     * Records a liveness heartbeat for a connected listener by advancing
     * `last_seen_at`. A single conditional UPDATE with no preceding SELECT: the
     * `subscription_status = 'connected'` guard ensures only live connections are
     * touched. `RETURNING` yields the program and stream ids needed to refresh
     * live presence without a second read. No returned row means the connection is
     * missing or not in the `connected` state, which is signalled with
     * `ListenerInvalidStateError` (consistent with the other state-guarded
     * mutators in this repository).
     */
    async recordHeartbeat(
        connectionId: string,
        clientHints: ListenerClientHints = {},
        acceptRequested: boolean = false,
    ): Promise<{ programId: string; streamId: string }> {
        const timestamp = nowIso();
        const statusGuard = acceptRequested
            ? "subscription_status NOT IN ('disconnected','failed')"
            : "subscription_status = 'connected'";
        const result = this.db
            .prepare(
                `UPDATE listener_connections
        SET last_seen_at = ?,
            client_device_model = COALESCE(?, client_device_model),
            client_platform = COALESCE(?, client_platform),
            client_platform_version = COALESCE(?, client_platform_version),
            client_browser_full_version = COALESCE(?, client_browser_full_version),
            updated_at = ?
        WHERE id = ? AND ${statusGuard}
        RETURNING program_id AS programId, language_stream_id AS streamId`,
            )
            .get(
                timestamp,
                clientHints.deviceModel ?? null,
                clientHints.platform ?? null,
                clientHints.platformVersion ?? null,
                clientHints.browserFullVersion ?? null,
                timestamp,
                connectionId,
            ) as { programId: string; streamId: string } | undefined;

        if (!result) {
            throw new ListenerInvalidStateError();
        }

        return result;
    }

    /**
     * Counts listeners currently live on each language stream of a program. A
     * listener is "live" when it is `connected` and its `last_seen_at` falls
     * within the trailing `windowSeconds` (NULL last_seen_at is excluded by the
     * `> ?` predicate). Returns per-stream counts plus the program total.
     *
     * Backed by `idx_listener_conn_presence`
     * (program_id, subscription_status, language_stream_id, last_seen_at) so the
     * GROUP BY is satisfied from the index without a temporary B-tree sort.
     * (Range column `last_seen_at` MUST be last — see the migration comment.)
     */
    async countActiveListeners(
        programId: string,
        windowSeconds: number,
    ): Promise<ActiveListenerCounts> {
        const threshold = new Date(Date.now() - windowSeconds * 1000).toISOString();

        const results = this.db
            .prepare(
                `SELECT language_stream_id as streamId, COUNT(*) as count
        FROM listener_connections
        WHERE program_id = ?
          AND subscription_status = 'connected'
          AND last_seen_at > ?
        GROUP BY language_stream_id`,
            )
            .all(programId, threshold) as Array<{ streamId: string; count: number }>;

        const streams: ActiveListenerStreamCount[] = results.map((row) => ({
            streamId: row.streamId,
            count: row.count,
        }));
        const total = streams.reduce((sum, stream) => sum + stream.count, 0);

        return { total, streams };
    }

    async setRealtimeSession(connectionId: string, cloudflareSessionId: string): Promise<void> {
        // Single guarded UPDATE — no pre-SELECT, no post-SELECT. The WHERE guard
        // enforces the `requested` + `cloudflare_session_id IS NULL` precondition;
        // the sole caller (createSubscribeSession) discards the row. On 0 rows, one
        // disambiguating SELECT distinguishes missing (NotFound) from wrong-state
        // (InvalidState) — preserving the two-error contract the pre-SELECT enforced.
        const timestamp = nowIso();
        const result = this.db
            .prepare(
                `UPDATE listener_connections
        SET cloudflare_session_id = ?,
            updated_at = ?
        WHERE id = ?
          AND subscription_status = 'requested'
          AND cloudflare_session_id IS NULL`,
            )
            .run(cloudflareSessionId, timestamp, connectionId);

        if (result.changes === 0) {
            const existing = await this.getConnection(connectionId);
            if (!existing) {
                throw new ListenerConnectionNotFoundError();
            }
            throw new ListenerInvalidStateError();
        }
    }

    async setRealtimeTrackMid(connectionId: string, mid: string): Promise<void> {
        // Single guarded UPDATE — no pre-SELECT, no post-SELECT. The WHERE guard
        // enforces requested + session-set + mid-not-yet-set; the sole caller
        // (subscribeTrack) discards the row. On 0 rows, one disambiguating SELECT
        // distinguishes missing (NotFound) from every wrong-state case (InvalidState).
        const timestamp = nowIso();
        const result = this.db
            .prepare(
                `UPDATE listener_connections
        SET cloudflare_track_mid = ?,
            updated_at = ?
        WHERE id = ?
          AND subscription_status = 'requested'
          AND cloudflare_session_id IS NOT NULL
          AND cloudflare_track_mid IS NULL`,
            )
            .run(mid, timestamp, connectionId);

        if (result.changes === 0) {
            const existing = await this.getConnection(connectionId);
            if (!existing) {
                throw new ListenerConnectionNotFoundError();
            }
            throw new ListenerInvalidStateError();
        }
    }

    async markFailed(
        connectionId: string,
        reason: string,
    ): Promise<{ connection: ListenerConnectionRecord; changed: boolean }> {
        const existing = await this.getConnection(connectionId);
        if (!existing) {
            throw new ListenerConnectionNotFoundError();
        }

        const timestamp = nowIso();
        const result = this.db
            .prepare(
                `UPDATE listener_connections
        SET subscription_status = 'failed',
            disconnected_at = COALESCE(disconnected_at, ?),
            disconnect_reason = COALESCE(disconnect_reason, ?),
            updated_at = ?
        WHERE id = ?
          AND subscription_status NOT IN ('disconnected', 'failed')`,
            )
            .run(timestamp, reason, timestamp, connectionId);

        return {
            connection: await this.requireConnection(connectionId),
            changed: result.changes > 0,
        };
    }

    async getRealtimeCleanupTarget(connectionId: string): Promise<ListenerRealtimeCleanupTarget> {
        const target = this.db
            .prepare(
                `SELECT id,
          program_id as programId,
          language_stream_id as streamId,
          cloudflare_session_id as cloudflareSessionId,
          cloudflare_track_mid as cloudflareTrackMid,
          subscription_status as subscriptionStatus
        FROM listener_connections
        WHERE id = ?`,
            )
            .get(connectionId) as ListenerRealtimeCleanupTarget | undefined;

        if (!target) {
            throw new ListenerConnectionNotFoundError();
        }

        return target;
    }

    async listRealtimeCleanupTargets(
        connectionId: string,
    ): Promise<ListenerRealtimeCleanupTarget[]> {
        const currentTarget = await this.getRealtimeCleanupTarget(connectionId);
        const cleaned = new Set<string>();

        const results = this.db
            .prepare(
                `SELECT cloudflare_session_id as cloudflareSessionId,
          cloudflare_track_mid as cloudflareTrackMid,
          cleanup_state as cleanupState
        FROM listener_realtime_cleanup_targets
        WHERE connection_id = ?
        ORDER BY created_at ASC`,
            )
            .all(connectionId) as RealtimeCleanupMarker[];

        for (const target of results) {
            if (target.cleanupState !== 'closed') {
                continue;
            }
            cleaned.add(cleanupTargetKey(target.cloudflareSessionId, target.cloudflareTrackMid));
        }

        const targets: ListenerRealtimeCleanupTarget[] = [];
        const seenReturned = new Set<string>();
        addRealtimeCleanupTarget(targets, seenReturned, cleaned, currentTarget);

        for (const target of results) {
            if (target.cleanupState !== 'pending') {
                continue;
            }
            addRealtimeCleanupTarget(targets, seenReturned, cleaned, {
                ...currentTarget,
                cloudflareSessionId: target.cloudflareSessionId,
                cloudflareTrackMid: target.cloudflareTrackMid,
            });
        }

        const legacyTargets = await this.listLegacyRealtimeCleanupTargets(currentTarget);
        for (const target of legacyTargets) {
            addRealtimeCleanupTarget(targets, seenReturned, cleaned, {
                ...currentTarget,
                cloudflareSessionId: target.cloudflareSessionId,
                cloudflareTrackMid: target.cloudflareTrackMid,
            });
        }

        return targets;
    }

    async recordRealtimeCleanupTarget(
        connectionId: string,
        cloudflareSessionId: string,
        cloudflareTrackMid: string,
    ): Promise<void> {
        await this.requireConnection(connectionId);
        const timestamp = nowIso();
        this.db
            .prepare(
                `INSERT OR IGNORE INTO listener_realtime_cleanup_targets
        (connection_id, cloudflare_session_id, cloudflare_track_mid,
         cleanup_state, created_at, updated_at, closed_at)
        VALUES (?, ?, ?, 'pending', ?, ?, NULL)`,
            )
            .run(connectionId, cloudflareSessionId, cloudflareTrackMid, timestamp, timestamp);

        this.db
            .prepare(
                `UPDATE listener_realtime_cleanup_targets
        SET cleanup_state = 'pending',
            updated_at = ?,
            closed_at = NULL
        WHERE connection_id = ?
          AND cloudflare_session_id = ?
          AND cloudflare_track_mid = ?
          AND cleanup_state != 'closed'`,
            )
            .run(timestamp, connectionId, cloudflareSessionId, cloudflareTrackMid);
    }

    async recordRealtimeCleanupSuccess(
        connectionId: string,
        cloudflareSessionId: string,
        cloudflareTrackMid: string,
    ): Promise<void> {
        await this.requireConnection(connectionId);
        const timestamp = nowIso();
        this.db
            .prepare(
                `INSERT OR IGNORE INTO listener_realtime_cleanup_targets
        (connection_id, cloudflare_session_id, cloudflare_track_mid,
         cleanup_state, created_at, updated_at, closed_at)
        VALUES (?, ?, ?, 'closed', ?, ?, ?)`,
            )
            .run(
                connectionId,
                cloudflareSessionId,
                cloudflareTrackMid,
                timestamp,
                timestamp,
                timestamp,
            );

        this.db
            .prepare(
                `UPDATE listener_realtime_cleanup_targets
        SET cleanup_state = 'closed',
            updated_at = ?,
            closed_at = COALESCE(closed_at, ?)
        WHERE connection_id = ?
          AND cloudflare_session_id = ?
          AND cloudflare_track_mid = ?`,
            )
            .run(timestamp, timestamp, connectionId, cloudflareSessionId, cloudflareTrackMid);
    }

    async recordConnectionFailure(
        connectionId: string,
        reason: string,
        metadata: Record<string, unknown> = {},
    ): Promise<void> {
        const connection = await this.requireConnection(connectionId);
        await this.insertStreamEvent(connection, 'connection_failed', {
            connectionId: connection.id,
            clientId: connection.clientId,
            reason,
            ...metadata,
        });
    }

    async disconnectConnection(
        connectionId: string,
        reason: string,
    ): Promise<{ connection: ListenerConnectionRecord; changed: boolean }> {
        const existing = await this.getConnection(connectionId);
        if (!existing) {
            throw new ListenerConnectionNotFoundError();
        }

        const timestamp = nowIso();
        const result = this.db
            .prepare(
                `UPDATE listener_connections
        SET subscription_status = 'disconnected',
            disconnected_at = COALESCE(disconnected_at, ?),
            disconnect_reason = COALESCE(disconnect_reason, ?),
            updated_at = ?
        WHERE id = ? AND subscription_status != 'disconnected'`,
            )
            .run(timestamp, reason, timestamp, connectionId);

        if (result.changes === 0) {
            return {
                connection: await this.requireConnection(connectionId),
                changed: false,
            };
        }

        const updated = await this.requireConnection(connectionId);
        await this.insertStreamEvent(updated, eventTypeForDisconnectReason(reason), {
            connectionId: updated.id,
            clientId: updated.clientId,
            reason,
        });

        return { connection: updated, changed: true };
    }

    async findSwitchSuccessor(
        input: FindListenerReplacementInput,
    ): Promise<ListenerConnectionRecord | null> {
        return this.findSuccessor('switch_from_connection_id', input);
    }

    async findReconnectSuccessor(
        input: FindListenerReplacementInput,
    ): Promise<ListenerConnectionRecord | null> {
        return this.findSuccessor('reconnect_of_connection_id', input);
    }

    async getConnection(connectionId: string): Promise<ListenerConnectionRecord | null> {
        return (
            (this.db.prepare(`${CONNECTION_SELECT} WHERE id = ?`).get(connectionId) as
                ListenerConnectionRecord | undefined) ?? null
        );
    }

    async listProgramConnections(programId: string): Promise<ListenerReportConnection[]> {
        if (!(await this.programExists(programId))) {
            throw new ListenerProgramNotFoundError();
        }

        const results = this.db
            .prepare(
                `SELECT id,
          program_id as programId,
          language_stream_id as streamId,
          client_id as clientId,
          subscription_status as subscriptionStatus,
          connected_at as connectedAt,
          disconnected_at as disconnectedAt,
          disconnect_reason as disconnectReason,
          listener_ip as listenerIp,
          user_agent as userAgent,
          last_seen_at as lastSeenAt
        FROM listener_connections
        WHERE program_id = ?
        ORDER BY created_at ASC`,
            )
            .all(programId) as Array<Omit<ListenerReportConnection, 'deviceLabel'>>;

        return results.map((row) => ({
            ...row,
            deviceLabel: deviceLabelFromUserAgent(row.userAgent),
            deviceModel: null,
            deviceModelName: null,
            platform: null,
            platformVersion: null,
            browserFullVersion: null,
            approvalStatus: null,
            approvedAt: null,
            approvedVia: null,
            hasRevokedHistory: false,
        }));
    }

    private buildConnectionFilterClause(
        programId: string,
        filters: ListenerReportFilters,
    ): { where: string; binds: unknown[] } {
        const whereClauses: string[] = ['lc.program_id = ?'];
        const binds: unknown[] = [programId];

        if (filters.states && filters.states.length > 0) {
            const statePlaceholders = filters.states.map(() => '?').join(',');
            whereClauses.push(`lc.subscription_status IN (${statePlaceholders})`);
            binds.push(...filters.states);
        }

        if (filters.streamId) {
            whereClauses.push('lc.language_stream_id = ?');
            binds.push(filters.streamId);
        }

        if (filters.deviceLabel) {
            whereClauses.push('lc.device_label = ?');
            binds.push(filters.deviceLabel);
        }

        if (filters.createdFrom) {
            whereClauses.push('lc.created_at >= ?');
            binds.push(filters.createdFrom);
        }

        if (filters.createdTo) {
            whereClauses.push('lc.created_at < ?');
            binds.push(filters.createdTo);
        }

        if (filters.approvalStatuses && filters.approvalStatuses.length > 0) {
            const approvalPlaceholders = filters.approvalStatuses.map(() => '?').join(',');
            whereClauses.push(`report_access.status IN (${approvalPlaceholders})`);
            binds.push(...filters.approvalStatuses);
        }

        return {
            where: whereClauses.join(' AND '),
            binds,
        };
    }

    async listProgramConnectionsPage(
        programId: string,
        filters: ListenerReportFilters,
        page: number,
        pageSize = 100,
    ): Promise<{
        connections: ListenerReportConnection[];
        total: number;
        page: number;
        pageSize: number;
        totalPages: number;
    }> {
        const row = this.db
            .prepare('SELECT id FROM programs WHERE id = ? AND deleted_at IS NULL')
            .get(programId);
        if (!row) {
            throw new ListenerProgramNotFoundError();
        }

        const total = await this.countProgramConnections(programId, filters);
        const normalizedPageSize = Math.max(1, Math.floor(pageSize));
        const totalPages = Math.max(1, Math.ceil(total / normalizedPageSize));
        const clampedPage = Math.min(
            Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1),
            totalPages,
        );
        const offset = (clampedPage - 1) * normalizedPageSize;

        const { where, binds } = this.buildConnectionFilterClause(programId, filters);
        const results = this.db
            .prepare(
                `SELECT lc.id,
          lc.program_id as programId,
          lc.language_stream_id as streamId,
          lc.client_id as clientId,
          lc.subscription_status as subscriptionStatus,
          lc.connected_at as connectedAt,
          lc.disconnected_at as disconnectedAt,
          lc.disconnect_reason as disconnectReason,
          lc.listener_ip as listenerIp,
          lc.user_agent as userAgent,
          lc.last_seen_at as lastSeenAt,
          lc.device_label as deviceLabel,
          lc.client_device_model as deviceModel,
          lc.client_platform as platform,
          lc.client_platform_version as platformVersion,
          lc.client_browser_full_version as browserFullVersion,
          report_access.status as approvalStatus,
          report_access.approved_at as approvedAt,
          report_access.approved_via as approvedVia,
          report_access.has_revoked_history as hasRevokedHistory
        FROM listener_connections lc
        ${LISTENER_ACCESS_REPORT_JOIN}
        WHERE ${where}
        ORDER BY lc.created_at DESC, lc.id DESC
        LIMIT ? OFFSET ?`,
            )
            .all(programId, ...binds, normalizedPageSize, offset) as ListenerReportQueryRow[];

        return {
            connections: results.map(mapListenerReportRow),
            total,
            page: clampedPage,
            pageSize: normalizedPageSize,
            totalPages,
        };
    }

    async countProgramConnections(
        programId: string,
        filters: ListenerReportFilters,
    ): Promise<number> {
        const { where, binds } = this.buildConnectionFilterClause(programId, filters);
        const needsAccessJoin = Boolean(filters.approvalStatuses?.length);
        const row = this.db
            .prepare(
                `SELECT COUNT(*) as c
        FROM listener_connections lc
        ${needsAccessJoin ? LISTENER_ACCESS_REPORT_JOIN : ''}
        WHERE ${where}`,
            )
            .get(...(needsAccessJoin ? [programId, ...binds] : binds)) as { c: number } | undefined;

        return row?.c ?? 0;
    }

    async listProgramConnectionsForCsv(
        programId: string,
        filters: ListenerReportFilters,
    ): Promise<ListenerReportCsvResult> {
        const { where, binds } = this.buildConnectionFilterClause(programId, filters);
        const results = this.db
            .prepare(
                `SELECT lc.id,
          lc.program_id as programId,
          lc.language_stream_id as streamId,
          lc.client_id as clientId,
          lc.subscription_status as subscriptionStatus,
          lc.connected_at as connectedAt,
          lc.disconnected_at as disconnectedAt,
          lc.disconnect_reason as disconnectReason,
          lc.listener_ip as listenerIp,
          lc.user_agent as userAgent,
          lc.last_seen_at as lastSeenAt,
          lc.device_label as deviceLabel,
          lc.client_device_model as deviceModel,
          lc.client_platform as platform,
          lc.client_platform_version as platformVersion,
          lc.client_browser_full_version as browserFullVersion,
          report_access.status as approvalStatus,
          report_access.approved_at as approvedAt,
          report_access.approved_via as approvedVia,
          report_access.has_revoked_history as hasRevokedHistory
        FROM listener_connections lc
        ${LISTENER_ACCESS_REPORT_JOIN}
        WHERE ${where}
        ORDER BY lc.created_at DESC, lc.id DESC
        LIMIT ?`,
            )
            .all(programId, ...binds, MAX_CSV_ROWS + 1) as ListenerReportQueryRow[];

        const truncated = results.length > MAX_CSV_ROWS;
        const rows = truncated ? results.slice(0, MAX_CSV_ROWS) : results;

        return {
            connections: rows.map(mapListenerReportRow),
            truncated,
        };
    }

    private buildEventFilterClause(
        programId: string,
        opts: ProgramEventPageOptions,
    ): { where: string; binds: unknown[] } {
        const whereClauses: string[] = ['se.program_id = ?'];
        const binds: unknown[] = [programId];

        if (opts.range?.from) {
            whereClauses.push('se.occurred_at >= ?');
            binds.push(opts.range.from);
        }

        if (opts.range?.to) {
            whereClauses.push('se.occurred_at < ?');
            binds.push(opts.range.to);
        }

        if (opts.eventTypes?.length) {
            whereClauses.push(`se.event_type IN (${opts.eventTypes.map(() => '?').join(', ')})`);
            binds.push(...opts.eventTypes);
        }

        if (opts.translatorId) {
            whereClauses.push("json_extract(se.metadata_json,'$.translatorId') = ?");
            binds.push(opts.translatorId);
        }

        return {
            where: whereClauses.join(' AND '),
            binds,
        };
    }

    private async countProgramEvents(
        programId: string,
        opts: ProgramEventPageOptions,
    ): Promise<number> {
        const { where, binds } = this.buildEventFilterClause(programId, opts);
        const row = this.db
            .prepare(`SELECT COUNT(*) as c FROM stream_events se WHERE ${where}`)
            .get(...binds) as { c: number } | undefined;

        return row?.c ?? 0;
    }

    async getProgramReportAggregates(
        programId: string,
        range: ReportDateRange = {},
    ): Promise<{
        totals: {
            totalConnections: number;
            uniqueDevices: number;
            dropouts: number;
            reconnects: number;
        };
        streams: Array<{
            streamId: string;
            languageName: string;
            languageCode: string;
            totalConnections: number;
            dropouts: number;
            reconnects: number;
        }>;
    }> {
        if (!(await this.programExists(programId))) {
            throw new ListenerProgramNotFoundError();
        }

        const streamRows = this.db
            .prepare(
                `SELECT id as streamId,
          language_name as languageName,
          language_code as languageCode
        FROM language_streams
        WHERE program_id = ?
        ORDER BY display_order ASC, created_at ASC`,
            )
            .all(programId) as Array<{
            streamId: string;
            languageName: string;
            languageCode: string;
        }>;

        const connectionWhere = ['program_id = ?'];
        const connectionBinds: unknown[] = [programId];
        if (range.from) {
            connectionWhere.push('created_at >= ?');
            connectionBinds.push(range.from);
        }
        if (range.to) {
            connectionWhere.push('created_at < ?');
            connectionBinds.push(range.to);
        }

        const connectionRows = this.db
            .prepare(
                `SELECT language_stream_id as streamId, COUNT(*) as count
        FROM listener_connections
        WHERE ${connectionWhere.join(' AND ')}
        GROUP BY language_stream_id`,
            )
            .all(...connectionBinds) as Array<{ streamId: string; count: number }>;
        const totalConnections = connectionRows.reduce((sum, row) => sum + row.count, 0);
        const connectionsByStream = new Map(connectionRows.map((row) => [row.streamId, row.count]));
        const uniqueDeviceRow = this.db
            .prepare(
                `SELECT COUNT(DISTINCT client_id) as count
        FROM listener_connections
        WHERE ${connectionWhere.join(' AND ')}
          AND client_id IS NOT NULL
          AND client_id != ''`,
            )
            .get(...connectionBinds) as { count: number | null } | undefined;
        const uniqueDevices = uniqueDeviceRow?.count ?? 0;

        const eventWhere = ['program_id = ?'];
        const eventBinds: unknown[] = [programId];
        if (range.from) {
            eventWhere.push('occurred_at >= ?');
            eventBinds.push(range.from);
        }
        if (range.to) {
            eventWhere.push('occurred_at < ?');
            eventBinds.push(range.to);
        }

        const eventRows = this.db
            .prepare(
                `SELECT language_stream_id as streamId,
          SUM(CASE WHEN event_type = 'listener_reconnected' THEN 1 ELSE 0 END) as reconnects,
          SUM(CASE WHEN ${DROPOUT_CONDITION} THEN 1 ELSE 0 END) as dropouts
        FROM stream_events
        WHERE ${eventWhere.join(' AND ')}
        GROUP BY language_stream_id`,
            )
            .all(...eventBinds) as Array<{
            streamId: string | null;
            reconnects: number | null;
            dropouts: number | null;
        }>;
        const totalsEvents = eventRows.reduce(
            (totals, row) => ({
                reconnects: totals.reconnects + (row.reconnects ?? 0),
                dropouts: totals.dropouts + (row.dropouts ?? 0),
            }),
            { reconnects: 0, dropouts: 0 },
        );
        const eventsByStream = new Map(
            eventRows
                .filter(
                    (
                        row,
                    ): row is {
                        streamId: string;
                        reconnects: number | null;
                        dropouts: number | null;
                    } => row.streamId !== null,
                )
                .map((row) => [
                    row.streamId,
                    { reconnects: row.reconnects ?? 0, dropouts: row.dropouts ?? 0 },
                ]),
        );

        const streams = streamRows.map((stream) => {
            const events = eventsByStream.get(stream.streamId);
            return {
                streamId: stream.streamId,
                languageName: stream.languageName,
                languageCode: stream.languageCode,
                totalConnections: connectionsByStream.get(stream.streamId) ?? 0,
                dropouts: events?.dropouts ?? 0,
                reconnects: events?.reconnects ?? 0,
            };
        });

        return {
            totals: {
                totalConnections,
                uniqueDevices,
                dropouts: totalsEvents.dropouts,
                reconnects: totalsEvents.reconnects,
            },
            streams,
        };
    }

    async listProgramEventsPage(
        programId: string,
        opts: ProgramEventPageOptions = {},
    ): Promise<ProgramEventPage> {
        if (!(await this.programExists(programId))) {
            throw new ListenerProgramNotFoundError();
        }

        const requestedPageSize = opts.pageSize ?? 20;
        const pageSize = Math.min(
            Math.max(1, Number.isFinite(requestedPageSize) ? Math.floor(requestedPageSize) : 20),
            100,
        );
        const total = await this.countProgramEvents(programId, opts);
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const requestedPage = opts.page ?? 1;
        const page = Math.min(
            Math.max(1, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1),
            totalPages,
        );
        const offset = (page - 1) * pageSize;

        const { where, binds } = this.buildEventFilterClause(programId, opts);
        const results = this.db
            .prepare(
                `SELECT se.id as id,
          se.event_type as eventType,
          se.occurred_at as occurredAt,
          se.language_stream_id as streamId,
          se.metadata_json as metadataJson,
          ls.language_name as languageName,
          ls.language_code as languageCode,
          se.translator_name as translatorName,
          se.translator_user_agent as translatorUserAgent
        FROM stream_events se
        LEFT JOIN language_streams ls
          ON ls.program_id = se.program_id
          AND ls.id = se.language_stream_id
        WHERE ${where}
        ORDER BY se.occurred_at DESC, se.id DESC
        LIMIT ? OFFSET ?`,
            )
            .all(...binds, pageSize, offset) as Array<{
            id: string;
            eventType: string;
            occurredAt: string;
            streamId: string | null;
            metadataJson: string | null;
            languageName: string | null;
            languageCode: string | null;
            translatorName: string | null;
            translatorUserAgent: string | null;
        }>;

        return {
            events: results.map((row) => {
                const metadata = sanitizeEventMetadata(parseMetadataObject(row.metadataJson));
                const translatorName =
                    metadata.translatorId === undefined
                        ? null
                        : (row.translatorName ?? 'Deleted translator');
                const translatorDeviceLabel = row.translatorUserAgent
                    ? deviceLabelFromUserAgent(row.translatorUserAgent)
                    : null;

                return {
                    id: row.id,
                    eventType: row.eventType,
                    occurredAt: row.occurredAt,
                    translatorName,
                    translatorDeviceLabel,
                    stream:
                        row.streamId && row.languageName !== null && row.languageCode !== null
                            ? {
                                  id: row.streamId,
                                  languageName: row.languageName,
                                  languageCode: row.languageCode,
                              }
                            : null,
                    metadata,
                };
            }),
            total,
            page,
            pageSize,
            totalPages,
        };
    }

    async anonymizeProgramTelemetry(programId: string, now: Date): Promise<number> {
        if (!(await this.programExists(programId))) {
            throw new ListenerProgramNotFoundError();
        }

        const timestamp = now.toISOString();
        const result = this.db
            .prepare(
                `UPDATE listener_connections
        SET listener_ip = ?, user_agent = ?, updated_at = ?
        WHERE program_id = ?
          AND (listener_ip != ? OR user_agent != ?)`,
            )
            .run(
                RETENTION_REDACTED_VALUE,
                RETENTION_REDACTED_VALUE,
                timestamp,
                programId,
                RETENTION_REDACTED_VALUE,
                RETENTION_REDACTED_VALUE,
            );

        return result.changes;
    }

    async requireStream(programId: string, streamId: string): Promise<void> {
        if (!(await this.streamExists(programId, streamId))) {
            throw new ListenerStreamNotFoundError();
        }
    }

    private async requireConnection(connectionId: string): Promise<ListenerConnectionRecord> {
        const connection = await this.getConnection(connectionId);
        if (!connection) {
            throw new ListenerConnectionNotFoundError();
        }
        return connection;
    }

    private async programExists(programId: string): Promise<boolean> {
        const row = this.db.prepare('SELECT id FROM programs WHERE id = ?').get(programId);
        return row !== undefined;
    }

    private async streamExists(programId: string, streamId: string): Promise<boolean> {
        const row = this.db
            .prepare(
                `SELECT id FROM language_streams
        WHERE program_id = ? AND id = ?`,
            )
            .get(programId, streamId);
        return row !== undefined;
    }

    private async connectionExists(connectionId: string): Promise<boolean> {
        const row = this.db
            .prepare('SELECT id FROM listener_connections WHERE id = ?')
            .get(connectionId);
        return row !== undefined;
    }

    private async findSuccessor(
        linkColumn: 'switch_from_connection_id' | 'reconnect_of_connection_id',
        input: FindListenerReplacementInput,
    ): Promise<ListenerConnectionRecord | null> {
        return (
            (this.db
                .prepare(
                    `${CONNECTION_SELECT}
        WHERE ${linkColumn} = ?
          AND program_id = ?
          AND language_stream_id = ?
          AND client_id = ?
        ORDER BY created_at ASC
        LIMIT 1`,
                )
                .get(
                    input.previousConnectionId,
                    input.programId,
                    input.streamId,
                    input.clientId,
                ) as ListenerConnectionRecord | undefined) ?? null
        );
    }

    private async insertStreamEvent(
        connection: ListenerConnectionRecord,
        eventType: ListenerStreamEventType,
        metadata: Record<string, unknown>,
    ): Promise<void> {
        const timestamp = nowIso();
        this.db
            .prepare(
                `INSERT INTO stream_events
        (id, program_id, stream_program_id, language_stream_id, event_type,
         occurred_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                id('stream_event'),
                connection.programId,
                connection.programId,
                connection.streamId,
                eventType,
                timestamp,
                JSON.stringify(metadata),
            );
    }

    private async listLegacyRealtimeCleanupTargets(
        currentTarget: ListenerRealtimeCleanupTarget,
    ): Promise<RealtimeCleanupMarker[]> {
        const results = this.db
            .prepare(
                `SELECT metadata_json as metadataJson
        FROM stream_events
        WHERE program_id = ?
          AND language_stream_id = ?
          AND event_type = 'connection_failed'
        ORDER BY occurred_at ASC`,
            )
            .all(currentTarget.programId, currentTarget.streamId) as Array<{
            metadataJson: string;
        }>;

        const targets: RealtimeCleanupMarker[] = [];
        for (const event of results) {
            const metadata = parseMetadata(event.metadataJson);
            if (
                metadata?.reason !== 'realtime_track_cleanup_failed' ||
                metadata.connectionId !== currentTarget.id
            ) {
                continue;
            }

            const cloudflareSessionId = metadataString(metadata.cloudflareSessionId);
            const cloudflareTrackMid =
                metadataString(metadata.cloudflareTrackMid) ?? metadataString(metadata.trackMid);
            if (!cloudflareSessionId || !cloudflareTrackMid) {
                continue;
            }

            targets.push({
                cloudflareSessionId,
                cloudflareTrackMid,
                cleanupState: 'pending',
            });
        }

        return targets;
    }
}

type ListenerStreamEventType =
    'listener_left' | 'listener_switched' | 'listener_reconnected' | 'connection_failed';

// A dropout is a connection failure, or a `listener_left` whose reason is not
// a known graceful departure. Mirrors `isDropoutEvent` in domain/reports.
const DROPOUT_CONDITION = `(
  event_type = 'connection_failed'
  OR (
    event_type = 'listener_left'
    AND COALESCE(json_extract(metadata_json, '$.reason'), '')
      NOT IN ('client_disconnect', 'language_switch', 'reconnected')
  )
)`;

const CONNECTION_SELECT = `SELECT id,
  program_id as programId,
  language_stream_id as streamId,
  client_id as clientId,
  subscription_status as subscriptionStatus,
  connected_at as connectedAt,
  disconnected_at as disconnectedAt,
  disconnect_reason as disconnectReason,
  cloudflare_session_id as cloudflareSessionId,
  cloudflare_track_mid as cloudflareTrackMid,
  listener_ip as listenerIp,
  user_agent as userAgent,
  switch_from_connection_id as switchFromConnectionId,
  reconnect_of_connection_id as reconnectOfConnectionId,
  created_at as createdAt,
  updated_at as updatedAt
  FROM listener_connections`;

export function buildRequestedConnectionRecord(
    input: CreateListenerConnectionInput,
): ListenerConnectionRecord {
    const timestamp = nowIso();
    return {
        id: id('listener_connection'),
        programId: input.programId,
        streamId: input.streamId,
        clientId: input.clientId,
        subscriptionStatus: 'requested',
        connectedAt: null,
        disconnectedAt: null,
        disconnectReason: null,
        cloudflareSessionId: null,
        cloudflareTrackMid: null,
        listenerIp: input.listenerIp,
        userAgent: input.userAgent,
        switchFromConnectionId: input.switchFromConnectionId ?? null,
        reconnectOfConnectionId: input.reconnectOfConnectionId ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
    };
}

export function applyConnectedUpdate(
    db: Database,
    connectionId: string,
    clientHints: ListenerClientHints,
    fastPath: true,
): ApplyConnectedUpdateFastPathResult;
export function applyConnectedUpdate(
    db: Database,
    connectionId: string,
    clientHints: ListenerClientHints,
    fastPath?: false,
): ApplyConnectedUpdateResult;
export function applyConnectedUpdate(
    db: Database,
    connectionId: string,
    clientHints: ListenerClientHints,
    fastPath: boolean = false,
): ApplyConnectedUpdateResult | ApplyConnectedUpdateFastPathResult {
    // Single guarded UPDATE — no pre-SELECT. The `subscription_status =
    // 'requested'` guard enforces every precondition the old pre-SELECT checked,
    // mirroring `recordHeartbeat`. A SELECT happens only when the UPDATE matches
    // a row, to build the audit payload.
    const timestamp = nowIso();
    const result = db
        .prepare(
            `UPDATE listener_connections
      SET subscription_status = 'connected',
          connected_at = COALESCE(connected_at, ?),
          last_seen_at = COALESCE(connected_at, ?),
          client_device_model = COALESCE(?, client_device_model),
          client_platform = COALESCE(?, client_platform),
          client_platform_version = COALESCE(?, client_platform_version),
          client_browser_full_version = COALESCE(?, client_browser_full_version),
          updated_at = ?
      WHERE id = ? AND subscription_status = 'requested'`,
        )
        .run(
            timestamp,
            timestamp,
            clientHints.deviceModel ?? null,
            clientHints.platform ?? null,
            clientHints.platformVersion ?? null,
            clientHints.browserFullVersion ?? null,
            timestamp,
            connectionId,
        );
    const changes = result.changes;

    if (changes === 0 || fastPath) {
        return { changes };
    }

    // Happy path: one post-SELECT to build the stateful payload (programId,
    // streamId, clientId).
    const updated = requireConnection(db, connectionId);

    return { changes, connection: updated };
}

function connectedUpdateChanged(
    result: ApplyConnectedUpdateResult,
): result is { changes: number; connection: ListenerConnectionRecord } {
    return result.changes > 0;
}

function requireConnection(db: Database, connectionId: string): ListenerConnectionRecord {
    const connection = db.prepare(`${CONNECTION_SELECT} WHERE id = ?`).get(connectionId) as
        ListenerConnectionRecord | undefined;
    if (!connection) {
        throw new ListenerConnectionNotFoundError();
    }
    return connection;
}

function nowIso(): string {
    return new Date().toISOString();
}

function id(prefix: string): string {
    return `${prefix}_${crypto.randomUUID()}`;
}

function cleanupTargetKey(cloudflareSessionId: string, trackMid: string): string {
    return `${cloudflareSessionId} ${trackMid}`;
}

function addRealtimeCleanupTarget(
    targets: ListenerRealtimeCleanupTarget[],
    seenReturned: Set<string>,
    cleaned: Set<string>,
    target: ListenerRealtimeCleanupTarget,
): void {
    if (target.cloudflareSessionId === null || target.cloudflareTrackMid === null) {
        targets.push(target);
        return;
    }

    const key = cleanupTargetKey(target.cloudflareSessionId, target.cloudflareTrackMid);
    if (cleaned.has(key) || seenReturned.has(key)) {
        return;
    }

    seenReturned.add(key);
    targets.push(target);
}

function parseMetadata(value: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return null;
        }
        return parsed as Record<string, unknown>;
    } catch (_error) {
        return null;
    }
}

function metadataString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

function eventTypeForDisconnectReason(reason: string): ListenerStreamEventType {
    if (reason === 'language_switch') {
        return 'listener_switched';
    }

    if (reason === 'reconnected') {
        return 'listener_reconnected';
    }

    return 'listener_left';
}

function isReferenceConstraintError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
        message.includes('FOREIGN KEY constraint failed') ||
        message.includes('CHECK constraint failed')
    );
}

function isReplacementSuccessorConstraintError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
        message.includes('UNIQUE') &&
        (message.includes('switch_from_connection_id') ||
            message.includes('reconnect_of_connection_id'))
    );
}
