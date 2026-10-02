import { FormEvent, useState } from 'react';
import { Alert, Badge, Button, Group, Paper, Stack, Text, TextInput, Tooltip } from '@mantine/core';

import { ApiError } from '../../api/client';
import { type AdminApi, type AdminRole } from '../../api/admin';
import { AdminDialog } from './AdminDialog';
import { AdminBrand } from './AdminShell';

interface AccountPanelProps {
    adminApi: Pick<AdminApi, 'changeMyPassword'>;
    username?: string | undefined;
    role?: AdminRole | undefined;
    onSignOut: () => void | Promise<void>;
}

function errorText(error: unknown): string {
    if (error instanceof ApiError) {
        if (typeof error.body === 'object' && error.body !== null && 'message' in error.body) {
            const bodyMessage = (error.body as { message?: string }).message;
            if (typeof bodyMessage === 'string' && bodyMessage.trim() !== '') {
                return bodyMessage;
            }
        }
        return error.code;
    }
    return String(error);
}

export function AdminAccountHeader({ adminApi, username, role, onSignOut }: AccountPanelProps) {
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [signingOut, setSigningOut] = useState(false);
    const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);

    async function signOut() {
        setSigningOut(true);
        try {
            await onSignOut();
        } finally {
            setSigningOut(false);
        }
    }

    function openPasswordDialog() {
        setError(null);
        setSuccess(null);
        setPasswordDialogOpen(true);
    }

    function closePasswordDialog() {
        if (pending) {
            return;
        }
        setPasswordDialogOpen(false);
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        setError(null);
    }

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (newPassword !== confirmPassword) {
            setError('Passwords do not match');
            return;
        }

        setError(null);
        setPending(true);
        try {
            await adminApi.changeMyPassword({
                ...(currentPassword ? { currentPassword } : {}),
                newPassword,
            });
            setCurrentPassword('');
            setNewPassword('');
            setConfirmPassword('');
            setPasswordDialogOpen(false);
            setSuccess('Password updated successfully.');
        } catch (passwordError) {
            setError(errorText(passwordError));
        } finally {
            setPending(false);
        }
    }

    return (
        <header aria-label="Account" className="admin-account-header">
            <AdminBrand />
            <Group className="admin-account-actions" gap="sm" wrap="wrap">
                <div className="admin-account-identity">
                    <Text fw={700} size="sm">
                        {username ?? 'Account'}
                    </Text>
                    {role ? (
                        <Badge size="sm" variant="light">
                            {role}
                        </Badge>
                    ) : null}
                </div>
                <Button
                    leftSection={<KeyIcon />}
                    onClick={openPasswordDialog}
                    size="compact-sm"
                    type="button"
                    variant="default"
                >
                    Reset
                </Button>
                <Tooltip label="Log out">
                    <Button
                        aria-label="Log out"
                        color="red"
                        disabled={signingOut}
                        loading={signingOut}
                        onClick={() => void signOut()}
                        px="xs"
                        size="compact-sm"
                        type="button"
                        variant="light"
                    >
                        <SignOutIcon />
                    </Button>
                </Tooltip>
            </Group>

            {success ? (
                <Alert color="green" mt="md">
                    {success}
                </Alert>
            ) : null}

            <AdminDialog
                open={passwordDialogOpen}
                onClose={closePasswordDialog}
                title="Reset password"
            >
                <Paper p="md" radius="md" withBorder>
                    <form onSubmit={submit}>
                        <Stack>
                            <TextInput
                                aria-label="Current password"
                                label="Current password"
                                autoComplete="current-password"
                                onChange={(event) => setCurrentPassword(event.target.value)}
                                type="password"
                                value={currentPassword}
                            />
                            <TextInput
                                aria-label="New password"
                                label="New password"
                                autoComplete="new-password"
                                onChange={(event) => setNewPassword(event.target.value)}
                                required
                                type="password"
                                value={newPassword}
                            />
                            <TextInput
                                aria-label="Confirm new password"
                                label="Confirm new password"
                                autoComplete="new-password"
                                onChange={(event) => setConfirmPassword(event.target.value)}
                                required
                                type="password"
                                value={confirmPassword}
                            />
                            {error ? (
                                <Alert color="red" role="alert">
                                    {error}
                                </Alert>
                            ) : null}
                            <Group justify="flex-end">
                                <Button
                                    onClick={closePasswordDialog}
                                    type="button"
                                    variant="default"
                                >
                                    Cancel
                                </Button>
                                <Button disabled={pending} loading={pending} type="submit">
                                    Save
                                </Button>
                            </Group>
                        </Stack>
                    </form>
                </Paper>
            </AdminDialog>
        </header>
    );
}

function KeyIcon() {
    return (
        <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 16 16" width="16">
            <circle cx="5.5" cy="10.5" r="2.9" stroke="currentColor" strokeWidth="1.3" />
            <path
                d="m7.7 8.3 5.2-5.2M11 3.9l1.1 1.1M9.1 5.8l1.1 1.1"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.3"
            />
        </svg>
    );
}

function SignOutIcon() {
    return (
        <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 16 16" width="16">
            <path
                d="M6.5 2H3.6a1.1 1.1 0 0 0-1.1 1.1v9.8a1.1 1.1 0 0 0 1.1 1.1h2.9"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.3"
            />
            <path
                d="M9.3 5.3 13 8l-3.7 2.7M13 8H6.2"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.3"
            />
        </svg>
    );
}
