/**
 * MOT SIRI-SM (Stop Monitoring) client — SIRI-Lite v2.8 JSON.
 *
 * Pull-on-demand only. No Prisma writes. Trip↔GTFS matching is NOT required
 * to display a prediction (DatedVehicleJourneyRef kept opaque / unverified).
 *
 * Kill switch: SIRI_ENABLED=1 plus non-empty SIRI_SM_BASE_URL and SIRI_SM_KEY.
 * Missing/disabled config never issues an HTTP request.
 *
 * Field names follow MOT ICD SM v2.8 (StopMonitoringDelivery / MonitoredStopVisit).
 */
export const SIRI_LIVE_SOURCE_HE =
  "תחזית הגעה רשמית (משרד התחבורה / SIRI) — זמן אמת כפי שהתקבל מהמפעיל";

export const SIRI_DISABLED_HE =
  "תחזית זמן אמת של משרד התחבורה כבויה כרגע (SIRI_ENABLED).";

export const SIRI_CONFIG_MISSING_HE =
  "תחזית זמן אמת אינה מוגדרת (חסרים כתובת בסיס או מפתח SIRI).";

export const SIRI_STALE_HE =
  "תחזית זמן האמת ישנה מדי — לא אציג אותה כחיה.";

export const SIRI_FRESHNESS_UNKNOWN_HE =
  "לא ניתן לאמת עדכניות של תחזית הזמן אמת — לא אציג אותה כחיה.";

export const SIRI_EMPTY_HE =
  "אין כרגע תחזיות הגעה חיות לתחנה הזו.";

export const SIRI_ERROR_HE =
  "לא הצלחתי לקבל תחזית זמן אמת ממשרד התחבורה עכשיו.";

/** Product stale threshold (not an ICD-mandated value). */
export const SIRI_STALE_AFTER_MS = 120_000;

export type SiriArrivalStatus =
  | "onTime"
  | "early"
  | "delayed"
  | "cancelled"
  | "arrived"
  | "noReport"
  | "unknown";

export type SiriNormalizedArrival = {
  stopCode: string;
  lineRef: string;
  publishedLineName: string;
  operatorRef: string;
  directionRef: string;
  destinationRef: string;
  /** Opaque MOT journey id — GTFS join unverified in Gate 4A. */
  datedVehicleJourneyRef: string;
  dataFrameRef: string;
  vehicleRef: string;
  expectedArrivalIso: string;
  aimedArrivalIso: string;
  arrivalStatus: SiriArrivalStatus;
  recordedAtIso: string;
  cancelled: boolean;
};

export type SiriFetchOk = {
  ok: true;
  responseTimestampIso: string;
  arrivals: SiriNormalizedArrival[];
  /** True when response/record age exceeds SIRI_STALE_AFTER_MS. */
  stale: boolean;
  sourceHe: string;
};

export type SiriFetchFail = {
  ok: false;
  kind:
    | "disabled"
    | "config_missing"
    | "http_error"
    | "malformed"
    | "empty"
    | "stale"
    /** No usable ServiceDelivery / StopMonitoringDelivery ResponseTimestamp. */
    | "freshness_unknown";
  messageHe: string;
  /** Present when we parsed arrivals but marked them stale/unfresh. */
  arrivals?: SiriNormalizedArrival[];
};

export type SiriFetchResult = SiriFetchOk | SiriFetchFail;

export type SiriSmConfig = {
  enabled: boolean;
  baseUrl: string;
  key: string;
};

/** Read kill switch + credentials from env. Never invents a base URL. */
export function readSiriSmConfig(
  env: NodeJS.ProcessEnv = process.env,
): SiriSmConfig {
  return {
    enabled: env.SIRI_ENABLED === "1",
    baseUrl: String(env.SIRI_SM_BASE_URL ?? "").trim(),
    key: String(env.SIRI_SM_KEY ?? "").trim(),
  };
}

export function isSiriSmConfigured(config: SiriSmConfig = readSiriSmConfig()): boolean {
  return config.enabled && Boolean(config.baseUrl) && Boolean(config.key);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function firstString(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v == null) return [];
  return [v as T];
}

