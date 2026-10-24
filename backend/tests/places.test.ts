import { describe, expect, it, vi } from "vitest";
import {
  normalizePlacesIncludedType,
  normalizePlacesIntent,
  normalizePlacesMinRating,
  normalizePlacesOpenNow,
  normalizePlacesRadiusMeters,
  placesMinRatingProviderFloor,
  PLACES_PARKING_INCLUDED_TYPE,
} from "@workee/shared";
import {
  buildPlacesFieldMask,
  formatPlacesFilterSummary,
  formatPlacesHebrew,
  parsePlacesAspects,
  fetchPlacesFacts,
  placesRequestMaxResults,
  placesUnfilteredMaxResults,
  resolvePlacesReply,
  PLACES_ASPECT_BILLING_NOTES,
  PLACES_BASE_FIELD_MASK,
  PLACES_DEFAULT_BIAS_RADIUS_METERS,
  PLACES_FILTERED_PAGE_SIZE,
  PLACES_FILTERED_SATURATED_EMPTY_HE,
  PLACES_FILTERED_SATURATED_SPARSE_HE,
  PLACES_MIN_RATING_UNKNOWN_DROPPED_HE,
  PLACES_PARKING_COST_UNKNOWN_DROPPED_HE,
  PLACES_PARKING_OWNERSHIP_UNKNOWN_HE,
  PLACES_PROVIDER_PARTIAL_HE,
  type PlaceResult,
  type PlacesFacts,
} from "../src/services/places.js";

const noFilters = {
  intent: "business" as const,
  openNowFilter: null as boolean | null,
  minRating: null as number | null,
  includedType: null as PlacesFacts["includedType"],
  radiusMeters: null as number | null,
  parkingCost: null as PlacesFacts["parkingCost"],
};

describe("parsePlacesAspects", () => {
  it("defaults to summary", () => {
    expect(parsePlacesAspects(undefined)).toEqual(["summary"]);
  });

  it("keeps known aspects including Phase C attributes", () => {
    expect(parsePlacesAspects(["phone", "address", "bogus"])).toEqual([
      "phone",
      "address",
    ]);
    expect(
      parsePlacesAspects([
        "parking",
        "accessibility",
        "outdoor",
        "children",
        "payment",
        "bogus",
      ]),
    ).toEqual([
      "parking",
      "accessibility",
      "outdoor",
      "children",
      "payment",
    ]);
  });
});

describe("buildPlacesFieldMask (Phase C)", () => {
  it("keeps summary FieldMask as base only (no Atmosphere fields)", () => {
    const mask = buildPlacesFieldMask(["summary"]);
    expect(mask).toBe(PLACES_BASE_FIELD_MASK.join(","));
    expect(mask).not.toContain("parkingOptions");
    expect(mask).not.toContain("accessibilityOptions");
    expect(mask).not.toContain("outdoorSeating");
    expect(mask).not.toContain("goodForChildren");
    expect(mask).not.toContain("paymentOptions");
  });

  it("adds attribute FieldMask fields only when that aspect is requested", () => {
    expect(buildPlacesFieldMask(["parking"])).toContain("places.parkingOptions");
    expect(buildPlacesFieldMask(["parking"])).not.toContain(
      "places.paymentOptions",
    );
    expect(buildPlacesFieldMask(["accessibility"])).toContain(
      "places.accessibilityOptions",
    );
    expect(buildPlacesFieldMask(["outdoor"])).toContain("places.outdoorSeating");
    expect(buildPlacesFieldMask(["children"])).toContain(
      "places.goodForChildren",
    );
    expect(buildPlacesFieldMask(["payment"])).toContain("places.paymentOptions");
    const all = buildPlacesFieldMask([
      "parking",
      "accessibility",
      "outdoor",
      "children",
      "payment",
    ]);
    expect(all).toContain("places.parkingOptions");
    expect(all).toContain("places.accessibilityOptions");
    expect(all).toContain("places.outdoorSeating");
    expect(all).toContain("places.goodForChildren");
    expect(all).toContain("places.paymentOptions");
    expect(PLACES_ASPECT_BILLING_NOTES.parking).toContain("Atmosphere");
    expect(PLACES_ASPECT_BILLING_NOTES.summary).toContain("Enterprise");
  });

  it("parking intent requests parkingOptions without changing summary base mask", () => {
    const businessSummary = buildPlacesFieldMask(["summary"], "business");
    expect(businessSummary).toBe(PLACES_BASE_FIELD_MASK.join(","));
    const parkingIntent = buildPlacesFieldMask(["summary"], "parking");
    expect(parkingIntent).toContain("places.parkingOptions");
    for (const field of PLACES_BASE_FIELD_MASK) {
      expect(parkingIntent).toContain(field);
    }
    expect(parkingIntent).not.toContain("places.paymentOptions");
    expect(PLACES_ASPECT_BILLING_NOTES.parking_intent).toContain("Atmosphere");
  });
});

