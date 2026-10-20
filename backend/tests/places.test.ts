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

  it("searches then formats details including postal", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const href = String(url);
      if (href.includes("textsearch")) {
        return {
          ok: true,
          json: async () => ({
            status: "OK",
            results: [{ place_id: "pid-1", name: "מקדונלדס" }],
          }),
        } as Response;
      }
      if (href.includes("details")) {
        return {
          ok: true,
          json: async () => ({
            status: "OK",
            result: {
              name: "מקדונלדס קרית אונו",
              formatted_phone_number: "03-9998888",
              formatted_address: "רחוב 1, קרית אונו",
              address_components: [
                { long_name: "55400", types: ["postal_code"] },
                { long_name: "ישראל", types: ["country"] },
              ],
              rating: 4.1,
              opening_hours: { open_now: true },
              url: "https://maps.google.com/?cid=1",
            },
          }),
        } as Response;
      }
      throw new Error(`unexpected url ${href}`);
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
    expect(fetchImpl).toHaveBeenCalled();
  });
});