function parseIsoMs(raw: string): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function normalizeStatus(raw: string): SiriArrivalStatus {
  const s = raw.trim();
  const known: SiriArrivalStatus[] = [
    "onTime",
    "early",
    "delayed",
    "cancelled",
    "arrived",
    "noReport",
  ];
  return (known as string[]).includes(s) ? (s as SiriArrivalStatus) : "unknown";
}

/**
 * Build SIRI-Lite v2.8 stop-monitoring URL.
 * `baseUrl` must already be the host+path prefix supplied by MOT (not invented).
 * Appends `/2.8/json` when the base does not already end with `/2.8/json` or `/2.8/xml`.
 */
export function buildSiriStopMonitoringUrl(input: {
  baseUrl: string;
  key: string;
  monitoringRef: string;
  lineRef?: string;
  maximumStopVisits?: number;
}): string {
  const base = input.baseUrl.replace(/\/+$/, "");
  const hasVersion = /\/2\.8\/(json|xml)$/i.test(base);
  const endpoint = hasVersion ? base : `${base}/2.8/json`;
  const url = new URL(endpoint);
  url.searchParams.set("Key", input.key);
  url.searchParams.set("MonitoringRef", input.monitoringRef.trim());
  const line = String(input.lineRef ?? "").trim();
  if (line) url.searchParams.set("LineRef", line);
  if (
    input.maximumStopVisits != null &&
    Number.isFinite(input.maximumStopVisits) &&
    input.maximumStopVisits > 0
  ) {
    url.searchParams.set(
      "MaximumStopVisits",
      String(Math.floor(input.maximumStopVisits)),
    );
  }
  return url.toString();
}

