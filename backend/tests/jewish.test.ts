import { describe, expect, it, vi } from "vitest";
import {
  filterHolidaysByQuery,
  formatJewishHebrew,
  jewishHolidayMatchScore,
  JEWISH_SPEAKER_MISSING_PIN_ASK,
  lookupIlGeonameid,
  nextCandleLighting,
  parseJewishAspects,
  resolveJewishPlaceInput,
  resolveJewishReply,
  shouldSkipLiveJewishForCandleReminders,
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
    expect(lookupIlGeonameid("ת״א")).toBe(293397);
    expect(lookupIlGeonameid("תא")).toBe(293397);
  });

  it("resolves Ramat Gan and Rishon LeZion aliases", () => {
    expect(lookupIlGeonameid("רמת גן")).toBe(293788);
    expect(lookupIlGeonameid("ראשון לציון")).toBe(293807);
    expect(lookupIlGeonameid("ראשון")).toBe(293807);
  });

  it("does not match short aliases as substrings of longer queries", () => {
    // Exact-only: containing «תא» / «ראשון» must not false-hit the city id.
    expect(lookupIlGeonameid("ראשון ברשימה שלי")).toBeNull();
    expect(lookupIlGeonameid("התאמה כללית")).toBeNull();
    expect(lookupIlGeonameid("רמת גן והסביבה")).toBeNull();
  });
});

describe("resolveJewishPlaceInput", () => {
  it("speaker + pin → lat/lng with Asia/Jerusalem (MVP Israel-only)", () => {
    const result = resolveJewishPlaceInput({
      place: "speaker",
      pending: {
        lat: 32.08,
        lng: 34.78,
        name: "",
        address: "",
        at: Date.now(),
      },
    });
    expect(result.kind).toBe("location");
    if (result.kind === "location") {
      expect(result.source).toBe("pin");
      expect(result.loc.latitude).toBeCloseTo(32.08);
      expect(result.loc.longitude).toBeCloseTo(34.78);
      expect(result.loc.tzid).toBe("Asia/Jerusalem");
      expect(result.loc.geonameid).toBeUndefined();
    }
  });

  it("speaker without pin asks", () => {
    expect(
      resolveJewishPlaceInput({ place: "speaker", pending: null }),
    ).toEqual({ kind: "ask", text: JEWISH_SPEAKER_MISSING_PIN_ASK });
  });

  it("saved coords hit skips named geocode path", () => {
    const result = resolveJewishPlaceInput({
      place: "מיקום הבית",
      snapshot: {
        filing: [
          {
            filing_id: "f-home",
            item_name: "מיקום הבית",
            item_info: "32.099279, 34.8923104",
            item_description: "",
            owner: "טל",
            scope: "personal",
          },
        ],
        lists: [],
      },
    });
    expect(result.kind).toBe("location");
    if (result.kind === "location") {
      expect(result.source).toBe("saved");
      expect(result.loc.latitude).toBeCloseTo(32.099279);
      expect(result.loc.longitude).toBeCloseTo(34.8923104);
      expect(result.loc.tzid).toBe("Asia/Jerusalem");
      expect(result.notice).toMatch(/מיקום הבית/);
    }
  });

  it("ambiguous saved places ask", () => {
    const result = resolveJewishPlaceInput({
      place: "בית",
      snapshot: {
        filing: [
          {
            filing_id: "f1",
            item_name: "בית תל אביב",
            item_info: "32.1, 34.8",
            item_description: "",
            owner: "טל",
            scope: "personal",
          },
          {
            filing_id: "f2",
            item_name: "בית חיפה",
            item_info: "32.8, 34.9",
            item_description: "",
            owner: "טל",
            scope: "personal",
          },
        ],
        lists: [],
      },
    });
    expect(result.kind).toBe("ask");
    if (result.kind === "ask") {
      expect(result.text).toMatch(/כמה מיקומים/);
    }
  });

  it("address-like filing without coords asks before named path", () => {
    const result = resolveJewishPlaceInput({
      place: "מיקום הבית",
      snapshot: {
        filing: [
          {
            filing_id: "f-home-no-coords",
            item_name: "מיקום הבית",
            item_info: "רחוב הרצל 1 פתח תקווה",
            item_description: "",
            owner: "טל",
            scope: "personal",
          },
        ],
        lists: [],
      },
    });
    expect(result.kind).toBe("ask");
    if (result.kind === "ask") {
      expect(result.text).toMatch(/אין קואורדינטות/);
    }
  });

  it("explicit city falls through as named", () => {
    expect(resolveJewishPlaceInput({ place: "רמת גן" })).toEqual({
      kind: "named",
      place: "רמת גן",
    });
  });
});

