/**
 * Live public-transit A→B via Google Routes API (travelMode TRANSIT),
 * plus stop-board lines via Places API transitStation.
 * Model→Action→Engine: engine formats API facts; never invents times/lines.
 * Google-only — not MOT GTFS/SIRI.
 */
import { getEnv } from "../config/env.js";

export type RoutesAspect =
  | "summary"
  | "duration"
  | "steps"
  | "fare"
  | "eta"
  | "frequency"
  | "lines";

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
  /** Expected seconds between departures (Google headway). */
  headwaySeconds: number | null;
};

export type RoutesFacts = {
  origin: string;
  destination: string;
  departure: string;
  arrival: string;
  line: string;
  headsign: string;
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

export const ROUTES_API_KEY_MISSING = "routes_api_key_missing";
export const ROUTES_API_DENIED = "routes_api_denied";
export const ROUTES_ZERO_RESULTS = "routes_zero_results";

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
    durationText: formatDurationHe(parseDurationSeconds(step.staticDuration)),
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
  originLat?: number | null;
  originLng?: number | null;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
  now?: Date;
}): Promise<RoutesFacts> {
  const originRaw = String(input.origin ?? "").trim();
  const destination = String(input.destination ?? "").trim();
  const departure = String(input.departure ?? "").trim();
  const arrival = String(input.arrival ?? "").trim();
  const line = String(input.line ?? "")
    .replace(/^קו\s+/u, "")
    .trim();
  const headsign = String(input.headsign ?? "").trim();
  const aspects = parseRoutesAspects(input.aspects);
  const now = input.now ?? new Date();
  const originLabel =
    originRaw.toLowerCase() === "speaker" ? "המיקום שלך" : originRaw;
  const filterSet = Boolean(line || headsign);
  const lineEtaAsk =
    filterSet &&
    (aspects.includes("eta") || aspects.includes("frequency"));
  const facts: RoutesFacts = {
    origin: originLabel,
    destination,
    departure,
    arrival,
    line,
    headsign,
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
    navigateAddress: destination,
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

  const hasSpeakerPin =
    originRaw.toLowerCase() === "speaker" &&
    input.originLat != null &&
    input.originLng != null &&
    Number.isFinite(input.originLat) &&
    Number.isFinite(input.originLng);
  if (!destination || (!originRaw && !hasSpeakerPin)) {
    return facts;
  }

  const apiKey = resolveRoutesApiKey(input.apiKey);
  if (!apiKey) {
    throw new Error(ROUTES_API_KEY_MISSING);
  }

  const originWaypoint = hasSpeakerPin
    ? {
        location: {
          latLng: {
            latitude: input.originLat,
            longitude: input.originLng,
          },
        },
      }
    : { address: originRaw };

  const body: Record<string, unknown> = {
    origin: originWaypoint,
    destination: { address: destination },
    travelMode: "TRANSIT",
    languageCode: "he-IL",
    regionCode: "IL",
    units: "METRIC",
    computeAlternativeRoutes: lineEtaAsk,
  };
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
  facts.durationSeconds = parseDurationSeconds(route.duration);
  facts.durationText =
    String(route.localizedValues?.duration?.text ?? "").trim() ||
    formatDurationHe(facts.durationSeconds);
  facts.distanceMeters =
    typeof route.distanceMeters === "number" ? route.distanceMeters : null;
  facts.fareText = fareTextFromAdvisory(route);
  facts.steps = (route.legs ?? [])
    .flatMap((leg) => (Array.isArray(leg.steps) ? leg.steps : []))
    .map(mapStep);

  const allSteps = lineEtaAsk
    ? routes.flatMap((r) =>
        (r.legs ?? [])
          .flatMap((leg) => (Array.isArray(leg.steps) ? leg.steps : []))
          .map(mapStep),
      )
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

  const firstTransit =
    focus ??
    (filterSet
      ? undefined
      : facts.steps.find(
          (s) => s.travelMode === "TRANSIT" && s.departureTime,
        ));
  const lastArrival = [...facts.steps]
    .reverse()
    .find((s) => s.arrivalTime);
  if (arrivalRfc && facts.durationSeconds != null) {
    const leaveMs =
      new Date(arrivalRfc).getTime() - facts.durationSeconds * 1000;
    facts.leaveByText = formatHmJerusalem(new Date(leaveMs).toISOString());
  } else if (firstTransit?.departureTime) {
    facts.leaveByText = firstTransit.departureTime;
  }
  if (lastArrival?.arrivalTime) {
    facts.arriveByText = lastArrival.arrivalTime;
  } else if (departureRfc && facts.durationSeconds != null) {
    const arriveMs =
      new Date(departureRfc).getTime() + facts.durationSeconds * 1000;
    facts.arriveByText = formatHmJerusalem(new Date(arriveMs).toISOString());
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
  if (facts.steps.length === 0 && !facts.durationText && !facts.lineMatchFailed) {
    return `לא מצאתי מסלול בתחבורה ציבורית מ«${facts.origin}» ל«${facts.destination}».`;
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

  const lines: string[] = [];
  const arriveAsk = Boolean(facts.arrival.trim());
  if (arriveAsk && facts.leaveByText) {
    const arriveLabel = displayClockLabel(facts.arrival);
    lines.push(
      `כדי להגיע ל«${facts.destination}» עד ${arriveLabel}, צא בסביבות *${facts.leaveByText}* מ«${facts.origin}».`,
    );
  } else {
    lines.push(
      `מסלול בתחבורה ציבורית מ«${facts.origin}» ל«${facts.destination}»:`,
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
    const max = facts.aspects.includes("steps") ? 12 : 8;
    facts.steps.slice(0, max).forEach((step, i) => {
      lines.push(formatStepLine(step, i));
    });
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

export async function resolveRoutesReply(input: {
  origin: string;
  destination: string;
  departure?: string;
  arrival?: string;
  line?: string;
  headsign?: string;
  aspects?: RoutesAspect[] | unknown;
  originLat?: number | null;
  originLng?: number | null;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
}): Promise<{ text: string; navigateAddress: string }> {
  const origin = String(input.origin ?? "").trim();
  const destination = String(input.destination ?? "").trim();
  const aspects = parseRoutesAspects(input.aspects);
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
      return {
        text: formatRoutesHebrew(facts),
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
  try {
    const facts = await fetchRoutesFacts({
      ...input,
      origin: origin || "speaker",
    });
    return {
      text: formatRoutesHebrew(facts),
      navigateAddress: facts.navigateAddress,
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
