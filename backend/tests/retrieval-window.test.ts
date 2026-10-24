import { describe, expect, it } from "vitest";
import { isValidCalendarYmd } from "@workee/shared";
import {
  applyCalendarDateFilterSortCap,
  calendarRangeToWindow,
  emptyRetrievalStats,
  hasCalendarDateRange,
  isLocallyTruncated,
} from "../src/services/retrieval-window.js";

function ymdOnly(raw: string): string | null {
  const s = raw.trim().slice(0, 10);
  return isValidCalendarYmd(s) ? s : null;
}

describe("retrieval-window helpers", () => {
  it("hasCalendarDateRange treats null/empty as none", () => {
    expect(hasCalendarDateRange({ dateFrom: null, dateTo: null })).toBe(false);
    expect(hasCalendarDateRange(null)).toBe(false);
    expect(
      hasCalendarDateRange({ dateFrom: "2025-01-01", dateTo: null }),
    ).toBe(true);
    expect(calendarRangeToWindow({ dateFrom: null, dateTo: null })).toEqual({
      kind: "none",
    });
    expect(
      calendarRangeToWindow({ dateFrom: "2025-01-01", dateTo: "2025-01-31" }),
    ).toEqual({
      kind: "calendar_range",
      from: "2025-01-01",
      to: "2025-01-31",
    });
  });

  it("filters inclusive range, sorts desc, caps, and classifies undated/invalid", () => {
    const { rows, stats } = applyCalendarDateFilterSortCap(
      [
        { id: "a", date: "2025-01-31T12:00:00" },
        { id: "b", date: "2025-02-01" },
        { id: "c", date: "2025-01-01" },
        { id: "d", date: "2024-12-31" },
        { id: "e", date: "" },
        { id: "f", date: "not-a-date" },
      ],
      {
        range: { dateFrom: "2025-01-01", dateTo: "2025-01-31" },
        cap: 10,
        getRawDate: (row) => row.date,
        normalizeDate: ymdOnly,
        withNormalizedDate: (row, ymd) => ({ ...row, date: ymd }),
        sortDir: "desc",
      },
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "c"]);
    expect(rows[0]?.date).toBe("2025-01-31");
    expect(stats).toMatchObject({
      matched: 2,
      outOfRange: 2,
      undated: 1,
      invalid: 1,
      truncated: false,
    });
  });

  it("sorts ascending when requested", () => {
    const { rows } = applyCalendarDateFilterSortCap(
      [
        { id: "late", date: "2025-06-02" },
        { id: "early", date: "2025-06-01" },
      ],
      {
        range: { dateFrom: null, dateTo: null },
        cap: 10,
        getRawDate: (r) => r.date,
        normalizeDate: ymdOnly,
        sortDir: "asc",
      },
    );
    expect(rows.map((r) => r.id)).toEqual(["early", "late"]);
  });

  it("keeps undated when no range and marks truncated on cap", () => {
    const { rows, stats } = applyCalendarDateFilterSortCap(
      [
        { id: "old", date: "2024-01-01" },
        { id: "new", date: "2025-06-01" },
        { id: "none", date: "" },
      ],
      {
        range: { dateFrom: null, dateTo: null },
        cap: 1,
        getRawDate: (r) => r.date,
        normalizeDate: ymdOnly,
      },
    );
    expect(rows.map((r) => r.id)).toEqual(["new"]);
    expect(stats.matched).toBe(2);
    expect(stats.undated).toBe(1);
    expect(stats.truncated).toBe(true);
  });

  it("isLocallyTruncated covers normalize and display-slice cases", () => {
    expect(isLocallyTruncated(undefined, 10, 15)).toBe(false);
    expect(isLocallyTruncated(emptyRetrievalStats(), 16, 15)).toBe(true);
    expect(
      isLocallyTruncated({ ...emptyRetrievalStats(), truncated: true }, 5, 15),
    ).toBe(true);
  });

  it("does not treat undated as outOfRange when filtering", () => {
    const { rows, stats } = applyCalendarDateFilterSortCap(
      [
        { id: "in", date: "2025-05-01" },
        { id: "blank", date: "" },
        { id: "bad", date: "xx" },
      ],
      {
        range: { dateFrom: "2025-01-01", dateTo: "2025-12-31" },
        cap: 10,
        getRawDate: (r) => r.date,
        normalizeDate: ymdOnly,
      },
    );
    expect(rows.map((r) => r.id)).toEqual(["in"]);
    expect(stats.outOfRange).toBe(0);
    expect(stats.undated).toBe(1);
    expect(stats.invalid).toBe(1);
  });
});
