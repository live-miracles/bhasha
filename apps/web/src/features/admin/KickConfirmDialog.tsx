import { Alert, Button, Checkbox, Group, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';

import { AdminDialog } from './AdminDialog';

interface KickConfirmDialogProps {
    open: boolean;
    onClose: () => void;
    onConfirm: (signOut: boolean) => void;
    title: string;
    listenerImpactLine: string;
    deviceSubLabel?: string;
    pending: boolean;
    error: string | null;
}

export function KickConfirmDialog({
    open,
    onClose,
    onConfirm,
    title,
    listenerImpactLine,
    deviceSubLabel,
    pending,
    error,
}: KickConfirmDialogProps) {
    const [signOutDevice, setSignOutDevice] = useState(false);

    useEffect(() => {
        if (open) {
            setSignOutDevice(false);
        }
    }, [open]);

    if (!open) {
        return null;
    }

    return (
        <AdminDialog open={open} onClose={onClose} title={title}>
            <Stack gap="md">
                <Text>{listenerImpactLine}</Text>
                <Text c="dimmed" size="sm">
                    The relay stays alive on silence. Listeners won't disconnect or need to rejoin.
                </Text>

                <Checkbox
                    checked={signOutDevice}
                    description={deviceSubLabel}
                    label="Also sign this device out"
                    onChange={(event) => setSignOutDevice(event.currentTarget.checked)}
                />

                {error ? <Alert color="red">{error}</Alert> : null}

                <Group justify="flex-end">
                    <Button disabled={pending} onClick={onClose} variant="default">
                        Cancel
                    </Button>
                    <Button color="red" disabled={pending} onClick={() => onConfirm(signOutDevice)}>
                        {pending ? 'Ending…' : 'End broadcast'}
                    </Button>
                </Group>
            </Stack>
        </AdminDialog>
    );
}
