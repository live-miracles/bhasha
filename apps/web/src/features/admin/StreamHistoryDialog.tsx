import { Alert, Button, Group, Stack, Table, Text } from '@mantine/core';

import type { AdminEventFeed, AdminStream } from '../../api/admin';
import { formatISTDateTime } from './formatTime';
import { AdminDialog } from './AdminDialog';
import { eventWording } from './reports/eventWording';

interface StreamHistoryDialogProps {
    stream: AdminStream | null;
    feed: AdminEventFeed | null;
    loading: boolean;
    error: string | null;
    onClose: () => void;
    onPageChange: (page: number) => void;
}

export function StreamHistoryDialog({
    stream,
    feed,
    loading,
    error,
    onClose,
    onPageChange,
}: StreamHistoryDialogProps) {
    return (
        <AdminDialog
            onClose={onClose}
            open={stream !== null}
            {...(stream ? { title: `${stream.languageName} history` } : {})}
        >
            <Stack gap="md">
                {loading ? <Text>Loading history…</Text> : null}
                {error ? <Alert color="red">Unable to load history.</Alert> : null}
                {!loading && !error && feed?.events.length === 0 ? (
                    <Text c="dimmed">No events recorded for this language.</Text>
                ) : null}
                {feed && feed.events.length > 0 ? (
                    <>
                        <Text c="dimmed" size="sm">
                            {feed.total} event{feed.total === 1 ? '' : 's'}
                        </Text>
                        <Table.ScrollContainer minWidth={560}>
                            <Table striped withTableBorder>
                                <Table.Thead>
                                    <Table.Tr>
                                        <Table.Th>Event</Table.Th>
                                        <Table.Th>Time</Table.Th>
                                    </Table.Tr>
                                </Table.Thead>
                                <Table.Tbody>
                                    {feed.events.map((event) => (
                                        <Table.Tr key={event.id}>
                                            <Table.Td>{eventWording(event)}</Table.Td>
                                            <Table.Td>
                                                {formatISTDateTime(event.occurredAt)}
                                            </Table.Td>
                                        </Table.Tr>
                                    ))}
                                </Table.Tbody>
                            </Table>
                        </Table.ScrollContainer>
                        <Group justify="space-between">
                            <Button
                                disabled={feed.page <= 1}
                                onClick={() => onPageChange(Math.max(1, feed.page - 1))}
                                type="button"
                                variant="default"
                            >
                                ← Previous
                            </Button>
                            <Text size="sm">
                                Page {feed.page} of {feed.totalPages}
                            </Text>
                            <Button
                                disabled={feed.page >= feed.totalPages}
                                onClick={() => onPageChange(feed.page + 1)}
                                type="button"
                                variant="default"
                            >
                                Next →
                            </Button>
                        </Group>
                    </>
                ) : null}
                <Group justify="flex-end">
                    <Button onClick={onClose} type="button" variant="default">
                        Close
                    </Button>
                </Group>
            </Stack>
        </AdminDialog>
    );
}
