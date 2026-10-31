/**
 * Geographic provider adapter contract (Stage 2A).
 * Providers are domain-agnostic; selection uses geometryNeeds only.
 */

import type {
  GeographicAsk,
  GeographicCandidate,
  GeographicConfidence,
  GeographicKind,
  GeographicPoint,
  GeographicProvenance,
  GeographicViewport,
} from "./geographic-match.js";
import type { GeoAreaGeometry } from "./geo-area.js";

export type GeographicGeometryNeed = {
  point?: boolean;
  area?: boolean;
  airport?: boolean;
};

export type ProviderGeometryKind = "point" | "viewport" | "polygon";

export type GeographicProviderCapabilities = {
  kinds: GeographicKind[];
  geometries: ProviderGeometryKind[];
  languages?: string[];
};

export type GeographicProviderHit = {
  kind: GeographicKind;
  labelHe: string;
  confidence: GeographicConfidence;
  provenance: GeographicProvenance;
  point?: GeographicPoint;
  viewport?: GeographicViewport;
  polygon?: GeoAreaGeometry;
  candidates?: GeographicCandidate[];
  policyTrace?: string;
};

export type GeographicProviderContext = {
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
  geometryNeeds: GeographicGeometryNeed;
};

export type GeographicProvider = {
  id: string;
  provenance: GeographicProvenance;
  capabilities: GeographicProviderCapabilities;
  /**
   * Return a hit, or null when this provider has no opinion
   * (caller tries the next provider).
   */
  resolve: (
    ask: GeographicAsk,
    ctx: GeographicProviderContext,
  ) => Promise<GeographicProviderHit | null>;
};

/** True when provider can contribute to the requested geometry needs. */
export function providerMatchesNeeds(
  provider: GeographicProvider,
  needs: GeographicGeometryNeed,
): boolean {
  const geos = new Set(provider.capabilities.geometries);
  if (needs.area && (geos.has("viewport") || geos.has("polygon"))) {
    return true;
  }
  if (needs.point && geos.has("point")) {
    return true;
  }
  if (needs.airport && provider.capabilities.kinds.includes("airport")) {
    return true;
  }
  return false;
}