describe("places intent (Phase D)", () => {
  it("normalizes intent aliases; default business", () => {
    expect(normalizePlacesIntent(undefined)).toBe("business");
    expect(normalizePlacesIntent("business")).toBe("business");
    expect(normalizePlacesIntent("parking")).toBe("parking");
    expect(normalizePlacesIntent("חניה")).toBe("parking");
    expect(normalizePlacesIntent("חניון")).toBe("parking");
    expect(normalizePlacesIntent("bogus")).toBe("business");
    expect(PLACES_PARKING_INCLUDED_TYPE).toBe("parking");
  });
});

describe("places parking intent prompt/schema routing (offline)", () => {
  it("ACTION schema and prompts teach parking vs business Hebrew asks", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const root = resolve(import.meta.dirname, "../..");
    const actionJson = await readFile(
      resolve(root, "LLM.action.json"),
      "utf8",
    );
    const configJson = await readFile(
      resolve(root, "LLM.config.json"),
      "utf8",
    );
    const chatService = await readFile(
      resolve(root, "backend/src/services/chat.service.ts"),
      "utf8",
    );

    const parkingPhrases = [
      "איפה יש חניון ליד הקניון?",
      "תמצא לי חניה קרובה",
      "איפה אפשר להחנות ליד המסעדה?",
      "יש חניון בתשלום באזור?",
    ];
    for (const phrase of parkingPhrases) {
      expect(actionJson, `schema missing ${phrase}`).toContain(phrase);
      expect(configJson, `config missing ${phrase}`).toContain(phrase);
      expect(chatService, `chat extras missing ${phrase}`).toContain(phrase);
    }
    expect(actionJson).toContain("תמצא לי מסעדה ליד הקניון");
    expect(configJson).toContain("תמצא לי מסעדה ליד הקניון");
    expect(chatService).toContain("תמצא לי מסעדה ליד הקניון");
    expect(actionJson).toContain("intent=parking");
    expect(actionJson).toContain('"parking"');
    // Schema distinguishes attribute-of-business from parking-place search.
    expect(actionJson).toContain("aspects [parking]");
    expect(chatService).toContain('intent:\\"parking\\"');
  });
});

describe("places filter normalizers", () => {
  it("keeps exact minRating; provider floor is conservative 0.5 step", () => {
    expect(normalizePlacesMinRating(4)).toBe(4);
    expect(normalizePlacesMinRating(4.1)).toBe(4.1);
    expect(normalizePlacesMinRating(4.4)).toBe(4.4);
    expect(normalizePlacesMinRating(4.5)).toBe(4.5);
    expect(normalizePlacesMinRating(0.6)).toBe(0.6);
    expect(normalizePlacesMinRating(5)).toBe(5);
    expect(normalizePlacesMinRating(9)).toBeNull();
    expect(normalizePlacesMinRating(-1)).toBeNull();
    expect(normalizePlacesMinRating("abo")).toBeNull();
    expect(placesMinRatingProviderFloor(4.1)).toBe(4);
    expect(placesMinRatingProviderFloor(4.4)).toBe(4);
    expect(placesMinRatingProviderFloor(4.5)).toBe(4.5);
    expect(placesMinRatingProviderFloor(4)).toBe(4);
    expect(placesMinRatingProviderFloor(0.6)).toBe(0.5);
  });

  it("allowlists included_type and rejects others", () => {
    expect(normalizePlacesIncludedType("restaurant")).toBe("restaurant");
    expect(normalizePlacesIncludedType("HAIR-CARE")).toBe("hair_care");
    expect(normalizePlacesIncludedType("gas_station")).toBeNull();
    expect(normalizePlacesIncludedType("")).toBeNull();
  });

  it("clamps radius_meters and treats open_now true-only", () => {
    expect(normalizePlacesRadiusMeters(100)).toBe(200);
    expect(normalizePlacesRadiusMeters(2000)).toBe(2000);
    expect(normalizePlacesRadiusMeters(99_000)).toBe(50_000);
    expect(normalizePlacesRadiusMeters(0)).toBeNull();
    expect(normalizePlacesOpenNow(true)).toBe(true);
    expect(normalizePlacesOpenNow(false)).toBeNull();
    expect(normalizePlacesOpenNow(null)).toBeNull();
  });
});

