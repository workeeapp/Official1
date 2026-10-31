/**
 * Point geocode provider wrapping an injected named-place geocoder
 * (Routes Places Text Search → Open-Meteo). No domain ifs.
 */

import type { GeographicAsk } from "../geographic-match.js";
import type {
  GeographicProvider,
  GeographicProviderContext,
  GeographicProviderHit,
} from "../geographic-provider.js";

export type NamedPlaceGeocodeResult =
  | { ok: true; lat: number; lng: number; label: string }
  | {
      ok: false;
      kind: "empty" | "ambiguous";
      messageHe: string;
      options?: string[];
    };

export type NamedPlaceGeocodeFn = (input: {
  query: string;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
}) => Promise<NamedPlaceGeocodeResult>;

export function createNamedPlacePointProvider(
  geocode: NamedPlaceGeocodeFn,
  opts?: { id?: string; provenance?: GeographicProvider["provenance"] },
): GeographicProvider {
  return {
    id: opts?.id ?? "named_place_point",
    provenance: opts?.provenance ?? "google_geocode",
    capabilities: {
      kinds: ["point", "city", "poi", "neighborhood"],
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
      const geo = await geocode({
        query: q,
        fetchImpl: ctx.fetchImpl,
        apiKey: ctx.apiKey,
      });
      if (!geo.ok) {
        if (geo.kind === "ambiguous") {
          return {
            kind: "city",
            labelHe: q,
            confidence: "low",
            provenance: opts?.provenance ?? "google_geocode",
            policyTrace: geo.messageHe,
            candidates: (geo.options ?? []).map((label) => ({
              label,
              kind: "city" as const,
              confidence: "medium" as const,
            })),
          };
        }
        return null;
      }
      return {
        kind: "city",
        labelHe: geo.label || q,
        confidence: "high",
        provenance: opts?.provenance ?? "google_geocode",
        point: { lat: geo.lat, lng: geo.lng },
      };
    },
  };
}
