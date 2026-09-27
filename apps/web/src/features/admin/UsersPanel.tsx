import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Group, Paper, Stack, Table, TextInput, Title } from '@mantine/core';

import { ApiError } from '../../api/client';
import { type AdminApi, type AdminUser } from '../../api/admin';
import { AdminDialog } from './AdminDialog';

interface UsersPanelProps {
    adminApi: Pick<
        AdminApi,
        'listUsers' | 'createUser' | 'updateUser' | 'deleteUser' | 'resetUserPassword'
    >;
    currentUserId: string;
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

export function UsersPanel({ adminApi, currentUserId }: UsersPanelProps) {
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [createOpen, setCreateOpen] = useState(false);
    const [createPasswordVisible, setCreatePasswordVisible] = useState(false);
    const [form, setForm] = useState({
        username: '',
        password: '',
    });
    const [passwordUser, setPasswordUser] = useState<AdminUser | null>(null);
    const [newPassword, setNewPassword] = useState('');
    const [resetError, setResetError] = useState<string | null>(null);
    const [resetPending, setResetPending] = useState(false);
    const [editUser, setEditUser] = useState<AdminUser | null>(null);
    const [editUsername, setEditUsername] = useState('');
    const [editPending, setEditPending] = useState(false);

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
                password: form.password,
            });
            setUsers((previous) => [...previous, created]);
            setForm({ username: '', password: '' });
            setCreateOpen(false);
        } catch (createError) {
            setError(errorText(createError));
        } finally {
            setPending(false);
        }
    }

    function openEditDialog(user: AdminUser) {
        setEditUser(user);
        setEditUsername(user.username);
        setError(null);
    }

    async function submitEdit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!editUser) return;
        setEditPending(true);
        try {
            const updated = await adminApi.updateUser(editUser.id, { username: editUsername });
            setUsers((previous) =>
                previous.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
            );
            setEditUser(null);
        } catch (editError) {
            setError(errorText(editError));
        } finally {
            setEditPending(false);
        }
    }

    async function deleteUser(user: AdminUser) {
        if (user.id === currentUserId || !window.confirm(`Delete user "${user.username}"?`)) return;
        setError(null);
        setPending(true);
        try {
            await adminApi.deleteUser(user.id);
            setUsers((previous) => previous.filter((candidate) => candidate.id !== user.id));
        } catch (deleteError) {
            setError(errorText(deleteError));
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
            <Group justify="space-between" mb="md">
                <Title order={2}>Users</Title>
                <Button
                    aria-label="Add user"
                    className="admin-add-program-button"
                    leftSection={<PlusIcon />}
                    onClick={() => {
                        setError(null);
                        setCreatePasswordVisible(false);
                        setCreateOpen(true);
                    }}
                    type="button"
                >
                    <span className="admin-add-program-label">Add user</span>
                </Button>
            </Group>

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
                            <Table.Th>Actions</Table.Th>
                        </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                        {users.map((user) => (
                            <Table.Tr key={user.id}>
                                <Table.Td>{user.username}</Table.Td>
                                <Table.Td>{user.role}</Table.Td>
                                <Table.Td>
                                    <Group gap="xs">
                                        {user.id === currentUserId ? (
                                            <span>Current account</span>
                                        ) : (
                                            <>
                                                <Button
                                                    disabled={pending}
                                                    onClick={() => openEditDialog(user)}
                                                    size="compact-sm"
                                                    type="button"
                                                    variant="default"
                                                >
                                                    Edit name
                                                </Button>
                                                <Button
                                                    color="red"
                                                    disabled={pending}
                                                    onClick={() => void deleteUser(user)}
                                                    size="compact-sm"
                                                    type="button"
                                                    variant="default"
                                                >
                                                    Delete
                                                </Button>
                                            </>
                                        )}
                                        {user.id !== currentUserId ? (
                                            <Button
                                                disabled={pending}
                                                onClick={() => void openResetDialog(user)}
                                                size="compact-sm"
                                                type="button"
                                                variant="default"
                                            >
                                                Reset password
                                            </Button>
                                        ) : null}
                                    </Group>
                                </Table.Td>
                            </Table.Tr>
                        ))}
                    </Table.Tbody>
                </Table>
            ) : null}

            <AdminDialog open={createOpen} onClose={() => setCreateOpen(false)} title="Create user">
                <Paper p="md" radius="md" withBorder>
                    <form onSubmit={submitCreate}>
                        <Stack>
                            <TextInput
                                aria-label="Username"
                                label="Username"
                                onChange={(event) =>
                                    setForm({ ...form, username: event.target.value })
                                }
                                required
                                type="text"
                                value={form.username}
                            />
                            <TextInput
                                aria-label="Password"
                                aria-describedby="create-user-password-visibility"
                                label="Password"
                                id="create-user-password"
                                onChange={(event) =>
                                    setForm({ ...form, password: event.target.value })
                                }
                                required
                                rightSection={
                                    <button
                                        aria-label={
                                            createPasswordVisible
                                                ? 'Hide password'
                                                : 'Show password'
                                        }
                                        className="password-visibility-button"
                                        onClick={() =>
                                            setCreatePasswordVisible((visible) => !visible)
                                        }
                                        type="button"
                                    >
                                        <EyeIcon slashed={!createPasswordVisible} />
                                    </button>
                                }
                                rightSectionPointerEvents="auto"
                                type={createPasswordVisible ? 'text' : 'password'}
                                value={form.password}
                            />
                            <span className="sr-only" id="create-user-password-visibility">
                                {createPasswordVisible
                                    ? 'Password is visible'
                                    : 'Password is hidden'}
                            </span>
                            {error ? (
                                <Alert color="red" role="alert">
                                    {error}
                                </Alert>
                            ) : null}
                            <Group justify="flex-end">
                                <Button
                                    onClick={() => setCreateOpen(false)}
                                    type="button"
                                    variant="default"
                                >
                                    Cancel
                                </Button>
                                <Button disabled={pending} loading={pending} type="submit">
                                    Create user
                                </Button>
                            </Group>
                        </Stack>
                    </form>
                </Paper>
            </AdminDialog>

            <AdminDialog
                open={editUser !== null}
                onClose={() => setEditUser(null)}
                title="Edit user name"
            >
                <Paper p="md" radius="md" withBorder>
                    <form onSubmit={submitEdit}>
                        <Stack>
                            <TextInput
                                aria-label="Username"
                                label="Username"
                                onChange={(event) => setEditUsername(event.target.value)}
                                required
                                value={editUsername}
                            />
                            <Group justify="flex-end">
                                <Button
                                    onClick={() => setEditUser(null)}
                                    type="button"
                                    variant="default"
                                >
                                    Cancel
                                </Button>
                                <Button disabled={editPending} loading={editPending} type="submit">
                                    Save
                                </Button>
                            </Group>
                        </Stack>
                    </form>
                </Paper>
            </AdminDialog>

            <AdminDialog open={passwordUser !== null} onClose={closeResetDialog}>
                <Paper p="md" radius="md" withBorder>
                    <form onSubmit={submitResetPassword}>
                        <Stack>
                            <p>
                                Set a new password for <strong>{passwordUser?.username}</strong>
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

function PlusIcon() {
    return (
        <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 16 16" width="16">
            <path
                d="M8 3v10M3 8h10"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1.8"
            />
        </svg>
    );
}

function EyeIcon({ slashed }: { slashed: boolean }) {
    return (
        <svg aria-hidden="true" fill="none" height="20" viewBox="0 0 24 24" width="20">
            <path
                d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
            />
            <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.8" />
            {slashed ? (
                <path
                    d="m4 4 16 16"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeWidth="1.8"
                />
            ) : null}
        </svg>
    );
}
