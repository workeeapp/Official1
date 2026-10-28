import { isValidCalendarYmd } from "@workee/shared";
import {
  applyCalendarDateFilterSortCap,
  emptyRetrievalStats,
  hasCalendarDateRange,
  isLocallyTruncated,
  type CalendarDateRange,
  type RetrievalStats,
} from "./retrieval-window.js";

/**
 * SmartSchool Israel (Webtop) — unofficial parent portal API.
 * Supported live aspects: homework | behavior | timetable | messages.
 * grades / absences are outside Q (no documented endpoint) — model leaves
 * smartschool null + discloses (LIVE CAPABILITY GATE).
 */

export type SmartschoolAspect =
  | "homework"
  | "behavior"
  | "timetable"
  | "messages";

/** Parsed ACTION may mention these; engine refuses fetch (capability U). */
export type SmartschoolUnsupportedAspect = "grades" | "absences";

export type SmartschoolFilingRow = {
  item_name?: string;
  item_info?: string;
  itemName?: string;
  itemInfo?: string;
};

export type SmartschoolCreds = {
  username: string;
  password: string;
  /** Academic year for timetable (from filing). */
  year: number | null;
  passwordChild?: string;
};

export type SmartschoolChild = {
  studentId: string;
  login: string;
  firstName: string;
  lastName: string;
};

export type SmartschoolSession = {
  token: string;
  /** Encrypted student id for homework / discipline / schedule bodies. */
  encryptedId: string;
  studentId: string;
  classCode: number | null;
  classNumber: number | null;
  firstName: string;
  lastName: string;
  schoolName: string;
  rawLoginData: Record<string, unknown>;
};

export type SmartschoolDateRange = CalendarDateRange;
export type SmartschoolDateStats = RetrievalStats;

export type SmartschoolFacts = {
  childName: string;
  aspects: SmartschoolAspect[];
  homework: Array<{ subject: string; text: string; date: string }>;
  behavior: Array<{ subject: string; text: string; date: string }>;
  timetable: Array<{ day: string; lessons: string }>;
  messages: Array<{
    subject: string;
    from: string;
    date: string;
    preview: string;
  }>;
  missingCreds: string[];
  error?: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  dateStats?: Partial<
    Record<"homework" | "behavior" | "messages", SmartschoolDateStats>
  >;
};

const BASE = "https://webtopserver.smartschool.co.il";
/** Opaque login Data field — pywebtop default that works for many schools. */
const DEFAULT_LOGIN_DATA = "+Aabe7FAdVluG6Lu+0ibrA==";

const ASPECT_SET = new Set<SmartschoolAspect>([
  "homework",
  "behavior",
  "timetable",
  "messages",
]);

const HEADERS_BASE: HeadersInit = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json; charset=utf-8",
  "User-Agent":
    "Mozilla/5.0 (compatible; Workee/1.0; +https://webtopserver.smartschool.co.il)",
};

export function hasSmartschoolDateRange(
  range?: SmartschoolDateRange | null,
): boolean {
  return hasCalendarDateRange(range);
}

