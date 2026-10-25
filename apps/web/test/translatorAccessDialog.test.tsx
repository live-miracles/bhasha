/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminStream, AdminTranslator, TranslatorAccessLink } from '../src/api/admin';
import {
    TranslatorAccessDialog,
    type TranslatorAccessApi,
} from '../src/features/admin/TranslatorAccessDialog';

const hindi: AdminStream = {
    id: 'stream_hi',
    languageName: 'Hindi',
    languageCode: 'hi',
    displayOrder: 1,
    isActive: true,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
};
const tamil: AdminStream = { ...hindi, id: 'stream_ta', languageName: 'Tamil', languageCode: 'ta' };

const issued: TranslatorAccessLink = {
    token: 'secret-token',
    url: 'https://bhasha.test/demo/translate#s=stream_hi&t=secret-token',
    expiresAt: '2030-01-01T12:00:00.000Z',
};

function translator(accessExpiresAt: string | null): AdminTranslator {
    return {
        id: 'stream_hi',
        email: 'stream_hi@language.invalid',
        name: 'Hindi',
        accessExpiresAt,
        assignments: [],
    };
}

function makeApi(overrides: Partial<TranslatorAccessApi> = {}): TranslatorAccessApi {
    return {
        createTranslatorAccess: vi.fn(async () => issued),
        revokeTranslatorAccess: vi.fn(async () => undefined),
        ...overrides,
    };
}

function renderDialog(
    props: Partial<Parameters<typeof TranslatorAccessDialog>[0]> = {},
    api: TranslatorAccessApi = makeApi(),
) {
    const onChanged = vi.fn();
    const onClose = vi.fn();
    const view = render(
        <TranslatorAccessDialog
            api={api}
            isLive={false}
            onChanged={onChanged}
            onClose={onClose}
            programId="program_1"
            stream={hindi}
            translator={translator(null)}
            {...props}
        />,
    );
    return { api, onChanged, onClose, ...view };
}

beforeEach(() => {
    vi.restoreAllMocks();
});

afterEach(() => {
    cleanup();
});

