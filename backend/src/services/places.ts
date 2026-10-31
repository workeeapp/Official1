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
import { createHash } from "node:crypto";
import { getEnv } from "../config/env.js";
import type { ComposeLlmBilling } from "./llm-usage.service.js";
import {
  formatLiveSelectFailureReply,
  LIVE_SELECT_NO_MATCH_HE,
  runLivePostSelect,
  type LiveRetrievalRecord,
  type LiveSelectApplyResult,
} from "./live-retrieval-select.js";
import {
  geographicAreaFromViewportBox,
  isValidGeoAreaGeometry,
  pointInAreaGeometry,
  type GeoAreaGeometry,
  type ResolvedGeographicArea,
} from "./geo-area.js";
import { resolveGeographicArea } from "./resolve-geographic-area.js";
import type { ResolvedViewport } from "./resolved-location.js";

/** Map facade area → Places rectangle+PIP viewport (same fields Places already consumes). */
function areaViewportFromGeographicArea(
  area: ResolvedGeographicArea,
): ResolvedViewport {
  return {
    low: area.bbox.low,
    high: area.bbox.high,
    label: area.label,
    source: area.source,
    geometry: area.geometry,
  };
}

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
  /** Stable id for post-retrieval live_select (Google place id, or local fallback). */
  id: string;
  name: string;
  phone: string;
  address: string;
  /** Israeli / Google postal_code when present — always shown in format. */
  postalCode: string;
  rating: number | null;
  openNow: boolean | null;
  weekdayHours: string[];
  mapsUrl: string;
  /** WGS84 from Places `location` when present (needed for area polygon filter). */
  lat: number | null;
  lng: number | null;
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
  /**
   * True when area_restrict polygon filter dropped rows (outside / missing coords).
   * Does not invent replacements — kept set may be sparse.
   */
  areaPolygonFiltered?: boolean;
};

/**
 * area_restrict: Places Text Search has no next-page beyond this many fetches.
 * One optional follow-up page only when the first page was saturated and
 * polygon filtering removed candidates (never unbounded).
 */
export const PLACES_AREA_RESTRICT_MAX_PAGES = 2;

/**
 * Caution when polygon filter ran on a saturated provider page — coverage
 * of the named region is not guaranteed (bbox candidates may crowd out
 * in-polygon hits).
 */
export const PLACES_AREA_POLYGON_PARTIAL_HE =
  "(ייתכן שהרשימה חלקית לאזור — מועמדים מחוץ לגבול האמיתי תפסו מקום בדף הספק.)";

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

/** Required for area_restrict point-in-polygon post-filter. */
export const PLACES_LOCATION_FIELD = "places.location";

/**
 * Build FieldMask: base always; Atmosphere/Pro attribute fields only when asked.
 * Parking intent also requests parkingOptions (without changing the base mask).
 * areaRestrict adds places.location for polygon filtering (Places-specific).
 */