export function normalizeSmartschoolEventDate(raw: string): string | null {
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

export function emptySmartschoolDateStats(): SmartschoolDateStats {
  return emptyRetrievalStats();
}

export function applySmartschoolDateFilterSortCap<T extends { date: string }>(
  rows: T[],
  opts: { range?: SmartschoolDateRange | null; cap: number },
): { rows: T[]; stats: SmartschoolDateStats } {
  return applyCalendarDateFilterSortCap(rows, {
    range: opts.range ?? null,
    cap: opts.cap,
    getRawDate: (row) => row.date,
    normalizeDate: normalizeSmartschoolEventDate,
    withNormalizedDate: (row, ymd) => ({ ...row, date: ymd }),
    sortDir: "desc",
  });
}

export function parseSmartschoolAspects(raw: unknown): SmartschoolAspect[] {
  if (!Array.isArray(raw)) {
    return ["homework"];
  }
  const out: SmartschoolAspect[] = [];
  for (const entry of raw) {
    const key = String(entry ?? "")
      .trim()
      .toLowerCase();
    const mapped: SmartschoolAspect | string =
      key === "behave" ||
      key === "behaviour" ||
      key === "התנהגות" ||
      key === "חיזוק" ||
      key === "חיזוקים" ||
      key === "חיזוקים חיוביים" ||
      key === "discipline"
        ? "behavior"
        : key === "schedule" || key === "מערכת" || key === "מערכת שעות"
          ? "timetable"
          : key === "שיעורי בית" || key === "שעורים" || key === "homework"
            ? "homework"
            : key === "הודעות" ||
                key === "messages" ||
                key === "mail" ||
                key === "inbox" ||
                key === "דואר" ||
                key === "התראות" ||
                key === "notifications"
              ? "messages"
              : key;
    if (
      ASPECT_SET.has(mapped as SmartschoolAspect) &&
      !out.includes(mapped as SmartschoolAspect)
    ) {
      out.push(mapped as SmartschoolAspect);
    }
  }
  return out.length > 0 ? out : ["homework"];
}

/** True when ACTION asked only for grades/absences (unsupported). */
export function smartschoolAspectsAllUnsupported(raw: unknown): boolean {
  if (!Array.isArray(raw) || raw.length === 0) {
    return false;
  }
  const unsupported = new Set(["grades", "absences", "ציונים", "חיסורים"]);
  let sawAny = false;
  for (const entry of raw) {
    const key = String(entry ?? "")
      .trim()
      .toLowerCase();
    if (!key) continue;
    sawAny = true;
    if (!unsupported.has(key) && ASPECT_SET.has(key as SmartschoolAspect)) {
      return false;
    }
    if (
      key === "behave" ||
      key === "behaviour" ||
      key === "schedule" ||
      key === "homework" ||
      key === "messages" ||
      key === "התנהגות" ||
      key === "מערכת" ||
      key === "שיעורי בית" ||
      key === "הודעות"
    ) {
      return false;
    }
  }
  return sawAny;
}

function filingName(row: SmartschoolFilingRow): string {
  return String(row.item_name ?? row.itemName ?? "")
    .trim()
    .toLowerCase();
}

function filingInfo(row: SmartschoolFilingRow): string {
  return String(row.item_info ?? row.itemInfo ?? "").trim();
}

function normHe(s: string): string {
  return s.replace(/["״']/g, "").trim().toLowerCase();
}

function isSmartschoolFilingName(name: string): boolean {
  return (
    name.includes("סמארט") ||
    name.includes("smartschool") ||
    name.includes("smart school") ||
    name.includes("סמארטסקול") ||
    name.includes("webtop") ||
    name.includes("וובטופ")
  );
}

function smartschoolFilingChildLabel(name: string): string {
  const ofMatch = name.match(/של\s+(.+)$/);
  return ofMatch ? normHe(ofMatch[1]!) : "";
}

function labelMatchesChild(labeled: string, wanted: string): boolean {
  if (!wanted || !labeled) {
    return false;
  }
  return (
    labeled === wanted ||
    wanted.includes(labeled) ||
    labeled.includes(wanted)
  );
}

function pickFiledValue(
  candidates: Array<{ info: string; labeled: string }>,
  childWanted: string,
): { info: string; labeled: string } | null {
  if (candidates.length === 0) {
    return null;
  }
  if (childWanted) {
    const match = candidates.find((c) =>
      labelMatchesChild(c.labeled, childWanted),
    );
    if (match) {
      return match;
    }
    const unlabeled = candidates.find((c) => !c.labeled);
    return unlabeled ?? null;
  }
  const unlabeled = candidates.find((c) => !c.labeled);
  return unlabeled ?? candidates[0] ?? null;
}

/**
 * Read SmartSchool login fields from speaker filings.
 * Username + password always required; year required only when timetable asked
 * (checked in resolveSmartschoolReply).
 */
export function loadSmartschoolCredsFromFilings(
  filings: SmartschoolFilingRow[],
  opts?: { child?: string },
): { creds: SmartschoolCreds | null; missing: string[] } {
  const childWanted = normHe(opts?.child ?? "");
  let username = "";
  const passwords: Array<{ info: string; labeled: string }> = [];
  const years: Array<{ info: string; labeled: string }> = [];

  for (const row of filings) {
    const name = filingName(row);
    const info = filingInfo(row);
    if (!info || !isSmartschoolFilingName(name)) {
      continue;
    }
    const labeled = smartschoolFilingChildLabel(name);
    if (
      name.includes("שם משתמש") ||
      name.includes("מזהה") ||
      name.includes("תעודת זהות") ||
      name.includes("username") ||
      name.includes("user name")
    ) {
      username = info;
      continue;
    }
    if (name.includes("שנת לימודים") || name.includes("שנה")) {
      years.push({ info: info.replace(/\D/g, "") || info, labeled });
      continue;
    }
    if (name.includes("סיסמ") || name.includes("password")) {
      passwords.push({ info, labeled });
    }
  }

  const missing: string[] = [];
  if (!username) {
    missing.push("שם משתמש לסמארט סקול");
  }
  const passwordPick = pickFiledValue(passwords, childWanted);
  if (!passwordPick) {
    missing.push("סיסמת סמארט סקול");
  }
  const yearPick = pickFiledValue(years, childWanted);
  const yearNum = yearPick ? Number(yearPick.info) : NaN;
  const year =
    Number.isFinite(yearNum) && yearNum >= 2000 && yearNum <= 2100
      ? yearNum
      : null;

  if (missing.length > 0) {
    return { creds: null, missing };
  }
  return {
    creds: {
      username,
      password: passwordPick!.info,
      year,
      passwordChild: passwordPick!.labeled || undefined,
    },
    missing: [],
  };
}

export class SmartschoolLoginError extends Error {
  readonly kind: "auth" | "http" | "session" | "validation";
  readonly status?: number;

  constructor(
    message: string,
    kind: SmartschoolLoginError["kind"],
    status?: number,
  ) {
    super(message);
    this.name = "SmartschoolLoginError";
    this.kind = kind;
    this.status = status;
  }
}

function numField(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = row[key];
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function strField(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = row[key];
    if (v !== undefined && v !== null && String(v).trim()) {
      return String(v).trim();
    }
  }
  return "";
}

function sessionFromLoginData(
  token: string,
  data: Record<string, unknown>,
): SmartschoolSession {
  return {
    token,
    encryptedId: strField(data, ["id", "encryptedId", "studentID", "studentId"]),
    studentId: strField(data, ["studentId", "id", "userId"]),
    classCode: numField(data, ["ClassCode", "classCode", "class_code"]),
    classNumber: numField(data, [
      "ClassNumber",
      "classNumber",
      "class_number",
    ]),
    firstName: strField(data, ["firstName", "FirstName", "privateName"]),
    lastName: strField(data, ["lastName", "LastName", "familyName"]),
    schoolName: strField(data, ["schoolName", "SchoolName"]),
    rawLoginData: data,
  };
}

export async function smartschoolLogin(
  creds: SmartschoolCreds,
  fetchImpl: typeof fetch = fetch,
): Promise<SmartschoolSession> {
  const res = await fetchImpl(
    `${BASE}/server/api/user/LoginByUserNameAndPassword`,
    {
      method: "POST",
      headers: HEADERS_BASE,
      body: JSON.stringify({
        UserName: creds.username,
        Password: creds.password,
        Data: DEFAULT_LOGIN_DATA,
        RememberMe: false,
        BiometricLogin: "",
      }),
    },
  );
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new SmartschoolLoginError(
        `smartschool login HTTP ${res.status}`,
        "auth",
        res.status,
      );
    }
    throw new SmartschoolLoginError(
      `smartschool login HTTP ${res.status}`,
      "http",
      res.status,
    );
  }
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new SmartschoolLoginError(
      "smartschool login response not JSON",
      "session",
    );
  }
  if (body.status !== true) {
    throw new SmartschoolLoginError(
      `smartschool login status=false: ${String(body.errorDescription ?? "")}`,
      "auth",
    );
  }
  const data =
    body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : {};
  const token = strField(data, ["token"]);
  if (!token) {
    throw new SmartschoolLoginError(
      "smartschool login missing token",
      "session",
    );
  }
  return sessionFromLoginData(token, data);
}