describe("shouldSkipLiveJewishForCandleReminders", () => {
  it("suppresses when jewish_candles add/update is on the same turn", () => {
    expect(
      shouldSkipLiveJewishForCandleReminders([
        { scheduleAnchor: "jewish_candles", action: "add" },
      ]),
    ).toBe(true);
    expect(
      shouldSkipLiveJewishForCandleReminders([
        { scheduleAnchor: "jewish_candles", action: "update" },
      ]),
    ).toBe(true);
  });

  it("does not suppress for cancel or unrelated reminders", () => {
    expect(
      shouldSkipLiveJewishForCandleReminders([
        { scheduleAnchor: "jewish_candles", action: "cancel" },
      ]),
    ).toBe(false);
    expect(
      shouldSkipLiveJewishForCandleReminders([
        { scheduleAnchor: "", action: "add" },
      ]),
    ).toBe(false);
    expect(shouldSkipLiveJewishForCandleReminders([])).toBe(false);
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
    const { text, lastLive } = await resolveJewishReply({
      place: "",
      aspects: ["candles"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toMatch(/באיזה יישוב/);
    expect(lastLive).toBeNull();
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

    const { text, lastLive } = await resolveJewishReply({
      place: "",
      aspects: ["holidays"],
      query: "ערב פסח",
      now: new Date("2026-10-24T12:00:00+03:00"),
      fetchImpl,
    });
    expect(text).toContain("ערב פסח");
    expect(text).toContain("21.04.2027");
    expect(text).not.toContain("סיגד");
    // Empty place → Jerusalem default path: never pack LAST_LIVE.
    expect(lastLive).toBeNull();
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

    const { text, lastLive } = await resolveJewishReply({
      place: "פתח תקווה",
      aspects: ["summary"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("17:39");
    expect(text).toContain("18:35");
    expect(text).toContain("לֶךְ־לְךָ");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(lastLive).toEqual({
      label: "פתח תקווה",
      lat: null,
      lng: null,
      kind: "soft_place_text",
      usedPendingPin: false,
    });
  });

  it("Ramat Gan uses geonameid (named path unchanged)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const href = String(url);
      expect(href).toContain("geonameid=293788");
      expect(href).not.toContain("latitude=");
      return {
        ok: true,
        json: async () => ({
          location: { title: "Ramat Gan, Israel", geonameid: 293788 },
          items: [
            {
              category: "havdalah",
              title: "Havdalah: 6:40pm",
              hebrew: "הַבְדָּלָה: 18:40",
              date: "2026-10-24T18:40:00+03:00",
            },
          ],
        }),
      } as Response;
    });
    const { text, lastLive } = await resolveJewishReply({
      place: "רמת גן",
      aspects: ["havdalah"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("18:40");
    expect(lastLive?.label).toBe("רמת גן");
    expect(lastLive?.kind).toBe("soft_place_text");
  });

  it("speaker + pending pin calls Hebcal with lat/lng + tzid", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const href = String(url);
      expect(href).toContain("hebcal.com/shabbat");
      expect(href).toContain("latitude=32.08");
      expect(href).toContain("longitude=34.78");
      expect(href).toContain("tzid=Asia%2FJerusalem");
      expect(href).not.toContain("geonameid=");
      return {
        ok: true,
        json: async () => ({
          location: { title: "Tel Aviv" },
          items: [
            {
              category: "candles",
              title: "Candle lighting: 5:30pm",
              hebrew: "הַדְלָקַת נֵרוֹת: 17:30",
              date: "2026-10-23T17:30:00+03:00",
            },
          ],
        }),
      } as Response;
    });
    const { text, lastLive } = await resolveJewishReply({
      place: "speaker",
      aspects: ["candles"],
      pending: {
        lat: 32.08,
        lng: 34.78,
        name: "",
        address: "",
        at: Date.now(),
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("17:30");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(lastLive).toMatchObject({
      kind: "pin",
      lat: 32.08,
      lng: 34.78,
      usedPendingPin: true,
    });
  });

  it("speaker without pin returns ask and does not fetch", async () => {
    const fetchImpl = vi.fn();
    const { text, lastLive } = await resolveJewishReply({
      place: "speaker",
      aspects: ["candles"],
      pending: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toBe(JEWISH_SPEAKER_MISSING_PIN_ASK);
    expect(lastLive).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("Hebcal failure does not pack LAST_LIVE", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("hebcal down");
    }) as unknown as typeof fetch;
    const { text, lastLive } = await resolveJewishReply({
      place: "פתח תקווה",
      aspects: ["candles"],
      fetchImpl,
    });
    expect(text).toMatch(/לא הצלחתי/);
    expect(lastLive).toBeNull();
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

    const { text, lastLive } = await resolveJewishReply({
      place: "",
      aspects: ["holidays"],
      now: new Date("2026-10-20T12:00:00Z"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("חֲנֻכָּה");
    expect(text).toContain("05.12.2026");
    expect(text).not.toContain(JEWISH_HOLIDAYS_LOCAL_TRUNCATION_HE);
    expect(text).not.toContain(JEWISH_HOLIDAYS_COLLECT_CAP_HE);
    expect(lastLive).toBeNull();
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

    const { text } = await resolveJewishReply({
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
