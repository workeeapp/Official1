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
import {
  adaptMatchForConsumer,
  ROUTES_ENDPOINT_CONSUMER_CAPABILITIES,
} from "./geographic-consumer.js";
import { speakGeographicMatchForUser } from "./geo-area-user-copy.js";
import type { GeographicProvider } from "./geographic-provider.js";
import { resolveGeographic } from "./geographic-resolve.js";
import { googleGeocodeAreaProvider } from "./providers/google-geocode-area.provider.js";
import { localGeoAreaIndexProvider } from "./providers/local-geo-area-index.provider.js";
import { createNamedPlacePointProvider } from "./providers/named-place-point.provider.js";
import { openMeteoPointProvider } from "./providers/open-meteo-point.provider.js";
import {
  formatSavedRouteNotice,
  type SavedLocationContactRef,
} from "./saved-route-location.js";
import type { EmployeeRecordSnapshot } from "./employee-records.service.js";
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
  /**
   * True when leaveByText is the first TRANSIT board clock (not door-to-door
   * leave derived from arrival − duration). Affects Hebrew lead labeling.
   */
  leaveIsBoarding?: boolean;
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
  /**
   * Trip prefer from ACTION. Only `closest_board` is honored; empty = default
   * leave→walk ranking (unchanged).
   */
  prefer: RoutesPrefer;
  /**
   * True when prefer=closest_board but no itinerary had comparable boarding
   * walk + line + stop — reply must disclose, not claim closest.
   */
  closestBoardInsufficient: boolean;
};

/** Supported routes.prefer values (omit/empty keeps default ranking). */
export type RoutesPrefer = "" | "closest_board";

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

/** prefer=closest_board but no comparable boarding walk among Google options. */
export const ROUTES_CLOSEST_BOARD_INSUFFICIENT_HE =
  "אין לי מספיק נתונים מגוגל כדי לקבוע איזו תחנת עלייה הכי קרובה למוצא מבין המסלולים שחזרו — לא אנחש.";

/** Narrow walk-step display note when empty/0s legs were omitted. */
export const ROUTES_WALK_PARTIAL_NOTE_HE =
  "(פרטי הליכה חלקיים מהמקור — חלק משלבי ההליכה לא הוצגו.)";

/**
 * Wave 1 compact multi cue — secondary itineraries are not expanded up front.
 * Follow-up: use saved-board open (recommended / all / מסלול N), not a new search.
 */
export function routesMultiAltsCueHe(
  extraCount: number,
  itineraries?: RouteItineraryOption[],
): string {
  const n = Math.max(0, Math.floor(extraCount));
  if (n <= 0) {
    return "";
  }
  const diffs = itinerariesDiffBitsHe(itineraries ?? []);
  const head = diffs
    ? `עוד ${n} אפשרויות (${diffs})`
    : `עוד ${n} אפשרויות`;
  return `${head} — לפרטים: «המסלול המומלץ», «כל המסלולים», או «מסלול 2».`;
}

/** Compact board persisted on assistant raw after a successful A→B trip. */
export type LastRoutesBoard = {
  origin: string;
  destination: string;
  mode: RoutesTravelMode;
  itineraries: RouteItineraryOption[];
  fetchedAt: string;
};

export const ROUTES_NO_SAVED_BOARD_HE =
  "אין לי מסלול שמור מהחיפוש הקודם — חפשי שוב איך להגיע.";

export const ROUTES_OPEN_INDEX_MISS_HE =
  "המסלול שבחרת לא זמין מהחיפוש האחרון.";

/**
 * Model emitted open_itinerary with empty O/D, but the speaker message is not
 * an exact closed-choice board command — fail closed (no board expand, no fetch).
 */
export const ROUTES_OPEN_UNAUTHORIZED_CLARIFY_HE =
  "לא ברור אם לפתוח את המסלול השמור או לחפש מסלול חדש — כתבי «המסלול המומלץ» / «כל המסלולים» / «מסלול N», או צייני מוצא ויעד לחיפוש מחדש.";

export type RoutesOpenItinerary = "recommended" | "all" | number;

export type ResolveRoutesResult = {
  text: string;
  navigateAddress: string;
  /** Set only after a successful Google A→B trip with ≥1 itinerary. */
  board?: LastRoutesBoard | null;
  /** Multi summary choice buttons (≥2 itineraries). */
  choiceButtons?: Array<{ label: string; command: string }>;
};

export function buildRoutesChoiceButtons(
  itineraryCount: number,
): Array<{ label: string; command: string }> {
  const n = Math.max(0, Math.floor(itineraryCount));
  if (n < 2) {
    return [];
  }
  // label === command so applyShowButtonsToBubbles keeps these as closed
  // choices on the routes facts bubble (not stripped as show/LIST chrome).
  const allLabel = `כל המסלולים (${n})`.slice(0, 20);
  return [
    { label: "המסלול המומלץ", command: "המסלול המומלץ" },
    { label: allLabel, command: allLabel },
  ];
}

export function buildLastRoutesBoard(input: {
  origin: string;
  destination: string;
  mode: RoutesTravelMode;
  itineraries: RouteItineraryOption[];
  fetchedAt?: string;
}): LastRoutesBoard | null {
  const itineraries = input.itineraries.slice(0, ROUTES_ITINERARY_DISPLAY_CAP);
  if (itineraries.length === 0) {
    return null;
  }
  return {
    origin: input.origin.trim(),
    destination: input.destination.trim(),
    mode: input.mode,
    itineraries,
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
  };
}

/**
 * Exact closed-choice commands for opening a saved board. Returns null when the
 * message has extra trip-change content (do not intercept mixed intent).
 */
export function mapRoutesOpenCommand(raw: string): RoutesOpenItinerary | null {
  const t = raw.trim().replace(/\s+/gu, " ");
  if (!t) {
    return null;
  }
  // Exact phrases only — never substring/mixed-intent (e.g. «המלצה לדיזנגוף»).
  const exactRecommended = new Set([
    "המסלול המומלץ",
    "הציגי את המסלול המומלץ",
    "הצג את המסלול המומלץ",
    "הראה את המסלול המומלץ",
    "הראי את המסלול המומלץ",
    "תראי את המסלול המומלץ",
    "תראה את המסלול המומלץ",
    "הציגי את ההמלצה",
    "הצג את ההמלצה",
    "תראי את ההמלצה",
    "תראה את ההמלצה",
  ]);
  if (exactRecommended.has(t)) {
    return "recommended";
  }
  if (
    t === "כל המסלולים" ||
    /^כל המסלולים \(\d+\)$/u.test(t) ||
    t === "הציגי את כל המסלולים" ||
    t === "הצג את כל המסלולים" ||
    t === "הראה את כל המסלולים" ||
    t === "הראי את כל המסלולים" ||
    t === "תראי את כל המסלולים" ||
    t === "תראה את כל המסלולים"
  ) {
    return "all";
  }
  const indexed = t.match(/^מסלול\s+(\d+)$/u);
  if (indexed) {
    const n = Number(indexed[1]);
    if (
      Number.isInteger(n) &&
      n >= 1 &&
      n <= ROUTES_ITINERARY_DISPLAY_CAP
    ) {
      return n;
    }
    return null;
  }
  return null;
}

