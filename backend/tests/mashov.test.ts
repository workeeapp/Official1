import { describe, expect, it, vi } from "vitest";
import {
  defaultMashovYear,
  formatMashovHebrew,
  loadMashovCredsFromFilings,
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
    expect(missing).toContain("סמל בית ספר למשוב");
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
