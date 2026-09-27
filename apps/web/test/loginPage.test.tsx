import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it } from 'vitest';

import { LoginPage } from '../src/components/LoginPage';

afterEach(cleanup);

describe('LoginPage', () => {
    it('centers the shared login layout and toggles password visibility with an SVG control', () => {
        render(
            <MantineProvider>
                <LoginPage
                    heading="Event name"
                    identityLabel="Email"
                    identityValue=""
                    onIdentityChange={() => undefined}
                    onPasswordChange={() => undefined}
                    onSubmit={(event) => event.preventDefault()}
                    passwordValue="secret"
                    title="Translator login"
                />
            </MantineProvider>,
        );

        expect(document.querySelector('.login-page')).toBeInTheDocument();
        expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
        expect(screen.getByRole('button', { name: 'Show password' })).toContainElement(
            document.querySelector('svg'),
        );

        fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
        expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
        expect(screen.getByRole('button', { name: 'Hide password' })).toBeInTheDocument();
    });

    it('uses native browser autocomplete fields for credentials', () => {
        render(
            <MantineProvider>
                <LoginPage
                    identityLabel="Email"
                    identityValue="user@example.com"
                    onIdentityChange={() => undefined}
                    onPasswordChange={() => undefined}
                    onSubmit={(event) => event.preventDefault()}
                    passwordValue="secret"
                    title="Translator login"
                />
            </MantineProvider>,
        );

        expect(screen.getByLabelText('Email')).toHaveAttribute('name', 'username');
        expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username');
        expect(screen.getByLabelText('Password')).toHaveAttribute('name', 'password');
        expect(screen.getByLabelText('Password')).toHaveAttribute(
            'autocomplete',
            'current-password',
        );
    });
});
