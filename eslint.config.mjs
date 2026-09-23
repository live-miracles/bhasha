import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
    {
        // Scope matches `npm run typecheck --workspaces`: the two npm
        // workspaces (apps/api, apps/web) plus root config. scripts/ holds
        // ad-hoc spike/load-test tooling (including vendored UMD bundles like
        // scripts/*-spike/*.umd.js / *.browser.js) that's outside the
        // workspaces and isn't type-checked either -- not covered here.
        ignores: [
            '**/node_modules/**',
            '**/dist/**',
            '**/build/**',
            '**/coverage/**',
            '**/playwright-report/**',
            '**/test-results/**',
            'apps/api/data/**',
            'scripts/**',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        // Most of the repo (apps/api, build/tooling scripts) runs under Node.
        languageOptions: {
            globals: globals.node,
        },
    },
    {
        files: ['apps/web/src/**/*.{ts,tsx}'],
        languageOptions: {
            globals: { ...globals.node, ...globals.browser },
        },
    },
    {
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'warn',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                },
            ],
        },
    },
    eslintConfigPrettier,
);
