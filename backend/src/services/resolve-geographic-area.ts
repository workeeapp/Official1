/**
 * Generic geographic-area resolution for Lucy domains (Places, weather, …).
 *
 * Pipeline (see resolvePlaceViewport):
 * 1. Documented local index
 * 2. Google Geocoding (multi-signal filtered viewport)
 * 3. Nominatim only when explicitly enabled
 *
 * Domain adapters decide how to consume bbox vs full geometry.
 */
import {
  buildResolvedGeographicArea,
  geographicAreaFromViewportBox,
  type ResolveGeographicAreaResult,
} from "./geo-area.js";
import { resolvePlaceViewport } from "./geocode-viewport.js";

export type {
  ResolveGeographicAreaResult,
  ResolvedGeographicArea,
} from "./geo-area.js";

export async function resolveGeographicArea(input: {
  place: string;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
  allowNominatimFallback?: boolean;
  allowIndexLookup?: boolean;
}): Promise<ResolveGeographicAreaResult> {
  const resolved = await resolvePlaceViewport(input);
  if (!resolved.ok) {
    return {
      ok: false,
      kind: resolved.kind,
      messageHe: resolved.messageHe,
    };
  }
  const vp = resolved.viewport;
  if (vp.geometry) {
    const area = buildResolvedGeographicArea({
      label: vp.label,
      geometry: vp.geometry,
      source: vp.source,
    });
    if (area) {
      return { ok: true, area };
    }
  }
  const fromBox = geographicAreaFromViewportBox({
    label: vp.label,
    low: vp.low,
    high: vp.high,
    source: vp.source,
  });
  if (!fromBox) {
    return {
      ok: false,
      kind: "invalid",
      messageHe: `לא הצלחתי לקבוע גבולות ל«${input.place}». נסה עיר או אזור אחר.`,
    };
  }
  return { ok: true, area: fromBox };
}
