import { describe, expect, it, vi } from "vitest";
import {
  applyMashovDateFilterSortCap,
  defaultMashovYear,
  formatMashovHebrew,
  hasMashovDateRange,
  isMashovPasswordTooShortError,
  loadMashovCredsFromFilings,
  MASHOV_INVALID_DATE_BOUNDS_HE,
  MASHOV_PASSWORD_TOO_SHORT_HE,
  matchMashovSchool,
  mashovSchoolMatchScore,
  normalizeAbsences,
  normalizeGrades,
  normalizeMashovEventDate,
  normalizeMessages,
  parseMashovAspects,
  pickMashovChild,
  resolveMashovReply,
  resolveMashovReplyRange,
} from "../src/services/mashov.js";

describe("parseMashovAspects", () => {
  it("defaults to grades", () => {
    expect(parseMashovAspects(undefined)).toEqual(["grades"]);
  });

  it("maps aliases", () => {
    expect(parseMashovAspects(["behave", "schedule"])).toEqual([
      "behavior",
      "timetable",
    ]);
  });

  it("maps absences and messages hebrew aliases", () => {
    expect(parseMashovAspects(["חיסורים", "הודעות"])).toEqual([
      "absences",
      "messages",
    ]);
  });

  it("maps חיזוקים to behavior", () => {
    expect(parseMashovAspects(["חיזוקים חיוביים", "חיזוק"])).toEqual([
      "behavior",
    ]);
  });
});

describe("loadMashovCredsFromFilings", () => {
  it("reads convention filings", () => {
    const { creds, missing } = loadMashovCredsFromFilings(
      [
        { item_name: "תעודת זהות למשוב", item_info: "03222842" },
        { item_name: "סיסמת משוב של דניאל", item_info: "ds73s" },
        { item_name: "סמל בית ספר למשוב", item_info: "123456" },
        { item_name: "שנת לימודים למשוב", item_info: "2026" },
      ],
      { child: "דניאל" },
    );
    expect(missing).toEqual([]);
    expect(creds).toMatchObject({
      username: "03222842",
      password: "ds73s",
      semel: 123456,
      year: 2026,
    });
  });

  it("reports missing fields", () => {
    const { creds, missing } = loadMashovCredsFromFilings([
      { item_name: "תעודת זהות למשוב", item_info: "1" },
    ]);
    expect(creds).toBeNull();
    expect(missing).toContain("סיסמת משוב");
    expect(missing).toContain("שם בית ספר למשוב");
    expect(missing).toContain("שנת לימודים למשוב");
  });

  it("pends school-name resolution when name+year are filed without semel", () => {
    const { creds, missing, pendingSchool } = loadMashovCredsFromFilings([
      { item_name: "תעודת זהות למשוב", item_info: "03222842" },
      { item_name: "סיסמת משוב", item_info: "secret" },
      { item_name: "שם בית ספר למשוב", item_info: "אריאל שרון פתח תקווה" },
      { item_name: "שנת לימודים למשוב", item_info: "2026" },
    ]);
    expect(creds).toBeNull();
    expect(missing).toEqual([]);
    expect(pendingSchool).toMatchObject({
      name: "אריאל שרון פתח תקווה",
      year: 2026,
      username: "03222842",
    });
  });

  it("asks for year when school name is filed without year", () => {
    const { missing, pendingSchool } = loadMashovCredsFromFilings([
      { item_name: "תעודת זהות למשוב", item_info: "1" },
      { item_name: "סיסמת משוב", item_info: "x" },
      { item_name: "שם בית ספר למשוב", item_info: "אחד העם" },
    ]);
    expect(pendingSchool).toBeUndefined();
    expect(missing).toContain("שנת לימודים למשוב");
  });

  it("picks child-labeled school/password and does not steal sibling school", () => {
    const { pendingSchool, missing } = loadMashovCredsFromFilings(
      [
        { item_name: "תעודת זהות למשוב", item_info: "03222842" },
        { item_name: "סיסמת משוב של יואב", item_info: "yoavpass" },
        { item_name: "סיסמת משוב של מאיה", item_info: "mayapass" },
        { item_name: "שם בית ספר למשוב של יואב", item_info: "שש שנתי רמון פתח תקווה" },
        { item_name: "שם בית ספר למשוב של מאיה", item_info: "שש שנתי משה ארנס" },
        { item_name: "שנת לימודים למשוב", item_info: "2027" },
      ],
      { child: "מאיה" },
    );
    expect(missing).toEqual([]);
    expect(pendingSchool).toMatchObject({
      name: "שש שנתי משה ארנס",
      year: 2027,
      password: "mayapass",
      passwordChild: "מאיה",
    });
  });
});

