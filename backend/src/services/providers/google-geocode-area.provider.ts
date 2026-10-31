/**
 * Google Geocoding area/viewport provider (Stage 2A).
 * Wraps resolvePlaceViewport (index skipped here — local index is a separate provider).
 */

import type { GeographicAsk } from "../geographic-match.js";
import { provenanceFromAreaSource } from "../geographic-match.js";
import type {
  GeographicProvider,
  GeographicProviderContext,
  GeographicProviderHit,
} from "../geographic-provider.js";
import { resolvePlaceViewport } from "../geocode-viewport.js";

export const googleGeocodeAreaProvider: GeographicProvider = {
  id: "google_geocode_area",
  provenance: "google_geocode",
  capabilities: {
    kinds: ["region", "city", "neighborhood", "poi"],
    geometries: ["viewport", "polygon"],
    languages: ["he", "en"],
  },
  async resolve(
    ask: GeographicAsk,
    ctx: GeographicProviderContext,
  ): Promise<GeographicProviderHit | null> {
    if (!ctx.geometryNeeds.area) {
      return null;
    }
    const q = String(ask.rawText ?? "").trim();
    if (!q) {
      return null;
    }
    const resolved = await resolvePlaceViewport({
      place: q,
      fetchImpl: ctx.fetchImpl,
      apiKey: ctx.apiKey,
      allowIndexLookup: false,
      allowNominatimFallback: false,
    });
    if (!resolved.ok) {
      if (resolved.kind === "ambiguous") {
        return {
          kind: "region",
          labelHe: q,
          confidence: "low",
          provenance: "google_geocode",
          policyTrace: resolved.messageHe,
          candidates: [],
        };
      }
      // none / invalid / error → no opinion (let next provider try) unless
      // we want policyTrace for logging; return null so OM point can run.
      return null;
    }
    const vp = resolved.viewport;
    return {
      kind: "region",
      labelHe: vp.label || q,
      confidence: "medium",
      provenance: provenanceFromAreaSource(vp.source),
      viewport: { low: vp.low, high: vp.high },
      ...(vp.geometry ? { polygon: vp.geometry } : {}),
    };
  },
};
