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
  aspects: PlacesAspect[];
  results: PlaceResult[];
};

const ASPECT_SET = new Set<PlacesAspect>([
  "summary",
  "phone",
  "address",
  "hours",
]);

const TEXT_SEARCH_URL =
  "https://maps.googleapis.com/maps/api/place/textsearch/json";
const DETAILS_URL =
  "https://maps.googleapis.com/maps/api/place/details/json";

const DETAIL_FIELDS = [
  "name",
  "formatted_phone_number",
  "international_phone_number",
  "formatted_address",
  "address_component",
  "opening_hours",
  "rating",
  "url",
].join(",");

const MAX_RESULTS = 3;

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

type TextResponse = {
  status?: string;
  error_message?: string;
  results?: Array<{ place_id?: string; name?: string }>;
};

type DetailsResponse = {
  status?: string;
  error_message?: string;
  result?: {
    name?: string;
    formatted_phone_number?: string;
    international_phone_number?: string;
    formatted_address?: string;
    address_components?: Array<{
      long_name?: string;
      short_name?: string;
      types?: string[];
    }>;
    opening_hours?: {
      open_now?: boolean;
      weekday_text?: string[];
    };
    rating?: number;
    url?: string;
  };
};

function postalFromComponents(
  components: DetailsResponse["result"] extends infer R
    ? R extends { address_components?: infer C }
      ? C
      : never
    : never,
): string {
  if (!Array.isArray(components)) {
    return "";
  }
  for (const row of components) {
    const types = Array.isArray(row?.types) ? row.types.map(String) : [];
    if (types.includes("postal_code")) {
      return String(row.long_name ?? row.short_name ?? "").trim();
    }
  }
  return "";
}

async function fetchPlaceDetails(
  placeId: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<PlaceResult | null> {
  const url = new URL(DETAILS_URL);
  url.searchParams.set("place_id", placeId);
  url.searchParams.set("fields", DETAIL_FIELDS);
  url.searchParams.set("language", "he");
  url.searchParams.set("key", apiKey);
  const res = await fetchImpl(url.toString());
  if (!res.ok) {
    throw new Error(`places details HTTP ${res.status}`);
  }
  const json = (await res.json()) as DetailsResponse;
  if (json.status && json.status !== "OK" && json.status !== "ZERO_RESULTS") {
    throw new Error(
      `places details ${json.status}${json.error_message ? `: ${json.error_message}` : ""}`,
    );
  }
  const row = json.result;
  if (!row) {
    return null;
  }
  const name = String(row.name ?? "").trim();
  if (!name) {
    return null;
  }
  const phone =
    String(row.formatted_phone_number ?? "").trim() ||
    String(row.international_phone_number ?? "").trim();
  const address = String(row.formatted_address ?? "").trim();
  const postalCode = postalFromComponents(row.address_components);
  const rating =
    typeof row.rating === "number" && Number.isFinite(row.rating)
      ? row.rating
      : null;
  const openNow =
    typeof row.opening_hours?.open_now === "boolean"
      ? row.opening_hours.open_now
      : null;
  const weekdayHours = Array.isArray(row.opening_hours?.weekday_text)
    ? row.opening_hours!.weekday_text!.map((line) => String(line).trim()).filter(Boolean)
    : [];
  const mapsUrl = String(row.url ?? "").trim();
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

export async function fetchPlacesFacts(input: {
  query: string;
  place: string;
  aspects?: PlacesAspect[] | unknown;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
}): Promise<PlacesFacts> {
  const query = String(input.query ?? "").trim();
  const place = String(input.place ?? "").trim();
  const aspects = parsePlacesAspects(input.aspects);
  const facts: PlacesFacts = { query, place, aspects, results: [] };
  if (!query || !place) {
    return facts;
  }

  const apiKey =
    (input.apiKey ?? getEnv().GOOGLE_PLACES_API_KEY ?? "").trim() || null;
  if (!apiKey) {
    throw new Error("places_api_key_missing");
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const searchUrl = new URL(TEXT_SEARCH_URL);
  searchUrl.searchParams.set("query", `${query} ${place}`);
  searchUrl.searchParams.set("language", "he");
  searchUrl.searchParams.set("region", "il");
  searchUrl.searchParams.set("key", apiKey);

  const searchRes = await fetchImpl(searchUrl.toString());
  if (!searchRes.ok) {
    throw new Error(`places search HTTP ${searchRes.status}`);
  }
  const searchJson = (await searchRes.json()) as SearchResponse;
  if (
    searchJson.status &&
    searchJson.status !== "OK" &&
    searchJson.status !== "ZERO_RESULTS"
  ) {
    throw new Error(
      `places search ${searchJson.status}${searchJson.error_message ? `: ${searchJson.error_message}` : ""}`,
    );
  }

  const ids = (searchJson.results ?? [])
    .map((row) => String(row.place_id ?? "").trim())
    .filter(Boolean)
    .slice(0, MAX_RESULTS);

  for (const placeId of ids) {
    const detail = await fetchPlaceDetails(placeId, apiKey, fetchImpl);
    if (detail) {
      facts.results.push(detail);
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
  if (!facts.query.trim() || !facts.place.trim()) {
    return "מה לחפש ואיפה? (למשל חשמלאי בפתח תקווה)";
  }
  if (facts.results.length === 0) {
    return `לא מצאתי תוצאות עבור «${facts.query}» ב«${facts.place}».`;
  }
  const blocks = facts.results.map((row) => formatOnePlace(row, facts.aspects));
  if (facts.results.length === 1) {
    return blocks[0]!;
  }
  return `מצאתי ${facts.results.length} תוצאות ל«${facts.query}» ב«${facts.place}»:\n\n${blocks.join("\n\n")}`;
}

export async function resolvePlacesReply(input: {
  query: string;
  place: string;
  aspects?: PlacesAspect[] | unknown;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
}): Promise<string> {
  const query = String(input.query ?? "").trim();
  const place = String(input.place ?? "").trim();
  if (!query || !place) {
    return "מה לחפש ואיפה? (למשל חשמלאי בפתח תקווה)";
  }
  try {
    const facts = await fetchPlacesFacts(input);
    return formatPlacesHebrew(facts);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "places_api_key_missing"
    ) {
      return "חיפוש עסקים לא מוגדר כרגע (חסר מפתח Google Places).";
    }
    return "לא הצלחתי לחפש עכשיו בגוגל. נסה שוב בעוד רגע.";
  }
}
