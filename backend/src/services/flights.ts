/**
 * Live airport departures/arrivals via AviationStack.
 * Model→Action→Engine: engine formats API facts; never invents times/gates.
 * Default hub: TLV (נתב״ג).
 */
import { createHash } from "node:crypto";
import {
  flightsClockHmToMinutes,
  normalizeFlightsClockHm,
} from "@workee/shared";
import { getEnv } from "../config/env.js";
import type { ComposeLlmBilling } from "./llm-usage.service.js";
import {
  formatLiveSelectFailureReply,
  LIVE_SELECT_NO_MATCH_HE,
  runLivePostSelect,
  type LiveRetrievalRecord,
  type LiveSelectApplyResult,
} from "./live-retrieval-select.js";
import {
  emptyRetrievalStats,
  isLocallyTruncated,
  type RetrievalStats,
} from "./retrieval-window.js";

export const DEFAULT_FLIGHT_AIRPORT = "TLV";

/** Board lines shown in Hebrew (after fetch/filter/sort). */
export const FLIGHTS_DISPLAY_CAP = 12;

/** Known local display truncation — not a provider claim. */
export const FLIGHTS_LOCAL_TRUNCATION_HE =
  "(מוצגות עד 12 טיסות — יש עוד בתוצאות שלא הוצגו בגלל מגבלת תצוגה.)";

/**
 * Saturated AviationStack page — potential incompleteness only.
 * Does not prove additional matching flights exist.
 */
export const FLIGHTS_PROVIDER_PARTIAL_HE =
  "(ייתכן שהלוח חלקי — התקבלה תשובה בגודל מגבלת הספק, ולא ניתן לדעת אם יש עוד טיסות.)";

export type FlightsDirection = "arrivals" | "departures" | "both";

export type FlightsAspect =
  | "summary"
  | "board"
  | "next"
  | "status"
  | "gate"
  | "delay";

export type FlightRow = {
  /** Opaque stable id for post-retrieval live_select (minted at map time). */
  liveRecordId: string;
  flightIata: string;
  flightNumber: string;
  airlineName: string;
  airlineIata: string;
  /** Other airport IATA (dest for dep, origin for arr). */
  otherIata: string;
  otherAirportName: string;
  scheduledIso: string;
  estimatedIso: string;
  status: string;
  gate: string;
  terminal: string;
  delayMinutes: number | null;
  direction: "arrivals" | "departures";
};

/**
 * Completeness for board replies. Uses shared RetrievalStats fields where they
 * fit; undated/invalid/outOfRange stay unused (flight rows are timed events).
 */
export type FlightsCompleteness = Pick<
  RetrievalStats,
  "matched" | "truncated" | "providerPartial"
>;

export type FlightsFacts = {
  airport: string;
  direction: FlightsDirection;
  airline: string;
  airlines: string[];
  city: string;
  flight: string;
  date: string;
  withinMinutes: number | null;
  /** Inclusive Jerusalem HH:mm lower bound (empty = none). */
  timeFrom: string;
  /** Inclusive Jerusalem HH:mm upper bound (empty = none). */
  timeTo: string;
  aspects: FlightsAspect[];
  rows: FlightRow[];
  /** Board completeness; omit for single-flight / next views. */
  completeness?: FlightsCompleteness;
};

export type FlightsBoardResult = {
  rows: FlightRow[];
  /** Requested AviationStack `limit` per direction. */
  providerLimit: number;
  /**
   * True when any direction's raw API page length reached `providerLimit`
   * (before client-side date/window filters). Potential incompleteness only.
   */
  providerLimitSaturated: boolean;
};

export type FlightEtaWatchResult = {
  /** Minutes until scheduled/estimated event (arrival or departure). */
  minutesUntil: number | null;
  fingerprint: string;
  /** Hebrew one-liner when within window. */
  summary: string;
  row: FlightRow | null;
};

export type FlightChangedWatchResult = {
  fingerprint: string;
  summary: string;
  row: FlightRow | null;
};

const ASPECT_SET = new Set<FlightsAspect>([
  "summary",
  "board",
  "next",
  "status",
  "gate",
  "delay",
]);

const FLIGHTS_URL = "https://api.aviationstack.com/v1/flights";

