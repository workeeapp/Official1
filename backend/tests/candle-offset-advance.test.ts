import { beforeEach, describe, expect, it, vi } from "vitest";

const { nextCandleLighting } = vi.hoisted(() => ({
  nextCandleLighting: vi.fn(),
}));

vi.mock("../src/services/jewish.js", () => ({
  nextCandleLighting,
}));

import { resolveNextFireAt } from "../src/services/reminder-fire.js";

describe("resolveNextFireAt jewish_candles", () => {
  beforeEach(() => {
    nextCandleLighting.mockReset();
  });

  it("re-resolves the next week from Hebcal instead of freezing HH:mm", async () => {
    nextCandleLighting.mockResolvedValue(new Date("2026-10-30T14:29:00.000Z"));

    const next = await resolveNextFireAt(
      {
        fireAt: new Date("2026-10-23T14:29:00.000Z"),
        repeat: "weekdays:5",
        recurrence: { freq: "weekly", interval: 1, weekdays: [5] },
        scheduleAnchor: "jewish_candles",
        scheduleOffsetMinutes: -10,
        composePlace: "פתח תקווה",
      },
      new Date("2026-10-23T14:30:00.000Z"),
      1,
    );

    expect(next?.toISOString()).toBe("2026-10-30T14:29:00.000Z");
    expect(nextCandleLighting).toHaveBeenCalledWith(
      expect.objectContaining({
        place: "פתח תקווה",
        offsetMinutes: -10,
      }),
    );
  });

  it("stops when recurrence count is exhausted", async () => {
    const next = await resolveNextFireAt(
      {
        fireAt: new Date("2026-10-23T14:29:00.000Z"),
        repeat: "weekdays:5",
        recurrence: { freq: "weekly", interval: 1, weekdays: [5], count: 1 },
        scheduleAnchor: "jewish_candles",
        scheduleOffsetMinutes: -10,
        composePlace: "פתח תקווה",
      },
      new Date("2026-10-23T14:30:00.000Z"),
      1,
    );
    expect(next).toBeNull();
    expect(nextCandleLighting).not.toHaveBeenCalled();
  });

  it("ends a one-shot candle clock (no recurrence)", async () => {
    const next = await resolveNextFireAt(
      {
        fireAt: new Date("2026-10-23T14:29:00.000Z"),
        repeat: "once",
        scheduleAnchor: "jewish_candles",
        scheduleOffsetMinutes: -45,
        composePlace: "פתח תקווה",
      },
      new Date("2026-10-23T14:30:00.000Z"),
      1,
    );
    expect(next).toBeNull();
    expect(nextCandleLighting).not.toHaveBeenCalled();
  });
});
