import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Group, Paper, Stack, Table, TextInput, Title } from '@mantine/core';

import { ApiError } from '../../api/client';
import { type AdminApi, type AdminUser } from '../../api/admin';
import { AdminDialog } from './AdminDialog';

interface UsersPanelProps {
    adminApi: Pick<AdminApi, 'listUsers' | 'createUser' | 'updateUser' | 'resetUserPassword'>;
}

function errorText(error: unknown): string {
    if (error instanceof ApiError) {
        if (
            error.status === 409 &&
            error.body != null &&
            typeof error.body === 'object' &&
            'error' in error.body &&
            typeof error.body.error === 'string' &&
            error.body.error === 'username_taken'
        ) {
            return 'Username already exists.';
        }
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

export function UsersPanel({ adminApi }: UsersPanelProps) {
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [form, setForm] = useState({
        username: '',
        tempPassword: '',
    });
    const [passwordUser, setPasswordUser] = useState<AdminUser | null>(null);
    const [newPassword, setNewPassword] = useState('');
    const [resetError, setResetError] = useState<string | null>(null);
    const [resetPending, setResetPending] = useState(false);

    useEffect(() => {
        let cancelled = false;

        const load = async () => {
            try {
                const usersResponse = await adminApi.listUsers();
                if (cancelled) {
                    return;
                }
                setUsers(usersResponse.users);
            } catch (loadError) {
                if (cancelled) {
                    return;
                }
                setError(errorText(loadError));
            }
        };

        void load();

        return () => {
            cancelled = true;
        };
    }, [adminApi]);

    async function submitCreate(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError(null);
        setPending(true);
        try {
            const created = await adminApi.createUser({
                username: form.username,
                role: 'user',
                tempPassword: form.tempPassword,
            });
            setUsers((previous) => [...previous, created]);
            setForm({ username: '', tempPassword: '' });
        } catch (createError) {
            setError(errorText(createError));
        } finally {
            setPending(false);
        }
    }

    async function toggleDisabled(user: AdminUser) {
        setError(null);
        setPending(true);
        try {
            const updated = await adminApi.updateUser(user.id, {
                isDisabled: !user.isDisabled,
            });
            setUsers((previous) =>
                previous.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
            );
        } catch (toggleError) {
            setError(errorText(toggleError));
        } finally {
            setPending(false);
        }
    }

    async function openResetDialog(user: AdminUser) {
        setResetError(null);
        setNewPassword('');
        setPasswordUser(user);
    }

    function closeResetDialog() {
        if (resetPending) {
            return;
        }
        setPasswordUser(null);
        setResetError(null);
        setNewPassword('');
    }

    async function submitResetPassword(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!passwordUser) {
            return;
        }
        setResetError(null);
        setResetPending(true);
        try {
            await adminApi.resetUserPassword(passwordUser.id, {
                newPassword,
            });
            closeResetDialog();
        } catch (resetPasswordError) {
            setResetError(errorText(resetPasswordError));
        } finally {
            setResetPending(false);
        }
    }

    return (
        <section aria-label="Users" className="admin-section">
            <Title order={2}>Users</Title>

            <Paper mt="md" p="md" radius="md" withBorder>
                <Title order={3}>Invite user</Title>
                <form onSubmit={submitCreate}>
                    <Stack mt="md">
                        <TextInput
                            aria-label="Username"
                            label="Username"
                            onChange={(event) => setForm({ ...form, username: event.target.value })}
                            required
                            type="text"
                            value={form.username}
                        />
                        <TextInput
                            aria-label="Temp password"
                            label="Temp password"
                            onChange={(event) =>
                                setForm({ ...form, tempPassword: event.target.value })
                            }
                            required
                            type="password"
                            value={form.tempPassword}
                        />
                        <Button disabled={pending} loading={pending} type="submit">
                            Create user
                        </Button>
                    </Stack>
                </form>
            </Paper>

            {error ? (
                <Alert color="red" mt="md" role="alert">
                    {error}
                </Alert>
            ) : null}

            {users.length === 0 ? <p>No users yet.</p> : null}
            {users.length > 0 ? (
                <Table mt="md" striped withTableBorder>
                    <Table.Thead>
                        <Table.Tr>
                            <Table.Th>Username</Table.Th>
                            <Table.Th>Role</Table.Th>
                            <Table.Th>Status</Table.Th>
                            <Table.Th>Actions</Table.Th>
                        </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                        {users.map((user) => (
                            <Table.Tr key={user.id}>
                                <Table.Td>{user.username}</Table.Td>
                                <Table.Td>{user.role}</Table.Td>
                                <Table.Td>
                                    <Badge color={user.isDisabled ? 'gray' : 'green'}>
                                        {user.isDisabled ? 'Disabled' : 'Active'}
                                    </Badge>
                                </Table.Td>
                                <Table.Td>
                                    <Group gap="xs">
                                        <Button
                                            disabled={pending}
                                            onClick={() => void toggleDisabled(user)}
                                            size="compact-sm"
                                            type="button"
                                            variant="default"
                                        >
                                            {user.isDisabled ? 'Enable' : 'Disable'}
                                        </Button>
                                        <Button
                                            disabled={pending}
                                            onClick={() => void openResetDialog(user)}
                                            size="compact-sm"
                                            type="button"
                                            variant="default"
                                        >
                                            Reset password
                                        </Button>
                                    </Group>
                                </Table.Td>
                            </Table.Tr>
                        ))}
                    </Table.Tbody>
                </Table>
            ) : null}

            <AdminDialog open={passwordUser !== null} onClose={closeResetDialog}>
                <Paper p="md" radius="md" withBorder>
                    <form onSubmit={submitResetPassword}>
                        <Stack>
                            <p>
                                Set a new temporary password for{' '}
                                <strong>{passwordUser?.username}</strong>
                            </p>
                            <TextInput
                                aria-label="New password"
                                label="New password"
                                autoComplete="new-password"
                                onChange={(event) => setNewPassword(event.target.value)}
                                required
                                type="password"
                                value={newPassword}
                            />
                            {resetError ? <Alert color="red">{resetError}</Alert> : null}
                            <Group>
                                <Button type="button" onClick={closeResetDialog} variant="default">
                                    Cancel
                                </Button>
                                <Button
                                    disabled={resetPending || newPassword.trim().length === 0}
                                    type="submit"
                                >
                                    Reset
                                </Button>
                            </Group>
                        </Stack>
                    </form>
                </Paper>
            </AdminDialog>
        </section>
    );
}
