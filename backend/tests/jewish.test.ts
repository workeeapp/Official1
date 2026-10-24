import { describe, expect, it, vi } from "vitest";
import {
  filterHolidaysByQuery,
  formatJewishHebrew,
  jewishHolidayMatchScore,
  lookupIlGeonameid,
  nextCandleLighting,
  parseJewishAspects,
  resolveJewishReply,
  stripHebrewNiqqud,
  JEWISH_HOLIDAYS_COLLECT_CAP,
  JEWISH_HOLIDAYS_COLLECT_CAP_HE,
  JEWISH_HOLIDAYS_DISPLAY_CAP,
  JEWISH_HOLIDAYS_LOCAL_TRUNCATION_HE,
  type JewishFacts,
  type JewishTimedItem,
} from "../src/services/jewish.js";

describe("parseJewishAspects", () => {
  it("defaults to summary", () => {
    expect(parseJewishAspects(undefined)).toEqual(["summary"]);
  });

  it("keeps known aspects", () => {
    expect(parseJewishAspects(["candles", "parasha", "bogus"])).toEqual([
      "candles",
      "parasha",
    ]);
  });
});

describe("holiday name match", () => {
  it("strips niqqud and scores ערב פסח", () => {
    expect(stripHebrewNiqqud("עֶרֶב פֶּסַח")).toContain("ערב");
    expect(jewishHolidayMatchScore("עֶרֶב פֶּסַח", "ערב פסח")).toBeGreaterThan(
      80,
    );
    // «פסח א׳» alone is not «ערב פסח» — require both tokens.
    expect(jewishHolidayMatchScore("פֶּסַח א׳", "ערב פסח")).toBe(0);
    expect(jewishHolidayMatchScore("חנוכה", "ערב פסח")).toBe(0);
  });

  it("filters and prefers better title matches", () => {
    const rows: JewishTimedItem[] = [
      {
        category: "holiday",
        title: "פֶּסַח א׳",
        dateIso: "2027-04-22",
        clock: "",
      },
      {
        category: "holiday",
        title: "עֶרֶב פֶּסַח",
        dateIso: "2027-04-21",
        clock: "",
      },
      {
        category: "holiday",
        title: "פּוּרִים",
        dateIso: "2027-03-23",
        clock: "",
      },
    ];
    const filtered = filterHolidaysByQuery(rows, "ערב פסח");
    expect(filtered[0]?.title).toContain("פ");
    expect(stripHebrewNiqqud(filtered[0]!.title)).toContain("ערב");
    expect(filtered.every((h) => jewishHolidayMatchScore(h.title, "ערב פסח") > 0)).toBe(
      true,
    );
  });
});

describe("lookupIlGeonameid", () => {
  it("resolves Petah Tikva spelling variants", () => {
    expect(lookupIlGeonameid("פתח תקווה")).toBe(293918);
    expect(lookupIlGeonameid("פתח תקוה")).toBe(293918);
  });

  it("resolves Tel Aviv", () => {
    expect(lookupIlGeonameid("תל אביב")).toBe(293397);
  });
});

