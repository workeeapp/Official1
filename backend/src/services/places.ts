import { getEnv } from "../config/env.js";

export type PlacesAspect = "summary" | "phone" | "address" | "hours";

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
};

export type PlacesFacts = {
  query: string;
  place: string;
  nearSpeaker: boolean;
  aspects: PlacesAspect[];
  results: PlaceResult[];
};

const ASPECT_SET = new Set<PlacesAspect>([
  "summary",
  "phone",
  "address",
  "hours",
]);

/** Places API (New) — Text Search. */
const SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";

const FIELD_MASK = [
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
].join(",");

const MAX_RESULTS = 3;

export const PLACES_API_KEY_MISSING = "places_api_key_missing";
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

type NewAddressComponent = {
  longText?: string;
  shortText?: string;
  types?: string[];
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

const NEARBY_RADIUS_METERS = 1500;

export async function fetchPlacesFacts(input: {
  query: string;
  place: string;
  aspects?: PlacesAspect[] | unknown;
  lat?: number | null;
  lng?: number | null;
  nearSpeaker?: boolean;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
}): Promise<PlacesFacts> {
  const query = String(input.query ?? "").trim();
  const place = String(input.place ?? "").trim();
  const aspects = parsePlacesAspects(input.aspects);
  const lat =
    input.lat != null && Number.isFinite(input.lat) ? input.lat : null;
  const lng =
    input.lng != null && Number.isFinite(input.lng) ? input.lng : null;
  const nearSpeaker =
    Boolean(input.nearSpeaker) || (lat != null && lng != null && !place);
  const facts: PlacesFacts = {
    query,
    place: nearSpeaker ? place || "האזור שלך" : place,
    nearSpeaker,
    aspects,
    results: [],
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
    maxResultCount: MAX_RESULTS,
  };
  if (lat != null && lng != null) {
    body.locationBias = {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: NEARBY_RADIUS_METERS,
      },
    };
  }
  const searchRes = await fetchImpl(SEARCH_TEXT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
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
  for (const row of places.slice(0, MAX_RESULTS)) {
    const mapped = mapNewPlace(row);
    if (mapped) {
      facts.results.push(mapped);
    }
  }
  return facts;
}

function formatOnePlace(row: PlaceResult, aspects: PlacesAspect[]): string {
  const phoneOnly =
    aspects.includes("phone") &&
    !aspects.includes("summary") &&
    aspects.length === 1;
  const addressOnly =
    aspects.includes("address") &&
    !aspects.includes("summary") &&
    aspects.length === 1;
  const hoursOnly =
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
  // Always show postal when Google provided it (plan requirement).
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
  return lines.join("\n");
}

/** Deterministic Hebrew reply from Places facts (engine replaces model response). */
export function formatPlacesHebrew(facts: PlacesFacts): string {
  const where = facts.place.trim() || (facts.nearSpeaker ? "האזור שלך" : "");
  if (!facts.query.trim() || !where) {
    return "מה לחפש ואיפה? (למשל חשמלאי בפתח תקווה — או שלח מיקום לוואטסאפ ל«באזור שלי»)";
  }
  if (facts.results.length === 0) {
    return `לא מצאתי תוצאות עבור «${facts.query}» ב«${where}».`;
  }
  const blocks = facts.results.map((row) => formatOnePlace(row, facts.aspects));
  if (facts.results.length === 1) {
    return blocks[0]!;
  }
  return `מצאתי ${facts.results.length} תוצאות ל«${facts.query}» ב«${where}»:\n\n${blocks.join("\n\n")}`;
}

export async function resolvePlacesReply(input: {
  query: string;
  place: string;
  aspects?: PlacesAspect[] | unknown;
  lat?: number | null;
  lng?: number | null;
  nearSpeaker?: boolean;
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
