import { beforeEach, describe, expect, it, vi } from "vitest";

import { getOrCreateClientId } from "../src/routes/ListenerRoute";

describe("getOrCreateClientId", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("returns a stable client id for repeated calls with same slug", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
    const clientId = getOrCreateClientId("summer-fest-2026");
    const repeat = getOrCreateClientId("summer-fest-2026");

    expect(repeat).toBe(clientId);
    expect(clientId).toMatch(/^listener_client_/);
  });

  it("persists to localStorage and does not write sessionStorage", () => {
    const slug = "city-voices";
    vi.spyOn(crypto, "randomUUID").mockReturnValue("bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb");
    const clientId = getOrCreateClientId(slug);
    const key = `bhasha.listener.${slug}.clientId`;

    expect(localStorage.getItem(key)).toBe(clientId);
    expect(sessionStorage.length).toBe(0);
  });

  it("uses a different key per program slug", () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("cccccccc-cccc-4ccc-cccc-cccccccccccc")
      .mockReturnValueOnce("dddddddd-dddd-4ddd-dddd-dddddddddddd");
    const a = getOrCreateClientId("event-a");
    const b = getOrCreateClientId("event-b");

    expect(a).not.toBe(b);
    expect(a).toBe("listener_client_cccccccc-cccc-4ccc-cccc-cccccccccccc");
    expect(b).toBe("listener_client_dddddddd-dddd-4ddd-dddd-dddddddddddd");
    expect(localStorage.getItem("bhasha.listener.event-a.clientId")).toBe(a);
    expect(localStorage.getItem("bhasha.listener.event-b.clientId")).toBe(b);
  });
});