describe("formatJewishHebrew", () => {
  const base: JewishFacts = {
    placeLabel: "פתח תקווה",
    aspects: ["summary"],
    candles: {
      category: "candles",
      title: "הדלקת נרות: 17:39",
      dateIso: "2026-10-23T17:39:00+03:00",
      clock: "17:39",
    },
    havdalah: {
      category: "havdalah",
      title: "הבדלה: 18:35",
      dateIso: "2026-10-24T18:35:00+03:00",
      clock: "18:35",
    },
    parasha: {
      category: "parashat",
      title: "פָּרָשַׁת לֶךְ־לְךָ",
      dateIso: "2026-10-24",
      clock: "",
    },
    holidays: [],
    missingPlace: false,
  };

  it("formats summary with candles havdalah and parasha", () => {
    const text = formatJewishHebrew(base);
    expect(text).toContain("הדלקת נרות בפתח תקווה: 17:39");
    expect(text).toContain("יציאת שבת / הבדלה בפתח תקווה: 18:35");
    expect(text).toContain("פרשת השבוע:");
    expect(text).toContain("לֶךְ־לְךָ");
  });

  it("asks for place when missing", () => {
    expect(
      formatJewishHebrew({
        ...base,
        placeLabel: "",
        missingPlace: true,
        candles: null,
        havdalah: null,
        parasha: null,
      }),
    ).toMatch(/באיזה יישוב/);
  });

  it("lists upcoming holidays", () => {
    const text = formatJewishHebrew({
      ...base,
      aspects: ["holidays"],
      candles: null,
      havdalah: null,
      parasha: null,
      holidays: [
        {
          category: "holiday",
          title: "חֲנֻכָּה",
          dateIso: "2026-12-05",
          clock: "",
        },
      ],
    });
    expect(text).toContain("חגים קרובים");
    expect(text).toContain("חֲנֻכָּה");
    expect(text).toContain("05.12.2026");
    expect(text).not.toContain(JEWISH_HOLIDAYS_LOCAL_TRUNCATION_HE);
    expect(text).not.toContain(JEWISH_HOLIDAYS_COLLECT_CAP_HE);
  });

  it("discloses local display truncation when holidays exceed display cap", () => {
    const holidays: JewishTimedItem[] = Array.from(
      { length: JEWISH_HOLIDAYS_DISPLAY_CAP + 2 },
      (_, i) => ({
        category: "holiday" as const,
        title: `חג ${i + 1}`,
        dateIso: `2026-11-${String(i + 1).padStart(2, "0")}`,
        clock: "",
      }),
    );
    const text = formatJewishHebrew({
      ...base,
      aspects: ["holidays"],
      candles: null,
      havdalah: null,
      parasha: null,
      holidays,
      holidaysDisplayTruncated: true,
    });
    expect(text).toContain("חג 1");
    expect(text).toContain(`חג ${JEWISH_HOLIDAYS_DISPLAY_CAP}`);
    expect(text).not.toContain(`חג ${JEWISH_HOLIDAYS_DISPLAY_CAP + 1}`);
    expect(text).toContain(JEWISH_HOLIDAYS_LOCAL_TRUNCATION_HE);
    expect(text).not.toContain(JEWISH_HOLIDAYS_COLLECT_CAP_HE);
  });

  it("discloses collect-cap saturation as potential incompleteness only", () => {
    const holidays: JewishTimedItem[] = Array.from(
      { length: JEWISH_HOLIDAYS_COLLECT_CAP },
      (_, i) => ({
        category: "holiday" as const,
        title: `חג ${i + 1}`,
        dateIso: `2026-11-${String(i + 1).padStart(2, "0")}`,
        clock: "",
      }),
    );
    const text = formatJewishHebrew({
      ...base,
      aspects: ["holidays"],
      candles: null,
      havdalah: null,
      parasha: null,
      holidays,
      holidaysDisplayTruncated: true,
      holidaysCollectCapped: true,
    });
    expect(text).toContain(JEWISH_HOLIDAYS_LOCAL_TRUNCATION_HE);
    expect(text).toContain(JEWISH_HOLIDAYS_COLLECT_CAP_HE);
  });

  it("omits holiday completeness notes for small unsaturated lists", () => {
    const text = formatJewishHebrew({
      ...base,
      aspects: ["holidays"],
      candles: null,
      havdalah: null,
      parasha: null,
      holidays: [
        {
          category: "holiday",
          title: "פּוּרִים",
          dateIso: "2027-03-14",
          clock: "",
        },
      ],
      holidaysDisplayTruncated: false,
      holidaysCollectCapped: false,
    });
    expect(text).toContain("פּוּרִים");
    expect(text).not.toContain("מגבלת תצוגה");
    expect(text).not.toContain("מגבלת האיסוף");
  });
});

