import {
  normalizePlacesIncludedType,
  normalizePlacesIntent,
  normalizePlacesMinRating,
  normalizePlacesOpenNow,
  normalizePlacesParkingCost,
  normalizePlacesRadiusMeters,
  placesMinRatingProviderFloor,
  PLACES_PARKING_INCLUDED_TYPE,
  type LlmPlacesIncludedType,
  type LlmPlacesIntent,
  type LlmPlacesParkingCost,
} from "@workee/shared";
import { getEnv } from "../config/env.js";

export type PlacesAspect =
  | "summary"
  | "phone"
  | "address"
  | "hours"
  | "parking"
  | "accessibility"
  | "outdoor"
  | "children"
  | "payment";

export type PlacesIntent = LlmPlacesIntent;

/** true / false / unknown (missing). Missing must never display as confirmed false. */
export type TriState = true | false | null;

export type PlaceParkingAttrs = {
  freeLot: TriState;
  paidLot: TriState;
  freeStreet: TriState;
  paidStreet: TriState;
  valet: TriState;
  freeGarage: TriState;
  paidGarage: TriState;
};

export type PlaceAccessibilityAttrs = {
  wheelchairParking: TriState;
  wheelchairEntrance: TriState;
  wheelchairRestroom: TriState;
  wheelchairSeating: TriState;
};

export type PlacePaymentAttrs = {
  creditCards: TriState;
  debitCards: TriState;
  cashOnly: TriState;
  nfc: TriState;
};

export type PlaceResult = {
  name: string;
  phone: string;
  address: string;
  /** Israeli / Google postal_code when present — always shown in format. */
  postalCode: string;
  rating: number | null;
  openNow: boolean | null;
  weekdayHours: string[];
  mapsUrl: string;
  parking: PlaceParkingAttrs | null;
  accessibility: PlaceAccessibilityAttrs | null;
  outdoorSeating: TriState;
  goodForChildren: TriState;
  payment: PlacePaymentAttrs | null;
};

export type PlacesFacts = {
  query: string;
  place: string;
  nearSpeaker: boolean;
  aspects: PlacesAspect[];
  /** business (default) or dedicated parking-place search. */
  intent: PlacesIntent;
  /** Applied Google openNow filter (true only). */
  openNowFilter: boolean | null;
  /** Exact min_rating threshold (local filter when rating present). */
  minRating: number | null;
  /** Floored 0.5 step sent to Google (inclusive provider page). */
  minRatingProvider?: number | null;
  /** True when local exact filter dropped rows with missing rating. */
  minRatingUnknownDropped?: boolean;
  /** Applied includedType filter. */
  includedType: LlmPlacesIncludedType | null;
  /**
   * Bias circle radius when ACTION set radius_meters (meters).
   * locationBias preference only — not a verified hard fence.
   */
  radiusMeters: number | null;
  /** Local free/paid ParkingOptions filter (null/omit = none). */
  parkingCost?: LlmPlacesParkingCost | null;
  /**
   * True when parking_cost filter dropped rows with unknown cost flags
   * (no confirming free/paid attribute from Google).
   */
  parkingCostUnknownDropped?: boolean;
  results: PlaceResult[];
  /** maxResultCount sent on this Text Search (for saturation checks). */
  requestedMax?: number;
  /**
   * True when the raw provider page length reached requestedMax,
   * measured before local mapping / exact rating drops.
   */
  providerPartial?: boolean;
};

/**
 * Saturated Places Text Search page (result count == requested max).
 * Potential incompleteness only — does not prove more matches exist.
 */
export const PLACES_PROVIDER_PARTIAL_HE =
  "(ייתכן שהרשימה חלקית — התקבל מספר תוצאות כמגבלת החיפוש, ולא ניתן לדעת אם יש עוד.)";

/**
 * Filtered ask + saturated provider page + zero kept rows after local mapping.
 * Must not claim that no matching places exist.
 */
export const PLACES_FILTERED_SATURATED_EMPTY_HE =
  "(ייתכן שהחיפוש חלקי — הדף התמלא במגבלת הספק, ולכן אי אפשר לקבוע שאין מקומות תואמים.)";

/**
 * Filtered ask + saturated page + only a sparse kept set after local mapping.
 */
export const PLACES_FILTERED_SATURATED_SPARSE_HE =
  "(ייתכן שהרשימה חלקית — הדף התמלא במגבלת הספק, וייתכן שיש עוד תוצאות שלא נכללו.)";

/**
 * Exact min_rating local filter dropped places without a returned rating.
 * Exact completeness cannot be guaranteed.
 */
