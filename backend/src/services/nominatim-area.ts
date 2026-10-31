/**
 * Nominatim (OpenStreetMap) geographic-area resolver.
 * Returns Polygon / MultiPolygon only — fail closed on Point / ambiguity.
 * Process-local positive cache; injectable fetch (no live calls in tests).
 *
 * Usage policy: identify the app via User-Agent.
 * https://operations.osmfoundation.org/policies/nominatim/
 */
import {
  buildResolvedGeographicArea,
  isValidGeoAreaGeometry,
  type GeoAreaGeometry,
  type ResolveGeographicAreaResult,
  type ResolvedGeographicArea,
} from "./geo-area.js";

const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const DEFAULT_USER_AGENT = "WorkeeLucy/1.0 (geographic-area; contact: local-dev)";

/** Positive cache only — keyed by normalized query. */
const areaCache = new Map<string, ResolvedGeographicArea>();
const CACHE_MAX = 256;

export type NominatimAreaResolveInput = {
  place: string;
  fetchImpl?: typeof fetch;
  /** Override User-Agent (tests). */
  userAgent?: string;
  /** When false, skip cache read/write (tests). Default true. */
  useCache?: boolean;
};

type NominatimRow = {
  display_name?: string;
  name?: string;
  osm_type?: string;
  osm_id?: number | string;
  class?: string;
  type?: string;
  geojson?: {
    type?: string;
    coordinates?: unknown;
  };
};

function cacheKey(place: string): string {
  return place.trim().normalize("NFC").toLowerCase();
}

export function clearNominatimAreaCache(): void {
  areaCache.clear();
}

function remember(key: string, area: ResolvedGeographicArea): void {
  if (areaCache.size >= CACHE_MAX) {
    const oldest = areaCache.keys().next().value;
    if (oldest !== undefined) {
      areaCache.delete(oldest);
    }
  }
  areaCache.set(key, area);
}

function geometryFromRow(row: NominatimRow): GeoAreaGeometry | null {
  const g = row.geojson;
  if (!g || typeof g !== "object") {
    return null;
  }
  if (g.type !== "Polygon" && g.type !== "MultiPolygon") {
    return null;
  }
  const candidate = {
    type: g.type,
    coordinates: g.coordinates,
  };
  if (!isValidGeoAreaGeometry(candidate)) {
    return null;
  }
  return candidate;
}

/**
 * Resolve a free-text region name via Nominatim polygon_geojson.
 * Exactly one Polygon/MultiPolygon among the page → accept.
 * 0 → none; >1 → ambiguous; Point-only / invalid → invalid/none.
 */
export async function resolveAreaFromNominatim(
  input: NominatimAreaResolveInput,
): Promise<ResolveGeographicAreaResult> {
  const place = String(input.place ?? "").trim();
  if (!place) {
    return {
      ok: false,
      kind: "none",
      messageHe: "לאיזה אזור לחפש? (למשל השרון / גוש דן)",
    };
  }

  const key = cacheKey(place);
  const useCache = input.useCache !== false;
  if (useCache) {
    const hit = areaCache.get(key);
    if (hit) {
      return { ok: true, area: hit };
    }
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const url = new URL(NOMINATIM_SEARCH_URL);
  url.searchParams.set("q", place);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("polygon_geojson", "1");
  url.searchParams.set("limit", "5");
  url.searchParams.set("addressdetails", "0");

  try {
    const res = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": (input.userAgent ?? DEFAULT_USER_AGENT).trim() || DEFAULT_USER_AGENT,
        "Accept-Language": "he,en",
      },
    });
    if (!res.ok) {
      return {
        ok: false,
        kind: "error",
        messageHe:
          "לא הצלחתי לזהות את האזור עכשיו. נסה שוב או ציין עיר מדויקת יותר.",
      };
    }
    const json = (await res.json()) as unknown;
    const rows = Array.isArray(json) ? (json as NominatimRow[]) : [];
    if (rows.length === 0) {
      return {
        ok: false,
        kind: "none",
        messageHe: `לא זיהיתי את האזור «${place}». אפשר לנסח מחדש או לציין עיר?`,
      };
    }

    const withPoly: Array<{ row: NominatimRow; geometry: GeoAreaGeometry }> =
      [];
    for (const row of rows) {
      const geometry = geometryFromRow(row);
      if (geometry) {
        withPoly.push({ row, geometry });
      }
    }

    if (withPoly.length === 0) {
      return {
        ok: false,
        kind: "invalid",
        messageHe: `לא הצלחתי לקבוע גבולות ל«${place}». נסה עיר או אזור אחר.`,
      };
    }
    if (withPoly.length > 1) {
      return {
        ok: false,
        kind: "ambiguous",
        messageHe: `מצאתי כמה אזורים ל«${place}». לאיזה התכוונת? (ציין עיר או אזור מדויק יותר)`,
      };
    }

    const { row, geometry } = withPoly[0]!;
    const label =
      String(row.display_name ?? "").trim() ||
      String(row.name ?? "").trim() ||
      place;
    const osmType = String(row.osm_type ?? "").trim();
    const osmId = row.osm_id != null ? String(row.osm_id).trim() : "";
    const providerRef =
      osmType && osmId ? `osm:${osmType}/${osmId}` : undefined;

    const area = buildResolvedGeographicArea({
      label,
      geometry,
      source: "osm_nominatim",
      providerRef,
    });
    if (!area) {
      return {
        ok: false,
        kind: "invalid",
        messageHe: `לא הצלחתי לקבוע גבולות ל«${place}». נסה עיר או אזור אחר.`,
      };
    }
    if (useCache) {
      remember(key, area);
    }
    return { ok: true, area };
  } catch {
    return {
      ok: false,
      kind: "error",
      messageHe: "לא הצלחתי לזהות את האזור עכשיו. נסה שוב בעוד רגע.",
    };
  }
}