describe("nextCandleLighting", () => {
  it("returns candles minus offset when still upcoming", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        location: { title: "Petaẖ Tiqva", geonameid: 293918 },
        items: [
          {
            category: "candles",
            date: "2026-10-23T17:39:00+03:00",
            hebrew: "הדלקת נרות",
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const fireAt = await nextCandleLighting({
      place: "פתח תקווה",
      offsetMinutes: -10,
      from: new Date("2026-10-20T12:00:00+03:00"),
      fetchImpl,
    });
    expect(fireAt?.toISOString()).toBe(
      new Date("2026-10-23T17:29:00+03:00").toISOString(),
    );
  });

  it("returns null without place", async () => {
    expect(await nextCandleLighting({ place: "" })).toBeNull();
  });
});

describe("resolveJewishReply", () => {
  it("asks for place on candles without city", async () => {
    const fetchImpl = vi.fn();
    const text = await resolveJewishReply({
      place: "",
      aspects: ["candles"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toMatch(/באיזה יישוב/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("filters named holiday query beyond short upcoming noise", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const href = String(url);
      if (href.includes("hebcal.com/hebcal")) {
        expect(href).toContain("start=");
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                category: "holiday",
                title: "חג הסיגד",
                date: "2026-11-09",
              },
              {
                category: "holiday",
                title: "עֶרֶב פֶּסַח",
                date: "2027-04-21",
              },
              {
                category: "holiday",
                title: "פֶּסַח א׳",
                date: "2027-04-22",
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ results: [] }) };
    }) as unknown as typeof fetch;

    const text = await resolveJewishReply({
      place: "",
      aspects: ["holidays"],
      query: "ערב פסח",
      now: new Date("2026-10-24T12:00:00+03:00"),
      fetchImpl,
    });
    expect(text).toContain("ערב פסח");
    expect(text).toContain("21.04.2027");
    expect(text).not.toContain("סיגד");
  });

  it("formats Shabbat from mocked Hebcal", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const href = String(url);
      expect(href).toContain("hebcal.com/shabbat");
      expect(href).toContain("geonameid=293918");
      expect(href).toContain("i=on");
      return {
        ok: true,
        json: async () => ({
          location: { title: "Petaẖ Tiqva, Israel", geonameid: 293918 },
          items: [
            {
              category: "candles",
              title: "Candle lighting: 5:39pm",
              hebrew: "הַדְלָקַת נֵרוֹת: 17:39",
              date: "2026-10-23T17:39:00+03:00",
            },
            {
              category: "parashat",
              title: "Parashat Lech-Lecha",
              hebrew: "פָּרָשַׁת לֶךְ־לְךָ",
              date: "2026-10-24",
            },
            {
              category: "havdalah",
              title: "Havdalah: 6:35pm",
              hebrew: "הַבְדָּלָה: 18:35",
              date: "2026-10-24T18:35:00+03:00",
            },
          ],
        }),
      } as Response;
    });

    const text = await resolveJewishReply({
      place: "פתח תקווה",
      aspects: ["summary"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("17:39");
    expect(text).toContain("18:35");
    expect(text).toContain("לֶךְ־לְךָ");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fetches holidays from /hebcal", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const href = String(url);
      expect(href).toContain("hebcal.com/hebcal");
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              category: "holiday",
              title: "Hanukkah",
              hebrew: "חֲנֻכָּה",
              date: "2026-12-05",
            },
            {
              category: "candles",
              title: "skip",
              date: "2026-12-04T16:00:00+02:00",
            },
          ],
        }),
      } as Response;
    });

    const text = await resolveJewishReply({
      place: "",
      aspects: ["holidays"],
      now: new Date("2026-10-20T12:00:00Z"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("חֲנֻכָּה");
    expect(text).toContain("05.12.2026");
    expect(text).not.toContain(JEWISH_HOLIDAYS_LOCAL_TRUNCATION_HE);
    expect(text).not.toContain(JEWISH_HOLIDAYS_COLLECT_CAP_HE);
  });

  it("resolve: discloses display trunc + collect cap when Hebcal returns many holidays", async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      category: "holiday",
      title: `Holiday ${i + 1}`,
      hebrew: `חג ${i + 1}`,
      date: `2026-11-${String(i + 1).padStart(2, "0")}`,
    }));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ items }),
    })) as unknown as typeof fetch;

    const text = await resolveJewishReply({
      place: "",
      aspects: ["holidays"],
      now: new Date("2026-10-20T12:00:00Z"),
      fetchImpl,
    });
    expect(text).toContain("חג 1");
    expect(text).toContain(`חג ${JEWISH_HOLIDAYS_DISPLAY_CAP}`);
    expect(text).not.toContain(`חג ${JEWISH_HOLIDAYS_DISPLAY_CAP + 1}`);
    expect(text).toContain(JEWISH_HOLIDAYS_LOCAL_TRUNCATION_HE);
    expect(text).toContain(JEWISH_HOLIDAYS_COLLECT_CAP_HE);
  });
});
