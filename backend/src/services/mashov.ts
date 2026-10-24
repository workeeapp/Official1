import { isValidCalendarYmd } from "@workee/shared";
import { jerusalemYmd } from "../utils/relative-date.js";
import {
  applyCalendarDateFilterSortCap,
  emptyRetrievalStats,
  hasCalendarDateRange,
  isLocallyTruncated,
  type CalendarDateRange,
  type RetrievalStats,
} from "./retrieval-window.js";

export type MashovAspect =
  | "grades"
  | "homework"
  | "behavior"
  | "timetable"
  | "absences"
  | "messages";

export type MashovFilingRow = {
  item_name?: string;
  item_info?: string;
  itemName?: string;
  itemInfo?: string;
};

export type MashovCreds = {
  username: string;
  password: string;
  semel: number;
  year: number;
  /** Password filing was labeled for this child (optional). */
  passwordChild?: string;
};

/** Row from public GET /api/schools (no auth). */
export type MashovSchool = {
  semel: number;
  name: string;
  years: number[];
};

/** When semel is not filed yet — resolve via school name + year. */
export type MashovPendingSchool = {
  name: string;
  year: number;
  username: string;
  password: string;
  passwordChild?: string;
};

export type MashovChild = {
  guid: string;
  privateName: string;
  familyName: string;
  classCode?: string;
  classNum?: number;
};

export type MashovSession = {
  csrfToken: string;
  cookieHeader: string;
  children: MashovChild[];
  displayName: string;
};

/** Inclusive calendar-day filter (YYYY-MM-DD). Null bounds = open on that side. */
export type MashovDateRange = CalendarDateRange;

/** Per-aspect filter/sort/cap stats (alias of shared RetrievalStats). */
export type MashovDateStats = RetrievalStats;

export type MashovFacts = {
  childName: string;
  aspects: MashovAspect[];
  grades: Array<{ subject: string; grade: string; date: string; type: string }>;
  homework: Array<{ subject: string; text: string; date: string }>;
  behavior: Array<{ subject: string; text: string; date: string }>;
  timetable: Array<{ day: string; lessons: string }>;
  absences: Array<{ subject: string; text: string; date: string }>;
  messages: Array<{
    subject: string;
    from: string;
    date: string;
    preview: string;
  }>;
  missingCreds: string[];
  error?: string;
  /** Event-date filter from ACTION (not Mashov login academic year). */
  dateFrom?: string | null;
  dateTo?: string | null;
  dateStats?: Partial<
    Record<
      "grades" | "homework" | "behavior" | "absences" | "messages",
      MashovDateStats
    >
  >;
};

export function hasMashovDateRange(
  range?: MashovDateRange | null,
): boolean {
  return hasCalendarDateRange(range);
}

/**
 * Normalize Mashov/ISO/local date strings to YYYY-MM-DD.
 * Uses the calendar day from the string (first 10 chars for ISO) — does not
 * reinterpret via local timezone. Returns null for empty or invalid dates.
 */
export function normalizeMashovEventDate(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) {
    return null;
  }
  const isoPrefix = s.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoPrefix)) {
    return isValidCalendarYmd(isoPrefix) ? isoPrefix : null;
  }
  const dmy = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
  if (dmy) {
    const d = Number(dmy[1]);
    const m = Number(dmy[2]);
    const y = Number(dmy[3]);
    const ymd = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return isValidCalendarYmd(ymd) ? ymd : null;
  }
  return null;
}

export function emptyMashovDateStats(): MashovDateStats {
  return emptyRetrievalStats();
}

/**
 * Filter by optional inclusive date range, sort newest-first, then apply cap.
 * Delegates to shared applyCalendarDateFilterSortCap; Mashov-specific date
 * parsing stays in normalizeMashovEventDate.
 *
 * API note: Mashov GETs have no page/limit params here — one body per aspect.
 * Local caps are display-only; do not claim a complete newest-page when the
 * upstream payload may already be partial.
 */
export function applyMashovDateFilterSortCap<T extends { date: string }>(
  rows: T[],
  opts: { range?: MashovDateRange | null; cap: number },
): { rows: T[]; stats: MashovDateStats } {
  return applyCalendarDateFilterSortCap(rows, {
    range: opts.range ?? null,
    cap: opts.cap,
    getRawDate: (row) => row.date,
    normalizeDate: normalizeMashovEventDate,
    withNormalizedDate: (row, ymd) => ({ ...row, date: ymd }),
    sortDir: "desc",
  });
}

const BASE = "https://web.mashov.info/api";
const ASPECT_SET = new Set<MashovAspect>([
  "grades",
  "homework",
  "behavior",
  "timetable",
  "absences",
  "messages",
]);

const MASHOV_HEADERS_BASE: HeadersInit = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (compatible; Workee/1.0; +https://web.mashov.info)",
};

export function parseMashovAspects(raw: unknown): MashovAspect[] {
  if (!Array.isArray(raw)) {
    return ["grades"];
  }
  const out: MashovAspect[] = [];
  for (const entry of raw) {
    const key = String(entry ?? "")
      .trim()
      .toLowerCase();
    const mapped: MashovAspect | string =
      key === "behave" || key === "behaviour" || key === "התנהגות"
        ? "behavior"
        : key === "schedule" || key === "מערכת"
          ? "timetable"
          : key === "ציונים"
            ? "grades"
            : key === "שיעורי בית" || key === "שעורים"
              ? "homework"
              : key === "חיסורים" ||
                  key === "absence" ||
                  key === "absences" ||
                  key === "נוכחות"
                ? "absences"
                : key === "הודעות" ||
                    key === "messages" ||
                    key === "mail" ||
                    key === "inbox" ||
                    key === "דואר"
                  ? "messages"
                  : key;
    if (
      ASPECT_SET.has(mapped as MashovAspect) &&
      !out.includes(mapped as MashovAspect)
    ) {
      out.push(mapped as MashovAspect);
    }
  }
  return out.length > 0 ? out : ["grades"];
}

function filingName(row: MashovFilingRow): string {
  return String(row.item_name ?? row.itemName ?? "")
    .trim()
    .toLowerCase();
}

function filingInfo(row: MashovFilingRow): string {
  return String(row.item_info ?? row.itemInfo ?? "").trim();
}