export const PLACES_MIN_RATING_UNKNOWN_DROPPED_HE =
  "(סינון דירוג מדויק: מקומות בלי דירוג בגוגל לא נכללו — אי אפשר להבטיח שלמות.)";

/**
 * parking_cost local filter dropped places without a confirming free/paid flag.
 */
export const PLACES_PARKING_COST_UNKNOWN_DROPPED_HE =
  "(סינון עלות חניה: מקומות בלי סימון חינם/בתשלום בגוגל לא נכללו — אי אפשר להבטיח שלמות.)";

/** Places API (New) hard max for maxResultCount. */
export const PLACES_API_HARD_MAX = 20;

/** Page size for asks that use request-side filters (Phase B). */
export const PLACES_FILTERED_PAGE_SIZE = 20;

/**
 * After local keep, this many or fewer rows with a saturated filtered page
 * is treated as "sparse" for cautious wording.
 */
export const PLACES_SPARSE_RESULT_THRESHOLD = 2;

/** Default locationBias radius when pin present and ACTION omits radius_meters. */
export const PLACES_DEFAULT_BIAS_RADIUS_METERS = 1500;

/**
 * Billing note (documentation only — not user-facing):
 * - Base/summary FieldMask: Text Search Enterprise (phone/hours/rating).
 * - accessibility → accessibilityOptions: Text Search Pro (usually already covered).
 * - parking / payment / outdoor / children → Enterprise + Atmosphere SKU.
 * - Parking intent always requests parkingOptions (Atmosphere) so free/paid /
 *   lot/street/valet can render when Google returns them.
 * - Google ParkingOptions does not expose public vs private ownership.
 */
export const PLACES_ASPECT_BILLING_NOTES = {
  summary: "Enterprise (existing base mask)",
  accessibility: "Pro (accessibilityOptions)",
  parking: "Enterprise + Atmosphere (parkingOptions)",
  payment: "Enterprise + Atmosphere (paymentOptions)",
  outdoor: "Enterprise + Atmosphere (outdoorSeating)",
  children: "Enterprise + Atmosphere (goodForChildren)",
  parking_intent:
    "Enterprise + Atmosphere via parkingOptions; includedType=parking (Table A). No public/private ownership field.",
} as const;

/**
 * Parking intent: ownership (public/private) is not in Google ParkingOptions.
 * Never infer from free/paid/lot/street/valet flags — and do not print a
 * "unknown ownership" line (omit missing facts from the reply).
 */
export const PLACES_PARKING_OWNERSHIP_UNKNOWN_HE =
  "בעלות החניה (ציבורית/פרטית): אין מידע בגוגל — לא ניתן להסיק מנתוני החניה.";

/** Google Table A type forced for intent=parking. */
export { PLACES_PARKING_INCLUDED_TYPE };

const ASPECT_SET = new Set<PlacesAspect>([
  "summary",
  "phone",
  "address",
  "hours",
  "parking",
  "accessibility",
  "outdoor",
  "children",
  "payment",
]);

/** Places API (New) — Text Search. */
const SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";

/** Default / summary FieldMask — unchanged SKU baseline from Phase A. */
export const PLACES_BASE_FIELD_MASK = [
  "places.displayName",
  "places.id",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.formattedAddress",
  "places.addressComponents",
  "places.rating",
  "places.currentOpeningHours",
  "places.regularOpeningHours",
  "places.googleMapsUri",
] as const;

/**
 * Build FieldMask: base always; Atmosphere/Pro attribute fields only when asked.
 * Parking intent also requests parkingOptions (without changing the base mask).
 */
export function buildPlacesFieldMask(
  aspects: PlacesAspect[],
  intent: PlacesIntent = "business",
): string {
  const fields = new Set<string>(PLACES_BASE_FIELD_MASK);
  if (aspects.includes("parking") || intent === "parking") {
    fields.add("places.parkingOptions");
  }
  if (aspects.includes("accessibility")) {
    fields.add("places.accessibilityOptions");
  }
  if (aspects.includes("outdoor")) {
    fields.add("places.outdoorSeating");
  }
  if (aspects.includes("children")) {
    fields.add("places.goodForChildren");
  }
  if (aspects.includes("payment")) {
    fields.add("places.paymentOptions");
  }
  return [...fields].join(",");
}

export const PLACES_API_KEY_MISSING = "places_api_key_missing";

/** Unfiltered Text Search page size from env (default 10, hard max 20). */
export function placesUnfilteredMaxResults(): number {
  return getEnv().GOOGLE_PLACES_MAX_RESULTS;
}

