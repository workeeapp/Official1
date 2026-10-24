import { describe, expect, it } from "vitest";
import {
  gtfsTimeToSeconds,
  secondsToDisplayHm,
  toServiceDateKey,
} from "../src/services/gtfs-time.js";

describe("gtfs-time", () => {
  it("parses after-midnight times beyond 24:00", () => {
    expect(gtfsTimeToSeconds("25:15:00")).toBe(25 * 3600 + 15 * 60);
    expect(gtfsTimeToSeconds("30:05:00")).toBe(30 * 3600 + 5 * 60);
    expect(secondsToDisplayHm(25 * 3600 + 15 * 60)).toBe("25:15");
  });

  it("rejects invalid clocks", () => {
    expect(gtfsTimeToSeconds("")).toBeNull();
    expect(gtfsTimeToSeconds("99:99:99")).toBeNull();
  });

  it("normalizes service date keys", () => {
    expect(toServiceDateKey("2026-10-24")).toBe("20261024");
  });
});
