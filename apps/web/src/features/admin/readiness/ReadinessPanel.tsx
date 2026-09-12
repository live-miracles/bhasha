import type { ReactElement } from "react";

import type {
  AdminReadiness,
  AdminReadinessItem,
  ConfirmableReadinessItemId,
  ReadinessStatus
} from "../../../api/admin";
import { formatISTDateTime } from "../formatTime";

interface ReadinessPanelProps {
  readiness: AdminReadiness | null;
  onConfirm: (itemId: ConfirmableReadinessItemId) => void;
  pendingItemId?: ConfirmableReadinessItemId | null;
  /** Viewers can read readiness but cannot confirm (server write is gated). */
  readOnly?: boolean;
}

const STATUS_LABEL: Record<ReadinessStatus, string> = {
  green: "Ready",
  warning: "Warning",
  blocker: "Blocker"
};

const STATUS_PILL_CLASS: Record<ReadinessStatus, string> = {
  green: "admin-pill-live",
  warning: "admin-pill-warning",
  blocker: "admin-pill-blocker"
};

const STATUS_ICON: Record<ReadinessStatus, ReactElement> = {
  green: (
    <svg
      aria-hidden="true"
      className="admin-readiness-icon admin-readiness-icon--green"
      fill="none"
      height="18"
      viewBox="0 0 24 24"
      width="18"
    >
      <path
        d="M9 12l2 2 4-5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
    </svg>
  ),
  warning: (
    <svg
      aria-hidden="true"
      className="admin-readiness-icon admin-readiness-icon--warning"
      fill="none"
      height="18"
      viewBox="0 0 24 24"
      width="18"
    >
      <path
        d="M10.3 4.4 2.8 17.5A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.5L13.7 4.4a2 2 0 0 0-3.4 0Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="M12 9v4m0 4h.01"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  ),
  blocker: (
    <svg
      aria-hidden="true"
      className="admin-readiness-icon admin-readiness-icon--blocker"
      fill="none"
      height="18"
      viewBox="0 0 24 24"
      width="18"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path
        d="m15 9-6 6m0-6 6 6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  )
};

const CONFIRM_LABEL: Record<ConfirmableReadinessItemId, string> = {
  realtime_smoke_tested: "Confirm realtime smoke test",
  mobile_field_tested: "Confirm mobile field test"
};

function isConfirmable(
  item: AdminReadinessItem
): item is AdminReadinessItem & { id: ConfirmableReadinessItemId } {
  return (
    item.id === "realtime_smoke_tested" || item.id === "mobile_field_tested"
  );
}

export function ReadinessPanel({
  readiness,
  onConfirm,
  pendingItemId,
  readOnly = false
}: ReadinessPanelProps) {
  if (!readiness) {
    return (
      <section aria-label="Event readiness" className="admin-subsection">
        <h2>Event readiness</h2>
        <p>Loading event readiness...</p>
      </section>
    );
  }

  const statusCounts = readiness.items.reduce(
    (counts, item) => ({
      ...counts,
      [item.status]: counts[item.status] + 1
    }),
    { green: 0, warning: 0, blocker: 0 } satisfies Record<ReadinessStatus, number>
  );

  return (
    <section aria-label="Event readiness" className="admin-subsection">
      <h2>Event readiness</h2>
      <div className="admin-readiness-summary" aria-label="Readiness summary">
        {(["green", "warning", "blocker"] as const).map((status) =>
          statusCounts[status] > 0 ? (
            <span
              key={status}
              className={`admin-pill ${STATUS_PILL_CLASS[status]}`}
            >
              {statusCounts[status]} {STATUS_LABEL[status]}
            </span>
          ) : null
        )}
      </div>
      <ul className="admin-readiness-grid" role="list">
        {readiness.items.map((item) => {
          const confirmable = isConfirmable(item);
          return (
            <li
              key={item.id}
              className="admin-readiness-card"
              data-status={item.status}
            >
              <div className="admin-readiness-card-head">
                {STATUS_ICON[item.status]}
                <span className="admin-readiness-label">{item.label}</span>
                <span
                  className={`admin-pill ${STATUS_PILL_CLASS[item.status]}`}
                >
                  {STATUS_LABEL[item.status]}
                </span>
              </div>
              <p className="admin-readiness-detail">{item.detail}</p>
              {item.checkedAt ? (
                <p className="admin-readiness-checked-at">
                  Confirmed at {formatISTDateTime(item.checkedAt)}
                </p>
              ) : null}
              {confirmable && !readOnly ? (
                <button
                  className="admin-btn-secondary"
                  type="button"
                  onClick={() => onConfirm(item.id)}
                  disabled={pendingItemId === item.id}
                >
                  {pendingItemId === item.id
                    ? "Confirming..."
                    : CONFIRM_LABEL[item.id]}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