describe("matchMashovSchool", () => {
  const schools = [
    {
      semel: 100005,
      name: 'חט"ב אחד העם החדשה - פתח תקוה',
      years: [2024, 2025],
    },
    {
      semel: 580001,
      name: "שש שנתי רמון - פתח תקוה (חטב+חטע)",
      years: [2025, 2026, 2027],
    },
    {
      semel: 112185,
      name: "אריאל - ירושלים (יסודי)",
      years: [2025, 2026],
    },
    {
      semel: 114058,
      name: "אריאל ממד - אפרתה (יסודי)",
      years: [2025, 2026],
    },
  ];

  it("scores exact-ish substring matches", () => {
    expect(mashovSchoolMatchScore(schools[0]!.name, "אחד העם")).toBeGreaterThanOrEqual(
      50,
    );
  });

  it("folds תקווה to תקוה so Petah Tikva queries match Mashov spelling", () => {
    expect(
      mashovSchoolMatchScore(
        "שש שנתי רמון - פתח תקוה (חטב+חטע)",
        "שש שנתי רמון פתח תקווה",
      ),
    ).toBeGreaterThanOrEqual(50);
  });

  it("picks Ramon Petah Tikva from a spoken-style query", () => {
    const matched = matchMashovSchool({
      schools,
      query: "שש שנתי רמון פתח תקווה",
      year: 2027,
    });
    expect(matched.reason).toBe("ok");
    expect(matched.school?.semel).toBe(580001);
  });

  it("picks a unique name+year match", () => {
    const matched = matchMashovSchool({
      schools,
      query: "אחד העם פתח תקווה",
      year: 2025,
    });
    expect(matched.reason).toBe("ok");
    expect(matched.school?.semel).toBe(100005);
  });

  it("reports year miss when name hits but year is absent", () => {
    const matched = matchMashovSchool({
      schools,
      query: "אחד העם",
      year: 2026,
    });
    expect(matched.reason).toBe("year");
    expect(matched.school).toBeNull();
  });

  it("asks when several schools tie", () => {
    const matched = matchMashovSchool({
      schools,
      query: "אריאל",
      year: 2026,
    });
    expect(matched.reason).toBe("ambiguous");
    expect(matched.candidates.length).toBeGreaterThan(1);
  });
});

describe("pickMashovChild / format", () => {
  const kids = [
    { guid: "g1", privateName: "דניאל", familyName: "כהן" },
    { guid: "g2", privateName: "נועה", familyName: "כהן" },
  ];

  it("asks which when several and no name", () => {
    const picked = pickMashovChild(kids, "");
    expect(picked.child).toBeNull();
    expect(picked.askWhich.length).toBe(2);
  });

  it("matches by first name", () => {
    expect(pickMashovChild(kids, "דניאל").child?.guid).toBe("g1");
  });

  it("formats grades hebrew", () => {
    const text = formatMashovHebrew({
      childName: "דניאל",
      aspects: ["grades"],
      grades: [
        {
          subject: "מתמטיקה",
          grade: "90",
          date: "2026-10-01",
          type: "מבחן",
        },
      ],
      homework: [],
      behavior: [],
      timetable: [],
      absences: [],
      messages: [],
      missingCreds: [],
    });
    expect(text).toContain("מתמטיקה");
    expect(text).toContain("90");
  });

  it("asks for year in plain Hebrew when only year is missing", () => {
    expect(
      formatMashovHebrew({
        childName: "יואב",
        aspects: ["grades"],
        grades: [],
        homework: [],
        behavior: [],
        timetable: [],
        absences: [],
        messages: [],
        missingCreds: ["שנת לימודים למשוב"],
      }),
    ).toContain("לאיזו שנת לימודים");
  });

  it("formats absences and messages", () => {
    const text = formatMashovHebrew({
      childName: "דניאל",
      aspects: ["absences", "messages"],
      grades: [],
      homework: [],
      behavior: [],
      timetable: [],
      absences: [
        { subject: "אנגלית", text: "חיסור", date: "2026-10-20" },
      ],
      messages: [
        {
          from: "מחנכת",
          subject: "טיול",
          preview: "נא לאשר",
          date: "2026-10-21",
        },
      ],
      missingCreds: [],
    });
    expect(text).toContain("חיסורים");
    expect(text).toContain("אנגלית");
    expect(text).toContain("הודעות");
    expect(text).toContain("טיול");
  });
});

