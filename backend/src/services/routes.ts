/**
 * Live public-transit A→B via Google Routes API (travelMode TRANSIT),
 * plus stop-board lines via Places API transitStation.
 * Official MOT GTFS aspects: schedule | nearest_stop (static feed; not RT).
 * Official MOT SIRI-SM aspect: live_arrivals (predictions; not schedule).
 * Model→Action→Engine: engine formats API/DB facts; never invents times/lines.
 */
import { getEnv } from "../config/env.js";
import { prisma } from "../database/prisma.js";
import {
  formatAmbiguityHebrew,
  formatNearestStopHebrew,
  formatScheduleHebrew,
  getActiveGenerationId,
  GTFS_OFFICIAL_SOURCE_HE,
  isGtfsEnabled,
  queryNearestStop,
  querySchedule,
  resolveGtfsAgencyHint,
  resolveScheduleStopRef,
} from "./gtfs-query.js";
import { jerusalemYmd } from "./gtfs-time.js";
import type { ComposeLlmBilling } from "./llm-usage.service.js";
import {
  formatLiveSelectFailureReply,
  LIVE_SELECT_NO_MATCH_HE,
  runLivePostSelect,
  type LiveRetrievalRecord,
  type LiveSelectApplyResult,
} from "./live-retrieval-select.js";
import {
  fetchSiriStopArrivals,
  filterSiriArrivals,
  formatSiriArrivalsHebrew,
  isSiriSmConfigured,
  type SiriFetchResult,
} from "./siri-sm.js";
import { geocodePlace as geocodePlaceOpenMeteo } from "./weather.js";

export type RoutesAspect =
  | "summary"
  | "duration"
  | "steps"
  | "fare"
  | "eta"
  | "frequency"
  | "lines"
  | "schedule"
  | "nearest_stop"
  | "live_arrivals";

export type RouteStepFact = {
  travelMode: string;
  instruction: string;
  line: string;
  headsign: string;
  fromStop: string;
  toStop: string;
  departureTime: string;
  /** RFC3339 when Google returned absolute departure. */
  departureIso: string;
  arrivalTime: string;
  durationText: string;
  /** Step duration from Google staticDuration (null when absent). */
  durationSeconds: number | null;
  /** Expected seconds between departures (Google headway). */
  headwaySeconds: number | null;
};

/** One Google computeRoutes alternative (fields only from that route). */
export type RouteItineraryOption = {
  durationText: string;
  durationSeconds: number | null;
  distanceMeters: number | null;
  fareText: string;
  leaveByText: string;
  arriveByText: string;
  steps: RouteStepFact[];
};

export type RoutesFacts = {
  origin: string;
  destination: string;
  departure: string;
  arrival: string;
  line: string;
  headsign: string;
  /** transit (default) or drive. */
  mode: RoutesTravelMode;
  aspects: RoutesAspect[];
  durationText: string;
  durationSeconds: number | null;
  distanceMeters: number | null;
  leaveByText: string;
  arriveByText: string;
  fareText: string;
  /** Minutes until next matching transit departure (eta aspect). */
  etaMinutes: number | null;
  headwaySeconds: number | null;
  steps: RouteStepFact[];
  /**
   * Google alternative itineraries for trip compare (empty for lines board /
   * line-ETA focus). Primary fields above stay routes[0]; multi format uses
   * length > 1.
   */
  itineraries: RouteItineraryOption[];
  navigateAddress: string;
  /**
   * True when a line/headsign filter was set but no matching boarding step
   * was found (or boarding stop did not match the asked origin).
   */
  lineMatchFailed: boolean;
  /** Matched boarding stop name from Google (when filter succeeded). */
  matchedFromStop: string;
  /** Matched line short name from Google (when filter succeeded). */
  matchedLine: string;
  /** Stop-board line short names (aspects lines) from Places transitStation. */
  stopLines: string[];
  /** Display name of the matched transit station for the board. */
  stopDisplayName: string;
};

const ASPECT_SET = new Set<RoutesAspect>([
  "summary",
  "duration",
  "steps",
  "fare",
  "eta",
  "frequency",
  "lines",
  "schedule",
  "nearest_stop",
  "live_arrivals",
]);

const COMPUTE_ROUTES_URL =
  "https://routes.googleapis.com/directions/v2:computeRoutes";

const PLACES_SEARCH_TEXT_URL =
  "https://places.googleapis.com/v1/places:searchText";

const FIELD_MASK = [
  "routes.duration",
  "routes.distanceMeters",
  "routes.legs.duration",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.staticDuration",
  "routes.legs.steps.navigationInstruction",
  "routes.legs.steps.transitDetails",
  "routes.localizedValues",
  "routes.travelAdvisory.transitFare",
].join(",");

const STOP_BOARD_FIELD_MASK = [
  "places.displayName",
  "places.formattedAddress",
  "places.transitStation",
].join(",");

/** Places Text Search fields for named-place → lat/lng (nearest_stop). */
const PLACE_GEOCODE_FIELD_MASK = [
  "places.displayName",
  "places.formattedAddress",
  "places.location",
].join(",");

export const ROUTES_API_KEY_MISSING = "routes_api_key_missing";
export const ROUTES_API_DENIED = "routes_api_denied";
export const ROUTES_ZERO_RESULTS = "routes_zero_results";

/** Summary trip step display cap (aspects include summary, not dedicated steps). */
export const ROUTES_STEPS_SUMMARY_DISPLAY_CAP = 8;
/** Dedicated steps-aspect display cap. */
export const ROUTES_STEPS_DETAIL_DISPLAY_CAP = 12;

/** Confirmed local trip-step display truncation — not a provider claim. */
export const ROUTES_STEPS_LOCAL_TRUNCATION_HE =
  "(מוצגים חלק משלבי המסלול — יש עוד שלא הוצגו בגלל מגבלת תצוגה.)";

/** Max Google alternatives shown in a multi-option reply. */
export const ROUTES_ITINERARY_DISPLAY_CAP = 3;

/** Honesty: Google times are estimates, not official timetable / RT verified. */
export const ROUTES_MULTI_ESTIMATE_DISCLAIMER_HE =
  "(זמנים משוערים מגוגל — לא לוח זמנים רשמי ולא אימות בזמן אמת.)";

/** Car / DRIVE estimates (traffic-aware when Google returns them). */
export const ROUTES_DRIVE_ESTIMATE_DISCLAIMER_HE =
  "(זמני נסיעה משוערים מגוגל — תלוי בעומס בפועל.)";

export type RoutesTravelMode = "transit" | "drive";

export function parseRoutesAspects(raw: unknown): RoutesAspect[] {
  if (!Array.isArray(raw)) {
    return ["summary"];
  }
  const out: RoutesAspect[] = [];
  for (const entry of raw) {
    const key = String(entry ?? "")
      .trim()
      .toLowerCase() as RoutesAspect;
    if (ASPECT_SET.has(key) && !out.includes(key)) {
      out.push(key);
    }
  }
  return out.length > 0 ? out : ["summary"];
}

function wants(aspects: RoutesAspect[], key: RoutesAspect): boolean {
  return aspects.includes("summary") || aspects.includes(key);
}

function resolveRoutesApiKey(override?: string | null): string | null {
  // Explicit override (including "") wins — tests pass apiKey: "" for missing-key.
  if (override !== undefined && override !== null) {
    return override.trim() || null;
  }
  const env = getEnv();
  return (
    (env.GOOGLE_ROUTES_API_KEY ?? "").trim() ||
    (env.GOOGLE_PLACES_API_KEY ?? "").trim() ||
    null
  );
}

export type GeocodeNamedPlaceResult =
  | { ok: true; lat: number; lng: number; label: string }
  | {
      ok: false;
      kind: "empty" | "ambiguous";
      messageHe: string;
      options?: string[];
    };

type PlacesGeocodeHit = {
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
};

function haversineMetersQuick(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Resolve a spoken address/place to coordinates for GTFS nearest_stop.
 * Prefers Google Places Text Search (same key as Routes/Places); falls back to
 * Open-Meteo city geocode when Places is unavailable or empty.
 * Never invents coordinates — empty/ambiguous → ask.
 */
export async function geocodeNamedPlaceForNearestStop(input: {
  query: string;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
}): Promise<GeocodeNamedPlaceResult> {
  const q = String(input.query ?? "").trim();
  if (!q || q.toLowerCase() === "speaker") {
    return {
      ok: false,
      kind: "empty",
      messageHe: "לאיזה מיקום לחפש תחנה קרובה? שלח סיכת מיקום או כתובת.",
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const apiKey = resolveRoutesApiKey(input.apiKey);

  if (apiKey) {
    try {
      const res = await fetchImpl(PLACES_SEARCH_TEXT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": PLACE_GEOCODE_FIELD_MASK,
        },
        body: JSON.stringify({
          textQuery: q,
          languageCode: "he",
          regionCode: "IL",
          maxResultCount: 5,
        }),
      });
      let json: { places?: PlacesGeocodeHit[]; error?: { status?: string } } =
        {};
      try {
        json = (await res.json()) as typeof json;
      } catch {
        json = {};
      }
      if (res.ok && !json.error) {
        const hits = (Array.isArray(json.places) ? json.places : [])
          .map((p) => {
            const lat = p.location?.latitude;
            const lng = p.location?.longitude;
            if (
              typeof lat !== "number" ||
              typeof lng !== "number" ||
              !Number.isFinite(lat) ||
              !Number.isFinite(lng)
            ) {
              return null;
            }
            const label =
              String(p.displayName?.text ?? "").trim() ||
              String(p.formattedAddress ?? "").trim() ||
              q;
            return { lat, lng, label };
          })
          .filter((row): row is { lat: number; lng: number; label: string } =>
            Boolean(row),
          );

        if (hits.length === 1) {
          return { ok: true, ...hits[0]! };
        }
        if (hits.length > 1) {
          const first = hits[0]!;
          const far = hits.filter(
            (h) => haversineMetersQuick(first.lat, first.lng, h.lat, h.lng) > 400,
          );
          // Clustered hits → take closest Google rank; spread hits → ask.
          if (far.length === 0) {
            return { ok: true, ...first };
          }
          const options = [
            ...new Set(hits.map((h) => h.label).filter(Boolean)),
          ].slice(0, 5);
          return {
            ok: false,
            kind: "ambiguous",
            messageHe: `מצאתי כמה מקומות ל«${q}». לאיזה התכוונת?`,
            options,
          };
        }
      }
    } catch {
      // Fall through to Open-Meteo.
    }
  }

  try {
    const geo = await geocodePlaceOpenMeteo(q, fetchImpl);
    if (geo) {
      return {
        ok: true,
        lat: geo.latitude,
        lng: geo.longitude,
        label: geo.name || q,
      };
    }
  } catch {
    // ignore
  }

  return {
    ok: false,
    kind: "empty",
    messageHe: `לא הצלחתי לזהות את המיקום «${q}». שלח סיכת מיקום בוואטסאפ או כתובת מדויקת יותר.`,
  };
}

/** Model local / ISO → RFC3339 for Routes API. Empty → null. */
export function toRoutesRfc3339(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) {
    return null;
  }
  if (
    /^\d{4}-\d{2}-\d{2}T/.test(s) &&
    (/Z$/i.test(s) || /[+-]\d{2}:\d{2}$/.test(s))
  ) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const m = s.match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const ymd = m[1]!;
  const hh = m[2]!.padStart(2, "0");
  const mm = m[3]!;
  const ss = (m[4] ?? "00").padStart(2, "0");
  return jerusalemLocalToUtcIso(ymd, `${hh}:${mm}:${ss}`);
}

