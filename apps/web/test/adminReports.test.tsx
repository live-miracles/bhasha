import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AdminEventFeed,
  AdminListenerReport,
  AdminProgramDetail,
  AdminReadiness,
  AdminReportSummary,
  ListenerReportQuery
} from "../src/api/admin";
import { CsvDownloadButton } from "../src/features/admin/reports/CsvDownloadButton";
import { ReadinessPanel } from "../src/features/admin/readiness/ReadinessPanel";
import { EventFeedPanel } from "../src/features/admin/reports/EventFeedPanel";
import {
  ListenerReportPanel,
  buildListenerReportKey
} from "../src/features/admin/AdminScreen";
import {
  ReportDateRangeControl,
  type ReportDateRangePreset,
  type ReportDateRangeValue
} from "../src/features/admin/reports/ReportDateRangeControl";
import { ReportSummaryPanel } from "../src/features/admin/reports/ReportSummaryPanel";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function summary(): AdminReportSummary {
  return {
    programId: "program_1",
    totals: {
      activeListeners: 42,
      totalConnections: 120,
      uniqueDevices: 88,
      dropouts: 7,
      reconnects: 13
    },
    streams: [
      {
        streamId: "stream_hi",
        languageName: "Hindi",
        languageCode: "hi",
        activeListeners: 30,
        totalConnections: 80,
        dropouts: 4,
        reconnects: 9
      }
    ],
    generatedAt: "2026-06-21T10:00:00.000Z",
    presenceSource: "durable_object"
  };
}

function eventFeed(): AdminEventFeed {
  return {
    total: 150,
    page: 2,
    pageSize: 20,
    totalPages: 2,
    events: [
      {
        id: "ev_1",
        eventType: "connection_failed",
        occurredAt: "2026-06-21T10:00:00.000Z",
        stream: {
          id: "stream_hi",
          languageName: "Hindi",
          languageCode: "hi"
        },
        translatorName: null,
        translatorDeviceLabel: null,
        metadata: {
          reason: "ice_failed",
          connectionId: "listener_connection_1"
        }
      }
    ]
  };
}

function eventDetail(): AdminProgramDetail {
  return {
    program: {
      id: "program_1",
      slug: "prog-1",
      name: "Translation Program",
      venue: "Main Hall",
      eventDate: "2026-07-01",
      status: "live",
      adminNotes: "",
      accessControlEnabled: false,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
      firstLiveAt: null
    },
    streams: [],
    translators: [
      {
        id: "translator_hindi",
        email: "hindi@example.com",
        name: "Hindi Translator",
        assignments: []
      }
    ],
    urls: {
      listenerUrl: "/test",
      translatorUrl: "/translator/test",
      volunteerUrl: "/test/volunteer"
    },
    qrPayload: "{}",
    suggestedQrFilename: "qrcode.svg"
  };
}

