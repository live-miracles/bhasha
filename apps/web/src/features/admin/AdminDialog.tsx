import { type MouseEvent, type ReactNode, useEffect, useRef } from "react";

interface AdminDialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

export function AdminDialog({
  open,
  onClose,
  title,
  children
}: AdminDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return;
    }

    const handleClose = () => {
      previousFocus.current?.focus();
      onClose();
    };

    dialog.addEventListener("close", handleClose);
    return () => {
      dialog.removeEventListener("close", handleClose);
    };
  }, [onClose]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return;
    }

    if (open && !dialog.open) {
      previousFocus.current = document.activeElement as HTMLElement | null;

      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }

      const focusable = dialog.querySelector<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]"
      );
      if (focusable) {
        focusable.focus();
      } else {
        dialog.focus();
      }
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) {
      return;
    }

    // Native showModal() traps focus and handles Escape itself; only polyfill
    // those for the non-modal setAttribute("open") fallback path.
    if (typeof dialog.showModal === "function") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (typeof dialog.close === "function") {
          dialog.close();
        } else {
          dialog.removeAttribute("open");
        }
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    dialog.addEventListener("keydown", handleKeyDown);
    return () => dialog.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  const handleClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === ref.current) {
      ref.current?.close();
    }
  };

  return (
    <dialog
      ref={ref}
      className="admin-dialog"
      aria-labelledby={title ? "admin-dialog-title" : undefined}
      onClick={handleClick}
    >
      {title ? <h2 id="admin-dialog-title">{title}</h2> : null}
      {children}
    </dialog>
  );
}
