import {
  cleanup,
  fireEvent,
  render,
  screen,
  within
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminReadiness } from "../src/api/admin";
import { ReadinessPanel } from "../src/features/admin/readiness/ReadinessPanel";

afterEach(() => {
  cleanup();
});

function readiness(): AdminReadiness {
  return {
    programId: "program_1",
    items: [
      {
        id: "program_setup",
        label: "Program setup",
        status: "green",
        detail: "Program details are configured."
      },
      {
        id: "streams",
        label: "Language streams",
        status: "blocker",
        detail: "No active language streams exist for this program."
      },
      {
        id: "turn_analytics_tagging",
        label: "TURN analytics tagging",
        status: "warning",
        detail: "TURN usage analytics tagging is not enabled."
      },
      {
        id: "realtime_smoke_tested",
        label: "Realtime smoke tested",
        status: "blocker",
        detail: "No realtime smoke test has been confirmed yet."
      },
      {
        id: "mobile_field_tested",
        label: "Mobile field tested",
        status: "green",
        detail: "Operator confirmed a mobile field test.",
        checkedAt: "2026-06-21T10:00:00.000Z"
      }
    ]
  };
}

describe("ReadinessPanel", () => {
  it("renders the readiness heading and each item with its status", () => {
    render(<ReadinessPanel readiness={readiness()} onConfirm={vi.fn()} />);

    expect(
      screen.getByRole("heading", { name: /event readiness/i })
    ).toBeTruthy();

    const region = screen.getByRole("region", { name: /event readiness/i });
    expect(within(region).getByText("Program setup")).toBeTruthy();
    expect(within(region).getByText("Language streams")).toBeTruthy();
    expect(within(region).getByText("TURN analytics tagging")).toBeTruthy();
    expect(
      within(region).getByText("Confirmed at 21 Jun 2026, 15:30:00 IST")
    ).toBeTruthy();
  });

  it("surfaces blocker and warning states", () => {
    render(<ReadinessPanel readiness={readiness()} onConfirm={vi.fn()} />);

    const blockers = screen.getAllByText(/blocker/i);
    expect(blockers.length).toBeGreaterThan(0);
    expect(screen.getAllByText(/warning/i).length).toBeGreaterThan(0);
  });

  it("renders confirm buttons only for smoke and mobile field checks", () => {
    render(<ReadinessPanel readiness={readiness()} onConfirm={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: /confirm realtime smoke test/i })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /confirm mobile field test/i })
    ).toBeTruthy();

    expect(
      screen.queryByRole("button", { name: /confirm language streams/i })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /confirm turn analytics/i })
    ).toBeNull();
  });

  it("calls onConfirm with the item id when a confirm button is clicked", () => {
    const onConfirm = vi.fn();
    render(<ReadinessPanel readiness={readiness()} onConfirm={onConfirm} />);

    fireEvent.click(
      screen.getByRole("button", { name: /confirm realtime smoke test/i })
    );

    expect(onConfirm).toHaveBeenCalledWith("realtime_smoke_tested");
  });

  it("shows a loading state when readiness is null", () => {
    render(<ReadinessPanel readiness={null} onConfirm={vi.fn()} />);
    expect(screen.getByText(/loading event readiness/i)).toBeTruthy();
  });
});