describe("formatPlacesHebrew", () => {
  const base: PlaceResult = {
    id: "place-mcdonalds",
    name: "מקדונלדס קרית אונו",
    phone: "03-1234567",
    address: "רחוב הרצל 1, קרית אונו",
    postalCode: "55400",
    rating: 4.2,
    openNow: true,
    weekdayHours: ["יום ראשון: 08:00–23:00"],
    mapsUrl: "https://maps.google.com/?cid=1",
    parking: null,
    accessibility: null,
    outdoorSeating: null,
    goodForChildren: null,
    payment: null,
  };

  it("always includes מיקוד when present", () => {
    const facts: PlacesFacts = {
      query: "מקדונלדס",
      place: "קרית אונו",
      nearSpeaker: false,
      aspects: ["summary"],
      ...noFilters,
      results: [base],
    };
    const text = formatPlacesHebrew(facts);
    expect(text).toContain("מקדונלדס");
    expect(text).toContain("טלפון: 03-1234567");
    expect(text).toContain("כתובת:");
    expect(text).toContain("מיקוד: 55400");
    expect(text).not.toContain("סינון:");
  });

  it("omits מיקוד line when postal is empty", () => {
    const text = formatPlacesHebrew({
      query: "חשמלאי",
      place: "פתח תקווה",
      nearSpeaker: false,
      aspects: ["summary"],
      ...noFilters,
      results: [{ ...base, name: "חשמלאי כהן", postalCode: "" }],
    });
    expect(text).not.toContain("מיקוד:");
  });

  it("lists several results", () => {
    const text = formatPlacesHebrew({
      query: "חשמלאי",
      place: "פתח תקווה",
      nearSpeaker: false,
      aspects: ["summary"],
      ...noFilters,
      results: [
        { ...base, name: "א'", postalCode: "49100" },
        { ...base, name: "ב'", postalCode: "49200" },
      ],
    });
    expect(text).toContain("2 תוצאות");
    expect(text).toContain("מיקוד: 49100");
    expect(text).toContain("מיקוד: 49200");
  });

  it("discloses provider page saturation as potential incompleteness only", () => {
    const text = formatPlacesHebrew({
      query: "חשמלאי",
      place: "פתח תקווה",
      nearSpeaker: false,
      aspects: ["summary"],
      ...noFilters,
      results: [
        { ...base, name: "א'" },
        { ...base, name: "ב'" },
      ],
      providerPartial: true,
    });
    expect(text).toContain("2 תוצאות");
    expect(text).toContain(PLACES_PROVIDER_PARTIAL_HE);
  });

  it("omits incompleteness note for unsaturated small result sets", () => {
    const text = formatPlacesHebrew({
      query: "חשמלאי",
      place: "פתח תקווה",
      nearSpeaker: false,
      aspects: ["summary"],
      ...noFilters,
      results: [{ ...base, name: "א'" }, { ...base, name: "ב'" }],
      providerPartial: false,
    });
    expect(text).toContain("2 תוצאות");
    expect(text).not.toContain(PLACES_PROVIDER_PARTIAL_HE);
    expect(text).not.toContain("ייתכן שהרשימה חלקית");
  });

  it("summarizes combined filters without claiming a hard radius fence", () => {
    const facts: PlacesFacts = {
      query: "מסעדות",
      place: "האזור שלך",
      nearSpeaker: true,
      aspects: ["summary"],
      intent: "business",
      openNowFilter: true,
      minRating: 4,
      includedType: "restaurant",
      radiusMeters: 2000,
      results: [base, { ...base, name: "ב'" }],
    };
    const summary = formatPlacesFilterSummary(facts);
    expect(summary).toContain("פתוח עכשיו");
    expect(summary).toContain("דירוג ≥ 4");
    expect(summary).toContain("מסעדה");
    expect(summary).toContain("העדפת קרבה עד כ־2000 מ׳");
    expect(summary).toContain("לא סינון גבול קשיח");
    const text = formatPlacesHebrew(facts);
    expect(text).toContain("סינון:");
    expect(text).toContain("2 תוצאות");
    expect(text).not.toMatch(/בתוך\s*2000/);
  });

  it("empty under filters mentions filters without incompleteness when unsaturated", () => {
    const empty = formatPlacesHebrew({
      query: "מסעדות",
      place: "תל אביב",
      nearSpeaker: false,
      aspects: ["summary"],
      intent: "business",
      openNowFilter: true,
      minRating: 4.5,
      includedType: "restaurant",
      radiusMeters: null,
      results: [],
    });
    expect(empty).toContain("לא מצאתי תוצאות");
    expect(empty).toContain("פתוח עכשיו");
    expect(empty).not.toContain(PLACES_PROVIDER_PARTIAL_HE);
    expect(empty).not.toContain(PLACES_FILTERED_SATURATED_EMPTY_HE);
  });

  it("saturated filtered empty never claims no matching places exist", () => {
    const emptyPartial = formatPlacesHebrew({
      query: "מסעדות",
      place: "תל אביב",
      nearSpeaker: false,
      aspects: ["summary"],
      intent: "business",
      openNowFilter: true,
      minRating: null,
      includedType: "restaurant",
      radiusMeters: null,
      results: [],
      providerPartial: true,
      requestedMax: 20,
    });
    expect(emptyPartial).toContain("לא הוצגו תוצאות מתאימות בדף החיפוש");
    expect(emptyPartial).not.toContain("לא מצאתי תוצאות");
    expect(emptyPartial).toContain(PLACES_FILTERED_SATURATED_EMPTY_HE);
    // Cautious: incompleteness, not a definitive "there are none".
    expect(emptyPartial).toContain("אי אפשר לקבוע שאין מקומות תואמים");
  });

  it("saturated filtered sparse set uses cautious sparse note", () => {
    const text = formatPlacesHebrew({
      query: "מסעדות",
      place: "תל אביב",
      nearSpeaker: false,
      aspects: ["summary"],
      intent: "business",
      openNowFilter: true,
      minRating: 4,
      includedType: null,
      radiusMeters: null,
      results: [base],
      providerPartial: true,
      requestedMax: 20,
    });
    expect(text).toContain("מקדונלדס");
    expect(text).toContain(PLACES_FILTERED_SATURATED_SPARSE_HE);
    expect(text).not.toContain(PLACES_PROVIDER_PARTIAL_HE);
  });

  it("formats attribute aspects as true/false/unknown — never invents no", () => {
    const withAttrs: PlaceResult = {
      ...base,
      parking: {
        freeLot: true,
        paidLot: false,
        freeStreet: null,
        paidStreet: null,
        valet: null,
        freeGarage: null,
        paidGarage: null,
      },
      accessibility: {
        wheelchairParking: null,
        wheelchairEntrance: true,
        wheelchairRestroom: false,
        wheelchairSeating: null,
      },
      outdoorSeating: true,
      goodForChildren: null,
      payment: {
        creditCards: true,
        debitCards: null,
        cashOnly: false,
        nfc: null,
      },
    };
    const text = formatPlacesHebrew({
      query: "מסעדה",
      place: "תל אביב",
      nearSpeaker: false,
      aspects: ["parking", "accessibility", "outdoor", "children", "payment"],
      ...noFilters,
      results: [withAttrs],
    });
    expect(text).toContain("חניון חינם: כן");
    expect(text).toContain("חניון בתשלום: לא");
    expect(text).not.toContain("רחוב חינם:");
    expect(text).toContain("כניסה לנכים: כן");
    expect(text).toContain("שירותים לנכים: לא");
    expect(text).toContain("ישיבה בחוץ: כן");
    expect(text).not.toContain("מתאים לילדים");
    expect(text).not.toContain("אין מידע בגוגל");
    expect(text).toContain("כרטיסי אשראי: כן");
    expect(text).toContain("מזומן בלבד: לא");
    expect(text).not.toContain("כרטיסי חיוב:");
  });

  it("summary aspect does not print attribute blocks", () => {
    const withAttrs: PlaceResult = {
      ...base,
      outdoorSeating: false,
      goodForChildren: false,
      parking: {
        freeLot: false,
        paidLot: false,
        freeStreet: false,
        paidStreet: false,
        valet: false,
        freeGarage: false,
        paidGarage: false,
      },
    };
    const text = formatPlacesHebrew({
      query: "מסעדה",
      place: "תל אביב",
      nearSpeaker: false,
      aspects: ["summary"],
      ...noFilters,
      results: [withAttrs],
    });
    expect(text).toContain("מקדונלדס");
    expect(text).toContain("טלפון:");
    expect(text).not.toContain("חניה");
    expect(text).not.toContain("ישיבה בחוץ");
    expect(text).not.toContain("מתאים לילדים");
    expect(text).not.toContain("אין מידע בגוגל");
  });

  it("notes when exact min_rating dropped places without rating (unsaturated)", () => {
    const text = formatPlacesHebrew({
      query: "מסעדות",
      place: "תל אביב",
      nearSpeaker: false,
      aspects: ["summary"],
      intent: "business",
      openNowFilter: null,
      minRating: 4.1,
      includedType: null,
      radiusMeters: null,
      results: [base],
      providerPartial: false,
      requestedMax: 20,
      minRatingUnknownDropped: true,
    });
    expect(text).toContain(PLACES_MIN_RATING_UNKNOWN_DROPPED_HE);
    expect(text).not.toContain(PLACES_PROVIDER_PARTIAL_HE);
    expect(text).not.toContain(PLACES_FILTERED_SATURATED_EMPTY_HE);
    expect(text).not.toContain(PLACES_FILTERED_SATURATED_SPARSE_HE);
  });

  it("notes unknown-rating drops on unsaturated empty keep set", () => {
    const empty = formatPlacesHebrew({
      query: "מסעדות",
      place: "תל אביב",
      nearSpeaker: false,
      aspects: ["summary"],
      intent: "business",
      openNowFilter: null,
      minRating: 4.4,
      includedType: null,
      radiusMeters: null,
      results: [],
      providerPartial: false,
      requestedMax: 20,
      minRatingUnknownDropped: true,
    });
    expect(empty).toContain("לא מצאתי תוצאות");
    expect(empty).toContain(PLACES_MIN_RATING_UNKNOWN_DROPPED_HE);
    expect(empty).not.toContain(PLACES_FILTERED_SATURATED_EMPTY_HE);
    expect(empty).not.toContain(PLACES_PROVIDER_PARTIAL_HE);
  });
});

