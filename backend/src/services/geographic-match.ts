/**
 * Shared Geographic Resolution contract (Stage 1 + 2A).
 *
 * This module defines the structured match between what the user asked and what
 * was identified. It does NOT call providers or execute domain searches.
 *
 * Domain adapters (Weather / Places / Routes / …) consume a GeographicMatch in
 * Stage 2+. News / Events may attach later via the same shape.
 *
 * Invariants:
 * - region is never silently collapsed to a bare point: if a representative
 *   point exists, kind stays "region" and representativePoint is separate.
 * - savedRef (saved row identity) is separate from coordinateProvenance
 *   (where lat/lng actually came from — e.g. saved coords vs later geocode).
 * - policyTrace is for logs only — never send to the user (see geo-area-user-copy).
 */

import type { GeoAreaGeometry, GeographicAreaSource } from "./geo-area.js";

/** What the speaker / ACTION asked for (intent), before provider resolution. */
export type GeographicAskRole =
  | "place"
  | "origin"
  | "destination"
  | "near"
  | "area"
  | "airport_hint";

export type GeographicDeixis = "pin" | "last_live" | "saved_label" | "none";

export type GeographicAsk = {
  /** Exact spoken / ACTION string (do not rewrite region names). */
  rawText: string;
  role: GeographicAskRole;
  deixis?: GeographicDeixis;
  /** When the model/engine already knows a saved row id. */
  savedRefHint?: { id: string };
  /**
   * Future: which live domain will consume the match.
   * Resolution itself must not fan out to all providers.
   */
  consumerHint?:
    | "weather"
    | "places"
    | "routes"
    | "jewish"
    | "flights"
    | "news"
    | "events"
    | "unknown";
};

/** Identity of a saved Lucy row — independent of how coords were obtained. */
export type GeographicSavedRef = {
  id: string;
  source: "filing" | "list" | "contact";
  listType?: string;
  label: string;
  /** True when the saved row already stored lat/lng at resolve time. */
  hadCoordsAtResolve: boolean;
};

export type GeographicKind =
  | "point"
  | "city"
  | "neighborhood"
  | "region"
  | "poi"
  | "saved"
  | "pin"
  | "airport";

export type GeographicConfidence = "high" | "medium" | "low";

export type GeographicProvenance =
  | "geo_area_index"
  | "google_geocode"
  | "osm_nominatim"
  | "open_meteo"
  | "saved"
  | "whatsapp_pin"
  | "iata_map"
  | "action_coords"
  | "unknown";

export type GeographicPoint = {
  lat: number;
  lng: number;
};

export type GeographicViewport = {
  low: GeographicPoint;
  high: GeographicPoint;
};

/** Optional stand-in point for point-only providers; never replaces kind=region. */
export type GeographicRepresentativePoint = {
  lat: number;
  lng: number;
  /** True only when a documented span/policy gate justified the point. */
  justified: boolean;
  maxSpanDeg?: number;
};

export type GeographicCandidate = {
  label: string;
  kind: GeographicKind;
  confidence: GeographicConfidence;
};

export type GeographicMatchStatus =
  | "resolved"
  | "ambiguous"
  | "needs_clarify"
  | "unsupported_for_consumer";

/**
 * Structured geographic understanding. Domains execute against this;
 * they must not invent a second interpretation of rawText.
 */
export type GeographicMatch = {
  status: GeographicMatchStatus;
  confidence: GeographicConfidence;
  asked: GeographicAsk;
  /**
   * Semantic kind of what was identified.
   * When status is needs_clarify / ambiguous, kind may still hint at the ask
   * (e.g. region) using asked.rawText without claiming a provider hit.
   */
  kind: GeographicKind;
  /** User-facing label (Hebrew preferred). */
  labelHe: string;
  geometry?: {
    point?: GeographicPoint;
    viewport?: GeographicViewport;
    polygon?: GeoAreaGeometry;
  };
  /**
   * Present only when a point-only consumer may use a stand-in.
   * MUST NOT be set unless kind === "region" (or documented exception).
   * Presence of this field does not change kind away from region.
   */
  representativePoint?: GeographicRepresentativePoint;
  /**
   * Semantic / row-level origin of the match (e.g. "saved" when the ask
   * resolved to a saved place). May stay "saved" even after address geocode.
   */
  provenance: GeographicProvenance;
  /**
   * Where geometry.point / viewport coordinates actually came from.
   * When a saved row lacked coords and a geocoder filled the point, keep
   * provenance="saved" + savedRef, and set coordinateProvenance to the
   * geocoder (e.g. open_meteo / google_geocode).
   */
  coordinateProvenance?: GeographicProvenance;
  /** Preserved saved-row identity when the ask matched a saved place. */
  savedRef?: GeographicSavedRef;
  candidates?: GeographicCandidate[];
  /** Internal policy / provider text — logs only. */
  policyTrace?: string;
  /** Ready-made natural clarify / confirm for the user (optional). */
  userAskHe?: string;
};

export function provenanceFromAreaSource(
  source: GeographicAreaSource | string,
): GeographicProvenance {
  switch (source) {
    case "geo_area_index":
      return "geo_area_index";
    case "geocode_viewport":
      return "google_geocode";
    case "osm_nominatim":
      return "osm_nominatim";
    default:
      return "unknown";
  }
}

