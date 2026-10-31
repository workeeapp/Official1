/**
 * Generic geographic area types + geometry helpers (Lucy infrastructure).
 * Domain adapters (Places, weather, transit, …) consume ResolvedGeographicArea
 * according to each provider’s capabilities — this module does not call Places.
 *
 * Coordinates in GeoJSON rings are [lng, lat] (RFC 7946).
 */

import {
  isValidLatitude,
  isValidLongitude,
  isValidViewport,
} from "./resolved-location.js";

export type GeoPolygon = {
  type: "Polygon";
  /** rings: first = exterior, rest = holes; each ring is [lng, lat][] */
  coordinates: number[][][];
};

export type GeoMultiPolygon = {
  type: "MultiPolygon";
  coordinates: number[][][][];
};

export type GeoAreaGeometry = GeoPolygon | GeoMultiPolygon;

export type GeographicAreaSource =
  | "geocode_viewport"
  | "osm_nominatim"
  | "geo_area_index";

/** Resolved named region with true geometry + tight axis-aligned bbox. */
export type ResolvedGeographicArea = {
  label: string;
  geometry: GeoAreaGeometry;
  bbox: {
    low: { lat: number; lng: number };
    high: { lat: number; lng: number };
  };
  source: GeographicAreaSource;
  /** Optional provider reference (e.g. OSM relation id). */
  providerRef?: string;
};

export type ResolveGeographicAreaFailureKind =
  | "none"
  | "ambiguous"
  | "invalid"
  | "error"
  | "missing_key";

export type ResolveGeographicAreaResult =
  | { ok: true; area: ResolvedGeographicArea }
  | {
      ok: false;
      kind: ResolveGeographicAreaFailureKind;
      messageHe: string;
    };

/** Closed region: boundary points count as inside. */
export const POINT_IN_POLYGON_BOUNDARY: "inside" = "inside";

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function isLngLatPair(pair: unknown): pair is [number, number] {
  if (!Array.isArray(pair) || pair.length < 2) {
    return false;
  }
  const lng = pair[0];
  const lat = pair[1];
  return isFiniteNumber(lng) && isFiniteNumber(lat);
}

function ringIsValid(ring: unknown): ring is number[][] {
  if (!Array.isArray(ring) || ring.length < 4) {
    return false;
  }
  for (const pair of ring) {
    if (!isLngLatPair(pair)) {
      return false;
    }
    if (!isValidLongitude(pair[0]) || !isValidLatitude(pair[1])) {
      return false;
    }
  }
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  // Ring should be closed; tolerate tiny float noise.
  if (
    Math.abs(first[0]! - last[0]!) > 1e-9 ||
    Math.abs(first[1]! - last[1]!) > 1e-9
  ) {
    return false;
  }
  return true;
}

