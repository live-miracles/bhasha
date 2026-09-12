export const RMS_GAIN = 2.0;
export const METER_SEGMENTS = 20;

export const METER_RANGES = [
  { min: -91, max: -90, fraction: 0.07, color: "green" },
  { min: -90, max: -36, fraction: 0.28, color: "green" },
  { min: -36, max: -18, fraction: 0.25, color: "green" },
  { min: -18, max: -6, fraction: 0.25, color: "green" },
  { min: -6, max: -1, fraction: 0.12, color: "amber" },
  { min: -1, max: 0, fraction: 0.03, color: "red" }
] as const;

type MeterColor = (typeof METER_RANGES)[number]["color"];

export function rmsToDb(level: number): number {
  // Clamp defensively: this is a standalone public module, and log10 of a
  // negative would yield NaN. Callers pass clamped [0,1] RMS today.
  const safeLevel = Math.max(0, level);
  return 20 * Math.log10(safeLevel * RMS_GAIN + 1e-10);
}

export function levelToFillFraction(level: number): number {
  const db = rmsToDb(level);
  if (db <= -91) {
    return 0;
  }
  if (db >= 0) {
    return 1;
  }

  let cumulativeBefore = 0;
  for (const range of METER_RANGES) {
    if (range.max >= db) {
      const t = Math.max(
        0,
        Math.min(1, (db - range.min) / (range.max - range.min))
      );
      return cumulativeBefore + t * range.fraction;
    }
    cumulativeBefore += range.fraction;
  }

  return 1;
}

export function levelToFilledSegments(level: number): number {
  return Math.round(levelToFillFraction(level) * METER_SEGMENTS);
}

function cumulativeFractionAtLastBand(color: MeterColor): number {
  let cumulative = 0;
  let cumulativeAtLastBand = 0;

  for (const range of METER_RANGES) {
    cumulative += range.fraction;
    if (range.color === color) {
      cumulativeAtLastBand = cumulative;
    }
  }

  return cumulativeAtLastBand;
}

export const amberStart = Math.round(
  cumulativeFractionAtLastBand("green") * METER_SEGMENTS
);
export const redStart = Math.round(
  cumulativeFractionAtLastBand("amber") * METER_SEGMENTS
);

export function getMeterZone(index: number): MeterColor {
  return index < amberStart ? "green" : index < redStart ? "amber" : "red";
}
