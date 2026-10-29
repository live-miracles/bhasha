/* @vitest-environment jsdom */

import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/api/client';
import type { SourceSession, TranscriptSourceApi } from '../src/api/transcript';
import { SourceConsoleRoute } from '../src/routes/SourceConsoleRoute';

const session: SourceSession = {
    token: 't',
    modelId: 'scribe_v2_realtime',
    sampleRate: 16000,
    audioFormat: 'pcm_16000',
    commitStrategy: 'vad',
    vadSilenceThresholdSecs: 0.8,
    languageCode: 'en',
    translationEnabled: true,
};

function renderConsole(api: TranscriptSourceApi) {
    const stopCapture = vi.fn();
    const connection = { sendAudio: vi.fn(), finish: vi.fn(), close: vi.fn() };
    let emit: ((event: { type: 'open' }) => void) | undefined;
    render(
        <MantineProvider>
            <SourceConsoleRoute
                api={api}
                capture={{
                    startCapture: async () => ({ stop: stopCapture }),
                    listInputs: async () => [{ deviceId: 'line-in', label: 'Interface line in' }],
                }}
                connectScribe={(_config, listener) => {
                    emit = listener as typeof emit;
                    return connection;
                }}
                programSlug="demo"
            />
        </MantineProvider>,
    );
    return { stopCapture, connection, open: () => emit?.({ type: 'open' }) };
}

afterEach(cleanup);

describe('SourceConsoleRoute', () => {
    it('tells the operator when another console is already sending', async () => {
        const api: TranscriptSourceApi = {
            session: vi.fn(async () => session),
            send: vi.fn(async () => ({ ok: true as const, primary: false })),
        };
        const { open } = renderConsole(api);

        fireEvent.click(screen.getByRole('button', { name: 'Start transcribing' }));
        await waitFor(() => expect(api.session).toHaveBeenCalled());
        open();

        expect(await screen.findByText('Standing by')).toBeTruthy();
    });

    it('starts transcribing, shows it live, and stops on request', async () => {
        const api: TranscriptSourceApi = {
            session: vi.fn(async () => session),
            send: vi.fn(async () => ({ ok: true as const, primary: true })),
        };
        const { open, stopCapture } = renderConsole(api);

        fireEvent.click(screen.getByRole('button', { name: 'Start transcribing' }));
        await waitFor(() => expect(api.session).toHaveBeenCalledWith('demo'));
        open();

        expect(await screen.findByText('Transcribing the hall feed')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
        await waitFor(() => expect(screen.getByText('Not transcribing')).toBeTruthy());
        expect(stopCapture).toHaveBeenCalled();
        expect(api.send).toHaveBeenLastCalledWith(
            'demo',
            { type: 'state', active: false },
            expect.any(String),
        );
    });

    it('asks for an admin sign-in instead of starting when the session is missing', async () => {
        const api: TranscriptSourceApi = {
            session: vi.fn(),
            send: vi.fn(async () => {
                throw new ApiError({ status: 401, code: 'admin_auth_required', body: {} });
            }),
        };
        renderConsole(api);

        fireEvent.click(screen.getByRole('button', { name: 'Start transcribing' }));

        expect(await screen.findByText('Sign in first')).toBeTruthy();
        expect(api.session).not.toHaveBeenCalled();
    });

    it('reports a program the admin cannot use', async () => {
        const api: TranscriptSourceApi = {
            session: vi.fn(),
            send: vi.fn(async () => {
                throw new ApiError({ status: 404, code: 'program_not_found', body: {} });
            }),
        };
        renderConsole(api);

        fireEvent.click(screen.getByRole('button', { name: 'Start transcribing' }));

        expect(await screen.findByText(/does not exist, or you do not have access/)).toBeTruthy();
    });
});
