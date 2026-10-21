/**
 * Last WhatsApp location pin per speaker (in-memory, 48h TTL).
 * Injected as PENDING_LOCATION; used by places nearby / routes origin=speaker.
 */

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
  if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) {
    return;
  }
  byEmployee.set(id, {
    lat: loc.lat,
    lng: loc.lng,
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
    "Speaker shared this WhatsApp pin. «באזור שלי» → metadata.places { query, place:\"\", near:\"speaker\" }. «מכאן» trip → metadata.routes origin \"speaker\". Do not invent coordinates.",
  ].join("\n");
}
