import { Alert, Button, Group, Stack, Text } from '@mantine/core';

import { AdminDialog } from './AdminDialog';

interface ConfirmDialogProps {
    open: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: string;
    confirmLabel?: string;
    pending: boolean;
    error: string | null;
}

export function ConfirmDialog({
    open,
    onClose,
    onConfirm,
    title,
    message,
    confirmLabel,
    pending,
    error,
}: ConfirmDialogProps) {
    if (!open) {
        return null;
    }

    return (
        <AdminDialog open={open} onClose={onClose} title={title}>
            <Stack gap="lg">
                <Text>{message}</Text>
                {error ? <Alert color="red">{error}</Alert> : null}
                <Group justify="flex-end">
                    <Button disabled={pending} onClick={onClose} variant="default">
                        Cancel
                    </Button>
                    <Button color="red" disabled={pending} onClick={onConfirm}>
                        {pending ? 'Ending…' : (confirmLabel ?? 'Confirm')}
                    </Button>
                </Group>
            </Stack>
        </AdminDialog>
    );
}
