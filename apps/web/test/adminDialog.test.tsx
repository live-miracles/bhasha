/* @vitest-environment jsdom */

import {
  cleanup,
  fireEvent,
  render,
  screen
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminDialog } from "../src/features/admin/AdminDialog";

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("AdminDialog", () => {
  it("renders title and child when open", () => {
    const { container } = render(
      <AdminDialog open onClose={vi.fn()} title="Audio Controls">
        <p>Manage stream settings</p>
      </AdminDialog>
    );

    const dialog = container.querySelector("dialog") as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(screen.getByText("Audio Controls")).not.toBeNull();
    expect(screen.getByText("Manage stream settings")).not.toBeNull();
  });

  it("calls onClose when dialog close event fires", () => {
    const onClose = vi.fn();
    render(
      <AdminDialog open={true} onClose={onClose} title="Audio Controls">
        <p>Manage stream settings</p>
      </AdminDialog>
    );

    const dialog = screen.getByRole("dialog") as HTMLDialogElement;
    fireEvent(dialog, new Event("close", { bubbles: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not keep dialog open when open prop is false", () => {
    const { container } = render(
      <AdminDialog open={false} onClose={vi.fn()} title="Audio Controls">
        <p>Manage stream settings</p>
      </AdminDialog>
    );

    const dialog = container.querySelector("dialog") as HTMLDialogElement;
    expect(dialog.open).toBe(false);
  });

  describe("fallback (showModal unavailable)", () => {
    let originalShowModal: typeof HTMLDialogElement.prototype.showModal;
    beforeEach(() => {
      originalShowModal = HTMLDialogElement.prototype.showModal;
      // @ts-expect-error force the non-modal fallback path
      HTMLDialogElement.prototype.showModal = undefined;
    });

    afterEach(() => {
      HTMLDialogElement.prototype.showModal = originalShowModal;
    });

    it("closes the dialog on Escape", () => {
      render(
        <AdminDialog open onClose={vi.fn()} title="T">
          <button>First</button>
          <button>Last</button>
        </AdminDialog>
      );
      const dialog = screen.getByRole("dialog") as HTMLDialogElement;
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(dialog.open).toBe(false);
    });

    it("wraps Tab focus from last to first", () => {
      render(
        <AdminDialog open onClose={vi.fn()} title="T">
          <button>First</button>
          <button>Last</button>
        </AdminDialog>
      );
      const dialog = screen.getByRole("dialog") as HTMLDialogElement;
      const buttons = screen.getAllByRole("button");
      const first = buttons[0]!;
      const last = buttons[1]!;
      last.focus();
      fireEvent.keyDown(dialog, { key: "Tab" });
      expect(document.activeElement).toBe(first);
    });

    it("wraps Shift+Tab focus from first to last", () => {
      render(
        <AdminDialog open onClose={vi.fn()} title="T">
          <button>First</button>
          <button>Last</button>
        </AdminDialog>
      );
      const dialog = screen.getByRole("dialog") as HTMLDialogElement;
      const buttons = screen.getAllByRole("button");
      const first = buttons[0]!;
      const last = buttons[1]!;
      first.focus();
      fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(last);
    });
  });
});
