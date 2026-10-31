/**
 * Resolve a named place/region for area_restrict.
 *
 * Order:
 * 1. Local documented geo-area index (Polygon/MultiPolygon).
 * 2. Google Geocoding as a filtered candidate (multi-signal accept).
 * 3. Nominatim public API only when allowNominatimFallback === true
 *    (off by default — not suitable as a product default).
 *
 * Reuses GOOGLE_PLACES_API_KEY (Geocoding API must be enabled on that key).
 */
import { getEnv } from "../config/env.js";
import {
  geographicAreaFromViewportBox,
  type GeoAreaGeometry,
} from "./geo-area.js";
import { lookupGeoAreaIndex } from "./geo-area-index.js";
import { decideGoogleAreaCandidate } from "./geo-area-policy.js";
import { resolveAreaFromNominatim } from "./nominatim-area.js";
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
  types?: string[];
  geometry?: GeocodeGeometry;
};
type GeocodeApiResponse = {
  status?: string;
  results?: GeocodeResultRow[];
  error_message?: string;
};

function resolveGeocodeApiKey(apiKey?: string | null): string | null {
  if (apiKey !== undefined && apiKey !== null) {
    return apiKey.trim() || null;
  }
  return (getEnv().GOOGLE_PLACES_API_KEY ?? "").trim() || null;
}

function boxFromGeometry(
  geometry: GeocodeGeometry | undefined,
): {
  low: { lat: number; lng: number };
  high: { lat: number; lng: number };
} | null {
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
  return isValidViewport(candidate) ? candidate : null;
}

function viewportFromBox(
  box: { low: { lat: number; lng: number }; high: { lat: number; lng: number } },
  label: string,
): ResolvedViewport | null {
  const area = geographicAreaFromViewportBox({
    label,
    low: box.low,
    high: box.high,
    source: "geocode_viewport",
  });
  if (!area) {
    return null;
  }
  return {
    low: area.bbox.low,
    high: area.bbox.high,
    label: area.label,
    source: "geocode_viewport",
    geometry: area.geometry,
  };
}

function viewportFromResolvedArea(area: {
  label: string;
  bbox: { low: { lat: number; lng: number }; high: { lat: number; lng: number } };
  geometry: GeoAreaGeometry;
  source: ResolvedViewport["source"];
}): ResolvedViewport {
  return {
    low: area.bbox.low,
    high: area.bbox.high,
    label: area.label,
    source: area.source,
    geometry: area.geometry,
  };
}

async function resolveGoogleGeocodeViewport(input: {
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
        messageHe:
          "לא הצלחתי לזהות את האזור עכשיו. נסה שוב או ציין עיר מדויקת יותר.",
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
    const label = String(row.formatted_address ?? "").trim() || place;
    const box = boxFromGeometry(row.geometry);
    if (!box) {
      return {
        ok: false,
        kind: "invalid",
        messageHe: `לא הצלחתי לקבוע גבולות ל«${place}». נסה עיר או אזור אחר.`,
      };
    }

    const decision = decideGoogleAreaCandidate({
      query: place,
      formattedAddress: label,
      types: Array.isArray(row.types) ? row.types.map(String) : [],
      partialMatch: row.partial_match === true,
      viewport: box,
    });
    if (!decision.ok) {
      const kind =
        decision.reason === "partial" || decision.reason === "weak_affinity"
          ? "ambiguous"
          : decision.reason === "unreliable" ||
              decision.reason === "point_like" ||
              decision.reason === "narrow_admin"
            ? "invalid"
            : "invalid";
      return {
        ok: false,
        kind,
        messageHe: decision.messageHe,
      };
    }

    const viewport = viewportFromBox(box, label);
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

/**
 * Index → Google (filtered) → optional Nominatim (flag, default off).
 */
export async function resolvePlaceViewport(input: {
  place: string;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
  /**
   * Public Nominatim fallback. Default false (product default).
   * Tests that exercise Nominatim must pass true explicitly.
   */
  allowNominatimFallback?: boolean;
  /** When false, skip local index (Google-only unit tests). Default true. */
  allowIndexLookup?: boolean;
}): Promise<GeocodeViewportResult> {
  const place = String(input.place ?? "").trim();
  if (!place) {
    return {
      ok: false,
      kind: "none",
      messageHe: "לאיזה אזור לחפש? (למשל השרון / גוש דן)",
    };
  }

  if (input.allowIndexLookup !== false) {
    const indexed = lookupGeoAreaIndex({ place });
    if (indexed.status === "resolved") {
      return {
        ok: true,
        viewport: viewportFromResolvedArea({
          ...indexed.area,
          source: "geo_area_index",
        }),
      };
    }
    if (indexed.status === "ambiguous") {
      return {
        ok: false,
        kind: "ambiguous",
        messageHe: indexed.messageHe,
      };
    }
  }

  const google = await resolveGoogleGeocodeViewport(input);
  if (google.ok) {
    return google;
  }

  // Nominatim is opt-in only — never the product default.
  if (input.allowNominatimFallback !== true) {
    return google;
  }
  if (
    google.kind !== "none" &&
    google.kind !== "invalid" &&
    google.kind !== "missing_key" &&
    google.kind !== "error"
  ) {
    return google;
  }

  const nominatim = await resolveAreaFromNominatim({
    place,
    fetchImpl: input.fetchImpl,
  });
  if (nominatim.ok) {
    return {
      ok: true,
      viewport: viewportFromResolvedArea({
        ...nominatim.area,
        source: "osm_nominatim",
      }),
    };
  }
  if (
    nominatim.kind === "none" ||
    nominatim.kind === "ambiguous" ||
    nominatim.kind === "invalid"
  ) {
    return {
      ok: false,
      kind: nominatim.kind,
      messageHe: nominatim.messageHe,
    };
  }
  return google;
}
