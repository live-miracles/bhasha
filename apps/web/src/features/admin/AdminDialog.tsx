import { Modal } from '@mantine/core';
import type { ReactNode } from 'react';

import { AdminUiProvider } from './AdminShell';

interface AdminDialogProps {
    open: boolean;
    onClose: () => void;
    title?: string;
    children: ReactNode;
}

export function AdminDialog({ open, onClose, title, children }: AdminDialogProps) {
    return (
        <AdminUiProvider>
            <Modal
                centered
                closeOnClickOutside
                closeOnEscape
                closeButtonProps={{ 'aria-label': 'Close modal' }}
                opened={open}
                onClose={onClose}
                title={title}
            >
                {children}
            </Modal>
        </AdminUiProvider>
    );
}