/** Build a clarify match without claiming a resolved geometry. */
export function geographicNeedsClarify(input: {
  asked: GeographicAsk;
  kind?: GeographicKind;
  labelHe?: string;
  confidence?: GeographicConfidence;
  policyTrace?: string;
  userAskHe: string;
}): GeographicMatch {
  const label =
    String(input.labelHe ?? "").trim() ||
    String(input.asked.rawText ?? "").trim() ||
    "המקום";
  return {
    status: "needs_clarify",
    confidence: input.confidence ?? "low",
    asked: input.asked,
    kind: input.kind ?? "point",
    labelHe: label,
    provenance: "unknown",
    policyTrace: input.policyTrace,
    userAskHe: input.userAskHe,
  };
}

export function geographicAmbiguous(input: {
  asked: GeographicAsk;
  kind?: GeographicKind;
  labelHe?: string;
  candidates: GeographicCandidate[];
  policyTrace?: string;
  userAskHe: string;
}): GeographicMatch {
  const label =
    String(input.labelHe ?? "").trim() ||
    String(input.asked.rawText ?? "").trim() ||
    "המקום";
  return {
    status: "ambiguous",
    confidence: "low",
    asked: input.asked,
    kind: input.kind ?? "point",
    labelHe: label,
    provenance: "unknown",
    candidates: input.candidates,
    policyTrace: input.policyTrace,
    userAskHe: input.userAskHe,
  };
}

/** Resolved city / POI / pin-style point (not a region). */
export function geographicResolvedPoint(input: {
  asked: GeographicAsk;
  kind?: Exclude<GeographicKind, "region">;
  labelHe: string;
  confidence?: GeographicConfidence;
  provenance: GeographicProvenance;
  /** Defaults to provenance when omitted. */
  coordinateProvenance?: GeographicProvenance;
  point: GeographicPoint;
  savedRef?: GeographicSavedRef;
  policyTrace?: string;
}): GeographicMatch {
  return {
    status: "resolved",
    confidence: input.confidence ?? "high",
    asked: input.asked,
    kind: input.kind ?? "point",
    labelHe: input.labelHe.trim() || input.asked.rawText.trim() || "המקום",
    geometry: { point: input.point },
    provenance: input.provenance,
    coordinateProvenance: input.coordinateProvenance ?? input.provenance,
    ...(input.savedRef ? { savedRef: input.savedRef } : {}),
    policyTrace: input.policyTrace,
  };
}

/**
 * Resolved region with optional justified representative point.
 * Enforces: kind stays "region"; representativePoint never replaces region.
 */
export function geographicResolvedRegion(input: {
  asked: GeographicAsk;
  labelHe: string;
  confidence?: GeographicConfidence;
  provenance: GeographicProvenance;
  coordinateProvenance?: GeographicProvenance;
  viewport?: GeographicViewport;
  polygon?: GeoAreaGeometry;
  point?: GeographicPoint;
  representativePoint?: GeographicRepresentativePoint;
  policyTrace?: string;
}): GeographicMatch {
  if (
    input.representativePoint &&
    input.representativePoint.justified !== true
  ) {
    throw new Error(
      "geographicResolvedRegion: representativePoint must be justified",
    );
  }
  return {
    status: "resolved",
    confidence: input.confidence ?? "medium",
    asked: input.asked,
    kind: "region",
    labelHe: input.labelHe.trim() || input.asked.rawText.trim() || "האזור",
    geometry: {
      ...(input.point ? { point: input.point } : {}),
      ...(input.viewport ? { viewport: input.viewport } : {}),
      ...(input.polygon ? { polygon: input.polygon } : {}),
    },
    ...(input.representativePoint
      ? { representativePoint: input.representativePoint }
      : {}),
    provenance: input.provenance,
    coordinateProvenance: input.coordinateProvenance ?? input.provenance,
    policyTrace: input.policyTrace,
  };
}

/**
 * True when a point-only consumer may use representativePoint.
 * Region meaning remains on the match (kind === "region").
 */
export function matchAllowsRepresentativePoint(match: GeographicMatch): boolean {
  return (
    match.status === "resolved" &&
    match.kind === "region" &&
    match.representativePoint?.justified === true &&
    Number.isFinite(match.representativePoint.lat) &&
    Number.isFinite(match.representativePoint.lng)
  );
}

/** Domain cannot consume this match shape — structured, not a fabricated hit. */
export function geographicUnsupportedForConsumer(input: {
  asked: GeographicAsk;
  kind?: GeographicKind;
  labelHe?: string;
  policyTrace?: string;
  userAskHe: string;
}): GeographicMatch {
  return {
    status: "unsupported_for_consumer",
    confidence: "low",
    asked: input.asked,
    kind: input.kind ?? "region",
    labelHe:
      String(input.labelHe ?? "").trim() ||
      String(input.asked.rawText ?? "").trim() ||
      "המקום",
    provenance: "unknown",
    policyTrace: input.policyTrace,
    userAskHe: input.userAskHe,
  };
}
