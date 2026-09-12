/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "../src/features/admin/ConfirmDialog";

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("ConfirmDialog", () => {
  it("renders title and message when open", () => {
    render(
      <ConfirmDialog
        open
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        title="End session for Hindi Translator?"
        message="This will end the Desktop Mic session."
        pending={false}
        error={null}
      />
    );

    expect(screen.getByRole("heading", { name: "End session for Hindi Translator?" }))
      .not.toBeNull();
    expect(screen.getByText("This will end the Desktop Mic session.")).not.toBeNull();
  });

  it("does not render when open is false", () => {
    render(
      <ConfirmDialog
        open={false}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        title="End session"
        message="This will end a session."
        pending={false}
        error={null}
      />
    );

    expect(screen.queryByRole("heading", { name: "End session" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("calls onConfirm when confirm is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onClose={vi.fn()}
        onConfirm={onConfirm}
        title="End session"
        message="This will end a session."
        pending={false}
        error={null}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onClose when cancel is clicked", () => {
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        open
        onClose={onClose}
        onConfirm={vi.fn()}
        title="End session"
        message="This will end a session."
        pending={false}
        error={null}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables both actions and shows ending label when pending", () => {
    render(
      <ConfirmDialog
        open
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        title="End session"
        message="This will end a session."
        pending
        error={null}
      />
    );

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Ending…" });

    expect(cancel).toBeDisabled();
    expect(confirm).toBeDisabled();
  });

  it("shows role alert text when error is set", () => {
    render(
      <ConfirmDialog
        open
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        title="End session"
        message="This will end a session."
        pending={false}
        error="Could not end session"
      />
    );

    const alert = screen.getByRole("alert");

    expect(alert).not.toBeNull();
    expect(alert).toHaveTextContent("Could not end session");
  });
});
