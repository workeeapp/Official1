/**
 * Local geographic-area index (documented GeoJSON extracts).
 * Names come only from source dataset fields — no hand aliases.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildResolvedGeographicArea,
  isValidGeoAreaGeometry,
  type GeoAreaGeometry,
  type GeographicAreaSource,
  type ResolvedGeographicArea,
} from "./geo-area.js";
import { decideIndexMatches } from "./geo-area-policy.js";

export type GeoAreaIndexFeature = {
  id: string;
  names: string[];
  kind: "vernacular_region" | "admin_broad" | "admin_narrow";
  hierarchy: Record<string, unknown>;
  source: {
    dataset: string;
    provider: string;
    license: string;
    attribution: string;
    featureId: string;
    url?: string;
    wikidata?: string | null;
  };
  geometry: GeoAreaGeometry;
  bbox: {
    low: { lat: number; lng: number };
    high: { lat: number; lng: number };
  };
};

export type GeoAreaIndexFile = {
  version: number;
  generatedAt?: string;
  description?: string;
  coverageNotes?: Record<string, unknown>;
  features: GeoAreaIndexFeature[];
};

let cached: GeoAreaIndexFile | null = null;

function defaultIndexPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../data/geo-area-index.json"), // src/services → src/data
    resolve(here, "../../src/data/geo-area-index.json"), // dist/services → src/data
    resolve(process.cwd(), "src/data/geo-area-index.json"),
    resolve(process.cwd(), "backend/src/data/geo-area-index.json"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return path;
    }
  }
  return candidates[0]!;
}

export function loadGeoAreaIndex(opts?: {
  path?: string;
  reload?: boolean;
}): GeoAreaIndexFile {
  if (cached && !opts?.reload && !opts?.path) {
    return cached;
  }
  const path = opts?.path ?? defaultIndexPath();
  const raw = JSON.parse(readFileSync(path, "utf8")) as GeoAreaIndexFile;
  const features = Array.isArray(raw.features) ? raw.features : [];
  cached = {
    ...raw,
    features: features.filter(
      (f) =>
        f &&
        typeof f.id === "string" &&
        Array.isArray(f.names) &&
        isValidGeoAreaGeometry(f.geometry),
    ),
  };
  return cached;
}

export function resetGeoAreaIndexCache(): void {
  cached = null;
}

export type GeoAreaIndexLookupResult =
  | {
      status: "resolved";
      area: ResolvedGeographicArea;
      feature: GeoAreaIndexFeature;
    }
  | { status: "ambiguous"; features: GeoAreaIndexFeature[]; messageHe: string }
  | { status: "unresolved" };

export function lookupGeoAreaIndex(input: {
  place: string;
  index?: GeoAreaIndexFile;
}): GeoAreaIndexLookupResult {
  const place = String(input.place ?? "").trim();
  if (!place) {
    return { status: "unresolved" };
  }
  const index = input.index ?? loadGeoAreaIndex();
  const decision = decideIndexMatches(place, index.features);
  if (decision.status === "unresolved") {
    return { status: "unresolved" };
  }
  const matched = index.features.filter((f) =>
    decision.featureIds.includes(f.id),
  );
  if (decision.status === "ambiguous" || matched.length > 1) {
    return {
      status: "ambiguous",
      features: matched,
      messageHe: `מצאתי כמה אזורים ל«${place}». לאיזה התכוונת? (ציין שם מדויק יותר)`,
    };
  }
  const feature = matched[0];
  if (!feature) {
    return { status: "unresolved" };
  }
  const area = buildResolvedGeographicArea({
    label: feature.names[0] || place,
    geometry: feature.geometry,
    source: "geo_area_index" as GeographicAreaSource,
    providerRef: feature.id,
  });
  if (!area) {
    return { status: "unresolved" };
  }
  return { status: "resolved", area, feature };
}