function normHe(s: string): string {
  return s.replace(/["״']/g, "").trim().toLowerCase();
}

/** Default Mashov academic year (end year of school year) in Asia/Jerusalem. */
export function defaultMashovYear(now = new Date()): number {
  const ymd = jerusalemYmd(now);
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(5, 7));
  // School year starts around August/September → Mashov end-year label.
  return month >= 8 ? year + 1 : year;
}

function isSchoolNameFiling(name: string): boolean {
  if (!name.includes("משוב")) {
    return false;
  }
  if (name.includes("סמל")) {
    return false;
  }
  return (
    name.includes("שם בית ספר") ||
    name.includes("שם מוסד") ||
    name === "בית ספר למשוב" ||
    (name.includes("שם") &&
      (name.includes("בית ספר") || name.includes("מוסד")))
  );
}

/**
 * Read Mashov login fields from speaker filings (model-saved conventions).
 * Does not parse the user utterance — only DB filing rows.
 *
 * School identity: numeric `סמל בית ספר למשוב`, OR `שם בית ספר למשוב`
 * (resolved later via GET /api/schools). Academic year is always required from
 * filing `שנת לימודים למשוב` — never invent a default year.
 */
export function loadMashovCredsFromFilings(
  filings: MashovFilingRow[],
  opts?: { child?: string; now?: Date },
): {
  creds: MashovCreds | null;
  missing: string[];
  pendingSchool?: MashovPendingSchool;
} {
  void opts?.now;
  const childWanted = normHe(opts?.child ?? "");
  let username = "";
  let password = "";
  let passwordChild = "";
  let semelRaw = "";
  let yearRaw = "";
  let schoolName = "";

  for (const row of filings) {
    const name = filingName(row);
    const info = filingInfo(row);
    if (!info) {
      continue;
    }
    if (
      (name.includes("תעודת זהות") && name.includes("משוב")) ||
      name.includes("מזהה משוב") ||
      name === "תעודת זהות למשוב"
    ) {
      username = info.replace(/\D/g, "") || info;
      continue;
    }
    if (
      (name.includes("סמל") && name.includes("משוב")) ||
      name.includes("סמל בית ספר למשוב") ||
      name === "סמל בית ספר"
    ) {
      semelRaw = info.replace(/\D/g, "") || info;
      continue;
    }
    if (isSchoolNameFiling(name)) {
      schoolName = info;
      continue;
    }
    if (name.includes("שנת לימודים") && name.includes("משוב")) {
      yearRaw = info.replace(/\D/g, "") || info;
      continue;
    }
    if (name.includes("סיסמ") && name.includes("משוב")) {
      // «סיסמת משוב של דניאל»
      const ofMatch = name.match(/של\s+(.+)$/);
      const labeledChild = ofMatch ? normHe(ofMatch[1]!) : "";
      if (childWanted && labeledChild) {
        if (labeledChild === childWanted || childWanted.includes(labeledChild)) {
          password = info;
          passwordChild = labeledChild;
        } else if (!password) {
          // keep generic fallback later
        }
      } else if (!labeledChild) {
        password = info;
      } else if (!password) {
        password = info;
        passwordChild = labeledChild;
      }
    }
  }

  // If child-specific password not found, accept any mashov password filing.
  if (!password) {
    for (const row of filings) {
      const name = filingName(row);
      const info = filingInfo(row);
      if (info && name.includes("סיסמ") && name.includes("משוב")) {
        password = info;
        break;
      }
    }
  }

  const missing: string[] = [];
  if (!username) {
    missing.push("תעודת זהות למשוב");
  }
  if (!password) {
    missing.push("סיסמת משוב");
  }

  const yearFromFiling = yearRaw ? Number(yearRaw) : NaN;
  const hasSemel = Boolean(semelRaw);
  const hasSchoolName = Boolean(schoolName.trim());

  if (!hasSemel && !hasSchoolName) {
    missing.push("שם בית ספר למשוב");
  }
  // Always ask — do not default to 2027/current end-year.
  if (!Number.isFinite(yearFromFiling) || yearFromFiling < 2000) {
    missing.push("שנת לימודים למשוב");
  }

  if (missing.length > 0) {
    return { creds: null, missing };
  }

  const year = yearFromFiling;

  if (hasSemel) {
    const semel = Number(semelRaw);
    if (!Number.isFinite(semel) || semel <= 0) {
      return { creds: null, missing: ["סמל בית ספר למשוב (מספר תקין)"] };
    }
    return {
      creds: {
        username,
        password,
        semel,
        year,
        ...(passwordChild ? { passwordChild } : {}),
      },
      missing: [],
    };
  }

  // Resolve semel later via /schools (year already validated from filing).
  return {
    creds: null,
    missing: [],
    pendingSchool: {
      name: schoolName.trim(),
      year,
      username,
      password,
      ...(passwordChild ? { passwordChild } : {}),
    },
  };
}

/**
 * Fold common Hebrew spelling variants so Mashov names match spoken filings
 * (e.g. פתח תקווה vs Mashov's פתח תקוה).
 */
function normalizeSchoolText(s: string): string {
  return s
    .replace(/["״"']/g, "")
    .replace(/תקווה/g, "תקוה")
    .replace(/-/g, " ")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Score how well a Mashov school name matches the speaker's query (0 = none). */
export function mashovSchoolMatchScore(
  schoolName: string,
  query: string,
): number {
  const n = normalizeSchoolText(schoolName);
  const q = normalizeSchoolText(query);
  if (!q || !n) {
    return 0;
  }
  if (n === q) {
    return 100;
  }
  if (n.includes(q)) {
    return 80;
  }
  if (q.includes(n) && n.length >= 4) {
    return 70;
  }
  const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) {
    return 0;
  }
  const hit = tokens.filter((t) => n.includes(t)).length;
  if (hit === tokens.length) {
    return 50 + Math.min(hit, 20);
  }
  if (hit >= Math.ceil(tokens.length * 0.6)) {
    return 30 + hit;
  }
  return 0;
}

/**
 * Pick a school from the public list by Hebrew name + academic year.
 */
export function matchMashovSchool(input: {
  schools: MashovSchool[];
  query: string;
  year: number;
}): {
  school: MashovSchool | null;
  candidates: MashovSchool[];
  reason: "ok" | "none" | "ambiguous" | "year";
  nameHits: MashovSchool[];
} {
  const scored = input.schools
    .map((school) => ({
      school,
      score: mashovSchoolMatchScore(school.name, input.query),
    }))
    .filter((row) => row.score >= 50)
    .sort((a, b) => b.score - a.score || a.school.name.localeCompare(b.school.name, "he"));

  const nameHits = scored.map((row) => row.school);
  if (nameHits.length === 0) {
    return { school: null, candidates: [], reason: "none", nameHits: [] };
  }

  const withYear = scored.filter((row) =>
    row.school.years.includes(input.year),
  );
  if (withYear.length === 0) {
    return {
      school: null,
      candidates: nameHits.slice(0, 5),
      reason: "year",
      nameHits,
    };
  }

  const top = withYear[0]!.score;
  const tied = withYear.filter((row) => row.score === top);
  if (tied.length === 1) {
    return {
      school: tied[0]!.school,
      candidates: [],
      reason: "ok",
      nameHits,
    };
  }
  return {
    school: null,
    candidates: tied.map((row) => row.school).slice(0, 5),
    reason: "ambiguous",
    nameHits,
  };
}

export async function fetchMashovSchools(
  fetchImpl: typeof fetch = fetch,
): Promise<MashovSchool[]> {
  const res = await fetchImpl(`${BASE}/schools`, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (compatible; Workee/1.0; +https://web.mashov.info)",
    },
  });
  if (!res.ok) {
    throw new Error(`mashov schools HTTP ${res.status}`);
  }
  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) {
    return [];
  }
  const out: MashovSchool[] = [];
  for (const row of json) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const rec = row as Record<string, unknown>;
    const semel = Number(rec.semel);
    const name = String(rec.name ?? "").trim();
    const years = Array.isArray(rec.years)
      ? rec.years.map((y) => Number(y)).filter((y) => Number.isFinite(y) && y > 0)
      : [];
    if (Number.isFinite(semel) && semel > 0 && name) {
      out.push({ semel, name, years });
    }
  }
  return out;
}