function jerusalemLocalToUtcIso(ymd: string, hms: string): string | null {
  const [y, mo, d] = ymd.split("-").map(Number);
  const [h, mi, s] = hms.split(":").map(Number);
  if (![y, mo, d, h, mi, s].every((n) => Number.isFinite(n))) {
    return null;
  }
  let utc = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Jerusalem",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(utc))
        .filter((p) => p.type !== "literal")
        .map((p) => [p.type, p.value]),
    );
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const desired = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
    const delta = desired - asUtc;
    if (delta === 0) {
      break;
    }
    utc += delta;
  }
  return new Date(utc).toISOString();
}

function parseDurationSeconds(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.round(raw);
  }
  const s = String(raw ?? "").trim();
  const m = s.match(/^(\d+)s$/i);
  if (m) {
    return Number(m[1]);
  }
  return null;
}

function formatDurationHe(seconds: number | null): string {
  if (seconds == null || seconds < 0) {
    return "";
  }
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) {
    return `${totalMin} דקות`;
  }
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (m === 0) {
    return h === 1 ? "שעה" : `${h} שעות`;
  }
  return `${h}:${String(m).padStart(2, "0")} שעות`;
}

function formatHmJerusalem(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

/** Display label for arrival/departure field (HH:mm if parseable). */
function displayClockLabel(raw: string): string {
  const rfc = toRoutesRfc3339(raw);
  if (rfc) {
    return formatHmJerusalem(rfc) || raw.trim();
  }
  const hm = raw.trim().match(/(\d{1,2}):(\d{2})/);
  return hm ? `${hm[1]!.padStart(2, "0")}:${hm[2]}` : raw.trim();
}

type ApiStep = {
  travelMode?: string;
  staticDuration?: string;
  navigationInstruction?: { instructions?: string };
  transitDetails?: {
    stopDetails?: {
      departureStop?: { name?: string };
      arrivalStop?: { name?: string };
      departureTime?: string;
      arrivalTime?: string;
    };
    headsign?: string;
    headway?: string;
    transitLine?: {
      nameShort?: string;
      name?: string;
    };
    localizedValues?: {
      departureTime?: { time?: { text?: string } };
      arrivalTime?: { time?: { text?: string } };
    };
  };
};

type ApiRoute = {
  duration?: string;
  distanceMeters?: number;
  localizedValues?: {
    duration?: { text?: string };
  };
  travelAdvisory?: {
    transitFare?: { currencyCode?: string; units?: string };
  };
  legs?: Array<{ steps?: ApiStep[] }>;
};

type ComputeRoutesResponse = {
  routes?: ApiRoute[];
  error?: { code?: number; message?: string; status?: string };
};

function isPermissionDenied(
  status: number,
  body: ComputeRoutesResponse,
): boolean {
  if (status === 403 || status === 401) {
    return true;
  }
  const errStatus = String(body.error?.status ?? "").toUpperCase();
  const msg = String(body.error?.message ?? "").toLowerCase();
  return (
    errStatus === "PERMISSION_DENIED" ||
    errStatus === "REQUEST_DENIED" ||
    msg.includes("permission") ||
    msg.includes("not enabled") ||
    msg.includes("api key")
  );
}

function mapStep(step: ApiStep): RouteStepFact {
  const travelMode = String(step.travelMode ?? "").toUpperCase() || "WALK";
  const instruction = String(
    step.navigationInstruction?.instructions ?? "",
  ).trim();
  const td = step.transitDetails;
  const line = String(
    td?.transitLine?.nameShort ?? td?.transitLine?.name ?? "",
  ).trim();
  const headsign = String(td?.headsign ?? "").trim();
  const fromStop = String(td?.stopDetails?.departureStop?.name ?? "").trim();
  const toStop = String(td?.stopDetails?.arrivalStop?.name ?? "").trim();
  const departureIso = String(td?.stopDetails?.departureTime ?? "").trim();
  const departureTime =
    String(td?.localizedValues?.departureTime?.time?.text ?? "").trim() ||
    (departureIso ? formatHmJerusalem(departureIso) : "");
  const arrivalTime =
    String(td?.localizedValues?.arrivalTime?.time?.text ?? "").trim() ||
    (td?.stopDetails?.arrivalTime
      ? formatHmJerusalem(td.stopDetails.arrivalTime)
      : "");
  const durationSeconds = parseDurationSeconds(step.staticDuration);
  return {
    travelMode,
    instruction,
    line,
    headsign,
    fromStop,
    toStop,
    departureTime,
    departureIso,
    arrivalTime,
    durationText: formatDurationHe(durationSeconds),
    durationSeconds,
    headwaySeconds: parseDurationSeconds(td?.headway),
  };
}

function normLine(s: string): string {
  return s
    .replace(/^קו\s+/u, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function stepMatchesFilter(
  step: RouteStepFact,
  line: string,
  headsign: string,
): boolean {
  if (step.travelMode !== "TRANSIT") {
    return false;
  }
  if (line && normLine(step.line) !== normLine(line)) {
    return false;
  }
  if (headsign) {
    const needle = headsign.trim().toLowerCase();
    if (!step.headsign.toLowerCase().includes(needle)) {
      return false;
    }
  }
  return Boolean(line || headsign) ? true : step.travelMode === "TRANSIT";
}

/** Meaningful tokens from a place/stop string (Hebrew + Latin, length ≥ 2). */
export function placeTokens(raw: string): string[] {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[''`׳״"]/g, "")
    .split(/[\s,|/·\-–—]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .filter(
      (t) =>
        ![
          "תחנה",
          "תחנת",
          "רחוב",
          "שדרות",
          "דרך",
          "ב",
          "מ",
          "ל",
          "של",
          "בפתח",
          "פתח",
          "תקווה",
          "תקוה",
          "תל",
          "אביב",
          "ישראל",
          "stop",
          "station",
          "street",
          "st",
          "rd",
        ].includes(t),
    );
}

/**
 * Boarding stop must share at least one meaningful token with the asked origin
 * (e.g. שלום / דורני), so we never claim a line leaves from stop A when Google
 * boards at stop B after a walk.
 */
export function boardingStopMatchesOrigin(
  fromStop: string,
  origin: string,
): boolean {
  const stop = String(fromStop ?? "").trim();
  const originLabel = String(origin ?? "").trim();
  if (!stop || !originLabel) {
    return false;
  }
  const stopNorm = stop.toLowerCase().replace(/[''`׳״"]/g, "");
  const originNorm = originLabel.toLowerCase().replace(/[''`׳״"]/g, "");
  if (stopNorm.includes(originNorm) || originNorm.includes(stopNorm)) {
    return true;
  }
  const originToks = placeTokens(originLabel);
  if (originToks.length === 0) {
    return true;
  }
  return originToks.some((tok) => stopNorm.includes(tok));
}

function fareTextFromAdvisory(route: ApiRoute): string {
  const fare = route.travelAdvisory?.transitFare;
  if (!fare) {
    return "";
  }
  const units = String(fare.units ?? "").trim();
  const code = String(fare.currencyCode ?? "").trim();
  if (!units) {
    return "";
  }
  if (code === "ILS" || code === "NIS") {
    return `₪${units}`;
  }
  return code ? `${units} ${code}` : units;
}

function stepsFromApiRoute(route: ApiRoute): RouteStepFact[] {
  return (route.legs ?? [])
    .flatMap((leg) => (Array.isArray(leg.steps) ? leg.steps : []))
    .map(mapStep);
}

/** Map one Google route to user-facing itinerary fields (no invented data). */
function summarizeApiRoute(
  route: ApiRoute,
  opts: { arrivalRfc: string | null; departureRfc: string | null },
): RouteItineraryOption {
  const steps = stepsFromApiRoute(route);
  const durationSeconds = parseDurationSeconds(route.duration);
  const durationText =
    String(route.localizedValues?.duration?.text ?? "").trim() ||
    formatDurationHe(durationSeconds);
  const distanceMeters =
    typeof route.distanceMeters === "number" ? route.distanceMeters : null;
  const fareText = fareTextFromAdvisory(route);

  let leaveByText = "";
  let arriveByText = "";
  const firstTransit = steps.find(
    (s) => s.travelMode === "TRANSIT" && s.departureTime,
  );
  const lastArrival = [...steps].reverse().find((s) => s.arrivalTime);
  if (opts.arrivalRfc && durationSeconds != null) {
    const leaveMs =
      new Date(opts.arrivalRfc).getTime() - durationSeconds * 1000;
    leaveByText = formatHmJerusalem(new Date(leaveMs).toISOString());
  } else if (firstTransit?.departureTime) {
    leaveByText = firstTransit.departureTime;
  }
  if (lastArrival?.arrivalTime) {
    arriveByText = lastArrival.arrivalTime;
  } else if (opts.departureRfc && durationSeconds != null) {
    const arriveMs =
      new Date(opts.departureRfc).getTime() + durationSeconds * 1000;
    arriveByText = formatHmJerusalem(new Date(arriveMs).toISOString());
  }

  return {
    durationText,
    durationSeconds,
    distanceMeters,
    fareText,
    leaveByText,
    arriveByText,
    steps,
  };
}

function transitLinesLabel(steps: RouteStepFact[]): string {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const step of steps) {
    if (step.travelMode !== "TRANSIT" || !step.line) {
      continue;
    }
    const key = normLine(step.line);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    labels.push(`קו ${step.line}`);
  }
  return labels.join(" · ");
}

/**
 * Walk / transfer compare bits derived only from step fields Google returned.
 * Never invents wait times (Google rarely exposes them as a separate field).
 */
export function itineraryWalkTransferBits(steps: RouteStepFact[]): string[] {
  const bits: string[] = [];
  let walkSeconds = 0;
  let walkKnown = false;
  let walkPresent = false;
  let transitCount = 0;
  for (const step of steps) {
    const mode = String(step.travelMode ?? "").toUpperCase();
    if (mode === "WALK" || mode === "WALKING") {
      walkPresent = true;
      if (step.durationSeconds != null && step.durationSeconds > 0) {
        walkSeconds += step.durationSeconds;
        walkKnown = true;
      }
    } else if (mode === "TRANSIT") {
      transitCount += 1;
    }
  }
  if (walkKnown && walkSeconds > 0) {
    const walkText = formatDurationHe(walkSeconds);
    if (walkText) bits.push(`הליכה משוערת ${walkText}`);
  } else if (walkPresent) {
    bits.push("כולל הליכה");
  }
  if (transitCount >= 2) {
    bits.push(`${transitCount - 1} החלפות`);
  } else if (transitCount === 1) {
    bits.push("בלי החלפה");
  }
  return bits;
}

function walkSecondsFromSteps(steps: RouteStepFact[]): number | null {
  let total = 0;
  let known = false;
  for (const step of steps) {
    const mode = String(step.travelMode ?? "").toUpperCase();
    if (mode !== "WALK" && mode !== "WALKING") continue;
    if (step.durationSeconds != null && step.durationSeconds > 0) {
      total += step.durationSeconds;
      known = true;
    }
  }
  return known ? total : null;
}

/** Parse HH:mm display clock to minutes since midnight (null if absent). */
function parseHmToMinutes(raw: string): number | null {
  const m = String(raw ?? "")
    .trim()
    .match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (![h, min].every(Number.isFinite)) return null;
  return h * 60 + min;
}

/**
 * Rank Google trip alternatives by practical leave time, walk, arrive, duration.
 * Does not invent values — missing fields sort last within that key.
 */
export function rankTripItineraries(
  options: RouteItineraryOption[],
): RouteItineraryOption[] {
  const score = (opt: RouteItineraryOption): [number, number, number, number] => [
    parseHmToMinutes(opt.leaveByText) ?? Number.POSITIVE_INFINITY,
    walkSecondsFromSteps(opt.steps) ?? Number.POSITIVE_INFINITY,
    parseHmToMinutes(opt.arriveByText) ?? Number.POSITIVE_INFINITY,
    opt.durationSeconds ?? Number.POSITIVE_INFINITY,
  ];
  return [...options].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) {
      if (sa[i]! !== sb[i]!) return sa[i]! - sb[i]!;
    }
    return 0;
  });
}

function firstTransitBoard(
  steps: RouteStepFact[],
): RouteStepFact | undefined {
  return steps.find(
    (s) =>
      String(s.travelMode ?? "").toUpperCase() === "TRANSIT" &&
      Boolean(s.line?.trim()) &&
      Boolean(s.fromStop?.trim()),
  );
}

/**
 * Append official MOT scheduled (and optional SIRI live) departures for the
 * Google-verified boarding stop+line. Never invents a journey — Google already
 * confirmed the route reaches the destination. Labels schedule ≠ live ≠ Google.
 */
export async function formatOfficialBoardingDeparturesHe(
  facts: RoutesFacts,
  options?: { fetchImpl?: typeof fetch },
): Promise<string> {
  if (!isGtfsEnabled()) {
    return "";
  }
  const itineraries: RouteItineraryOption[] =
    facts.itineraries.length > 0
      ? facts.itineraries
      : [
          {
            durationText: facts.durationText,
            durationSeconds: facts.durationSeconds,
            distanceMeters: facts.distanceMeters,
            fareText: facts.fareText,
            leaveByText: facts.leaveByText,
            arriveByText: facts.arriveByText,
            steps: facts.steps,
          },
        ];

  const blocks: string[] = [];
  let triedSiri = false;
  for (let i = 0; i < itineraries.length; i++) {
    const board = firstTransitBoard(itineraries[i]!.steps);
    if (!board) continue;
    const line = board.line.replace(/^קו\s+/u, "").trim();
    const sched = await querySchedule(prisma, {
      stopCode: board.fromStop,
      line,
      agency: "",
      direction: "",
      headsign: board.headsign || "",
      limit: 2,
    });
    if (!sched.ok) {
      // Ambiguous / empty — keep Google journey; do not guess another stop.
      continue;
    }
    const optLabel =
      itineraries.length > 1 ? `אפשרות ${i + 1}` : "תחנת העלייה";
    const rows = sched.departures.slice(0, 2).map((d) => {
      const dir =
        d.headsign || d.directionLabel
          ? ` לכיוון ${d.headsign || d.directionLabel}`
          : "";
      return `• ${d.departureTime} קו ${d.line}${dir} [${d.stopCode}]`;
    });
    blocks.push(
      `${optLabel} «${sched.departures[0]?.stopName || board.fromStop}» קו ${line}:\n${rows.join("\n")}`,
    );

    if (!triedSiri && isSiriSmConfigured()) {
      triedSiri = true;
      const stopCode = sched.departures[0]?.stopCode ?? "";
      if (stopCode) {
        const siri = await fetchSiriStopArrivals({
          monitoringRef: stopCode,
          fetchImpl: options?.fetchImpl,
        });
        if (siri.ok) {
          const arrivals = filterSiriArrivals(siri.arrivals, {
            publishedLineName: line,
          })
            .filter((a) => !a.cancelled)
            .slice(0, 2);
          if (arrivals.length > 0) {
            const liveRows = arrivals.map((a) => {
              const hm =
                formatHmJerusalem(a.expectedArrivalIso) ||
                formatHmJerusalem(a.aimedArrivalIso) ||
                "";
              return `• ${hm} קו ${a.publishedLineName || line} [${a.stopCode}]`;
            });
            blocks.push(
              `תחזית חיה (SIRI) לקו ${line} בתחנה [${stopCode}] — לא לוח מתוזמן:\n${liveRows.join("\n")}`,
            );
          }
        }
      }
    }
  }

  if (blocks.length === 0) {
    return "";
  }
  return [
    "",
    "יציאות מתוזמנות רשמיות מתחנות העלייה במסלול (לא זמני Google):",
    ...blocks,
    GTFS_OFFICIAL_SOURCE_HE,
  ].join("\n");
}

type TransitStationLine = {
  vehicleType?: string;
  displayName?: { text?: string };
  shortDisplayName?: { text?: string };
};

type TransitStationAgency = {
  displayName?: { text?: string };
  lines?: TransitStationLine[];
};

type PlacesTransitStation = {
  displayName?: { text?: string };
  agencies?: TransitStationAgency[];
};

type PlacesStopBoardPlace = {
  displayName?: { text?: string };
  formattedAddress?: string;
  transitStation?: PlacesTransitStation;
};

type PlacesStopBoardResponse = {
  places?: PlacesStopBoardPlace[];
  error?: { code?: number; message?: string; status?: string };
};

function lineLabelFromStationLine(row: TransitStationLine): string {
  const short = String(row.shortDisplayName?.text ?? "").trim();
  const full = String(row.displayName?.text ?? "").trim();
  // Prefer short bus numbers (51 / 66); fall back to full name.
  const raw = short || full;
  return raw.replace(/^קו\s+/u, "").trim();
}

function collectStopLines(station: PlacesTransitStation | undefined): string[] {
  if (!station || !Array.isArray(station.agencies)) {
    return [];
  }
  const bus: string[] = [];
  const other: string[] = [];
  const seen = new Set<string>();
  for (const agency of station.agencies) {
    for (const line of agency.lines ?? []) {
      const label = lineLabelFromStationLine(line);
      if (!label) {
        continue;
      }
      const key = label.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const vehicle = String(line.vehicleType ?? "").toUpperCase();
      if (vehicle === "BUS" || vehicle === "" || vehicle === "VEHICLE_TYPE_UNSPECIFIED") {
        bus.push(label);
      } else {
        other.push(label);
      }
    }
  }
  // Prefer BUS first; keep other modes after.
  return [...bus, ...other];
}

/** Places Text Search → transitStation lines for a named stop (no destination). */
export async function fetchStopBoardFacts(input: {
  origin: string;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
}): Promise<Pick<RoutesFacts, "origin" | "stopDisplayName" | "stopLines" | "navigateAddress">> {
  const originRaw = String(input.origin ?? "").trim();
  const originLabel =
    originRaw.toLowerCase() === "speaker" ? "המיקום שלך" : originRaw;
  const empty = {
    origin: originLabel,
    stopDisplayName: "",
    stopLines: [] as string[],
    navigateAddress: originLabel,
  };
  if (!originRaw || originRaw.toLowerCase() === "speaker") {
    return empty;
  }

  const apiKey = resolveRoutesApiKey(input.apiKey);
  if (!apiKey) {
    throw new Error(ROUTES_API_KEY_MISSING);
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    textQuery: originRaw,
    languageCode: "he",
    regionCode: "IL",
    maxResultCount: 5,
    includedType: "transit_station",
  };
  const res = await fetchImpl(PLACES_SEARCH_TEXT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": STOP_BOARD_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  let json: PlacesStopBoardResponse = {};
  try {
    json = (await res.json()) as PlacesStopBoardResponse;
  } catch {
    json = {};
  }

  if (!res.ok) {
    if (isPermissionDenied(res.status, json as ComputeRoutesResponse)) {
      throw new Error(ROUTES_API_DENIED);
    }
    throw new Error(`stop board HTTP ${res.status}`);
  }
  if (json.error) {
    if (isPermissionDenied(0, json as ComputeRoutesResponse)) {
      throw new Error(ROUTES_API_DENIED);
    }
    throw new Error(
      `stop board ${json.error.status ?? "ERROR"}${
        json.error.message ? `: ${json.error.message}` : ""
      }`,
    );
  }

  const places = Array.isArray(json.places) ? json.places : [];
  // Prefer a hit that actually has transitStation.lines.
  let best: PlacesStopBoardPlace | undefined;
  for (const place of places) {
    const lines = collectStopLines(place.transitStation);
    if (lines.length > 0) {
      best = place;
      break;
    }
    if (!best) {
      best = place;
    }
  }
  if (!best) {
    return empty;
  }
  const stopDisplayName =
    String(best.transitStation?.displayName?.text ?? "").trim() ||
    String(best.displayName?.text ?? "").trim() ||
    originLabel;
  return {
    origin: originLabel,
    stopDisplayName,
    stopLines: collectStopLines(best.transitStation),
    navigateAddress: stopDisplayName,
  };
}

export async function fetchRoutesFacts(input: {
  origin: string;
  destination: string;
  departure?: string;
  arrival?: string;
  line?: string;
  headsign?: string;
  aspects?: RoutesAspect[] | unknown;
  /** transit (default) or drive (car). */
  mode?: RoutesTravelMode | string | null;
  originLat?: number | null;
  originLng?: number | null;
  destinationLat?: number | null;
  destinationLng?: number | null;
  /** Optional display labels after geocode (overrides raw origin/destination text). */
  originLabel?: string;
  destinationLabel?: string;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
  now?: Date;
}): Promise<RoutesFacts> {
  const originRaw = String(input.origin ?? "").trim();
  const destination = String(input.destination ?? "").trim();
  const departure = String(input.departure ?? "").trim();
  const arrival = String(input.arrival ?? "").trim();
  const travelMode: RoutesTravelMode =
    String(input.mode ?? "")
      .trim()
      .toLowerCase() === "drive"
      ? "drive"
      : "transit";
  const line =
    travelMode === "drive"
      ? ""
      : String(input.line ?? "")
          .replace(/^קו\s+/u, "")
          .trim();
  const headsign = travelMode === "drive" ? "" : String(input.headsign ?? "").trim();
  const aspects = parseRoutesAspects(input.aspects);
  const now = input.now ?? new Date();
  const originLabel =
    String(input.originLabel ?? "").trim() ||
    (originRaw.toLowerCase() === "speaker" ? "המיקום שלך" : originRaw);
  const destinationLabel =
    String(input.destinationLabel ?? "").trim() || destination;
  const filterSet = Boolean(line || headsign);
  const lineEtaAsk =
    travelMode === "transit" &&
    filterSet &&
    (aspects.includes("eta") || aspects.includes("frequency"));
  /** Ordinary A→B trip: ask Google for alternatives; line-ETA keeps its path. */
  const wantTripAlternatives = Boolean(destination) && !lineEtaAsk;
  const facts: RoutesFacts = {
    origin: originLabel,
    destination: destinationLabel,
    departure,
    arrival,
    line,
    headsign,
    mode: travelMode,
    aspects,
    durationText: "",
    durationSeconds: null,
    distanceMeters: null,
    leaveByText: "",
    arriveByText: "",
    fareText: "",
    etaMinutes: null,
    headwaySeconds: null,
    steps: [],
    itineraries: [],
    navigateAddress: destinationLabel,
    lineMatchFailed: false,
    matchedFromStop: "",
    matchedLine: "",
    stopLines: [],
    stopDisplayName: "",
  };

  if (aspects.includes("lines") && !destination) {
    const board = await fetchStopBoardFacts({
      origin: originRaw,
      fetchImpl: input.fetchImpl,
      apiKey: input.apiKey,
    });
    facts.stopLines = board.stopLines;
    facts.stopDisplayName = board.stopDisplayName;
    facts.navigateAddress = board.navigateAddress;
    return facts;
  }

  const hasOriginCoords =
    input.originLat != null &&
    input.originLng != null &&
    Number.isFinite(input.originLat) &&
    Number.isFinite(input.originLng);
  const hasSpeakerPin =
    originRaw.toLowerCase() === "speaker" && hasOriginCoords;
  const hasDestCoords =
    input.destinationLat != null &&
    input.destinationLng != null &&
    Number.isFinite(input.destinationLat) &&
    Number.isFinite(input.destinationLng);
  if (!destination || (!originRaw && !hasSpeakerPin && !hasOriginCoords)) {
    return facts;
  }

  const apiKey = resolveRoutesApiKey(input.apiKey);
  if (!apiKey) {
    throw new Error(ROUTES_API_KEY_MISSING);
  }

  const originWaypoint = hasOriginCoords
    ? {
        location: {
          latLng: {
            latitude: input.originLat,
            longitude: input.originLng,
          },
        },
      }
    : { address: originRaw };

  const destinationWaypoint = hasDestCoords
    ? {
        location: {
          latLng: {
            latitude: input.destinationLat,
            longitude: input.destinationLng,
          },
        },
      }
    : { address: destination };

  const body: Record<string, unknown> = {
    origin: originWaypoint,
    destination: destinationWaypoint,
    travelMode: travelMode === "drive" ? "DRIVE" : "TRANSIT",
    languageCode: "he-IL",
    regionCode: "IL",
    units: "METRIC",
    computeAlternativeRoutes: lineEtaAsk || wantTripAlternatives,
  };
  if (travelMode === "drive") {
    body.routingPreference = "TRAFFIC_AWARE";
  }
  if (lineEtaAsk) {
    body.transitPreferences = { allowedTravelModes: ["BUS"] };
  }

  const departureRfc = toRoutesRfc3339(departure);
  const arrivalRfc = toRoutesRfc3339(arrival);
  if (arrivalRfc && !departureRfc) {
    body.arrivalTime = arrivalRfc;
  } else if (departureRfc) {
    body.departureTime = departureRfc;
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const res = await fetchImpl(COMPUTE_ROUTES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  let json: ComputeRoutesResponse = {};
  try {
    json = (await res.json()) as ComputeRoutesResponse;
  } catch {
    json = {};
  }

  if (!res.ok) {
    if (isPermissionDenied(res.status, json)) {
      throw new Error(ROUTES_API_DENIED);
    }
    const status = String(json.error?.status ?? "").toUpperCase();
    if (
      status === "NOT_FOUND" ||
      status === "ZERO_RESULTS" ||
      res.status === 404
    ) {
      throw new Error(ROUTES_ZERO_RESULTS);
    }
    throw new Error(`routes HTTP ${res.status}`);
  }

  if (json.error) {
    if (isPermissionDenied(res.status, json)) {
      throw new Error(ROUTES_API_DENIED);
    }
    throw new Error(
      `routes ${json.error.status ?? "ERROR"}${
        json.error.message ? `: ${json.error.message}` : ""
      }`,
    );
  }

  const routes = Array.isArray(json.routes) ? json.routes : [];
  if (routes.length === 0) {
    throw new Error(ROUTES_ZERO_RESULTS);
  }

  const route = routes[0]!;
  const primary = summarizeApiRoute(route, {
    arrivalRfc: arrivalRfc,
    departureRfc: departureRfc,
  });
  facts.durationSeconds = primary.durationSeconds;
  facts.durationText = primary.durationText;
  facts.distanceMeters = primary.distanceMeters;
  facts.fareText = primary.fareText;
  facts.steps = primary.steps;
  if (wantTripAlternatives) {
    facts.itineraries = rankTripItineraries(
      routes.slice(0, ROUTES_ITINERARY_DISPLAY_CAP).map((r) =>
        summarizeApiRoute(r, {
          arrivalRfc: arrivalRfc,
          departureRfc: departureRfc,
        }),
      ),
    );
    // Keep primary summary fields aligned with the best ranked option.
    const best = facts.itineraries[0];
    if (best) {
      facts.durationSeconds = best.durationSeconds;
      facts.durationText = best.durationText;
      facts.distanceMeters = best.distanceMeters;
      facts.fareText = best.fareText;
      facts.steps = best.steps;
      facts.leaveByText = best.leaveByText;
      facts.arriveByText = best.arriveByText;
    }
  }

  const allSteps = lineEtaAsk
    ? routes.flatMap((r) => stepsFromApiRoute(r))
    : facts.steps;

  const lineMatching = filterSet
    ? allSteps.filter((s) => stepMatchesFilter(s, line, headsign))
    : [];
  // Pin-based origin has no stop name to fuzzy-match; only named origins
  // must share a token with Google's departureStop.
  const requireStopMatch = originLabel !== "המיקום שלך";
  const stopMatched = requireStopMatch
    ? lineMatching.filter((s) =>
        boardingStopMatchesOrigin(s.fromStop, originLabel),
      )
    : lineMatching;

  let focus: RouteStepFact | undefined;
  if (filterSet) {
    if (stopMatched.length === 0) {
      // Fail closed: never borrow another line's clock (or a walk-away stop).
      facts.lineMatchFailed = true;
      facts.etaMinutes = null;
      facts.headwaySeconds = null;
      // Keep duration/steps from primary route for summary asks, but do not
      // set leaveBy from a non-matching transit when this was a line ETA.
      if (lineEtaAsk) {
        facts.leaveByText = "";
        return facts;
      }
    } else {
      focus = stopMatched[0];
    }
  } else {
    focus =
      allSteps.find((s) => s.travelMode === "TRANSIT") ??
      facts.steps.find((s) => s.travelMode === "TRANSIT");
  }

  if (focus) {
    facts.matchedFromStop = focus.fromStop;
    facts.matchedLine = focus.line || line;
    if (focus.departureIso) {
      const ms = new Date(focus.departureIso).getTime() - now.getTime();
      if (Number.isFinite(ms)) {
        facts.etaMinutes = Math.max(0, Math.round(ms / 60_000));
      }
    }
    facts.headwaySeconds = focus.headwaySeconds;
    if (!facts.headwaySeconds) {
      const withHeadway = (filterSet ? stopMatched : allSteps).find(
        (s) => s.headwaySeconds != null,
      );
      facts.headwaySeconds = withHeadway?.headwaySeconds ?? null;
    }
  }

  // Leave/arrive: never borrow another line's clock when a filter failed.
  // Ranked trip alternatives already synced leave/arrive from the best option.
  if (arrivalRfc && facts.durationSeconds != null) {
    const leaveMs =
      new Date(arrivalRfc).getTime() - facts.durationSeconds * 1000;
    facts.leaveByText = formatHmJerusalem(new Date(leaveMs).toISOString());
    facts.arriveByText =
      facts.itineraries[0]?.arriveByText || primary.arriveByText;
  } else if (filterSet) {
    if (focus?.departureTime) {
      facts.leaveByText = focus.departureTime;
    }
    facts.arriveByText = primary.arriveByText;
  } else if (wantTripAlternatives && facts.itineraries.length > 0) {
    // leaveByText / arriveByText already copied from ranked best above.
  } else {
    facts.leaveByText = primary.leaveByText;
    facts.arriveByText = primary.arriveByText;
  }

  return facts;
}

function formatStepLine(step: RouteStepFact, index: number): string {
  const n = index + 1;
  if (step.travelMode === "WALK" || step.travelMode === "WALKING") {
    const tip =
      step.instruction ||
      (step.toStop ? `הליכה עד ${step.toStop}` : "הליכה");
    const dur = step.durationText ? ` (${step.durationText})` : "";
    return `${n}. הליכה — ${tip}${dur}`;
  }
  if (step.travelMode === "TRANSIT") {
    const lineBit = step.line ? `קו ${step.line}` : "תחבורה ציבורית";
    const head = step.headsign ? ` לכיוון ${step.headsign}` : "";
    const fromTo =
      step.fromStop && step.toStop
        ? ` מ${step.fromStop} ל${step.toStop}`
        : step.fromStop
          ? ` מ${step.fromStop}`
          : "";
    const times =
      step.departureTime && step.arrivalTime
        ? ` (${step.departureTime}→${step.arrivalTime})`
        : step.departureTime
          ? ` (יציאה ${step.departureTime})`
          : "";
    return `${n}. ${lineBit}${head}${fromTo}${times}`;
  }
  return `${n}. ${step.instruction || step.travelMode}`;
}

function formatMultiItinerariesHebrew(facts: RoutesFacts): string {
  const lines: string[] = [];
  const arriveAsk = Boolean(facts.arrival.trim());
  const n = facts.itineraries.length;
  const drive = facts.mode === "drive";
  lines.push(
    drive
      ? `מצאתי ${n} אפשרויות ברכב מ«${facts.origin}» ל«${facts.destination}» ${ROUTES_DRIVE_ESTIMATE_DISCLAIMER_HE}`
      : `מצאתי ${n} אפשרויות בתחבורה ציבורית מ«${facts.origin}» ל«${facts.destination}» ${ROUTES_MULTI_ESTIMATE_DISCLAIMER_HE}`,
  );
  if (arriveAsk) {
    const arriveLabel = displayClockLabel(facts.arrival);
    lines.push(`יעד הגעה: עד ${arriveLabel}.`);
  }

  const showSteps =
    wants(facts.aspects, "steps") || facts.aspects.includes("summary");
  const maxSteps = facts.aspects.includes("steps")
    ? ROUTES_STEPS_DETAIL_DISPLAY_CAP
    : ROUTES_STEPS_SUMMARY_DISPLAY_CAP;

  facts.itineraries.forEach((opt, i) => {
    lines.push("");
    const headBits: string[] = [];
    if (opt.durationText) {
      headBits.push(`משך משוער *${opt.durationText}*`);
    }
    if (arriveAsk && opt.leaveByText) {
      headBits.push(`צא בסביבות *${opt.leaveByText}*`);
    } else if (opt.leaveByText) {
      headBits.push(`יציאה משוערת ${opt.leaveByText}`);
    }
    if (opt.arriveByText && !arriveAsk) {
      headBits.push(`הגעה משוערת ${opt.arriveByText}`);
    }
    if (wants(facts.aspects, "fare") && opt.fareText) {
      headBits.push(`מחיר משוער ${opt.fareText}`);
    }
    const lineLabel = transitLinesLabel(opt.steps);
    if (lineLabel) {
      headBits.push(lineLabel);
    }
    for (const bit of itineraryWalkTransferBits(opt.steps)) {
      headBits.push(bit);
    }
    lines.push(
      `*אפשרות ${i + 1}* — ${headBits.length > 0 ? headBits.join(" · ") : "מסלול"}`,
    );
    if (showSteps && opt.steps.length > 0) {
      opt.steps.slice(0, maxSteps).forEach((step, si) => {
        lines.push(formatStepLine(step, si));
      });
      if (opt.steps.length > maxSteps) {
        lines.push(ROUTES_STEPS_LOCAL_TRUNCATION_HE);
      }
    }
  });

  return lines.join("\n").trim();
}

/** Opaque itinerary ids for Stage B (stable within this turn's board). */
export function routesItinerariesToLiveRetrievalRecords(
  facts: RoutesFacts,
): LiveRetrievalRecord[] {
  const options =
    facts.itineraries.length > 0
      ? facts.itineraries
      : facts.steps.length > 0
        ? [
            {
              durationText: facts.durationText,
              durationSeconds: facts.durationSeconds,
              distanceMeters: facts.distanceMeters,
              fareText: facts.fareText,
              leaveByText: facts.leaveByText,
              arriveByText: facts.arriveByText,
              steps: facts.steps,
            },
          ]
        : [];
  return options.map((opt, i) => {
    const lines = transitLinesLabel(opt.steps);
    const transfers = itineraryWalkTransferBits(opt.steps);
    return {
      id: `itin:${i}`,
      label:
        lines ||
        opt.durationText ||
        `אפשרות ${i + 1}`,
      fields: {
        index: i + 1,
        duration_text: opt.durationText || null,
        duration_seconds: opt.durationSeconds,
        leave_by: opt.leaveByText || null,
        arrive_by: opt.arriveByText || null,
        fare: opt.fareText || null,
        lines: lines || null,
        walk_transfer: transfers,
        steps: opt.steps.map((s) => ({
          mode: s.travelMode,
          line: s.line || null,
          headsign: s.headsign || null,
          from: s.fromStop || null,
          to: s.toStop || null,
          departure: s.departureTime || null,
          arrival: s.arrivalTime || null,
        })),
      },
    };
  });
}

/** Stop-board line short names as Stage B records. */
export function routesStopLinesToLiveRetrievalRecords(
  facts: RoutesFacts,
): LiveRetrievalRecord[] {
  return facts.stopLines.map((line, i) => ({
    id: `line:${i}:${line}`,
    label: /^\d/.test(line) ? `קו ${line}` : line,
    fields: { line, index: i + 1 },
  }));
}

export function filterRoutesFactsByItineraryIds(
  facts: RoutesFacts,
  ids: string[],
): RoutesFacts {
  const want = new Set(ids);
  const source =
    facts.itineraries.length > 0
      ? facts.itineraries
      : facts.steps.length > 0
        ? [
            {
              durationText: facts.durationText,
              durationSeconds: facts.durationSeconds,
              distanceMeters: facts.distanceMeters,
              fareText: facts.fareText,
              leaveByText: facts.leaveByText,
              arriveByText: facts.arriveByText,
              steps: facts.steps,
            },
          ]
        : [];
  const kept = source.filter((_, i) => want.has(`itin:${i}`));
  if (kept.length === 0) {
    return { ...facts, itineraries: [], steps: [], durationText: "", leaveByText: "", arriveByText: "" };
  }
  const best = kept[0]!;
  return {
    ...facts,
    itineraries: kept,
    steps: best.steps,
    durationText: best.durationText,
    durationSeconds: best.durationSeconds,
    distanceMeters: best.distanceMeters,
    fareText: best.fareText,
    leaveByText: best.leaveByText,
    arriveByText: best.arriveByText,
  };
}

export function filterRoutesFactsByLineIds(
  facts: RoutesFacts,
  ids: string[],
): RoutesFacts {
  const want = new Set(ids);
  const stopLines = facts.stopLines.filter((line, i) =>
    want.has(`line:${i}:${line}`),
  );
  return { ...facts, stopLines };
}

/** Apply Stage B outcome onto Routes facts and format Hebrew. */
export function formatRoutesAfterLiveSelect(
  facts: RoutesFacts,
  outcome: LiveSelectApplyResult,
  board: "itineraries" | "lines",
): string {
  if (outcome.kind === "failure") {
    const raw = formatRoutesHebrew(facts);
    return formatLiveSelectFailureReply(raw, {
      includeUnfiltered: outcome.mayShowUnfilteredLabeled,
    });
  }
  if (outcome.kind === "no_match") {
    return outcome.messageHe?.trim() || LIVE_SELECT_NO_MATCH_HE;
  }
  if (outcome.kind === "subset") {
    const filtered =
      board === "lines"
        ? filterRoutesFactsByLineIds(facts, outcome.keptIds)
        : filterRoutesFactsByItineraryIds(facts, outcome.keptIds);
    return formatRoutesHebrew(filtered);
  }
  return formatRoutesHebrew(facts);
}

export function formatRoutesHebrew(facts: RoutesFacts): string {
  const linesBoard =
    facts.aspects.includes("lines") && !facts.destination.trim();
  if (linesBoard) {
    const stopLabel = facts.stopDisplayName || facts.origin;
    if (facts.stopLines.length === 0) {
      return `לא מצאתי רשימת קווים לתחנת «${facts.origin}». אפשר לנסות שם מדויק יותר, או לתת יעד ואגיד איך מגיעים.`;
    }
    const listed = facts.stopLines
      .slice(0, 24)
      .map((n) => (/^\d/.test(n) ? `קו ${n}` : n))
      .join(", ");
    const more =
      facts.stopLines.length > 24
        ? ` (ועוד ${facts.stopLines.length - 24})`
        : "";
    return `בתחנת «${stopLabel}» עוברים בין השאר: ${listed}${more}.`;
  }

  if (!facts.destination.trim() || !facts.origin.trim()) {
    return "מאיפה ולאן? (למשל מרחוב ז׳בוטינסקי בפתח תקווה לדיזנגוף סנטר)";
  }
  const driveTrip = facts.mode === "drive";
  if (facts.steps.length === 0 && !facts.durationText && !facts.lineMatchFailed) {
    return driveTrip
      ? `לא מצאתי מסלול ברכב מ«${facts.origin}» ל«${facts.destination}».`
      : `לא מצאתי מסלול בתחבורה ציבורית מ«${facts.origin}» ל«${facts.destination}».`;
  }

  const etaOnly =
    facts.aspects.includes("eta") && !facts.aspects.includes("summary");
  const freqOnly =
    facts.aspects.includes("frequency") && !facts.aspects.includes("summary");
  const lineBit = facts.matchedLine
    ? `קו ${facts.matchedLine}`
    : facts.line
      ? `קו ${facts.line}`
      : "הקו";
  const lineRefuse = (): string =>
    `לא מצאתי ${facts.line ? `קו ${facts.line}` : "קו"} שיוצא מ«${facts.origin}» לכיוון «${facts.destination}».`;

  if (etaOnly || (facts.aspects.includes("eta") && facts.line)) {
    if (facts.lineMatchFailed || facts.etaMinutes == null) {
      return lineRefuse();
    }
    const when =
      facts.etaMinutes <= 0
        ? "עכשיו / בקרוב מאוד"
        : `בעוד כ־${facts.etaMinutes} דקות`;
    const head = facts.headsign ? ` לכיוון ${facts.headsign}` : "";
    const fromLabel = facts.matchedFromStop || facts.origin;
    return `${lineBit}${head} מ«${fromLabel}» יוצא ${when}${facts.leaveByText ? ` (ב־${facts.leaveByText})` : ""}.`;
  }

  if (freqOnly || facts.aspects.includes("frequency")) {
    if (facts.lineMatchFailed) {
      return lineRefuse();
    }
    if (facts.headwaySeconds == null || facts.headwaySeconds <= 0) {
      return `אין לי תדירות מדויקת ל${lineBit} עכשיו. אפשר לשאול על היציאה הבאה ליעד.`;
    }
    const mins = Math.max(1, Math.round(facts.headwaySeconds / 60));
    const fromLabel = facts.matchedFromStop || facts.origin;
    return `תדירות משוערת ל${lineBit} מ«${fromLabel}» לכיוון «${facts.destination}»: כל כ־${mins} דקות.`;
  }

  if (facts.lineMatchFailed && facts.line && facts.aspects.includes("eta")) {
    return lineRefuse();
  }

  // Multi-option only when Google returned >1 alternatives for a trip summary.
  if (facts.itineraries.length > 1) {
    return formatMultiItinerariesHebrew(facts);
  }

  const lines: string[] = [];
  const arriveAsk = Boolean(facts.arrival.trim());
  if (arriveAsk && facts.leaveByText) {
    const arriveLabel = displayClockLabel(facts.arrival);
    lines.push(
      `כדי להגיע ל«${facts.destination}» עד ${arriveLabel}, צא בסביבות *${facts.leaveByText}* מ«${facts.origin}».`,
    );
  } else {
    lines.push(
      driveTrip
        ? `מסלול ברכב מ«${facts.origin}» ל«${facts.destination}» ${ROUTES_DRIVE_ESTIMATE_DISCLAIMER_HE}:`
        : `מסלול בתחבורה ציבורית מ«${facts.origin}» ל«${facts.destination}»:`,
    );
  }

  if (wants(facts.aspects, "duration") && facts.durationText) {
    lines.push(`משך נסיעה משוער: *${facts.durationText}*`);
  }
  if (facts.arriveByText && !arriveAsk) {
    lines.push(`הגעה משוערת: ${facts.arriveByText}`);
  }
  if (wants(facts.aspects, "fare") && facts.fareText) {
    lines.push(`מחיר משוער: ${facts.fareText}`);
  }
  if (facts.aspects.includes("eta") && facts.etaMinutes != null && facts.line) {
    lines.push(
      `יציאת קו ${facts.line}: בעוד כ־${facts.etaMinutes} דקות` +
        (facts.leaveByText ? ` (${facts.leaveByText})` : ""),
    );
  }
  if (
    facts.aspects.includes("frequency") &&
    facts.headwaySeconds != null &&
    facts.headwaySeconds > 0
  ) {
    lines.push(
      `תדירות משוערת: כל כ־${Math.max(1, Math.round(facts.headwaySeconds / 60))} דקות`,
    );
  }

  const showSteps =
    wants(facts.aspects, "steps") || facts.aspects.includes("summary");
  if (showSteps && facts.steps.length > 0) {
    lines.push("");
    const max = facts.aspects.includes("steps")
      ? ROUTES_STEPS_DETAIL_DISPLAY_CAP
      : ROUTES_STEPS_SUMMARY_DISPLAY_CAP;
    facts.steps.slice(0, max).forEach((step, i) => {
      lines.push(formatStepLine(step, i));
    });
    // Confirmed local display truncation only — one Google trip is intentional.
    if (facts.steps.length > max) {
      lines.push(ROUTES_STEPS_LOCAL_TRUNCATION_HE);
    }
  }

  return lines.join("\n").trim();
}

/** Next departure minutes + fingerprint for bus_eta watches. */
export async function fetchBusEtaWatch(input: {
  origin: string;
  destination: string;
  line: string;
  headsign?: string;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
  now?: Date;
}): Promise<{ minutes: number | null; fingerprint: string; leaveByText: string }> {
  try {
    const facts = await fetchRoutesFacts({
      origin: input.origin,
      destination: input.destination,
      line: input.line,
      headsign: input.headsign ?? "",
      aspects: ["eta"],
      fetchImpl: input.fetchImpl,
      apiKey: input.apiKey,
      now: input.now,
    });
    const fp = [
      input.line,
      facts.leaveByText || "",
      facts.etaMinutes ?? "",
      facts.steps.find((s) => s.departureIso)?.departureIso ?? "",
    ].join("|");
    return {
      minutes: facts.etaMinutes,
      fingerprint: fp,
      leaveByText: facts.leaveByText,
    };
  } catch {
    return { minutes: null, fingerprint: "", leaveByText: "" };
  }
}

function parseHmToSeconds(raw: string): number | null {
  const s = String(raw ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3] ?? "0");
  if (![h, min, sec].every(Number.isFinite)) return null;
  return h * 3600 + min * 60 + sec;
}

function serviceDateFromLocal(raw: string): string {
  const s = String(raw ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return "";
}

async function resolveGtfsRoutesReply(input: {
  origin: string;
  destination: string;
  departure?: string;
  line?: string;
  headsign?: string;
  stopCode?: string;
  agency?: string;
  serviceDate?: string;
  windowEnd?: string;
  aspects: RoutesAspect[];
  originLat?: number | null;
  originLng?: number | null;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
}): Promise<{ text: string; navigateAddress: string }> {
  const line = String(input.line ?? "").trim();
  const stopCode = String(input.stopCode ?? "").trim();
  const agency = String(input.agency ?? "").trim();
  const headsign = String(input.headsign ?? "").trim();
  const serviceDate =
    String(input.serviceDate ?? "").trim() ||
    serviceDateFromLocal(input.departure ?? "") ||
    "";

  if (input.aspects.includes("schedule")) {
    const code = stopCode || String(input.origin ?? "").trim();
    if (!code || !line) {
      return {
        text: "ללוח הרשמי צריך מספר קו וקוד תחנה או שם תחנה.",
        navigateAddress: "",
      };
    }
    const dep = String(input.departure ?? "").trim();
    const windowStartSeconds = parseHmToSeconds(
      dep.includes("T") ? dep.split("T")[1] ?? "" : dep,
    );
    const windowEndSeconds = parseHmToSeconds(
      String(input.windowEnd ?? "").trim(),
    );
    // Short numeric headsign is treated as RouteNetworks DirectionRef, not trip_headsign.
    const tripHeadsign = /^\d{1,2}$/.test(headsign) ? "" : headsign;
    const result = await querySchedule(prisma, {
      stopCode: code,
      line,
      agency,
      direction: headsign,
      headsign: tripHeadsign,
      serviceDate: serviceDate || undefined,
      windowStartSeconds: windowStartSeconds ?? undefined,
      windowEndSeconds: windowEndSeconds ?? undefined,
    });
    if (!result.ok) {
      if (result.kind === "ambiguous") {
        return {
          text: formatAmbiguityHebrew(result.ambiguity),
          navigateAddress: "",
        };
      }
      return { text: result.messageHe, navigateAddress: "" };
    }
    return {
      text: formatScheduleHebrew(result),
      navigateAddress: "",
    };
  }

  if (input.aspects.includes("nearest_stop")) {
    if (!line) {
      return {
        text: "לאיזה קו לחפש תחנה קרובה?",
        navigateAddress: "",
      };
    }
    const originRaw = String(input.origin ?? "").trim();
    const speakerOrigin = originRaw.toLowerCase() === "speaker";
    let lat = input.originLat;
    let lng = input.originLng;
    let placeLabel = "";

    if (
      (lat == null ||
        lng == null ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng)) &&
      !speakerOrigin &&
      originRaw
    ) {
      const geo = await geocodeNamedPlaceForNearestStop({
        query: originRaw,
        fetchImpl: input.fetchImpl,
        apiKey: input.apiKey,
      });
      if (!geo.ok) {
        if (geo.kind === "ambiguous" && geo.options?.length) {
          return {
            text: `${geo.messageHe}\n${geo.options.map((o) => `• ${o}`).join("\n")}`,
            navigateAddress: "",
          };
        }
        return { text: geo.messageHe, navigateAddress: "" };
      }
      lat = geo.lat;
      lng = geo.lng;
      placeLabel = geo.label;
    }

    if (
      lat == null ||
      lng == null ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {
      return {
        text: speakerOrigin || !originRaw
          ? "שלח מיקום בוואטסאפ (סיכת מיקום) ואז אמצא תחנה קרובה לקו."
          : `לא הצלחתי לזהות את המיקום «${originRaw}». שלח סיכת מיקום או כתובת מדויקת יותר.`,
        navigateAddress: "",
      };
    }
    const result = await queryNearestStop(prisma, {
      lat,
      lng,
      line,
      agency,
      direction: headsign,
      serviceDate: serviceDate || jerusalemYmd(),
    });
    if (!result.ok) {
      if (result.kind === "ambiguous") {
        return {
          text: formatAmbiguityHebrew(result.ambiguity),
          navigateAddress: "",
        };
      }
      return { text: result.messageHe, navigateAddress: "" };
    }
    const body = formatNearestStopHebrew(result);
    const preface = placeLabel
      ? `חיפוש ליד «${placeLabel}»:\n`
      : "";
    const nearestName = result.stops[0]?.stopName?.trim() || "";
    return {
      text: `${preface}${body}`,
      navigateAddress: nearestName,
    };
  }

  if (input.aspects.includes("live_arrivals")) {
    return resolveLiveArrivalsReply({
      stopCode,
      origin: input.origin,
      line,
      agency,
      headsign,
      serviceDate,
      departure: input.departure,
      windowEnd: input.windowEnd,
      fetchImpl: input.fetchImpl,
    });
  }

  return {
    text: "בקשת לוח רשמי לא מזוהה.",
    navigateAddress: "",
  };
}

/**
 * Official SIRI live board with truthful GTFS schedule fallback.
 * Never labels schedule/Google as SIRI live. Does not touch bus_eta watches.
 */
async function resolveLiveArrivalsReply(input: {
  stopCode: string;
  origin: string;
  line: string;
  agency: string;
  headsign: string;
  serviceDate: string;
  departure?: string;
  windowEnd?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ text: string; navigateAddress: string }> {
  const rawRef = input.stopCode || String(input.origin ?? "").trim();
  if (!rawRef) {
    return {
      text: "לאיזו תחנה? צריך קוד תחנה או שם תחנה לתחזית זמן אמת.",
      navigateAddress: "",
    };
  }

  // Prefer MOT stop_code. Spoken stop names resolve via GTFS (same as schedule)
  // before calling SIRI — never send a Hebrew name as MonitoringRef.
  let code = rawRef;
  if (isGtfsEnabled()) {
    const generationId = await getActiveGenerationId(prisma);
    if (generationId) {
      const resolved = await resolveScheduleStopRef(prisma, generationId, rawRef, {
        line: input.line || undefined,
      });
      if (!resolved.ok) {
        if (resolved.kind === "ambiguous") {
          return {
            text: formatAmbiguityHebrew(resolved.ambiguity),
            navigateAddress: "",
          };
        }
        // Numeric-looking refs may still be valid SIRI MonitoringRefs without GTFS hit.
        if (!/^\d{3,}$/.test(rawRef)) {
          return { text: resolved.messageHe, navigateAddress: "" };
        }
      } else {
        code = resolved.match.stopCode;
      }
    } else if (!/^\d{3,}$/.test(rawRef)) {
      return {
        text: "לתחזית חיה צריך קוד תחנה רשמי (או לוח GTFS פעיל לזיהוי שם תחנה).",
        navigateAddress: "",
      };
    }
  } else if (!/^\d{3,}$/.test(rawRef)) {
    return {
      text: "לתחזית חיה צריך קוד תחנה רשמי (מספר).",
      navigateAddress: "",
    };
  }

  // Ambiguity for line+agency is resolved via GTFS when a line filter is set
  // and schedule data is available — same ask behavior as schedule.
  // Direction codes (1/2/…) are for RouteNetworks, not trip_headsign ILIKE.
  const direction = input.headsign;
  if (input.line) {
    const probe = await querySchedule(prisma, {
      stopCode: code,
      line: input.line,
      agency: input.agency,
      direction,
      headsign: "",
      serviceDate: input.serviceDate || undefined,
      windowStartSeconds: 0,
      windowEndSeconds: 48 * 3600,
      limit: 1,
    });
    if (!probe.ok && probe.kind === "ambiguous") {
      return {
        text: formatAmbiguityHebrew(probe.ambiguity),
        navigateAddress: "",
      };
    }
  }

  // Resolve Hebrew/name agency hint → GTFS agency_id before filtering SIRI OperatorRef.
  // Never present unfiltered live arrivals as matching a requested agency.
  let operatorAgencyId: string | undefined;
  let agencyUnresolvedNote = "";
  if (input.agency.trim()) {
    const resolved = await resolveGtfsAgencyHint(prisma, input.agency, {
      line: input.line || undefined,
    });
    if (!resolved.ok) {
      if (resolved.kind === "ambiguous") {
        return {
          text: formatAmbiguityHebrew({
            kind: "agency",
            messageHe: resolved.messageHe,
            options: resolved.options,
          }),
          navigateAddress: "",
        };
      }
      if (resolved.kind === "unknown") {
        return { text: resolved.messageHe, navigateAddress: "" };
      }
      // no_feed / GTFS off: Hebrew cannot be mapped — skip SIRI live (would
      // misrepresent multi-operator boards). Schedule fallback only if labeled.
      agencyUnresolvedNote = resolved.messageHe;
    } else if (resolved.matches.length === 1) {
      operatorAgencyId = resolved.matches[0]!.agencyId;
    }
  }

  if (!agencyUnresolvedNote) {
    const siri: SiriFetchResult = await fetchSiriStopArrivals({
      monitoringRef: code,
      // LineRef is MOT route_id — we do not invent it from short name here.
      // Client-side filter uses publishedLineName + resolved agency_id.
      fetchImpl: input.fetchImpl,
    });

    if (siri.ok) {
      let arrivals = siri.arrivals;
      if (input.line || operatorAgencyId) {
        arrivals = filterSiriArrivals(arrivals, {
          publishedLineName: input.line || undefined,
          operatorRef: operatorAgencyId,
        });
      }
      if (arrivals.length > 0) {
        return {
          text: formatSiriArrivalsHebrew({ ...siri, arrivals }),
          navigateAddress: "",
        };
      }
      // Filtered empty — fall through to schedule with explanation.
    }

    const siriNote = !siri.ok
      ? siri.messageHe
      : "אין תחזית חיה לקו המבוקש בתחנה הזו.";

    // Schedule fallback — always labeled as scheduled, never as live.
    if (input.line) {
      const dep = String(input.departure ?? "").trim();
      const windowStartSeconds = parseHmToSeconds(
        dep.includes("T") ? dep.split("T")[1] ?? "" : dep,
      );
      const windowEndSeconds = parseHmToSeconds(
        String(input.windowEnd ?? "").trim(),
      );
      const sched = await querySchedule(prisma, {
        stopCode: code,
        line: input.line,
        agency: input.agency,
        direction,
        headsign: "",
        serviceDate: input.serviceDate || undefined,
        windowStartSeconds: windowStartSeconds ?? undefined,
        windowEndSeconds: windowEndSeconds ?? undefined,
      });
      if (sched.ok) {
        return {
          text: [
            siriNote,
            "מציגה במקום לוח זמנים מתוזמן (לא תחזית חיה):",
            formatScheduleHebrew(sched),
          ].join("\n"),
          navigateAddress: "",
        };
      }
      if (sched.kind === "ambiguous") {
        return {
          text: formatAmbiguityHebrew(sched.ambiguity),
          navigateAddress: "",
        };
      }
      return {
        text: `${siriNote}\n${sched.messageHe}`,
        navigateAddress: "",
      };
    }

    return {
      text: `${siriNote}\nללוח מתוזמן צייני גם מספר קו.`,
      navigateAddress: "",
    };
  }

  // Agency requested but unresolved — never call SIRI without OperatorRef filter.
  if (input.line) {
    const dep = String(input.departure ?? "").trim();
    const windowStartSeconds = parseHmToSeconds(
      dep.includes("T") ? dep.split("T")[1] ?? "" : dep,
    );
    const windowEndSeconds = parseHmToSeconds(
      String(input.windowEnd ?? "").trim(),
    );
    const sched = await querySchedule(prisma, {
      stopCode: code,
      line: input.line,
      agency: input.agency,
      direction,
      headsign: "",
      serviceDate: input.serviceDate || undefined,
      windowStartSeconds: windowStartSeconds ?? undefined,
      windowEndSeconds: windowEndSeconds ?? undefined,
    });
    if (sched.ok) {
      return {
        text: [
          agencyUnresolvedNote,
          "מציגה במקום לוח זמנים מתוזמן (לא תחזית חיה):",
          formatScheduleHebrew(sched),
        ].join("\n"),
        navigateAddress: "",
      };
    }
    if (sched.kind === "ambiguous") {
      return {
        text: formatAmbiguityHebrew(sched.ambiguity),
        navigateAddress: "",
      };
    }
    return {
      text: `${agencyUnresolvedNote}\n${sched.messageHe}`,
      navigateAddress: "",
    };
  }

  return {
    text: agencyUnresolvedNote,
    navigateAddress: "",
  };
}

export async function resolveRoutesReply(input: {
  origin: string;
  destination: string;
  departure?: string;
  arrival?: string;
  line?: string;
  headsign?: string;
  stopCode?: string;
  agency?: string;
  serviceDate?: string;
  windowEnd?: string;
  aspects?: RoutesAspect[] | unknown;
  mode?: RoutesTravelMode | string | null;
  originLat?: number | null;
  originLng?: number | null;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
  requireLiveSelect?: boolean;
  speakerAsk?: string;
  billing?: ComposeLlmBilling | null;
  runSelect?: typeof runLivePostSelect;
}): Promise<{ text: string; navigateAddress: string }> {
  const origin = String(input.origin ?? "").trim();
  const destination = String(input.destination ?? "").trim();
  const aspects = parseRoutesAspects(input.aspects);
  const travelMode: RoutesTravelMode =
    String(input.mode ?? "")
      .trim()
      .toLowerCase() === "drive"
      ? "drive"
      : "transit";
  const requireLiveSelect = input.requireLiveSelect === true;
  const runSelect = input.runSelect ?? runLivePostSelect;
  if (
    aspects.includes("schedule") ||
    aspects.includes("nearest_stop") ||
    aspects.includes("live_arrivals")
  ) {
    // MOT schedule / nearest / SIRI: structured filters only — no Stage B.
    return resolveGtfsRoutesReply({
      origin,
      destination,
      departure: input.departure,
      line: input.line,
      headsign: input.headsign,
      stopCode: input.stopCode,
      agency: input.agency,
      serviceDate: input.serviceDate,
      windowEnd: input.windowEnd,
      aspects,
      originLat: input.originLat,
      originLng: input.originLng,
      fetchImpl: input.fetchImpl,
      apiKey: input.apiKey,
    });
  }
  const linesBoard = aspects.includes("lines") && !destination;
  const speakerOrigin = origin.toLowerCase() === "speaker";
  const hasPin =
    input.originLat != null &&
    input.originLng != null &&
    Number.isFinite(input.originLat) &&
    Number.isFinite(input.originLng);

  if (linesBoard) {
    if (!origin || speakerOrigin) {
      return {
        text: "לאיזו תחנה? (למשל שלום דורני בפתח תקווה)",
        navigateAddress: "",
      };
    }
    try {
      const facts = await fetchRoutesFacts({
        ...input,
        origin,
        destination: "",
        aspects: ["lines"],
      });
      if (!requireLiveSelect || facts.stopLines.length === 0) {
        return {
          text: formatRoutesHebrew(facts),
          navigateAddress: facts.navigateAddress,
        };
      }
      const outcome = await runSelect({
        domain: "routes",
        records: routesStopLinesToLiveRetrievalRecords(facts),
        speakerAsk: input.speakerAsk ?? "",
        billing: input.billing ?? null,
      });
      return {
        text: formatRoutesAfterLiveSelect(facts, outcome, "lines"),
        navigateAddress: facts.navigateAddress,
      };
    } catch (error) {
      if (error instanceof Error && error.message === ROUTES_API_KEY_MISSING) {
        return {
          text: "רשימת קווים בתחנה לא מוגדרת כרגע (חסר מפתח Google Places/Routes).",
          navigateAddress: "",
        };
      }
      if (error instanceof Error && error.message === ROUTES_API_DENIED) {
        return {
          text: "חיפוש תחנות בגוגל לא מופעל למפתח הזה (צריך Places API).",
          navigateAddress: "",
        };
      }
      return {
        text: `לא הצלחתי לשלוף קווים לתחנת «${origin}» עכשיו. נסה שוב בעוד רגע.`,
        navigateAddress: "",
      };
    }
  }

  if (!destination || (!origin && !hasPin)) {
    return {
      text: "מאיפה ולאן? (למשל מרחוב ז׳בוטינסקי בפתח תקווה לדיזנגוף סנטר)",
      navigateAddress: "",
    };
  }
  if (speakerOrigin && !hasPin) {
    return {
      text: "שלח מיקום בוואטסאפ (סיכת מיקום) ואז אגיד איך להגיע מכאן.",
      navigateAddress: "",
    };
  }

  // Trip planning needs Google Routes — fail before geocode network calls.
  if (!resolveRoutesApiKey(input.apiKey)) {
    return {
      text: "ניווט בתחבורה ציבורית לא מוגדר כרגע (חסר מפתח Google Routes).",
      navigateAddress: "",
    };
  }

  let originLat = input.originLat;
  let originLng = input.originLng;
  let originLabel: string | undefined;
  let destinationLat: number | null | undefined;
  let destinationLng: number | null | undefined;
  let destinationLabel: string | undefined;
  const lineFocus =
    Boolean(String(input.line ?? "").trim() || String(input.headsign ?? "").trim()) &&
    (aspects.includes("eta") || aspects.includes("frequency"));

  // Named origin (not speaker pin): resolve coords when possible; ask if ambiguous.
  if (!speakerOrigin && origin && !hasPin) {
    const geo = await geocodeNamedPlaceForNearestStop({
      query: origin,
      fetchImpl: input.fetchImpl,
      apiKey: input.apiKey,
    });
    if (!geo.ok && geo.kind === "ambiguous") {
      return {
        text: geo.options?.length
          ? `${geo.messageHe}\n${geo.options.map((o) => `• ${o}`).join("\n")}`
          : geo.messageHe,
        navigateAddress: "",
      };
    }
    if (geo.ok) {
      originLat = geo.lat;
      originLng = geo.lng;
      // Keep spoken origin for line-ETA boarding-stop token match.
      if (!lineFocus) {
        originLabel = geo.label;
      }
    }
    // Empty geocode → keep Google address string (existing trip path).
  }

  if (destination) {
    const geo = await geocodeNamedPlaceForNearestStop({
      query: destination,
      fetchImpl: input.fetchImpl,
      apiKey: input.apiKey,
    });
    if (!geo.ok && geo.kind === "ambiguous") {
      return {
        text: geo.options?.length
          ? `${geo.messageHe}\n${geo.options.map((o) => `• ${o}`).join("\n")}`
          : geo.messageHe,
        navigateAddress: "",
      };
    }
    if (geo.ok) {
      destinationLat = geo.lat;
      destinationLng = geo.lng;
      destinationLabel = geo.label;
    }
  }

  try {
    const facts = await fetchRoutesFacts({
      ...input,
      origin: origin || "speaker",
      mode: travelMode,
      originLat,
      originLng,
      destinationLat,
      destinationLng,
      originLabel,
      destinationLabel,
    });
    const itineraryRecords = routesItinerariesToLiveRetrievalRecords(facts);
    let googleText = formatRoutesHebrew(facts);
    let selectedFacts = facts;
    if (requireLiveSelect && itineraryRecords.length > 0) {
      const outcome = await runSelect({
        domain: "routes",
        records: itineraryRecords,
        speakerAsk: input.speakerAsk ?? "",
        billing: input.billing ?? null,
      });
      googleText = formatRoutesAfterLiveSelect(facts, outcome, "itineraries");
      if (outcome.kind === "subset") {
        selectedFacts = filterRoutesFactsByItineraryIds(facts, outcome.keptIds);
      } else if (outcome.kind === "no_match") {
        selectedFacts = {
          ...facts,
          itineraries: [],
          steps: [],
          durationText: "",
          leaveByText: "",
          arriveByText: "",
        };
      }
    }
    const officialExtra =
      travelMode === "transit" && selectedFacts.steps.length > 0
        ? await formatOfficialBoardingDeparturesHe(selectedFacts, {
            fetchImpl: input.fetchImpl,
          })
        : "";
    return {
      text: `${googleText}${officialExtra}`.trim(),
      navigateAddress: selectedFacts.navigateAddress || facts.navigateAddress,
    };
  } catch (error) {
    if (error instanceof Error && error.message === ROUTES_API_KEY_MISSING) {
      return {
        text: "ניווט בתחבורה ציבורית לא מוגדר כרגע (חסר מפתח Google Routes).",
        navigateAddress: "",
      };
    }
    if (error instanceof Error && error.message === ROUTES_API_DENIED) {
      return {
        text: "מסלולי תחבורה ציבורית בגוגל לא מופעלים למפתח הזה (צריך Routes API).",
        navigateAddress: "",
      };
    }
    if (error instanceof Error && error.message === ROUTES_ZERO_RESULTS) {
      return {
        text: `לא מצאתי מסלול בתחבורה ציבורית מ«${speakerOrigin ? "המיקום שלך" : origin}» ל«${destination}».`,
        navigateAddress: "",
      };
    }
    return {
      text: "לא הצלחתי לחשב מסלול עכשיו. נסה שוב בעוד רגע.",
      navigateAddress: "",
    };
  }
}
