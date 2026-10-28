/**
 * Resolve a named place/region to a Google Geocoding viewport (B2a).
 * Used only for Places geo_mode=area_restrict — fail closed on ambiguity.
 * Reuses GOOGLE_PLACES_API_KEY (Geocoding API must be enabled on that key).
 */
import { getEnv } from "../config/env.js";
import {
  isValidViewport,
  type ResolvedViewport,
} from "./resolved-location.js";

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

export const GEOCODE_VIEWPORT_API_KEY_MISSING =
  "geocode_viewport_api_key_missing";

export type GeocodeViewportResult =
  | { ok: true; viewport: ResolvedViewport }
  | {
      ok: false;
      kind: "missing_key" | "none" | "ambiguous" | "invalid" | "error";
      messageHe: string;
    };

type GeocodeLatLng = { lat?: number; lng?: number };
type GeocodeViewportJson = {
  southwest?: GeocodeLatLng;
  northeast?: GeocodeLatLng;
};
type GeocodeGeometry = {
  location?: GeocodeLatLng;
  viewport?: GeocodeViewportJson;
  bounds?: GeocodeViewportJson;
};
type GeocodeResultRow = {
  formatted_address?: string;
  partial_match?: boolean;
  geometry?: GeocodeGeometry;
};
type GeocodeApiResponse = {
  status?: string;
  results?: GeocodeResultRow[];
  error_message?: string;
};

function resolveGeocodeApiKey(apiKey?: string | null): string | null {
  // Explicit apiKey (incl. "") wins — same contract as Places adapter tests.
  if (apiKey !== undefined && apiKey !== null) {
    return apiKey.trim() || null;
  }
  return (getEnv().GOOGLE_PLACES_API_KEY ?? "").trim() || null;
}

function viewportFromGeometry(
  geometry: GeocodeGeometry | undefined,
  label: string,
): ResolvedViewport | null {
  const box = geometry?.viewport ?? geometry?.bounds;
  const sw = box?.southwest;
  const ne = box?.northeast;
  if (
    typeof sw?.lat !== "number" ||
    typeof sw?.lng !== "number" ||
    typeof ne?.lat !== "number" ||
    typeof ne?.lng !== "number"
  ) {
    return null;
  }
  const candidate = {
    low: { lat: sw.lat, lng: sw.lng },
    high: { lat: ne.lat, lng: ne.lng },
  };
  if (!isValidViewport(candidate)) {
    return null;
  }
  return {
    ...candidate,
    label,
    source: "geocode_viewport",
  };
}

/**
 * Single clear Geocoding hit → viewport.
 * 0 hits / partial_match / multiple results / invalid box → fail closed.
 */
export async function resolvePlaceViewport(input: {
  place: string;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
}): Promise<GeocodeViewportResult> {
  const place = String(input.place ?? "").trim();
  if (!place) {
    return {
      ok: false,
      kind: "none",
      messageHe: "לאיזה אזור לחפש? (למשל השרון / גוש דן)",
    };
  }
  const apiKey = resolveGeocodeApiKey(input.apiKey);
  if (!apiKey) {
    return {
      ok: false,
      kind: "missing_key",
      messageHe:
        "חיפוש לפי אזור לא מוגדר כרגע (חסר מפתח Google / Geocoding).",
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const url = new URL(GEOCODE_URL);
  url.searchParams.set("address", place);
  url.searchParams.set("language", "he");
  url.searchParams.set("region", "il");
  url.searchParams.set("key", apiKey);

  try {
    const res = await fetchImpl(url.toString());
    if (!res.ok) {
      return {
        ok: false,
        kind: "error",
        messageHe: "לא הצלחתי לזהות את האזור עכשיו. נסה שוב או ציין עיר מדויקת יותר.",
      };
    }
    const json = (await res.json()) as GeocodeApiResponse;
    const status = String(json.status ?? "").toUpperCase();
    if (status === "ZERO_RESULTS") {
      return {
        ok: false,
        kind: "none",
        messageHe: `לא זיהיתי את האזור «${place}». אפשר לנסח מחדש או לציין עיר?`,
      };
    }
    if (status === "REQUEST_DENIED" || status === "INVALID_REQUEST") {
      return {
        ok: false,
        kind: "missing_key",
        messageHe:
          "חיפוש לפי אזור לא מופעל למפתח הזה (צריך Geocoding API).",
      };
    }
    if (status !== "OK" && status !== "ZERO_RESULTS") {
      return {
        ok: false,
        kind: "error",
        messageHe: "לא הצלחתי לזהות את האזור עכשיו. נסה שוב בעוד רגע.",
      };
    }

    const results = Array.isArray(json.results) ? json.results : [];
    // Clearly defensible = exactly one non-partial hit with a valid viewport.
    if (results.length === 0) {
      return {
        ok: false,
        kind: "none",
        messageHe: `לא זיהיתי את האזור «${place}». אפשר לנסח מחדש או לציין עיר?`,
      };
    }
    if (results.length > 1) {
      return {
        ok: false,
        kind: "ambiguous",
        messageHe: `מצאתי כמה אזורים ל«${place}». לאיזה התכוונת? (ציין עיר או אזור מדויק יותר)`,
      };
    }
    const row = results[0]!;
    if (row.partial_match === true) {
      return {
        ok: false,
        kind: "ambiguous",
        messageHe: `לא בטוח שזיהיתי נכון את «${place}». אפשר לציין אזור או עיר מדויקים יותר?`,
      };
    }
    const label =
      String(row.formatted_address ?? "").trim() || place;
    const viewport = viewportFromGeometry(row.geometry, label);
    if (!viewport) {
      return {
        ok: false,
        kind: "invalid",
        messageHe: `לא הצלחתי לקבוע גבולות ל«${place}». נסה עיר או אזור אחר.`,
      };
    }
    return { ok: true, viewport };
  } catch {
    return {
      ok: false,
      kind: "error",
      messageHe: "לא הצלחתי לזהות את האזור עכשיו. נסה שוב בעוד רגע.",
    };
  }
}