/** Resolve pending school-name filings into login creds via /schools. */
export async function resolvePendingMashovSchool(
  pending: MashovPendingSchool,
  fetchImpl: typeof fetch = fetch,
): Promise<{ creds: MashovCreds | null; notice: string | null }> {
  let schools: MashovSchool[];
  try {
    schools = await fetchMashovSchools(fetchImpl);
  } catch {
    return {
      creds: null,
      notice:
        "לא הצלחתי לשלוף את רשימת בתי הספר ממשוב עכשיו. נסה שוב בעוד רגע, או שמור סמל בית ספר למשוב.",
    };
  }
  const matched = matchMashovSchool({
    schools,
    query: pending.name,
    year: pending.year,
  });
  if (matched.reason === "ok" && matched.school) {
    return {
      creds: {
        username: pending.username,
        password: pending.password,
        semel: matched.school.semel,
        year: pending.year,
        ...(pending.passwordChild
          ? { passwordChild: pending.passwordChild }
          : {}),
      },
      notice: null,
    };
  }
  if (matched.reason === "year") {
    const hints = matched.candidates
      .map((s) => {
        const ys = s.years.filter((y) => y >= 2020).slice(-4).join(", ");
        return `«${s.name}» (${ys || "אין שנים זמינות"})`;
      })
      .join("; ");
    return {
      creds: null,
      notice: `מצאתי בית ספר לפי השם, אבל שנת ${pending.year} לא זמינה שם. ${hints ? `אפשרויות: ${hints}.` : ""} עדכן שנת לימודים למשוב.`,
    };
  }
  if (matched.reason === "ambiguous") {
    const names = matched.candidates.map((s) => `«${s.name}»`).join(" או ");
    return {
      creds: null,
      notice: `מצאתי כמה בתי ספר דומים — לאיזה התכוונת: ${names}? שמור את השם המדויק בתיוק שם בית ספר למשוב.`,
    };
  }
  return {
    creds: null,
    notice: `לא מצאתי בית ספר בשם «${pending.name}» לשנת ${pending.year}. בדוק את השם או שמור סמל בית ספר למשוב.`,
  };
}

function cookieHeaderFromResponse(res: Response): string {
  const anyHeaders = res.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookies =
    typeof anyHeaders.getSetCookie === "function"
      ? anyHeaders.getSetCookie()
      : [];
  if (setCookies.length > 0) {
    return setCookies
      .map((c) => c.split(";")[0]!.trim())
      .filter(Boolean)
      .join("; ");
  }
  const single = res.headers.get("set-cookie");
  if (!single) {
    return "";
  }
  // Best-effort when getSetCookie is unavailable.
  return single
    .split(/,(?=\s*[^;]+=)/)
    .map((c) => c.split(";")[0]!.trim())
    .filter(Boolean)
    .join("; ");
}

type LoginBody = {
  accessToken?: {
    displayName?: string;
    children?: Array<{
      childGuid?: string;
      privateName?: string;
      familyName?: string;
      classCode?: string;
      classNum?: number;
    }>;
  };
};

/** Mashov parent-portal login rejects passwords shorter than this. */
export const MASHOV_PASSWORD_MIN_LENGTH = 6;

export const MASHOV_PASSWORD_TOO_SHORT_HE =
  "הסיסמה למשוב בתיוק קצרה מדי (משוב דורש לפחות 6 תווים). עדכני את «סיסמת משוב» בתיוק וניסה שוב.";

export class MashovLoginError extends Error {
  readonly kind: "auth" | "session" | "http" | "validation";
  readonly status?: number;
  readonly code?: "password_too_short";

