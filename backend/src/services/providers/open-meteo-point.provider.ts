/**
 * Open-Meteo point geocode provider (Stage 2A).
 * Wraps weather.geocodePlace — no domain logic.
 *
 * Open-Meteo resolves place/city names, not street geocodes. For established
 * street-like address strings (saved addressText), retry trailing city tokens
 * after a full-string miss — still the same OM pipeline, not a second matcher.
 */

import type { GeographicAsk } from "../geographic-match.js";
import type {
  GeographicProvider,
  GeographicProviderContext,
  GeographicProviderHit,
} from "../geographic-provider.js";
import { looksLikeStreetOrPlaceAddress } from "../saved-route-location.js";
import { geocodePlace, type WeatherPlace } from "../weather.js";

/** Trailing token candidates: "הרצל 5 רמת גן" → ["רמת גן", "גן"]. */
export function openMeteoAddressCityFallbacks(address: string): string[] {
  const parts = address
    .trim()
    .split(/\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    return [];
  }
  const out: string[] = [];
  for (let n = Math.min(3, parts.length - 1); n >= 1; n--) {
    const candidate = parts.slice(-n).join(" ");
    if (!candidate || candidate === address.trim()) {
      continue;
    }
    // Skip pure numbers and leading-house-number tails ("5 רמת גן").
    if (/^\d/.test(candidate)) {
      continue;
    }
    if (candidate.length < 2) {
      continue;
    }
    out.push(candidate);
  }
  return out;
}

function hitFromGeo(geo: WeatherPlace, fallbackLabel: string): GeographicProviderHit {
  return {
    kind: "city",
    labelHe: geo.name || fallbackLabel,
    confidence: "high",
    provenance: "open_meteo",
    point: { lat: geo.latitude, lng: geo.longitude },
  };
}

export function createOpenMeteoPointProvider(
  geocode: typeof geocodePlace = geocodePlace,
): GeographicProvider {
  return {
    id: "open_meteo_point",
    provenance: "open_meteo",
    capabilities: {
      kinds: ["point", "city", "poi"],
      geometries: ["point"],
      languages: ["he", "en"],
    },
    async resolve(
      ask: GeographicAsk,
      ctx: GeographicProviderContext,
    ): Promise<GeographicProviderHit | null> {
      if (!ctx.geometryNeeds.point) {
        return null;
      }
      const q = String(ask.rawText ?? "").trim();
      if (!q || q.toLowerCase() === "speaker") {
        return null;
      }
      const fetchImpl = ctx.fetchImpl ?? fetch;
      let geo: WeatherPlace | null = null;
      try {
        geo = await geocode(q, fetchImpl);
      } catch {
        geo = null;
      }
      if (geo) {
        return hitFromGeo(geo, q);
      }
      if (!looksLikeStreetOrPlaceAddress(q)) {
        return null;
      }
      for (const candidate of openMeteoAddressCityFallbacks(q)) {
        try {
          const city = await geocode(candidate, fetchImpl);
          if (city) {
            return hitFromGeo(city, candidate);
          }
        } catch {
          // try next fallback
        }
      }
      return null;
    },
  };
}

export const openMeteoPointProvider = createOpenMeteoPointProvider();
