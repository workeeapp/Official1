/**
 * Last WhatsApp location pin per speaker (in-memory, 48h TTL).
 * Injected as PENDING_LOCATION; used by places nearby / routes origin=speaker.
 *
 * Limits (by design — no second conversation-state store):
 * - Process-local Map only: lost on restart / multi-instance not shared.
 * - Static `location` pins only (`live_location` is not ingested).
 * - Out-of-range coords are refused here and at WhatsApp ingest.
 */

import { parseCoordinatePair } from "./resolved-location.js";

export type PendingLocation = {
  lat: number;
  lng: number;
  name: string;
  address: string;
  at: number;
};

const TTL_MS = 48 * 60 * 60 * 1000;
const byEmployee = new Map<string, PendingLocation>();

export function setPendingLocation(
  employeeId: string,
  loc: Omit<PendingLocation, "at">,
): void {
  const id = employeeId.trim();
  if (!id) {
    return;
  }
  const pair = parseCoordinatePair(loc.lat, loc.lng);
  if (!pair) {
    return;
  }
  byEmployee.set(id, {
    lat: pair.lat,
    lng: pair.lng,
    name: String(loc.name ?? "").trim(),
    address: String(loc.address ?? "").trim(),
    at: Date.now(),
  });
}

export function getPendingLocation(employeeId: string): PendingLocation | null {
  const id = employeeId.trim();
  if (!id) {
    return null;
  }
  const row = byEmployee.get(id);
  if (!row) {
    return null;
  }
  if (Date.now() - row.at > TTL_MS) {
    byEmployee.delete(id);
    return null;
  }
  return row;
}

export function clearPendingLocation(employeeId: string): void {
  byEmployee.delete(employeeId.trim());
}

/** Test helper. */
export function resetPendingLocations(): void {
  byEmployee.clear();
}

export function formatPendingLocationContext(
  loc: PendingLocation | null,
): string {
  if (!loc) {
    return "";
  }
  const label =
    loc.name || loc.address || `${loc.lat.toFixed(5)},${loc.lng.toFixed(5)}`;
  return [
    "PENDING_LOCATION:",
    JSON.stringify({
      lat: loc.lat,
      lng: loc.lng,
      name: loc.name,
      address: loc.address,
      label,
    }),
    "Speaker shared this WhatsApp pin — AVAILABLE only, not an automatic instruction.",
    "Use it ONLY when the speaker clearly means this pin (near-me deixis / «שם» / «מהמיקום ששלחתי» / «מכאן»).",
    "Then: places { query, place:\"\", near:\"speaker\" } | weather { place:\"\", near:\"speaker\", aspects } | routes origin \"speaker\".",
    "Named city/place → use that place string; FORBIDDEN substituting this pin. Vague «מה יש לידי?» with no clear deixis → ASK for a pin/clarification (do not emit near=speaker just because PENDING_LOCATION exists).",
    "Do not invent coordinates.",
  ].join("\n");
}
