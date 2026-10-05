import { Badge, Button, Group, Table, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';

import { AdminUiProvider, KpiTile } from '../AdminShell';
import type { AdminReportSummary } from '../../../api/admin';

interface ReportSummaryPanelProps {
    summary: AdminReportSummary | null;
    rangeActive?: boolean;
    rangeLabel?: string | null;
    onRangeChipClick?: () => void;
    rangeControl?: ReactNode;
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
        <Button size="compact-sm" type="button" onClick={onClick} variant="light">
            {label}
        </Button>
    );
}

const CHART_COLORS = ['#2563eb', '#d97706', '#059669', '#dc2626', '#7c3aed', '#0891b2'];

function ReportLineChart({
    title,
    metric,
    summary,
}: {
    title: string;
    metric: 'listeners' | 'reliability' | 'approvals';
    summary: AdminReportSummary;
}) {
    const series = summary.series ?? { bucket: 'day' as const, points: [] };
    const width = 720;
    const height = 220;
    const left = 36;
    const right = 12;
    const top = 16;
    const bottom = 28;
    const chartWidth = width - left - right;
    const chartHeight = height - top - bottom;
    const values = series.points.flatMap((point) =>
        point.streams.map((stream) =>
            metric === 'listeners'
                ? stream.activeListeners
                : metric === 'approvals'
                  ? stream.approvals
                  : stream.dropouts + stream.reconnects,
        ),
    );
    const maxValue = Math.max(1, ...values);
    const xFor = (index: number) =>
        left + (series.points.length <= 1 ? 0 : (index / (series.points.length - 1)) * chartWidth);
    const yFor = (value: number) => top + chartHeight - (value / maxValue) * chartHeight;
    const firstPoint = series.points[0];
    const lastPoint = series.points.at(-1) ?? firstPoint;
    const labelFor = (value: string) =>
        new Intl.DateTimeFormat(
            undefined,
            series.bucket === 'day'
                ? { month: 'short', day: 'numeric' }
                : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
        ).format(new Date(value));

    return (
        <section aria-label={title} className="admin-report-chart-card">
            <Group justify="space-between" mb="xs">
                <Title order={3}>{title}</Title>
                <Text c="dimmed" size="xs">
                    {series.bucket} buckets
                </Text>
            </Group>
            <svg
                aria-label={`${title} chart`}
                className="admin-report-chart"
                role="img"
                viewBox={`0 0 ${width} ${height}`}
            >
                {[0, 0.5, 1].map((fraction) => {
                    const y = top + chartHeight * fraction;
                    return (
                        <g key={fraction}>
                            <line
                                stroke="currentColor"
                                strokeOpacity="0.12"
                                x1={left}
                                x2={width - right}
                                y1={y}
                                y2={y}
                            />
                            <text
                                fill="currentColor"
                                fontSize="10"
                                textAnchor="end"
                                x={left - 6}
                                y={y + 3}
                            >
                                {Math.round(maxValue * (1 - fraction))}
                            </text>
                        </g>
                    );
                })}
                {summary.streams.map((stream, streamIndex) => {
                    const points = series.points
                        .map((point, pointIndex) => {
                            const value = point.streams.find(
                                (item) => item.streamId === stream.streamId,
                            );
                            const amount = value
                                ? metric === 'listeners'
                                    ? value.activeListeners
                                    : metric === 'approvals'
                                      ? value.approvals
                                      : value.dropouts + value.reconnects
                                : 0;
                            return `${xFor(pointIndex)},${yFor(amount)}`;
                        })
                        .join(' ');
                    return (
                        <polyline
                            fill="none"
                            key={stream.streamId}
                            points={points}
                            stroke={CHART_COLORS[streamIndex % CHART_COLORS.length]}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2.5"
                        />
                    );
                })}
                {firstPoint && lastPoint ? (
                    <>
                        <text fill="currentColor" fontSize="10" x={left} y={height - 8}>
                            {labelFor(firstPoint.bucketStart)}
                        </text>
                        <text
                            fill="currentColor"
                            fontSize="10"
                            textAnchor="end"
                            x={width - right}
                            y={height - 8}
                        >
                            {labelFor(lastPoint.bucketStart)}
                        </text>
                    </>
                ) : null}
            </svg>
            <div className="admin-report-chart-legend">
                {summary.streams.map((stream, index) => (
                    <span key={stream.streamId}>
                        <i style={{ backgroundColor: CHART_COLORS[index % CHART_COLORS.length] }} />
                        {stream.languageName}
                    </span>
                ))}
            </div>
        </section>
    );
}

export function ReportSummaryPanel({
    summary,
    rangeActive = false,
    rangeLabel = null,
    onRangeChipClick,
    rangeControl,
    isFetching = false,
}: ReportSummaryPanelProps) {
    if (!summary) {
        return (
            <AdminUiProvider>
                <section aria-label="Report summary" className="admin-subsection">
                    <Group justify="space-between" mb="md">
                        <Title order={2}>Report summary</Title>
                        {rangeControl ?? (
                            <RangeChip label={rangeLabel} onClick={onRangeChipClick} />
                        )}
                    </Group>
                    <p>Loading report summary...</p>
                </section>
            </AdminUiProvider>
        );
    }

    return (
        <AdminUiProvider>
            <section aria-label="Report summary" className="admin-subsection">
                <Group justify="space-between" mb="md">
                    <Title order={2}>Report summary</Title>
                    {rangeControl ?? <RangeChip label={rangeLabel} onClick={onRangeChipClick} />}
                </Group>
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
                            value={String(summary.totals.uniqueDevices ?? 0)}
                        />
                        <KpiTile label="Dropouts" value={summary.totals.dropouts.toString()} />
                        <KpiTile label="Reconnects" value={summary.totals.reconnects.toString()} />
                        <div className="admin-kpi admin-kpi-live">
                            <Text component="div" fw={700} size="xl">
                                {summary.totals.activeListeners}
                                <Badge color="green" ml="xs">
                                    LIVE
                                </Badge>
                            </Text>
                            <Text c="dimmed" size="sm">
                                Active now
                            </Text>
                            {rangeActive ? (
                                <Text c="dimmed" size="xs">
                                    (not windowed)
                                </Text>
                            ) : null}
                        </div>
                    </div>
                    <Table striped withTableBorder>
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>Language</Table.Th>
                                <Table.Th>Active (now)</Table.Th>
                                <Table.Th>Connections</Table.Th>
                                <Table.Th>Dropouts</Table.Th>
                                <Table.Th>Reconnects</Table.Th>
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {summary.streams.map((stream) => (
                                <Table.Tr key={stream.streamId}>
                                    <Table.Td>{stream.languageName}</Table.Td>
                                    <Table.Td>{stream.activeListeners}</Table.Td>
                                    <Table.Td>{stream.totalConnections}</Table.Td>
                                    <Table.Td>{stream.dropouts}</Table.Td>
                                    <Table.Td>{stream.reconnects}</Table.Td>
                                </Table.Tr>
                            ))}
                        </Table.Tbody>
                    </Table>
                    <div className="admin-report-chart-grid">
                        <ReportLineChart
                            metric="listeners"
                            summary={summary}
                            title="Active listeners over time"
                        />
                        <ReportLineChart
                            metric="reliability"
                            summary={summary}
                            title="Listener reconnects and dropouts"
                        />
                        <ReportLineChart
                            metric="approvals"
                            summary={summary}
                            title="Listener approvals"
                        />
                    </div>
                    <Text c="dimmed" size="sm">
                        Active column shows current listeners, not the selected window.
                    </Text>
                </div>
            </section>
        </AdminUiProvider>
    );
}