describe("ReportSummaryPanel", () => {
  it("renders Active now with a LIVE badge, connections, unique devices, dropouts, and reconnects", () => {
    render(<ReportSummaryPanel summary={summary()} />);

    const panel = screen.getByLabelText("Report summary");
    expect(panel).toHaveTextContent("Active now");
    expect(within(panel).getByText("LIVE")).toHaveClass("admin-pill-live");
    expect(panel).toHaveTextContent("42");
    expect(panel).toHaveTextContent("120");
    expect(panel).toHaveTextContent("Unique devices");
    expect(panel).toHaveTextContent("88");
    expect(panel).toHaveTextContent("7");
    expect(panel).toHaveTextContent("13");

    const hindiRow = within(panel).getByText("Hindi").closest("tr");
    expect(hindiRow).toHaveTextContent("30");
    expect(hindiRow).toHaveTextContent("80");
    expect(panel).toHaveTextContent("Active (now)");
    expect(panel).toHaveTextContent(
      "Active column shows current listeners, not the selected window."
    );
  });

  it("renders a loading message when no summary is available", () => {
    render(<ReportSummaryPanel summary={null} />);
    expect(screen.getByText("Loading report summary...")).toBeInTheDocument();
  });

  it("shows the not-windowed hint only when a range is active", () => {
    const { rerender } = render(
      <ReportSummaryPanel summary={summary()} rangeActive={false} />
    );
    expect(screen.queryByText("(not windowed)")).not.toBeInTheDocument();

    rerender(<ReportSummaryPanel summary={summary()} rangeActive={true} />);
    expect(screen.getByText("(not windowed)")).toBeInTheDocument();
  });

  it("shows a clickable range chip when a range is active", () => {
    const onRangeChipClick = vi.fn();
    const { rerender } = render(
      <ReportSummaryPanel
        summary={summary()}
        rangeLabel={null}
        onRangeChipClick={onRangeChipClick}
      />
    );
    expect(screen.queryByRole("button", { name: "Last 24h" })).not.toBeInTheDocument();

    rerender(
      <ReportSummaryPanel
        summary={summary()}
        rangeLabel="Last 24h"
        onRangeChipClick={onRangeChipClick}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Last 24h" }));
    expect(onRangeChipClick).toHaveBeenCalledTimes(1);
  });

  it("dims while refetching and keeps the existing summary content", () => {
    render(<ReportSummaryPanel summary={summary()} isFetching />);

    const body = screen.getByTestId("report-summary-body");
    expect(body).toHaveStyle({ opacity: "0.6", pointerEvents: "none" });
    expect(screen.getByText("Active now")).toBeInTheDocument();
    expect(screen.queryByText("Loading report summary...")).not.toBeInTheDocument();
  });
});

describe("ReadinessPanel", () => {
  it("renders status cards and summary count chips for mixed readiness states", () => {
    const readiness: AdminReadiness = {
      programId: "program_1",
      items: [
        {
          id: "program_setup",
          label: "Program setup",
          status: "green",
          detail: "Program details are configured."
        },
        {
          id: "turn_configured",
          label: "TURN credentials configured",
          status: "blocker",
          detail: "Cloudflare TURN is not configured."
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
        }
      ]
    };

    render(
      <ReadinessPanel
        readiness={readiness}
        onConfirm={vi.fn()}
        pendingItemId={null}
      />
    );

    const panel = screen.getByRole("region", { name: "Event readiness" });
    const summary = panel.querySelector(".admin-readiness-summary");
    expect(summary).not.toBeNull();
    expect(summary).toHaveTextContent("1 Ready");
    expect(summary).toHaveTextContent("1 Warning");
    expect(summary).toHaveTextContent("2 Blocker");

    const cards = panel.querySelectorAll(".admin-readiness-card");
    expect(cards).toHaveLength(4);
    expect(cards[0]).toHaveAttribute("data-status", "green");
    expect(cards[1]).toHaveAttribute("data-status", "blocker");
    expect(cards[2]).toHaveAttribute("data-status", "warning");
    expect(within(cards[0] as HTMLElement).getByText("Ready")).toHaveClass(
      "admin-pill-live"
    );
    expect(within(cards[1] as HTMLElement).getByText("Blocker")).toHaveClass(
      "admin-pill-blocker"
    );
    expect(within(cards[2] as HTMLElement).getByText("Warning")).toHaveClass(
      "admin-pill-warning"
    );
  });
});

describe("EventFeedPanel", () => {
  it("renders event wording, stream language, timestamp, and safe debug metadata", () => {
    render(
      <EventFeedPanel
        detail={eventDetail()}
        feed={eventFeed()}
        filters={{ eventTypes: [], translatorId: "" }}
        page={2}
        onFilterChange={vi.fn()}
        onPageChange={vi.fn()}
        onClearFilters={vi.fn()}
      />
    );

    const panel = screen.getByLabelText("Recent events");
    expect(panel).toHaveTextContent("Listener connection failed — ice_failed");
    expect(panel).not.toHaveTextContent("connection_failed");
    expect(panel).toHaveTextContent("Hindi");
    expect(panel).toHaveTextContent("21 Jun 2026, 15:30:00 IST");
    expect(panel).toHaveTextContent("ice_failed");
    expect(panel).toHaveTextContent("Debug info");
  });

  it("shows translator device as a second line only when present", () => {
    const feed: AdminEventFeed = {
      total: 2,
      page: 1,
      pageSize: 20,
      totalPages: 1,
      events: [
        {
          id: "ev_translator_device",
          eventType: "translator_connected",
          occurredAt: "2026-06-21T10:00:00.000Z",
          stream: null,
          translatorName: "Anita",
          translatorDeviceLabel: "Chrome on Android",
          metadata: {}
        },
        {
          id: "ev_translator_no_device",
          eventType: "translator_disconnected",
          occurredAt: "2026-06-21T10:01:00.000Z",
          stream: null,
          translatorName: "Bala",
          translatorDeviceLabel: null,
          metadata: {}
        }
      ]
    };

    render(
      <EventFeedPanel
        detail={eventDetail()}
        feed={feed}
        filters={{ eventTypes: [], translatorId: "" }}
        page={1}
        onFilterChange={vi.fn()}
        onPageChange={vi.fn()}
        onClearFilters={vi.fn()}
      />
    );

    const anitaRow = screen.getByText("Anita connected").closest("tr");
    expect(anitaRow).toHaveTextContent("Chrome on Android");
    expect(within(anitaRow as HTMLElement).getByText("Chrome on Android")).toHaveClass(
      "admin-hint"
    );

    const balaRow = screen.getByText("Bala disconnected").closest("tr");
    expect(balaRow).not.toHaveTextContent("Chrome on Android");
  });

  it("renders a deleted translator name muted and italic", () => {
    const feed: AdminEventFeed = {
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
      events: [
        {
          id: "ev_deleted_translator",
          eventType: "translator_connected",
          occurredAt: "2026-06-21T10:00:00.000Z",
          stream: null,
          translatorName: "Deleted translator",
          translatorDeviceLabel: null,
          metadata: {}
        }
      ]
    };

    render(
      <EventFeedPanel
        detail={eventDetail()}
        feed={feed}
        filters={{ eventTypes: [], translatorId: "" }}
        page={1}
        onFilterChange={vi.fn()}
        onPageChange={vi.fn()}
        onClearFilters={vi.fn()}
      />
    );

    const deletedName = screen.getByText("Deleted translator");
    expect(deletedName.tagName).toBe("EM");
    expect(deletedName).toHaveClass("admin-text-soft");
  });

  it("renders a deleted translator token muted and italic when it is not the first wording token", () => {
    const feed: AdminEventFeed = {
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
      events: [
        {
          id: "ev_deleted_translator_connection_failed",
          eventType: "connection_failed",
          occurredAt: "2026-06-21T10:00:00.000Z",
          stream: null,
          translatorName: "Deleted translator",
          translatorDeviceLabel: null,
          metadata: {}
        }
      ]
    };

    render(
      <EventFeedPanel
        detail={eventDetail()}
        feed={feed}
        filters={{ eventTypes: [], translatorId: "" }}
        page={1}
        onFilterChange={vi.fn()}
        onPageChange={vi.fn()}
        onClearFilters={vi.fn()}
      />
    );

    const deletedName = screen.getByText("Deleted translator");
    const eventRow = deletedName.closest("tr");
    expect(deletedName.tagName).toBe("EM");
    expect(deletedName).toHaveClass("admin-text-soft");
    expect(eventRow).toHaveTextContent(
      "Connection failed — Deleted translator"
    );
  });

  it("omits translator ids from debug info and renders an empty cell when no debug fields remain", () => {
    const translatorId = "translator_00000000-0000-4000-8000-000000000001";
    const feed: AdminEventFeed = {
      total: 2,
      page: 1,
      pageSize: 20,
      totalPages: 1,
      events: [
        {
          id: "ev_with_connection",
          eventType: "translator_connected",
          occurredAt: "2026-06-21T10:00:00.000Z",
          stream: null,
          translatorName: "Anita",
          translatorDeviceLabel: null,
          metadata: {
            translatorId,
            connectionId: "listener_connection_1"
          }
        },
        {
          id: "ev_no_debug",
          eventType: "translator_disconnected",
          occurredAt: "2026-06-21T10:01:00.000Z",
          stream: null,
          translatorName: "Anita",
          translatorDeviceLabel: null,
          metadata: { translatorId }
        }
      ]
    };

    render(
      <EventFeedPanel
        detail={eventDetail()}
        feed={feed}
        filters={{ eventTypes: [], translatorId: "" }}
        page={1}
        onFilterChange={vi.fn()}
        onPageChange={vi.fn()}
        onClearFilters={vi.fn()}
      />
    );

    const panel = screen.getByLabelText("Recent events");
    expect(panel).not.toHaveTextContent(translatorId);
    expect(panel).toHaveTextContent("connection: listener_connection_1");
    const noDebugRow = screen.getByText("Anita disconnected").closest("tr");
    expect(within(noDebugRow as HTMLElement).getAllByRole("cell")[3]).toBeEmptyDOMElement();
  });

  it("never renders IP or user-agent values even if present in fixtures", () => {
    const feed: AdminEventFeed = {
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
      events: [
        {
          id: "ev_leak",
          eventType: "connection_failed",
          occurredAt: "2026-06-21T10:00:00.000Z",
          stream: null,
          translatorName: null,
          translatorDeviceLabel: null,
          metadata: {
            reason: "ice_failed",
            // Untrusted extra keys must never be rendered.
            ...({
              listenerIp: "203.0.113.55",
              userAgent: "Leak Browser"
            } as Record<string, string>)
          }
        }
      ]
    };

    render(
      <EventFeedPanel
        detail={eventDetail()}
        feed={feed}
        filters={{ eventTypes: [], translatorId: "" }}
        page={1}
        onFilterChange={vi.fn()}
        onPageChange={vi.fn()}
        onClearFilters={vi.fn()}
      />
    );

    const panel = screen.getByLabelText("Recent events");
    expect(panel).not.toHaveTextContent("203.0.113.55");
    expect(panel).not.toHaveTextContent("Leak Browser");
  });

  it("renders an empty state when there are no events", () => {
    render(
      <EventFeedPanel
        detail={eventDetail()}
        feed={{ events: [], total: 0, page: 1, pageSize: 20, totalPages: 1 }}
        filters={{ eventTypes: [], translatorId: "" }}
        page={1}
        onFilterChange={vi.fn()}
        onPageChange={vi.fn()}
        onClearFilters={vi.fn()}
      />
    );
    expect(screen.getByText("No recent events.")).toBeInTheDocument();
  });

  it("shows a clickable range chip when a range is active", () => {
    const onRangeChipClick = vi.fn();
    const { rerender } = render(
      <EventFeedPanel
        detail={eventDetail()}
        feed={eventFeed()}
        filters={{ eventTypes: [], translatorId: "" }}
        page={2}
        onFilterChange={vi.fn()}
        onPageChange={vi.fn()}
        onClearFilters={vi.fn()}
        rangeLabel={null}
        onRangeChipClick={onRangeChipClick}
      />
    );
    expect(screen.queryByRole("button", { name: "20 Jun – 21 Jun" })).not.toBeInTheDocument();

    rerender(
      <EventFeedPanel
        detail={eventDetail()}
        feed={eventFeed()}
        filters={{ eventTypes: [], translatorId: "" }}
        page={2}
        onFilterChange={vi.fn()}
        onPageChange={vi.fn()}
        onClearFilters={vi.fn()}
        rangeLabel="20 Jun – 21 Jun"
        onRangeChipClick={onRangeChipClick}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "20 Jun – 21 Jun" }));
    expect(onRangeChipClick).toHaveBeenCalledTimes(1);
  });

  it("dims while refetching and keeps the existing event content", () => {
    render(
      <EventFeedPanel
        detail={eventDetail()}
        feed={eventFeed()}
        filters={{ eventTypes: [], translatorId: "" }}
        page={2}
        onFilterChange={vi.fn()}
        onPageChange={vi.fn()}
        onClearFilters={vi.fn()}
        isFetching
      />
    );

    const body = screen.getByTestId("event-feed-body");
    expect(body).toHaveStyle({ opacity: "0.6", pointerEvents: "none" });
    expect(screen.getByText("Listener connection failed — ice_failed")).toBeInTheDocument();
    expect(screen.queryByText("Loading recent events...")).not.toBeInTheDocument();
  });

  it("renders event-type multi-select, translator select, and Prev/Next pager", () => {
    const onPageChange = vi.fn();
    render(
      <EventFeedPanel
        detail={eventDetail()}
        feed={eventFeed()}
        filters={{ eventTypes: [], translatorId: "" }}
        page={2}
        onFilterChange={vi.fn()}
        onPageChange={onPageChange}
        onClearFilters={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Event type"));
    expect(screen.getByRole("checkbox", { name: "Connection failed" })).toHaveAttribute(
      "value",
      "connection_failed"
    );
    expect(
      screen.queryByRole("checkbox", { name: "Listener connected" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Connection failed" })).toBeInTheDocument();
    expect(screen.getByLabelText("Translator")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Hindi Translator" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Page 2 of 2 · 150 events"
    );

    fireEvent.click(screen.getByRole("button", { name: "← Prev" }));
    expect(onPageChange).toHaveBeenCalledWith(1);
    expect(screen.getByRole("button", { name: "Next →" })).toBeDisabled();
  });

  it("applying an event filter calls the handler and resets to page 1", () => {
    const onFilterChange = vi.fn();
    const onPageChange = vi.fn();
    render(
      <EventFeedPanel
        detail={eventDetail()}
        feed={eventFeed()}
        filters={{ eventTypes: [], translatorId: "" }}
        page={2}
        onFilterChange={onFilterChange}
        onPageChange={onPageChange}
        onClearFilters={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Event type"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Translator connected" }));

    expect(onFilterChange).toHaveBeenCalledWith({ eventTypes: ["translator_connected"] });
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it("renders multi-select event type checkboxes and shows selected count", () => {
    const onFilterChange = vi.fn();
    render(
      <EventFeedPanel
        detail={eventDetail()}
        feed={eventFeed()}
        filters={{ eventTypes: ["translator_connected"], translatorId: "" }}
        page={1}
        onFilterChange={onFilterChange}
        onPageChange={vi.fn()}
        onClearFilters={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Event type · 1"));
    expect(screen.getAllByRole("checkbox")).toHaveLength(6);
    expect(screen.getByRole("checkbox", { name: "Translator connected" })).toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", { name: "Translator disconnected" }));

    expect(onFilterChange).toHaveBeenCalledWith({
      eventTypes: ["translator_connected", "translator_disconnected"]
    });
  });

  it("shows Clear all filters only when active and resets filters plus page", () => {
    const onClearFilters = vi.fn();
    const onPageChange = vi.fn();
    const { rerender } = render(
      <EventFeedPanel
        detail={eventDetail()}
        feed={eventFeed()}
        filters={{ eventTypes: [], translatorId: "" }}
        page={2}
        onFilterChange={vi.fn()}
        onPageChange={onPageChange}
        onClearFilters={onClearFilters}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Clear all filters" })
    ).not.toBeInTheDocument();

    rerender(
      <EventFeedPanel
        detail={eventDetail()}
        feed={eventFeed()}
        filters={{ eventTypes: ["connection_failed"], translatorId: "" }}
        page={2}
        onFilterChange={vi.fn()}
        onPageChange={onPageChange}
        onClearFilters={onClearFilters}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear all filters" }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
    expect(onPageChange).toHaveBeenCalledWith(1);
  });
});

describe("ReportDateRangeControl", () => {
  function RangeHarness({
    initialPreset = "All time",
    initialValue = { from: "", to: "" }
  }: {
    initialPreset?: ReportDateRangePreset;
    initialValue?: ReportDateRangeValue;
  }) {
    const [preset, setPreset] = useState<ReportDateRangePreset>(initialPreset);
    const [value, setValue] = useState<ReportDateRangeValue>(initialValue);
    return (
      <ReportDateRangeControl
        value={value}
        preset={preset}
        onChange={setValue}
        onPresetChange={setPreset}
      />
    );
  }

  it("renders the date range presets in a select", () => {
    render(<RangeHarness />);

    const rangeSelect = screen.getByLabelText("Range");
    expect(rangeSelect).toBeInstanceOf(HTMLSelectElement);
    expect(
      within(rangeSelect).getAllByRole("option").map((option) => option.textContent)
    ).toEqual([
      "All time",
      "Last 5 minutes",
      "Last 30 minutes",
      "Last 1 hour",
      "Last 6 hours",
      "Last 12 hours",
      "Last 24 hours",
      "Today",
      "Last 7 days",
      "Custom"
    ]);
    expect(screen.queryByText("Report date range")).not.toBeInTheDocument();
    expect(screen.queryByText(/All timestamps in IST/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("From")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("To")).not.toBeInTheDocument();
  });

  it("hides custom From and To inputs for non-custom presets", () => {
    const onChange = vi.fn();
    const onPresetChange = vi.fn();

    const { rerender } = render(
      <ReportDateRangeControl
        value={{ from: "2026-06-20T10:00", to: "2026-06-21T10:00" }}
        preset="Last 1 hour"
        onChange={onChange}
        onPresetChange={onPresetChange}
      />
    );

    fireEvent.change(screen.getByLabelText("Range"), {
      target: { value: "Last 24 hours" }
    });

    expect(onPresetChange).toHaveBeenCalledWith("Last 24 hours");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("From")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("To")).not.toBeInTheDocument();

    rerender(
      <ReportDateRangeControl
        value={{ from: "2026-06-20T10:00", to: "2026-06-21T10:00" }}
        preset="Today"
        onChange={onChange}
        onPresetChange={onPresetChange}
      />
    );
    expect(screen.queryByLabelText("From")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("To")).not.toBeInTheDocument();
  });

  it("reveals right-aligned custom From and To inputs when Custom is selected", () => {
    render(<RangeHarness />);

    expect(screen.queryByLabelText("From")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Range"), {
      target: { value: "Custom" }
    });

    const from = screen.getByLabelText("From");
    const to = screen.getByLabelText("To");
    expect(from).toHaveAttribute("type", "datetime-local");
    expect(to).toHaveAttribute("type", "datetime-local");
    expect(from.closest(".admin-report-range-custom")).not.toBeNull();
    expect(to.closest(".admin-report-range-custom")).not.toBeNull();
    expect(screen.getAllByText("(IST)")).toHaveLength(2);
  });

  it("switches the select to Custom when a custom input is edited", () => {
    render(
      <RangeHarness
        initialPreset="Custom"
        initialValue={{ from: "2026-06-20T10:00", to: "2026-06-21T10:00" }}
      />
    );

    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-06-20T11:00" }
    });

    expect(screen.getByLabelText("Range")).toHaveValue("Custom");
    expect(screen.getByLabelText("From")).toHaveValue("2026-06-20T11:00");
    expect(screen.getByLabelText("To")).toHaveValue("2026-06-21T10:00");
  });

  it("renders the preset selected by its parent even when dates are populated", () => {
    render(
      <ReportDateRangeControl
        value={{ from: "2026-06-20T10:00", to: "2026-06-21T10:00" }}
        preset="Last 24 hours"
        onChange={vi.fn()}
      />
    );

    expect(screen.getByLabelText("Range")).toHaveValue("Last 24 hours");
  });
});

describe("CsvDownloadButton", () => {
  it("calls the download handler and shows a success state", async () => {
    const onDownload = vi.fn(async () => undefined);
    render(<CsvDownloadButton onDownload={onDownload} />);

    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));

    await waitFor(() => {
      expect(onDownload).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText("Download ready")).toBeInTheDocument();
  });

  it("shows a failure state when the download handler rejects", async () => {
    const onDownload = vi.fn(async () => {
      throw new Error("network_error");
    });
    render(<CsvDownloadButton onDownload={onDownload} />);

    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));

    expect(await screen.findByText("Download failed")).toBeInTheDocument();
  });
});

describe("ListenerReportPanel", () => {
  const detail: AdminProgramDetail = {
    program: {
      id: "program_1",
      slug: "prog-1",
      name: "Translation Program",
      venue: "Main Hall",
      eventDate: "2026-07-01",
      status: "live",
      adminNotes: "",
      accessControlEnabled: false,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
      firstLiveAt: null
    },
    streams: [
      {
        id: "stream_hi",
        languageName: "Hindi",
        languageCode: "hi",
        displayOrder: 1,
        isActive: true,
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:00:00.000Z"
      }
    ],
    translators: [],
    urls: {
      listenerUrl: "/test",
      translatorUrl: "/translator/test",
      volunteerUrl: "/test/volunteer"
    },
    qrPayload: "{}",
    suggestedQrFilename: "qrcode.svg"
  };

  const baseProps = {
    detail,
    reportOpen: true as const,
    filters: {
      states: [],
      approvalStatuses: [],
      streamId: "",
      deviceLabel: ""
    },
    onClearFilters: vi.fn(),
    onPageChange: vi.fn(),
    isFetching: false,
    onDownloadCsv: vi.fn(),
    accessSummary: { pending: 2, approved: 3, revoked: 1 },
    accessSummaryFetching: false,
    onRefreshAccessSummary: vi.fn(),
    onRevokeAccess: vi.fn(async () => undefined),
    readOnly: false
  };

  it("renders connection times, device label, count meta, and hides raw user-agent text", () => {
    const report: AdminListenerReport = {
      total: 2,
      page: 1,
      pageSize: 100,
      totalPages: 1,
      connections: [
        {
          id: "conn_1",
          programId: "program_1",
          streamId: "stream_hi",
          clientId: "client_1",
          subscriptionStatus: "connected",
          connectedAt: "2026-06-21T10:00:00.000Z",
          disconnectedAt: null,
          disconnectReason: null,
          listenerIp: "203.0.113.10",
          userAgent:
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
          lastSeenAt: "2026-06-21T10:05:00.000Z",
          deviceLabel: "Safari on iPhone",
          deviceModel: "iPhone",
          deviceModelName: "Apple iPhone",
          platform: "iOS",
          platformVersion: "17.0",
          browserFullVersion: "17.0.1",
          approvalStatus: "approved",
          approvedAt: "2026-06-21T09:55:00.000Z",
          approvedVia: "scan",
          hasRevokedHistory: false
        },
        {
          id: "conn_2",
          programId: "program_1",
          streamId: "stream_hi",
          clientId: "client_2",
          subscriptionStatus: "requested",
          connectedAt: null,
          disconnectedAt: null,
          disconnectReason: null,
          listenerIp: "203.0.113.11",
          userAgent: "Test UA",
          lastSeenAt: null,
          deviceLabel: "Unknown device",
          deviceModel: null,
          deviceModelName: null,
          platform: null,
          platformVersion: null,
          browserFullVersion: null,
          approvalStatus: null,
          approvedAt: null,
          approvedVia: null,
          hasRevokedHistory: false
        }
      ]
    };

    render(
      <ListenerReportPanel
        {...baseProps}
        report={report}
        onFilterChange={vi.fn()}
        page={1}
      />
    );

    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Showing 1–2 of 2 connections"
    );

    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    const populatedRow = rows[1]!;
    const nullRow = rows[2]!;
    const populatedCells = within(populatedRow).getAllByRole("cell");
    const nullCells = within(nullRow).getAllByRole("cell");

    expect(populatedCells[1]).toHaveTextContent("21 Jun 2026, 15:30:00 IST");
    expect(populatedCells[2]).not.toHaveTextContent("—");
    expect(populatedCells[3]).toHaveTextContent("203.0.113.10");
    expect(populatedCells[4]).toHaveTextContent("Safari on iPhone");
    expect(populatedCells[4]).toHaveAttribute(
      "title",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    );
    expect(populatedCells[5]).toHaveTextContent("Apple iPhone");
    expect(populatedCells[5]).toHaveAttribute("title", "iPhone");
    expect(
      screen.queryByText(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      )
    ).not.toBeInTheDocument();

    expect(nullCells[1]).toHaveTextContent("—");
    expect(nullCells[2]).toHaveTextContent("—");
  });

  it("shows pagination state for multi-page reports and forwards next", () => {
    const report: AdminListenerReport = {
      total: 150,
      page: 1,
      pageSize: 100,
      totalPages: 2,
      connections: []
    };
    const onPageChange = vi.fn();
    render(
      <ListenerReportPanel
        {...baseProps}
        report={report}
        onFilterChange={vi.fn()}
        onPageChange={onPageChange}
        page={1}
      />
    );

    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Showing 1–100 of 150 connections"
    );
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("calls onFilterChange for state checkbox and clear filters behavior", () => {
    const report: AdminListenerReport = {
      total: 0,
      page: 1,
      pageSize: 100,
      totalPages: 1,
      connections: []
    };
    const onFilterChange = vi.fn();
    const onClearFilters = vi.fn();
    render(
      <ListenerReportPanel
        {...baseProps}
        report={report}
        onFilterChange={onFilterChange}
        onClearFilters={onClearFilters}
        page={1}
      />
    );
    expect(
      screen.queryByRole("button", { name: "Clear all filters" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "requested" }));
    expect(onFilterChange).toHaveBeenCalledWith({ states: ["requested"] });

    render(
      <ListenerReportPanel
        {...baseProps}
        report={report}
        filters={{ ...baseProps.filters, states: ["connected"] }}
        onFilterChange={onFilterChange}
        onClearFilters={onClearFilters}
        page={1}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear all filters" }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it("shows an empty-state row when no connections match and keeps table headers", () => {
    const report: AdminListenerReport = {
      total: 0,
      page: 1,
      pageSize: 100,
      totalPages: 1,
      connections: []
    };
    render(
      <ListenerReportPanel
        {...baseProps}
        report={report}
        onFilterChange={vi.fn()}
        page={1}
      />
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(
      screen.getByText("No connections match the current filters.")
    ).toBeInTheDocument();
  });

  it("exposes a CSV download button for report content", () => {
    const report: AdminListenerReport = {
      total: 1,
      page: 1,
      pageSize: 100,
      totalPages: 1,
      connections: [
        {
          id: "conn_1",
          programId: "program_1",
          streamId: "stream_hi",
          clientId: "client_1",
          subscriptionStatus: "connected",
          connectedAt: "2026-06-21T10:00:00.000Z",
          disconnectedAt: null,
          disconnectReason: null,
          listenerIp: "203.0.113.10",
          userAgent: "Test UA",
          lastSeenAt: "2026-06-21T10:05:00.000Z",
          deviceLabel: "Safari on iPhone",
          deviceModel: "iPhone",
          deviceModelName: "Apple iPhone",
          platform: "iOS",
          platformVersion: "17.0",
          browserFullVersion: "17.0.1",
          approvalStatus: "approved",
          approvedAt: "2026-06-21T09:55:00.000Z",
          approvedVia: "scan",
          hasRevokedHistory: false
        }
      ]
    };
    const onDownloadCsv = vi.fn();
    render(
      <ListenerReportPanel
        {...baseProps}
        report={report}
        onFilterChange={vi.fn()}
        onDownloadCsv={onDownloadCsv}
        page={1}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(onDownloadCsv).toHaveBeenCalledTimes(1);
  });

  it("shows a clickable range chip when a range is active", () => {
    const report: AdminListenerReport = {
      total: 0,
      page: 1,
      pageSize: 100,
      totalPages: 1,
      connections: []
    };
    const onRangeChipClick = vi.fn();

    const { rerender } = render(
      <ListenerReportPanel
        {...baseProps}
        report={report}
        onFilterChange={vi.fn()}
        page={1}
        rangeLabel={null}
        onRangeChipClick={onRangeChipClick}
      />
    );
    expect(screen.queryByRole("button", { name: "Last 7d" })).not.toBeInTheDocument();

    rerender(
      <ListenerReportPanel
        {...baseProps}
        report={report}
        onFilterChange={vi.fn()}
        page={1}
        rangeLabel="Last 7d"
        onRangeChipClick={onRangeChipClick}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Last 7d" }));
    expect(onRangeChipClick).toHaveBeenCalledTimes(1);
  });

  it("renders access KPIs, approval filter and columns, and confirms revoke", async () => {
    const onFilterChange = vi.fn();
    const onRefreshAccessSummary = vi.fn();
    const onRevokeAccess = vi.fn(async () => undefined);
    const report: AdminListenerReport = {
      total: 1,
      page: 1,
      pageSize: 100,
      totalPages: 1,
      connections: [
        {
          id: "conn_approved",
          programId: "program_1",
          streamId: "stream_hi",
          clientId: "client_approved",
          subscriptionStatus: "connected",
          connectedAt: "2026-06-21T10:00:00.000Z",
          disconnectedAt: null,
          disconnectReason: null,
          listenerIp: "203.0.113.10",
          userAgent: "Test UA",
          lastSeenAt: "2026-06-21T10:05:00.000Z",
          deviceLabel: "Safari on iPhone",
          deviceModel: null,
          deviceModelName: null,
          platform: "iOS",
          platformVersion: "17",
          browserFullVersion: "17.0.1",
          approvalStatus: "approved",
          approvedAt: "2026-06-21T09:55:00.000Z",
          approvedVia: "scan",
          hasRevokedHistory: true
        }
      ]
    };

    render(
      <ListenerReportPanel
        {...baseProps}
        report={report}
        onFilterChange={onFilterChange}
        onRefreshAccessSummary={onRefreshAccessSummary}
        onRevokeAccess={onRevokeAccess}
        page={1}
      />
    );

    expect(screen.getByText("Pending").closest("div")).toHaveTextContent("2");
    expect(screen.getByText("Approved").closest("div")).toHaveTextContent("3");
    expect(screen.getByText("Revoked").closest("div")).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: "Refresh access counts" }));
    expect(onRefreshAccessSummary).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("checkbox", { name: "approved" }));
    expect(onFilterChange).toHaveBeenCalledWith({
      approvalStatuses: ["approved"]
    });
    expect(screen.getByRole("columnheader", { name: "Approval status" }))
      .toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Approved at" }))
      .toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Approved via" }))
      .toBeInTheDocument();
    expect(screen.getByText(/volunteer/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(
      screen.getByText(
        "Revoke access for this device? They'll need a volunteer to re-approve them."
      )
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
    await waitFor(() => {
      expect(onRevokeAccess).toHaveBeenCalledWith("client_approved");
    });
  });

  it("hides revoke actions for viewers", () => {
    const report: AdminListenerReport = {
      total: 0,
      page: 1,
      pageSize: 100,
      totalPages: 1,
      connections: []
    };
    render(
      <ListenerReportPanel
        {...baseProps}
        report={report}
        onFilterChange={vi.fn()}
        page={1}
        readOnly
      />
    );
    expect(screen.queryByRole("columnheader", { name: "Action" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" }))
      .not.toBeInTheDocument();
  });
});

describe("buildListenerReportKey", () => {
  const programId = "program_1";
  const relativePreset: ReportDateRangePreset = "Last 5 minutes";
  const emptyCustom: ReportDateRangeValue = { from: "", to: "" };

  it("is time-invariant for a relative preset (ignores the rolling createdFrom/createdTo)", () => {
    // computeRange derives these absolute bounds from Date.now() on every
    // render for relative presets. If the key tracked them, it would change
    // each render and defeat the de-dup guard → the infinite refetch loop.
    const earlier: ListenerReportQuery = {
      createdFrom: "2026-06-21T10:00:00.000Z",
      createdTo: "2026-06-21T10:05:00.000Z"
    };
    const later: ListenerReportQuery = {
      createdFrom: "2026-06-21T10:00:20.000Z",
      createdTo: "2026-06-21T10:05:20.000Z"
    };

    expect(
      buildListenerReportKey(programId, earlier, relativePreset, emptyCustom)
    ).toBe(buildListenerReportKey(programId, later, relativePreset, emptyCustom));
  });

  it("still changes when a meaningful input changes (preset, page, state filter)", () => {
    const query: ListenerReportQuery = {
      createdFrom: "2026-06-21T10:00:00.000Z",
      createdTo: "2026-06-21T10:05:00.000Z"
    };
    const base = buildListenerReportKey(
      programId,
      query,
      relativePreset,
      emptyCustom
    );

    expect(
      buildListenerReportKey(programId, query, "Last 1 hour", emptyCustom)
    ).not.toBe(base);
    expect(
      buildListenerReportKey(
        programId,
        { ...query, page: 2 },
        relativePreset,
        emptyCustom
      )
    ).not.toBe(base);
    expect(
      buildListenerReportKey(
        programId,
        { ...query, states: ["connected"] },
        relativePreset,
        emptyCustom
      )
    ).not.toBe(base);
  });

  it("distinguishes custom ranges by their entered bounds", () => {
    const query: ListenerReportQuery = {};
    const a = buildListenerReportKey(programId, query, "Custom", {
      from: "2026-06-20T10:00",
      to: "2026-06-21T10:00"
    });
    const b = buildListenerReportKey(programId, query, "Custom", {
      from: "2026-06-19T10:00",
      to: "2026-06-21T10:00"
    });
    expect(a).not.toBe(b);
  });
});
