/**
 * Unified saved-location catalog across filings / lists / contacts (no NLP).
 */
import { describe, expect, it } from "vitest";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";
import {
  buildSavedLocationCatalog,
  matchSavedLocationReference,
} from "../src/services/geographic-saved-catalog.js";
import type { GeographicAsk } from "../src/services/geographic-match.js";
import type { GeographicProvider } from "../src/services/geographic-provider.js";
import { resolveGeographic } from "../src/services/geographic-resolve.js";
import {
  collectSavedPlacesWithoutCoords,
  looksLikeStreetOrPlaceAddress,
} from "../src/services/saved-route-location.js";

const ask = (rawText: string): GeographicAsk => ({
  rawText,
  role: "place",
});

const filing = (
  id: string,
  name: string,
  info: string,
): EmployeeRecordSnapshot["filing"][number] => ({
  filing_id: id,
  item_name: name,
  item_info: info,
  item_description: "",
  owner: "טל",
  scope: "personal",
});

describe("looksLikeStreetOrPlaceAddress", () => {
  it("accepts street+number; rejects bare notes", () => {
    expect(looksLikeStreetOrPlaceAddress("הרצל 5 רמת גן")).toBe(true);
    expect(looksLikeStreetOrPlaceAddress("רחוב דיזנגוף")).toBe(true);
    expect(looksLikeStreetOrPlaceAddress("בלי מיקום")).toBe(false);
    expect(looksLikeStreetOrPlaceAddress("32.08, 34.78")).toBe(false);
  });
});

describe("openMeteoAddressCityFallbacks", () => {
  it("yields trailing city tokens from a street address", async () => {
    const { openMeteoAddressCityFallbacks } = await import(
      "../src/services/providers/open-meteo-point.provider.js"
    );
    expect(openMeteoAddressCityFallbacks("הרצל 5 רמת גן")).toEqual([
      "רמת גן",
      "גן",
    ]);
  });
});

