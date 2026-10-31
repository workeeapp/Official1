/**
 * Shared location representation for live domains (Stage A).
 * Coordinates are canonical; address/name are optional display only.
 * No DB / second global store — PENDING_LOCATION remains the pin cache.
 *
 * resolveActionLocation: ACTION intent → coords for weather/places.
 * Place/saved wins over a pending pin; pin only when near=speaker + empty place.
 */

import type { EmployeeRecordSnapshot } from "./employee-records.service.js";
import type { GeoAreaGeometry } from "./geo-area.js";
import type { PendingLocation } from "./pending-location.js";
import {
  formatSavedLabelMissingCoordsAsk,
  formatSavedRouteAmbiguousAsk,
  matchSavedPlaceWithoutCoords,
  resolveSavedRoutePoint,
  type SavedLocationContactRef,
} from "./saved-route-location.js";

export type ResolvedLocationSource =
  | "whatsapp_pin"
  | "action_coords"
  | "geocode"
  | "saved";

export type ResolvedLocation = {
  lat: number;
  lng: number;
  address?: string;
  placeName?: string;
  source: ResolvedLocationSource;
  /** Display label: name || address || neutral pin label (never invent an address). */
  label: string;
};

/**
 * SW–NE rectangle for hard Places locationRestriction (B2a).
 * Optional `geometry` carries the true region (Polygon/MultiPolygon) when
 * known — Places uses the box for the API and geometry for post-filter.
 */
export type ResolvedViewport = {
  low: { lat: number; lng: number };
  high: { lat: number; lng: number };
  label: string;
  source: "geocode_viewport" | "osm_nominatim" | "geo_area_index";
  /** RFC7946 Polygon/MultiPolygon ([lng,lat]); omit only for legacy stubs. */
  geometry?: GeoAreaGeometry;
};

export function isValidViewport(v: {
  low: { lat: number; lng: number };
  high: { lat: number; lng: number };
}): boolean {
  if (
    !isValidLatitude(v.low.lat) ||
    !isValidLongitude(v.low.lng) ||
    !isValidLatitude(v.high.lat) ||
    !isValidLongitude(v.high.lng)
  ) {
    return false;
  }
  if (v.low.lat > v.high.lat) {
    return false;
  }
  // Empty point box rejected; require a positive span in at least one axis.
  if (v.low.lat === v.high.lat && v.low.lng === v.high.lng) {
    return false;
  }
  // Longitude span must be ≤ 180° (Google Viewport rule).
  const lngSpan = Math.abs(v.high.lng - v.low.lng);
  if (lngSpan > 180) {
    return false;
  }
  return true;
}

/** Hebrew marker shared by Places / Routes ask-for-pin replies. */
export const ASK_FOR_WHATSAPP_PIN_MARKER = "שלח מיקום בוואטסאפ";

/** Neutral label when pin has no name/address. */
export const NEUTRAL_PIN_LABEL = "המיקום שלך";

export function isValidLatitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180
  );
}

export function parseCoordinatePair(
  lat: unknown,
  lng: unknown,
): { lat: number; lng: number } | null {
  const la = typeof lat === "number" ? lat : Number(lat);
  const ln = typeof lng === "number" ? lng : Number(lng);
  if (!isValidLatitude(la) || !isValidLongitude(ln)) {
    return null;
  }
  return { lat: la, lng: ln };
}

export function displayLabelForPin(loc: {
  name?: string | null;
  address?: string | null;
  lat: number;
  lng: number;
}): string {
  const name = String(loc.name ?? "").trim();
  if (name) return name;
  const address = String(loc.address ?? "").trim();
  if (address) return address;
  return NEUTRAL_PIN_LABEL;
}

export function fromPendingLocation(
  loc: PendingLocation | null | undefined,
): ResolvedLocation | null {
  if (!loc) return null;
  const pair = parseCoordinatePair(loc.lat, loc.lng);
  if (!pair) return null;
  const placeName = String(loc.name ?? "").trim() || undefined;
  const address = String(loc.address ?? "").trim() || undefined;
  return {
    lat: pair.lat,
    lng: pair.lng,
    placeName,
    address,
    source: "whatsapp_pin",
    label: displayLabelForPin({
      name: placeName,
      address,
      lat: pair.lat,
      lng: pair.lng,
    }),
  };
}

export function fromActionCoords(
  lat: unknown,
  lng: unknown,
  label?: string,
): ResolvedLocation | null {
  const pair = parseCoordinatePair(lat, lng);
  if (!pair) return null;
  const trimmed = String(label ?? "").trim();
  return {
    lat: pair.lat,
    lng: pair.lng,
    source: "action_coords",
    label: trimmed || NEUTRAL_PIN_LABEL,
    ...(trimmed ? { placeName: trimmed } : {}),
  };
}

