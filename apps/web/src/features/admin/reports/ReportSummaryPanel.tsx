import { AdminUiProvider, KpiTile } from '../AdminShell';
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
        <Button size="compact-sm" type="button" onClick={onClick} variant="light">
            {label}
        </Button>
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
            <AdminUiProvider>
                <section aria-label="Report summary" className="admin-subsection">
                    <Group justify="space-between" mb="md">
                        <Title order={2}>Report summary</Title>
                        <RangeChip label={rangeLabel} onClick={onRangeChipClick} />
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
                    <RangeChip label={rangeLabel} onClick={onRangeChipClick} />
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
                    <Text c="dimmed" size="sm">
                        Active column shows current listeners, not the selected window.
                    </Text>
                </div>
            </section>
        </AdminUiProvider>
    );
}
import { Badge, Button, Group, Table, Text, Title } from '@mantine/core';