  constructor(
    message: string,
    kind: "auth" | "session" | "http" | "validation",
    status?: number,
    code?: "password_too_short",
  ) {
    super(message);
    this.name = "MashovLoginError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

/** True when Mashov login JSON complains about password min length. */
export function isMashovPasswordTooShortError(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }
  const errors = (body as { errors?: unknown }).errors;
  if (!errors || typeof errors !== "object") {
    return false;
  }
  const password = (errors as { password?: unknown }).password;
  const msgs = Array.isArray(password)
    ? password.map((m) => String(m ?? ""))
    : [String(password ?? "")];
  return msgs.some(
    (m) =>
      /minimum length/i.test(m) ||
      /min(?:imum)?\s*length/i.test(m) ||
      /at least\s*6/i.test(m),
  );
}

export async function mashovLogin(
  creds: MashovCreds,
  fetchImpl: typeof fetch = fetch,
): Promise<MashovSession> {
  if (creds.password.length < MASHOV_PASSWORD_MIN_LENGTH) {
    throw new MashovLoginError(
      "mashov password too short",
      "validation",
      undefined,
      "password_too_short",
    );
  }
  const body = {
    username: creds.username,
    password: creds.password,
    semel: creds.semel,
    year: creds.year,
    appName: "com.mashov.students",
    appVersion: "3.20200528",
    apiVersion: "3.20200528",
    appBuild: 3.20200528,
    deviceUuid: "chrome",
    devicePlatform: "chrome",
    deviceManufacturer: "linux",
    deviceModel: "desktop",
    deviceVersion: "120",
  };
  const res = await fetchImpl(`${BASE}/login`, {
    method: "POST",
    headers: MASHOV_HEADERS_BASE,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let errBody: unknown = null;
    try {
      errBody = await res.json();
    } catch {
      errBody = null;
    }
    if (res.status === 401 || res.status === 403) {
      throw new MashovLoginError(
        `mashov login HTTP ${res.status}`,
        "auth",
        res.status,
      );
    }
    if (isMashovPasswordTooShortError(errBody)) {
      throw new MashovLoginError(
        `mashov login HTTP ${res.status} password too short`,
        "validation",
        res.status,
        "password_too_short",
      );
    }
    throw new MashovLoginError(
      `mashov login HTTP ${res.status}`,
      "http",
      res.status,
    );
  }
  const csrf =
    res.headers.get("x-csrf-token") ||
    res.headers.get("X-Csrf-Token") ||
    "";
  const cookieHeader = cookieHeaderFromResponse(res);
  if (!csrf || !cookieHeader) {
    throw new MashovLoginError(
      "mashov login missing csrf/cookies",
      "session",
    );
  }
  const json = (await res.json()) as LoginBody;
  const children: MashovChild[] = (json.accessToken?.children ?? [])
    .map((c) => ({
      guid: String(c.childGuid ?? "").trim(),
      privateName: String(c.privateName ?? "").trim(),
      familyName: String(c.familyName ?? "").trim(),
      classCode: c.classCode,
      classNum: c.classNum,
    }))
    .filter((c) => c.guid);
  return {
    csrfToken: csrf,
    cookieHeader,
    children,
    displayName: String(json.accessToken?.displayName ?? "").trim(),
  };
}

async function mashovGetJson(
  session: MashovSession,
  path: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(`${BASE}${path}`, {
    method: "GET",
    headers: {
      ...MASHOV_HEADERS_BASE,
      "X-Csrf-Token": session.csrfToken,
      Cookie: session.cookieHeader,
    },
  });
  if (!res.ok) {
    throw new Error(`mashov GET ${path} HTTP ${res.status}`);
  }
  return res.json();
}

export function pickMashovChild(
  children: MashovChild[],
  childName?: string | null,
): { child: MashovChild | null; askWhich: string[] } {
  if (children.length === 0) {
    return { child: null, askWhich: [] };
  }
  const wanted = normHe(childName ?? "");
  if (!wanted) {
    if (children.length === 1) {
      return { child: children[0]!, askWhich: [] };
    }
    return {
      child: null,
      askWhich: children.map(
        (c) => `${c.privateName}${c.familyName ? ` ${c.familyName}` : ""}`.trim(),
      ),
    };
  }
  const match =
    children.find((c) => normHe(c.privateName) === wanted) ||
    children.find((c) =>
      normHe(`${c.privateName} ${c.familyName}`).includes(wanted),
    ) ||
    children.find((c) => wanted.includes(normHe(c.privateName)));
  if (match) {
    return { child: match, askWhich: [] };
  }
  return {
    child: null,
    askWhich: children.map(
      (c) => `${c.privateName}${c.familyName ? ` ${c.familyName}` : ""}`.trim(),
    ),
  };
}

function asRecordArray(raw: unknown): Record<string, unknown>[] {
  return Array.isArray(raw)
    ? raw.filter(
        (row): row is Record<string, unknown> =>
          Boolean(row && typeof row === "object" && !Array.isArray(row)),
      )
    : [];
}

function str(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = row[key];
    if (v !== undefined && v !== null && String(v).trim()) {
      return String(v).trim();
    }
  }
  return "";
}

export function mapMashovGrades(raw: unknown) {
  return asRecordArray(raw)
    .map((row) => ({
      subject: str(row, ["subjectName", "subject", "groupName", "שם מקצוע"]),
      grade: str(row, ["grade", "gradeText", "ציון"]),
      date: str(row, ["eventDate", "date", "gradingEventDate", "תאריך"]),
      type: str(row, ["gradingEvent", "gradingType", "type", "סוג"]),
    }))
    .filter((row) => row.subject || row.grade);
}

export function normalizeGrades(
  raw: unknown,
  opts?: { range?: MashovDateRange | null },
) {
  return applyMashovDateFilterSortCap(mapMashovGrades(raw), {
    range: opts?.range ?? null,
    cap: 40,
  }).rows;
}

export function normalizeGradesWithStats(
  raw: unknown,
  opts?: { range?: MashovDateRange | null },
) {
  return applyMashovDateFilterSortCap(mapMashovGrades(raw), {
    range: opts?.range ?? null,
    cap: 40,
  });
}

export function mapMashovHomework(raw: unknown) {
  return asRecordArray(raw)
    .map((row) => ({
      subject: str(row, ["subjectName", "subject", "groupName"]),
      text: str(row, ["homework", "remark", "text", "body", "שיעורי בית"]),
      date: str(row, ["date", "lessonDate", "timestamp"]),
    }))
    .filter((row) => row.text || row.subject);
}

export function normalizeHomework(
  raw: unknown,
  opts?: { range?: MashovDateRange | null },
) {
  return applyMashovDateFilterSortCap(mapMashovHomework(raw), {
    range: opts?.range ?? null,
    cap: 30,
  }).rows;
}

export function normalizeHomeworkWithStats(
  raw: unknown,
  opts?: { range?: MashovDateRange | null },
) {
  return applyMashovDateFilterSortCap(mapMashovHomework(raw), {
    range: opts?.range ?? null,
    cap: 30,
  });
}

export function mapMashovBehavior(raw: unknown) {
  return asRecordArray(raw)
    .map((row) => ({
      subject: str(row, ["subjectName", "subject", "groupName"]),
      text: str(row, [
        "text",
        "remark",
        "achievements",
        "type",
        "justification",
        "הערה",
      ]),
      date: str(row, ["date", "lessonDate", "timestamp"]),
    }))
    .filter((row) => row.text || row.subject);
}

export function normalizeBehavior(
  raw: unknown,
  opts?: { range?: MashovDateRange | null },
) {
  return applyMashovDateFilterSortCap(mapMashovBehavior(raw), {
    range: opts?.range ?? null,
    cap: 30,
  }).rows;
}

export function normalizeBehaviorWithStats(
  raw: unknown,
  opts?: { range?: MashovDateRange | null },
) {
  return applyMashovDateFilterSortCap(mapMashovBehavior(raw), {
    range: opts?.range ?? null,
    cap: 30,
  });
}

function looksLikeAbsenceRow(row: Record<string, unknown>): boolean {
  const blob = [
    str(row, ["achvaName", "achva", "type", "eventType", "name", "text"]),
    str(row, ["justification", "remark"]),
  ]
    .join(" ")
    .toLowerCase();
  return /חיסור|העדר|absence|missed|לא הגיע|איחור/.test(blob);
}

/** lessonsCount payload and/or filtered behave rows → absences list. */
export function mapMashovAbsences(raw: unknown) {
  const rows = asRecordArray(raw);
  const mapped = rows
    .map((row) => ({
      subject: str(row, [
        "subjectName",
        "subject",
        "groupName",
        "group",
        "מקצוע",
      ]),
      text: str(row, [
        "achvaName",
        "achva",
        "type",
        "eventType",
        "name",
        "text",
        "remark",
        "justification",
        "status",
        "חיסור",
      ]),
      date: str(row, [
        "date",
        "lessonDate",
        "timestamp",
        "eventDate",
        "תאריך",
      ]),
      _absence: looksLikeAbsenceRow(row),
    }))
    .filter((row) => row.text || row.subject);
  const onlyAbsences = mapped.filter((row) => row._absence);
  const use = onlyAbsences.length > 0 ? onlyAbsences : mapped;
  return use.map(({ subject, text, date }) => ({ subject, text, date }));
}

export function normalizeAbsences(
  raw: unknown,
  opts?: { range?: MashovDateRange | null },
) {
  return applyMashovDateFilterSortCap(mapMashovAbsences(raw), {
    range: opts?.range ?? null,
    cap: 40,
  }).rows;
}

export function normalizeAbsencesWithStats(
  raw: unknown,
  opts?: { range?: MashovDateRange | null },
) {
  return applyMashovDateFilterSortCap(mapMashovAbsences(raw), {
    range: opts?.range ?? null,
    cap: 40,
  });
}

export function mapMashovMessages(raw: unknown) {
  return asRecordArray(raw)
    .map((row) => ({
      subject: str(row, [
        "subject",
        "title",
        "conversationSubject",
        "נושא",
      ]),
      from: str(row, [
        "senderName",
        "from",
        "fromName",
        "lastMessageSender",
        "שולח",
      ]),
      date: str(row, [
        "date",
        "sendDate",
        "lastMessageDate",
        "timestamp",
        "תאריך",
      ]),
      preview: str(row, [
        "body",
        "preview",
        "lastMessage",
        "snippet",
        "text",
      ]).slice(0, 200),
    }))
    .filter((row) => row.subject || row.from || row.preview);
}

export function normalizeMessages(
  raw: unknown,
  opts?: { range?: MashovDateRange | null },
) {
  return applyMashovDateFilterSortCap(mapMashovMessages(raw), {
    range: opts?.range ?? null,
    cap: 20,
  }).rows;
}

export function normalizeMessagesWithStats(
  raw: unknown,
  opts?: { range?: MashovDateRange | null },
) {
  return applyMashovDateFilterSortCap(mapMashovMessages(raw), {
    range: opts?.range ?? null,
    cap: 20,
  });
}

const HEB_WEEKDAY = [
  "ראשון",
  "שני",
  "שלישי",
  "רביעי",
  "חמישי",
  "שישי",
  "שבת",
] as const;

function dayLabelFromUnknown(raw: unknown): string {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const n = Math.trunc(raw);
    // Mashov often uses 1=Sunday … 7=Saturday; also accept 0–6.
    if (n >= 1 && n <= 7) return HEB_WEEKDAY[n - 1]!;
    if (n >= 0 && n <= 6) return HEB_WEEKDAY[n]!;
  }
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (/^\d+$/.test(s)) return dayLabelFromUnknown(Number(s));
  return s;
}