describe("Phase B result limits", () => {
  it("keeps unfiltered page size at the configured default", () => {
    expect(placesRequestMaxResults(false)).toBe(placesUnfilteredMaxResults());
    expect(placesRequestMaxResults(false)).toBe(10);
  });

  it("uses up to 20 for filtered asks", () => {
    expect(placesRequestMaxResults(true)).toBe(PLACES_FILTERED_PAGE_SIZE);
    expect(placesRequestMaxResults(true)).toBe(20);
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
        maxResultCount?: number;
        openNow?: boolean;
        minRating?: number;
        includedType?: string;
      };
      expect(body.textQuery).toBe("מקדונלדס קרית אונו");
      expect(body.languageCode).toBe("he");
      expect(body.regionCode).toBe("IL");
      expect(body.maxResultCount).toBe(10);
      expect(body.openNow).toBeUndefined();
      expect(body.minRating).toBeUndefined();
      expect(body.includedType).toBeUndefined();
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
    expect(text).not.toContain("סינון:");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends Google request-side filters and bias radius when set", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        openNow?: boolean;
        minRating?: number;
        includedType?: string;
        strictTypeFiltering?: boolean;
        maxResultCount?: number;
        locationBias?: {
          circle?: { radius?: number; center?: { latitude: number } };
        };
        rankPreference?: string;
      };
      expect(body.openNow).toBe(true);
      expect(body.minRating).toBe(4);
      expect(body.includedType).toBe("cafe");
      expect(body.strictTypeFiltering).toBe(true);
      expect(body.maxResultCount).toBe(20);
      expect(body.locationBias?.circle?.radius).toBe(2500);
      expect(body.rankPreference).toBe("DISTANCE");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          places: [
            {
              id: "places/1",
              displayName: { text: "קפה", languageCode: "he" },
              nationalPhoneNumber: "03-1",
              formattedAddress: "רחוב 1",
              rating: 4.2,
            },
          ],
        }),
      } as Response;
    });

    const text = await resolvePlacesReply({
      query: "קפה",
      place: "",
      nearSpeaker: true,
      lat: 32.1,
      lng: 34.8,
      openNow: true,
      minRating: 4,
      includedType: "cafe",
      radiusMeters: 2500,
      radiusExplicit: true,
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("קפה");
    expect(text).toContain("סינון:");
    expect(text).toContain("פתוח עכשיו");
    expect(text).toContain("לא סינון גבול קשיח");
  });

  it("floors fractional min_rating for Google and keeps exact local matches", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["X-Goog-FieldMask"]).toBe(PLACES_BASE_FIELD_MASK.join(","));
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        minRating?: number;
        maxResultCount?: number;
      };
      expect(body.minRating).toBe(4);
      expect(body.maxResultCount).toBe(20);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          // Unsaturated page (3 < maxResultCount 20) — honesty note must still appear.
          places: [
            {
              id: "places/keep",
              displayName: { text: "מעל הסף", languageCode: "he" },
              rating: 4.1,
              nationalPhoneNumber: "03-1",
              formattedAddress: "רחוב 1",
            },
            {
              id: "places/drop-low",
              displayName: { text: "מתחת לסף", languageCode: "he" },
              rating: 4.05,
              nationalPhoneNumber: "03-2",
              formattedAddress: "רחוב 2",
            },
            {
              id: "places/drop-null",
              displayName: { text: "בלי דירוג", languageCode: "he" },
              nationalPhoneNumber: "03-3",
              formattedAddress: "רחוב 3",
            },
          ],
        }),
      } as Response;
    });

    const text = await resolvePlacesReply({
      query: "מסעדות",
      place: "תל אביב",
      aspects: ["summary"],
      minRating: 4.1,
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("מעל הסף");
    expect(text).toContain("דירוג ≥ 4.1");
    expect(text).not.toContain("*מתחת לסף*");
    expect(text).not.toContain("*בלי דירוג*");
    expect(text).toContain(PLACES_MIN_RATING_UNKNOWN_DROPPED_HE);
    expect(text).not.toContain(PLACES_PROVIDER_PARTIAL_HE);
    expect(text).not.toContain(PLACES_FILTERED_SATURATED_SPARSE_HE);
  });

  it("exact local min_rating filter keeps ≥4.1 and drops below/null (structured facts)", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        minRating?: number;
      };
      expect(body.minRating).toBe(placesMinRatingProviderFloor(4.1));
      expect(body.minRating).toBe(4);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          places: [
            {
              id: "places/above",
              displayName: { text: "מעל", languageCode: "he" },
              rating: 4.7,
              formattedAddress: "א",
            },
            {
              id: "places/exact",
              displayName: { text: "בדיוק", languageCode: "he" },
              rating: 4.1,
              formattedAddress: "ב",
            },
            {
              id: "places/between-floor-and-exact",
              displayName: { text: "בין רצפה לסף", languageCode: "he" },
              rating: 4.05,
              formattedAddress: "ג",
            },
            {
              id: "places/below-floor",
              displayName: { text: "מתחת לרצפה", languageCode: "he" },
              rating: 3.9,
              formattedAddress: "ד",
            },
            {
              id: "places/null-rating",
              displayName: { text: "בלי דירוג", languageCode: "he" },
              formattedAddress: "ה",
            },
          ],
        }),
      } as Response;
    });

    const facts = await fetchPlacesFacts({
      query: "מסעדות",
      place: "תל אביב",
      aspects: ["summary"],
      minRating: 4.1,
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(facts.minRating).toBe(4.1);
    expect(facts.minRatingProvider).toBe(4);
    expect(facts.minRatingUnknownDropped).toBe(true);
    expect(facts.results.map((r) => r.name).sort()).toEqual(["בדיוק", "מעל"]);
    expect(facts.results.every((r) => r.rating != null && r.rating >= 4.1)).toBe(
      true,
    );
    expect(facts.results.some((r) => r.name === "בין רצפה לסף")).toBe(false);
    expect(facts.results.some((r) => r.name === "בלי דירוג")).toBe(false);
  });

  it("shows unknown-rating drop note on unsaturated page even when keep set is empty", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        minRating?: number;
        maxResultCount?: number;
      };
      expect(body.minRating).toBe(4);
      expect(body.maxResultCount).toBe(20);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          places: [
            {
              id: "places/a",
              displayName: { text: "בלי דירוג א", languageCode: "he" },
              formattedAddress: "רחוב 1",
            },
            {
              id: "places/b",
              displayName: { text: "בלי דירוג ב", languageCode: "he" },
              formattedAddress: "רחוב 2",
            },
          ],
        }),
      } as Response;
    });

    const text = await resolvePlacesReply({
      query: "מסעדות",
      place: "תל אביב",
      minRating: 4.4,
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("לא מצאתי תוצאות");
    expect(text).toContain("דירוג ≥ 4.4");
    expect(text).toContain(PLACES_MIN_RATING_UNKNOWN_DROPPED_HE);
    expect(text).not.toContain(PLACES_FILTERED_SATURATED_EMPTY_HE);
    expect(text).not.toContain(PLACES_PROVIDER_PARTIAL_HE);
  });

  it("floors 4.4 to provider 4.0 and keeps half-step 4.5 exact", async () => {
    const seen: number[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        minRating?: number;
      };
      seen.push(body.minRating ?? -1);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          places: [
            {
              id: "places/a",
              displayName: { text: "דירוג 4.4", languageCode: "he" },
              rating: 4.4,
              formattedAddress: "רחוב 1",
            },
            {
              id: "places/b",
              displayName: { text: "דירוג 4.5", languageCode: "he" },
              rating: 4.5,
              formattedAddress: "רחוב 2",
            },
          ],
        }),
      } as Response;
    });

    const for44 = await resolvePlacesReply({
      query: "מסעדות",
      place: "תל אביב",
      minRating: 4.4,
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(seen[0]).toBe(4);
    expect(for44).toContain("דירוג 4.4");
    expect(for44).toContain("דירוג 4.5");
    expect(for44).toContain("דירוג ≥ 4.4");

    const for45 = await resolvePlacesReply({
      query: "מסעדות",
      place: "תל אביב",
      minRating: 4.5,
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(seen[1]).toBe(4.5);
    expect(for45).not.toContain("דירוג 4.4");
    expect(for45).toContain("דירוג 4.5");
    expect(for45).toContain("דירוג ≥ 4.5");
  });

  it("requests Atmosphere fields only for attribute aspects", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["X-Goog-FieldMask"]).toContain("places.parkingOptions");
      expect(headers["X-Goog-FieldMask"]).toContain("places.outdoorSeating");
      expect(headers["X-Goog-FieldMask"]).not.toContain("places.paymentOptions");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          places: [
            {
              id: "places/1",
              displayName: { text: "מקום", languageCode: "he" },
              formattedAddress: "רחוב 1",
              parkingOptions: {
                freeParkingLot: true,
                paidParkingLot: false,
              },
              outdoorSeating: false,
            },
          ],
        }),
      } as Response;
    });

    const text = await resolvePlacesReply({
      query: "מסעדה",
      place: "תל אביב",
      aspects: ["parking", "outdoor"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("חניון חינם: כן");
    expect(text).toContain("חניון בתשלום: לא");
    expect(text).toContain("ישיבה בחוץ: לא");
    expect(text).not.toMatch(/^תשלום/m);
    expect(text).not.toContain("כרטיסי אשראי");
  });

  it("unfiltered requests keep default maxResultCount 10", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        maxResultCount?: number;
      };
      expect(body.maxResultCount).toBe(10);
      return {
        ok: true,
        status: 200,
        json: async () => ({ places: [] }),
      } as Response;
    });
    await resolvePlacesReply({
      query: "חשמלאי",
      place: "פתח תקווה",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
  });

  it("saturation is based on raw page size before local mapping drops", async () => {
    // 20 raw rows (filtered page size) but none mappable → saturated empty.
    const places = Array.from({ length: 20 }, (_, i) => ({
      id: `places/${i}`,
      // Missing displayName → dropped by local mapping.
    }));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ places }),
    })) as unknown as typeof fetch;

    const text = await resolvePlacesReply({
      query: "מסעדות",
      place: "תל אביב",
      openNow: true,
      includedType: "restaurant",
      apiKey: "test-key",
      fetchImpl,
    });
    expect(text).toContain("לא הוצגו תוצאות מתאימות בדף החיפוש");
    expect(text).toContain(PLACES_FILTERED_SATURATED_EMPTY_HE);
    expect(text).not.toContain("לא מצאתי תוצאות");
  });

  it("unsaturated filtered empty may say no results were found", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        maxResultCount?: number;
      };
      expect(body.maxResultCount).toBe(20);
      return {
        ok: true,
        status: 200,
        json: async () => ({ places: [] }),
      } as Response;
    });
    const text = await resolvePlacesReply({
      query: "מסעדות",
      place: "תל אביב",
      openNow: true,
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("לא מצאתי תוצאות");
    expect(text).not.toContain(PLACES_FILTERED_SATURATED_EMPTY_HE);
  });

  it("uses default bias radius without advertising it as a filter", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        locationBias?: { circle?: { radius?: number } };
      };
      expect(body.locationBias?.circle?.radius).toBe(
        PLACES_DEFAULT_BIAS_RADIUS_METERS,
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({
          places: [
            {
              id: "places/1",
              displayName: { text: "מקום", languageCode: "he" },
            },
          ],
        }),
      } as Response;
    });

    const text = await resolvePlacesReply({
      query: "מסעדות",
      place: "",
      nearSpeaker: true,
      lat: 32.1,
      lng: 34.8,
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("מקום");
    expect(text).not.toContain("העדפת קרבה");
    expect(text).not.toContain("סינון:");
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
    expect(text).not.toContain(PLACES_PROVIDER_PARTIAL_HE);
  });

  it("marks saturated Text Search page as potential incompleteness", async () => {
    const places = Array.from({ length: 10 }, (_, i) => ({
      id: `places/${i}`,
      displayName: { text: `עסק ${i}`, languageCode: "he" },
      nationalPhoneNumber: `03-000000${i}`,
      formattedAddress: `רחוב ${i}`,
      addressComponents: [{ longText: `4900${i}`, types: ["postal_code"] }],
    }));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ places }),
    })) as unknown as typeof fetch;

    const text = await resolvePlacesReply({
      query: "חשמלאי",
      place: "פתח תקווה",
      apiKey: "test-key",
      fetchImpl,
    });
    expect(text).toContain("10 תוצאות");
    expect(text).toContain(PLACES_PROVIDER_PARTIAL_HE);
  });

  it("does not claim incompleteness when provider page is unsaturated", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        places: [
          {
            id: "places/1",
            displayName: { text: "עסק אחד", languageCode: "he" },
            nationalPhoneNumber: "03-111",
            formattedAddress: "רחוב 1",
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const text = await resolvePlacesReply({
      query: "חשמלאי",
      place: "פתח תקווה",
      apiKey: "test-key",
      fetchImpl,
    });
    expect(text).toContain("עסק אחד");
    expect(text).not.toContain(PLACES_PROVIDER_PARTIAL_HE);
  });

  it("parking intent forces includedType parking + parkingOptions FieldMask", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["X-Goog-FieldMask"]).toContain("places.parkingOptions");
      expect(headers["X-Goog-FieldMask"]).not.toContain("places.paymentOptions");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        includedType?: string;
        strictTypeFiltering?: boolean;
        maxResultCount?: number;
      };
      expect(body.includedType).toBe(PLACES_PARKING_INCLUDED_TYPE);
      expect(body.strictTypeFiltering).toBe(true);
      expect(body.maxResultCount).toBe(20);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          places: [
            {
              id: "places/p1",
              displayName: { text: "חניון העירייה", languageCode: "he" },
              formattedAddress: "רחוב 1",
              parkingOptions: {
                paidParkingLot: true,
                freeParkingLot: false,
                valetParking: true,
              },
            },
          ],
        }),
      } as Response;
    });

    const text = await resolvePlacesReply({
      query: "חניה",
      place: "תל אביב",
      intent: "parking",
      aspects: ["summary"],
      // Model may omit or send a conflicting type — engine forces parking.
      includedType: "restaurant",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("חניון העירייה");
    expect(text).toContain("חיפוש חניה");
    expect(text).toContain("סוג: חניה");
    expect(text).toContain("חניון בתשלום: כן");
    expect(text).toContain("חניון חינם: לא");
    expect(text).toContain("שירות חניה: כן");
    expect(text).not.toContain(PLACES_PARKING_OWNERSHIP_UNKNOWN_HE);
    expect(text).not.toContain("אין מידע בגוגל");
    // Missing street flags must not appear as confirmed no.
    expect(text).not.toContain("רחוב חינם:");
  });

  it("business intent without parking aspect keeps summary FieldMask and omits ownership note", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["X-Goog-FieldMask"]).toBe(PLACES_BASE_FIELD_MASK.join(","));
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        includedType?: string;
        maxResultCount?: number;
      };
      expect(body.includedType).toBeUndefined();
      expect(body.maxResultCount).toBe(10);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          places: [
            {
              id: "places/b1",
              displayName: { text: "מסעדה", languageCode: "he" },
              nationalPhoneNumber: "03-1",
              formattedAddress: "רחוב 1",
              parkingOptions: { freeParkingLot: true },
            },
          ],
        }),
      } as Response;
    });

    const text = await resolvePlacesReply({
      query: "מסעדה",
      place: "תל אביב",
      intent: "business",
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("מסעדה");
    expect(text).not.toContain("חיפוש חניה");
    expect(text).not.toContain(PLACES_PARKING_OWNERSHIP_UNKNOWN_HE);
    expect(text).not.toContain("חניון חינם");
  });
});

