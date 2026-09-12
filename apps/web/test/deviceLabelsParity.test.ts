import { describe, expect, it } from "vitest";

import { LISTENER_DEVICE_LABELS } from "../src/api/admin";

describe("LISTENER_DEVICE_LABELS parity", () => {
  it("matches api device label list snapshot", () => {
    // Keep this snapshot in sync with the api's DEVICE_LABELS and deviceLabel.ts.
    const expected = [
      "Edge on Windows",
      "Chrome on iPhone",
      "Chrome on iPad",
      "Chrome on Windows",
      "Chrome on macOS",
      "Chrome on Android",
      "Firefox on Windows",
      "Safari on iPhone",
      "Safari on iPad",
      "Safari on macOS",
      "Unknown device"
    ];

    expect(new Set(LISTENER_DEVICE_LABELS)).toEqual(new Set(expected));
  });
});
