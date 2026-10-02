import { FormEvent, ReactNode, useId, useState } from 'react';
import { Alert, Button, NativeSelect, Paper, Stack, TextInput, Title } from '@mantine/core';

type LoginPageProps = {
    eyebrow?: ReactNode;
    heading?: ReactNode;
    title: ReactNode;
    identityLabel: string;
    identityType?: 'email' | 'text';
    identityOptions?: Array<{ value: string; label: string }>;
    identityValue: string;
    onIdentityChange: (value: string) => void;
    passwordValue: string;
    onPasswordChange: (value: string) => void;
    passwordLabel?: string;
    passwordRequired?: boolean;
    error?: string | null;
    pending?: boolean;
    onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
    submitLabel?: string;
};

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

export function LoginPage({
    eyebrow,
    heading,
    title,
    identityLabel,
    identityType = 'text',
    identityOptions,
    identityValue,
    onIdentityChange,
    passwordValue,
    onPasswordChange,
    passwordLabel = 'Password',
    passwordRequired = true,
    error,
    pending = false,
    onSubmit,
    submitLabel = 'Log in',
}: LoginPageProps) {
    const [passwordVisible, setPasswordVisible] = useState(false);
    const passwordInputId = useId();

    return (
        <section aria-label={`${title} login`} className="login-page">
            <div className="login-page-content">
                {heading || eyebrow ? (
                    <div className="login-page-heading">
                        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
                        {heading ? <Title order={1}>{heading}</Title> : null}
                    </div>
                ) : null}
                <Paper className="login-page-card" p="lg" radius="md" withBorder>
                    <form autoComplete="on" onSubmit={onSubmit}>
                        <Title order={2}>{title}</Title>
                        {error ? (
                            <Alert color="red" mt="md" role="alert">
                                {error}
                            </Alert>
                        ) : null}
                        <Stack mt="md">
                            {identityOptions ? (
                                <NativeSelect
                                    aria-label={identityLabel}
                                    data={identityOptions}
                                    label={identityLabel}
                                    onChange={(event) => onIdentityChange(event.target.value)}
                                    required
                                    value={identityValue}
                                />
                            ) : (
                                <TextInput
                                    aria-label={identityLabel}
                                    autoComplete="username"
                                    label={identityLabel}
                                    name="username"
                                    onChange={(event) => onIdentityChange(event.target.value)}
                                    required
                                    type={identityType}
                                    value={identityValue}
                                />
                            )}
                            <TextInput
                                aria-describedby={`${passwordInputId}-visibility`}
                                aria-label={passwordLabel}
                                autoComplete="current-password"
                                id={passwordInputId}
                                label={passwordLabel}
                                name="password"
                                onChange={(event) => onPasswordChange(event.target.value)}
                                required={passwordRequired}
                                rightSection={
                                    <button
                                        aria-label={
                                            passwordVisible ? 'Hide password' : 'Show password'
                                        }
                                        className="password-visibility-button"
                                        onClick={() => setPasswordVisible((visible) => !visible)}
                                        type="button"
                                    >
                                        <EyeIcon slashed={!passwordVisible} />
                                    </button>
                                }
                                rightSectionPointerEvents="auto"
                                type={passwordVisible ? 'text' : 'password'}
                                value={passwordValue}
                            />
                            <span className="sr-only" id={`${passwordInputId}-visibility`}>
                                {passwordVisible ? 'Password is visible' : 'Password is hidden'}
                            </span>
                            <Button disabled={pending} loading={pending} type="submit">
                                {submitLabel}
                            </Button>
                        </Stack>
                    </form>
                </Paper>
            </div>
        </section>
    );
}