export function buildPlacesFieldMask(
  aspects: PlacesAspect[],
  intent: PlacesIntent = "business",
  opts?: { areaRestrict?: boolean },
): string {
  const fields = new Set<string>(PLACES_BASE_FIELD_MASK);
  if (opts?.areaRestrict === true) {
    fields.add(PLACES_LOCATION_FIELD);
  }
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
  location?: { latitude?: number; longitude?: number };
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
  nextPageToken?: string;
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

function mintPlaceFallbackId(parts: {
  name: string;
  address: string;
  mapsUrl: string;
}): string {
  return createHash("sha256")
    .update(`${parts.name}|${parts.address}|${parts.mapsUrl}`)
    .digest("hex")
    .slice(0, 24);
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
  const googleId = String(row.id ?? "").trim();
  const latRaw = row.location?.latitude;
  const lngRaw = row.location?.longitude;
  const lat =
    typeof latRaw === "number" &&
    Number.isFinite(latRaw) &&
    latRaw >= -90 &&
    latRaw <= 90
      ? latRaw
      : null;
  const lng =
    typeof lngRaw === "number" &&
    Number.isFinite(lngRaw) &&
    lngRaw >= -180 &&
    lngRaw <= 180
      ? lngRaw
      : null;
  return {
    id:
      googleId ||
      mintPlaceFallbackId({ name, address, mapsUrl }),
    name,
    phone,
    address,
    postalCode,
    rating,
    openNow,
    weekdayHours,
    mapsUrl,
    lat,
    lng,
    parking: mapParking(row.parkingOptions),
    accessibility: mapAccessibility(row.accessibilityOptions),
    outdoorSeating: triFromUnknown(row.outdoorSeating),
    goodForChildren: triFromUnknown(row.goodForChildren),
    payment: mapPayment(row.paymentOptions),
  };
}

/**
 * Ensure area_restrict viewport carries geometry (synthesize rectangle when
 * a test stub / Google path omitted it). Invalid → null (fail closed).
 */
export function geometryForAreaViewport(
  vp: ResolvedViewport | null | undefined,
): GeoAreaGeometry | null {
  if (!vp) {
    return null;
  }
  if (vp.geometry && isValidGeoAreaGeometry(vp.geometry)) {
    return vp.geometry;
  }
  const area = geographicAreaFromViewportBox({
    label: vp.label || "area",
    low: vp.low,
    high: vp.high,
    source: vp.source === "osm_nominatim" ? "osm_nominatim" : "geocode_viewport",
  });
  return area?.geometry ?? null;
}

/**
 * Keep only places with coords inside the area geometry.
 * Missing coords or outside → drop (fail closed). Does not invent rows.
 */
export function filterPlacesByAreaGeometry(
  rows: PlaceResult[],
  geometry: GeoAreaGeometry,
): { kept: PlaceResult[]; dropped: number } {
  if (!isValidGeoAreaGeometry(geometry)) {
    return { kept: [], dropped: rows.length };
  }
  const kept: PlaceResult[] = [];
  let dropped = 0;
  for (const row of rows) {
    if (row.lat == null || row.lng == null) {
      dropped += 1;
      continue;
    }
    if (pointInAreaGeometry(row.lat, row.lng, geometry)) {
      kept.push(row);
    } else {
      dropped += 1;
    }
  }
  return { kept, dropped };
}

/** Compact rows for Stage B live_select (fields returned this turn). */
export function placesToLiveRetrievalRecords(
  facts: PlacesFacts,
): LiveRetrievalRecord[] {
  const aspects = new Set(facts.aspects);
  const intent = facts.intent ?? "business";
  return facts.results.map((row) => {
    const fields: Record<string, unknown> = {
      name: row.name,
      address: row.address,
      postal_code: row.postalCode || null,
      rating: row.rating,
      open_now: row.openNow,
      maps_url: row.mapsUrl || null,
    };
    if (aspects.has("phone") || aspects.has("summary")) {
      fields.phone = row.phone || null;
    }
    if (aspects.has("hours") || aspects.has("summary")) {
      fields.weekday_hours = row.weekdayHours;
    }
    if (intent === "parking" || aspects.has("parking")) {
      fields.parking = row.parking
        ? {
            free_lot: row.parking.freeLot,
            paid_lot: row.parking.paidLot,
            free_street: row.parking.freeStreet,
            paid_street: row.parking.paidStreet,
            valet: row.parking.valet,
            free_garage: row.parking.freeGarage,
            paid_garage: row.parking.paidGarage,
          }
        : null;
    }
    if (aspects.has("accessibility")) {
      fields.accessibility = row.accessibility
        ? {
            wheelchair_entrance: row.accessibility.wheelchairEntrance,
            wheelchair_parking: row.accessibility.wheelchairParking,
            wheelchair_restroom: row.accessibility.wheelchairRestroom,
            wheelchair_seating: row.accessibility.wheelchairSeating,
          }
        : null;
    }
    if (aspects.has("outdoor")) {
      fields.outdoor_seating = row.outdoorSeating;
    }
    if (aspects.has("children")) {
      fields.good_for_children = row.goodForChildren;
    }
    if (aspects.has("payment")) {
      fields.payment = row.payment
        ? {
            credit_cards: row.payment.creditCards,
            debit_cards: row.payment.debitCards,
            cash_only: row.payment.cashOnly,
            nfc: row.payment.nfc,
          }
        : null;
    }
    return {
      id: row.id,
      label: row.name,
      fields,
    };
  });
}

export function filterPlacesFactsByIds(
  facts: PlacesFacts,
  ids: string[],
): PlacesFacts {
  const kept = new Set(ids);
  return {
    ...facts,
    results: facts.results.filter((row) => kept.has(row.id)),
  };
}

function placesCompletenessNotes(facts: PlacesFacts): string[] {
  const requestFilters = hasRequestSideFiltersOnFacts(facts);
  const saturated = facts.providerPartial === true;
  const kept = facts.results.length;
  const notes: string[] = [];
  if (saturated && requestFilters && kept === 0) {
    notes.push(PLACES_FILTERED_SATURATED_EMPTY_HE);
  } else if (
    saturated &&
    requestFilters &&
    kept > 0 &&
    kept <= PLACES_SPARSE_RESULT_THRESHOLD
  ) {
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
  return notes;
}

/** Apply Stage B outcome onto Places facts and format Hebrew. */
export function formatPlacesAfterLiveSelect(
  facts: PlacesFacts,
  outcome: LiveSelectApplyResult,
): string {
  if (outcome.kind === "failure") {
    const raw = formatPlacesHebrew(facts);
    return formatLiveSelectFailureReply(raw, {
      includeUnfiltered: outcome.mayShowUnfilteredLabeled,
    });
  }
  if (outcome.kind === "no_match") {
    const base = outcome.messageHe?.trim() || LIVE_SELECT_NO_MATCH_HE;
    const notes = placesCompletenessNotes({ ...facts, results: [] });
    return notes.length > 0 ? `${base}\n${notes.join("\n")}` : base;
  }
  if (outcome.kind === "subset") {
    const filtered = filterPlacesFactsByIds(facts, outcome.keptIds);
    return formatPlacesHebrew(filtered);
  }
  return formatPlacesHebrew(facts);
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
  /**
   * Hard inside-area search (B2a). When set with a valid viewport, sends
   * locationRestriction only — never locationBias / DISTANCE / pending pin.
   */
  areaRestrict?: boolean;
  areaViewport?: ResolvedViewport | null;
  openNow?: boolean | null;
  minRating?: number | null;
  includedType?: string | null;
  radiusMeters?: number | null;
  /** True when ACTION explicitly set radius_meters (vs engine default bias). */
  radiusExplicit?: boolean;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
}): Promise<PlacesFacts> {
  const query = String(input.query ?? "").trim();
  const place = String(input.place ?? "").trim();
  const aspects = parsePlacesAspects(input.aspects);
  const intent = normalizePlacesIntent(input.intent);
  const areaRestrict =
    input.areaRestrict === true && input.areaViewport != null;
  const latRaw =
    input.lat != null && Number.isFinite(input.lat) ? input.lat : null;
  const lngRaw =
    input.lng != null && Number.isFinite(input.lng) ? input.lng : null;
  // Area restrict never uses pin coords.
  const lat = areaRestrict
    ? null
    : latRaw != null && latRaw >= -90 && latRaw <= 90
      ? latRaw
      : null;
  const lng = areaRestrict
    ? null
    : lngRaw != null && lngRaw >= -180 && lngRaw <= 180
      ? lngRaw
      : null;
  // near=speaker OR explicit coords with empty place (pin-style ACTION).
  // Named place + leftover coords must NOT become nearSpeaker / locationBias.
  // area_restrict never becomes nearSpeaker.
  const nearSpeaker = areaRestrict
    ? false
    : Boolean(input.nearSpeaker) || (lat != null && lng != null && !place);
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
  // Bias only for intentional speaker/pin searches — never with area_restrict.
  const biasRadius =
    !areaRestrict && nearSpeaker && lat != null && lng != null
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
    place: nearSpeaker
      ? place || "האזור שלך"
      : areaRestrict
        ? input.areaViewport!.label || place
        : place,
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
  if (
    !query ||
    (areaRestrict
      ? !place
      : !place && (lat == null || lng == null))
  ) {
    return facts;
  }

  const apiKey =
    (input.apiKey ?? getEnv().GOOGLE_PLACES_API_KEY ?? "").trim() || null;
  if (!apiKey) {
    throw new Error(PLACES_API_KEY_MISSING);
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const areaGeometry = areaRestrict
    ? geometryForAreaViewport(input.areaViewport)
    : null;
  // Hard area without usable geometry → fail closed (no provider call leakage).
  if (areaRestrict && !areaGeometry) {
    facts.results = [];
    facts.areaPolygonFiltered = true;
    return facts;
  }

  // Hard area: category query only — region enforced by locationRestriction.
  // Soft named place: keep query+place text preference.
  const baseBody: Record<string, unknown> = {
    textQuery:
      areaRestrict
        ? query
        : place && !nearSpeaker
          ? `${query} ${place}`
          : query,
    languageCode: "he",
    regionCode: "IL",
    maxResultCount: requestedMax,
  };
  if (openNowFilter === true) {
    baseBody.openNow = true;
  }
  if (minRatingProvider != null) {
    baseBody.minRating = minRatingProvider;
  }
  if (includedType) {
    baseBody.includedType = includedType;
    baseBody.strictTypeFiltering = true;
  }
  if (areaRestrict && input.areaViewport) {
    const vp = input.areaViewport;
    baseBody.locationRestriction = {
      rectangle: {
        low: { latitude: vp.low.lat, longitude: vp.low.lng },
        high: { latitude: vp.high.lat, longitude: vp.high.lng },
      },
    };
    // Never pair with locationBias or DISTANCE.
  } else if (nearSpeaker && lat != null && lng != null && biasRadius != null) {
    baseBody.locationBias = {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: biasRadius,
      },
    };
    baseBody.rankPreference = "DISTANCE";
  }
  const fieldMask = buildPlacesFieldMask(aspects, intent, {
    areaRestrict,
  });

  async function searchTextPage(
    pageToken?: string,
  ): Promise<{
    places: NewPlace[];
    nextPageToken: string | null;
    saturated: boolean;
  }> {
    const body: Record<string, unknown> = { ...baseBody };
    if (pageToken) {
      body.pageToken = pageToken;
    }
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

    const pagePlaces = Array.isArray(searchJson.places)
      ? searchJson.places
      : [];
    const next =
      typeof searchJson.nextPageToken === "string" &&
      searchJson.nextPageToken.trim()
        ? searchJson.nextPageToken.trim()
        : null;
    return {
      places: pagePlaces.slice(0, requestedMax),
      nextPageToken: next,
      saturated: pagePlaces.length >= requestedMax,
    };
  }

  const firstPage = await searchTextPage();
  let providerPageSaturated = firstPage.saturated;

  function mapUnique(rows: NewPlace[], seen: Set<string>): PlaceResult[] {
    const out: PlaceResult[] = [];
    for (const row of rows) {
      const item = mapNewPlace(row);
      if (!item || seen.has(item.id)) {
        continue;
      }
      seen.add(item.id);
      out.push(item);
    }
    return out;
  }

  const seenIds = new Set<string>();
  let working = mapUnique(firstPage.places, seenIds);
  let areaPolygonFiltered = false;

  if (areaRestrict && areaGeometry) {
    const firstFilter = filterPlacesByAreaGeometry(working, areaGeometry);
    areaPolygonFiltered = firstFilter.dropped > 0;
    working = firstFilter.kept;

    // One optional follow-up page only when the first page was full AND
    // polygon drops removed candidates (outside-bbox leakage into the quota).
    if (
      firstPage.saturated &&
      firstFilter.dropped > 0 &&
      firstPage.nextPageToken &&
      PLACES_AREA_RESTRICT_MAX_PAGES > 1
    ) {
      const second = await searchTextPage(firstPage.nextPageToken);
      if (second.saturated || second.nextPageToken) {
        providerPageSaturated = true;
      }
      const secondMapped = mapUnique(second.places, seenIds);
      const secondFilter = filterPlacesByAreaGeometry(
        secondMapped,
        areaGeometry,
      );
      if (secondFilter.dropped > 0) {
        areaPolygonFiltered = true;
      }
      working = working.concat(secondFilter.kept);
    }
    facts.areaPolygonFiltered = areaPolygonFiltered;
  }

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
      if (facts.areaPolygonFiltered) {
        notes.push(PLACES_AREA_POLYGON_PARTIAL_HE);
      }
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
    if (saturated && facts.areaPolygonFiltered) {
      emptyNotes.push(PLACES_AREA_POLYGON_PARTIAL_HE);
    }
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
  if (facts.areaPolygonFiltered && saturated) {
    notes.push(PLACES_AREA_POLYGON_PARTIAL_HE);
  }
  if (facts.minRatingUnknownDropped) {
    notes.push(PLACES_MIN_RATING_UNKNOWN_DROPPED_HE);
  }
  if (facts.parkingCostUnknownDropped) {
    notes.push(PLACES_PARKING_COST_UNKNOWN_DROPPED_HE);
  }
  return notes.length > 0 ? `${body}\n${notes.join("\n")}` : body;
}

export type PlacesReplyResult = {
  text: string;
  /** True when a near=speaker search successfully used pin/ACTION coords. */
  usedPendingPin: boolean;
  /** True when reply only asks for a WhatsApp pin / place (no provider call). */
  needsLocation: boolean;
};

export async function resolvePlacesReplyDetailed(input: {
  query: string;
  place: string;
  aspects?: PlacesAspect[] | unknown;
  intent?: PlacesIntent | unknown;
  lat?: number | null;
  lng?: number | null;
  nearSpeaker?: boolean;
  /** Hard inside-area mode (ACTION geo_mode=area_restrict). */
  areaRestrict?: boolean;
  openNow?: boolean | null;
  minRating?: number | null;
  includedType?: string | null;
  radiusMeters?: number | null;
  parkingCost?: LlmPlacesParkingCost | unknown;
  radiusExplicit?: boolean;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
  /** When true and rows exist, run same-turn live_select (Stage B). */
  requireLiveSelect?: boolean;
  speakerAsk?: string;
  billing?: ComposeLlmBilling | null;
  runSelect?: typeof runLivePostSelect;
  /** Injected for tests — default resolveGeographicArea. */
  resolveArea?: typeof resolveGeographicArea;
}): Promise<PlacesReplyResult> {
  const query = String(input.query ?? "").trim();
  const place = String(input.place ?? "").trim();
  const areaRestrict = input.areaRestrict === true;
  const hasPin =
    !areaRestrict &&
    input.lat != null &&
    input.lng != null &&
    Number.isFinite(input.lat) &&
    Number.isFinite(input.lng) &&
    (input.lat as number) >= -90 &&
    (input.lat as number) <= 90 &&
    (input.lng as number) >= -180 &&
    (input.lng as number) <= 180;
  const nearSpeaker = areaRestrict ? false : Boolean(input.nearSpeaker);
  if (!query || (!place && !hasPin && !nearSpeaker)) {
    return {
      text: "מה לחפש ואיפה? (למשל חשמלאי בפתח תקווה — או שלח מיקום לוואטסאפ ל«באזור שלי»)",
      usedPendingPin: false,
      needsLocation: true,
    };
  }
  if (areaRestrict && !place) {
    return {
      text: "לאיזה אזור לחפש? (למשל השרון / גוש דן)",
      usedPendingPin: false,
      needsLocation: true,
    };
  }
  if ((nearSpeaker || !place) && !hasPin) {
    return {
      text: "שלח מיקום בוואטסאפ (סיכת מיקום) ואחפש באזור שלך.",
      usedPendingPin: false,
      needsLocation: true,
    };
  }

  let areaViewport: ResolvedViewport | null = null;
  if (areaRestrict) {
    const resolveArea = input.resolveArea ?? resolveGeographicArea;
    const resolved = await resolveArea({
      place,
      fetchImpl: input.fetchImpl,
      apiKey: input.apiKey,
    });
    if (!resolved.ok) {
      return {
        text: resolved.messageHe,
        usedPendingPin: false,
        needsLocation: true,
      };
    }
    areaViewport = areaViewportFromGeographicArea(resolved.area);
  }

  try {
    const facts = await fetchPlacesFacts({
      ...input,
      nearSpeaker,
      lat: areaRestrict ? null : input.lat,
      lng: areaRestrict ? null : input.lng,
      areaRestrict,
      areaViewport,
    });
    const text =
      !input.requireLiveSelect || facts.results.length === 0
        ? formatPlacesHebrew(facts)
        : formatPlacesAfterLiveSelect(
            facts,
            await (input.runSelect ?? runLivePostSelect)({
              domain: "places",
              records: placesToLiveRetrievalRecords(facts),
              speakerAsk: input.speakerAsk ?? "",
              billing: input.billing ?? null,
            }),
          );
    return {
      text,
      usedPendingPin: nearSpeaker && hasPin,
      needsLocation: false,
    };
  } catch (error) {
    if (error instanceof Error && error.message === PLACES_API_KEY_MISSING) {
      return {
        text: "חיפוש עסקים לא מוגדר כרגע (חסר מפתח Google Places).",
        usedPendingPin: false,
        needsLocation: false,
      };
    }
    if (error instanceof Error && error.message === PLACES_API_DENIED) {
      return {
        text: "חיפוש עסקים בגוגל לא מופעל למפתח הזה (צריך Places API New).",
        usedPendingPin: false,
        needsLocation: false,
      };
    }
    return {
      text: "לא הצלחתי לחפש עכשיו בגוגל. נסה שוב בעוד רגע.",
      usedPendingPin: false,
      needsLocation: false,
    };
  }
}

export async function resolvePlacesReply(input: {
  query: string;
  place: string;
  aspects?: PlacesAspect[] | unknown;
  intent?: PlacesIntent | unknown;
  lat?: number | null;
  lng?: number | null;
  nearSpeaker?: boolean;
  areaRestrict?: boolean;
  openNow?: boolean | null;
  minRating?: number | null;
  includedType?: string | null;
  radiusMeters?: number | null;
  parkingCost?: LlmPlacesParkingCost | unknown;
  radiusExplicit?: boolean;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
  /** When true and rows exist, run same-turn live_select (Stage B). */
  requireLiveSelect?: boolean;
  speakerAsk?: string;
  billing?: ComposeLlmBilling | null;
  runSelect?: typeof runLivePostSelect;
  resolveArea?: typeof resolveGeographicArea;
}): Promise<string> {
  return (await resolvePlacesReplyDetailed(input)).text;
}
