import { jerusalemYmd } from "../utils/relative-date.js";

export type MashovAspect =
  | "grades"
  | "homework"
  | "behavior"
  | "timetable";

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

export type MashovFacts = {
  childName: string;
  aspects: MashovAspect[];
  grades: Array<{ subject: string; grade: string; date: string; type: string }>;
  homework: Array<{ subject: string; text: string; date: string }>;
  behavior: Array<{ subject: string; text: string; date: string }>;
  timetable: Array<{ day: string; lessons: string }>;
  missingCreds: string[];
  error?: string;
};

const BASE = "https://web.mashov.info/api";
const ASPECT_SET = new Set<MashovAspect>([
  "grades",
  "homework",
  "behavior",
  "timetable",
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
      .toLowerCase() as MashovAspect;
    const mapped =
      key === "behave" || key === "behaviour"
        ? ("behavior" as MashovAspect)
        : key === "schedule" || key === "מערכת"
          ? ("timetable" as MashovAspect)
          : key === "ציונים"
            ? ("grades" as MashovAspect)
            : key === "שיעורי בית" || key === "שעורים"
              ? ("homework" as MashovAspect)
              : key;
    if (ASPECT_SET.has(mapped) && !out.includes(mapped)) {
      out.push(mapped);
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
  // School year starts around August/September.
  return month >= 8 ? year + 1 : year;
}

/**
 * Read Mashov login fields from speaker filings (model-saved conventions).
 * Does not parse the user utterance — only DB filing rows.
 */
export function loadMashovCredsFromFilings(
  filings: MashovFilingRow[],
  opts?: { child?: string; now?: Date },
): { creds: MashovCreds | null; missing: string[] } {
  const childWanted = normHe(opts?.child ?? "");
  let username = "";
  let password = "";
  let passwordChild = "";
  let semelRaw = "";
  let yearRaw = "";

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
  if (!semelRaw) {
    missing.push("סמל בית ספר למשוב");
  }
  if (missing.length > 0) {
    return { creds: null, missing };
  }

  const semel = Number(semelRaw);
  const year = yearRaw
    ? Number(yearRaw)
    : defaultMashovYear(opts?.now);
  if (!Number.isFinite(semel) || semel <= 0) {
    return { creds: null, missing: ["סמל בית ספר למשוב (מספר תקין)"] };
  }
  if (!Number.isFinite(year) || year < 2000) {
    return { creds: null, missing: ["שנת לימודים למשוב"] };
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

export async function mashovLogin(
  creds: MashovCreds,
  fetchImpl: typeof fetch = fetch,
): Promise<MashovSession> {
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
    throw new Error(`mashov login HTTP ${res.status}`);
  }
  const csrf =
    res.headers.get("x-csrf-token") ||
    res.headers.get("X-Csrf-Token") ||
    "";
  const cookieHeader = cookieHeaderFromResponse(res);
  if (!csrf || !cookieHeader) {
    throw new Error("mashov login missing csrf/cookies");
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

export function normalizeGrades(raw: unknown) {
  return asRecordArray(raw)
    .map((row) => ({
      subject: str(row, ["subjectName", "subject", "groupName", "שם מקצוע"]),
      grade: str(row, ["grade", "gradeText", "ציון"]),
      date: str(row, ["eventDate", "date", "gradingEventDate", "תאריך"]),
      type: str(row, ["gradingEvent", "gradingType", "type", "סוג"]),
    }))
    .filter((row) => row.subject || row.grade)
    .slice(0, 40);
}

export function normalizeHomework(raw: unknown) {
  return asRecordArray(raw)
    .map((row) => ({
      subject: str(row, ["subjectName", "subject", "groupName"]),
      text: str(row, ["homework", "remark", "text", "body", "שיעורי בית"]),
      date: str(row, ["date", "lessonDate", "timestamp"]),
    }))
    .filter((row) => row.text || row.subject)
    .slice(0, 30);
}

export function normalizeBehavior(raw: unknown) {
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
    .filter((row) => row.text || row.subject)
    .slice(0, 30);
}

export function normalizeTimetable(raw: unknown) {
  const rows = asRecordArray(raw);
  // Mashov timetable is often nested; flatten best-effort.
  const byDay = new Map<string, string[]>();
  for (const row of rows) {
    const day = str(row, ["dayName", "day", "יום"]) || "יום";
    const time = str(row, ["timeTableTime", "hour", "lesson", "שעה"]);
    const subject = str(row, ["subjectName", "subject", "groupName", "מקצוע"]);
    const teacher = str(row, ["teacherName", "teacher"]);
    const line = [time, subject, teacher].filter(Boolean).join(" · ");
    if (!line) {
      continue;
    }
    const list = byDay.get(day) ?? [];
    list.push(line);
    byDay.set(day, list);
  }
  return [...byDay.entries()]
    .map(([day, lessons]) => ({
      day,
      lessons: lessons.slice(0, 12).join("; "),
    }))
    .slice(0, 7);
}

export async function fetchMashovAspects(input: {
  session: MashovSession;
  childGuid: string;
  aspects: MashovAspect[];
  fetchImpl?: typeof fetch;
}): Promise<Omit<MashovFacts, "childName" | "missingCreds" | "error">> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const aspects = input.aspects;
  const base = `/students/${encodeURIComponent(input.childGuid)}`;
  const grades = aspects.includes("grades")
    ? normalizeGrades(await mashovGetJson(input.session, `${base}/grades`, fetchImpl))
    : [];
  const homework = aspects.includes("homework")
    ? normalizeHomework(
        await mashovGetJson(input.session, `${base}/homework`, fetchImpl),
      )
    : [];
  const behavior = aspects.includes("behavior")
    ? normalizeBehavior(
        await mashovGetJson(input.session, `${base}/behave`, fetchImpl),
      )
    : [];
  const timetable = aspects.includes("timetable")
    ? normalizeTimetable(
        await mashovGetJson(input.session, `${base}/timetable`, fetchImpl),
      )
    : [];
  return { aspects, grades, homework, behavior, timetable };
}

export function formatMashovHebrew(facts: MashovFacts): string {
  if (facts.missingCreds.length > 0) {
    return `כדי לבדוק במשוב חסר לי: ${facts.missingCreds.join(", ")}. שמור אותם בתיוק ואנסה שוב.`;
  }
  if (facts.error) {
    return facts.error;
  }
  const lines: string[] = [];
  const who = facts.childName ? `של ${facts.childName}` : "";
  if (facts.aspects.includes("grades")) {
    if (facts.grades.length === 0) {
      lines.push(`אין ציונים חדשים ${who}.`.replace(/\s+/g, " ").trim());
    } else {
      lines.push(`ציונים ${who}:`.trim());
      for (const g of facts.grades.slice(0, 15)) {
        const bits = [g.subject, g.grade, g.type, g.date.slice(0, 10)].filter(
          Boolean,
        );
        lines.push(`• ${bits.join(" — ")}`);
      }
    }
  }
  if (facts.aspects.includes("homework")) {
    if (facts.homework.length === 0) {
      lines.push(`אין שיעורי בית ${who}.`.replace(/\s+/g, " ").trim());
    } else {
      lines.push(`שיעורי בית ${who}:`.trim());
      for (const h of facts.homework.slice(0, 10)) {
        lines.push(
          `• ${[h.subject, h.text, h.date.slice(0, 10)].filter(Boolean).join(" — ")}`,
        );
      }
    }
  }
  if (facts.aspects.includes("behavior")) {
    if (facts.behavior.length === 0) {
      lines.push(`אין אירועי התנהגות ${who}.`.replace(/\s+/g, " ").trim());
    } else {
      lines.push(`התנהגות ${who}:`.trim());
      for (const b of facts.behavior.slice(0, 10)) {
        lines.push(
          `• ${[b.subject, b.text, b.date.slice(0, 10)].filter(Boolean).join(" — ")}`,
        );
      }
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
  if (lines.length === 0) {
    return "לא מצאתי נתונים במשוב.";
  }
  return lines.join("\n");
}

export async function resolveMashovReply(input: {
  filings: MashovFilingRow[];
  child?: string | null;
  aspects?: MashovAspect[] | unknown;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const aspects = parseMashovAspects(input.aspects);
  const { creds, missing } = loadMashovCredsFromFilings(input.filings, {
    child: input.child ?? undefined,
    now: input.now,
  });
  if (!creds) {
    return formatMashovHebrew({
      childName: input.child?.trim() ?? "",
      aspects,
      grades: [],
      homework: [],
      behavior: [],
      timetable: [],
      missingCreds: missing,
    });
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const session = await mashovLogin(creds, fetchImpl);
    const picked = pickMashovChild(session.children, input.child);
    if (!picked.child) {
      if (picked.askWhich.length > 1) {
        return `לאיזה ילד לבדוק במשוב — ${picked.askWhich.join(" או ")}?`;
      }
      if (picked.askWhich.length === 0) {
        return "ההתחברות למשוב הצליחה אבל לא מצאתי ילדים בחשבון.";
      }
      return `לא מצאתי ילד בשם «${input.child}». אצלך: ${picked.askWhich.join(", ")}.`;
    }
    const data = await fetchMashovAspects({
      session,
      childGuid: picked.child.guid,
      aspects,
      fetchImpl,
    });
    const childName =
      `${picked.child.privateName}${picked.child.familyName ? ` ${picked.child.familyName}` : ""}`.trim();
    return formatMashovHebrew({
      childName,
      missingCreds: [],
      ...data,
    });
  } catch {
    return "לא הצלחתי להתחבר למשוב עכשיו. בדוק תעודת זהות, סיסמה וסמל בית ספר בתיוקים, ונסה שוב.";
  }
}