/**
 * Request page size: unfiltered keeps env default; filtered asks use up to 20
 * (API hard max).
 */
export function placesRequestMaxResults(filtersActive: boolean): number {
  if (!filtersActive) {
    return placesUnfilteredMaxResults();
  }
  return Math.min(PLACES_API_HARD_MAX, PLACES_FILTERED_PAGE_SIZE);
}

/** Filters that justify the larger Text Search page (request-side or local). */
export function hasPlacesRequestSideFilters(input: {
  openNowFilter?: boolean | null;
  minRating?: number | null;
  includedType?: string | null;
  parkingCost?: LlmPlacesParkingCost | null;
}): boolean {
  return (
    input.openNowFilter === true ||
    input.minRating != null ||
    Boolean(input.includedType) ||
    input.parkingCost === "free" ||
    input.parkingCost === "paid"
  );
}

/** Known free lot / street / garage from Google ParkingOptions. */
export function placeOffersFreeParking(row: PlaceResult): boolean {
  const p = row.parking;
  if (!p) {
    return false;
  }
  return (
    p.freeLot === true || p.freeStreet === true || p.freeGarage === true
  );
}

/** Known paid lot / street / garage / valet from Google ParkingOptions. */
export function placeOffersPaidParking(row: PlaceResult): boolean {
  const p = row.parking;
  if (!p) {
    return false;
  }
  return (
    p.paidLot === true ||
    p.paidStreet === true ||
    p.paidGarage === true ||
    p.valet === true
  );
}

export const PLACES_API_DENIED = "places_api_denied";

export function parsePlacesAspects(raw: unknown): PlacesAspect[] {
  if (!Array.isArray(raw)) {
    return ["summary"];
  }
  const out: PlacesAspect[] = [];
  for (const entry of raw) {
    const key = String(entry ?? "")
      .trim()
      .toLowerCase() as PlacesAspect;
    if (ASPECT_SET.has(key) && !out.includes(key)) {
      out.push(key);
    }
  }
  return out.length > 0 ? out : ["summary"];
}

function wants(aspects: PlacesAspect[], key: PlacesAspect): boolean {
  return aspects.includes("summary") || aspects.includes(key);
}

function wantsAttr(aspects: PlacesAspect[], key: PlacesAspect): boolean {
  return aspects.includes(key);
}

function wantsParkingDetails(
  aspects: PlacesAspect[],
  intent: PlacesIntent,
): boolean {
  return intent === "parking" || wantsAttr(aspects, "parking");
}

function triFromUnknown(value: unknown): TriState {
  if (value === true) {
    return true;
  }
  if (value === false) {
    return false;
  }
  return null;
}

type NewAddressComponent = {
  longText?: string;
  shortText?: string;
  types?: string[];
};

type NewParkingOptions = {
  freeParkingLot?: boolean;
  paidParkingLot?: boolean;
  freeStreetParking?: boolean;
  paidStreetParking?: boolean;
  valetParking?: boolean;
  freeGarageParking?: boolean;
  paidGarageParking?: boolean;
};

type NewAccessibilityOptions = {
  wheelchairAccessibleParking?: boolean;
  wheelchairAccessibleEntrance?: boolean;
  wheelchairAccessibleRestroom?: boolean;
  wheelchairAccessibleSeating?: boolean;
};

type NewPaymentOptions = {
  acceptsCreditCards?: boolean;
  acceptsDebitCards?: boolean;
  acceptsCashOnly?: boolean;
  acceptsNfc?: boolean;
};

type NewPlace = {
  id?: string;
  displayName?: { text?: string; languageCode?: string };
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  formattedAddress?: string;
  addressComponents?: NewAddressComponent[];
  rating?: number;
  currentOpeningHours?: {
    openNow?: boolean;
    weekdayDescriptions?: string[];
  };
  regularOpeningHours?: {
    openNow?: boolean;
    weekdayDescriptions?: string[];
  };
  googleMapsUri?: string;
  parkingOptions?: NewParkingOptions;
  accessibilityOptions?: NewAccessibilityOptions;
  outdoorSeating?: boolean;
  goodForChildren?: boolean;
  paymentOptions?: NewPaymentOptions;
};

