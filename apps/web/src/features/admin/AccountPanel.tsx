import { FormEvent, useState } from 'react';
import { Alert, Button, Paper, Stack, Text, TextInput, Title } from '@mantine/core';

import { ApiError } from '../../api/client';
import { type AdminApi } from '../../api/admin';

interface AccountPanelProps {
    adminApi: Pick<AdminApi, 'changeMyPassword'>;
    username?: string | undefined;
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

export function AccountPanel({ adminApi, username, onSignOut }: AccountPanelProps) {
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [signingOut, setSigningOut] = useState(false);

    async function signOut() {
        setSigningOut(true);
        try {
            await onSignOut();
        } finally {
            setSigningOut(false);
        }
    }

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (newPassword !== confirmPassword) {
            setError('Passwords do not match');
            return;
        }

        setError(null);
        setSuccess(null);
        setPending(true);
        try {
            await adminApi.changeMyPassword({
                ...(currentPassword ? { currentPassword } : {}),
                newPassword,
            });
            setCurrentPassword('');
            setNewPassword('');
            setConfirmPassword('');
            setSuccess('Password updated successfully.');
        } catch (passwordError) {
            setError(errorText(passwordError));
        } finally {
            setPending(false);
        }
    }

    return (
        <section aria-label="Account" className="admin-section">
            <Title order={2}>Account</Title>
            <Paper mt="md" p="md" radius="md" withBorder>
                <Title order={3}>Change password</Title>
                <form onSubmit={submit}>
                    <Stack mt="md">
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
                        <Button disabled={pending} loading={pending} type="submit">
                            Change password
                        </Button>
                    </Stack>
                </form>
            </Paper>

            <Paper mt="md" p="md" radius="md" withBorder>
                <Title order={3}>Session</Title>
                {username ? <Text mt="xs">Signed in as {username}</Text> : null}
                <Button
                    disabled={signingOut}
                    loading={signingOut}
                    onClick={() => void signOut()}
                    type="button"
                    variant="default"
                >
                    Sign out
                </Button>
            </Paper>

            {error ? (
                <Alert color="red" mt="md" role="alert">
                    {error}
                </Alert>
            ) : null}
            {success ? (
                <Alert color="green" mt="md">
                    {success}
                </Alert>
            ) : null}
        </section>
    );
}