describe('TranslatorAccessDialog', () => {
    it('renders nothing while no language is selected', () => {
        renderDialog({ stream: null });

        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('titles the dialog with the language', () => {
        renderDialog();

        expect(screen.getByText('Hindi translator access')).toBeInTheDocument();
    });

    it.each([
        [null, 'Sign-in currently uses a password set by an admin.'],
        ['2999-01-01T00:00:00.000Z', 'An access link is active until'],
        ['2000-01-01T00:00:00.000Z', 'The last access link has expired or was revoked.'],
    ])('describes the current credential (expiry %s)', (accessExpiresAt, expected) => {
        renderDialog({ translator: translator(accessExpiresAt) });

        expect(screen.getByText(new RegExp(expected))).toBeInTheDocument();
    });

    it('generates a link with the default 12 hour lifetime', async () => {
        const { api, onChanged } = renderDialog();

        fireEvent.click(screen.getByRole('button', { name: 'Generate link' }));

        expect(await screen.findByLabelText('Translator access link')).toHaveValue(issued.url);
        expect(api.createTranslatorAccess).toHaveBeenCalledWith('program_1', 'stream_hi', 12);
        expect(onChanged).toHaveBeenCalledOnce();
        expect(screen.getByLabelText('Translator access QR')).toBeInTheDocument();
        expect(screen.getByText(/shown only once/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Generate new link' })).toBeInTheDocument();
    });

    it('sends the lifetime the admin picked', async () => {
        const { api } = renderDialog();

        fireEvent.change(screen.getByLabelText('Valid for'), { target: { value: '48' } });
        fireEvent.click(screen.getByRole('button', { name: 'Generate link' }));

        await waitFor(() => {
            expect(api.createTranslatorAccess).toHaveBeenCalledWith('program_1', 'stream_hi', 48);
        });
    });

    it('warns that generating replaces the current credential', () => {
        renderDialog();

        expect(
            screen.getByText(
                'Generating a new link replaces the current password or link and signs the translator out.',
            ),
        ).toBeInTheDocument();
    });

    it('warns that generating ends the broadcast when the language is live', () => {
        renderDialog({ isLive: true });

        expect(
            screen.getByText(/This language is live\. Generating a new link ends the current/),
        ).toBeInTheDocument();
    });

    it('shows the failure and no link when generating fails', async () => {
        const api = makeApi({
            createTranslatorAccess: vi.fn(async () => {
                throw new Error('stream_not_found');
            }),
        });
        const { onChanged } = renderDialog({}, api);

        fireEvent.click(screen.getByRole('button', { name: 'Generate link' }));

        expect(await screen.findByText('stream_not_found')).toBeInTheDocument();
        expect(screen.queryByLabelText('Translator access link')).toBeNull();
        expect(onChanged).not.toHaveBeenCalled();
    });

    it('copies the link to the clipboard', async () => {
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
        renderDialog();
        fireEvent.click(screen.getByRole('button', { name: 'Generate link' }));
        await screen.findByLabelText('Translator access link');

        fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));

        expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
        expect(writeText).toHaveBeenCalledWith(issued.url);
    });

    it('tells the admin to copy manually when the clipboard is unavailable', async () => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
                writeText: vi.fn(async () => {
                    throw new Error('denied');
                }),
            },
        });
        renderDialog();
        fireEvent.click(screen.getByRole('button', { name: 'Generate link' }));
        await screen.findByLabelText('Translator access link');

        fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));

        expect(await screen.findByText(/Could not copy automatically/)).toBeInTheDocument();
        expect(screen.getByLabelText('Translator access link')).toHaveValue(issued.url);
    });

    describe('revoking', () => {
        it('is offered only when an access link is active', () => {
            const { unmount } = renderDialog({ translator: translator(null) });
            expect(screen.queryByRole('button', { name: 'Revoke access' })).toBeNull();
            unmount();

            renderDialog({ translator: translator('2000-01-01T00:00:00.000Z') });
            expect(screen.queryByRole('button', { name: 'Revoke access' })).toBeNull();
            cleanup();

            renderDialog({ translator: translator('2999-01-01T00:00:00.000Z') });
            expect(screen.getByRole('button', { name: 'Revoke access' })).toBeInTheDocument();
        });

        it('is offered right after generating a link', async () => {
            renderDialog();

            fireEvent.click(screen.getByRole('button', { name: 'Generate link' }));

            expect(
                await screen.findByRole('button', { name: 'Revoke access' }),
            ).toBeInTheDocument();
        });

        it('revokes, hides the link, and refreshes the caller', async () => {
            const { api, onChanged } = renderDialog();
            fireEvent.click(screen.getByRole('button', { name: 'Generate link' }));
            await screen.findByLabelText('Translator access link');
            onChanged.mockClear();

            fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));

            expect(
                await screen.findByText('Access revoked. The translator can no longer sign in.'),
            ).toBeInTheDocument();
            expect(api.revokeTranslatorAccess).toHaveBeenCalledWith('program_1', 'stream_hi');
            expect(screen.queryByLabelText('Translator access link')).toBeNull();
            expect(onChanged).toHaveBeenCalledOnce();
        });

        it('shows the failure when revoking fails', async () => {
            const api = makeApi({
                revokeTranslatorAccess: vi.fn(async () => {
                    throw new Error('translator_not_found');
                }),
            });
            renderDialog({ translator: translator('2999-01-01T00:00:00.000Z') }, api);

            fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));

            expect(await screen.findByText('translator_not_found')).toBeInTheDocument();
        });
    });

    it('never carries a generated link over to another language', async () => {
        const api = makeApi();
        const props = {
            api,
            isLive: false,
            onChanged: vi.fn(),
            onClose: vi.fn(),
            programId: 'program_1',
            translator: translator(null),
        };
        const { rerender } = render(<TranslatorAccessDialog {...props} stream={hindi} />);
        fireEvent.click(screen.getByRole('button', { name: 'Generate link' }));
        await screen.findByLabelText('Translator access link');

        rerender(<TranslatorAccessDialog {...props} stream={tamil} />);

        expect(screen.getByText('Tamil translator access')).toBeInTheDocument();
        await waitFor(() => {
            expect(screen.queryByLabelText('Translator access link')).toBeNull();
        });
    });

    it('closes through the dialog close button', () => {
        const { onClose } = renderDialog();

        fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));

        expect(onClose).toHaveBeenCalledOnce();
    });
});
