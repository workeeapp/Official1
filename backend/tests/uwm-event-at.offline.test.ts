/**
 * Fail-closed eventAt extraction from web_search prose.
 *   npm test -- tests/uwm-event-at.offline.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  extractEventAtFromRetrievalText,
  zonedLocalToUtc,
} from "../src/services/uwm-event-at.js";
import { extractRawCandidates } from "../src/services/uwm-normalize.js";

describe("zonedLocalToUtc", () => {
  it("Madrid winter 21:00 → 20:00Z (CET)", () => {
    const d = zonedLocalToUtc({
      year: 2026,
      month: 11,
      day: 21,
      hour: 21,
      minute: 0,
      timeZone: "Europe/Madrid",
    });
    expect(d?.toISOString()).toBe("2026-11-21T20:00:00.000Z");
  });

  it("Jerusalem 22:00 on same civil day → 20:00Z (IST winter)", () => {
    const d = zonedLocalToUtc({
      year: 2026,
      month: 11,
      day: 21,
      hour: 22,
      minute: 0,
      timeZone: "Asia/Jerusalem",
    });
    expect(d?.toISOString()).toBe("2026-11-21T20:00:00.000Z");
  });
});

describe("extractEventAtFromRetrievalText", () => {
  it("ISO with explicit Z", () => {
    const hit = extractEventAtFromRetrievalText({
      text: "Kickoff at 2026-11-21T20:00:00.000Z at the Bernabeu.",
      sources: ["https://example.com/match"],
    });
    expect(hit?.eventAtIso).toBe("2026-11-21T20:00:00.000Z");
    expect(hit?.timeZoneSource).toBe("explicit_offset");
  });

  it("ISO with +01:00 offset", () => {
    const hit = extractEventAtFromRetrievalText({
      text: "Starts 2026-11-21T21:00:00+01:00",
      sources: ["https://example.com/a"],
    });
    expect(hit?.eventAtIso).toBe("2026-11-21T20:00:00.000Z");
  });

  it("English date + time + Madrid place", () => {
    const hit = extractEventAtFromRetrievalText({
      text: "Real Madrid vs Celta will be played on November 21, 2026 at 9:00 pm in Madrid.",
      sources: ["https://www.realmadrid.com/news/match"],
    });
    expect(hit?.localWall).toBe("2026-11-21T21:00");
    expect(hit?.timeZone).toBe("Europe/Madrid");
    expect(hit?.eventAtIso).toBe("2026-11-21T20:00:00.000Z");
  });

  it("Hebrew date + שעון מדריד (not Israel wall clock)", () => {
    const text =
      "המשחק הבא של ריאל מדריד הוא מול סלטה ויגו, בשבת, 21 בנובמבר 2026, בשעה 21:00 לפי שעון מדריד — כלומר 22:00 בישראל. המשחק ייערך בסנטיאגו ברנבאו.";
    const hit = extractEventAtFromRetrievalText({
      text,
      sources: [
        "The Real Madrid-Celta match will be played on Saturday, November 21, at 9:00 pm — https://www.realmadrid.com/en-US/news/football/first-team/latest-news/el-real-madrid-celta-se-jugara-el-sabado-21-de-noviembre-a-las-21-00-horas-21-10-2026?utm_source=openai",
      ],
    });
    expect(hit).not.toBeNull();
    expect(hit!.timeZone).toBe("Europe/Madrid");
    expect(hit!.localWall).toBe("2026-11-21T21:00");
    // 21:00 Madrid ≠ 21:00 Israel
    expect(hit!.eventAtIso).toBe("2026-11-21T20:00:00.000Z");
    expect(hit!.snippet).toMatch(/21|נובמבר|21:00/);
  });

  it("inverted Israel/Spain gloss vs English 9pm → fail closed (conflict)", () => {
    // Hosted search sometimes swaps the conversion line; English 9pm Madrid
    // disagrees with the inverted pair → do not invent a kickoff.
    const text =
      "המשחק הבא של ריאל מדריד נגד סלטה ויגו, 21 בנובמבר 2026, בשעה 21:00 לפי שעון ישראל (20:00 בספרד). יתקיים בסנטיאגו ברנבאו.";
    const hit = extractEventAtFromRetrievalText({
      text,
      sources: [
        "The Real Madrid-Celta match will be played on Saturday, November 21, at 9:00 pm — https://www.realmadrid.com/en-US/news/x-21-10-2026",
      ],
    });
    expect(hit).toBeNull();
  });

  it("correct Madrid+Israel conversion pair + English 9pm → 20:00Z", () => {
    const text =
      "ריאל מדריד נגד סלטה, 21 בנובמבר 2026, בשעה 21:00 לפי שעון מדריד (22:00 בישראל), ברנבאו.";
    const hit = extractEventAtFromRetrievalText({
      text,
      sources: [
        "November 21, 2026 at 9:00 pm — https://www.realmadrid.com/news/x",
      ],
    });
    expect(hit?.eventAtIso).toBe("2026-11-21T20:00:00.000Z");
    expect(hit?.timeZone).toBe("Europe/Madrid");
  });

  it("URL publication date DD-MM-YYYY is NOT used as eventAt", () => {
    // Event clearly Nov 21; URL path has 21-10-2026 (publication).
    const hit = extractEventAtFromRetrievalText({
      text: "Match on 21 בנובמבר 2026 בשעה 21:00 לפי שעון מדריד.",
      sources: [
        "https://www.realmadrid.com/news/el-partido-21-10-2026",
      ],
    });
    expect(hit?.localWall).toBe("2026-11-21T21:00");
    expect(hit?.eventAtIso).toBe("2026-11-21T20:00:00.000Z");
  });

  it("URL-only date with no prose event → null (fail closed)", () => {
    const hit = extractEventAtFromRetrievalText({
      text: "See the club site for details.",
      sources: [
        "https://www.realmadrid.com/news/update-21-10-2026",
      ],
    });
    expect(hit).toBeNull();
  });

  it("date without time → null", () => {
    const hit = extractEventAtFromRetrievalText({
      text: "Real Madrid play Celta on November 21, 2026 in Madrid.",
      sources: ["https://www.realmadrid.com/a"],
    });
    expect(hit).toBeNull();
  });

  it("time without timezone/place → null", () => {
    const hit = extractEventAtFromRetrievalText({
      text: "The match is on November 21, 2026 at 21:00.",
      sources: ["https://example.com/sports/match"],
    });
    expect(hit).toBeNull();
  });

  it("English date without year → null", () => {
    const hit = extractEventAtFromRetrievalText({
      text: "Kickoff Saturday, November 21, at 9:00 pm in Madrid.",
      sources: ["https://www.realmadrid.com/a"],
    });
    expect(hit).toBeNull();
  });

  it("conflicting absolute ISOs → null", () => {
    const hit = extractEventAtFromRetrievalText({
      text: "One source 2026-11-21T20:00:00.000Z other 2026-11-22T20:00:00.000Z",
      sources: ["https://example.com/a"],
    });
    expect(hit).toBeNull();
  });
});

describe("extractRawCandidates wires eventAt + provenance attrs", () => {
  it("attaches eventAt and extraction attributes for Real Madrid prose", () => {
    const text =
      "המשחק הבא של ריאל מדריד הוא מול סלטה ויגו, בשבת, 21 בנובמבר 2026, בשעה 21:00 לפי שעון מדריד — כלומר 22:00 בישראל.\nhttps://www.realmadrid.com/en-US/news/match";
    const rows = extractRawCandidates({
      text,
      sources: [
        "https://www.realmadrid.com/en-US/news/football/first-team/latest-news/el-real-madrid-celta-se-jugara-el-sabado-21-de-noviembre-a-las-21-00-horas-21-10-2026",
      ],
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.eventAt).toBe("2026-11-21T20:00:00.000Z");
    expect(rows[0]!.attributes?.eventAtTimeZone).toBe("Europe/Madrid");
    expect(rows[0]!.attributes?.eventAtLocal).toBe("2026-11-21T21:00");
    expect(rows[0]!.attributes?.eventAtExtractedFrom).toBe("web_search_prose");
    expect(String(rows[0]!.attributes?.eventAtSnippet ?? "").length).toBeGreaterThan(0);
  });

  it("fixture path still wins (page-path regression)", () => {
    const rows = extractRawCandidates({
      text: `UWM_FIXTURE_ITEMS: ${JSON.stringify([
        {
          title: "Fixture Match",
          url: "https://p.example/m",
          sourceUrls: ["https://p.example/m"],
          eventAt: "2026-06-01T17:00:00.000Z",
          retrievalOk: true,
        },
      ])}\n\n`,
      sources: ["https://p.example/m"],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventAt).toBe("2026-06-01T17:00:00.000Z");
    expect(rows[0]!.attributes?.eventAtExtractedFrom).toBeUndefined();
  });
});