export function isValidGeoAreaGeometry(
  geometry: unknown,
): geometry is GeoAreaGeometry {
  if (!geometry || typeof geometry !== "object") {
    return false;
  }
  const g = geometry as { type?: unknown; coordinates?: unknown };
  if (g.type === "Polygon") {
    if (!Array.isArray(g.coordinates) || g.coordinates.length === 0) {
      return false;
    }
    return g.coordinates.every(ringIsValid);
  }
  if (g.type === "MultiPolygon") {
    if (!Array.isArray(g.coordinates) || g.coordinates.length === 0) {
      return false;
    }
    for (const poly of g.coordinates) {
      if (!Array.isArray(poly) || poly.length === 0) {
        return false;
      }
      if (!poly.every(ringIsValid)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/** Tight axis-aligned bbox from Polygon / MultiPolygon. No padding. */
export function bboxFromGeometry(
  geometry: GeoAreaGeometry,
): { low: { lat: number; lng: number }; high: { lat: number; lng: number } } | null {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  const visitRing = (ring: number[][]) => {
    for (const pair of ring) {
      const lng = pair[0]!;
      const lat = pair[1]!;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
  };

  if (geometry.type === "Polygon") {
    for (const ring of geometry.coordinates) {
      visitRing(ring);
    }
  } else {
    for (const poly of geometry.coordinates) {
      for (const ring of poly) {
        visitRing(ring);
      }
    }
  }

  const box = {
    low: { lat: minLat, lng: minLng },
    high: { lat: maxLat, lng: maxLng },
  };
  if (!isValidViewport(box)) {
    return null;
  }
  return box;
}

/**
 * Rectangle → GeoJSON Polygon (closed ring). Used when a provider only
 * returns a viewport (e.g. Google Geocoding) so consumers always get geometry.
 */
export function polygonFromViewport(box: {
  low: { lat: number; lng: number };
  high: { lat: number; lng: number };
}): GeoPolygon | null {
  if (!isValidViewport(box)) {
    return null;
  }
  const { low, high } = box;
  return {
    type: "Polygon",
    coordinates: [
      [
        [low.lng, low.lat],
        [high.lng, low.lat],
        [high.lng, high.lat],
        [low.lng, high.lat],
        [low.lng, low.lat],
      ],
    ],
  };
}

/**
 * Ray-casting point-in-polygon. Boundary → inside (closed).
 * Holes: even-odd across rings within a polygon.
 */
function pointInRing(
  lng: number,
  lat: number,
  ring: number[][],
): { inside: boolean; onBoundary: boolean } {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i]![0]!;
    const yi = ring[i]![1]!;
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;

    // On segment? (closed-boundary rule)
    const onSeg =
      Math.min(yi, yj) - 1e-12 <= lat &&
      lat <= Math.max(yi, yj) + 1e-12 &&
      Math.min(xi, xj) - 1e-12 <= lng &&
      lng <= Math.max(xi, xj) + 1e-12 &&
      Math.abs((xj - xi) * (lat - yi) - (lng - xi) * (yj - yi)) <= 1e-9;
    if (onSeg) {
      return { inside: true, onBoundary: true };
    }

    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return { inside, onBoundary: false };
}

function pointInPolygonRings(
  lng: number,
  lat: number,
  rings: number[][][],
): boolean {
  if (rings.length === 0) {
    return false;
  }
  const exterior = pointInRing(lng, lat, rings[0]!);
  if (exterior.onBoundary) {
    return true;
  }
  if (!exterior.inside) {
    return false;
  }
  // Holes: if inside a hole (odd relative to hole), exclude — unless on hole boundary (inside).
  for (let h = 1; h < rings.length; h++) {
    const hole = pointInRing(lng, lat, rings[h]!);
    if (hole.onBoundary) {
      return true;
    }
    if (hole.inside) {
      return false;
    }
  }
  return true;
}

/**
 * True when (lat,lng) lies inside geometry (boundary inclusive).
 * Invalid coords → false (caller may treat as fail-closed drop).
 */
export function pointInAreaGeometry(
  lat: number,
  lng: number,
  geometry: GeoAreaGeometry,
): boolean {
  if (!isValidLatitude(lat) || !isValidLongitude(lng)) {
    return false;
  }
  if (!isValidGeoAreaGeometry(geometry)) {
    return false;
  }
  if (geometry.type === "Polygon") {
    return pointInPolygonRings(lng, lat, geometry.coordinates);
  }
  for (const poly of geometry.coordinates) {
    if (pointInPolygonRings(lng, lat, poly)) {
      return true;
    }
  }
  return false;
}

export function buildResolvedGeographicArea(input: {
  label: string;
  geometry: GeoAreaGeometry;
  source: GeographicAreaSource;
  providerRef?: string;
}): ResolvedGeographicArea | null {
  if (!isValidGeoAreaGeometry(input.geometry)) {
    return null;
  }
  const bbox = bboxFromGeometry(input.geometry);
  if (!bbox) {
    return null;
  }
  const label = String(input.label ?? "").trim();
  if (!label) {
    return null;
  }
  return {
    label,
    geometry: input.geometry,
    bbox,
    source: input.source,
    providerRef: input.providerRef,
  };
}

/** Build area from a SW–NE viewport when the provider has no polygon. */
export function geographicAreaFromViewportBox(input: {
  label: string;
  low: { lat: number; lng: number };
  high: { lat: number; lng: number };
  source: GeographicAreaSource;
  providerRef?: string;
}): ResolvedGeographicArea | null {
  const geometry = polygonFromViewport({
    low: input.low,
    high: input.high,
  });
  if (!geometry) {
    return null;
  }
  return buildResolvedGeographicArea({
    label: input.label,
    geometry,
    source: input.source,
    providerRef: input.providerRef,
  });
}