function unwrapTimetablePayload(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const row = raw as Record<string, unknown>;
  for (const key of [
    "timeTable",
    "timetable",
    "table",
    "data",
    "lessons",
    "days",
    "schedule",
  ]) {
    const v = row[key];
    if (Array.isArray(v)) return v;
  }
  // Single day object with nested lessons.
  if (Array.isArray(row.hours) || Array.isArray(row.periods)) {
    return [row];
  }
  return [];
}

function expandTimetableRow(
  row: Record<string, unknown>,
): Array<{ day: string; line: string }> {
  const nested =
    (row.timeTable && typeof row.timeTable === "object"
      ? (row.timeTable as Record<string, unknown>)
      : null) ||
    (row.timetable && typeof row.timetable === "object"
      ? (row.timetable as Record<string, unknown>)
      : null) ||
    null;
  const group =
    (row.groupDetails && typeof row.groupDetails === "object"
      ? (row.groupDetails as Record<string, unknown>)
      : null) ||
    (row.group && typeof row.group === "object"
      ? (row.group as Record<string, unknown>)
      : null) ||
    null;

  const day =
    dayLabelFromUnknown(
      nested
        ? nested.dayName ?? nested.day ?? nested.dayOfWeek ?? nested.weekday
        : undefined,
    ) ||
    dayLabelFromUnknown(
      row.dayName ?? row.day ?? row.dayOfWeek ?? row.weekday ?? row["יום"],
    ) ||
    "יום";

  const lessonArrays = [
    row.lessons,
    row.hours,
    row.periods,
    nested?.lessons,
    nested?.hours,
  ].filter(Array.isArray) as unknown[][];

  if (lessonArrays.length > 0) {
    const out: Array<{ day: string; line: string }> = [];
    for (const arr of lessonArrays) {
      for (const lesson of arr) {
        if (!lesson || typeof lesson !== "object" || Array.isArray(lesson)) {
          continue;
        }
        const L = lesson as Record<string, unknown>;
        const time = str(L, [
          "timeTableTime",
          "hour",
          "lessonTime",
          "from",
          "startTime",
          "שעה",
        ]);
        const subject = str(L, [
          "subjectName",
          "subject",
          "groupName",
          "name",
          "מקצוע",
        ]);
        const teacher = str(L, ["teacherName", "teacher", "מורה"]);
        const room = str(L, ["roomNum", "room", "classRoom", "כיתה"]);
        const line = [time, subject, teacher, room].filter(Boolean).join(" · ");
        if (line) out.push({ day, line });
      }
    }
    if (out.length > 0) return out;
  }

  const time = str(row, [
    "timeTableTime",
    "hour",
    "lesson",
    "lessonTime",
    "startTime",
    "שעה",
  ]) || (nested ? str(nested, ["timeTableTime", "hour", "lesson", "startTime"]) : "");
  const subject =
    str(row, ["subjectName", "subject", "groupName", "מקצוע"]) ||
    (group ? str(group, ["subjectName", "subject", "groupName", "name"]) : "") ||
    (nested ? str(nested, ["subjectName", "subject", "groupName"]) : "");
  const teacher =
    str(row, ["teacherName", "teacher", "מורה"]) ||
    (group ? str(group, ["teacherName", "teacher"]) : "");
  const room = str(row, ["roomNum", "room", "classRoom", "כיתה"]);
  const line = [time, subject, teacher, room].filter(Boolean).join(" · ");
  return line ? [{ day, line }] : [];
}

/**
 * Flatten Mashov timetable payloads (flat rows, nested timeTable/groupDetails,
 * or day objects with lessons/hours arrays). Never invents subjects.
 */
export function normalizeTimetable(raw: unknown) {
  const byDay = new Map<string, string[]>();
  for (const entry of unwrapTimetablePayload(raw)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    for (const { day, line } of expandTimetableRow(
      entry as Record<string, unknown>,
    )) {
      const list = byDay.get(day) ?? [];
      list.push(line);
      byDay.set(day, list);
    }
  }
  return [...byDay.entries()]
    .map(([day, lessons]) => ({
      day,
      lessons: lessons.slice(0, 12).join("; "),
    }))
    .slice(0, 7);
}

