import { describe, expect, it } from "vitest";

import { preferredStreamVersion } from "../src/routes/ListenerRoute";

describe("preferredStreamVersion", () => {
  it("prefers relayVersion when present", () => {
    expect(
      preferredStreamVersion({
        relayVersion: "relay_12",
        publisherVersion: "publisher_old"
      })
    ).toBe("relay_12");
  });

  it("falls back to publisherVersion when relayVersion is null", () => {
    expect(
      preferredStreamVersion({
        relayVersion: null,
        publisherVersion: "publisher_new"
      })
    ).toBe("publisher_new");
  });

  it("falls back to publisherVersion when relayVersion is undefined", () => {
    expect(
      preferredStreamVersion({
        publisherVersion: "publisher_only"
      })
    ).toBe("publisher_only");
  });

  it("returns null when both values are absent", () => {
    expect(preferredStreamVersion(undefined)).toBeNull();
    expect(preferredStreamVersion({})).toBeNull();
    expect(
      preferredStreamVersion({ relayVersion: null, publisherVersion: null })
    ).toBeNull();
  });
});