/** Saved filing/list row that already stores valid lat,lng. */
export function fromSavedCoords(
  lat: unknown,
  lng: unknown,
  label?: string,
): ResolvedLocation | null {
  const pair = parseCoordinatePair(lat, lng);
  if (!pair) return null;
  const trimmed = String(label ?? "").trim();
  return {
    lat: pair.lat,
    lng: pair.lng,
    source: "saved",
    label: trimmed || NEUTRAL_PIN_LABEL,
    ...(trimmed ? { placeName: trimmed } : {}),
  };
}

export type ActionLocationResult =
  | {
      kind: "hit";
      location: ResolvedLocation;
      /** True only when the hit came from PENDING_LOCATION via near=speaker. */
      usedPendingPin: boolean;
    }
  | {
      kind: "ambiguous";
      askText: string;
    }
  | {
      kind: "label_without_coords";
      askText: string;
    }
  | { kind: "need_pin" }
  | { kind: "none" };

/**
 * Resolve weather/places ACTION location from intent, not mere availability.
 *
 * 1. Non-empty place → saved coords (hit) / ambiguous ask / address-like
 *    label without coords (ask, never geocode that label) / none (named city).
 * 2. Else near=speaker → PENDING_LOCATION or need_pin.
 * 3. Else none.
 *
 * A pending pin is never used when place is set. Never invents coordinates.
 */
export function resolveActionLocation(input: {
  place: string;
  nearSpeaker: boolean;
  pending: PendingLocation | null | undefined;
  snapshot:
    | Pick<EmployeeRecordSnapshot, "lists" | "filing">
    | null
    | undefined;
  /** SPEAKER_CONTACTS — description may hold coords or a street note. */
  contacts?: SavedLocationContactRef[] | null;
}): ActionLocationResult {
  const place = String(input.place ?? "").trim();
  if (place) {
    const saved = resolveSavedRoutePoint(
      place,
      input.snapshot,
      input.contacts,
    );
    if (saved.kind === "hit") {
      const location = fromSavedCoords(saved.lat, saved.lng, saved.label);
      if (!location) {
        return {
          kind: "label_without_coords",
          askText: formatSavedLabelMissingCoordsAsk(saved.label),
        };
      }
      return { kind: "hit", location, usedPendingPin: false };
    }
    if (saved.kind === "ambiguous") {
      return {
        kind: "ambiguous",
        askText: formatSavedRouteAmbiguousAsk(place, saved.options),
      };
    }
    const noCoords = matchSavedPlaceWithoutCoords(
      place,
      input.snapshot,
      input.contacts,
    );
    if (noCoords.kind === "unique") {
      return {
        kind: "label_without_coords",
        askText: formatSavedLabelMissingCoordsAsk(noCoords.row.label),
      };
    }
    if (noCoords.kind === "ambiguous") {
      return {
        kind: "ambiguous",
        askText: formatSavedRouteAmbiguousAsk(place, noCoords.options),
      };
    }
    return { kind: "none" };
  }

  if (input.nearSpeaker) {
    const pin = fromPendingLocation(input.pending);
    if (!pin) {
      return { kind: "need_pin" };
    }
    return { kind: "hit", location: pin, usedPendingPin: true };
  }

  return { kind: "none" };
}

export function fromGeocode(place: {
  name: string;
  latitude: number;
  longitude: number;
}): ResolvedLocation | null {
  const pair = parseCoordinatePair(place.latitude, place.longitude);
  if (!pair) return null;
  const name = String(place.name ?? "").trim() || NEUTRAL_PIN_LABEL;
  return {
    lat: pair.lat,
    lng: pair.lng,
    placeName: name,
    source: "geocode",
    label: name,
  };
}

/** True when the spoken reply only asks the user to share a WhatsApp pin. */
export function replyAsksForWhatsAppPin(text: string): boolean {
  return String(text ?? "").includes(ASK_FOR_WHATSAPP_PIN_MARKER);
}

/**
 * Clear PENDING_LOCATION only after a successful op that actually used the pin.
 * Named-place / ask-for-pin / unused pin → keep pending.
 */
export function shouldClearPendingAfterSpeakerPinUse(opts: {
  usedPendingPin: boolean;
  needsLocation?: boolean;
  replyText?: string;
}): boolean {
  if (!opts.usedPendingPin) {
    return false;
  }
  if (opts.needsLocation === true) {
    return false;
  }
  if (opts.replyText != null && replyAsksForWhatsAppPin(opts.replyText)) {
    return false;
  }
  return true;
}