export async function fetchMashovMessages(
  session: MashovSession,
  fetchImpl: typeof fetch = fetch,
  range?: MashovDateRange | null,
): Promise<{ rows: MashovFacts["messages"]; stats: MashovDateStats }> {
  try {
    const raw = await mashovGetJson(
      session,
      "/mail/inbox/conversations",
      fetchImpl,
    );
    return normalizeMessagesWithStats(raw, { range });
  } catch {
    return { rows: [], stats: emptyMashovDateStats() };
  }
}

export async function fetchMashovAbsences(input: {
  session: MashovSession;
  childGuid: string;
  fetchImpl?: typeof fetch;
  range?: MashovDateRange | null;
}): Promise<{ rows: MashovFacts["absences"]; stats: MashovDateStats }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const range = input.range ?? null;
  const base = `/students/${encodeURIComponent(input.childGuid)}`;
  try {
    const fromCount = normalizeAbsencesWithStats(
      await mashovGetJson(input.session, `${base}/lessonsCount`, fetchImpl),
      { range },
    );
    if (fromCount.rows.length > 0 || fromCount.stats.matched > 0) {
      return fromCount;
    }
    // Prefer stats from first payload when it had undated/invalid only.
    if (
      fromCount.stats.undated + fromCount.stats.invalid + fromCount.stats.outOfRange >
      0
    ) {
      return fromCount;
    }
  } catch {
    // fall through to behave filter
  }
  try {
    const behave = asRecordArray(
      await mashovGetJson(input.session, `${base}/behave`, fetchImpl),
    );
    return normalizeAbsencesWithStats(behave.filter(looksLikeAbsenceRow), {
      range,
    });
  } catch {
    return { rows: [], stats: emptyMashovDateStats() };
  }
}

export async function fetchMashovAspects(input: {
  session: MashovSession;
  childGuid: string;
  aspects: MashovAspect[];
  fetchImpl?: typeof fetch;
  range?: MashovDateRange | null;
}): Promise<
  Omit<MashovFacts, "childName" | "missingCreds" | "error">
> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const aspects = input.aspects;
  const range = input.range ?? null;
  const base = `/students/${encodeURIComponent(input.childGuid)}`;
  const dateStats: MashovFacts["dateStats"] = {};

  let grades: MashovFacts["grades"] = [];
  if (aspects.includes("grades")) {
    const result = normalizeGradesWithStats(
      await mashovGetJson(input.session, `${base}/grades`, fetchImpl),
      { range },
    );
    grades = result.rows;
    dateStats.grades = result.stats;
  }

  let homework: MashovFacts["homework"] = [];
  if (aspects.includes("homework")) {
    const result = normalizeHomeworkWithStats(
      await mashovGetJson(input.session, `${base}/homework`, fetchImpl),
      { range },
    );
    homework = result.rows;
    dateStats.homework = result.stats;
  }

  let behavior: MashovFacts["behavior"] = [];
  if (aspects.includes("behavior")) {
    const result = normalizeBehaviorWithStats(
      await mashovGetJson(input.session, `${base}/behave`, fetchImpl),
      { range },
    );
    behavior = result.rows;
    dateStats.behavior = result.stats;
  }

  const timetable = aspects.includes("timetable")
    ? normalizeTimetable(
        await mashovGetJson(input.session, `${base}/timetable`, fetchImpl),
      )
    : [];

  let absences: MashovFacts["absences"] = [];
  if (aspects.includes("absences")) {
    const result = await fetchMashovAbsences({
      session: input.session,
      childGuid: input.childGuid,
      fetchImpl,
      range,
    });
    absences = result.rows;
    dateStats.absences = result.stats;
  }

  let messages: MashovFacts["messages"] = [];
  if (aspects.includes("messages")) {
    const result = await fetchMashovMessages(input.session, fetchImpl, range);
    messages = result.rows;
    dateStats.messages = result.stats;
  }

  return {
    aspects,
    grades,
    homework,
    behavior,
    timetable,
    absences,
    messages,
    dateFrom: range?.dateFrom ?? null,
    dateTo: range?.dateTo ?? null,
    dateStats,
  };
}

function formatMashovRangeLabel(facts: MashovFacts): string {
  const from = facts.dateFrom?.trim() || "";
  const to = facts.dateTo?.trim() || "";
  if (from && to) {
    return from === to ? from : `${from}–${to}`;
  }
  if (from) {
    return `מ־${from}`;
  }
  if (to) {
    return `עד ${to}`;
  }
  return "";
}

function unclassifiedCount(stats?: MashovDateStats): number {
  if (!stats) {
    return 0;
  }
  return stats.undated + stats.invalid;
}

function formatAspectEmptyLine(input: {
  label: string;
  who: string;
  rangeLabel: string;
  filtering: boolean;
  stats?: MashovDateStats;
  emptyNoRange: string;
}): string {
  const whoBit = input.who ? ` ${input.who}` : "";
  const unclassified = unclassifiedCount(input.stats);
  if (!input.filtering) {
    return input.emptyNoRange;
  }
  if (unclassified > 0) {
    return `לא מצאתי ${input.label} עם תאריך תקין בטווח ${input.rangeLabel}${whoBit} — יש ${unclassified} רשומות בלי תאריך תקין שלא סווגו לטווח, ולכן זו לא תוצאה שלילית מלאה.`
      .replace(/\s+/g, " ")
      .trim();
  }
  return `אין ${input.label} בטווח ${input.rangeLabel}${whoBit}.`
    .replace(/\s+/g, " ")
    .trim();
}

function formatUnclassifiedNote(
  stats: MashovDateStats | undefined,
  filtering: boolean,
): string | null {
  if (!filtering) {
    return null;
  }
  const n = unclassifiedCount(stats);
  if (n <= 0) {
    return null;
  }
  return `(שים לב: ${n} רשומות נוספות בלי תאריך תקין לא סווגו לטווח.)`;
}

/**
 * Local truncate note — covers normalize cap and Hebrew display slice.
 * Not proof the Mashov API page was incomplete.
 */
export const MASHOV_LOCAL_TRUNCATION_HE =
  "(מוצגים חלק מהרשומות — יש עוד שלא הוצגו בגלל מגבלת תצוגה.)";

/** Display caps after normalize — can hide rows even when stats.truncated is false. */
export const MASHOV_DISPLAY_CAPS = {
  grades: 15,
  homework: 10,
  behavior: 10,
  absences: 15,
  messages: 10,
} as const;

function appendAspectNotes(
  lines: string[],
  stats: MashovDateStats | undefined,
  filtering: boolean,
  rowCount: number,
  displayCap: number,
): void {
  const unclassified = formatUnclassifiedNote(stats, filtering);
  if (unclassified) {
    lines.push(unclassified);
  }
  if (isLocallyTruncated(stats, rowCount, displayCap)) {
    lines.push(MASHOV_LOCAL_TRUNCATION_HE);
  }
}