function itineraryLeadBitsHe(option: RouteItineraryOption): string {
  const clocks = displayLeaveArriveForLead(option);
  const headBits: string[] = [];
  if (option.durationText) {
    headBits.push(`משך משוער *${option.durationText}*`);
  }
  if (clocks.leaveByText) {
    headBits.push(
      clocks.leaveIsBoarding
        ? `עלייה משוערת ${clocks.leaveByText}`
        : `יציאה משוערת ${clocks.leaveByText}`,
    );
  }
  if (clocks.arriveByText) {
    headBits.push(`הגעה משוערת ${clocks.arriveByText}`);
  }
  if (option.fareText) {
    headBits.push(`מחיר משוער ${option.fareText}`);
  }
  const lineLabel = transitLinesLabel(option.steps);
  if (lineLabel) {
    headBits.push(lineLabel);
  }
  for (const bit of itineraryWalkTransferBits(option.steps)) {
    headBits.push(bit);
  }
  return headBits.length > 0 ? headBits.join(" · ") : "";
}

/** Step-by-step for one saved itinerary (verified fields only). */
export function formatRecommendedItineraryHebrew(
  option: RouteItineraryOption,
  meta?: { origin?: string; destination?: string; mode?: RoutesTravelMode },
): string {
  const lines: string[] = [];
  const drive = meta?.mode === "drive";
  const od =
    meta?.origin && meta?.destination
      ? ` מ«${meta.origin}» ל«${meta.destination}»`
      : "";
  lines.push(
    drive
      ? `המסלול המומלץ ברכב${od} ${ROUTES_DRIVE_ESTIMATE_DISCLAIMER_HE}`
      : `המסלול המומלץ בתחבורה ציבורית${od} ${ROUTES_MULTI_ESTIMATE_DISCLAIMER_HE}`,
  );
  const lead = itineraryLeadBitsHe(option);
  if (lead) {
    lines.push("");
    lines.push(lead);
  }
  if (option.steps.length > 0) {
    lines.push("");
    const before = lines.length;
    pushFormattedSteps(
      lines,
      option.steps,
      ROUTES_STEPS_DETAIL_DISPLAY_CAP,
    );
    if (lines.length === before) {
      lines.push("אין מספיק פרטי שלבים מהמקור כדי להציג מסלול מפורט.");
    }
  } else {
    lines.push("");
    lines.push("אין מספיק פרטי שלבים מהמקור כדי להציג מסלול מפורט.");
  }
  return lines.join("\n").trim();
}

/** Compact comparable list of saved alternatives (stable 1..N). */
export function formatAllItinerariesCompareHebrew(
  itineraries: RouteItineraryOption[],
  meta?: { origin?: string; destination?: string; mode?: RoutesTravelMode },
): string {
  const options = itineraries.slice(0, ROUTES_ITINERARY_DISPLAY_CAP);
  if (options.length === 0) {
    return ROUTES_NO_SAVED_BOARD_HE;
  }
  const lines: string[] = [];
  const drive = meta?.mode === "drive";
  const od =
    meta?.origin && meta?.destination
      ? ` מ«${meta.origin}» ל«${meta.destination}»`
      : "";
  lines.push(
    drive
      ? `כל המסלולים ברכב (${options.length})${od} ${ROUTES_DRIVE_ESTIMATE_DISCLAIMER_HE}`
      : `כל המסלולים בתחבורה ציבורית (${options.length})${od} ${ROUTES_MULTI_ESTIMATE_DISCLAIMER_HE}`,
  );
  options.forEach((opt, i) => {
    const lead = itineraryLeadBitsHe(opt) || "מסלול";
    lines.push(`${i + 1}. ${lead}`);
  });
  lines.push("");
  lines.push("לבחירה: «מסלול 1» / «מסלול 2» או «המסלול המומלץ».");
  return lines.join("\n").trim();
}

/** Expand a saved board without a provider fetch. */
export function formatOpenItineraryFromBoard(
  board: LastRoutesBoard,
  open: RoutesOpenItinerary,
): { text: string; navigateAddress: string } {
  const options = board.itineraries.slice(0, ROUTES_ITINERARY_DISPLAY_CAP);
  if (options.length === 0) {
    return { text: ROUTES_NO_SAVED_BOARD_HE, navigateAddress: "" };
  }
  const meta = {
    origin: board.origin,
    destination: board.destination,
    mode: board.mode,
  };
  if (open === "all") {
    return {
      text: formatAllItinerariesCompareHebrew(options, meta),
      navigateAddress: board.destination || "",
    };
  }
  let index = 0;
  if (open === "recommended") {
    index = 0;
  } else if (typeof open === "number") {
    if (open < 1 || open > options.length) {
      const valid = options.map((_, i) => `מסלול ${i + 1}`).join(" / ");
      return {
        text: `${ROUTES_OPEN_INDEX_MISS_HE} זמינים: ${valid} או «המסלול המומלץ» / «כל המסלולים».`,
        navigateAddress: "",
      };
    }
    index = open - 1;
  }
  const option = options[index]!;
  const title =
    open === "recommended" || index === 0
      ? formatRecommendedItineraryHebrew(option, meta)
      : formatRecommendedItineraryHebrew(option, meta).replace(
          /^המסלול המומלץ/u,
          `מסלול ${index + 1}`,
        );
  return {
    text: title,
    navigateAddress: board.destination || "",
  };
}

/** Real differences among itineraries only — never invent contrast. */
function itinerariesDiffBitsHe(itineraries: RouteItineraryOption[]): string {
  if (itineraries.length < 2) {
    return "";
  }
  const parts: string[] = [];
  const leaves = itineraries.map((i) => i.leaveByText.trim()).filter(Boolean);
  if (leaves.length >= 2 && new Set(leaves).size > 1) {
    parts.push("יציאה");
  }
  const durs = itineraries
    .map((i) =>
      i.durationText.trim() ||
      (i.durationSeconds != null ? String(i.durationSeconds) : ""),
    )
    .filter(Boolean);
  if (durs.length >= 2 && new Set(durs).size > 1) {
    parts.push("משך");
  }
  const walks = itineraries.map((i) => walkSecondsFromSteps(i.steps));
  const knownWalks = walks.filter((w): w is number => w != null);
  if (
    knownWalks.length >= 2 &&
    new Set(knownWalks).size > 1
  ) {
    parts.push("הליכה");
  }
  return parts.join("/");
}

/** Schedule fallback intro — never label as live SIRI. */
export const ROUTES_SCHEDULE_NOT_LIVE_INTRO_HE =
  "מציגה במקום לוח זמנים מתוזמן (לא תחזית חיה):";

/** Google ETA when SIRI cannot run — explicitly not live MOT. */
export const ROUTES_GOOGLE_ETA_NOT_SIRI_INTRO_HE =
  "מציגה הערכת Google ליציאה הבאה (לא תחזית SIRI חיה):";

/**
 * Network-wide disruption / SX is not connected — prompt/capability U disclose.
 * Not a live feed result. Engine injects when routes.disclose_network_disruption.
 */
export const ROUTES_DISRUPTION_UNAVAILABLE_HE =
  "אין לי מידע על שיבושים או ביטולים ברשת — היכולת הזו לא מחוברת. אפשר לשאול על תחזית הגעה לתחנה או לוח מתוזמן לקו.";