type SearchTextResponse = {
  places?: NewPlace[];
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

function postalFromComponents(
  components: NewAddressComponent[] | undefined,
): string {
  if (!Array.isArray(components)) {
    return "";
  }
  for (const row of components) {
    const types = Array.isArray(row?.types) ? row.types.map(String) : [];
    if (types.includes("postal_code")) {
      return String(row.longText ?? row.shortText ?? "").trim();
    }
  }
  return "";
}

function mapParking(opts: NewParkingOptions | undefined): PlaceParkingAttrs | null {
  if (!opts || typeof opts !== "object") {
    return null;
  }
  return {
    freeLot: triFromUnknown(opts.freeParkingLot),
    paidLot: triFromUnknown(opts.paidParkingLot),
    freeStreet: triFromUnknown(opts.freeStreetParking),
    paidStreet: triFromUnknown(opts.paidStreetParking),
    valet: triFromUnknown(opts.valetParking),
    freeGarage: triFromUnknown(opts.freeGarageParking),
    paidGarage: triFromUnknown(opts.paidGarageParking),
  };
}

function mapAccessibility(
  opts: NewAccessibilityOptions | undefined,
): PlaceAccessibilityAttrs | null {
  if (!opts || typeof opts !== "object") {
    return null;
  }
  return {
    wheelchairParking: triFromUnknown(opts.wheelchairAccessibleParking),
    wheelchairEntrance: triFromUnknown(opts.wheelchairAccessibleEntrance),
    wheelchairRestroom: triFromUnknown(opts.wheelchairAccessibleRestroom),
    wheelchairSeating: triFromUnknown(opts.wheelchairAccessibleSeating),
  };
}

function mapPayment(opts: NewPaymentOptions | undefined): PlacePaymentAttrs | null {
  if (!opts || typeof opts !== "object") {
    return null;
  }
  return {
    creditCards: triFromUnknown(opts.acceptsCreditCards),
    debitCards: triFromUnknown(opts.acceptsDebitCards),
    cashOnly: triFromUnknown(opts.acceptsCashOnly),
    nfc: triFromUnknown(opts.acceptsNfc),
  };
}

function mapNewPlace(row: NewPlace): PlaceResult | null {
  const name = String(row.displayName?.text ?? "").trim();
  if (!name) {
    return null;
  }
  const phone =
    String(row.nationalPhoneNumber ?? "").trim() ||
    String(row.internationalPhoneNumber ?? "").trim();
  const address = String(row.formattedAddress ?? "").trim();
  const postalCode = postalFromComponents(row.addressComponents);
  const rating =
    typeof row.rating === "number" && Number.isFinite(row.rating)
      ? row.rating
      : null;
  const hours = row.currentOpeningHours ?? row.regularOpeningHours;
  const openNow = typeof hours?.openNow === "boolean" ? hours.openNow : null;
  const weekdayHours = Array.isArray(hours?.weekdayDescriptions)
    ? hours!.weekdayDescriptions!.map((line) => String(line).trim()).filter(Boolean)
    : [];
  const mapsUrl = String(row.googleMapsUri ?? "").trim();
  return {
    name,
    phone,
    address,
    postalCode,
    rating,
    openNow,
    weekdayHours,
    mapsUrl,
    parking: mapParking(row.parkingOptions),
    accessibility: mapAccessibility(row.accessibilityOptions),
    outdoorSeating: triFromUnknown(row.outdoorSeating),
    goodForChildren: triFromUnknown(row.goodForChildren),
    payment: mapPayment(row.paymentOptions),
  };
}

function isPermissionDenied(status: number, body: SearchTextResponse): boolean {
  if (status === 403 || status === 401) {
    return true;
  }
  const errStatus = String(body.error?.status ?? "").toUpperCase();
  const msg = String(body.error?.message ?? "").toLowerCase();
  return (
    errStatus === "PERMISSION_DENIED" ||
    errStatus === "REQUEST_DENIED" ||
    msg.includes("permission") ||
    msg.includes("not enabled") ||
    msg.includes("legacy api")
  );
}

const INCLUDED_TYPE_HE: Record<LlmPlacesIncludedType, string> = {
  restaurant: "מסעדה",
  cafe: "בית קפה",
  bakery: "מאפייה",
  supermarket: "סופר",
  pharmacy: "בית מרקחת",
  hair_care: "מספרה",
  parking: "חניה",
};

/** Concise Hebrew filter summary bits (no hard-radius claim). */
export function formatPlacesFilterSummary(facts: PlacesFacts): string {
  const bits: string[] = [];
  if (facts.intent === "parking") {
    bits.push("חיפוש חניה");
  }
  if (facts.openNowFilter === true) {
    bits.push("פתוח עכשיו");
  }
  if (facts.minRating != null) {
    bits.push(`דירוג ≥ ${facts.minRating}`);
  }
  if (facts.includedType) {
    bits.push(`סוג: ${INCLUDED_TYPE_HE[facts.includedType] ?? facts.includedType}`);
  }
  if (facts.parkingCost === "free") {
    bits.push("חניה חינם");
  } else if (facts.parkingCost === "paid") {
    bits.push("חניה בתשלום");
  }
  if (facts.radiusMeters != null && facts.nearSpeaker) {
    bits.push(
      `העדפת קרבה עד כ־${facts.radiusMeters} מ׳ (לא סינון גבול קשיח)`,
    );
  }
  return bits.join(" · ");
}

export async function fetchPlacesFacts(input: {
  query: string;
  place: string;
  aspects?: PlacesAspect[] | unknown;
  intent?: PlacesIntent | unknown;
  lat?: number | null;
  lng?: number | null;
  nearSpeaker?: boolean;
  openNow?: boolean | null;
  minRating?: number | null;
  includedType?: string | null;
  radiusMeters?: number | null;
  parkingCost?: LlmPlacesParkingCost | unknown;
  /** True when ACTION explicitly set radius_meters (vs engine default bias). */
  radiusExplicit?: boolean;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
}): Promise<PlacesFacts> {
  const query = String(input.query ?? "").trim();
  const place = String(input.place ?? "").trim();
  const aspects = parsePlacesAspects(input.aspects);
  const intent = normalizePlacesIntent(input.intent);
  const lat =
    input.lat != null && Number.isFinite(input.lat) ? input.lat : null;
  const lng =
    input.lng != null && Number.isFinite(input.lng) ? input.lng : null;
  const nearSpeaker =
    Boolean(input.nearSpeaker) || (lat != null && lng != null && !place);
  const openNowFilter = normalizePlacesOpenNow(input.openNow);
  const minRating = normalizePlacesMinRating(input.minRating);
  const minRatingProvider =
    minRating != null ? placesMinRatingProviderFloor(minRating) : null;
  let includedType = normalizePlacesIncludedType(input.includedType);
  if (intent === "parking") {
    includedType = PLACES_PARKING_INCLUDED_TYPE;
  }
  const parkingCost = normalizePlacesParkingCost(input.parkingCost);
  const radiusExplicit =
    input.radiusExplicit === true ||
    (input.radiusMeters != null &&
      normalizePlacesRadiusMeters(input.radiusMeters) != null);
  const biasRadius =
    lat != null && lng != null
      ? normalizePlacesRadiusMeters(input.radiusMeters) ??
        PLACES_DEFAULT_BIAS_RADIUS_METERS
      : null;

  const requestFiltersActive = hasPlacesRequestSideFilters({
    openNowFilter,
    minRating,
    includedType,
    parkingCost,
  });
  const requestedMax = placesRequestMaxResults(requestFiltersActive);

  const facts: PlacesFacts = {
    query,
    place: nearSpeaker ? place || "האזור שלך" : place,
    nearSpeaker,
    aspects,
    intent,
    openNowFilter,
    minRating,
    minRatingProvider,
    includedType,
    radiusMeters: radiusExplicit && nearSpeaker ? biasRadius : null,
    parkingCost,
    results: [],
    requestedMax,
  };
  if (!query || (!place && (lat == null || lng == null))) {
    return facts;
  }

  const apiKey =
    (input.apiKey ?? getEnv().GOOGLE_PLACES_API_KEY ?? "").trim() || null;
  if (!apiKey) {
    throw new Error(PLACES_API_KEY_MISSING);
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    textQuery: place && !nearSpeaker ? `${query} ${place}` : query,
    languageCode: "he",
    regionCode: "IL",
    maxResultCount: requestedMax,
  };
  if (openNowFilter === true) {
    body.openNow = true;
  }
  if (minRatingProvider != null) {
    body.minRating = minRatingProvider;
  }
  if (includedType) {
    body.includedType = includedType;
    body.strictTypeFiltering = true;
  }
  if (lat != null && lng != null && biasRadius != null) {
    body.locationBias = {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: biasRadius,
      },
    };
    body.rankPreference = "DISTANCE";
  }
  const fieldMask = buildPlacesFieldMask(aspects, intent);
  const searchRes = await fetchImpl(SEARCH_TEXT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": fieldMask,
    },
    body: JSON.stringify(body),
  });

  let searchJson: SearchTextResponse = {};
  try {
    searchJson = (await searchRes.json()) as SearchTextResponse;
  } catch {
    searchJson = {};
  }

  if (!searchRes.ok) {
    if (isPermissionDenied(searchRes.status, searchJson)) {
      throw new Error(PLACES_API_DENIED);
    }
    throw new Error(`places search HTTP ${searchRes.status}`);
  }

  if (searchJson.error) {
    if (isPermissionDenied(searchRes.status, searchJson)) {
      throw new Error(PLACES_API_DENIED);
    }
    throw new Error(
      `places search ${searchJson.error.status ?? "ERROR"}${
        searchJson.error.message ? `: ${searchJson.error.message}` : ""
      }`,
    );
  }

  const places = Array.isArray(searchJson.places) ? searchJson.places : [];
  // Saturation on raw provider page BEFORE local mapping / exact rating drops.
  const providerPageSaturated = places.length >= requestedMax;
  const mapped: PlaceResult[] = [];
  for (const row of places.slice(0, requestedMax)) {
    const item = mapNewPlace(row);
    if (item) {
      mapped.push(item);
    }
  }

  let working = mapped;
  let minRatingUnknownDropped = false;
  if (minRating != null) {
    const kept: PlaceResult[] = [];
    for (const row of working) {
      if (row.rating == null) {
        minRatingUnknownDropped = true;
        continue;
      }
      if (row.rating >= minRating) {
        kept.push(row);
      }
    }
    working = kept;
    facts.minRatingUnknownDropped = minRatingUnknownDropped;
  }

  let parkingCostUnknownDropped = false;
  if (parkingCost === "free" || parkingCost === "paid") {
    const kept: PlaceResult[] = [];
    for (const row of working) {
      const isFree = placeOffersFreeParking(row);
      const isPaid = placeOffersPaidParking(row);
      const matches = parkingCost === "free" ? isFree : isPaid;
      if (matches) {
        kept.push(row);
        continue;
      }
      // Known opposite cost is a clean reject; missing flags → unknown drop note.
      const knownOpposite = parkingCost === "free" ? isPaid : isFree;
      if (!knownOpposite) {
        parkingCostUnknownDropped = true;
      }
    }
    working = kept;
    facts.parkingCostUnknownDropped = parkingCostUnknownDropped;
  }

  facts.results = working;

  if (providerPageSaturated) {
    facts.providerPartial = true;
  }
  return facts;
}