export function formatMashovHebrew(facts: MashovFacts): string {
  if (facts.missingCreds.length > 0) {
    if (
      facts.missingCreds.length === 1 &&
      facts.missingCreds[0] === "שנת לימודים למשוב"
    ) {
      return "לאיזו שנת לימודים לבדוק במשוב? (למשל 2026)";
    }
    return `כדי לבדוק במשוב חסר לי: ${facts.missingCreds.join(", ")}. אחרי שתענה אשמור ואבדוק.`;
  }
  if (facts.error) {
    return facts.error;
  }
  const lines: string[] = [];
  const who = facts.childName ? `של ${facts.childName}` : "";
  const filtering = hasMashovDateRange({
    dateFrom: facts.dateFrom ?? null,
    dateTo: facts.dateTo ?? null,
  });
  const rangeLabel = formatMashovRangeLabel(facts) || "המבוקש";

  if (facts.aspects.includes("grades")) {
    const stats = facts.dateStats?.grades;
    if (facts.grades.length === 0) {
      lines.push(
        formatAspectEmptyLine({
          label: "ציונים",
          who,
          rangeLabel,
          filtering,
          stats,
          emptyNoRange: `אין ציונים חדשים ${who}.`.replace(/\s+/g, " ").trim(),
        }),
      );
    } else {
      lines.push(
        filtering
          ? `ציונים ${who} בטווח ${rangeLabel}:`.replace(/\s+/g, " ").trim()
          : `ציונים ${who}:`.trim(),
      );
      const gradeCap = MASHOV_DISPLAY_CAPS.grades;
      for (const g of facts.grades.slice(0, gradeCap)) {
        const bits = [g.subject, g.grade, g.type, g.date.slice(0, 10)].filter(
          Boolean,
        );
        lines.push(`• ${bits.join(" — ")}`);
      }
      appendAspectNotes(lines, stats, filtering, facts.grades.length, gradeCap);
    }
  }
  if (facts.aspects.includes("homework")) {
    const stats = facts.dateStats?.homework;
    if (facts.homework.length === 0) {
      lines.push(
        formatAspectEmptyLine({
          label: "שיעורי בית",
          who,
          rangeLabel,
          filtering,
          stats,
          emptyNoRange: `אין שיעורי בית ${who}.`.replace(/\s+/g, " ").trim(),
        }),
      );
    } else {
      lines.push(
        filtering
          ? `שיעורי בית ${who} בטווח ${rangeLabel}:`.replace(/\s+/g, " ").trim()
          : `שיעורי בית ${who}:`.trim(),
      );
      const homeworkCap = MASHOV_DISPLAY_CAPS.homework;
      for (const h of facts.homework.slice(0, homeworkCap)) {
        lines.push(
          `• ${[h.subject, h.text, h.date.slice(0, 10)].filter(Boolean).join(" — ")}`,
        );
      }
      appendAspectNotes(
        lines,
        stats,
        filtering,
        facts.homework.length,
        homeworkCap,
      );
    }
  }
  if (facts.aspects.includes("behavior")) {
    const stats = facts.dateStats?.behavior;
    if (facts.behavior.length === 0) {
      lines.push(
        formatAspectEmptyLine({
          label: "אירועי התנהגות",
          who,
          rangeLabel,
          filtering,
          stats,
          emptyNoRange: `אין אירועי התנהגות ${who}.`
            .replace(/\s+/g, " ")
            .trim(),
        }),
      );
    } else {
      lines.push(
        filtering
          ? `התנהגות ${who} בטווח ${rangeLabel}:`.replace(/\s+/g, " ").trim()
          : `התנהגות ${who}:`.trim(),
      );
      const behaviorCap = MASHOV_DISPLAY_CAPS.behavior;
      for (const b of facts.behavior.slice(0, behaviorCap)) {
        lines.push(
          `• ${[b.subject, b.text, b.date.slice(0, 10)].filter(Boolean).join(" — ")}`,
        );
      }
      appendAspectNotes(
        lines,
        stats,
        filtering,
        facts.behavior.length,
        behaviorCap,
      );
    }
  }
  if (facts.aspects.includes("timetable")) {
    if (facts.timetable.length === 0) {
      lines.push(`אין מערכת שעות ${who}.`.replace(/\s+/g, " ").trim());
    } else {
      lines.push(`מערכת שעות ${who}:`.trim());
      for (const t of facts.timetable) {
        lines.push(`• ${t.day}: ${t.lessons}`);
      }
    }
  }
  if (facts.aspects.includes("absences")) {
    const stats = facts.dateStats?.absences;
    if (facts.absences.length === 0) {
      lines.push(
        formatAspectEmptyLine({
          label: "חיסורים",
          who,
          rangeLabel,
          filtering,
          stats,
          emptyNoRange: `אין חיסורים ${who}.`.replace(/\s+/g, " ").trim(),
        }),
      );
    } else {
      lines.push(
        filtering
          ? `חיסורים ${who} בטווח ${rangeLabel}:`.replace(/\s+/g, " ").trim()
          : `חיסורים ${who}:`.trim(),
      );
      const absenceCap = MASHOV_DISPLAY_CAPS.absences;
      for (const a of facts.absences.slice(0, absenceCap)) {
        lines.push(
          `• ${[a.subject, a.text, a.date.slice(0, 10)].filter(Boolean).join(" — ")}`,
        );
      }
      appendAspectNotes(
        lines,
        stats,
        filtering,
        facts.absences.length,
        absenceCap,
      );
    }
  }
  if (facts.aspects.includes("messages")) {
    const stats = facts.dateStats?.messages;
    if (facts.messages.length === 0) {
      lines.push(
        formatAspectEmptyLine({
          label: "הודעות",
          who: "",
          rangeLabel,
          filtering,
          stats,
          emptyNoRange: "אין הודעות חדשות בתיבת הדואר במשוב.",
        }),
      );
    } else {
      lines.push(
        filtering ? `הודעות במשוב בטווח ${rangeLabel}:` : "הודעות במשוב:",
      );
      const messageCap = MASHOV_DISPLAY_CAPS.messages;
      for (const m of facts.messages.slice(0, messageCap)) {
        lines.push(
          `• ${[m.from, m.subject, m.preview, m.date.slice(0, 10)]
            .filter(Boolean)
            .join(" — ")}`,
        );
      }
      appendAspectNotes(
        lines,
        stats,
        filtering,
        facts.messages.length,
        messageCap,
      );
    }
  }
  if (lines.length === 0) {
    return "לא מצאתי נתונים במשוב.";
  }
  return lines.join("\n");
}