/** Best-effort Hebrew/English city → primary IATA (common IL routes). */
const CITY_IATA: Record<string, string> = {
  "תל אביב": "TLV",
  "תל-אביב": "TLV",
  תלאביב: "TLV",
  נתבג: "TLV",
  'נתב"ג': "TLV",
  "נתב״ג": "TLV",
  tlv: "TLV",
  "ben gurion": "TLV",
  "בן גוריון": "TLV",
  פריז: "CDG",
  paris: "CDG",
  cdg: "CDG",
  ory: "ORY",
  רומא: "FCO",
  rome: "FCO",
  fco: "FCO",
  cia: "CIA",
  מילאנו: "MXP",
  milano: "MXP",
  milan: "MXP",
  mxp: "MXP",
  לונדון: "LHR",
  london: "LHR",
  lhr: "LHR",
  lgw: "LGW",
  stn: "STN",
  ניוyork: "JFK",
  "ניו יורק": "JFK",
  "new york": "JFK",
  jfk: "JFK",
  ewr: "EWR",
  lga: "LGA",
  ברלין: "BER",
  berlin: "BER",
  ber: "BER",
  מינכן: "MUC",
  munich: "MUC",
  muc: "MUC",
  פרנקפורט: "FRA",
  frankfurt: "FRA",
  fra: "FRA",
  אמסטרדם: "AMS",
  amsterdam: "AMS",
  ams: "AMS",
  מדריד: "MAD",
  madrid: "MAD",
  mad: "MAD",
  ברצלונה: "BCN",
  barcelona: "BCN",
  bcn: "BCN",
  אתונה: "ATH",
  athens: "ATH",
  ath: "ATH",
  איסטנבול: "IST",
  istanbul: "IST",
  ist: "IST",
  דובאי: "DXB",
  dubai: "DXB",
  dxb: "DXB",
  "אבו דאבי": "AUH",
  "abu dhabi": "AUH",
  auh: "AUH",
  לרנקה: "LCA",
  larnaca: "LCA",
  lca: "LCA",
  פאפוס: "PFO",
  paphos: "PFO",
  pfo: "PFO",
  וינה: "VIE",
  vienna: "VIE",
  vie: "VIE",
  ציריך: "ZRH",
  zurich: "ZRH",
  zrh: "ZRH",
  "ז'נבה": "GVA",
  "ז׳נבה": "GVA",
  geneva: "GVA",
  gva: "GVA",
  בודפשט: "BUD",
  budapest: "BUD",
  bud: "BUD",
  פראג: "PRG",
  prague: "PRG",
  prg: "PRG",
  ורשה: "WAW",
  warsaw: "WAW",
  waw: "WAW",
  בוקרשט: "OTP",
  bucharest: "OTP",
  otp: "OTP",
  סופיה: "SOF",
  sofia: "SOF",
  sof: "SOF",
  בנגקוק: "BKK",
  bangkok: "BKK",
  bkk: "BKK",
  "הונג קונג": "HKG",
  "hong kong": "HKG",
  hkg: "HKG",
  טוקיו: "NRT",
  tokyo: "NRT",
  nrt: "NRT",
  hnd: "HND",
  "לוס אנג'לס": "LAX",
  "לוס אנג׳לס": "LAX",
  "los angeles": "LAX",
  lax: "LAX",
  מיאמי: "MIA",
  miami: "MIA",
  mia: "MIA",
  טורונטו: "YYZ",
  toronto: "YYZ",
  yyz: "YYZ",
  מוסקבה: "SVO",
  moscow: "SVO",
  svo: "SVO",
  באטומי: "BUS",
  batumi: "BUS",
  bus: "BUS",
  טביליסי: "TBS",
  tbilisi: "TBS",
  tbs: "TBS",
  איילת: "ETH",
  eilat: "ETH",
  eth: "ETH",
  vda: "VDA",
  חיפה: "HFA",
  haifa: "HFA",
  hfa: "HFA",
};

const AIRLINE_IATA: Record<string, string> = {
  "אל על": "LY",
  elal: "LY",
  "el al": "LY",
  ly: "LY",
  arkia: "IZ",
  ארקיע: "IZ",
  israir: "6H",
  ישראייר: "6H",
  "british airways": "BA",
  ba: "BA",
  lufthansa: "LH",
  lh: "LH",
  airfrance: "AF",
  "air france": "AF",
  af: "AF",
  easyjet: "U2",
  wizz: "W6",
  "wizz air": "W6",
};

export class FlightsApiKeyMissingError extends Error {
  constructor() {
    super("AVIATIONSTACK_ACCESS_KEY is not configured");
    this.name = "FlightsApiKeyMissingError";
  }
}

function accessKey(override?: string | null): string {
  const key =
    (override !== undefined && override !== null
      ? override
      : getEnv().AVIATIONSTACK_ACCESS_KEY ?? ""
    ).trim();
  if (!key) {
    throw new FlightsApiKeyMissingError();
  }
  return key;
}

