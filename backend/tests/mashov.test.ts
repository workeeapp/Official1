import { describe, expect, it, vi } from "vitest";
import {
  defaultMashovYear,
  formatMashovHebrew,
  loadMashovCredsFromFilings,
  matchMashovSchool,
  mashovSchoolMatchScore,
  normalizeGrades,
  parseMashovAspects,
  pickMashovChild,
  resolveMashovReply,
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

  it("requires year when school name is filed without semel", () => {
    const { missing, pendingSchool } = loadMashovCredsFromFilings([
      { item_name: "תעודת זהות למשוב", item_info: "1" },
      { item_name: "סיסמת משוב", item_info: "x" },
      { item_name: "שם בית ספר למשוב", item_info: "אחד העם" },
    ]);
    expect(pendingSchool).toBeUndefined();
    expect(missing).toContain("שנת לימודים למשוב");
  });
});

describe("matchMashovSchool", () => {
  const schools = [
    {
      semel: 100005,
      name: 'חט"ב אחד העם החדשה - פתח תקווה',
      years: [2024, 2025],
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
      missingCreds: [],
    });
    expect(text).toContain("מתמטיקה");
    expect(text).toContain("90");
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
        date: "2026-09-01T00:00:00",
        type: "בוחן",
      },
    ]);
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
    expect(fetchImpl).not.toHaveBeenCalled();
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
              semel: 4242,
              name: "אריאל שרון - פתח תקווה",
              years: [2025, 2026],
            },
          ],
        } as unknown as Response;
      }
      if (href.endsWith("/login") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as {
          semel?: number;
          year?: number;
        };
        expect(body.semel).toBe(4242);
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
        { item_name: "שם בית ספר למשוב", item_info: "אריאל שרון פתח תקווה" },
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
});