/** Concise notice when ACTION had explicit but invalid date bounds. */
export const MASHOV_INVALID_DATE_BOUNDS_HE =
  "לא הצלחתי להבין את טווח התאריכים. בדקו תאריך בפורמט YYYY-MM-DD (למשל 2025-01-31) ונסו שוב.";

type MashovBoundClass =
  | { kind: "absent" }
  | { kind: "valid"; ymd: string }
  | { kind: "invalid" };

function classifyMashovBound(raw: string | null | undefined): MashovBoundClass {
  if (raw === null || raw === undefined) {
    return { kind: "absent" };
  }
  if (typeof raw !== "string") {
    return { kind: "invalid" };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { kind: "absent" };
  }
  const ymd = trimmed.slice(0, 10);
  if (isValidCalendarYmd(ymd)) {
    return { kind: "valid", ymd };
  }
  return { kind: "invalid" };
}

export type MashovReplyRangeResult =
  | { ok: true; range: MashovDateRange }
  | { ok: false; notice: string };

/**
 * Resolve ACTION date_from/date_to for Mashov event filtering.
 * Explicit non-empty invalid bounds → fail (never silent open-range).
 * Absent/null/empty → open range (ok).
 */
export function resolveMashovReplyRange(input: {
  dateFrom?: string | null;
  dateTo?: string | null;
  /** From parse when a bound was present but calendar-invalid. */
  dateBoundsInvalid?: boolean;
}): MashovReplyRangeResult {
  if (input.dateBoundsInvalid) {
    return { ok: false, notice: MASHOV_INVALID_DATE_BOUNDS_HE };
  }
  const from = classifyMashovBound(input.dateFrom);
  const to = classifyMashovBound(input.dateTo);
  if (from.kind === "invalid" || to.kind === "invalid") {
    return { ok: false, notice: MASHOV_INVALID_DATE_BOUNDS_HE };
  }
  let dateFrom = from.kind === "valid" ? from.ymd : null;
  let dateTo = to.kind === "valid" ? to.ymd : null;
  if (dateFrom && dateTo && dateFrom > dateTo) {
    const swap = dateFrom;
    dateFrom = dateTo;
    dateTo = swap;
  }
  return { ok: true, range: { dateFrom, dateTo } };
}

export async function resolveMashovReply(input: {
  filings: MashovFilingRow[];
  child?: string | null;
  aspects?: MashovAspect[] | unknown;
  /** Inclusive event-date filter (not login academic year). */
  dateFrom?: string | null;
  dateTo?: string | null;
  /** When parse saw explicit invalid bounds — do not open-range. */
  dateBoundsInvalid?: boolean;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const aspects = parseMashovAspects(input.aspects);
  const rangeResult = resolveMashovReplyRange({
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    dateBoundsInvalid: input.dateBoundsInvalid,
  });
  if (!rangeResult.ok) {
    return rangeResult.notice;
  }
  const range = rangeResult.range;
  const loaded = loadMashovCredsFromFilings(input.filings, {
    child: input.child ?? undefined,
    now: input.now,
  });
  const fetchImpl = input.fetchImpl ?? fetch;

  let creds = loaded.creds;
  if (!creds && loaded.pendingSchool) {
    const resolved = await resolvePendingMashovSchool(
      loaded.pendingSchool,
      fetchImpl,
    );
    if (resolved.notice) {
      return resolved.notice;
    }
    creds = resolved.creds;
  }

  if (!creds) {
    return formatMashovHebrew({
      childName: input.child?.trim() ?? "",
      aspects,
      grades: [],
      homework: [],
      behavior: [],
      timetable: [],
      absences: [],
      messages: [],
      missingCreds: loaded.missing,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
    });
  }

  try {
    const session = await mashovLogin(creds, fetchImpl);
    const needsChild = aspects.some((a) => a !== "messages");
    const messagesOnly =
      aspects.length > 0 && aspects.every((a) => a === "messages");
    if (messagesOnly) {
      const messagesResult = await fetchMashovMessages(
        session,
        fetchImpl,
        range,
      );
      return formatMashovHebrew({
        childName: "",
        aspects,
        grades: [],
        homework: [],
        behavior: [],
        timetable: [],
        absences: [],
        messages: messagesResult.rows,
        missingCreds: [],
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        dateStats: { messages: messagesResult.stats },
      });
    }
    const picked = pickMashovChild(session.children, input.child);
    if (!picked.child && needsChild) {
      if (picked.askWhich.length > 1) {
        return `לאיזה ילד לבדוק במשוב — ${picked.askWhich.join(" או ")}?`;
      }
      if (picked.askWhich.length === 0) {
        return "ההתחברות למשוב הצליחה אבל לא מצאתי ילדים בחשבון.";
      }
      return `לא מצאתי ילד בשם «${input.child}». אצלך: ${picked.askWhich.join(", ")}.`;
    }
    if (!picked.child) {
      const messagesResult = aspects.includes("messages")
        ? await fetchMashovMessages(session, fetchImpl, range)
        : { rows: [] as MashovFacts["messages"], stats: emptyMashovDateStats() };
      return formatMashovHebrew({
        childName: "",
        aspects,
        grades: [],
        homework: [],
        behavior: [],
        timetable: [],
        absences: [],
        messages: messagesResult.rows,
        missingCreds: [],
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        dateStats: aspects.includes("messages")
          ? { messages: messagesResult.stats }
          : undefined,
      });
    }
    const data = await fetchMashovAspects({
      session,
      childGuid: picked.child.guid,
      aspects,
      fetchImpl,
      range,
    });
    const childName =
      `${picked.child.privateName}${picked.child.familyName ? ` ${picked.child.familyName}` : ""}`.trim();
    return formatMashovHebrew({
      childName,
      missingCreds: [],
      ...data,
    });
  } catch (error) {
    if (
      error instanceof MashovLoginError &&
      error.code === "password_too_short"
    ) {
      return MASHOV_PASSWORD_TOO_SHORT_HE;
    }
    if (error instanceof MashovLoginError && error.kind === "auth") {
      return "פרטי ההתחברות למשוב לא התקבלו. בדוק תעודת זהות, סיסמה, שם בית הספר ושנת הלימודים בתיוקים.";
    }
    if (error instanceof MashovLoginError && error.kind === "session") {
      return "ההתחברות למשוב לא הושלמה. נסה שוב בעוד רגע.";
    }
    if (error instanceof MashovLoginError && error.kind === "validation") {
      return "פרטי ההתחברות למשוב לא תקינים. בדוק תעודת זהות, סיסמה, שם בית ספר ושנת לימודים בתיוקים.";
    }
    return "לא הצלחתי להתחבר למשוב עכשיו. בדוק תעודת זהות, סיסמה, שם בית ספר ושנת לימודים בתיוקים, ונסה שוב.";
  }
}
