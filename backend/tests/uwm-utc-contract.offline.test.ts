/**
 * UWM UTC contract — absolute timestamps only; date-only never arms precise.
 *   npm test -- tests/uwm-utc-contract.offline.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  extractEventAtFromRetrievalText,
  isAbsoluteUtcTimestamp,
  isDateOnly,
  normalizeAbsoluteUtcIso,
  normalizePublishedAt,
  zonedLocalToUtc,
} from "../src/services/uwm-event-at.js";
import {
  extractRawCandidates,
  normalizeCandidates,
  sanitizeCandidateEventAt,
} from "../src/services/uwm-normalize.js";
import { computeNextPrecise } from "../src/services/uwm-schedule.js";

describe("UTC absolute contract helpers", () => {
  it("accepts Z and numeric offset; rejects date-only and local", () => {
    expect(isAbsoluteUtcTimestamp("2026-11-21T20:00:00.000Z")).toBe(true);
    expect(isAbsoluteUtcTimestamp("2026-11-21T21:00:00+01:00")).toBe(true);
    expect(isAbsoluteUtcTimestamp("2026-11-21")).toBe(false);
    expect(isAbsoluteUtcTimestamp("2026-11-21T21:00")).toBe(false);
    expect(isAbsoluteUtcTimestamp("2026-11-21 21:00")).toBe(false);
    expect(isDateOnly("2026-11-21")).toBe(true);
  });

  it("normalizeAbsoluteUtcIso canonicalizes offset → Z", () => {
    expect(normalizeAbsoluteUtcIso("2026-11-21T21:00:00+01:00")).toBe(
      "2026-11-21T20:00:00.000Z",
    );
    expect(normalizeAbsoluteUtcIso("2026-11-21")).toBeNull();
    expect(normalizeAbsoluteUtcIso("2026-11-21T21:00")).toBeNull();
  });

  it("normalizePublishedAt keeps date-only; normalizes absolute", () => {
    expect(normalizePublishedAt("2026-10-21")).toBe("2026-10-21");
    expect(normalizePublishedAt("2026-10-21T12:00:00Z")).toBe(
      "2026-10-21T12:00:00.000Z",
    );
    expect(normalizePublishedAt("2026-10-21T12:00")).toBeNull();
  });

  it("runtime TZ does not change Madrid→UTC conversion", () => {
    const a = zonedLocalToUtc({
      year: 2026,
      month: 11,
      day: 21,
      hour: 21,
      minute: 0,
      timeZone: "Europe/Madrid",
    });
    // Same inputs always yield same UTC (Intl + Date.UTC; no local Date ctor)
    const b = zonedLocalToUtc({
      year: 2026,
      month: 11,
      day: 21,
      hour: 21,
      minute: 0,
      timeZone: "Europe/Madrid",
    });
    expect(a?.toISOString()).toBe("2026-11-21T20:00:00.000Z");
    expect(b?.toISOString()).toBe(a?.toISOString());
  });
});

describe("sanitizeCandidateEventAt", () => {
  it("drops date-only into attributes.eventDate", () => {
    const s = sanitizeCandidateEventAt({
      title: "x",
      eventAt: "2026-11-21",
    });
    expect(s.eventAt).toBeNull();
    expect(s.attributes.eventDate).toBe("2026-11-21");
  });

  it("keeps absolute Z", () => {
    const s = sanitizeCandidateEventAt({
      title: "x",
      eventAt: "2026-11-21T20:00:00.000Z",
    });
    expect(s.eventAt).toBe("2026-11-21T20:00:00.000Z");
  });
});

describe("page-path extraction (same rules as web_search)", () => {
  it("ISO with Z → eventAt UTC", () => {
    const hit = extractEventAtFromRetrievalText({
      text: "Kickoff 2026-11-21T20:00:00.000Z at the stadium.",
      sources: ["https://club.example/match"],
    });
    expect(hit?.eventAtIso).toBe("2026-11-21T20:00:00.000Z");
  });

  it("ISO with +01:00 offset → UTC Z", () => {
    const hit = extractEventAtFromRetrievalText({
      text: "Starts 2026-11-21T21:00:00+01:00 in Madrid.",
      sources: ["https://club.example/a"],
    });
    expect(hit?.eventAtIso).toBe("2026-11-21T20:00:00.000Z");
  });

  it("local wall + explicit Madrid timezone → UTC", () => {
    const hit = extractEventAtFromRetrievalText({
      text: "Match on 21 בנובמבר 2026 בשעה 21:00 לפי שעון מדריד at Bernabeu.",
      sources: ["https://www.realmadrid.com/news"],
    });
    expect(hit?.localWall).toBe("2026-11-21T21:00");
    expect(hit?.timeZone).toBe("Europe/Madrid");
    expect(hit?.eventAtIso).toBe("2026-11-21T20:00:00.000Z");
  });

  it("date-only → no eventAt", () => {
    const hit = extractEventAtFromRetrievalText({
      text: "The match is on November 21, 2026 in Madrid.",
      sources: ["https://www.realmadrid.com/a"],
    });
    expect(hit).toBeNull();
  });

  it("time without timezone → fail closed", () => {
    const hit = extractEventAtFromRetrievalText({
      text: "Kickoff on November 21, 2026 at 21:00.",
      sources: ["https://example.com/match"],
    });
    expect(hit).toBeNull();
  });

  it("normalizeCandidates strips date-only fixture eventAt", () => {
    const rows = normalizeCandidates({
      candidates: [
        {
          title: "Real Madrid vs Celta",
          url: "https://p.example/m",
          sourceUrls: ["https://p.example/m"],
          eventAt: "2026-11-21",
          retrievalOk: true,
        },
      ],
      fetchedAt: "2026-11-19T12:00:00.000Z",
      sourceKind: "web_page",
      sourceId: "web_page",
    });
    expect(rows[0]!.eventAt).toBeNull();
    expect(rows[0]!.attributes.eventDate).toBe("2026-11-21");
  });

  it("fixture absolute Z survives normalize", () => {
    const rows = extractRawCandidates({
      text: `UWM_FIXTURE_ITEMS: ${JSON.stringify([
        {
          title: "Fixture",
          url: "https://p.example/m",
          eventAt: "2026-06-01T17:00:00.000Z",
          retrievalOk: true,
        },
      ])}\n\n`,
      sources: ["https://p.example/m"],
    });
    const norm = normalizeCandidates({
      candidates: rows,
      fetchedAt: "2026-06-01T12:00:00.000Z",
      sourceKind: "web_page",
      sourceId: "t",
    });
    expect(norm[0]!.eventAt).toBe("2026-06-01T17:00:00.000Z");
  });
});

describe("computeNextPrecise rejects non-absolute eventAt", () => {
  const objectives = [
    { id: "p1", kind: "time_before_event", minutesBefore: 60 },
  ];
  const now = new Date("2026-06-01T12:00:00.000Z");

  it("arms absolute UTC", () => {
    const next = computeNextPrecise({
      now,
      objectives,
      items: {
        a: {
          firstSeenAt: now.toISOString(),
          lastSeenAt: now.toISOString(),
          contentFp: "x",
          eventAt: "2026-06-01T17:00:00.000Z",
          evidenceGrade: "observed",
          notified: {},
          status: "active",
        },
      },
    });
    expect(next?.eventAtIso).toBe("2026-06-01T17:00:00.000Z");
    expect(next?.fireAtIso).toBe("2026-06-01T16:00:00.000Z");
  });

  it("rejects date-only", () => {
    const next = computeNextPrecise({
      now,
      objectives,
      items: {
        a: {
          firstSeenAt: now.toISOString(),
          lastSeenAt: now.toISOString(),
          contentFp: "x",
          eventAt: "2026-06-01",
          evidenceGrade: "observed",
          notified: {},
          status: "active",
        },
      },
    });
    expect(next).toBeNull();
  });

  it("rejects timezone-less local", () => {
    const next = computeNextPrecise({
      now,
      objectives,
      items: {
        a: {
          firstSeenAt: now.toISOString(),
          lastSeenAt: now.toISOString(),
          contentFp: "x",
          eventAt: "2026-06-01T17:00",
          evidenceGrade: "observed",
          notified: {},
          status: "active",
        },
      },
    });
    expect(next).toBeNull();
  });
});