export function normalizeAirportCode(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return DEFAULT_FLIGHT_AIRPORT;
  }
  const lower = trimmed.toLowerCase().replace(/\s+/g, " ");
  if (CITY_IATA[lower]) {
    return CITY_IATA[lower];
  }
  if (CITY_IATA[trimmed]) {
    return CITY_IATA[trimmed];
  }
  const compact = lower.replace(/[\s"״"']/g, "");
  if (CITY_IATA[compact]) {
    return CITY_IATA[compact];
  }
  if (/^[A-Za-z]{3}$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  return trimmed.slice(0, 8).toUpperCase();
}

export function resolveCityIata(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const lower = trimmed.toLowerCase().replace(/\s+/g, " ");
  if (CITY_IATA[lower]) {
    return CITY_IATA[lower];
  }
  if (CITY_IATA[trimmed]) {
    return CITY_IATA[trimmed];
  }
  if (/^[A-Za-z]{3}$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  return "";
}

export function resolveAirlineIata(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const lower = trimmed.toLowerCase().replace(/\s+/g, " ");
  if (AIRLINE_IATA[lower]) {
    return AIRLINE_IATA[lower];
  }
  if (AIRLINE_IATA[trimmed]) {
    return AIRLINE_IATA[trimmed];
  }
  if (/^[A-Za-z0-9]{2}$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  return "";
}

/** Strip spaces; keep alnum for flight_iata / number matching. */
export function normalizeFlightCode(raw: string): string {
  return raw.trim().replace(/\s+/g, "").toUpperCase();
}

export function parseFlightsAspects(raw: unknown): FlightsAspect[] {
  if (!Array.isArray(raw)) {
    if (typeof raw === "string" && raw.trim()) {
      return parseFlightsAspects(raw.split(/[,;|]+/));
    }
    return ["summary"];
  }
  const out: FlightsAspect[] = [];
  for (const entry of raw) {
    const key = String(entry ?? "")
      .trim()
      .toLowerCase() as FlightsAspect;
    if (ASPECT_SET.has(key) && !out.includes(key)) {
      out.push(key);
    }
  }
  return out.length > 0 ? out : ["summary"];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function nestedNumber(
  parent: Record<string, unknown> | null,
  key: string,
  field: string,
): number | null {
  const child = asRecord(parent?.[key] ?? null);
  const raw = child?.[field];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim())) {
    return Number(raw.trim());
  }
  return null;
}

export function mintFlightLiveRecordId(
  row: Omit<FlightRow, "liveRecordId">,
  airport: string,
): string {
  const raw = [
    airport,
    row.direction,
    row.flightIata,
    row.scheduledIso,
    row.otherIata,
    row.gate,
  ].join("|");
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 24);
}

function mapApiFlight(
  entry: unknown,
  direction: "arrivals" | "departures",
  airport: string,
): FlightRow | null {
  const row = asRecord(entry);
  if (!row) {
    return null;
  }
  const airline = asRecord(row.airline);
  const flight = asRecord(row.flight);
  const departure = asRecord(row.departure);
  const arrival = asRecord(row.arrival);
  const leg = direction === "departures" ? departure : arrival;
  const other = direction === "departures" ? arrival : departure;
  const flightIata = String(flight?.iata ?? "").trim().toUpperCase();
  const flightNumber = String(flight?.number ?? flightIata).trim();
  const scheduled = String(leg?.scheduled ?? "").trim();
  if (!scheduled && !flightIata && !flightNumber) {
    return null;
  }
  const base: Omit<FlightRow, "liveRecordId"> = {
    flightIata: flightIata || flightNumber,
    flightNumber,
    airlineName: String(airline?.name ?? "").trim(),
    airlineIata: String(airline?.iata ?? "").trim().toUpperCase(),
    otherIata: String(other?.iata ?? "").trim().toUpperCase(),
    otherAirportName: String(other?.airport ?? "").trim(),
    scheduledIso: scheduled,
    estimatedIso: String(leg?.estimated ?? leg?.actual ?? scheduled).trim(),
    status: String(row.flight_status ?? "").trim().toLowerCase(),
    gate: String(leg?.gate ?? "").trim(),
    terminal: String(leg?.terminal ?? "").trim(),
    delayMinutes: nestedNumber(row, direction === "departures" ? "departure" : "arrival", "delay"),
    direction,
  };
  return {
    ...base,
    liveRecordId: mintFlightLiveRecordId(base, airport),
  };
}

function flightMatchesCode(row: FlightRow, code: string): boolean {
  const want = normalizeFlightCode(code);
  if (!want) {
    return true;
  }
  const iata = normalizeFlightCode(row.flightIata);
  const num = normalizeFlightCode(row.flightNumber);
  const airlineNum = normalizeFlightCode(`${row.airlineIata}${row.flightNumber}`);
  return (
    iata === want ||
    num === want ||
    airlineNum === want ||
    iata.endsWith(want) ||
    want.endsWith(num) ||
    iata.includes(want) ||
    want.includes(iata)
  );
}

function flightMatchesAirline(row: FlightRow, airline: string): boolean {
  const raw = airline.trim();
  if (!raw) {
    return true;
  }
  const iata = resolveAirlineIata(raw);
  if (iata && row.airlineIata === iata) {
    return true;
  }
  const lower = raw.toLowerCase();
  return (
    row.airlineName.toLowerCase().includes(lower) ||
    row.airlineIata.toLowerCase() === lower
  );
}

/** OR-match against airline + airlines[]; empty list → keep all. */
export function flightMatchesAirlineSet(
  row: FlightRow,
  airlines: string[],
): boolean {
  const list = airlines.map((a) => a.trim()).filter(Boolean);
  if (list.length === 0) {
    return true;
  }
  return list.some((entry) => flightMatchesAirline(row, entry));
}

/** Jerusalem HH:mm of estimated/scheduled ISO. */
export function flightClockHm(row: FlightRow): string {
  const iso = row.estimatedIso || row.scheduledIso;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return "";
  }
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

/**
 * Inclusive Jerusalem clock window. Only from → hm >= from; only to → hm <= to;
 * both → from <= hm <= to (no overnight wrap).
 */
export function flightMatchesClockWindow(
  row: FlightRow,
  timeFrom: string,
  timeTo: string,
): boolean {
  const from = normalizeFlightsClockHm(timeFrom) ?? "";
  const to = normalizeFlightsClockHm(timeTo) ?? "";
  if (!from && !to) {
    return true;
  }
  const hm = normalizeFlightsClockHm(flightClockHm(row)) ?? "";
  if (!hm) {
    return false;
  }
  const mins = flightsClockHmToMinutes(hm);
  if (mins < 0) {
    return false;
  }
  if (from) {
    const fromMins = flightsClockHmToMinutes(from);
    if (fromMins >= 0 && mins < fromMins) {
      return false;
    }
  }
  if (to) {
    const toMins = flightsClockHmToMinutes(to);
    if (toMins >= 0 && mins > toMins) {
      return false;
    }
  }
  return true;
}

function flightMatchesCity(row: FlightRow, city: string): boolean {
  const raw = city.trim();
  if (!raw) {
    return true;
  }
  const iata = resolveCityIata(raw);
  if (iata && row.otherIata === iata) {
    return true;
  }
  const lower = raw.toLowerCase();
  return (
    row.otherAirportName.toLowerCase().includes(lower) ||
    row.otherIata.toLowerCase() === lower
  );
}

export class FlightsApiError extends Error {
  code: string;
  constructor(message: string, code = "") {
    super(message);
    this.name = "FlightsApiError";
    this.code = code;
  }
}

async function aviationstackGet(
  params: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
  apiKey?: string | null,
): Promise<unknown[]> {
  const key = accessKey(apiKey);
  const url = new URL(FLIGHTS_URL);
  url.searchParams.set("access_key", key);
  for (const [k, v] of Object.entries(params)) {
    if (v) {
      url.searchParams.set(k, v);
    }
  }
  const res = await fetchImpl(url.toString(), {
    headers: { Accept: "application/json" },
  });
  let body: {
    data?: unknown;
    error?: { message?: string; code?: string };
  } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new FlightsApiError(`AviationStack HTTP ${res.status}`);
  }
  if (body.error?.message) {
    throw new FlightsApiError(
      body.error.message,
      String(body.error.code ?? ""),
    );
  }
  if (!res.ok) {
    throw new FlightsApiError(`AviationStack HTTP ${res.status}`);
  }
  return Array.isArray(body.data) ? body.data : [];
}

/** Jerusalem calendar YYYY-MM-DD for an ISO timestamp. */
export function jerusalemDateKey(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return "";
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

export async function fetchFlightsBoard(input: {
  airport?: string;
  direction?: FlightsDirection | string;
  airline?: string;
  airlines?: string[] | null;
  city?: string;
  flight?: string;
  date?: string;
  /** Keep only flights with ETA/STA within this many minutes from now. */
  withinMinutes?: number | null;
  timeFrom?: string | null;
  timeTo?: string | null;
  limit?: number;
  now?: Date;
  fetchImpl?: typeof fetch;
  /** Override env key (empty string → missing-key error). */
  apiKey?: string | null;
}): Promise<FlightsBoardResult> {
  const airport = normalizeAirportCode(input.airport ?? "");
  const directionRaw = String(input.direction ?? "both")
    .trim()
    .toLowerCase();
  const direction: FlightsDirection =
    directionRaw === "arrivals" || directionRaw === "arrival"
      ? "arrivals"
      : directionRaw === "departures" || directionRaw === "departure"
        ? "departures"
        : "both";
  const airline = String(input.airline ?? "").trim();
  const airlines = [
    ...new Set(
      [...(Array.isArray(input.airlines) ? input.airlines : []), airline]
        .map((a) => String(a ?? "").trim())
        .filter(Boolean),
    ),
  ];
  const city = String(input.city ?? "").trim();
  const flight = normalizeFlightCode(String(input.flight ?? ""));
  // Free AviationStack rejects flight_date — always filter client-side.
  const date = String(input.date ?? "").trim();
  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
  const withinMinutes =
    typeof input.withinMinutes === "number" &&
    Number.isFinite(input.withinMinutes) &&
    input.withinMinutes > 0
      ? Math.min(Math.round(input.withinMinutes), 24 * 60)
      : null;
  const timeFrom = normalizeFlightsClockHm(input.timeFrom) ?? "";
  const timeTo = normalizeFlightsClockHm(input.timeTo) ?? "";
  const now = input.now ?? new Date();
  const wantWidePage =
    withinMinutes != null ||
    Boolean(timeFrom || timeTo) ||
    airlines.length > 1;
  const limit = Math.min(
    Math.max(input.limit ?? (wantWidePage ? 100 : 40), 1),
    100,
  );
  const fetchImpl = input.fetchImpl ?? fetch;
  const apiKey = input.apiKey;

  const directions: Array<"arrivals" | "departures"> =
    direction === "both" ? ["departures", "arrivals"] : [direction];

  const rows: FlightRow[] = [];
  let providerLimitSaturated = false;
  for (const dir of directions) {
    const params: Record<string, string> = {
      limit: String(limit),
    };
    // Do NOT set flight_date — restricted on free plan (function_access_restricted).
    if (dir === "departures") {
      params.dep_iata = airport;
    } else {
      params.arr_iata = airport;
    }
    // Single known IATA → provider filter; multi-airline OR → client-side only.
    if (airlines.length === 1) {
      const airlineIata = resolveAirlineIata(airlines[0]!);
      if (airlineIata) {
        params.airline_iata = airlineIata;
      }
    }
    if (flight) {
      // Prefer iata when it looks like LY831; else search number loosely after fetch.
      if (/^[A-Z]{2}\d{1,4}[A-Z]?$/i.test(flight)) {
        params.flight_iata = flight;
      } else if (/^\d+$/.test(flight)) {
        params.flight_number = flight;
      }
    }
    const cityIata = resolveCityIata(city);
    if (cityIata) {
      if (dir === "departures") {
        params.arr_iata = cityIata;
      } else {
        params.dep_iata = cityIata;
      }
    }
    const data = await aviationstackGet(params, fetchImpl, apiKey);
    // Saturating the request limit = possible more pages; not proof of more matches.
    if (data.length >= limit) {
      providerLimitSaturated = true;
    }
    for (const entry of data) {
      const mapped = mapApiFlight(entry, dir, airport);
      if (!mapped) {
        continue;
      }
      if (!flightMatchesCode(mapped, flight)) {
        continue;
      }
      if (!flightMatchesAirlineSet(mapped, airlines)) {
        continue;
      }
      if (!flightMatchesCity(mapped, city)) {
        continue;
      }
      if (dateKey) {
        const rowDate = jerusalemDateKey(
          mapped.estimatedIso || mapped.scheduledIso,
        );
        if (rowDate && rowDate !== dateKey) {
          continue;
        }
      }
      rows.push(mapped);
    }
  }

  let filtered = rows;
  if (withinMinutes != null) {
    filtered = rows.filter((row) => {
      const mins = minutesUntilIso(row.estimatedIso || row.scheduledIso, now);
      return mins != null && mins >= -5 && mins <= withinMinutes;
    });
  } else if (!flight) {
    // Prefer still-upcoming legs for a live board (already landed long ago → drop).
    filtered = rows.filter((row) => {
      const mins = minutesUntilIso(row.estimatedIso || row.scheduledIso, now);
      return mins == null || mins >= -30;
    });
  }
  if (timeFrom || timeTo) {
    filtered = filtered.filter((row) =>
      flightMatchesClockWindow(row, timeFrom, timeTo),
    );
  }

  filtered.sort((a, b) => {
    const left = Date.parse(a.estimatedIso || a.scheduledIso) || 0;
    const right = Date.parse(b.estimatedIso || b.scheduledIso) || 0;
    return left - right;
  });
  return {
    rows: filtered,
    providerLimit: limit,
    providerLimitSaturated,
  };
}

/** Build RetrievalStats-shaped completeness for a filtered board. */
export function buildFlightsCompleteness(input: {
  rows: FlightRow[];
  providerLimitSaturated: boolean;
  displayCap?: number;
}): FlightsCompleteness {
  const displayCap = input.displayCap ?? FLIGHTS_DISPLAY_CAP;
  const base = emptyRetrievalStats();
  return {
    matched: input.rows.length,
    truncated: isLocallyTruncated(base, input.rows.length, displayCap),
    providerPartial: input.providerLimitSaturated || undefined,
  };
}

function formatClockHe(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return iso.slice(11, 16) || iso;
  }
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function statusHe(status: string): string {
  switch (status) {
    case "scheduled":
      return "מתוכננת";
    case "active":
      return "באוויר";
    case "landed":
      return "נחתה";
    case "cancelled":
      return "בוטלה";
    case "incident":
      return "תקרית";
    case "diverted":
      return "הוסטה";
    default:
      return status || "לא ידוע";
  }
}

function formatFlightsClockFilterNote(timeFrom: string, timeTo: string): string {
  const from = normalizeFlightsClockHm(timeFrom) ?? "";
  const to = normalizeFlightsClockHm(timeTo) ?? "";
  if (from && to) {
    return `בין ${from} ל־${to}`;
  }
  if (from) {
    return `מ־${from} ואילך`;
  }
  if (to) {
    return `עד ${to}`;
  }
  return "";
}

export function formatOneFlightHe(row: FlightRow): string {
  const code = row.flightIata || row.flightNumber || "?";
  const airline = row.airlineName || row.airlineIata || "";
  const other =
    row.otherAirportName || row.otherIata
      ? `${row.otherAirportName || row.otherIata}${row.otherIata && row.otherAirportName ? ` (${row.otherIata})` : row.otherIata && !row.otherAirportName ? "" : ""}`
      : "?";
  const when = formatClockHe(row.estimatedIso || row.scheduledIso);
  const verb = row.direction === "arrivals" ? "נחיתה" : "המראה";
  const parts = [
    `${airline ? `${airline} ` : ""}${code}`,
    `${verb} ${when}`,
    row.direction === "arrivals" ? `מ־${other}` : `ל־${other}`,
    statusHe(row.status),
  ];
  if (row.gate) {
    parts.push(`שער ${row.gate}`);
  }
  if (row.terminal) {
    parts.push(`טרמינל ${row.terminal}`);
  }
  if (row.delayMinutes != null && row.delayMinutes > 0) {
    parts.push(`עיכוב ${row.delayMinutes} דק׳`);
  }
  return parts.join(" — ");
}

export function formatFlightsHebrew(facts: FlightsFacts): string {
  const airport = facts.airport || DEFAULT_FLIGHT_AIRPORT;
  const clockNote = formatFlightsClockFilterNote(
    facts.timeFrom ?? "",
    facts.timeTo ?? "",
  );
  const airlineNote =
    (facts.airlines?.length ?? 0) > 1
      ? ` (סינון ${facts.airlines.length} חברות)`
      : "";
  if (facts.rows.length === 0) {
    const who = facts.flight
      ? `טיסה ${facts.flight}`
      : facts.airline || facts.city || (facts.airlines?.length ?? 0) > 0
        ? [facts.airline, ...(facts.airlines ?? []), facts.city]
            .filter(Boolean)
            .slice(0, 3)
            .join(" / ")
        : "טיסות";
    const window =
      facts.withinMinutes != null
        ? ` ב־${facts.withinMinutes} הדקות הקרובות`
        : clockNote
          ? ` ${clockNote}`
          : facts.date
            ? ` ל־${facts.date}`
            : "";
    return `לא מצאתי ${who} בלוח ${airport}${window}.`;
  }
  const wantNext =
    facts.aspects.includes("next") ||
    (facts.aspects.length === 1 && facts.aspects[0] === "summary" && facts.flight);
  if (wantNext || facts.flight) {
    const row = facts.rows[0];
    return formatOneFlightHe(row) + ".";
  }
  const windowNote =
    facts.withinMinutes != null
      ? ` (ב־${facts.withinMinutes} דק׳ הקרובות)`
      : clockNote
        ? ` (${clockNote})`
        : "";
  const header =
    facts.direction === "arrivals"
      ? `נחיתות ב־${airport}${windowNote}${airlineNote}:`
      : facts.direction === "departures"
        ? `המראות מ־${airport}${windowNote}${airlineNote}:`
        : `טיסות ב־${airport}${windowNote}${airlineNote}:`;
  const displayCap = FLIGHTS_DISPLAY_CAP;
  const lines = facts.rows
    .slice(0, displayCap)
    .map((row, i) => `${i + 1}. ${formatOneFlightHe(row)}`);
  const notes: string[] = [];
  const localTrunc =
    facts.completeness?.truncated === true ||
    isLocallyTruncated(undefined, facts.rows.length, displayCap);
  if (localTrunc) {
    notes.push(FLIGHTS_LOCAL_TRUNCATION_HE);
  }
  // Saturated provider page = uncertainty only — never claim confirmed missing rows.
  if (facts.completeness?.providerPartial) {
    notes.push(FLIGHTS_PROVIDER_PARTIAL_HE);
  }
  return [header, ...lines, ...notes].join("\n");
}

/** Compact rows for Stage B live_select. */
export function flightsToLiveRetrievalRecords(
  facts: FlightsFacts,
): LiveRetrievalRecord[] {
  return facts.rows.map((row) => ({
    id: row.liveRecordId,
    label: `${row.flightIata || row.flightNumber} ${row.airlineName || row.airlineIata}`.trim(),
    fields: {
      flight_iata: row.flightIata,
      flight_number: row.flightNumber,
      airline_name: row.airlineName,
      airline_iata: row.airlineIata,
      other_iata: row.otherIata,
      other_airport: row.otherAirportName,
      scheduled: row.scheduledIso,
      estimated: row.estimatedIso,
      status: row.status,
      gate: row.gate || null,
      terminal: row.terminal || null,
      delay_minutes: row.delayMinutes,
      direction: row.direction,
    },
  }));
}

export function filterFlightsFactsByIds(
  facts: FlightsFacts,
  ids: string[],
): FlightsFacts {
  const kept = new Set(ids);
  const rows = facts.rows.filter((row) => kept.has(row.liveRecordId));
  return {
    ...facts,
    rows,
    ...(facts.completeness
      ? {
          completeness: {
            ...facts.completeness,
            matched: rows.length,
            truncated: isLocallyTruncated(
              undefined,
              rows.length,
              FLIGHTS_DISPLAY_CAP,
            ),
          },
        }
      : {}),
  };
}

function flightsCompletenessNotes(facts: FlightsFacts): string[] {
  const notes: string[] = [];
  if (facts.completeness?.truncated) {
    notes.push(FLIGHTS_LOCAL_TRUNCATION_HE);
  }
  if (facts.completeness?.providerPartial) {
    notes.push(FLIGHTS_PROVIDER_PARTIAL_HE);
  }
  return notes;
}

/** Apply Stage B outcome onto Flights facts and format Hebrew. */
export function formatFlightsAfterLiveSelect(
  facts: FlightsFacts,
  outcome: LiveSelectApplyResult,
): string {
  if (outcome.kind === "failure") {
    const raw = formatFlightsHebrew(facts);
    return formatLiveSelectFailureReply(raw, {
      includeUnfiltered: outcome.mayShowUnfilteredLabeled,
    });
  }
  if (outcome.kind === "no_match") {
    const base = outcome.messageHe?.trim() || LIVE_SELECT_NO_MATCH_HE;
    const notes = flightsCompletenessNotes(facts);
    return notes.length > 0 ? `${base}\n${notes.join("\n")}` : base;
  }
  if (outcome.kind === "subset") {
    return formatFlightsHebrew(filterFlightsFactsByIds(facts, outcome.keptIds));
  }
  return formatFlightsHebrew(facts);
}

export async function resolveFlightsReply(input: {
  airport?: string;
  direction?: string;
  airline?: string;
  airlines?: string[] | null;
  city?: string;
  flight?: string;
  date?: string;
  withinMinutes?: number | null;
  timeFrom?: string | null;
  timeTo?: string | null;
  aspects?: unknown;
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
  now?: Date;
  /** When true and rows exist, run same-turn live_select (Stage B). */
  requireLiveSelect?: boolean;
  speakerAsk?: string;
  billing?: ComposeLlmBilling | null;
  runSelect?: typeof runLivePostSelect;
}): Promise<string> {
  try {
    const aspects = parseFlightsAspects(input.aspects);
    const withinMinutes =
      typeof input.withinMinutes === "number" &&
      Number.isFinite(input.withinMinutes)
        ? input.withinMinutes
        : null;
    const timeFrom = normalizeFlightsClockHm(input.timeFrom) ?? "";
    const timeTo = normalizeFlightsClockHm(input.timeTo) ?? "";
    const airlines = [
      ...new Set(
        [
          ...(Array.isArray(input.airlines) ? input.airlines : []),
          String(input.airline ?? "").trim(),
        ]
          .map((a) => String(a ?? "").trim())
          .filter(Boolean),
      ),
    ];
    const board = await fetchFlightsBoard({
      airport: input.airport,
      direction: input.direction,
      airline: input.airline,
      airlines,
      city: input.city,
      flight: input.flight,
      date: input.date,
      withinMinutes,
      timeFrom,
      timeTo,
      now: input.now,
      fetchImpl: input.fetchImpl,
      apiKey: input.apiKey,
    });
    const singleFlight =
      aspects.includes("next") ||
      Boolean(normalizeFlightCode(String(input.flight ?? "")));
    const rows = singleFlight ? board.rows.slice(0, 1) : board.rows;
    const facts: FlightsFacts = {
      airport: normalizeAirportCode(input.airport ?? ""),
      direction: (String(input.direction ?? "both").toLowerCase() === "arrivals"
        ? "arrivals"
        : String(input.direction ?? "").toLowerCase() === "departures"
          ? "departures"
          : "both") as FlightsDirection,
      airline: String(input.airline ?? "").trim(),
      airlines,
      city: String(input.city ?? "").trim(),
      flight: normalizeFlightCode(String(input.flight ?? "")),
      date: String(input.date ?? "").trim(),
      withinMinutes,
      timeFrom,
      timeTo,
      aspects,
      rows,
      // Board views only — single-flight/next intentionally omit completeness notes.
      ...(singleFlight
        ? {}
        : {
            completeness: buildFlightsCompleteness({
              rows: board.rows,
              providerLimitSaturated: board.providerLimitSaturated,
            }),
          }),
    };
    if (!input.requireLiveSelect || facts.rows.length === 0) {
      return formatFlightsHebrew(facts);
    }
    const runSelect = input.runSelect ?? runLivePostSelect;
    const outcome = await runSelect({
      domain: "flights",
      records: flightsToLiveRetrievalRecords(facts),
      speakerAsk: input.speakerAsk ?? "",
      billing: input.billing ?? null,
    });
    return formatFlightsAfterLiveSelect(facts, outcome);
  } catch (error) {
    if (error instanceof FlightsApiKeyMissingError) {
      return "אין חיבור לנתוני טיסות כרגע (חסר מפתח API).";
    }
    if (
      error instanceof FlightsApiError &&
      error.code === "function_access_restricted"
    ) {
      return "ספק הטיסות לא מאפשר את הסינון הזה בתוכנית הנוכחית. נסה בלי תאריך מדויק, או לפי מספר טיסה.";
    }
    return "לא הצלחתי לשלוף עכשיו את לוח הטיסות. נסה שוב בעוד רגע.";
  }
}

export function flightStatusFingerprint(row: FlightRow): string {
  const raw = [
    row.flightIata,
    row.status,
    row.delayMinutes ?? "",
    row.gate,
    row.terminal,
    row.scheduledIso,
    row.estimatedIso,
  ].join("|");
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 40);
}

function minutesUntilIso(iso: string, now: Date): number | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return Math.round((ms - now.getTime()) / 60_000);
}