function formatTriLine(label: string, value: TriState): string | null {
  if (value === true) {
    return `${label}: כן`;
  }
  if (value === false) {
    return `${label}: לא`;
  }
  return null;
}

/** Known attribute lines only — omit the whole block when Google returned nothing. */
function formatAttrBlock(
  title: string,
  lines: Array<string | null>,
): string | null {
  const known = lines.filter((line): line is string => Boolean(line));
  if (known.length === 0) {
    return null;
  }
  return [title, ...known.map((line) => `• ${line}`)].join("\n");
}

function formatAttributeSections(
  row: PlaceResult,
  aspects: PlacesAspect[],
  intent: PlacesIntent = "business",
): string[] {
  const out: string[] = [];
  if (wantsParkingDetails(aspects, intent)) {
    const p = row.parking;
    const block = formatAttrBlock(
      "חניה",
      p
        ? [
            formatTriLine("חניון חינם", p.freeLot),
            formatTriLine("חניון בתשלום", p.paidLot),
            formatTriLine("רחוב חינם", p.freeStreet),
            formatTriLine("רחוב בתשלום", p.paidStreet),
            formatTriLine("שירות חניה", p.valet),
            formatTriLine("חניון מקורה חינם", p.freeGarage),
            formatTriLine("חניון מקורה בתשלום", p.paidGarage),
          ]
        : [],
    );
    if (block) {
      out.push(block);
    }
    // Ownership is never in Google ParkingOptions — omit (do not print unknown).
  }
  if (wantsAttr(aspects, "accessibility")) {
    const a = row.accessibility;
    const block = formatAttrBlock(
      "נגישות",
      a
        ? [
            formatTriLine("חניה לנכים", a.wheelchairParking),
            formatTriLine("כניסה לנכים", a.wheelchairEntrance),
            formatTriLine("שירותים לנכים", a.wheelchairRestroom),
            formatTriLine("ישיבה לנכים", a.wheelchairSeating),
          ]
        : [],
    );
    if (block) {
      out.push(block);
    }
  }
  if (wantsAttr(aspects, "outdoor")) {
    if (row.outdoorSeating === true) {
      out.push("ישיבה בחוץ: כן");
    } else if (row.outdoorSeating === false) {
      out.push("ישיבה בחוץ: לא");
    }
  }
  if (wantsAttr(aspects, "children")) {
    if (row.goodForChildren === true) {
      out.push("מתאים לילדים: כן");
    } else if (row.goodForChildren === false) {
      out.push("מתאים לילדים: לא");
    }
  }
  if (wantsAttr(aspects, "payment")) {
    const p = row.payment;
    const block = formatAttrBlock(
      "תשלום",
      p
        ? [
            formatTriLine("כרטיסי אשראי", p.creditCards),
            formatTriLine("כרטיסי חיוב", p.debitCards),
            formatTriLine("מזומן בלבד", p.cashOnly),
            formatTriLine("תשלום קרבה (NFC)", p.nfc),
          ]
        : [],
    );
    if (block) {
      out.push(block);
    }
  }
  return out;
}