describe("normalizeAbsences / normalizeMessages", () => {
  it("keeps absence-like behave rows", () => {
    expect(
      normalizeAbsences([
        {
          subjectName: "ספורט",
          achvaName: "חיסור",
          lessonDate: "2026-10-01",
        },
        {
          subjectName: "מתמטיקה",
          achvaName: "חיזוק חיובי",
          lessonDate: "2026-10-02",
        },
      ]),
    ).toEqual([
      { subject: "ספורט", text: "חיסור", date: "2026-10-01" },
    ]);
  });

  it("maps inbox conversation rows", () => {
    expect(
      normalizeMessages([
        {
          subject: "אסיפת הורים",
          senderName: "מנהלת",
          lastMessage: "שלום",
          sendDate: "2026-10-21T10:00:00",
        },
      ]),
    ).toEqual([
      {
        subject: "אסיפת הורים",
        from: "מנהלת",
        date: "2026-10-21",
        preview: "שלום",
      },
    ]);
  });
});

describe("normalizeGrades", () => {
  it("maps mashov-shaped rows", () => {
    expect(
      normalizeGrades([
        {
          subjectName: "אנגלית",
          grade: 85,
          eventDate: "2026-09-01T00:00:00",
          gradingEvent: "בוחן",
        },
      ]),
    ).toEqual([
      {
        subject: "אנגלית",
        grade: "85",
        date: "2026-09-01",
        type: "בוחן",
      },
    ]);
  });
});

