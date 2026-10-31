/**
 * Consumer capabilities + adaptMatchForConsumer (Stage 2A).
 * Domain-agnostic: no if weather/places — only capability flags.
 */

import {
  geographicNeedsClarify,
  geographicUnsupportedForConsumer,
  type GeographicKind,
  type GeographicMatch,
} from "./geographic-match.js";
import { decideJustifiedRepresentativePoint } from "./geographic-representative-policy.js";

export type GeographicConsumerCapabilities = {
  accepts: GeographicKind[];
  requiresExactPoint: boolean;
  acceptsViewport: boolean;
  acceptsPolygon: boolean;
  allowsJustifiedRepresentativePoint: boolean;
  /**
   * Required to invent a justified representative point.
   * Omit / null → never invent (clarify or unsupported instead).
   */
  maxRepresentativeSpanDeg?: number | null;
};

export function adaptMatchForConsumer(
  match: GeographicMatch,
  capabilities: GeographicConsumerCapabilities,
): GeographicMatch {
  if (
    match.status === "ambiguous" ||
    match.status === "needs_clarify" ||
    match.status === "unsupported_for_consumer"
  ) {
    return match;
  }

  const accepts = new Set(capabilities.accepts);
  if (!accepts.has(match.kind)) {
    return geographicUnsupportedForConsumer({
      asked: match.asked,
      kind: match.kind,
      labelHe: match.labelHe,
      policyTrace: match.policyTrace,
      userAskHe: `לא ניתן להשתמש ב«${match.labelHe}» לסוג הבקשה הזו. אפשר לציין עיר או מקום מדויק יותר?`,
    });
  }

  if (match.kind === "region") {
    const hasAreaGeom =
      (capabilities.acceptsViewport && match.geometry?.viewport != null) ||
      (capabilities.acceptsPolygon && match.geometry?.polygon != null);

    if (hasAreaGeom && !capabilities.requiresExactPoint) {
      return match;
    }

    if (
      capabilities.requiresExactPoint &&
      capabilities.allowsJustifiedRepresentativePoint
    ) {
      const decision = decideJustifiedRepresentativePoint({
        viewport: match.geometry?.viewport,
        maxRepresentativeSpanDeg: capabilities.maxRepresentativeSpanDeg,
      });
      if (decision.ok) {
        return {
          ...match,
          representativePoint: decision.point,
        };
      }
      return geographicNeedsClarify({
        asked: match.asked,
        kind: "region",
        labelHe: match.labelHe,
        policyTrace: `representative_denied:${decision.reason}`,
        userAskHe: `«${match.labelHe}» הוא אזור רחב. באיזו עיר באזור מדובר?`,
      });
    }

    if (capabilities.requiresExactPoint) {
      return geographicNeedsClarify({
        asked: match.asked,
        kind: "region",
        labelHe: match.labelHe,
        policyTrace: "region_requires_point_no_representative",
        userAskHe: `«${match.labelHe}» הוא אזור. באיזו עיר לבדוק?`,
      });
    }

    if (!hasAreaGeom) {
      return geographicUnsupportedForConsumer({
        asked: match.asked,
        kind: "region",
        labelHe: match.labelHe,
        userAskHe: `לא הצלחתי להשתמש באזור «${match.labelHe}» לבקשה הזו. אפשר לציין עיר?`,
      });
    }
  }

  if (
    capabilities.requiresExactPoint &&
    match.geometry?.point == null &&
    !match.representativePoint
  ) {
    return geographicNeedsClarify({
      asked: match.asked,
      kind: match.kind,
      labelHe: match.labelHe,
      userAskHe: `לאיזה מקום מדויק התייחסת ב«${match.labelHe}»?`,
    });
  }

  return match;
}

/** Weather consumer caps — point forecast; region only via justified representative. */
export const WEATHER_CONSUMER_CAPABILITIES: GeographicConsumerCapabilities = {
  accepts: ["point", "city", "neighborhood", "pin", "saved", "region"],
  requiresExactPoint: true,
  acceptsViewport: false,
  acceptsPolygon: false,
  allowsJustifiedRepresentativePoint: true,
  // Documented Weather threshold (Sharon-class vs Negev) — consumer-local only.
  maxRepresentativeSpanDeg: 1.25,
};

/** @deprecated Alias — prefer WEATHER_CONSUMER_CAPABILITIES. */
export const WEATHER_CONSUMER_CAPABILITIES_EXAMPLE =
  WEATHER_CONSUMER_CAPABILITIES;

/** Places area_restrict — region viewport / polygon for locationRestriction. */
export const PLACES_AREA_CONSUMER_CAPABILITIES: GeographicConsumerCapabilities =
  {
    accepts: ["region", "city", "point", "neighborhood", "saved", "pin"],
    requiresExactPoint: false,
    acceptsViewport: true,
    acceptsPolygon: true,
    allowsJustifiedRepresentativePoint: false,
  };

/** @deprecated Alias — prefer PLACES_AREA_CONSUMER_CAPABILITIES. */
export const PLACES_AREA_CONSUMER_CAPABILITIES_EXAMPLE =
  PLACES_AREA_CONSUMER_CAPABILITIES;

/**
 * Places soft / near — bias point from city, pin, or saved (no region centroid).
 */
export const PLACES_SOFT_CONSUMER_CAPABILITIES: GeographicConsumerCapabilities =
  {
    accepts: ["point", "city", "neighborhood", "poi", "saved", "pin"],
    requiresExactPoint: true,
    acceptsViewport: false,
    acceptsPolygon: false,
    allowsJustifiedRepresentativePoint: false,
  };

/** Routes O/D — usable point only; never invent a region centroid. */
export const ROUTES_ENDPOINT_CONSUMER_CAPABILITIES: GeographicConsumerCapabilities =
  {
    accepts: ["point", "city", "neighborhood", "poi", "saved", "pin"],
    requiresExactPoint: true,
    acceptsViewport: false,
    acceptsPolygon: false,
    allowsJustifiedRepresentativePoint: false,
  };

/** @deprecated Alias — prefer ROUTES_ENDPOINT_CONSUMER_CAPABILITIES. */
export const ROUTES_ENDPOINT_CONSUMER_CAPABILITIES_EXAMPLE =
  ROUTES_ENDPOINT_CONSUMER_CAPABILITIES;

/**
 * Jewish place resolve — pin/saved/city points; no region representative.
 * Named cities may still fall through to Hebcal geonameid outside Core.
 */
export const JEWISH_CONSUMER_CAPABILITIES: GeographicConsumerCapabilities = {
  accepts: ["point", "city", "neighborhood", "poi", "saved", "pin"],
  requiresExactPoint: true,
  acceptsViewport: false,
  acceptsPolygon: false,
  allowsJustifiedRepresentativePoint: false,
};