function formatOnePlace(
  row: PlaceResult,
  aspects: PlacesAspect[],
  intent: PlacesIntent = "business",
): string {
  const phoneOnly =
    intent !== "parking" &&
    aspects.includes("phone") &&
    !aspects.includes("summary") &&
    aspects.length === 1;
  const addressOnly =
    intent !== "parking" &&
    aspects.includes("address") &&
    !aspects.includes("summary") &&
    aspects.length === 1;
  const hoursOnly =
    intent !== "parking" &&
    aspects.includes("hours") &&
    !aspects.includes("summary") &&
    aspects.length === 1;

  if (phoneOnly) {
    const lines = [`*${row.name}*`];
    lines.push(row.phone ? `טלפון: ${row.phone}` : "אין טלפון זמין.");
    if (row.address) {
      lines.push(`כתובת: ${row.address}`);
    }
    if (row.postalCode) {
      lines.push(`מיקוד: ${row.postalCode}`);
    }
    return lines.join("\n");
  }

  if (addressOnly) {
    const lines = [`*${row.name}*`];
    lines.push(row.address ? `כתובת: ${row.address}` : "אין כתובת זמינה.");
    if (row.postalCode) {
      lines.push(`מיקוד: ${row.postalCode}`);
    }
    if (row.phone) {
      lines.push(`טלפון: ${row.phone}`);
    }
    return lines.join("\n");
  }

  if (hoursOnly) {
    const lines = [`*${row.name}*`];
    if (row.openNow === true) {
      lines.push("פתוח עכשיו.");
    } else if (row.openNow === false) {
      lines.push("סגור עכשיו.");
    }
    if (row.weekdayHours.length > 0) {
      lines.push(...row.weekdayHours.slice(0, 7).map((h) => `• ${h}`));
    } else {
      lines.push("אין שעות פעילות זמינות.");
    }
    return lines.join("\n");
  }

  const lines: string[] = [`*${row.name}*`];
  if (row.rating != null) {
    lines.push(`דירוג: ${row.rating}`);
  }
  if (wants(aspects, "phone") && row.phone) {
    lines.push(`טלפון: ${row.phone}`);
  }
  if (wants(aspects, "address") && row.address) {
    lines.push(`כתובת: ${row.address}`);
  }
  if (row.postalCode) {
    lines.push(`מיקוד: ${row.postalCode}`);
  }
  if (wants(aspects, "hours")) {
    if (row.openNow === true) {
      lines.push("פתוח עכשיו");
    } else if (row.openNow === false) {
      lines.push("סגור עכשיו");
    }
    if (aspects.includes("hours") && row.weekdayHours.length > 0) {
      lines.push(...row.weekdayHours.slice(0, 3).map((h) => `• ${h}`));
    }
  }
  lines.push(...formatAttributeSections(row, aspects, intent));
  return lines.join("\n");
}

