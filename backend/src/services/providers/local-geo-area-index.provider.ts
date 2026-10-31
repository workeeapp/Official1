/**
 * Local geo-area index provider (Stage 2A).
 * Wraps lookupGeoAreaIndex — documented features only, no aliases.
 */

import type { GeographicAsk } from "../geographic-match.js";
import { provenanceFromAreaSource } from "../geographic-match.js";
import type {
  GeographicProvider,
  GeographicProviderContext,
  GeographicProviderHit,
} from "../geographic-provider.js";
import { lookupGeoAreaIndex } from "../geo-area-index.js";

export const localGeoAreaIndexProvider: GeographicProvider = {
  id: "local_geo_area_index",
  provenance: "geo_area_index",
  capabilities: {
    kinds: ["region"],
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
    const hit = lookupGeoAreaIndex({ place: q });
    if (hit.status === "resolved") {
      return {
        kind: "region",
        labelHe: hit.area.label || q,
        confidence: "high",
        provenance: provenanceFromAreaSource(hit.area.source),
        viewport: hit.area.bbox,
        polygon: hit.area.geometry,
      };
    }
    if (hit.status === "ambiguous") {
      return {
        kind: "region",
        labelHe: q,
        confidence: "low",
        provenance: "geo_area_index",
        candidates: hit.features.map((f) => ({
          label: f.names[0] || f.id,
          kind: "region" as const,
          confidence: "medium" as const,
        })),
        policyTrace: hit.messageHe,
      };
    }
    return null;
  },
};
