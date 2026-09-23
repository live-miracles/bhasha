/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminDialog } from '../src/features/admin/AdminDialog';

beforeEach(() => {
    vi.restoreAllMocks();
});

afterEach(() => {
    cleanup();
});

describe('AdminDialog', () => {
    it('renders title and child when open', () => {
        render(
            <AdminDialog open onClose={vi.fn()} title="Audio Controls">
                <p>Manage stream settings</p>
            </AdminDialog>,
        );

        expect(screen.getByRole('dialog')).toBeVisible();
        expect(screen.getByText('Audio Controls')).not.toBeNull();
        expect(screen.getByText('Manage stream settings')).not.toBeNull();
    });

    it('calls onClose when the close button is clicked', () => {
        const onClose = vi.fn();
        render(
            <AdminDialog open onClose={onClose} title="Audio Controls">
                <p>Manage stream settings</p>
            </AdminDialog>,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('does not render a dialog when open is false', () => {
        render(
            <AdminDialog open={false} onClose={vi.fn()} title="Audio Controls">
                <p>Manage stream settings</p>
            </AdminDialog>,
        );

        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('calls onClose when Escape is pressed', () => {
        const onClose = vi.fn();
        render(
            <AdminDialog open onClose={onClose} title="T">
                <button>First</button>
            </AdminDialog>,
        );

        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();
    });
});
