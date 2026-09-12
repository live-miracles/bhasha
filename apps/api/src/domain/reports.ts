export const RETENTION_REDACTED_VALUE = "[redacted]";
export const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

const SAFE_DISCONNECT_REASONS = [
  "client_disconnect",
  "language_switch",
  "reconnected"
] as const;

const CSV_FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

export interface SanitizedEventMetadata {
  reason?: string;
  translatorId?: string;
  connectionId?: string;
}

export interface AdminReportStreamSummary {
  streamId: string;
  languageName: string;
  languageCode: string;
  activeListeners: number;
  totalConnections: number;
  dropouts: number;
  reconnects: number;
}

export interface AdminReportSummaryTotals {
  activeListeners: number;
  totalConnections: number;
  uniqueDevices: number;
  dropouts: number;
  reconnects: number;
}

export interface AdminReportSummaryResponse {
  programId: string;
  totals: AdminReportSummaryTotals;
  streams: AdminReportStreamSummary[];
  generatedAt: string;
  presenceSource: "durable_object" | "archived_snapshot";
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
  metadata: SanitizedEventMetadata;
}

export interface AdminEventFeedResponse {
  events: AdminEventFeedEntry[];
}

export interface ListenerCsvRow {
  id: string;
  clientId: string;
  streamId: string;
  connectedAt: string | null;
  disconnectedAt: string | null;
  disconnectReason: string | null;
  listenerIp: string;
  userAgent: string;
  deviceModel: string | null;
  deviceModelName: string | null;
  platform: string | null;
  platformVersion: string | null;
  browserFullVersion: string | null;
  approvalStatus: string | null;
  approvedAt: string | null;
  approvedVia: string | null;
}

const CSV_HEADER =
  "connectionId,clientId,streamId,connectedAt,disconnectedAt,disconnectReason,listenerIp,userAgent,deviceModel,deviceModelName,platform,platformVersion,browserFullVersion,approvalStatus,approvedAt,approvedVia";

/**
 * Reduce raw event metadata to the small allowlist that is safe to expose in
 * the authenticated admin event feed. IP, user agent, client id, Cloudflare
 * session ids, track details, and any unknown keys are intentionally dropped.
 */
export function sanitizeEventMetadata(
  value: Record<string, unknown> | null
): SanitizedEventMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const sanitized: SanitizedEventMetadata = {};
  if (typeof value.reason === "string") {
    sanitized.reason = value.reason;
  }
  if (typeof value.translatorId === "string") {
    sanitized.translatorId = value.translatorId;
  }
  if (typeof value.connectionId === "string") {
    sanitized.connectionId = value.connectionId;
  }
  return sanitized;
}

/**
 * Escape a single CSV field per RFC4180 and neutralize spreadsheet
 * formula-injection by prefixing dangerous leading characters with a quote.
 */
export function escapeCsvField(value: string | null): string {
  if (value === null || value === undefined) {
    return "";
  }

  let field = value;
  if (CSV_FORMULA_PREFIXES.some((prefix) => field.startsWith(prefix))) {
    field = `'${field}`;
  }

  if (/[",\r\n]/.test(field)) {
    field = `"${field.replaceAll('"', '""')}"`;
  }

  return field;
}

export function listenerConnectionsToCsv(rows: ListenerCsvRow[]): string {
  const lines = [CSV_HEADER];
  for (const row of rows) {
    lines.push(
      [
        escapeCsvField(row.id),
        escapeCsvField(row.clientId),
        escapeCsvField(row.streamId),
        escapeCsvField(row.connectedAt),
        escapeCsvField(row.disconnectedAt),
        escapeCsvField(row.disconnectReason),
        escapeCsvField(row.listenerIp),
        escapeCsvField(row.userAgent),
        escapeCsvField(row.deviceModel),
        escapeCsvField(row.deviceModelName),
        escapeCsvField(row.platform),
        escapeCsvField(row.platformVersion),
        escapeCsvField(row.browserFullVersion),
        escapeCsvField(row.approvalStatus),
        escapeCsvField(row.approvedAt),
        escapeCsvField(row.approvedVia)
      ].join(",")
    );
  }
  return lines.join("\r\n");
}

/**
 * A dropout is a persisted connection failure, or a `listener_left` event
 * whose reason is not a known graceful departure. Graceful reasons
 * (client_disconnect, language_switch, reconnected) are excluded.
 */
export function isDropoutEvent(
  eventType: string,
  reason: string | null
): boolean {
  if (eventType === "connection_failed") {
    return true;
  }
  if (eventType !== "listener_left") {
    return false;
  }
  return !SAFE_DISCONNECT_REASONS.includes(
    (reason ?? "") as (typeof SAFE_DISCONNECT_REASONS)[number]
  );
}

export function isReconnectEvent(eventType: string): boolean {
  return eventType === "listener_reconnected";
}

export function isRetentionEligible(input: {
  status: "draft" | "live" | "archived";
  archivedAt: string | null;
  retentionProcessedAt: string | null;
  now: Date;
}): boolean {
  if (input.status !== "archived") {
    return false;
  }
  if (input.archivedAt === null) {
    return false;
  }
  if (input.retentionProcessedAt !== null) {
    return false;
  }

  const archivedAtMs = Date.parse(input.archivedAt);
  if (!Number.isFinite(archivedAtMs)) {
    return false;
  }

  return input.now.getTime() - archivedAtMs >= RETENTION_MS;
}

/** Local safe JSON parser for metadata columns. */
export function parseMetadataObject(
  value: string | null
): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (_error) {
    return null;
  }
}