/** Pure parse + normalize of a SIRI-Lite JSON body (ICD field names). */
export function parseSiriStopMonitoringJson(
  body: unknown,
  options?: { now?: Date; staleAfterMs?: number },
): SiriFetchResult {
  const now = options?.now ?? new Date();
  const staleAfterMs = options?.staleAfterMs ?? SIRI_STALE_AFTER_MS;
  const root = asRecord(body);
  if (!root) {
    return { ok: false, kind: "malformed", messageHe: SIRI_ERROR_HE };
  }

  const siri = asRecord(root.Siri) ?? root;
  const delivery = asRecord(siri.ServiceDelivery);
  if (!delivery) {
    return { ok: false, kind: "malformed", messageHe: SIRI_ERROR_HE };
  }

  /**
   * ICD: ResponseTimestamp = time of the SIRI response (ServiceDelivery and/or
   * StopMonitoringDelivery). RecordedAtTime = vehicle observation time — metadata
   * only; it must not make an old response look fresh.
   */
  const serviceResponseIso = firstString(delivery.ResponseTimestamp);
  const stopDeliveries = asArray<unknown>(delivery.StopMonitoringDelivery);
  if (stopDeliveries.length === 0) {
    return { ok: false, kind: "malformed", messageHe: SIRI_ERROR_HE };
  }

  const arrivals: SiriNormalizedArrival[] = [];
  /** Newest parseable delivery/service ResponseTimestamp (not RecordedAtTime). */
  let newestResponseMs: number | null = parseIsoMs(serviceResponseIso);
  let newestResponseIso = serviceResponseIso;

  for (const rawDel of stopDeliveries) {
    const del = asRecord(rawDel);
    if (!del) continue;

    const statusVal = del.Status;
    if (statusVal === false || statusVal === "false") {
      const err =
        firstString(
          asRecord(del.ErrorCondition)?.Description,
          asRecord(asRecord(del.ErrorCondition)?.OtherError)?.ErrorText,
          asRecord(del.ErrorCondition)?.ErrorText,
        ) || SIRI_ERROR_HE;
      return { ok: false, kind: "http_error", messageHe: err };
    }

    const delTs = firstString(del.ResponseTimestamp);
    const delMs = parseIsoMs(delTs);
    if (delMs != null && (newestResponseMs == null || delMs > newestResponseMs)) {
      newestResponseMs = delMs;
      newestResponseIso = delTs;
    }

    for (const rawVisit of asArray<unknown>(del.MonitoredStopVisit)) {
      const visit = asRecord(rawVisit);
      if (!visit) continue;
      const journey = asRecord(visit.MonitoredVehicleJourney);
      if (!journey) continue;
      const call = asRecord(journey.MonitoredCall) ?? {};
      const framed = asRecord(journey.FramedVehicleJourneyRef) ?? {};

      const expectedRaw = firstString(call.ExpectedArrivalTime);
      const aimedRaw = firstString(call.AimedArrivalTime);
      // Prefer Expected; Aimed only when Expected absent (ICD: pre-start planned).
      // Reject unparseable arrival clocks — do not invent.
      const expectedArrivalIso =
        (expectedRaw && parseIsoMs(expectedRaw) != null ? expectedRaw : "") ||
        (aimedRaw && parseIsoMs(aimedRaw) != null ? aimedRaw : "");
      const aimedArrivalIso =
        aimedRaw && parseIsoMs(aimedRaw) != null ? aimedRaw : "";
      const arrivalStatus = normalizeStatus(firstString(call.ArrivalStatus));
      const cancelled = arrivalStatus === "cancelled";
      // Vehicle observation metadata only (ICD RecordedAtTime) — not response freshness.
      const recordedAtIso = firstString(visit.RecordedAtTime);

      // Skip visits with no usable arrival time (unless cancelled — still surface).
      if (!expectedArrivalIso && !cancelled) continue;

      arrivals.push({
        stopCode: firstString(
          visit.MonitoringRef,
          call.StopPointRef,
        ),
        lineRef: firstString(journey.LineRef),
        publishedLineName: firstString(journey.PublishedLineName),
        operatorRef: firstString(journey.OperatorRef),
        directionRef: firstString(journey.DirectionRef),
        destinationRef: firstString(journey.DestinationRef),
        datedVehicleJourneyRef: firstString(framed.DatedVehicleJourneyRef),
        dataFrameRef: firstString(framed.DataFrameRef),
        vehicleRef: firstString(journey.VehicleRef),
        expectedArrivalIso,
        aimedArrivalIso,
        arrivalStatus,
        recordedAtIso,
        cancelled,
      });
    }
  }

  const deduped = dedupeArrivals(arrivals);

  // Fail closed: never label live without a valid response timestamp.
  if (newestResponseMs == null) {
    return {
      ok: false,
      kind: "freshness_unknown",
      messageHe: SIRI_FRESHNESS_UNKNOWN_HE,
      arrivals: deduped,
    };
  }

  const ageMs = now.getTime() - newestResponseMs;
  // Negative age (client clock behind MOT) is treated as fresh.
  if (ageMs > staleAfterMs) {
    return {
      ok: false,
      kind: "stale",
      messageHe: SIRI_STALE_HE,
      arrivals: deduped,
    };
  }

  if (deduped.length === 0) {
    return { ok: false, kind: "empty", messageHe: SIRI_EMPTY_HE };
  }

  return {
    ok: true,
    responseTimestampIso: newestResponseIso,
    arrivals: deduped,
    stale: false,
    sourceHe: SIRI_LIVE_SOURCE_HE,
  };
}

