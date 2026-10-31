/**
 * Weather ↔ geographic-area bridge.
 * Uses resolveGeographicArea (index / Google viewport). No hand aliases.
 *
 * Representative point is justified only for moderate spans (Sharon / Galilee class).
 * Very large regions (e.g. Negev desert ~1.8°) ask for a city instead of a blind centroid.
 */

import { viewportSpanDegrees } from "./geo-area-policy.js";
import type { ResolvedGeographicArea } from "./geo-area.js";
import {
  resolveGeographicArea,
  type ResolveGeographicAreaResult,
} from "./resolve-geographic-area.js";

/**
 * Max axis span (degrees) for a single Open-Meteo point to stand in for a region.
 * Sharon fixture ≈ 0.24°; Negev index ≈ 1.81° → ask city above this threshold.
 */
export const WEATHER_REGION_MAX_REPRESENTATIVE_SPAN_DEG = 1.25;

export type WeatherRegionPoint = {
  latitude: number;
  longitude: number;
  /** Spoken region label (speaker's place string preferred). */
  regionLabel: string;
  /** Provider area label when different. */
  resolvedLabel: string;
  maxSpanDeg: number;
  source: ResolvedGeographicArea["source"];
};

export type WeatherRegionResolve =
  | { status: "point"; point: WeatherRegionPoint }
  | { status: "ask_city"; regionLabel: string; reason: "too_wide" }
  | { status: "unresolved"; regionLabel: string; policyMessageHe: string; kind: string };

/** Bbox center — only after span gate; not a blind fallback for every area. */
export function representativePointFromArea(
  area: ResolvedGeographicArea,
): { latitude: number; longitude: number; maxSpanDeg: number } {
  const { maxSpan, spanLat, spanLng } = viewportSpanDegrees(area.bbox);
  void spanLat;
  void spanLng;
  return {
    latitude: (area.bbox.low.lat + area.bbox.high.lat) / 2,
    longitude: (area.bbox.low.lng + area.bbox.high.lng) / 2,
    maxSpanDeg: maxSpan,
  };
}

export function decideWeatherRegionPoint(
  area: ResolvedGeographicArea,
  spokenPlace: string,
): Extract<WeatherRegionResolve, { status: "point" | "ask_city" }> {
  const regionLabel = spokenPlace.trim() || area.label;
  const { latitude, longitude, maxSpanDeg } = representativePointFromArea(area);
  if (maxSpanDeg > WEATHER_REGION_MAX_REPRESENTATIVE_SPAN_DEG) {
    return { status: "ask_city", regionLabel, reason: "too_wide" };
  }
  return {
    status: "point",
    point: {
      latitude,
      longitude,
      regionLabel,
      resolvedLabel: area.label,
      maxSpanDeg,
      source: area.source,
    },
  };
}

export function formatWeatherRegionAskCity(regionLabel: string): string {
  const label = regionLabel.trim() || "האזור";
  return `«${label}» הוא אזור רחב. באיזו עיר באזור לבדוק את מזג האוויר?`;
}

export function formatWeatherPlaceClarifyAsk(place: string): string {
  const label = place.trim() || "המקום";
  return `לא זיהיתי בוודאות את «${label}». באיזו עיר לבדוק את מזג האוויר?`;
}

/** Display label when forecast uses a representative regional point. */
export function formatWeatherRegionRepresentativeLabel(regionLabel: string): string {
  const label = regionLabel.trim() || "האזור";
  return `${label} (נקודה מייצגת באזור)`;
}

export async function resolveWeatherRegionPlace(input: {
  place: string;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
  resolveArea?: typeof resolveGeographicArea;
}): Promise<WeatherRegionResolve> {
  const place = String(input.place ?? "").trim();
  if (!place) {
    return {
      status: "unresolved",
      regionLabel: "",
      policyMessageHe: "",
      kind: "none",
    };
  }
  const resolveArea = input.resolveArea ?? resolveGeographicArea;
  const resolved: ResolveGeographicAreaResult = await resolveArea({
    place,
    fetchImpl: input.fetchImpl,
    apiKey: input.apiKey,
  });
  if (!resolved.ok) {
    return {
      status: "unresolved",
      regionLabel: place,
      policyMessageHe: resolved.messageHe,
      kind: resolved.kind,
    };
  }
  return decideWeatherRegionPoint(resolved.area, place);
}