describe("mashov event dates", () => {
  it("normalizes ISO, dmy, leap day, and rejects invalid", () => {
    expect(normalizeMashovEventDate("2025-03-01T22:00:00Z")).toBe("2025-03-01");
    expect(normalizeMashovEventDate("01.09.2025")).toBe("2025-09-01");
    expect(normalizeMashovEventDate("29/02/2024")).toBe("2024-02-29");
    expect(normalizeMashovEventDate("29/02/2025")).toBeNull();
    expect(normalizeMashovEventDate("2025-13-01")).toBeNull();
    expect(normalizeMashovEventDate("")).toBeNull();
    expect(normalizeMashovEventDate("לא ידוע")).toBeNull();
  });

  it("treats null range as no filter", () => {
    expect(hasMashovDateRange({ dateFrom: null, dateTo: null })).toBe(false);
    expect(hasMashovDateRange({ dateFrom: "2025-01-01", dateTo: null })).toBe(
      true,
    );
  });

  it("filters inclusive month bounds and sorts newest-first before cap", () => {
    const { rows, stats } = applyMashovDateFilterSortCap(
      [
        { id: "a", date: "2025-01-31T12:00:00" },
        { id: "b", date: "2025-02-01" },
        { id: "c", date: "2025-01-01" },
        { id: "d", date: "2024-12-31" },
        { id: "e", date: "" },
        { id: "f", date: "bad-date" },
      ],
      {
        range: { dateFrom: "2025-01-01", dateTo: "2025-01-31" },
        cap: 10,
      },
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "c"]);
    expect(stats.matched).toBe(2);
    expect(stats.outOfRange).toBe(2);
    expect(stats.undated).toBe(1);
    expect(stats.invalid).toBe(1);
    expect(stats.truncated).toBe(false);
  });

  it("keeps undated when no range and sorts dated newest-first before cap", () => {
    const { rows, stats } = applyMashovDateFilterSortCap(
      [
        { id: "old", date: "2024-01-01" },
        { id: "new", date: "2025-06-01" },
        { id: "mid", date: "2025-01-15" },
        { id: "none", date: "" },
      ],
      { range: { dateFrom: null, dateTo: null }, cap: 2 },
    );
    expect(rows.map((r) => r.id)).toEqual(["new", "mid"]);
    expect(stats.matched).toBe(3);
    expect(stats.undated).toBe(1);
    expect(stats.truncated).toBe(true);
  });

  it("supports full historical calendar year 2025", () => {
    const grades = normalizeGrades(
      [
        {
          subjectName: "היסטוריה",
          grade: 70,
          eventDate: "2025-06-15",
          gradingEvent: "מבחן",
        },
        {
          subjectName: "מתמטיקה",
          grade: 90,
          eventDate: "2024-12-20",
          gradingEvent: "מבחן",
        },
        {
          subjectName: "אנגלית",
          grade: 80,
          eventDate: "2026-01-05",
          gradingEvent: "בוחן",
        },
      ],
      { range: { dateFrom: "2025-01-01", dateTo: "2025-12-31" } },
    );
    expect(grades).toEqual([
      {
        subject: "היסטוריה",
        grade: "70",
        date: "2025-06-15",
        type: "מבחן",
      },
    ]);
  });

  it("filters mixed event types independently via normalize helpers", () => {
    expect(
      normalizeAbsences(
        [
          {
            subjectName: "ספורט",
            achvaName: "חיסור",
            lessonDate: "2025-03-01",
          },
          {
            subjectName: "ספורט",
            achvaName: "חיסור",
            lessonDate: "2025-05-01",
          },
        ],
        { range: { dateFrom: "2025-04-01", dateTo: "2025-04-30" } },
      ),
    ).toEqual([]);
    expect(
      normalizeMessages(
        [
          {
            subject: "ישן",
            senderName: "א",
            lastMessage: "x",
            sendDate: "2025-01-01",
          },
          {
            subject: "חדש",
            senderName: "ב",
            lastMessage: "y",
            sendDate: "2025-08-01T09:00:00",
          },
        ],
        { range: { dateFrom: "2025-07-01", dateTo: null } },
      ).map((m) => m.subject),
    ).toEqual(["חדש"]);
  });

  it("Hebrew empty range distinguishes unclassified undated rows", () => {
    const text = formatMashovHebrew({
      childName: "דניאל",
      aspects: ["grades"],
      grades: [],
      homework: [],
      behavior: [],
      timetable: [],
      absences: [],
      messages: [],
      missingCreds: [],
      dateFrom: "2025-01-01",
      dateTo: "2025-12-31",
      dateStats: {
        grades: {
          matched: 0,
          undated: 2,
          invalid: 1,
          outOfRange: 5,
          truncated: false,
        },
      },
    });
    expect(text).toContain("לא מצאתי ציונים עם תאריך תקין");
    expect(text).toContain("לא סווגו לטווח");
    expect(text).not.toMatch(/^אין ציונים בטווח/);
  });

  it("Hebrew empty range with no unclassified is a clean negative", () => {
    const text = formatMashovHebrew({
      childName: "דניאל",
      aspects: ["grades"],
      grades: [],
      homework: [],
      behavior: [],
      timetable: [],
      absences: [],
      messages: [],
      missingCreds: [],
      dateFrom: "2025-01-01",
      dateTo: "2025-01-31",
      dateStats: {
        grades: {
          matched: 0,
          undated: 0,
          invalid: 0,
          outOfRange: 4,
          truncated: false,
        },
      },
    });
    expect(text).toContain("אין ציונים בטווח 2025-01-01–2025-01-31");
    expect(text).toContain("מחוץ לטווח");
    expect(text).toContain("שנת לימודים למשוב");
    expect(text).not.toContain("לא סווגו");
  });

  it("Hebrew matches note unclassified without claiming completeness of API pages", () => {
    const text = formatMashovHebrew({
      childName: "דניאל",
      aspects: ["grades"],
      grades: [
        {
          subject: "מתמטיקה",
          grade: "90",
          date: "2025-05-01",
          type: "מבחן",
        },
      ],
      homework: [],
      behavior: [],
      timetable: [],
      absences: [],
      messages: [],
      missingCreds: [],
      dateFrom: "2025-01-01",
      dateTo: "2025-12-31",
      dateStats: {
        grades: {
          matched: 1,
          undated: 2,
          invalid: 0,
          outOfRange: 0,
          truncated: false,
        },
      },
    });
    expect(text).toContain("מתמטיקה");
    expect(text).toContain("בטווח 2025-01-01–2025-12-31");
    expect(text).toContain("2 רשומות נוספות בלי תאריך תקין");
    expect(text).not.toContain("הכי חדשים");
  });

  it("documents no pagination: single-response local cap only", () => {
    // Client Mashov GETs have no page/limit query; truncation is local only.
    const many = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`,
      date: `2025-06-${String(10 - i).padStart(2, "0")}`,
    }));
    const { rows, stats } = applyMashovDateFilterSortCap(many, {
      range: { dateFrom: "2025-01-01", dateTo: "2025-12-31" },
      cap: 3,
    });
    expect(rows).toHaveLength(3);
    expect(stats.matched).toBe(5);
    expect(stats.truncated).toBe(true);
    expect(rows[0]?.id).toBe("r0");
  });

  it("rejects explicit invalid bounds instead of open-range", () => {
    expect(
      resolveMashovReplyRange({ dateFrom: "2025-02-29", dateTo: "2025-03-01" }),
    ).toEqual({ ok: false, notice: MASHOV_INVALID_DATE_BOUNDS_HE });
    expect(
      resolveMashovReplyRange({ dateBoundsInvalid: true }),
    ).toEqual({ ok: false, notice: MASHOV_INVALID_DATE_BOUNDS_HE });
    expect(resolveMashovReplyRange({ dateFrom: null, dateTo: null })).toEqual({
      ok: true,
      range: { dateFrom: null, dateTo: null },
    });
    expect(
      resolveMashovReplyRange({
        dateFrom: "2025-01-01",
        dateTo: "2025-12-31",
      }),
    ).toEqual({
      ok: true,
      range: { dateFrom: "2025-01-01", dateTo: "2025-12-31" },
    });
  });

  it("Hebrew discloses local truncation when stats.truncated", () => {
    const text = formatMashovHebrew({
      childName: "דניאל",
      aspects: ["grades"],
      grades: [
        {
          subject: "מתמטיקה",
          grade: "90",
          date: "2025-05-01",
          type: "מבחן",
        },
      ],
      homework: [],
      behavior: [],
      timetable: [],
      absences: [],
      messages: [],
      missingCreds: [],
      dateFrom: null,
      dateTo: null,
      dateStats: {
        grades: {
          matched: 50,
          undated: 0,
          invalid: 0,
          outOfRange: 0,
          truncated: true,
        },
      },
    });
    expect(text).toContain("מתמטיקה");
    expect(text).toContain("מגבלת תצוגה");
  });

  it("Hebrew discloses truncation when display slice hides rows without normalize truncated", () => {
    // 16 grades ≤ normalize cap 40 → stats.truncated false, but slice(0,15) hides 1.
    const grades = Array.from({ length: 16 }, (_, i) => ({
      subject: `מקצוע${i}`,
      grade: "80",
      date: `2025-05-${String(16 - i).padStart(2, "0")}`,
      type: "מבחן",
    }));
    const text = formatMashovHebrew({
      childName: "דניאל",
      aspects: ["grades"],
      grades,
      homework: [],
      behavior: [],
      timetable: [],
      absences: [],
      messages: [],
      missingCreds: [],
      dateStats: {
        grades: {
          matched: 16,
          undated: 0,
          invalid: 0,
          outOfRange: 0,
          truncated: false,
        },
      },
    });
    expect(text).toContain("מקצוע0");
    expect(text).not.toContain("מקצוע15");
    expect(text).toContain("מגבלת תצוגה");
  });
});

describe("defaultMashovYear", () => {
  it("uses end-of-school-year convention", () => {
    expect(defaultMashovYear(new Date("2026-03-01T12:00:00+02:00"))).toBe(2026);
    expect(defaultMashovYear(new Date("2026-09-01T12:00:00+03:00"))).toBe(2027);
  });
});

describe("resolveMashovReply", () => {
  it("asks for missing filings without calling login", async () => {
    const fetchImpl = vi.fn();
    const reply = await resolveMashovReply({
      filings: [],
      child: "דניאל",
      aspects: ["grades"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(reply).toContain("חסר");
    expect(reply).toContain("שם בית ספר למשוב");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("explains auth failure clearly on HTTP 401", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const reply = await resolveMashovReply({
      filings: [
        { item_name: "תעודת זהות למשוב", item_info: "1" },
        { item_name: "סיסמת משוב", item_info: "badpass" },
        { item_name: "סמל בית ספר למשוב", item_info: "580001" },
        { item_name: "שנת לימודים למשוב", item_info: "2027" },
      ],
      child: "יואב",
      aspects: ["grades"],
      fetchImpl,
    });
    expect(reply).toContain("לא התקבלו");
  });

  it("asks to update filing when password is shorter than 6 chars (no login call)", async () => {
    const fetchImpl = vi.fn();
    const reply = await resolveMashovReply({
      filings: [
        { item_name: "תעודת זהות למשוב", item_info: "032228421" },
        { item_name: "סיסמת משוב של יואב", item_info: "S007" },
        { item_name: "סמל בית ספר למשוב", item_info: "580001" },
        { item_name: "שנת לימודים למשוב", item_info: "2026" },
      ],
      child: "יואב",
      aspects: ["grades"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(reply).toBe(MASHOV_PASSWORD_TOO_SHORT_HE);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps Mashov 400 password min-length to the short-password Hebrew", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      headers: { get: () => null },
      json: async () => ({
        errors: {
          password: [
            "The field Password must be a string or array type with a minimum length of '6'.",
          ],
        },
        title: "One or more validation errors occurred.",
      }),
    })) as unknown as typeof fetch;

    const reply = await resolveMashovReply({
      filings: [
        { item_name: "תעודת זהות למשוב", item_info: "032228421" },
        // Long enough to pass local pre-check; API still rejects.
        { item_name: "סיסמת משוב", item_info: "abcdef" },
        { item_name: "סמל בית ספר למשוב", item_info: "580001" },
        { item_name: "שנת לימודים למשוב", item_info: "2026" },
      ],
      child: "יואב",
      aspects: ["grades"],
      fetchImpl,
    });
    expect(reply).toBe(MASHOV_PASSWORD_TOO_SHORT_HE);
  });

  it("resolves school name via /schools then logs in", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/schools")) {
        return {
          ok: true,
          headers: { get: () => null },
          json: async () => [
            {
              semel: 580001,
              name: "שש שנתי רמון - פתח תקוה (חטב+חטע)",
              years: [2025, 2026, 2027],
            },
          ],
        } as unknown as Response;
      }
      if (href.endsWith("/login") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as {
          semel?: number;
          year?: number;
        };
        expect(body.semel).toBe(580001);
        expect(body.year).toBe(2026);
        return {
          ok: true,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "x-csrf-token" ? "csrf" : null,
            getSetCookie: () => [
              "MashovAuthToken=abc; Path=/",
              "Csrf-Token=csrf; Path=/",
            ],
          },
          json: async () => ({
            accessToken: {
              displayName: "הורה",
              children: [
                {
                  childGuid: "child-1",
                  privateName: "דניאל",
                  familyName: "כהן",
                },
              ],
            },
          }),
        } as unknown as Response;
      }
      if (href.includes("/grades")) {
        return {
          ok: true,
          headers: { get: () => null },
          json: async () => [
            {
              subjectName: "מתמטיקה",
              grade: "95",
              eventDate: "2026-10-10",
              gradingEvent: "מבחן",
            },
          ],
        } as unknown as Response;
      }
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => [],
      } as unknown as Response;
    });

    const reply = await resolveMashovReply({
      filings: [
        { item_name: "תעודת זהות למשוב", item_info: "03222842" },
        { item_name: "סיסמת משוב", item_info: "secret" },
        // Spoken spelling with vav; Mashov list uses תקוה without vav.
        { item_name: "שם בית ספר למשוב", item_info: "שש שנתי רמון פתח תקווה" },
        { item_name: "שנת לימודים למשוב", item_info: "2026" },
      ],
      child: "דניאל",
      aspects: ["grades"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(reply).toContain("מתמטיקה");
    expect(reply).toContain("95");
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("logs in and formats grades", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/login") && init?.method === "POST") {
        return {
          ok: true,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "x-csrf-token" ? "csrf" : null,
            getSetCookie: () => [
              "MashovAuthToken=abc; Path=/",
              "Csrf-Token=csrf; Path=/",
            ],
          },
          json: async () => ({
            accessToken: {
              displayName: "הורה",
              children: [
                {
                  childGuid: "child-1",
                  privateName: "דניאל",
                  familyName: "כהן",
                },
              ],
            },
          }),
        } as unknown as Response;
      }
      if (href.includes("/grades")) {
        return {
          ok: true,
          headers: { get: () => null },
          json: async () => [
            {
              subjectName: "היסטוריה",
              grade: "88",
              eventDate: "2026-10-10",
              gradingEvent: "מבחן",
            },
          ],
        } as unknown as Response;
      }
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => [],
      } as unknown as Response;
    });

    const reply = await resolveMashovReply({
      filings: [
        { item_name: "תעודת זהות למשוב", item_info: "03222842" },
        { item_name: "סיסמת משוב", item_info: "secret" },
        { item_name: "סמל בית ספר למשוב", item_info: "999" },
        { item_name: "שנת לימודים למשוב", item_info: "2026" },
      ],
      child: "דניאל",
      aspects: ["grades"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(reply).toContain("היסטוריה");
    expect(reply).toContain("88");
    expect(reply).not.toContain("secret");
  });

  it("returns invalid-bounds notice without calling Mashov", async () => {
    const fetchImpl = vi.fn();
    const reply = await resolveMashovReply({
      filings: [
        { item_name: "תעודת זהות למשוב", item_info: "03222842" },
        { item_name: "סיסמת משוב", item_info: "secret1" },
        { item_name: "סמל בית ספר למשוב", item_info: "999" },
        { item_name: "שנת לימודים למשוב", item_info: "2026" },
      ],
      child: "דניאל",
      aspects: ["grades"],
      dateFrom: "2025-02-29",
      dateTo: "2025-03-01",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(reply).toBe(MASHOV_INVALID_DATE_BOUNDS_HE);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("filters grades by date range, sorts newest-first, and discloses truncate", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/login") && init?.method === "POST") {
        return {
          ok: true,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "x-csrf-token" ? "csrf" : null,
            getSetCookie: () => [
              "MashovAuthToken=abc; Path=/",
              "Csrf-Token=csrf; Path=/",
            ],
          },
          json: async () => ({
            accessToken: {
              displayName: "הורה",
              children: [
                {
                  childGuid: "child-1",
                  privateName: "דניאל",
                  familyName: "כהן",
                },
              ],
            },
          }),
        } as unknown as Response;
      }
      if (href.includes("/grades")) {
        // 42 in-range + 1 out-of-range → normalize cap 40 → truncated
        const rows = Array.from({ length: 42 }, (_, i) => ({
          subjectName: `מקצוע${i}`,
          grade: String(60 + (i % 40)),
          eventDate: `2025-06-${String((i % 28) + 1).padStart(2, "0")}`,
          gradingEvent: "מבחן",
        }));
        rows.push({
          subjectName: "מחוץ",
          grade: "50",
          eventDate: "2024-12-01",
          gradingEvent: "מבחן",
        });
        return {
          ok: true,
          headers: { get: () => null },
          json: async () => rows,
        } as unknown as Response;
      }
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => [],
      } as unknown as Response;
    });

    const reply = await resolveMashovReply({
      filings: [
        { item_name: "תעודת זהות למשוב", item_info: "03222842" },
        { item_name: "סיסמת משוב", item_info: "secret1" },
        { item_name: "סמל בית ספר למשוב", item_info: "999" },
        { item_name: "שנת לימודים למשוב", item_info: "2026" },
      ],
      child: "דניאל",
      aspects: ["grades"],
      dateFrom: "2025-01-01",
      dateTo: "2025-12-31",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(reply).toContain("בטווח 2025-01-01–2025-12-31");
    expect(reply).toContain("מגבלת תצוגה");
    expect(reply).not.toContain("מחוץ");
    // Newest-first among displayed: day 28 before day 1 for same month pattern
    const firstBullet = reply
      .split("\n")
      .find((line) => line.startsWith("• "));
    expect(firstBullet).toBeTruthy();
  });
});

describe("isMashovPasswordTooShortError", () => {
  it("detects Mashov password min-length validation payload", () => {
    expect(
      isMashovPasswordTooShortError({
        errors: {
          password: [
            "The field Password must be a string or array type with a minimum length of '6'.",
          ],
        },
      }),
    ).toBe(true);
    expect(isMashovPasswordTooShortError({ errors: { username: ["x"] } })).toBe(
      false,
    );
  });
});