/** Missed-bus recalculate with no recoverable O/D from history/board. */
export const ROUTES_RECALCULATE_NO_CONTEXT_HE =
  "אין לי מוצא ויעד מהמסלול הקודם — מאיפה ולאן לחשב עכשיו?";

/**
 * Persistent Google Routes ETA poll failures for bus_eta watches.
 * Not SIRI; does not invent an ETA.
 */
export const ROUTES_BUS_ETA_POLL_UNAVAILABLE_HE =
  "לא הצלחתי לעדכן את הערכת זמן היציאה מגוגל לקו המבוקש — ההתראה לא מבוססת על תחזית SIRI חיה. אבדוק שוב בסיבוב הבא; אם זה נמשך, כדאי לבקש חיפוש מסלול מחדש.";

/** Consecutive Google ETA poll failures before one honesty notify. */
export const BUS_ETA_POLL_FAIL_NOTIFY_AFTER = 3;

const BUS_ETA_POLL_FAIL_PREFIX = "bus_eta:poll_fail:";
const BUS_ETA_POLL_FAIL_NOTIFIED = "bus_eta:poll_fail_notified";

export function parseBusEtaPollFailCount(lastReportSha: string): number {
  const s = String(lastReportSha ?? "").trim();
  if (!s.startsWith(BUS_ETA_POLL_FAIL_PREFIX)) {
    return 0;
  }
  const n = Number(s.slice(BUS_ETA_POLL_FAIL_PREFIX.length));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function busEtaPollFailSha(count: number): string {
  return `${BUS_ETA_POLL_FAIL_PREFIX}${Math.max(1, Math.floor(count))}`;
}

export function isBusEtaPollFailNotified(lastReportSha: string): boolean {
  return String(lastReportSha ?? "")
    .trim()
    .startsWith(BUS_ETA_POLL_FAIL_NOTIFIED);
}

export function busEtaPollFailNotifiedSha(now = new Date()): string {
  return `${BUS_ETA_POLL_FAIL_NOTIFIED}:${now.toISOString()}`;
}

/** Fill missing O/D from a saved board for recalculate (never invents places). */
export function fillRoutesOdFromBoard(
  origin: string,
  destination: string,
  board: LastRoutesBoard | null | undefined,
): { origin: string; destination: string } {
  const o = origin.trim();
  const d = destination.trim();
  if (o && d) {
    return { origin: o, destination: d };
  }
  if (!board) {
    return { origin: o, destination: d };
  }
  return {
    origin: o || board.origin.trim(),
    destination: d || board.destination.trim(),
  };
}

export function parseRoutesPrefer(raw: unknown): RoutesPrefer {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase();
  return key === "closest_board" ? "closest_board" : "";
}

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

/**
 * Shared ladder for one routes endpoint (origin or destination) via
 * Geographic Core + Routes consumer fit:
 * speaker+PIN → saved (coords or geocoded address) → Places Text Search /
 * Open-Meteo → region rejected (no invented representative point).
 */
export type RoutesEndpointResolveResult =
  | {
      kind: "coords";
      lat: number;
      lng: number;
      label: string;
      source: "pin" | "saved" | "geocode";
      savedNotice?: string;
    }
  | { kind: "ask"; text: string }
  | { kind: "unresolved"; query: string }
  | { kind: "none" };

/** Places Text Search first, then OM, then area (for region reject via fit). */
export function routesGeographicProviders(
  geocodeFn: typeof geocodeNamedPlaceForNearestStop = geocodeNamedPlaceForNearestStop,
): GeographicProvider[] {
  return [
    createNamedPlacePointProvider(geocodeFn),
    openMeteoPointProvider,
    localGeoAreaIndexProvider,
    googleGeocodeAreaProvider,
  ];
}

export async function resolveRoutesEndpoint(input: {
  label: string;
  pinLat?: number | null;
  pinLng?: number | null;
  snapshot?: Pick<EmployeeRecordSnapshot, "lists" | "filing"> | null;
  contacts?: SavedLocationContactRef[] | null;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
  /** Hebrew ask when label is speaker and no pin coords were provided. */
  speakerMissingPinAsk: string;
  /**
   * Trip keeps the spoken string for Google when geocode is empty.
   * nearest_stop surfaces the geocode empty ask.
   */
  onGeocodeEmpty: "continue" | "ask";
  providers?: GeographicProvider[];
}): Promise<RoutesEndpointResolveResult> {
  const q = String(input.label ?? "").trim();
  if (!q) {
    return { kind: "none" };
  }

  const speaker = q.toLowerCase() === "speaker";
  const pinOk =
    input.pinLat != null &&
    input.pinLng != null &&
    Number.isFinite(input.pinLat) &&
    Number.isFinite(input.pinLng);

  if (speaker && !pinOk) {
    return { kind: "ask", text: input.speakerMissingPinAsk };
  }

  const match = await resolveGeographic({
    ask: {
      rawText: speaker ? "" : q,
      role: "origin",
      deixis: speaker ? "pin" : "none",
      consumerHint: "routes",
    },
    geometryNeeds: { point: true, area: true },
    pending: pinOk
      ? {
          lat: input.pinLat!,
          lng: input.pinLng!,
          name: "",
          address: "",
          at: Date.now(),
        }
      : null,
    snapshot: input.snapshot,
    contacts: input.contacts,
    providers: input.providers ?? routesGeographicProviders(),
    geocodeSavedWithoutCoords: true,
    fetchImpl: input.fetchImpl,
    apiKey: input.apiKey,
  });

  const fitted = adaptMatchForConsumer(
    match,
    ROUTES_ENDPOINT_CONSUMER_CAPABILITIES,
  );

  if (fitted.status === "ambiguous") {
    return {
      kind: "ask",
      text: speakGeographicMatchForUser(fitted),
    };
  }

  if (fitted.status === "unsupported_for_consumer") {
    return {
      kind: "ask",
      text:
        speakGeographicMatchForUser(fitted) ||
        `«${fitted.labelHe || q}» הוא אזור. לאיזו נקודת מוצא או יעד מדויקת התכוונת?`,
    };
  }

  if (fitted.status === "needs_clarify") {
    // Saved without coords whose geocode failed → familiar missing-coords ask.
    if (fitted.kind === "saved" && fitted.userAskHe?.trim()) {
      return { kind: "ask", text: fitted.userAskHe };
    }
    if (input.onGeocodeEmpty === "ask") {
      return {
        kind: "ask",
        text:
          speakGeographicMatchForUser(fitted) ||
          `לא הצלחתי לזהות את המיקום «${q}». שלח סיכת מיקום או כתובת מדויקת יותר.`,
      };
    }
    // Trip path: keep spoken string for Google (existing unresolved behavior).
    return { kind: "unresolved", query: q };
  }

  const point = fitted.geometry?.point;
  if (
    !point ||
    !Number.isFinite(point.lat) ||
    !Number.isFinite(point.lng)
  ) {
    if (input.onGeocodeEmpty === "ask") {
      return {
        kind: "ask",
        text: `לא הצלחתי לזהות את המיקום «${q}». שלח סיכת מיקום או כתובת מדויקת יותר.`,
      };
    }
    return { kind: "unresolved", query: q };
  }

  if (fitted.kind === "pin") {
    return {
      kind: "coords",
      lat: point.lat,
      lng: point.lng,
      label: fitted.labelHe || "המיקום שלך",
      source: "pin",
    };
  }
  if (fitted.kind === "saved" || fitted.savedRef) {
    return {
      kind: "coords",
      lat: point.lat,
      lng: point.lng,
      label: fitted.labelHe || q,
      source: "saved",
      savedNotice: formatSavedRouteNotice(fitted.labelHe || q),
    };
  }
  return {
    kind: "coords",
    lat: point.lat,
    lng: point.lng,
    label: fitted.labelHe || q,
    source: "geocode",
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

/**
 * Prefer engine Hebrew duration when seconds are known; otherwise sanitize
 * Google localized text (never leave English "mins" in the spoken reply).
 */
export function durationTextPreferHe(
  durationSeconds: number | null,
  localizedText: string,
): string {
  if (durationSeconds != null) {
    return formatDurationHe(durationSeconds);
  }
  const raw = String(localizedText ?? "").trim();
  if (!raw) {
    return "";
  }
  if (/דק|שע/u.test(raw)) {
    return raw;
  }
  const minsOnly = raw.match(/^(\d+)\s*mins?\.?$/i);
  if (minsOnly) {
    return formatDurationHe(Number(minsOnly[1]) * 60);
  }
  const hourMin = raw.match(
    /^(\d+)\s*hours?\s*(?:(\d+)\s*mins?\.?)?$/i,
  );
  if (hourMin) {
    const h = Number(hourMin[1]);
    const m = hourMin[2] ? Number(hourMin[2]) : 0;
    return formatDurationHe(h * 3600 + m * 60);
  }
  // Unknown Latin leftover — omit rather than show English units.
  if (/[A-Za-z]/.test(raw)) {
    return "";
  }
  return raw;
}

const CLOCK_RECONCILE_TOLERANCE_MIN = 12;

function looksMidnightHm(raw: string): boolean {
  return /^(0|00):00$/.test(String(raw ?? "").trim());
}

function clockSpanMinutes(leave: string, arrive: string): number | null {
  const a = parseHmToMinutes(leave);
  const b = parseHmToMinutes(arrive);
  if (a == null || b == null) {
    return null;
  }
  let span = b - a;
  if (span < 0) {
    span += 24 * 60;
  }
  return span;
}

function leaveLooksLikeBoarding(opt: RouteItineraryOption): boolean {
  if (opt.leaveIsBoarding === true) {
    return true;
  }
  const leave = opt.leaveByText.trim();
  if (!leave) {
    return false;
  }
  const firstTransit = opt.steps.find((s) => {
    const mode = String(s.travelMode ?? "").toUpperCase();
    return mode === "TRANSIT" && String(s.departureTime ?? "").trim();
  });
  return Boolean(
    firstTransit && String(firstTransit.departureTime).trim() === leave,
  );
}

function itineraryLeaveHasIsoBacking(opt: RouteItineraryOption): boolean {
  const leave = opt.leaveByText.trim();
  if (!leave) {
    return false;
  }
  for (const step of opt.steps) {
    const mode = String(step.travelMode ?? "").toUpperCase();
    if (mode !== "TRANSIT") continue;
    const iso = String(step.departureIso ?? "").trim();
    if (!iso) continue;
    const fromIso = formatHmJerusalem(iso);
    if (fromIso && fromIso === leave) {
      return true;
    }
  }
  return false;
}

/**
 * Display leave/arrive for the compact multi lead. Omits unreliable clocks;
 * never invents replacements. Boarding leave may legitimately span less than
 * door-to-door duration (walk before board).
 *
 * Door-to-door leave-by (arrival − duration, leaveIsBoarding false) is kept even
 * when step board/arrive clocks do not reconcile or lack ISO backing — that
 * estimate is independent of boarding clocks and must not be silently dropped.
 */
export function displayLeaveArriveForLead(opt: RouteItineraryOption): {
  leaveByText: string;
  arriveByText: string;
  leaveIsBoarding: boolean;
} {
  let leave = opt.leaveByText.trim();
  let arrive = opt.arriveByText.trim();
  const boarding = leaveLooksLikeBoarding(opt);
  const durMin =
    opt.durationSeconds != null
      ? Math.round(opt.durationSeconds / 60)
      : null;
  const span =
    leave && arrive ? clockSpanMinutes(leave, arrive) : null;
  const walkSec = walkSecondsFromSteps(opt.steps);
  const walkMin = walkSec != null ? Math.round(walkSec / 60) : null;
  const hasIso = itineraryLeaveHasIsoBacking(opt);
  /** Engine door-to-door leave-by (not a verified board clock). */
  const doorToDoorLeave = Boolean(leave) && !boarding;

  const within = (a: number, b: number) =>
    Math.abs(a - b) <= CLOCK_RECONCILE_TOLERANCE_MIN;

  let keep = true;
  /** Keep leave but drop arrive when pairing is unreliable. */
  let leaveOnly = false;
  if (
    leave &&
    !hasIso &&
    (looksMidnightHm(leave) || looksMidnightHm(arrive)) &&
    durMin != null &&
    durMin >= 20
  ) {
    if (doorToDoorLeave) {
      // Arrival−duration leave-by is never ISO-backed; keep leave, drop clocks.
      leaveOnly = true;
    } else {
      // Midnight-looking boarding clocks without ISO + substantial duration —
      // unreliable (do not keep just because board→arrive span is shorter).
      keep = false;
    }
  } else if (leave && arrive && durMin != null && span != null) {
    const doorOk = within(span, durMin);
    const boardWalkOk =
      boarding &&
      walkMin != null &&
      within(span + walkMin, durMin);
    const boardSpanPlausible =
      boarding && span > 0 && span <= durMin + CLOCK_RECONCILE_TOLERANCE_MIN;
    if (boarding && (boardWalkOk || boardSpanPlausible)) {
      keep = true;
    } else if (!boarding && doorOk) {
      keep = true;
    } else if (doorToDoorLeave) {
      // Preserve arrival−duration leave-by; step arrive may not match duration.
      leaveOnly = true;
    } else if (!hasIso && !doorOk && !(boarding && span < durMin)) {
      keep = false;
    }
  }

  if (!keep) {
    leave = "";
    arrive = "";
  } else if (leaveOnly) {
    arrive = "";
  }
  return { leaveByText: leave, arriveByText: arrive, leaveIsBoarding: boarding };
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
  const arrivalIso = String(td?.stopDetails?.arrivalTime ?? "").trim();
  // Prefer absolute ISO → Jerusalem HH:mm over Google localized short text.
  const departureTime =
    (departureIso ? formatHmJerusalem(departureIso) : "") ||
    String(td?.localizedValues?.departureTime?.time?.text ?? "").trim();
  const arrivalTime =
    (arrivalIso ? formatHmJerusalem(arrivalIso) : "") ||
    String(td?.localizedValues?.arrivalTime?.time?.text ?? "").trim();
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

/**
 * Area / landmark origin (not a named transit stop). Line ETA/frequency may
 * accept Google's line-matched boarding stop after a short walk and must cite
 * that stop name — never fail closed just because tokens ≠ stop name.
 */
export function originSuggestsAreaOrLandmark(origin: string): boolean {
  const o = String(origin ?? "").trim();
  if (!o) return false;
  if (/אזור|ליד|סביב|קרוב(?:ה)?\s+ל|באזור|מאיזור|מאזור/u.test(o)) {
    return true;
  }
  // Landmark without an explicit «תחנה …» stop phrase.
  if (
    /עיריי|קניון|בי["׳']?ח|בית\s*חולים|מרכז|שוק|דיזנגוף|עזריאלי/u.test(o) &&
    !/תחנ[הת]/u.test(o)
  ) {
    return true;
  }
  return false;
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
  const durationText = durationTextPreferHe(
    durationSeconds,
    String(route.localizedValues?.duration?.text ?? "").trim(),
  );
  const distanceMeters =
    typeof route.distanceMeters === "number" ? route.distanceMeters : null;
  const fareText = fareTextFromAdvisory(route);

  let leaveByText = "";
  let arriveByText = "";
  let leaveIsBoarding = false;
  const firstTransit = steps.find((s) => {
    const mode = String(s.travelMode ?? "").toUpperCase();
    return (
      mode === "TRANSIT" &&
      (String(s.departureTime ?? "").trim() ||
        String(s.departureIso ?? "").trim())
    );
  });
  const lastArrival = [...steps]
    .reverse()
    .find((s) => String(s.arrivalTime ?? "").trim());
  if (opts.arrivalRfc && durationSeconds != null) {
    const leaveMs =
      new Date(opts.arrivalRfc).getTime() - durationSeconds * 1000;
    leaveByText = formatHmJerusalem(new Date(leaveMs).toISOString());
    leaveIsBoarding = false;
  } else if (firstTransit) {
    const iso = String(firstTransit.departureIso ?? "").trim();
    leaveByText =
      (iso ? formatHmJerusalem(iso) : "") ||
      String(firstTransit.departureTime ?? "").trim();
    leaveIsBoarding = Boolean(leaveByText);
  }
  if (lastArrival?.arrivalTime) {
    arriveByText = String(lastArrival.arrivalTime).trim();
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
    leaveIsBoarding,
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
 * Walk seconds on contiguous WALK legs before the first TRANSIT step.
 * 0 when the itinerary starts with transit. null when walk exists but no
 * usable duration, or when there is no transit boarding step.
 */
export function boardingWalkSecondsBeforeTransit(
  steps: RouteStepFact[],
): number | null {
  let walk = 0;
  let sawWalk = false;
  let knownWalk = false;
  for (const step of steps) {
    const mode = String(step.travelMode ?? "").toUpperCase();
    if (mode === "TRANSIT") {
      if (!sawWalk) {
        return 0;
      }
      return knownWalk ? walk : null;
    }
    if (mode === "WALK" || mode === "WALKING") {
      sawWalk = true;
      if (step.durationSeconds != null && step.durationSeconds >= 0) {
        walk += step.durationSeconds;
        knownWalk = true;
      }
    }
  }
  return null;
}

export function firstTransitBoard(
  steps: RouteStepFact[],
): RouteStepFact | undefined {
  return steps.find(
    (s) =>
      String(s.travelMode ?? "").toUpperCase() === "TRANSIT" &&
      Boolean(s.line?.trim()) &&
      Boolean(s.fromStop?.trim()),
  );
}

/** Usable for closest_board: known boarding walk + line + stop name. */
export function itineraryClosestBoardComparable(
  opt: RouteItineraryOption,
): boolean {
  if (!firstTransitBoard(opt.steps)) {
    return false;
  }
  return boardingWalkSecondsBeforeTransit(opt.steps) != null;
}

/**
 * Rank Google trip alternatives by practical leave time, walk, arrive, duration.
 * Does not invent values — missing fields sort last within that key.
 * Default ranking when prefer is omitted — do not change without regressing tests.
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

/**
 * Rank by walk-to-first-board among comparable itineraries; non-comparable last.
 * Tie-break with the default leave→walk→arrive→duration keys.
 */
export function rankTripItinerariesByClosestBoard(
  options: RouteItineraryOption[],
): RouteItineraryOption[] {
  const score = (
    opt: RouteItineraryOption,
  ): [number, number, number, number, number] => {
    const comparable = itineraryClosestBoardComparable(opt);
    const boardWalk = comparable
      ? (boardingWalkSecondsBeforeTransit(opt.steps) as number)
      : Number.POSITIVE_INFINITY;
    return [
      boardWalk,
      parseHmToMinutes(opt.leaveByText) ?? Number.POSITIVE_INFINITY,
      walkSecondsFromSteps(opt.steps) ?? Number.POSITIVE_INFINITY,
      parseHmToMinutes(opt.arriveByText) ?? Number.POSITIVE_INFINITY,
      opt.durationSeconds ?? Number.POSITIVE_INFINITY,
    ];
  };
  return [...options].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) {
      if (sa[i]! !== sb[i]!) return sa[i]! - sb[i]!;
    }
    return 0;
  });
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
  let attemptedOfficialBoard = false;
  for (let i = 0; i < itineraries.length; i++) {
    const board = firstTransitBoard(itineraries[i]!.steps);
    if (!board) continue;
    attemptedOfficialBoard = true;
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
    // Identify by stop+line only — never «אפשרות N» (conflicts with Wave 1
    // compact multi cue: no stable option index after recalculate).
    const rows = sched.departures.slice(0, 2).map((d) => {
      const dir =
        d.headsign || d.directionLabel
          ? ` לכיוון ${d.headsign || d.directionLabel}`
          : "";
      return `• ${d.departureTime} קו ${d.line}${dir} [${d.stopCode}]`;
    });
    blocks.push(
      `תחנת העלייה «${sched.departures[0]?.stopName || board.fromStop}» קו ${line}:\n${rows.join("\n")}`,
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
    // Honesty: we tried MOT match from Google boarding names but got nothing —
    // do not silently look like “no official times exist” without saying why.
    if (attemptedOfficialBoard) {
      return [
        "",
        "לא הצלחתי לשייך יציאות רשמיות מתחנות העלייה במסלול (שם תחנה מגוגל לא תמיד תואם לקוד MOT) — המסלול למעלה הוא הערכת Google בלבד.",
      ].join("\n");
    }
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
  /** Only closest_board is honored; omit/empty keeps default ranking. */
  prefer?: RoutesPrefer | string | null;
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
  const prefer =
    travelMode === "drive" ? "" : parseRoutesPrefer(input.prefer);
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
    prefer,
    closestBoardInsufficient: false,
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
    const mapped = routes.slice(0, ROUTES_ITINERARY_DISPLAY_CAP).map((r) =>
      summarizeApiRoute(r, {
        arrivalRfc: arrivalRfc,
        departureRfc: departureRfc,
      }),
    );
    if (prefer === "closest_board") {
      const usable = mapped.filter(itineraryClosestBoardComparable);
      if (usable.length === 0) {
        facts.closestBoardInsufficient = true;
        facts.itineraries = rankTripItineraries(mapped);
      } else {
        facts.itineraries = rankTripItinerariesByClosestBoard(mapped);
      }
    } else {
      facts.itineraries = rankTripItineraries(mapped);
    }
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
      // Named stop asked but Google boards elsewhere → fail closed.
      // Area/landmark origin → accept line-matched board and cite that stop.
      if (
        lineEtaAsk &&
        lineMatching.length > 0 &&
        originSuggestsAreaOrLandmark(originLabel)
      ) {
        focus = lineMatching[0];
      } else {
        facts.lineMatchFailed = true;
        facts.etaMinutes = null;
        facts.headwaySeconds = null;
        // Keep duration/steps from primary route for summary asks, but do not
        // set leaveBy from a non-matching transit when this was a line ETA.
        if (lineEtaAsk) {
          facts.leaveByText = "";
          return facts;
        }
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

/**
 * Format one step for display. Empty string = omit this step (N2: empty/0s
 * walk legs without a clear tip are not shown as navigation).
 */
function formatStepLine(step: RouteStepFact, index: number): string {
  const n = index + 1;
  if (step.travelMode === "WALK" || step.travelMode === "WALKING") {
    const instruction = String(step.instruction ?? "").trim();
    const toStop = String(step.toStop ?? "").trim();
    const hasTip = Boolean(instruction || toStop);
    const zeroDur =
      step.durationSeconds === 0 ||
      /^0\s*דק/u.test(String(step.durationText ?? "").trim());
    const noUsableDur =
      step.durationSeconds == null && !String(step.durationText ?? "").trim();
    // Omit junk walk legs: no tip and zero/missing duration.
    if (!hasTip && (zeroDur || noUsableDur)) {
      return "";
    }
    const tip = instruction || (toStop ? `הליכה עד ${toStop}` : "הליכה");
    const dur =
      step.durationText && !zeroDur ? ` (${step.durationText})` : "";
    // Zero-duration with a tip: show tip without claiming 0 minutes.
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

/** Push formatted steps; renumber after omissions; note partial walk once. */
function pushFormattedSteps(
  lines: string[],
  steps: RouteStepFact[],
  maxSteps: number,
): void {
  let displayIndex = 0;
  let omittedWalk = false;
  for (const step of steps.slice(0, maxSteps)) {
    const line = formatStepLine(step, displayIndex);
    if (!line) {
      if (
        step.travelMode === "WALK" ||
        step.travelMode === "WALKING"
      ) {
        omittedWalk = true;
      }
      continue;
    }
    lines.push(line);
    displayIndex += 1;
  }
  if (omittedWalk) {
    lines.push(ROUTES_WALK_PARTIAL_NOTE_HE);
  }
  if (steps.length > maxSteps) {
    lines.push(ROUTES_STEPS_LOCAL_TRUNCATION_HE);
  }
}

function closestBoardLeadHe(facts: RoutesFacts): string {
  const opt =
    facts.itineraries[0] ??
    (facts.steps.length > 0
      ? {
          durationText: facts.durationText,
          durationSeconds: facts.durationSeconds,
          distanceMeters: facts.distanceMeters,
          fareText: facts.fareText,
          leaveByText: facts.leaveByText,
          arriveByText: facts.arriveByText,
          steps: facts.steps,
        }
      : null);
  if (!opt || !itineraryClosestBoardComparable(opt)) {
    return "";
  }
  const board = firstTransitBoard(opt.steps)!;
  const walkSec = boardingWalkSecondsBeforeTransit(opt.steps)!;
  const walkBit =
    walkSec <= 0
      ? "ללא הליכה לתחנה"
      : `הליכה כ־${formatDurationHe(walkSec)}`;
  return `הקו עם תחנת העלייה הקרובה ביותר למוצא (מבין המסלולים שגוגל הציע עכשיו): קו ${board.line} מ«${board.fromStop}», ${walkBit}.`;
}

/**
 * Multi-itinerary first response (Wave 1 compact contract):
 * - Lead = primary recommendation + decision-relevant fields only.
 * - Cue that more alternatives exist (no full bodies for options 2..N).
 * - Step-by-step only when aspects includes `steps`, and only for the primary.
 *
 * Single-itinerary answers use formatRoutesHebrew's single path and KEEP showing
 * basic directions when aspects includes `summary` (product usefulness).
 */
function formatMultiItinerariesHebrew(facts: RoutesFacts): string {
  const lines: string[] = [];
  const arriveAsk = Boolean(facts.arrival.trim());
  const n = facts.itineraries.length;
  const drive = facts.mode === "drive";
  const primary = facts.itineraries[0];
  if (!primary) {
    return "";
  }
  lines.push(
    drive
      ? `מצאתי ${n} אפשרויות ברכב מ«${facts.origin}» ל«${facts.destination}» ${ROUTES_DRIVE_ESTIMATE_DISCLAIMER_HE}`
      : `מצאתי ${n} אפשרויות בתחבורה ציבורית מ«${facts.origin}» ל«${facts.destination}» ${ROUTES_MULTI_ESTIMATE_DISCLAIMER_HE}`,
  );
  if (arriveAsk) {
    const arriveLabel = displayClockLabel(facts.arrival);
    lines.push(`יעד הגעה: עד ${arriveLabel}.`);
  }

  const clocks = displayLeaveArriveForLead(primary);
  const headBits: string[] = [];
  if (primary.durationText) {
    headBits.push(`משך משוער *${primary.durationText}*`);
  }
  if (arriveAsk && clocks.leaveByText) {
    headBits.push(`צא בסביבות *${clocks.leaveByText}*`);
  } else if (clocks.leaveByText) {
    headBits.push(
      clocks.leaveIsBoarding
        ? `עלייה משוערת ${clocks.leaveByText}`
        : `יציאה משוערת ${clocks.leaveByText}`,
    );
  }
  if (clocks.arriveByText && !arriveAsk) {
    headBits.push(`הגעה משוערת ${clocks.arriveByText}`);
  }
  if (wants(facts.aspects, "fare") && primary.fareText) {
    headBits.push(`מחיר משוער ${primary.fareText}`);
  }
  const lineLabel = transitLinesLabel(primary.steps);
  if (lineLabel) {
    headBits.push(lineLabel);
  }
  for (const bit of itineraryWalkTransferBits(primary.steps)) {
    headBits.push(bit);
  }
  lines.push("");
  lines.push(
    `המלצה: ${headBits.length > 0 ? headBits.join(" · ") : "מסלול ראשי"}`,
  );

  // Multi: steps only on explicit steps aspect (not summary). Primary only.
  if (facts.aspects.includes("steps") && primary.steps.length > 0) {
    lines.push("");
    pushFormattedSteps(
      lines,
      primary.steps,
      ROUTES_STEPS_DETAIL_DISPLAY_CAP,
    );
  }

  const cue = routesMultiAltsCueHe(n - 1, facts.itineraries);
  if (cue) {
    lines.push("");
    lines.push(cue);
  }

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

  const closestPrefix =
    facts.prefer === "closest_board"
      ? facts.closestBoardInsufficient
        ? `${ROUTES_CLOSEST_BOARD_INSUFFICIENT_HE}\n\n`
        : (() => {
            const lead = closestBoardLeadHe(facts);
            return lead ? `${lead}\n\n` : "";
          })()
      : "";

  // Multi-option only when Google returned >1 alternatives for a trip summary.
  if (facts.itineraries.length > 1) {
    return `${closestPrefix}${formatMultiItinerariesHebrew(facts)}`.trim();
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
        : `מסלול בתחבורה ציבורית מ«${facts.origin}» ל«${facts.destination}» ${ROUTES_MULTI_ESTIMATE_DISCLAIMER_HE}:`,
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

  // Single itinerary: keep useful basic directions on summary (Wave 1 product).
  // Multi path above is compact and does not use this branch.
  const showSteps =
    wants(facts.aspects, "steps") || facts.aspects.includes("summary");
  if (showSteps && facts.steps.length > 0) {
    lines.push("");
    const max = facts.aspects.includes("steps")
      ? ROUTES_STEPS_DETAIL_DISPLAY_CAP
      : ROUTES_STEPS_SUMMARY_DISPLAY_CAP;
    pushFormattedSteps(lines, facts.steps, max);
  }

  return `${closestPrefix}${lines.join("\n")}`.trim();
}

export type BusEtaWatchResult = {
  /** false = provider/network error (not “ETA still above threshold”). */
  ok: boolean;
  minutes: number | null;
  fingerprint: string;
  leaveByText: string;
};

/** Next departure minutes + fingerprint for bus_eta watches (Google ETA, not SIRI). */
export async function fetchBusEtaWatch(input: {
  origin: string;
  destination: string;
  line: string;
  headsign?: string;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
  now?: Date;
}): Promise<BusEtaWatchResult> {
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
      ok: true,
      minutes: facts.etaMinutes,
      fingerprint: fp,
      leaveByText: facts.leaveByText,
    };
  } catch {
    return { ok: false, minutes: null, fingerprint: "", leaveByText: "" };
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
  snapshot?: Pick<EmployeeRecordSnapshot, "lists" | "filing"> | null;
  contacts?: SavedLocationContactRef[] | null;
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
    let lat: number | null | undefined;
    let lng: number | null | undefined;
    let placeLabel = "";

    const originResolved = await resolveRoutesEndpoint({
      label: originRaw,
      pinLat: input.originLat,
      pinLng: input.originLng,
      snapshot: input.snapshot,
      contacts: input.contacts,
      fetchImpl: input.fetchImpl,
      apiKey: input.apiKey,
      speakerMissingPinAsk:
        "שלח מיקום בוואטסאפ (סיכת מיקום) ואז אמצא תחנה קרובה לקו.",
      onGeocodeEmpty: "ask",
    });
    if (originResolved.kind === "ask") {
      return { text: originResolved.text, navigateAddress: "" };
    }
    if (originResolved.kind === "coords") {
      lat = originResolved.lat;
      lng = originResolved.lng;
      if (originResolved.source !== "pin") {
        placeLabel = originResolved.label;
      }
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
      destination: input.destination,
      line,
      agency,
      headsign,
      serviceDate,
      departure: input.departure,
      windowEnd: input.windowEnd,
      fetchImpl: input.fetchImpl,
      apiKey: input.apiKey,
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
  destination?: string;
  line: string;
  agency: string;
  headsign: string;
  serviceDate: string;
  departure?: string;
  windowEnd?: string;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
}): Promise<{ text: string; navigateAddress: string }> {
  const rawRef = input.stopCode || String(input.origin ?? "").trim();
  if (!rawRef) {
    return {
      text: "לאיזו תחנה? צריך קוד תחנה או שם תחנה לתחזית זמן אמת.",
      navigateAddress: "",
    };
  }

  /** Google ETA labeled as estimate when MOT stop_code cannot be resolved. */
  const googleEtaFallback = async (
    whyHe: string,
  ): Promise<{ text: string; navigateAddress: string } | null> => {
    const dest =
      String(input.destination ?? "").trim() ||
      String(input.headsign ?? "").trim();
    if (!input.line.trim() || !dest || /^\d{1,2}$/.test(dest)) {
      return null;
    }
    try {
      const facts = await fetchRoutesFacts({
        origin: rawRef,
        destination: dest,
        line: input.line,
        headsign: /^\d{1,2}$/.test(input.headsign) ? "" : input.headsign,
        aspects: ["eta"],
        departure: input.departure,
        fetchImpl: input.fetchImpl,
        apiKey: input.apiKey,
      });
      if (facts.lineMatchFailed || facts.etaMinutes == null) {
        return null;
      }
      return {
        text: [
          whyHe,
          ROUTES_GOOGLE_ETA_NOT_SIRI_INTRO_HE,
          formatRoutesHebrew(facts),
          "לתחזית חיה רשמית של משרד התחבורה צריך קוד תחנה (מספר).",
        ].join("\n"),
        navigateAddress: "",
      };
    } catch {
      return null;
    }
  };

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
          const fallback = await googleEtaFallback(resolved.messageHe);
          if (fallback) return fallback;
          return { text: resolved.messageHe, navigateAddress: "" };
        }
      } else {
        code = resolved.match.stopCode;
      }
    } else if (!/^\d{3,}$/.test(rawRef)) {
      const why =
        "לתחזית חיה צריך קוד תחנה רשמי (או לוח GTFS פעיל לזיהוי שם תחנה).";
      const fallback = await googleEtaFallback(why);
      if (fallback) return fallback;
      return { text: why, navigateAddress: "" };
    }
  } else if (!/^\d{3,}$/.test(rawRef)) {
    const why = "לתחזית חיה צריך קוד תחנה רשמי (מספר).";
    const fallback = await googleEtaFallback(why);
    if (fallback) return fallback;
    return { text: why, navigateAddress: "" };
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
            ROUTES_SCHEDULE_NOT_LIVE_INTRO_HE,
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
          ROUTES_SCHEDULE_NOT_LIVE_INTRO_HE,
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
  /** Only closest_board; omit keeps default leave→walk ranking. */
  prefer?: RoutesPrefer | string | null;
  originLat?: number | null;
  originLng?: number | null;
  /** Speaker saved lists/filings — resolve named origin/destination to coords. */
  snapshot?: Pick<EmployeeRecordSnapshot, "lists" | "filing"> | null;
  /** SPEAKER_CONTACTS — resolve contact name → coords from description. */
  contacts?: SavedLocationContactRef[] | null;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
  requireLiveSelect?: boolean;
  speakerAsk?: string;
  billing?: ComposeLlmBilling | null;
  runSelect?: typeof runLivePostSelect;
}): Promise<ResolveRoutesResult> {
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
    // Do not attach/replace lastRoutesBoard (trip board is Google A→B only).
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
      snapshot: input.snapshot,
      contacts: input.contacts,
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
    // Explicit live-pin request — never silently fall back to a saved place.
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
  const savedNotices: string[] = [];
  const lineFocus =
    Boolean(String(input.line ?? "").trim() || String(input.headsign ?? "").trim()) &&
    (aspects.includes("eta") || aspects.includes("frequency"));

  // Shared endpoint ladder (speaker+pin / SRP / address-like ASK / geocode).
  // Speaker without pin already returned above; pin coords stay when speaker.
  if (origin) {
    const originResolved = await resolveRoutesEndpoint({
      label: origin,
      pinLat: speakerOrigin ? input.originLat : null,
      pinLng: speakerOrigin ? input.originLng : null,
      snapshot: input.snapshot,
      contacts: input.contacts,
      fetchImpl: input.fetchImpl,
      apiKey: input.apiKey,
      speakerMissingPinAsk:
        "שלח מיקום בוואטסאפ (סיכת מיקום) ואז אגיד איך להגיע מכאן.",
      onGeocodeEmpty: "continue",
    });
    if (originResolved.kind === "ask") {
      return { text: originResolved.text, navigateAddress: "" };
    }
    if (originResolved.kind === "coords") {
      originLat = originResolved.lat;
      originLng = originResolved.lng;
      if (originResolved.source === "saved") {
        originLabel = originResolved.label;
        if (originResolved.savedNotice) {
          savedNotices.push(originResolved.savedNotice);
        }
      } else if (originResolved.source === "geocode" && !lineFocus) {
        // Keep spoken origin for line-ETA boarding-stop token match.
        originLabel = originResolved.label;
      }
      // pin: leave originLabel unset (display maps "speaker" elsewhere).
    }
    // unresolved / none → keep Google address string (existing trip path).
  }

  if (destination) {
    const destResolved = await resolveRoutesEndpoint({
      label: destination,
      snapshot: input.snapshot,
      contacts: input.contacts,
      fetchImpl: input.fetchImpl,
      apiKey: input.apiKey,
      speakerMissingPinAsk:
        "שלח מיקום בוואטסאפ (סיכת מיקום) ואז אגיד איך להגיע מכאן.",
      onGeocodeEmpty: "continue",
    });
    if (destResolved.kind === "ask") {
      return { text: destResolved.text, navigateAddress: "" };
    }
    if (destResolved.kind === "coords") {
      destinationLat = destResolved.lat;
      destinationLng = destResolved.lng;
      if (destResolved.source === "saved") {
        destinationLabel = destResolved.label;
        if (destResolved.savedNotice) {
          savedNotices.push(destResolved.savedNotice);
        }
      } else if (destResolved.source === "geocode") {
        destinationLabel = destResolved.label;
      }
    }
  }

  try {
    const facts = await fetchRoutesFacts({
      ...input,
      origin: originLabel || origin || "speaker",
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
    const body = `${googleText}${officialExtra}`.trim();
    const preface =
      savedNotices.length > 0 ? `${savedNotices.join("\n")}\n` : "";
    const boardItineraries =
      selectedFacts.itineraries.length > 0
        ? selectedFacts.itineraries
        : selectedFacts.steps.length > 0
          ? [
              {
                durationText: selectedFacts.durationText,
                durationSeconds: selectedFacts.durationSeconds,
                distanceMeters: selectedFacts.distanceMeters,
                fareText: selectedFacts.fareText,
                leaveByText: selectedFacts.leaveByText,
                arriveByText: selectedFacts.arriveByText,
                steps: selectedFacts.steps,
              },
            ]
          : [];
    const board = buildLastRoutesBoard({
      origin: String(originLabel || origin || "").trim(),
      destination: String(destinationLabel || destination || "").trim(),
      mode: travelMode,
      itineraries: boardItineraries,
    });
    const choiceButtons = buildRoutesChoiceButtons(
      board?.itineraries.length ?? 0,
    );
    return {
      text: `${preface}${body}`.trim(),
      navigateAddress: selectedFacts.navigateAddress || facts.navigateAddress,
      ...(board ? { board } : {}),
      ...(choiceButtons.length > 0 ? { choiceButtons } : {}),
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
        text: `לא מצאתי מסלול בתחבורה ציבורית מ«${speakerOrigin ? "המיקום שלך" : originLabel || origin}» ל«${destinationLabel || destination}».`,
        navigateAddress: "",
      };
    }
    // Points were resolved; Google/network failed — not a missing-place ask.
    // Failed search must not overwrite a prior lastRoutesBoard.
    return {
      text: "לא הצלחתי לחשב מסלול עכשיו. נסה שוב בעוד רגע.",
      navigateAddress: "",
    };
  }
}

/** Compact parse of a persisted board (ignore junk / oversized provider blobs). */
export function parseLastRoutesBoard(raw: unknown): LastRoutesBoard | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const origin = typeof row.origin === "string" ? row.origin.trim() : "";
  const destination =
    typeof row.destination === "string" ? row.destination.trim() : "";
  const modeRaw = String(row.mode ?? "")
    .trim()
    .toLowerCase();
  const mode: RoutesTravelMode = modeRaw === "drive" ? "drive" : "transit";
  const fetchedAt =
    typeof row.fetchedAt === "string" && row.fetchedAt.trim()
      ? row.fetchedAt.trim()
      : typeof row.fetched_at === "string" && row.fetched_at.trim()
        ? row.fetched_at.trim()
        : "";
  if (!Array.isArray(row.itineraries)) {
    return null;
  }
  const itineraries: RouteItineraryOption[] = [];
  for (const entry of row.itineraries.slice(0, ROUTES_ITINERARY_DISPLAY_CAP)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const opt = entry as Record<string, unknown>;
    const stepsRaw = Array.isArray(opt.steps) ? opt.steps : [];
    const steps: RouteStepFact[] = [];
    for (const stepEntry of stepsRaw.slice(0, ROUTES_STEPS_DETAIL_DISPLAY_CAP)) {
      if (
        !stepEntry ||
        typeof stepEntry !== "object" ||
        Array.isArray(stepEntry)
      ) {
        continue;
      }
      const s = stepEntry as Record<string, unknown>;
      steps.push({
        travelMode: typeof s.travelMode === "string" ? s.travelMode : "",
        instruction: typeof s.instruction === "string" ? s.instruction : "",
        line: typeof s.line === "string" ? s.line : "",
        headsign: typeof s.headsign === "string" ? s.headsign : "",
        fromStop: typeof s.fromStop === "string" ? s.fromStop : "",
        toStop: typeof s.toStop === "string" ? s.toStop : "",
        departureTime:
          typeof s.departureTime === "string" ? s.departureTime : "",
        departureIso:
          typeof s.departureIso === "string" ? s.departureIso : "",
        arrivalTime: typeof s.arrivalTime === "string" ? s.arrivalTime : "",
        durationText:
          typeof s.durationText === "string" ? s.durationText : "",
        durationSeconds:
          typeof s.durationSeconds === "number" &&
          Number.isFinite(s.durationSeconds)
            ? s.durationSeconds
            : null,
        headwaySeconds:
          typeof s.headwaySeconds === "number" &&
          Number.isFinite(s.headwaySeconds)
            ? s.headwaySeconds
            : null,
      });
    }
    itineraries.push({
      durationText: typeof opt.durationText === "string" ? opt.durationText : "",
      durationSeconds:
        typeof opt.durationSeconds === "number" &&
        Number.isFinite(opt.durationSeconds)
          ? opt.durationSeconds
          : null,
      distanceMeters:
        typeof opt.distanceMeters === "number" &&
        Number.isFinite(opt.distanceMeters)
          ? opt.distanceMeters
          : null,
      fareText: typeof opt.fareText === "string" ? opt.fareText : "",
      leaveByText: typeof opt.leaveByText === "string" ? opt.leaveByText : "",
      arriveByText: typeof opt.arriveByText === "string" ? opt.arriveByText : "",
      ...(opt.leaveIsBoarding === true ? { leaveIsBoarding: true } : {}),
      steps,
    });
  }
  if (itineraries.length === 0) {
    return null;
  }
  return {
    origin,
    destination,
    mode,
    itineraries,
    fetchedAt: fetchedAt || new Date(0).toISOString(),
  };
}