/** Dedupe by journey+stop+expected time (or vehicle+line+time). */
export function dedupeArrivals(
  arrivals: SiriNormalizedArrival[],
): SiriNormalizedArrival[] {
  const seen = new Set<string>();
  const out: SiriNormalizedArrival[] = [];
  for (const a of arrivals) {
    const key =
      [
        a.datedVehicleJourneyRef || a.vehicleRef,
        a.stopCode,
        a.expectedArrivalIso || a.aimedArrivalIso,
        a.lineRef || a.publishedLineName,
      ].join("|") || JSON.stringify(a);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  out.sort((a, b) => {
    const am = parseIsoMs(a.expectedArrivalIso) ?? Number.POSITIVE_INFINITY;
    const bm = parseIsoMs(b.expectedArrivalIso) ?? Number.POSITIVE_INFINITY;
    return am - bm;
  });
  return out;
}

export type FetchStopArrivalsInput = {
  monitoringRef: string;
  /** Optional MOT LineRef (route_id), not the published short name. */
  lineRef?: string;
  maximumStopVisits?: number;
  fetchImpl?: typeof fetch;
  config?: SiriSmConfig;
  now?: Date;
  staleAfterMs?: number;
};

/**
 * Fetch + normalize stop arrivals. Never calls network when disabled/unconfigured.
 */
export async function fetchSiriStopArrivals(
  input: FetchStopArrivalsInput,
): Promise<SiriFetchResult> {
  const config = input.config ?? readSiriSmConfig();
  if (!config.enabled) {
    return { ok: false, kind: "disabled", messageHe: SIRI_DISABLED_HE };
  }
  if (!config.baseUrl || !config.key) {
    return { ok: false, kind: "config_missing", messageHe: SIRI_CONFIG_MISSING_HE };
  }
  const monitoringRef = String(input.monitoringRef ?? "").trim();
  if (!monitoringRef) {
    return { ok: false, kind: "malformed", messageHe: "חסר קוד תחנה לתחזית זמן אמת." };
  }

  const url = buildSiriStopMonitoringUrl({
    baseUrl: config.baseUrl,
    key: config.key,
    monitoringRef,
    lineRef: input.lineRef,
    maximumStopVisits: input.maximumStopVisits,
  });

  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch {
    return { ok: false, kind: "http_error", messageHe: SIRI_ERROR_HE };
  }

  if (!response.ok) {
    return {
      ok: false,
      kind: "http_error",
      messageHe: SIRI_ERROR_HE,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, kind: "malformed", messageHe: SIRI_ERROR_HE };
  }

  return parseSiriStopMonitoringJson(body, {
    now: input.now,
    staleAfterMs: input.staleAfterMs,
  });
}

function formatArrivalHm(iso: string): string {
  const ms = parseIsoMs(iso);
  if (ms == null) return iso.slice(11, 16) || iso;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Jerusalem",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return iso.slice(11, 16) || iso;
  }
}

export function formatSiriArrivalsHebrew(
  result: SiriFetchOk,
  options?: { limit?: number },
): string {
  const limit = Math.min(Math.max(options?.limit ?? 8, 1), 20);
  const rows = result.arrivals
    .filter((a) => !a.cancelled)
    .slice(0, limit);
  const cancelled = result.arrivals.filter((a) => a.cancelled).slice(0, 3);
  const lines = rows.map((a) => {
    const line = a.publishedLineName || a.lineRef || "?";
    const hm = formatArrivalHm(a.expectedArrivalIso);
    const status =
      a.arrivalStatus === "delayed"
        ? " (מתעכב)"
        : a.arrivalStatus === "early"
          ? " (מוקדם)"
          : "";
    return `• ${hm} קו ${line}${status} — תחנה [${a.stopCode}]`;
  });
  const parts: string[] = [];
  if (rows.length > 0) {
    parts.push("הגעות חזויות (זמן אמת):", ...lines);
  } else if (cancelled.length > 0) {
    // Truthful: do not imply active arrival predictions when none exist.
    parts.push("אין תחזיות הגעה פעילות כרגע — רק דיווחי ביטול:");
  } else {
    parts.push(SIRI_EMPTY_HE);
  }
  if (cancelled.length > 0) {
    parts.push(
      "בוטלו:",
      ...cancelled.map(
        (a) =>
          `• קו ${a.publishedLineName || a.lineRef || "?"} [${a.stopCode}]`,
      ),
    );
  }
  parts.push(result.sourceHe);
  return parts.join("\n");
}

/**
 * Filter normalized arrivals by published line name and/or operator.
 * `operatorRef` must be the MOT/GTFS agency_id (exact), not a Hebrew display name.
 */
export function filterSiriArrivals(
  arrivals: SiriNormalizedArrival[],
  filters: { publishedLineName?: string; operatorRef?: string; lineRef?: string },
): SiriNormalizedArrival[] {
  const lineName = String(filters.publishedLineName ?? "").trim();
  const op = String(filters.operatorRef ?? "").trim();
  const lineRef = String(filters.lineRef ?? "").trim();
  return arrivals.filter((a) => {
    if (lineName && a.publishedLineName !== lineName && a.lineRef !== lineName) {
      return false;
    }
    if (lineRef && a.lineRef !== lineRef) return false;
    if (op && a.operatorRef !== op) return false;
    return true;
  });
}