async function smartschoolPostJson(
  session: SmartschoolSession,
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(`${BASE}${path}`, {
    method: "POST",
    headers: {
      ...HEADERS_BASE,
      Cookie: `webToken=${session.token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`smartschool POST ${path} HTTP ${res.status}`);
  }
  return res.json();
}

export async function smartschoolLinkedStudents(
  session: SmartschoolSession,
  fetchImpl: typeof fetch = fetch,
): Promise<SmartschoolChild[]> {
  try {
    const raw = await smartschoolPostJson(
      session,
      "/server/api/user/GetMultipleUsersForUser",
      {},
      fetchImpl,
    );
    const body = raw as Record<string, unknown>;
    if (body.status !== true) {
      return [];
    }
    const list = Array.isArray(body.data) ? body.data : [];
    return list
      .filter(
        (row): row is Record<string, unknown> =>
          Boolean(row && typeof row === "object" && !Array.isArray(row)),
      )
      .map((row) => ({
        studentId: strField(row, ["studentId", "StudentId", "id"]),
        login: strField(row, ["studentLogin", "login", "userName"]),
        firstName: strField(row, ["firstName", "FirstName", "privateName"]),
        lastName: strField(row, ["lastName", "LastName", "familyName"]),
      }))
      .filter((c) => c.studentId);
  } catch {
    return [];
  }
}

export async function smartschoolSwitchStudent(
  session: SmartschoolSession,
  studentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SmartschoolSession> {
  const raw = await smartschoolPostJson(
    session,
    "/server/api/user/ChangeUser",
    {
      StudentId: studentId,
      institutionCode: null,
      savedUser: "",
      userType: null,
    },
    fetchImpl,
  );
  const body = raw as Record<string, unknown>;
  if (body.status !== true) {
    throw new SmartschoolLoginError(
      "smartschool switch student failed",
      "session",
    );
  }
  const data =
    body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : {};
  const token = strField(data, ["token"]) || session.token;
  return sessionFromLoginData(token, { ...session.rawLoginData, ...data });
}

export function pickSmartschoolChild(
  children: SmartschoolChild[],
  childName?: string | null,
  current?: SmartschoolSession | null,
): { child: SmartschoolChild | null; askWhich: string[]; useCurrent: boolean } {
  const currentName = current
    ? normHe(`${current.firstName} ${current.lastName}`.trim())
    : "";
  const wanted = normHe(childName ?? "");

  if (children.length === 0) {
    if (!wanted || (current && currentName && (
      currentName === wanted ||
      currentName.includes(wanted) ||
      wanted.includes(normHe(current.firstName))
    ))) {
      return { child: null, askWhich: [], useCurrent: true };
    }
    if (current && !wanted) {
      return { child: null, askWhich: [], useCurrent: true };
    }
    return { child: null, askWhich: [], useCurrent: Boolean(current) };
  }

  if (!wanted) {
    if (children.length === 1) {
      return { child: children[0]!, askWhich: [], useCurrent: false };
    }
    return {
      child: null,
      askWhich: children.map((c) =>
        `${c.firstName}${c.lastName ? ` ${c.lastName}` : ""}`.trim() || c.login,
      ),
      useCurrent: false,
    };
  }

  const match =
    children.find((c) => normHe(c.firstName) === wanted) ||
    children.find((c) =>
      normHe(`${c.firstName} ${c.lastName}`).includes(wanted),
    ) ||
    children.find((c) => wanted.includes(normHe(c.firstName))) ||
    children.find((c) => normHe(c.login).includes(wanted));
  if (match) {
    return { child: match, askWhich: [], useCurrent: false };
  }
  if (
    current &&
    (currentName.includes(wanted) || wanted.includes(normHe(current.firstName)))
  ) {
    return { child: null, askWhich: [], useCurrent: true };
  }
  return {
    child: null,
    askWhich: children.map((c) =>
      `${c.firstName}${c.lastName ? ` ${c.lastName}` : ""}`.trim() || c.login,
    ),
    useCurrent: false,
  };
}

function asRecordArray(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    return raw.filter(
      (row): row is Record<string, unknown> =>
        Boolean(row && typeof row === "object" && !Array.isArray(row)),
    );
  }
  if (raw && typeof raw === "object") {
    const row = raw as Record<string, unknown>;
    for (const key of ["data", "items", "list", "messages", "homeWork", "homework"]) {
      const v = row[key];
      if (Array.isArray(v)) {
        return asRecordArray(v);
      }
    }
  }
  return [];
}

function str(row: Record<string, unknown>, keys: string[]): string {
  return strField(row, keys);
}

export function mapSmartschoolHomework(raw: unknown) {
  return asRecordArray(raw)
    .map((row) => ({
      subject: str(row, [
        "subjectName",
        "SubjectName",
        "subject",
        "lessonName",
        "name",
      ]),
      text: str(row, [
        "homeWork",
        "HomeWork",
        "homework",
        "text",
        "remark",
        "body",
        "description",
      ]),
      date: str(row, [
        "date",
        "Date",
        "lessonDate",
        "dueDate",
        "timestamp",
      ]),
    }))
    .filter((row) => row.text || row.subject);
}

export function normalizeHomework(
  raw: unknown,
  opts?: { range?: SmartschoolDateRange | null },
) {
  return applySmartschoolDateFilterSortCap(mapSmartschoolHomework(raw), {
    range: opts?.range ?? null,
    cap: 30,
  });
}

export function mapSmartschoolBehavior(raw: unknown) {
  return asRecordArray(raw)
    .map((row) => ({
      subject: str(row, [
        "subjectName",
        "SubjectName",
        "subject",
        "lessonName",
      ]),
      text: str(row, [
        "text",
        "remark",
        "eventName",
        "EventName",
        "type",
        "description",
        "diciplineEvent",
        "הערה",
      ]),
      date: str(row, ["date", "Date", "eventDate", "timestamp"]),
    }))
    .filter((row) => row.text || row.subject);
}

export function normalizeBehavior(
  raw: unknown,
  opts?: { range?: SmartschoolDateRange | null },
) {
  return applySmartschoolDateFilterSortCap(mapSmartschoolBehavior(raw), {
    range: opts?.range ?? null,
    cap: 30,
  });
}

export function mapSmartschoolMessages(raw: unknown) {
  return asRecordArray(raw)
    .map((row) => ({
      subject: str(row, ["subject", "Subject", "title", "Title"]),
      from: str(row, [
        "senderName",
        "SenderName",
        "from",
        "fromName",
        "sender",
      ]),
      date: str(row, ["date", "Date", "sendDate", "SendDate", "timestamp"]),
      preview: str(row, [
        "body",
        "preview",
        "snippet",
        "text",
        "message",
      ]).slice(0, 200),
    }))
    .filter((row) => row.subject || row.from || row.preview);
}

export function normalizeMessages(
  raw: unknown,
  opts?: { range?: SmartschoolDateRange | null },
) {
  return applySmartschoolDateFilterSortCap(mapSmartschoolMessages(raw), {
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
  const data = row.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    return unwrapTimetablePayload(data);
  }
  for (const key of [
    "timeTable",
    "timetable",
    "table",
    "lessons",
    "days",
    "schedule",
    "scheduale",
  ]) {
    const v = row[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

export function normalizeTimetable(raw: unknown) {
  const byDay = new Map<string, string[]>();
  for (const entry of unwrapTimetablePayload(raw)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const day =
      dayLabelFromUnknown(
        row.dayName ?? row.day ?? row.dayOfWeek ?? row.weekday ?? row["יום"],
      ) || "יום";
    const nestedLessons = [row.lessons, row.hours, row.periods].filter(
      Array.isArray,
    ) as unknown[][];
    if (nestedLessons.length > 0) {
      for (const arr of nestedLessons) {
        for (const lesson of arr) {
          if (!lesson || typeof lesson !== "object" || Array.isArray(lesson)) {
            continue;
          }
          const L = lesson as Record<string, unknown>;
          const time = str(L, ["hour", "time", "startTime", "lessonTime", "שעה"]);
          const subject = str(L, [
            "subjectName",
            "subject",
            "name",
            "lessonName",
            "מקצוע",
          ]);
          const teacher = str(L, ["teacherName", "teacher", "מורה"]);
          const room = str(L, ["room", "roomNum", "classRoom", "כיתה"]);
          const line = [time, subject, teacher, room].filter(Boolean).join(" · ");
          if (line) {
            const list = byDay.get(day) ?? [];
            list.push(line);
            byDay.set(day, list);
          }
        }
      }
      continue;
    }
    const time = str(row, ["hour", "time", "startTime", "lessonTime", "שעה"]);
    const subject = str(row, [
      "subjectName",
      "subject",
      "name",
      "lessonName",
      "מקצוע",
    ]);
    const teacher = str(row, ["teacherName", "teacher", "מורה"]);
    const room = str(row, ["room", "roomNum", "classRoom", "כיתה"]);
    const line = [time, subject, teacher, room].filter(Boolean).join(" · ");
    if (line) {
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

async function enrichSessionClass(
  session: SmartschoolSession,
  fetchImpl: typeof fetch,
): Promise<SmartschoolSession> {
  if (session.classCode != null && session.encryptedId) {
    return session;
  }
  try {
    const raw = await smartschoolPostJson(
      session,
      "/server/api/dashboard/InitDashboard",
      {},
      fetchImpl,
    );
    const body = raw as Record<string, unknown>;
    const data =
      body.data && typeof body.data === "object"
        ? (body.data as Record<string, unknown>)
        : body;
    const nested =
      Array.isArray(data)
        ? (data[0] as Record<string, unknown> | undefined)
        : data;
    if (!nested || typeof nested !== "object") {
      return session;
    }
    return {
      ...session,
      encryptedId:
        session.encryptedId ||
        strField(nested, ["id", "encryptedId", "studentID"]),
      classCode:
        session.classCode ??
        numField(nested, ["ClassCode", "classCode", "class_code"]),
      classNumber:
        session.classNumber ??
        numField(nested, ["ClassNumber", "classNumber", "class_number"]),
      firstName:
        session.firstName ||
        strField(nested, ["firstName", "FirstName", "privateName"]),
      lastName:
        session.lastName ||
        strField(nested, ["lastName", "LastName", "familyName"]),
    };
  } catch {
    return session;
  }
}

export async function fetchSmartschoolAspects(input: {
  session: SmartschoolSession;
  aspects: SmartschoolAspect[];
  year: number | null;
  fetchImpl?: typeof fetch;
  range?: SmartschoolDateRange | null;
}): Promise<Omit<SmartschoolFacts, "childName" | "missingCreds" | "error">> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const aspects = input.aspects;
  const range = input.range ?? null;
  const session = await enrichSessionClass(input.session, fetchImpl);
  const dateStats: SmartschoolFacts["dateStats"] = {};
  const encryptedId = session.encryptedId;
  const classCode = session.classCode ?? 0;
  const classNumber = session.classNumber ?? classCode;

  let homework: SmartschoolFacts["homework"] = [];
  if (aspects.includes("homework")) {
    try {
      const raw = await smartschoolPostJson(
        session,
        "/server/api/dashboard/GetHomeWork",
        {
          id: encryptedId,
          ClassCode: classCode,
          ClassNumber: classNumber,
        },
        fetchImpl,
      );
      const result = normalizeHomework(raw, { range });
      homework = result.rows;
      dateStats.homework = result.stats;
    } catch {
      homework = [];
      dateStats.homework = emptySmartschoolDateStats();
    }
  }

  let behavior: SmartschoolFacts["behavior"] = [];
  if (aspects.includes("behavior")) {
    try {
      const raw = await smartschoolPostJson(
        session,
        "/server/api/dashboard/GetPupilDiciplineEvents",
        {
          id: encryptedId,
          ClassCode: classCode,
        },
        fetchImpl,
      );
      const result = normalizeBehavior(raw, { range });
      behavior = result.rows;
      dateStats.behavior = result.stats;
    } catch {
      behavior = [];
      dateStats.behavior = emptySmartschoolDateStats();
    }
  }

  let timetable: SmartschoolFacts["timetable"] = [];
  if (aspects.includes("timetable")) {
    if (input.year == null) {
      // Caller should have asked for year; leave empty + missing handled upstream.
      timetable = [];
    } else {
      try {
        const raw = await smartschoolPostJson(
          session,
          "/server/api/PupilCard/GetPupilScheduale",
          {
            weekIndex: 0,
            viewType: 0,
            studyYear: input.year,
            studentID: encryptedId,
            classCode,
            moduleID: 10,
          },
          fetchImpl,
        );
        timetable = normalizeTimetable(raw);
      } catch {
        timetable = [];
      }
    }
  }

  let messages: SmartschoolFacts["messages"] = [];
  if (aspects.includes("messages")) {
    try {
      const raw = await smartschoolPostJson(
        session,
        "/server/api/messageBox/GetMessagesInbox",
        {
          PageId: 1,
          LabelId: 0,
          HasRead: null,
          SearchQuery: "",
        },
        fetchImpl,
      );
      const result = normalizeMessages(raw, { range });
      messages = result.rows;
      dateStats.messages = result.stats;
    } catch {
      // Fall back to unread notifications preview.
      try {
        const preview = await smartschoolPostJson(
          session,
          "/server/api/Menu/GetPreviewUnreadNotifications",
          {},
          fetchImpl,
        );
        const result = normalizeMessages(preview, { range });
        messages = result.rows;
        dateStats.messages = result.stats;
      } catch {
        messages = [];
        dateStats.messages = emptySmartschoolDateStats();
      }
    }
  }

  return {
    aspects,
    homework,
    behavior,
    timetable,
    messages,
    dateFrom: range?.dateFrom ?? null,
    dateTo: range?.dateTo ?? null,
    dateStats,
  };
}

function formatRangeLabel(facts: SmartschoolFacts): string {
  const from = facts.dateFrom?.trim() || "";
  const to = facts.dateTo?.trim() || "";
  if (from && to) {
    return from === to ? from : `${from}–${to}`;
  }
  if (from) return `מ־${from}`;
  if (to) return `עד ${to}`;
  return "";
}

function unclassifiedCount(stats?: SmartschoolDateStats): number {
  if (!stats) return 0;
  return stats.undated + stats.invalid;
}

function formatAspectEmptyLine(input: {
  label: string;
  who: string;
  rangeLabel: string;
  filtering: boolean;
  stats?: SmartschoolDateStats;
  emptyNoRange: string;
}): string {
  const whoBit = input.who ? ` ${input.who}` : "";
  const unclassified = unclassifiedCount(input.stats);
  if (!input.filtering) {
    return input.emptyNoRange;
  }
  if (unclassified > 0) {
    return `לא מצאתי ${input.label} עם תאריך תקין בטווח ${input.rangeLabel}${whoBit} — יש ${unclassified} רשומות בלי תאריך תקין שלא סווגו לטווח.`
      .replace(/\s+/g, " ")
      .trim();
  }
  const out = input.stats?.outOfRange ?? 0;
  if (out > 0) {
    return `אין ${input.label} בטווח ${input.rangeLabel}${whoBit} — יש ${out} רשומות מחוץ לטווח.`
      .replace(/\s+/g, " ")
      .trim();
  }
  return `אין ${input.label} בטווח ${input.rangeLabel}${whoBit}.`
    .replace(/\s+/g, " ")
    .trim();
}

export const SMARTSCHOOL_LOCAL_TRUNCATION_HE =
  "(מוצגים חלק מהרשומות — יש עוד שלא הוצגו בגלל מגבלת תצוגה.)";

export const SMARTSCHOOL_DISPLAY_CAPS = {
  homework: 10,
  behavior: 10,
  messages: 10,
} as const;

export const SMARTSCHOOL_UNSUPPORTED_HE =
  "בחיבור לסמארט סקול אין כרגע גישה לציונים או לחיסורים — אפשר לבדוק שיעורי בית, התנהגות, מערכת שעות והודעות.";

export const SMARTSCHOOL_INVALID_DATE_BOUNDS_HE =
  "לא הצלחתי להבין את טווח התאריכים. בדקו תאריך בפורמט YYYY-MM-DD (למשל 2025-01-31) ונסו שוב.";

function appendAspectNotes(
  lines: string[],
  stats: SmartschoolDateStats | undefined,
  filtering: boolean,
  rowCount: number,
  displayCap: number,
): void {
  const n = unclassifiedCount(stats);
  if (filtering && n > 0) {
    lines.push(`(שים לב: ${n} רשומות נוספות בלי תאריך תקין לא סווגו לטווח.)`);
  }
  if (isLocallyTruncated(stats, rowCount, displayCap)) {
    lines.push(SMARTSCHOOL_LOCAL_TRUNCATION_HE);
  }
}

export function formatSmartschoolHebrew(facts: SmartschoolFacts): string {
  if (facts.missingCreds.length > 0) {
    if (
      facts.missingCreds.length === 1 &&
      facts.missingCreds[0] === "שנת לימודים לסמארט סקול"
    ) {
      return "לאיזו שנת לימודים לבדוק בסמארט סקול? (למשל 2026)";
    }
    return `כדי לבדוק בסמארט סקול חסר לי: ${facts.missingCreds.join(", ")}. אחרי שתענה אשמור ואבדוק.`;
  }
  if (facts.error) {
    return facts.error;
  }
  const lines: string[] = [];
  const who = facts.childName ? `של ${facts.childName}` : "";
  const filtering = hasSmartschoolDateRange({
    dateFrom: facts.dateFrom ?? null,
    dateTo: facts.dateTo ?? null,
  });
  const rangeLabel = formatRangeLabel(facts) || "המבוקש";

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
      const cap = SMARTSCHOOL_DISPLAY_CAPS.homework;
      for (const h of facts.homework.slice(0, cap)) {
        lines.push(
          `• ${[h.subject, h.text, h.date.slice(0, 10)].filter(Boolean).join(" — ")}`,
        );
      }
      appendAspectNotes(lines, stats, filtering, facts.homework.length, cap);
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
      const cap = SMARTSCHOOL_DISPLAY_CAPS.behavior;
      for (const b of facts.behavior.slice(0, cap)) {
        lines.push(
          `• ${[b.subject, b.text, b.date.slice(0, 10)].filter(Boolean).join(" — ")}`,
        );
      }
      appendAspectNotes(lines, stats, filtering, facts.behavior.length, cap);
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
          emptyNoRange: "אין הודעות חדשות בסמארט סקול.",
        }),
      );
    } else {
      lines.push(
        filtering
          ? `הודעות בסמארט סקול בטווח ${rangeLabel}:`
          : "הודעות בסמארט סקול:",
      );
      const cap = SMARTSCHOOL_DISPLAY_CAPS.messages;
      for (const m of facts.messages.slice(0, cap)) {
        lines.push(
          `• ${[m.from, m.subject, m.preview, m.date.slice(0, 10)]
            .filter(Boolean)
            .join(" — ")}`,
        );
      }
      appendAspectNotes(lines, stats, filtering, facts.messages.length, cap);
    }
  }
  if (lines.length === 0) {
    return "לא מצאתי נתונים בסמארט סקול.";
  }
  return lines.join("\n");
}

type BoundClass =
  | { kind: "absent" }
  | { kind: "valid"; ymd: string }
  | { kind: "invalid" };

function classifyBound(raw: string | null | undefined): BoundClass {
  if (raw === null || raw === undefined) return { kind: "absent" };
  if (typeof raw !== "string") return { kind: "invalid" };
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "absent" };
  const ymd = trimmed.slice(0, 10);
  if (isValidCalendarYmd(ymd)) return { kind: "valid", ymd };
  return { kind: "invalid" };
}

export type SmartschoolReplyRangeResult =
  | { ok: true; range: SmartschoolDateRange }
  | { ok: false; notice: string };

export function resolveSmartschoolReplyRange(input: {
  dateFrom?: string | null;
  dateTo?: string | null;
  dateBoundsInvalid?: boolean;
}): SmartschoolReplyRangeResult {
  if (input.dateBoundsInvalid) {
    return { ok: false, notice: SMARTSCHOOL_INVALID_DATE_BOUNDS_HE };
  }
  const from = classifyBound(input.dateFrom);
  const to = classifyBound(input.dateTo);
  if (from.kind === "invalid" || to.kind === "invalid") {
    return { ok: false, notice: SMARTSCHOOL_INVALID_DATE_BOUNDS_HE };
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

export async function resolveSmartschoolReply(input: {
  filings: SmartschoolFilingRow[];
  child?: string | null;
  aspects?: SmartschoolAspect[] | unknown;
  dateFrom?: string | null;
  dateTo?: string | null;
  dateBoundsInvalid?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  if (smartschoolAspectsAllUnsupported(input.aspects)) {
    return SMARTSCHOOL_UNSUPPORTED_HE;
  }
  const aspects = parseSmartschoolAspects(input.aspects);
  const rangeResult = resolveSmartschoolReplyRange({
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    dateBoundsInvalid: input.dateBoundsInvalid,
  });
  if (!rangeResult.ok) {
    return rangeResult.notice;
  }
  const range = rangeResult.range;
  const loaded = loadSmartschoolCredsFromFilings(input.filings, {
    child: input.child ?? undefined,
  });
  const fetchImpl = input.fetchImpl ?? fetch;

  if (!loaded.creds) {
    return formatSmartschoolHebrew({
      childName: input.child?.trim() ?? "",
      aspects,
      homework: [],
      behavior: [],
      timetable: [],
      messages: [],
      missingCreds: loaded.missing,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
    });
  }

  const needsYear = aspects.includes("timetable");
  if (needsYear && loaded.creds.year == null) {
    return formatSmartschoolHebrew({
      childName: input.child?.trim() ?? "",
      aspects,
      homework: [],
      behavior: [],
      timetable: [],
      messages: [],
      missingCreds: ["שנת לימודים לסמארט סקול"],
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
    });
  }

  try {
    let session = await smartschoolLogin(loaded.creds, fetchImpl);
    const linked = await smartschoolLinkedStudents(session, fetchImpl);
    const picked = pickSmartschoolChild(linked, input.child, session);
    if (!picked.useCurrent && !picked.child && picked.askWhich.length > 1) {
      return `לאיזה ילד לבדוק בסמארט סקול — ${picked.askWhich.join(" או ")}?`;
    }
    if (!picked.useCurrent && !picked.child && picked.askWhich.length === 1) {
      // single listed but no match — fall through to switch that one? ask.
      return `לא מצאתי ילד בשם «${input.child}». אצלך: ${picked.askWhich.join(", ")}.`;
    }
    if (!picked.useCurrent && !picked.child && input.child?.trim()) {
      return `לא מצאתי ילד בשם «${input.child}».`;
    }
    if (picked.child) {
      session = await smartschoolSwitchStudent(
        session,
        picked.child.studentId,
        fetchImpl,
      );
    }
    const data = await fetchSmartschoolAspects({
      session,
      aspects,
      year: loaded.creds.year,
      fetchImpl,
      range,
    });
    const childName =
      `${session.firstName}${session.lastName ? ` ${session.lastName}` : ""}`.trim() ||
      (picked.child
        ? `${picked.child.firstName}${picked.child.lastName ? ` ${picked.child.lastName}` : ""}`.trim()
        : input.child?.trim() || "");
    return formatSmartschoolHebrew({
      childName,
      missingCreds: [],
      ...data,
    });
  } catch (error) {
    if (error instanceof SmartschoolLoginError && error.kind === "auth") {
      return "פרטי ההתחברות לסמארט סקול לא התקבלו. בדוק שם משתמש וסיסמה בתיוקים.";
    }
    if (error instanceof SmartschoolLoginError && error.kind === "session") {
      return "ההתחברות לסמארט סקול לא הושלמה. נסה שוב בעוד רגע.";
    }
    return "לא הצלחתי להתחבר לסמארט סקול עכשיו. בדוק שם משתמש וסיסמה בתיוקים, ונסה שוב.";
  }
}