describe("Phase D parking formatting", () => {
  const lot: PlaceResult = {
    id: "place-lot-1",
    name: "חניון בדיקה",
    phone: "",
    address: "רחוב 9",
    postalCode: "",
    rating: null,
    openNow: null,
    weekdayHours: [],
    mapsUrl: "",
    parking: {
      freeLot: null,
      paidLot: true,
      freeStreet: false,
      paidStreet: null,
      valet: null,
      freeGarage: null,
      paidGarage: null,
    },
    accessibility: null,
    outdoorSeating: null,
    goodForChildren: null,
    payment: null,
  };

  it("shows known parking flags only and never invents ownership", () => {
    const text = formatPlacesHebrew({
      query: "חניה",
      place: "חיפה",
      nearSpeaker: false,
      aspects: ["summary"],
      intent: "parking",
      openNowFilter: null,
      minRating: null,
      includedType: "parking",
      radiusMeters: null,
      results: [lot],
    });
    expect(text).toContain("חניון בתשלום: כן");
    expect(text).toContain("רחוב חינם: לא");
    expect(text).not.toContain("חניון חינם:");
    expect(text).not.toContain("שירות חניה:");
    expect(text).not.toContain(PLACES_PARKING_OWNERSHIP_UNKNOWN_HE);
    expect(text).not.toContain("אין מידע בגוגל");
    expect(text).toContain("חיפוש חניה");
  });

  it("business + parking aspect shows attrs without ownership ownership claim", () => {
    const text = formatPlacesHebrew({
      query: "מסעדה",
      place: "חיפה",
      nearSpeaker: false,
      aspects: ["parking"],
      intent: "business",
      openNowFilter: null,
      minRating: null,
      includedType: null,
      radiusMeters: null,
      results: [lot],
    });
    expect(text).toContain("חניון בתשלום: כן");
    expect(text).not.toContain(PLACES_PARKING_OWNERSHIP_UNKNOWN_HE);
    expect(text).not.toContain("חיפוש חניה");
  });
});