export async function fetchFlightEtaWatch(input: {
  airport?: string;
  direction: "arrivals" | "departures";
  flight?: string;
  airline?: string;
  city?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<FlightEtaWatchResult> {
  const now = input.now ?? new Date();
  try {
    const { rows } = await fetchFlightsBoard({
      airport: input.airport,
      direction: input.direction,
      flight: input.flight,
      airline: input.airline,
      city: input.city,
      fetchImpl: input.fetchImpl,
      limit: 30,
    });
    const upcoming = rows.filter((row) => {
      const m = minutesUntilIso(row.estimatedIso || row.scheduledIso, now);
      return m != null && m > -30;
    });
    const row = upcoming[0] ?? rows[0] ?? null;
    if (!row) {
      return { minutesUntil: null, fingerprint: "", summary: "", row: null };
    }
    const minutesUntil = minutesUntilIso(
      row.estimatedIso || row.scheduledIso,
      now,
    );
    return {
      minutesUntil,
      fingerprint: flightStatusFingerprint(row),
      summary: formatOneFlightHe(row),
      row,
    };
  } catch {
    return { minutesUntil: null, fingerprint: "", summary: "", row: null };
  }
}

export async function fetchFlightChangedWatch(input: {
  airport?: string;
  direction: "arrivals" | "departures";
  flight: string;
  fetchImpl?: typeof fetch;
}): Promise<FlightChangedWatchResult> {
  try {
    const { rows } = await fetchFlightsBoard({
      airport: input.airport,
      direction: input.direction,
      flight: input.flight,
      fetchImpl: input.fetchImpl,
      limit: 20,
    });
    const row = rows[0] ?? null;
    if (!row) {
      return { fingerprint: "", summary: "", row: null };
    }
    return {
      fingerprint: flightStatusFingerprint(row),
      summary: formatOneFlightHe(row),
      row,
    };
  } catch {
    return { fingerprint: "", summary: "", row: null };
  }
}

/** Total minutes threshold from flight_eta condition fields. */
export function flightEtaThresholdMinutes(input: {
  minutesBefore?: number;
  hoursBefore?: number;
}): number {
  const minutes =
    typeof input.minutesBefore === "number" && Number.isFinite(input.minutesBefore)
      ? Math.abs(Math.round(input.minutesBefore))
      : 0;
  const hours =
    typeof input.hoursBefore === "number" && Number.isFinite(input.hoursBefore)
      ? Math.abs(Math.round(input.hoursBefore))
      : 0;
  return minutes + hours * 60;
}
