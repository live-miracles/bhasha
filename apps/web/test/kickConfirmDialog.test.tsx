/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KickConfirmDialog } from "../src/features/admin/KickConfirmDialog";

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("KickConfirmDialog", () => {
  it("renders title and body lines when open", () => {
    render(
      <KickConfirmDialog
        open
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        title="Kick translator"
        listenerImpactLine="Hindi has 42 active listeners. They will keep hearing silence — the stream stays connected."
        pending={false}
        error={null}
      />
    );

    expect(screen.getByRole("heading", { name: "Kick translator" })).not.toBeNull();
    expect(
      screen.getByText(
        "Hindi has 42 active listeners. They will keep hearing silence — the stream stays connected."
      )
    ).not.toBeNull();
    expect(
      screen.getByText("The relay stays alive on silence. Listeners won't disconnect or need to rejoin.")
    ).not.toBeNull();
  });

  it("does not render content when open is false", () => {
    render(
      <KickConfirmDialog
        open={false}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        title="Kick translator"
        listenerImpactLine="Hindi has 42 active listeners. They will keep hearing silence — the stream stays connected."
        pending={false}
        error={null}
      />
    );

    expect(screen.queryByRole("heading", { name: "Kick translator" })).toBeNull();
    expect(screen.queryByText("Cancel")).toBeNull();
  });

  it("calls onConfirm with checkbox state", () => {
    const onConfirm = vi.fn();
    render(
      <KickConfirmDialog
        open
        onClose={vi.fn()}
        onConfirm={onConfirm}
        title="Kick translator"
        listenerImpactLine="Hindi has 42 active listeners. They will keep hearing silence — the stream stays connected."
        pending={false}
        error={null}
      />
    );

    const confirm = screen.getByRole("button", { name: "End broadcast" });
    const checkbox = screen.getByRole("checkbox", {
      name: "Also sign this device out"
    });

    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenLastCalledWith(false);

    fireEvent.click(checkbox);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenLastCalledWith(true);
  });

  it("calls onClose when cancel is clicked", () => {
    const onClose = vi.fn();
    render(
      <KickConfirmDialog
        open
        onClose={onClose}
        onConfirm={vi.fn()}
        title="Kick translator"
        listenerImpactLine="Hindi has 42 active listeners. They will keep hearing silence — the stream stays connected."
        pending={false}
        error={null}
      />
    );

    const cancel = screen.getByRole("button", { name: "Cancel" });
    fireEvent.click(cancel);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables both actions and shows ending label when pending", () => {
    render(
      <KickConfirmDialog
        open
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        title="Kick translator"
        listenerImpactLine="Hindi has 42 active listeners. They will keep hearing silence — the stream stays connected."
        pending
        error={null}
      />
    );

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Ending…" });

    expect(cancel).toBeDisabled();
    expect(confirm).toBeDisabled();
  });

  it("shows an alert with error text", () => {
    render(
      <KickConfirmDialog
        open
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        title="Kick translator"
        listenerImpactLine="Hindi has 42 active listeners. They will keep hearing silence — the stream stays connected."
        pending={false}
        error="Could not remove translator"
      />
    );

    const alert = screen.getByRole("alert");

    expect(alert).not.toBeNull();
    expect(alert).toHaveTextContent("Could not remove translator");
  });

  it("renders device sub-label when provided", () => {
    render(
      <KickConfirmDialog
        open
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        title="Kick translator"
        listenerImpactLine="Hindi has 42 active listeners. They will keep hearing silence — the stream stays connected."
        deviceSubLabel="The listener will be removed from this browser only."
        pending={false}
        error={null}
      />
    );

    expect(
      screen.getByText("The listener will be removed from this browser only.")
    ).not.toBeNull();
  });
});