describe("parking_cost local filter", () => {
  it("keeps only known-free lots when parking_cost=free", async () => {
    const fetchImpl = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          places: [
            {
              id: "places/free1",
              displayName: { text: "חניון חינם", languageCode: "he" },
              formattedAddress: "רחוב 1",
              parkingOptions: { freeParkingLot: true, paidParkingLot: false },
            },
            {
              id: "places/paid1",
              displayName: { text: "חניון בתשלום", languageCode: "he" },
              formattedAddress: "רחוב 2",
              parkingOptions: { freeParkingLot: false, paidParkingLot: true },
            },
            {
              id: "places/unknown1",
              displayName: { text: "חניון לא ידוע", languageCode: "he" },
              formattedAddress: "רחוב 3",
            },
          ],
        }),
      } as Response;
    });

    const text = await resolvePlacesReply({
      query: "חניה",
      place: "תל אביב",
      intent: "parking",
      parkingCost: "free",
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("*חניון חינם*");
    expect(text).toContain("חניה חינם");
    expect(text).not.toContain("*חניון בתשלום*");
    expect(text).not.toContain("*חניון לא ידוע*");
    expect(text).toContain(PLACES_PARKING_COST_UNKNOWN_DROPPED_HE);
  });

  it("keeps only known-paid lots when parking_cost=paid", async () => {
    const fetchImpl = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          places: [
            {
              id: "places/free1",
              displayName: { text: "חניון חינם", languageCode: "he" },
              formattedAddress: "רחוב 1",
              parkingOptions: { freeParkingLot: true },
            },
            {
              id: "places/paid1",
              displayName: { text: "חניון בתשלום", languageCode: "he" },
              formattedAddress: "רחוב 2",
              parkingOptions: { paidParkingLot: true },
            },
          ],
        }),
      } as Response;
    });

    const text = await resolvePlacesReply({
      query: "חניון",
      place: "תל אביב",
      intent: "parking",
      parkingCost: "paid",
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("*חניון בתשלום*");
    expect(text).toContain("חניה בתשלום");
    expect(text).not.toContain("*חניון חינם*");
  });
});
