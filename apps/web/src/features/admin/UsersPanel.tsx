import { useEffect, useState, type FormEvent } from 'react';

import { ApiError } from '../../api/client';
import {
    type AdminApi,
    type AdminMe,
    type AdminOrg,
    type AdminRole,
    type AdminUser,
} from '../../api/admin';
import { AdminDialog } from './AdminDialog';

interface UsersPanelProps {
    adminApi: Pick<
        AdminApi,
        'listUsers' | 'listOrgs' | 'createUser' | 'updateUser' | 'resetUserPassword'
    >;
    identity: AdminMe | null;
}

function errorText(error: unknown): string {
    if (error instanceof ApiError) {
        if (
            error.status === 409 &&
            error.body != null &&
            typeof error.body === 'object' &&
            'error' in error.body &&
            typeof error.body.error === 'string'
        ) {
            if (error.body.error === 'email_taken') {
                return 'Email already exists.';
            }
            if (error.body.error === 'org_admin_exists') {
                return 'An org admin already exists for this organization.';
            }
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

export function UsersPanel({ adminApi, identity }: UsersPanelProps) {
    const isPlatform = identity?.role === 'platform_admin';
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [orgs, setOrgs] = useState<AdminOrg[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [form, setForm] = useState({
        email: '',
        role: 'viewer' as AdminRole,
        orgId: '',
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
                // GET /api/admin/orgs is platform_admin-only (403 for org_admin), so only
                // fetch the org list when we actually need it (the platform create form's
                // org selector). An org_admin creates viewers in its own org — no list needed.
                const usersResponse = await adminApi.listUsers();
                const orgsResponse = isPlatform ? await adminApi.listOrgs() : null;
                if (cancelled) {
                    return;
                }
                setUsers(usersResponse.users);
                if (orgsResponse) {
                    setOrgs(orgsResponse.orgs);
                }
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
    }, [adminApi, isPlatform]);

    function orgName(orgId: string) {
        const fromList = orgs.find((org) => org.id === orgId)?.name;
        if (fromList) {
            return fromList;
        }
        // org_admin has no org list; fall back to its own org name for own-org rows.
        if (identity?.orgId === orgId && identity.orgName) {
            return identity.orgName;
        }
        return '—';
    }

    async function submitCreate(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError(null);
        setPending(true);
        try {
            const role = isPlatform ? form.role : 'viewer';
            // platform: platform_admin ⇒ no org; org role ⇒ chosen org. org_admin: the
            // server forces the caller's own org, so send null and let it decide.
            const orgId = !isPlatform
                ? null
                : role === 'platform_admin'
                  ? null
                  : form.orgId || null;
            const created = await adminApi.createUser({
                email: form.email,
                role,
                tempPassword: form.tempPassword,
                orgId,
            });
            setUsers((previous) => [...previous, created]);
            setForm({
                email: '',
                role: isPlatform ? 'viewer' : 'viewer',
                orgId: '',
                tempPassword: '',
            });
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
                <h2>{isPlatform ? 'Users' : 'Team'}</h2>
            </div>

            <article className="admin-card">
                <h2>{isPlatform ? 'Invite user' : 'Invite viewer'}</h2>
                <form className="admin-form" onSubmit={submitCreate}>
                    <label>
                        User email
                        <input
                            onChange={(event) => setForm({ ...form, email: event.target.value })}
                            required
                            type="email"
                            value={form.email}
                        />
                    </label>

                    {isPlatform ? (
                        <label>
                            Role
                            <select
                                onChange={(event) =>
                                    setForm({
                                        ...form,
                                        role: event.target.value as AdminRole,
                                        orgId:
                                            event.target.value === 'platform_admin'
                                                ? ''
                                                : form.orgId,
                                    })
                                }
                                value={form.role}
                            >
                                <option value="viewer">viewer</option>
                                <option value="org_admin">org_admin</option>
                                <option value="platform_admin">platform_admin</option>
                            </select>
                        </label>
                    ) : null}

                    {isPlatform && form.role !== 'platform_admin' ? (
                        <label>
                            Organization
                            <select
                                onChange={(event) =>
                                    setForm({ ...form, orgId: event.target.value })
                                }
                                required
                                value={form.orgId}
                            >
                                <option value="">Select organization</option>
                                {orgs.map((org) => (
                                    <option key={org.id} value={org.id}>
                                        {org.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ) : null}

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
                        {isPlatform ? 'Create user' : 'Create viewer'}
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
                            <th>Email</th>
                            <th>Role</th>
                            <th>Organization</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {users.map((user) => (
                            <tr key={user.id}>
                                <td>{user.email}</td>
                                <td>{user.role}</td>
                                <td>{user.orgId ? orgName(user.orgId) : '—'}</td>
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
                            Set a new temporary password for <strong>{passwordUser?.email}</strong>
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
