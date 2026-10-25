import { describe, expect, it } from 'vitest';

import { assertSafeDeployment, deploymentProblems, isLocalDeployment } from '../src/startupChecks';

const strong = (label: string) => `${label}-${'a1b2c3d4'.repeat(6)}`;

const goodProduction = {
    PUBLIC_APP_URL: 'https://live.bhasha.org',
    ADMIN_SESSION_SECRET: strong('admin'),
    TRANSLATOR_PASSWORD_PEPPER: strong('pepper'),
    TRANSLATOR_SESSION_SECRET: strong('session'),
    APPROVER_SESSION_SECRET: strong('approver'),
    ADMIN_INITIAL_PASSWORD: 'a-real-strong-initial-password',
    LIVEKIT_URL: 'wss://rtc.live.bhasha.org',
    LIVEKIT_API_KEY: 'APIrealkey123',
    LIVEKIT_API_SECRET: strong('livekit'),
};

// The values `.env.example` ships with, which a copy-pasted .env would still contain.
const examplePlaceholders = {
    PUBLIC_APP_URL: 'https://example.com',
    ADMIN_SESSION_SECRET: 'replace-with-random-admin-session-secret',
    TRANSLATOR_PASSWORD_PEPPER: 'replace-with-random-translator-password-pepper',
    TRANSLATOR_SESSION_SECRET: 'replace-with-random-translator-session-secret',
    APPROVER_SESSION_SECRET: 'replace-with-random-approver-session-secret',
    ADMIN_INITIAL_PASSWORD: 'replace-me-admin-password',
    LIVEKIT_URL: 'wss://rtc.example.com',
    LIVEKIT_API_KEY: 'bhasha-dev-key',
    LIVEKIT_API_SECRET: 'bhasha-dev-secret-0123456789-0123456789-0123456789',
};

describe('isLocalDeployment', () => {
    it.each([
        undefined,
        '',
        'not a url',
        'http://localhost:5173',
        'http://127.0.0.1:8787',
        'http://[::1]:5173',
        'http://app.localhost',
    ])('treats %s as local', (value) => {
        expect(isLocalDeployment(value)).toBe(true);
    });

    it.each(['https://live.bhasha.org', 'https://example.com', 'http://203.0.113.10'])(
        'treats %s as public',
        (value) => {
            expect(isLocalDeployment(value)).toBe(false);
        },
    );
});

describe('deploymentProblems', () => {
    it('accepts a properly configured public deployment', () => {
        expect(deploymentProblems(goodProduction, { adminExists: false })).toEqual([]);
    });

    it('does not check local development, even with the example placeholders', () => {
        expect(
            deploymentProblems(
                { ...examplePlaceholders, PUBLIC_APP_URL: 'http://localhost:5173' },
                { adminExists: false },
            ),
        ).toEqual([]);
        expect(deploymentProblems(examplePlaceholders_noUrl(), { adminExists: false })).toEqual([]);
    });

    it('reports every placeholder in an untouched .env.example copy', () => {
        const problems = deploymentProblems(examplePlaceholders, { adminExists: false });

        expect(problems).toEqual(
            expect.arrayContaining([
                expect.stringContaining('ADMIN_SESSION_SECRET'),
                expect.stringContaining('TRANSLATOR_PASSWORD_PEPPER'),
                expect.stringContaining('TRANSLATOR_SESSION_SECRET'),
                expect.stringContaining('APPROVER_SESSION_SECRET'),
                expect.stringContaining('ADMIN_INITIAL_PASSWORD'),
                expect.stringContaining('LIVEKIT_API_KEY'),
                expect.stringContaining('LIVEKIT_API_SECRET'),
                expect.stringContaining('DOMAIN / PUBLIC_APP_URL'),
                expect.stringContaining('LIVEKIT_URL'),
            ]),
        );
    });

    it('requires the core secrets to be present', () => {
        const { ADMIN_SESSION_SECRET: _omitted, ...rest } = goodProduction;

        expect(deploymentProblems(rest, { adminExists: true })).toEqual([
            expect.stringContaining('ADMIN_SESSION_SECRET'),
        ]);
    });

    it('rejects secrets that are too short to be random', () => {
        expect(
            deploymentProblems(
                { ...goodProduction, TRANSLATOR_SESSION_SECRET: 'short-secret' },
                { adminExists: true },
            ),
        ).toEqual([expect.stringContaining('TRANSLATOR_SESSION_SECRET must be at least 32')]);
    });

    it('allows the approver secret to be unset', () => {
        const { APPROVER_SESSION_SECRET: _omitted, ...rest } = goodProduction;

        expect(deploymentProblems(rest, { adminExists: true })).toEqual([]);
    });

    it('allows LiveKit to be unconfigured so the app can boot before it is provisioned', () => {
        const {
            LIVEKIT_URL: _url,
            LIVEKIT_API_KEY: _key,
            LIVEKIT_API_SECRET: _secret,
            ...rest
        } = goodProduction;

        expect(deploymentProblems(rest, { adminExists: true })).toEqual([]);
    });

    it('ignores a leftover initial-password placeholder once an admin exists', () => {
        const env = { ...goodProduction, ADMIN_INITIAL_PASSWORD: 'replace-me-admin-password' };

        expect(deploymentProblems(env, { adminExists: true })).toEqual([]);
        expect(deploymentProblems(env, { adminExists: false })).toEqual([
            expect.stringContaining('ADMIN_INITIAL_PASSWORD'),
        ]);
    });

    it('never includes secret values in the messages', () => {
        const problems = deploymentProblems(
            { ...goodProduction, ADMIN_SESSION_SECRET: 'replace-with-super-secret-value' },
            { adminExists: true },
        );

        expect(problems.join('\n')).not.toContain('super-secret-value');
    });
});

describe('assertSafeDeployment', () => {
    it('does nothing for a safe configuration', () => {
        expect(() => assertSafeDeployment(goodProduction, { adminExists: true })).not.toThrow();
    });

    it('throws a message that lists each problem and how to fix it', () => {
        expect(() => assertSafeDeployment(examplePlaceholders, { adminExists: false })).toThrow(
            /Refusing to start[\s\S]*ADMIN_SESSION_SECRET[\s\S]*LIVEKIT_API_KEY[\s\S]*openssl rand -hex 32/,
        );
    });
});

function examplePlaceholders_noUrl() {
    const { PUBLIC_APP_URL: _omitted, ...rest } = examplePlaceholders;
    return rest;
}
