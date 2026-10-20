import { describe, expect, it, vi } from "vitest";
import {
  formatJewishHebrew,
  lookupIlGeonameid,
  nextCandleLighting,
  parseJewishAspects,
  resolveJewishReply,
  type JewishFacts,
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
  });
});
