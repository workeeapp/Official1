import { describe, expect, it, vi } from "vitest";
import {
  formatPlacesHebrew,
  parsePlacesAspects,
  resolvePlacesReply,
  type PlaceResult,
  type PlacesFacts,
} from "../src/services/places.js";

describe("parsePlacesAspects", () => {
  it("defaults to summary", () => {
    expect(parsePlacesAspects(undefined)).toEqual(["summary"]);
  });

  it("keeps known aspects", () => {
    expect(parsePlacesAspects(["phone", "address", "bogus"])).toEqual([
      "phone",
      "address",
    ]);
  });
});

describe("formatPlacesHebrew", () => {
  const base: PlaceResult = {
    name: "מקדונלדס קרית אונו",
    phone: "03-1234567",
    address: "רחוב הרצל 1, קרית אונו",
    postalCode: "55400",
    rating: 4.2,
    openNow: true,
    weekdayHours: ["יום ראשון: 08:00–23:00"],
    mapsUrl: "https://maps.google.com/?cid=1",
  };

  it("always includes מיקוד when present", () => {
    const facts: PlacesFacts = {
      query: "מקדונלדס",
      place: "קרית אונו",
      aspects: ["summary"],
      results: [base],
    };
    const text = formatPlacesHebrew(facts);
    expect(text).toContain("מקדונלדס");
    expect(text).toContain("טלפון: 03-1234567");
    expect(text).toContain("כתובת:");
    expect(text).toContain("מיקוד: 55400");
  });

  it("omits מיקוד line when postal is empty", () => {
    const text = formatPlacesHebrew({
      query: "חשמלאי",
      place: "פתח תקווה",
      aspects: ["summary"],
      results: [{ ...base, name: "חשמלאי כהן", postalCode: "" }],
    });
    expect(text).not.toContain("מיקוד:");
  });

  it("lists several results", () => {
    const text = formatPlacesHebrew({
      query: "חשמלאי",
      place: "פתח תקווה",
      aspects: ["summary"],
      results: [
        { ...base, name: "א'", postalCode: "49100" },
        { ...base, name: "ב'", postalCode: "49200" },
      ],
    });
    expect(text).toContain("2 תוצאות");
    expect(text).toContain("מיקוד: 49100");
    expect(text).toContain("מיקוד: 49200");
  });
});

describe("resolvePlacesReply", () => {
  it("asks when query or place is missing", async () => {
    await expect(
      resolvePlacesReply({ query: "", place: "תל אביב" }),
    ).resolves.toMatch(/מה לחפש/);
  });

  it("explains missing API key", async () => {
    const text = await resolvePlacesReply({
      query: "חשמלאי",
      place: "פתח תקווה",
      apiKey: "",
    });
    expect(text).toContain("לא מוגדר");
  });

  it("explains permission denied for Places API New", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        error: {
          code: 403,
          status: "PERMISSION_DENIED",
          message: "Places API (New) has not been used in project",
        },
      }),
    })) as unknown as typeof fetch;

    const text = await resolvePlacesReply({
      query: "קיסו",
      place: "קרית אונו",
      aspects: ["address"],
      apiKey: "test-key",
      fetchImpl,
    });
    expect(text).toContain("Places API New");
  });

  it("searches Places API New and formats including postal", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toContain("places.googleapis.com/v1/places:searchText");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers["X-Goog-Api-Key"]).toBe("test-key");
      expect(headers["X-Goog-FieldMask"]).toContain("places.formattedAddress");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        textQuery?: string;
        languageCode?: string;
        regionCode?: string;
      };
      expect(body.textQuery).toBe("מקדונלדס קרית אונו");
      expect(body.languageCode).toBe("he");
      expect(body.regionCode).toBe("IL");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          places: [
            {
              id: "places/abc",
              displayName: { text: "מקדונלדס קרית אונו", languageCode: "he" },
              nationalPhoneNumber: "03-9998888",
              formattedAddress: "רחוב 1, קרית אונו",
              addressComponents: [
                { longText: "55400", types: ["postal_code"] },
                { longText: "ישראל", types: ["country"] },
              ],
              rating: 4.1,
              currentOpeningHours: {
                openNow: true,
                weekdayDescriptions: ["יום ראשון: 08:00–23:00"],
              },
              googleMapsUri: "https://maps.google.com/?cid=1",
            },
          ],
        }),
      } as Response;
    });

    const text = await resolvePlacesReply({
      query: "מקדונלדס",
      place: "קרית אונו",
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("מקדונלדס קרית אונו");
    expect(text).toContain("03-9998888");
    expect(text).toContain("מיקוד: 55400");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns empty-results Hebrew when New API returns no places", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ places: [] }),
    })) as unknown as typeof fetch;

    const text = await resolvePlacesReply({
      query: "xyzzy",
      place: "נווה מדבר",
      apiKey: "test-key",
      fetchImpl,
    });
    expect(text).toContain("לא מצאתי תוצאות");
  });
});
