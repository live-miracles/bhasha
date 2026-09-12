import { useEffect, useState } from "react";

import { AdminDialog } from "./AdminDialog";

interface KickConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (signOut: boolean) => void;
  title: string;
  listenerImpactLine: string;
  deviceSubLabel?: string;
  pending: boolean;
  error: string | null;
}

export function KickConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  listenerImpactLine,
  deviceSubLabel,
  pending,
  error
}: KickConfirmDialogProps) {
  const [signOutDevice, setSignOutDevice] = useState(false);

  useEffect(() => {
    if (open) {
      setSignOutDevice(false);
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <AdminDialog open={open} onClose={onClose} title={title}>
      <div className="admin-kick-confirm-dialog">
        <p>{listenerImpactLine}</p>
        <p className="admin-kick-confirm-muted">
          The relay stays alive on silence. Listeners won't disconnect or need to rejoin.
        </p>

        <label className="admin-kick-confirm-device-option">
          <input
            type="checkbox"
            checked={signOutDevice}
            onChange={(event) => setSignOutDevice(event.target.checked)}
          />
          <span className="admin-kick-confirm-device-text">
            Also sign this device out
            {deviceSubLabel ? (
              <span className="admin-kick-confirm-device-sub-label">{deviceSubLabel}</span>
            ) : null}
          </span>
        </label>

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
            onClick={() => onConfirm(signOutDevice)}
            disabled={pending}
          >
            {pending ? "Ending\u2026" : "End broadcast"}
          </button>
        </footer>
      </div>
    </AdminDialog>
  );
}
