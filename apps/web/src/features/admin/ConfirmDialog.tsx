import { AdminDialog } from './AdminDialog';

interface ConfirmDialogProps {
    open: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: string;
    confirmLabel?: string;
    pending: boolean;
    error: string | null;
}

export function ConfirmDialog({
    open,
    onClose,
    onConfirm,
    title,
    message,
    confirmLabel,
    pending,
    error,
}: ConfirmDialogProps) {
    if (!open) {
        return null;
    }

    return (
        <AdminDialog open={open} onClose={onClose} title={title}>
            <div className="admin-kick-confirm-dialog">
                <p>{message}</p>
                {error ? (
                    <p role="alert" className="admin-kick-confirm-alert">
                        {error}
                    </p>
                ) : null}
                <footer className="admin-kick-confirm-footer">
                    <button
                        type="button"
                        className="admin-kick-confirm-btn admin-kick-confirm-btn-ghost"
                        onClick={onClose}
                        disabled={pending}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="admin-kick-confirm-btn admin-kick-confirm-btn-danger"
                        onClick={onConfirm}
                        disabled={pending}
                    >
                        {pending ? 'Ending…' : (confirmLabel ?? 'Confirm')}
                    </button>
                </footer>
            </div>
        </AdminDialog>
    );
}