function hasRequestSideFiltersOnFacts(facts: PlacesFacts): boolean {
  return hasPlacesRequestSideFilters({
    openNowFilter: facts.openNowFilter,
    minRating: facts.minRating,
    includedType: facts.includedType,
    parkingCost: facts.parkingCost,
  });
}

/** Deterministic Hebrew reply from Places facts (engine replaces model response). */
export function formatPlacesHebrew(facts: PlacesFacts): string {
  const where = facts.place.trim() || (facts.nearSpeaker ? "האזור שלך" : "");
  if (!facts.query.trim() || !where) {
    return "מה לחפש ואיפה? (למשל חשמלאי בפתח תקווה — או שלח מיקום לוואטסאפ ל«באזור שלי»)";
  }
  const filterSummary = formatPlacesFilterSummary(facts);
  const filterLine = filterSummary ? `סינון: ${filterSummary}` : "";
  const requestFilters = hasRequestSideFiltersOnFacts(facts);
  const saturated = facts.providerPartial === true;
  const kept = facts.results.length;

  if (kept === 0) {
    const emptyBits = filterSummary ? ` (${filterSummary})` : "";
    if (saturated && requestFilters) {
      const notes = [PLACES_FILTERED_SATURATED_EMPTY_HE];
      if (facts.minRatingUnknownDropped) {
        notes.push(PLACES_MIN_RATING_UNKNOWN_DROPPED_HE);
      }
      if (facts.parkingCostUnknownDropped) {
        notes.push(PLACES_PARKING_COST_UNKNOWN_DROPPED_HE);
      }
      return (
        `לא הוצגו תוצאות מתאימות בדף החיפוש עבור «${facts.query}» ב«${where}»${emptyBits}.\n` +
        notes.join("\n")
      );
    }
    const empty = `לא מצאתי תוצאות עבור «${facts.query}» ב«${where}»${emptyBits}.`;
    const emptyNotes: string[] = [];
    if (facts.minRatingUnknownDropped) {
      emptyNotes.push(PLACES_MIN_RATING_UNKNOWN_DROPPED_HE);
    }
    if (facts.parkingCostUnknownDropped) {
      emptyNotes.push(PLACES_PARKING_COST_UNKNOWN_DROPPED_HE);
    }
    return emptyNotes.length > 0
      ? `${empty}\n${emptyNotes.join("\n")}`
      : empty;
  }

  const intent = facts.intent ?? "business";
  const blocks = facts.results.map((row) =>
    formatOnePlace(row, facts.aspects, intent),
  );
  let body: string;
  if (kept === 1) {
    body = filterLine ? `${blocks[0]!}\n${filterLine}` : blocks[0]!;
  } else {
    const head = `מצאתי ${kept} תוצאות ל«${facts.query}» ב«${where}»:`;
    body = filterLine
      ? `${head}\n${filterLine}\n\n${blocks.join("\n\n")}`
      : `${head}\n\n${blocks.join("\n\n")}`;
  }

  const notes: string[] = [];
  if (saturated && requestFilters && kept <= PLACES_SPARSE_RESULT_THRESHOLD) {
    notes.push(PLACES_FILTERED_SATURATED_SPARSE_HE);
  } else if (saturated) {
    notes.push(PLACES_PROVIDER_PARTIAL_HE);
  }
  if (facts.minRatingUnknownDropped) {
    notes.push(PLACES_MIN_RATING_UNKNOWN_DROPPED_HE);
  }
  if (facts.parkingCostUnknownDropped) {
    notes.push(PLACES_PARKING_COST_UNKNOWN_DROPPED_HE);
  }
  return notes.length > 0 ? `${body}\n${notes.join("\n")}` : body;
}

