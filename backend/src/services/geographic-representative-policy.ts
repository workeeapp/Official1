/**
 * Domain-agnostic representative-point geometry gate (Stage 2A).
 * Core never invents a point; consumer fit calls this with consumer-supplied maxSpan.
 */

import { viewportSpanDegrees } from "./geo-area-policy.js";
import type {
  GeographicPoint,
  GeographicRepresentativePoint,
  GeographicViewport,
} from "./geographic-match.js";

export type RepresentativePointDecision =
  | {
      ok: true;
      point: GeographicRepresentativePoint;
      center: GeographicPoint;
      maxSpanDeg: number;
    }
  | {
      ok: false;
      reason: "missing_viewport" | "missing_max_span" | "span_too_wide";
      maxSpanDeg?: number;
    };

/**
 * Justify a bbox-center stand-in for a region.
 * Requires an explicit maxSpanDeg from the consumer — no global default.
 */
export function decideJustifiedRepresentativePoint(input: {
  viewport?: GeographicViewport | null;
  maxRepresentativeSpanDeg?: number | null;
}): RepresentativePointDecision {
  const vp = input.viewport;
  if (
    !vp ||
    typeof vp.low?.lat !== "number" ||
    typeof vp.low?.lng !== "number" ||
    typeof vp.high?.lat !== "number" ||
    typeof vp.high?.lng !== "number"
  ) {
    return { ok: false, reason: "missing_viewport" };
  }
  const maxAllowed = input.maxRepresentativeSpanDeg;
  if (
    maxAllowed == null ||
    !Number.isFinite(maxAllowed) ||
    maxAllowed <= 0
  ) {
    return { ok: false, reason: "missing_max_span" };
  }
  const { maxSpan } = viewportSpanDegrees(vp);
  if (maxSpan > maxAllowed) {
    return { ok: false, reason: "span_too_wide", maxSpanDeg: maxSpan };
  }
  const center = {
    lat: (vp.low.lat + vp.high.lat) / 2,
    lng: (vp.low.lng + vp.high.lng) / 2,
  };
  return {
    ok: true,
    center,
    maxSpanDeg: maxSpan,
    point: {
      lat: center.lat,
      lng: center.lng,
      justified: true,
      maxSpanDeg: maxSpan,
    },
  };
}
