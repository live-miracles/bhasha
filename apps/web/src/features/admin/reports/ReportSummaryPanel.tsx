import { KpiTile } from '../AdminShell';
import type { AdminReportSummary } from '../../../api/admin';

interface ReportSummaryPanelProps {
    summary: AdminReportSummary | null;
    rangeActive?: boolean;
    rangeLabel?: string | null;
    onRangeChipClick?: () => void;
    isFetching?: boolean;
}

function RangeChip({
    label,
    onClick,
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

export function ReportSummaryPanel({
    summary,
    rangeActive = false,
    rangeLabel = null,
    onRangeChipClick,
    isFetching = false,
}: ReportSummaryPanelProps) {
    if (!summary) {
        return (
            <section aria-label="Report summary" className="admin-subsection">
                <div className="admin-panel-heading">
                    <h2>Report summary</h2>
                    <RangeChip label={rangeLabel} onClick={onRangeChipClick} />
                </div>
                <p>Loading report summary...</p>
            </section>
        );
    }

    return (
        <section aria-label="Report summary" className="admin-subsection">
            <div className="admin-panel-heading">
                <h2>Report summary</h2>
                <RangeChip label={rangeLabel} onClick={onRangeChipClick} />
            </div>
            <div
                className="admin-refetch-dim"
                data-testid="report-summary-body"
                style={{
                    opacity: isFetching ? 0.6 : 1,
                    pointerEvents: isFetching ? 'none' : 'auto',
                }}
            >
                <div className="admin-kpi-strip">
                    <KpiTile
                        label="Total connections"
                        value={summary.totals.totalConnections.toString()}
                    />
                    <KpiTile
                        label="Unique devices"
                        value={summary.totals.uniqueDevices.toString()}
                    />
                    <KpiTile label="Dropouts" value={summary.totals.dropouts.toString()} />
                    <KpiTile label="Reconnects" value={summary.totals.reconnects.toString()} />
                    <div className="admin-kpi admin-kpi-live">
                        <span className="admin-kpi-value admin-kpi-value-live">
                            {summary.totals.activeListeners}
                            <span className="admin-pill admin-pill-live">LIVE</span>
                        </span>
                        <span className="admin-kpi-label">Active now</span>
                        {rangeActive ? <span className="admin-hint">(not windowed)</span> : null}
                    </div>
                </div>
                <table className="admin-table">
                    <thead>
                        <tr>
                            <th>Language</th>
                            <th>Active (now)</th>
                            <th>Connections</th>
                            <th>Dropouts</th>
                            <th>Reconnects</th>
                        </tr>
                    </thead>
                    <tbody>
                        {summary.streams.map((stream) => (
                            <tr key={stream.streamId}>
                                <td>{stream.languageName}</td>
                                <td>{stream.activeListeners}</td>
                                <td>{stream.totalConnections}</td>
                                <td>{stream.dropouts}</td>
                                <td>{stream.reconnects}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <p className="admin-hint">
                    Active column shows current listeners, not the selected window.
                </p>
            </div>
        </section>
    );
}
