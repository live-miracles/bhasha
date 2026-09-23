import { FormEvent, useState } from 'react';

import { ApiError } from '../../api/client';
import { type AdminApi } from '../../api/admin';

interface AccountPanelProps {
    adminApi: Pick<AdminApi, 'changeMyPassword'>;
    email?: string | undefined;
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

export function AccountPanel({ adminApi, email, onSignOut }: AccountPanelProps) {
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
            <div className="admin-section-head">
                <h2>Account</h2>
            </div>
            <article className="admin-card">
                <h2>Change password</h2>
                <form className="admin-form" onSubmit={submit}>
                    <label>
                        Current password
                        <input
                            autoComplete="current-password"
                            onChange={(event) => setCurrentPassword(event.target.value)}
                            type="password"
                            value={currentPassword}
                        />
                    </label>
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
                    <label>
                        Confirm new password
                        <input
                            autoComplete="new-password"
                            onChange={(event) => setConfirmPassword(event.target.value)}
                            required
                            type="password"
                            value={confirmPassword}
                        />
                    </label>
                    <button disabled={pending} type="submit">
                        {pending ? 'Changing…' : 'Change password'}
                    </button>
                </form>
            </article>

            <article className="admin-card">
                <h2>Session</h2>
                {email ? <p className="admin-prog-label">Signed in as {email}</p> : null}
                <button
                    className="admin-secondary"
                    disabled={signingOut}
                    onClick={() => void signOut()}
                    type="button"
                >
                    {signingOut ? 'Signing out…' : 'Sign out'}
                </button>
            </article>

            {error ? (
                <p className="admin-alert" role="alert">
                    {error}
                </p>
            ) : null}
            {success ? <p className="admin-session-count--active">{success}</p> : null}
        </section>
    );
}
