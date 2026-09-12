import type {
  AdminEventFeed,
  AdminEventFeedEntry,
  AdminProgramDetail
} from "../../../api/admin";
import { formatISTDateTime } from "../formatTime";
import { eventWording } from "./eventWording";

export type EventFiltersState = {
  eventTypes: string[];
  translatorId: string;
};

interface EventFeedPanelProps {
  detail: AdminProgramDetail;
  feed: AdminEventFeed | null;
  filters: EventFiltersState;
  page: number;
  onFilterChange: (partial: Partial<EventFiltersState>) => void;
  onPageChange: (page: number) => void;
  onClearFilters: () => void;
  rangeLabel?: string | null;
  onRangeChipClick?: () => void;
  isFetching?: boolean;
}

const EVENT_TYPE_OPTIONS = [
  ["translator_connected", "Translator connected"],
  ["translator_disconnected", "Translator disconnected"],
  ["listener_left", "Listener left"],
  ["listener_switched", "Listener switched"],
  ["listener_reconnected", "Listener reconnected"],
  ["connection_failed", "Connection failed"]
] as const;

/**
 * Render only the allowlisted metadata fields. Iterating over arbitrary
 * metadata keys could leak IP/user-agent/track details if the backend
 * allowlist ever regressed, so we read named fields explicitly.
 */
function safeMetadata(entry: AdminEventFeedEntry): string {
  const parts: string[] = [];
  if (entry.metadata.reason) {
    parts.push(`reason: ${entry.metadata.reason}`);
  }
  if (entry.metadata.connectionId) {
    parts.push(`connection: ${entry.metadata.connectionId}`);
  }
  return parts.join(" · ");
}

function EventWordingCell({ event }: { event: AdminEventFeedEntry }) {
  const wording = eventWording(event);
  const deletedTranslatorToken = "Deleted translator";
  const wordingParts = wording.split(deletedTranslatorToken);

  return (
    <>
      <div>
        {wordingParts.map((part, index) => (
          <span key={`${part}-${index}`}>
            {index > 0 ? (
              <em className="admin-text-soft">{deletedTranslatorToken}</em>
            ) : null}
            {part}
          </span>
        ))}
      </div>
      {event.translatorDeviceLabel ? (
        <small className="admin-hint">{event.translatorDeviceLabel}</small>
      ) : null}
    </>
  );
}

function RangeChip({
  label,
  onClick
}: {
  label: string | null | undefined;
  onClick: (() => void) | undefined;
}) {
  if (!label) {
    return null;
  }
  return (
    <button className="admin-pill admin-range-chip" type="button" onClick={onClick}>
      {label}
    </button>
  );
}

export function EventFeedPanel({
  detail,
  feed,
  filters,
  page,
  onFilterChange,
  onPageChange,
  onClearFilters,
  rangeLabel = null,
  onRangeChipClick,
  isFetching = false
}: EventFeedPanelProps) {
  const total = feed?.total ?? 0;
  const totalPages = feed?.totalPages ?? 1;
  const filtersActive =
    filters.eventTypes.length > 0 || filters.translatorId !== "";

  function applyFilter(partial: Partial<EventFiltersState>) {
    onFilterChange(partial);
    onPageChange(1);
  }

  function toggleEventType(eventType: string) {
    const eventTypes = filters.eventTypes.includes(eventType)
      ? filters.eventTypes.filter((selected) => selected !== eventType)
      : [...filters.eventTypes, eventType];
    applyFilter({ eventTypes });
  }

  function clearFilters() {
    onClearFilters();
    onPageChange(1);
  }

  return (
    <section aria-label="Recent events" className="admin-subsection">
      <div className="admin-panel-heading">
        <h2>Recent events</h2>
        <RangeChip label={rangeLabel} onClick={onRangeChipClick} />
      </div>
      <div className="admin-filter-bar">
        <div className="admin-filter-row">
          <div className="admin-filter-field">
            <details className="admin-multiselect">
              <summary className="admin-multiselect-summary">
                Event type
                {filters.eventTypes.length > 0
                  ? ` · ${filters.eventTypes.length}`
                  : ""}
              </summary>
              <div className="admin-multiselect-menu">
                {EVENT_TYPE_OPTIONS.map(([value, label]) => (
                  <label key={value} className="admin-checkbox-row">
                    <input
                      type="checkbox"
                      value={value}
                      checked={filters.eventTypes.includes(value)}
                      onChange={() => toggleEventType(value)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </details>
          </div>
          <label className="admin-filter-field">
            <span className="admin-filter-field-label">Translator</span>
            <select
              value={filters.translatorId}
              onChange={(e) => applyFilter({ translatorId: e.target.value })}
            >
              <option value="">All translators</option>
              {detail.translators.map((translator) => (
                <option key={translator.id} value={translator.id}>
                  {translator.name}
                </option>
              ))}
            </select>
          </label>
          {filtersActive ? (
            <button
              className="admin-btn-secondary"
              type="button"
              onClick={clearFilters}
            >
              Clear all filters
            </button>
          ) : null}
        </div>
      </div>
      {feed !== null ? (
        <div className="admin-report-meta">
          <p role="status" aria-live="polite">
            Page {page} of {totalPages} · {total} events
          </p>
        </div>
      ) : null}
      <div
        className="admin-refetch-dim"
        data-testid="event-feed-body"
        style={{
          opacity: isFetching ? 0.6 : 1,
          pointerEvents: isFetching ? "none" : "auto"
        }}
      >
        {feed === null ? <p>Loading recent events...</p> : null}
        {feed !== null && feed.events.length === 0 ? (
          <p>No recent events.</p>
        ) : null}
        {feed !== null && feed.events.length > 0 ? (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Language</th>
                <th>Time</th>
                <th>Debug info</th>
              </tr>
            </thead>
            <tbody>
              {feed.events.map((event) => (
                <tr key={event.id}>
                  <td>
                    <EventWordingCell event={event} />
                  </td>
                  <td>{event.stream ? event.stream.languageName : "—"}</td>
                  <td>{formatISTDateTime(event.occurredAt)}</td>
                  <td>{safeMetadata(event)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
      {feed !== null ? (
        <div className="admin-pagination">
          <button
            className="admin-btn-secondary"
            type="button"
            disabled={page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
          >
            ← Prev
          </button>
          <span className="admin-pagination-info">
            Page {page} of {totalPages}
          </span>
          <button
            className="admin-btn-secondary"
            type="button"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            Next →
          </button>
        </div>
      ) : null}
    </section>
  );
}
