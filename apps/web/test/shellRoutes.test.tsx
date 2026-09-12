import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";
import type {
  PublicApi,
  PublicProgramMetadata,
  PublicProgramStatus
} from "../src/api/public";

function metadata(streams: PublicProgramMetadata["streams"]): PublicProgramMetadata {
  return {
    program: {
      slug: "patna-event-2026",
      name: "Patna Event 2026",
      venue: "Main Hall",
      eventDate: "2026-07-01",
      status: "live",
      accessControlEnabled: false
    },
    streams,
    urls: {
      listenerUrl: "https://bhasha.test/patna-event-2026",
      translatorUrl: "https://bhasha.test/patna-event-2026/translate",
      volunteerUrl: "https://bhasha.test/patna-event-2026/volunteer"
    }
  };
}

function programStatus(
  streams: PublicProgramStatus["streams"] = []
): PublicProgramStatus {
  return {
    program: { slug: "patna-event-2026" },
    streams,
    stale: false,
    degraded: false,
    serverTime: "2026-06-21T10:00:00.000Z"
  };
}

describe("App route shells", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders the auth-gated admin dashboard route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "admin_auth_required" }, { status: 401 })
      )
    );

    window.history.pushState(null, "", "/admin");
    render(<App path="/admin" />);

    expect(
      await screen.findByRole("main", { name: "Admin dashboard" })
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Admin login" })).toBeInTheDocument();
  });

  it("renders loading then listener metadata and status success", async () => {
    const fetchProgram = vi.fn(async () =>
      metadata([
        {
          id: "stream_hi",
          languageName: "Hindi",
          nativeName: "हिन्दी",
          languageCode: "hi",
          displayOrder: 1,
          isActive: true
        }
      ])
    );
    const fetchProgramStatus = vi.fn(async () =>
      programStatus([
        {
          id: "stream_hi",
          languageName: "Hindi",
          nativeName: "हिन्दी",
          languageCode: "hi",
          isActive: true,
          state: "live",
        }
      ])
    );

    render(
      <App
        path="/patna-event-2026"
        publicApi={{ fetchProgram, fetchProgramStatus }}
      />
    );

    expect(screen.getByText("Loading program...")).toBeInTheDocument();
    expect(await screen.findByText("Patna Event 2026")).toBeInTheDocument();
    expect(screen.getByText("Hindi")).toBeInTheDocument();
    // Listener counts are admin-only telemetry and must not render for participants.
    expect(screen.queryByText(/listening/i)).not.toBeInTheDocument();
    expect(fetchProgram).toHaveBeenCalledWith("patna-event-2026");
    expect(fetchProgram).toHaveBeenCalledTimes(1);
    expect(fetchProgramStatus).toHaveBeenCalledWith("patna-event-2026");
  });

  it("renders listener empty metadata state", async () => {
    const publicApi: PublicApi = {
      fetchProgram: vi.fn(async () => metadata([])),
      fetchProgramStatus: vi.fn(async () => programStatus())
    };
    render(
      <App
        path="/patna-event-2026"
        publicApi={publicApi}
      />
    );

    expect(await screen.findByText("No languages are available yet.")).toBeInTheDocument();
  });

  it("renders listener error state", async () => {
    render(
      <App
        path="/patna-event-2026"
        publicApi={{
          fetchProgram: vi.fn(async () => {
            throw new Error("program_not_found");
          }),
          fetchProgramStatus: vi.fn(async () => programStatus())
        }}
      />
    );

    expect(await screen.findByText("This program does not exist.")).toBeInTheDocument();
  });

  it("renders translator shell login with the decoded slug", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "translator_auth_required" }, { status: 401 })
      )
    );

    render(<App path="/patna%20event%202026/translate" />);

    expect(
      screen.getByRole("main", { name: "Translator shell" })
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Translator login" })
    ).toBeInTheDocument();
    // The program slug appears in the login eyebrow once auth resolves to
    // logged-out — T2 moved it from an always-on header into the per-state
    // login head, so it is asserted after the login screen renders.
    expect(screen.getByText("patna event 2026")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go live" })).not.toBeInTheDocument();
  });

  it("renders not found shell for unknown routes", () => {
    render(<App path="/missing/path" />);

    expect(screen.getByRole("main", { name: "Not found" })).toBeInTheDocument();
  });
});
