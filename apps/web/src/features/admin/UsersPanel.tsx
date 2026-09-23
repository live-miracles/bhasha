import { useEffect, useState, type FormEvent } from 'react';

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
            <div className="admin-section-head">
                <h2>Users</h2>
            </div>

            <article className="admin-card">
                <h2>Invite user</h2>
                <form className="admin-form" onSubmit={submitCreate}>
                    <label>
                        Username
                        <input
                            onChange={(event) =>
                                setForm({ ...form, username: event.target.value })
                            }
                            required
                            type="text"
                            value={form.username}
                        />
                    </label>

                    <label>
                        Temp password
                        <input
                            onChange={(event) =>
                                setForm({ ...form, tempPassword: event.target.value })
                            }
                            required
                            type="password"
                            value={form.tempPassword}
                        />
                    </label>

                    <button disabled={pending} type="submit">
                        Create user
                    </button>
                </form>
            </article>

            {error ? (
                <p className="admin-alert" role="alert">
                    {error}
                </p>
            ) : null}

            {users.length === 0 ? <p>No users yet.</p> : null}
            {users.length > 0 ? (
                <table className="admin-table">
                    <thead>
                        <tr>
                            <th>Username</th>
                            <th>Role</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {users.map((user) => (
                            <tr key={user.id}>
                                <td>{user.username}</td>
                                <td>{user.role}</td>
                                <td>{user.isDisabled ? 'Disabled' : 'Active'}</td>
                                <td>
                                    <button
                                        disabled={pending}
                                        onClick={() => void toggleDisabled(user)}
                                        type="button"
                                    >
                                        {user.isDisabled ? 'Enable' : 'Disable'}
                                    </button>
                                    <button
                                        disabled={pending}
                                        onClick={() => void openResetDialog(user)}
                                        type="button"
                                    >
                                        Reset password
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : null}

            <AdminDialog open={passwordUser !== null} onClose={closeResetDialog}>
                <div className="admin-card">
                    <form className="admin-form" onSubmit={submitResetPassword}>
                        <p>
                            Set a new temporary password for{' '}
                            <strong>{passwordUser?.username}</strong>
                        </p>
                        <label>
                            New password
                            <input
                                autoComplete="new-password"
                                onChange={(event) => setNewPassword(event.target.value)}
                                required
                                type="password"
                                value={newPassword}
                            />
                        </label>
                        {resetError ? <p className="admin-alert">{resetError}</p> : null}
                        <div className="admin-actions">
                            <button type="button" onClick={closeResetDialog}>
                                Cancel
                            </button>
                            <button
                                disabled={resetPending || newPassword.trim().length === 0}
                                type="submit"
                            >
                                {resetPending ? 'Resetting…' : 'Reset'}
                            </button>
                        </div>
                    </form>
                </div>
            </AdminDialog>
        </section>
    );
}