describe("collectSavedPlacesWithoutCoords — all sources", () => {
  it("filing nickname + street item_info (סבתא)", () => {
    const rows = collectSavedPlacesWithoutCoords({
      filing: [filing("f-g", "סבתא", "הרצל 5 רמת גן")],
      lists: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("סבתא");
    expect(rows[0]!.addressText).toBe("הרצל 5 רמת גן");
    expect(rows[0]!.listType).toBe("filings");
  });

  it("skips nickname filing whose item_info is not an address", () => {
    const rows = collectSavedPlacesWithoutCoords({
      filing: [filing("f-note", "סבתא", "אוהבת עוגות")],
      lists: [],
    });
    expect(rows).toEqual([]);
  });

  it("contact alias + description address", () => {
    const rows = collectSavedPlacesWithoutCoords(
      { filing: [], lists: [] },
      [{ id: "c-g", name: "סבתא", description: "הרצל 5 רמת גן" }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.listType).toBe("contacts");
    expect(rows[0]!.addressText).toBe("הרצל 5 רמת גן");
  });

  it("system-list (tasks) item alias + כתובת", () => {
    const rows = collectSavedPlacesWithoutCoords({
      filing: [],
      lists: [
        {
          list_type: "tasks",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "t-branch",
              "שם מטלה": "הסניף הצפוני",
              כתובת: "דרך השלום 1 חיפה",
            },
          ],
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("הסניף הצפוני");
    expect(rows[0]!.addressText).toBe("דרך השלום 1 חיפה");
    expect(rows[0]!.listType).toBe("tasks");
  });

  it("custom-list item alias + מקום", () => {
    const rows = collectSavedPlacesWithoutCoords({
      filing: [],
      lists: [
        {
          list_type: "custom",
          list_name: "משפחה",
          owner: "טל",
          scope: "personal",
          columns: ["שם", "מקום"],
          title_field: "שם",
          items: [
            {
              item_id: "c-g",
              שם: "סבתא",
              מקום: "הרצל 5 רמת גן",
            },
          ],
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("סבתא");
    expect(rows[0]!.addressText).toBe("הרצל 5 רמת גן");
    expect(rows[0]!.listType).toBe("custom");
  });

  it("missing address → not catalogued", () => {
    expect(
      collectSavedPlacesWithoutCoords({
        filing: [filing("f-x", "דירה בחיפה", "")],
        lists: [],
      }),
    ).toEqual([]);
  });

  it("ambiguous same alias across sources", () => {
    const catalog = buildSavedLocationCatalog(
      {
        filing: [filing("f-g", "סבתא", "הרצל 1 תל אביב")],
        lists: [],
      },
      [{ id: "c-g", name: "סבתא", description: "ביאליק 2 רמת גן" }],
    );
    expect(catalog.withoutCoords.length).toBe(2);
    const match = matchSavedLocationReference({
      ask: ask("סבתא"),
      snapshot: {
        filing: [filing("f-g", "סבתא", "הרצל 1 תל אביב")],
        lists: [],
      },
      contacts: [{ id: "c-g", name: "סבתא", description: "ביאליק 2 רמת גן" }],
    });
    expect(match.status).toBe("ambiguous");
  });

  it("two nickname filings same soft label → ambiguous", () => {
    const match = matchSavedLocationReference({
      ask: ask("בית"),
      snapshot: {
        filing: [
          filing("f1", "בית הורים", "הרצל 1 תל אביב"),
          filing("f2", "בית סבתא", "ביאליק 2 רמת גן"),
        ],
        lists: [],
      },
    });
    expect(match.status).toBe("ambiguous");
  });
});

describe("resolveGeographic — geocode alias vs address + savedRef", () => {
  it("geocodes addressText, keeps savedRef for filing nickname", async () => {
    const geocodeQueries: string[] = [];
    const provider: GeographicProvider = {
      id: "mock_om",
      provenance: "open_meteo",
      capabilities: { kinds: ["city"], geometries: ["point"] },
      resolve: async (a) => {
        geocodeQueries.push(a.rawText);
        return {
          kind: "city",
          labelHe: "רמת גן",
          confidence: "high",
          provenance: "open_meteo",
          point: { lat: 32.08, lng: 34.81 },
        };
      },
    };
    const match = await resolveGeographic({
      ask: ask("סבתא"),
      geometryNeeds: { point: true },
      snapshot: {
        filing: [filing("fil-grandma", "סבתא", "הרצל 5 רמת גן")],
        lists: [],
      },
      providers: [provider],
      geocodeSavedWithoutCoords: true,
    });
    expect(match.status).toBe("resolved");
    expect(match.kind).toBe("saved");
    expect(match.provenance).toBe("saved");
    expect(match.coordinateProvenance).toBe("open_meteo");
    expect(match.savedRef?.id).toBe("fil-grandma");
    expect(match.savedRef?.label).toBe("סבתא");
    expect(match.savedRef?.hadCoordsAtResolve).toBe(false);
    expect(match.labelHe).toBe("סבתא");
    expect(geocodeQueries).toEqual(["הרצל 5 רמת גן"]);
  });

  it("saved with coords: no geocode; coordinateProvenance=saved", async () => {
    const provider: GeographicProvider = {
      id: "mock_om",
      provenance: "open_meteo",
      capabilities: { kinds: ["city"], geometries: ["point"] },
      resolve: async () => {
        throw new Error("must not geocode");
      },
    };
    const match = await resolveGeographic({
      ask: ask("בית"),
      geometryNeeds: { point: true },
      snapshot: {
        filing: [filing("fil-home", "בית", "32.099279, 34.8923104")],
        lists: [],
      },
      providers: [provider],
      geocodeSavedWithoutCoords: true,
    });
    expect(match.status).toBe("resolved");
    expect(match.savedRef?.hadCoordsAtResolve).toBe(true);
    expect(match.coordinateProvenance).toBe("saved");
    expect(match.geometry?.point?.lat).toBeCloseTo(32.099279);
  });

  it("contact without coords: geocode description; savedRef source=contact", async () => {
    const queries: string[] = [];
    const provider: GeographicProvider = {
      id: "mock_om",
      provenance: "open_meteo",
      capabilities: { kinds: ["city"], geometries: ["point"] },
      resolve: async (a) => {
        queries.push(a.rawText);
        return {
          kind: "city",
          labelHe: "רמת גן",
          confidence: "high",
          provenance: "open_meteo",
          point: { lat: 32.08, lng: 34.81 },
        };
      },
    };
    const match = await resolveGeographic({
      ask: ask("סבתא"),
      geometryNeeds: { point: true },
      snapshot: { filing: [], lists: [] },
      contacts: [
        { id: "c-grandma", name: "סבתא", description: "הרצל 5 רמת גן" },
      ],
      providers: [provider],
      geocodeSavedWithoutCoords: true,
    });
    expect(match.savedRef?.source).toBe("contact");
    expect(match.savedRef?.id).toBe("c-grandma");
    expect(queries).toEqual(["הרצל 5 רמת גן"]);
  });
});
