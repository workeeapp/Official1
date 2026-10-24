import { isValidCalendarYmd } from "@workee/shared";

/**
 * Shared retrieval primitives for calendar-dated record lists.
 *
 * Not a universal pipeline — routes, weather scalars, market quotes, and
 * geospatial search keep their own adapters. Flights' relative-minute window
 * can adopt similar stats later without forcing calendar semantics.
 */

/** Inclusive calendar-day window. Null bound = open on that side. */
export type CalendarDateRange = {
  dateFrom: string | null;
  dateTo: string | null;
};

/**
 * Conceptual RetrievalWindow kinds used by the audit.
 * Calendar filter/sort/cap is implemented here. Flights use relative-time
 * windows in their adapter and only reuse RetrievalStats / isLocallyTruncated.
 */
export type RetrievalWindow =
  | { kind: "calendar_range"; from: string | null; to: string | null }
  | { kind: "relative_minutes"; within: number; now: Date }
  | { kind: "none" };

export type RetrievalStats = {
  matched: number;
  undated: number;
  invalid: number;
  outOfRange: number;
  /** True when kept rows exceeded the local cap after filter+sort. */
  truncated: boolean;
  /**
   * Optional: provider returned a saturated page / hard limit.
   * Represents potential incompleteness, not proof more matches exist.
   */
  providerPartial?: boolean;
  /** Filters the ACTION asked for that this adapter cannot apply. */
  unsupportedFilters?: string[];
};

export function emptyRetrievalStats(): RetrievalStats {
  return {
    matched: 0,
    undated: 0,
    invalid: 0,
    outOfRange: 0,
    truncated: false,
  };
}

export function hasCalendarDateRange(
  range?: CalendarDateRange | null,
): boolean {
  return Boolean(range?.dateFrom || range?.dateTo);
}

export function calendarRangeToWindow(
  range?: CalendarDateRange | null,
): RetrievalWindow {
  if (!hasCalendarDateRange(range)) {
    return { kind: "none" };
  }
  return {
    kind: "calendar_range",
    from: range?.dateFrom ?? null,
    to: range?.dateTo ?? null,
  };
}

/**
 * Filter by optional inclusive YYYY-MM-DD range, sort by date key, then cap.
 *
 * Undated (empty raw) and invalid (non-empty unparseable) are never counted
 * as confirmed out-of-range. With no range they remain in the result (after
 * dated rows when sortDir is desc).
 *
 * Caller supplies domain-specific date parsing via normalizeDate.
 */
export function applyCalendarDateFilterSortCap<T>(
  rows: T[],
  opts: {
    range?: CalendarDateRange | null;
    cap: number;
    getRawDate: (row: T) => string;
    /** Empty → undated; non-empty invalid → invalid; YYYY-MM-DD → matched. */
    normalizeDate: (raw: string) => string | null;
    /** Rewrite row when a valid YMD was parsed (e.g. store normalized date). */
    withNormalizedDate?: (row: T, ymd: string) => T;
    /** Default newest-first (desc). */
    sortDir?: "asc" | "desc";
  },
): { rows: T[]; stats: RetrievalStats } {
  const range = opts.range ?? null;
  const filtering = hasCalendarDateRange(range);
  const from =
    range?.dateFrom && isValidCalendarYmd(range.dateFrom)
      ? range.dateFrom
      : null;
  const to =
    range?.dateTo && isValidCalendarYmd(range.dateTo) ? range.dateTo : null;
  const sortDir = opts.sortDir ?? "desc";

  const stats = emptyRetrievalStats();
  const kept: Array<{ row: T; sortKey: string }> = [];

  for (const row of rows) {
    const raw = String(opts.getRawDate(row) ?? "").trim();
    const ymd = opts.normalizeDate(raw);
    if (!raw) {
      stats.undated += 1;
      if (!filtering) {
        kept.push({ row, sortKey: "" });
      }
      continue;
    }
    if (!ymd) {
      stats.invalid += 1;
      if (!filtering) {
        kept.push({ row, sortKey: "" });
      }
      continue;
    }
    const normalizedRow = opts.withNormalizedDate
      ? opts.withNormalizedDate(row, ymd)
      : row;
    if (filtering) {
      if (from && ymd < from) {
        stats.outOfRange += 1;
        continue;
      }
      if (to && ymd > to) {
        stats.outOfRange += 1;
        continue;
      }
    }
    stats.matched += 1;
    kept.push({ row: normalizedRow, sortKey: ymd });
  }

  kept.sort((a, b) => {
    if (a.sortKey && b.sortKey) {
      const cmp = a.sortKey.localeCompare(b.sortKey);
      return sortDir === "asc" ? cmp : -cmp;
    }
    if (a.sortKey && !b.sortKey) {
      return -1;
    }
    if (!a.sortKey && b.sortKey) {
      return 1;
    }
    return 0;
  });

  const cap = Math.max(0, opts.cap);
  stats.truncated = kept.length > cap;
  return {
    rows: kept.slice(0, cap).map((entry) => entry.row),
    stats,
  };
}

/** True when normalize cap or a later display slice hid rows. */
export function isLocallyTruncated(
  stats: Pick<RetrievalStats, "truncated"> | undefined,
  rowCount: number,
  displayCap: number,
): boolean {
  return Boolean(stats?.truncated) || rowCount > displayCap;
}
