/**
 * Shared location representation for live domains (Stage A).
 * Coordinates are canonical; address/name are optional display only.
 * No DB / second global store — PENDING_LOCATION remains the pin cache.
 */

import type { PendingLocation } from "./pending-location.js";

export type ResolvedLocationSource =
  | "whatsapp_pin"
  | "action_coords"
  | "geocode";

export type ResolvedLocation = {
  lat: number;
  lng: number;
  address?: string;
  placeName?: string;
  source: ResolvedLocationSource;
  /** Display label: name || address || neutral pin label (never invent an address). */
  label: string;
};

/** SW–NE rectangle for hard Places locationRestriction (B2a). */
export type ResolvedViewport = {
  low: { lat: number; lng: number };
  high: { lat: number; lng: number };
  label: string;
  source: "geocode_viewport";
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