export async function resolvePlacesReply(input: {
  query: string;
  place: string;
  aspects?: PlacesAspect[] | unknown;
  intent?: PlacesIntent | unknown;
  lat?: number | null;
  lng?: number | null;
  nearSpeaker?: boolean;
  openNow?: boolean | null;
  minRating?: number | null;
  includedType?: string | null;
  radiusMeters?: number | null;
  parkingCost?: LlmPlacesParkingCost | unknown;
  radiusExplicit?: boolean;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
}): Promise<string> {
  const query = String(input.query ?? "").trim();
  const place = String(input.place ?? "").trim();
  const hasPin =
    input.lat != null &&
    input.lng != null &&
    Number.isFinite(input.lat) &&
    Number.isFinite(input.lng);
  if (!query || (!place && !hasPin && !input.nearSpeaker)) {
    return "מה לחפש ואיפה? (למשל חשמלאי בפתח תקווה — או שלח מיקום לוואטסאפ ל«באזור שלי»)";
  }
  if ((input.nearSpeaker || !place) && !hasPin) {
    return "שלח מיקום בוואטסאפ (סיכת מיקום) ואחפש באזור שלך.";
  }
  try {
    const facts = await fetchPlacesFacts(input);
    return formatPlacesHebrew(facts);
  } catch (error) {
    if (error instanceof Error && error.message === PLACES_API_KEY_MISSING) {
      return "חיפוש עסקים לא מוגדר כרגע (חסר מפתח Google Places).";
    }
    if (error instanceof Error && error.message === PLACES_API_DENIED) {
      return "חיפוש עסקים בגוגל לא מופעל למפתח הזה (צריך Places API New).";
    }
    return "לא הצלחתי לחפש עכשיו בגוגל. נסה שוב בעוד רגע.";
  }
}
