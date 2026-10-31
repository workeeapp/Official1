/**
 * LAST_LIVE_LOCATION — place that a successful live domain turn actually used.
 * Persisted on assistant message raw (same pack pattern as lastRoutesBoard).
 * Injected as AVAILABLE fact only — model decides via deixis; engine never auto-applies.
 */

export type LastLiveLocationKind =
  | "pin"
  | "saved"
  | "geocoded"
  | "soft_place_text"
  | "area"
  | "routes_point";

export type LastLiveLocationDomain =
  | "weather"
  | "places"
  | "routes"
  | "jewish";

export type LastLiveLocation = {
  label: string;
  lat: number | null;
  lng: number | null;
  kind: LastLiveLocationKind;
  domain: LastLiveLocationDomain;
  /** ISO timestamp when the live reply used this location. */
  at: string;
  role?: "origin" | "destination" | "place" | "area";
};

const KINDS = new Set<string>([
  "pin",
  "saved",
  "geocoded",
  "soft_place_text",
  "area",
  "routes_point",
]);

const DOMAINS = new Set<string>(["weather", "places", "routes", "jewish"]);

function isFiniteCoord(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

export function parseLastLiveLocation(raw: unknown): LastLiveLocation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const label = typeof row.label === "string" ? row.label.trim() : "";
  const kind = typeof row.kind === "string" ? row.kind.trim() : "";
  const domain = typeof row.domain === "string" ? row.domain.trim() : "";
  const at = typeof row.at === "string" ? row.at.trim() : "";
  if (!label || !KINDS.has(kind) || !DOMAINS.has(domain) || !at) {
    return null;
  }
  const latRaw = row.lat ?? row.latitude;
  const lngRaw = row.lng ?? row.longitude;
  const lat = isFiniteCoord(latRaw) ? latRaw : null;
  const lng = isFiniteCoord(lngRaw) ? lngRaw : null;
  if ((lat == null) !== (lng == null)) {
    return null;
  }
  if (lat != null && (lat < -90 || lat > 90 || lng! < -180 || lng! > 180)) {
    return null;
  }
  const roleRaw = typeof row.role === "string" ? row.role.trim() : "";
  const role =
    roleRaw === "origin" ||
    roleRaw === "destination" ||
    roleRaw === "place" ||
    roleRaw === "area"
      ? roleRaw
      : undefined;
  return {
    label,
    lat,
    lng,
    kind: kind as LastLiveLocationKind,
    domain: domain as LastLiveLocationDomain,
    at,
    ...(role ? { role } : {}),
  };
}

export function buildLastLiveLocation(input: {
  label: string;
  lat?: number | null;
  lng?: number | null;
  kind: LastLiveLocationKind;
  domain: LastLiveLocationDomain;
  at?: Date | string;
  role?: LastLiveLocation["role"];
}): LastLiveLocation | null {
  const label = String(input.label ?? "").trim();
  if (!label) {
    return null;
  }
  const lat = isFiniteCoord(input.lat) ? input.lat : null;
  const lng = isFiniteCoord(input.lng) ? input.lng : null;
  if ((lat == null) !== (lng == null)) {
    return null;
  }
  if (lat != null && (lat < -90 || lat > 90 || lng! < -180 || lng! > 180)) {
    return null;
  }
  const at =
    typeof input.at === "string" && input.at.trim()
      ? input.at.trim()
      : input.at instanceof Date
        ? input.at.toISOString()
        : new Date().toISOString();
  return parseLastLiveLocation({
    label,
    lat,
    lng,
    kind: input.kind,
    domain: input.domain,
    at,
    ...(input.role ? { role: input.role } : {}),
  });
}

/** Injected next to PENDING_LOCATION — AVAILABLE only (Stage 2 deixis still applies). */
export function formatLastLiveLocationContext(
  loc: LastLiveLocation | null | undefined,
): string {
  if (!loc) {
    return "";
  }
  return [
    "LAST_LIVE_LOCATION:",
    JSON.stringify({
      label: loc.label,
      lat: loc.lat,
      lng: loc.lng,
      kind: loc.kind,
      domain: loc.domain,
      at: loc.at,
      ...(loc.role ? { role: loc.role } : {}),
    }),
    "Place last used successfully by a live weather/places/routes/jewish reply — AVAILABLE only, not an automatic instruction.",
    "For anaphora («שם» / «ליד המקום» / «באזור שדיברנו») when THIS label is the clearer referent AND no competing PENDING_LOCATION pin also fits → re-emit label in place/origin/destination (near empty unless kind is pin and deixis clearly means the pin).",
    "When PENDING_LOCATION is also present in THIS turn and bare «שם» / unclear deixis could mean the pin OR this label → ASK one short question (pin vs this place); leave weather/places/routes/jewish null — FORBIDDEN preferring this LAST_LIVE_LOCATION merely because it is AVAILABLE.",
    "Explicit city/saved name in the current ask, clear PENDING_LOCATION pin deixis, or other unambiguous Stage 2 deixis → follow that cue (do not force this anchor; do not ask when clear). Do not invent coordinates.",
  ].join("\n");
}
