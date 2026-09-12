import { describe, expect, it } from "vitest";

import {
  amberStart,
  getMeterZone,
  levelToFilledSegments,
  redStart,
  RMS_GAIN,
  rmsToDb
} from "../src/lib/micMeter";

describe("mic meter calibration", () => {
  it("converts raw RMS levels to calibrated decibels", () => {
    expect(rmsToDb(0)).toBeCloseTo(20 * Math.log10(1e-10), 6);
    expect(rmsToDb(1)).toBeCloseTo(20 * Math.log10(2), 6);

    const level = 0.1;
    expect(rmsToDb(level) - 20 * Math.log10(level)).toBeCloseTo(
      6.0206,
      4
    );
  });

  it.each([
    [0, 0],
    [0.05, 11],
    [0.25, 17],
    [0.35, 18],
    [0.47, 20],
    [0.5, 20]
  ])("maps level %s to %s filled segments", (level, expected) => {
    expect(levelToFilledSegments(level)).toBe(expected);
  });

  it("places the exact -6 dB boundary at 17 filled segments", () => {
    const level = 10 ** (-6 / 20) / RMS_GAIN;

    expect(levelToFilledSegments(level)).toBe(17);
  });

  it("assigns segment zones at the derived boundaries", () => {
    expect(getMeterZone(16)).toBe("green");
    expect(getMeterZone(17)).toBe("amber");
    expect(getMeterZone(18)).toBe("amber");
    expect(getMeterZone(19)).toBe("red");

    const zones = Array.from({ length: 20 }, (_, index) =>
      getMeterZone(index)
    );
    expect(zones.filter((zone) => zone === "green")).toHaveLength(17);
    expect(zones.filter((zone) => zone === "amber")).toHaveLength(2);
    expect(zones.filter((zone) => zone === "red")).toHaveLength(1);
  });

  it("derives coherent amber and red starts from the meter ranges", () => {
    expect(amberStart).toBe(17);
    expect(redStart).toBe(19);
  });
});
