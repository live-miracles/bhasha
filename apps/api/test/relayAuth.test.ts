import { describe, expect, it } from "vitest";

import {
  relayToken,
  timingSafeEqualHex
} from "../src/relay/relayAuth";

describe("relayToken", () => {
  it("is deterministic for same secret and key", async () => {
    const secret = "auth-secret";
    const key = "program-1:stream-1";
    const [first, second] = await Promise.all([
      relayToken(secret, key),
      relayToken(secret, key)
    ]);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different keys", async () => {
    const secret = "auth-secret";
    const tokenA = await relayToken(secret, "program-a:stream-a");
    const tokenB = await relayToken(secret, "program-b:stream-b");

    expect(tokenA).not.toBe(tokenB);
  });
});

describe("timingSafeEqualHex", () => {
  it("returns true for matching tokens", async () => {
    const ok = await timingSafeEqualHex("abcd", "abcd");
    expect(ok).toBe(true);
  });

  it("returns false for mismatching tokens", async () => {
    const wrong = await timingSafeEqualHex("abcd", "abce");
    expect(wrong).toBe(false);
  });

  it("returns false when lengths differ", async () => {
    const mismatch = await timingSafeEqualHex("abcd", "abcd00");
    expect(mismatch).toBe(false);
  });
});

