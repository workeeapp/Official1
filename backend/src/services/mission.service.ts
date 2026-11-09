import type { Mission, Prisma } from "@prisma/client";
import type { LlmMissionAction, PublicEmployee } from "@workee/shared";
import {
  isAccountOwner,
  isGuestEmployee,
  MISSION_EXECUTOR_NAME,
} from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { resolveRelativeDateLabel } from "../utils/relative-date.js";
import { recordAuditEvent } from "./audit.service.js";
import { MISSION_EXECUTOR_INSTRUCTIONS } from "./mission-executor-prompt.js";
import { listVaultMetaForSpeaker } from "./mission-vault.js";
import {
  runMissionTool,
  toolRequiresApproval,
  WEB_SEARCH_TOOL,
} from "./mission-tools/index.js";
import { clearBrowserSession } from "./mission-tools/browser.js";

/** Mission executor model (not Lucy). Synced on ensureMissionExecutor. */
export const MISSION_EXECUTOR_MODEL = "gpt-6-luna";

export const ACTIVE_MISSION_STATUSES = [
  "open",
  "planning",
  "waiting_plan_approval",
  "waiting_user",
  "waiting_approval",
  "running",
] as const;

export type ActiveMissionStatus = (typeof ACTIVE_MISSION_STATUSES)[number];

const TERMINAL = new Set(["done", "failed", "cancelled"]);

export type ActiveMissionFact = {
  mission_id: string;
  goal: string;
  success_criteria: string;
  status: string;
  last_summary: string;
  waiting_on: string;
  plan_steps: string[];
  plan_approved: boolean;
  tracking_item_id: string | null;
};

export async function ensureMissionExecutor(
  userId: string,
  teamId?: string | null,
): Promise<{ id: string }> {
  const existing = await prisma.employee.findFirst({
    where: {
      userId,
      kind: "digital",
      OR: [
        { isExecutor: true },
        { name: MISSION_EXECUTOR_NAME },
        { nickname: MISSION_EXECUTOR_NAME },
      ],
    },
  });
  if (existing) {
    await prisma.employee.update({
      where: { id: existing.id },
      data: {
        isExecutor: true,
        // Keep executor prompt + model in sync with code — runner also injects file instructions.
        instructions: MISSION_EXECUTOR_INSTRUCTIONS,
        model: MISSION_EXECUTOR_MODEL,
      },
    });
    return { id: existing.id };
  }

  const team =
    teamId ??
    (
      await prisma.team.findFirst({
        where: { userId },
        orderBy: { createdAt: "asc" },
      })
    )?.id;
  if (!team) {
    throw new Error("Cannot seed mission executor without a team");
  }

  const created = await prisma.employee.create({
    data: {
      userId,
      teamId: team,
      kind: "digital",
      isProtected: false,
      isGuest: false,
      isExecutor: true,
      name: MISSION_EXECUTOR_NAME,
      surname: "",
      nickname: MISSION_EXECUTOR_NAME,
      model: MISSION_EXECUTOR_MODEL,
      temperature: 0.2,
      instructions: MISSION_EXECUTOR_INSTRUCTIONS,
    },
  });
  return { id: created.id };
}

function planStepsOf(mission: Mission): string[] {
  const plan = mission.plan;
  if (!Array.isArray(plan)) {
    return [];
  }
  return plan
    .map((step) => (typeof step === "string" ? step : ""))
    .filter(Boolean);
}

export function planIsApproved(
  mission: Pick<Mission, "planApprovedAt" | "planUpdatedAt">,
): boolean {
  if (!mission.planApprovedAt || !mission.planUpdatedAt) {
    return false;
  }
  return mission.planApprovedAt.getTime() >= mission.planUpdatedAt.getTime();
}

/** What the runner should do when the executor emits no missions actions. */
export function emptyMissionTurnPolicy(
  mission: Pick<Mission, "status" | "planApprovedAt" | "planUpdatedAt">,
): "bootstrap_plan" | "continue_tools" | "retry" {
  if (mission.status === "planning" || mission.status === "open") {
    return "bootstrap_plan";
  }
  const approved =
    !!mission.planApprovedAt &&
    !!mission.planUpdatedAt &&
    mission.planApprovedAt.getTime() >= mission.planUpdatedAt.getTime();
  // Approved / running: handle extract/stalls — never force a site navigate.
  if (mission.status === "running" || mission.status === "pending" || approved) {
    return "continue_tools";
  }
  return "retry";
}

/** Buy-shaped goals — used only for product-line matching, not URL routing. */
const SHOPPING_GOAL_RE =
  /תקנ[יהו]?|לקנות|קניות|לרכוש|הזמנה|קורקינט|חינה/u;

/** True when the mission goal is a purchase / shopping ask. */
export function isShoppingGoal(goal: string): boolean {
  return SHOPPING_GOAL_RE.test(goal.trim());
}

/** High-level mission shape — language signals only, never site names. */
export type MissionShape = "fact" | "options" | "portal" | "generic";

export function inferMissionShape(goal: string): MissionShape {
  const g = goal.trim();
  if (
    /בדיק(?:ות|ה)?|מעבד|חשבון|בנק|יתר(?:ה|ת)?|קופת\s*חולים|תור\s+ל|lab\s*result|account\s*balance|statement/iu.test(
      g,
    )
  ) {
    return "portal";
  }
  if (
    isShoppingGoal(g) ||
    /מלון|מלונות|טיסה|טיסות|hotel|flight|הזמנ|להשוות|אפשרויות/iu.test(g)
  ) {
    return "options";
  }
  if (
    /תוצא|נגמר|מי\s*ניצח|livescore|final\s*score|משחק|כדורגל|score/iu.test(g)
  ) {
    return "fact";
  }
  return "generic";
}

export function isOptionsFindGoal(goal: string): boolean {
  return inferMissionShape(goal) === "options";
}

export function isPortalMissionGoal(goal: string): boolean {
  return inferMissionShape(goal) === "portal";
}

export function isFactMissionGoal(goal: string): boolean {
  return inferMissionShape(goal) === "fact";
}

/** Speaker chat that must NOT auto-resume a parked mission. */
export function isNonMissionAnswerText(text: string): boolean {
  const t = text.trim();
  if (!t) {
    return true;
  }
  // Inventory / cancel — not answers to ask_user. Bare כן/לא ARE valid mission answers.
  return /^(מה יש לך|מה יש|הציגי?\s+משימות|הצג\s+משימות|מעקבים|סטטוס(?:\s|$)|מה\s+קורה עם|תמחקי|תבטלי(?:\s|$)|בטל משימה)/iu.test(
    t,
  );
}

/** True when speaker text looks like credentials / OTP, not a new search clue. */
export function looksLikeCredentialAnswer(text: string): boolean {
  const t = text.trim();
  if (!t) {
    return false;
  }
  if (/otp|קוד\s*חד|חד[\s-]?פעמי|2fa|סיסמ|password|username|משתמש|ת\.?\s*ז\.?|תעודת/iu.test(t)) {
    return true;
  }
  // Short opaque tokens / user:pass patterns.
  if (/^\S{3,64}([:：]\S{3,64})?$/u.test(t) && !/\s{2,}/u.test(t)) {
    return /[:：]|@|\d{5,}/u.test(t);
  }
  return false;
}

export function missionAwaitingCredentials(contextFacts: unknown): boolean {
  if (!Array.isArray(contextFacts)) {
    return false;
  }
  for (let i = contextFacts.length - 1; i >= 0; i -= 1) {
    const row = contextFacts[i];
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const fact = row as Record<string, unknown>;
    if (fact.awaiting_credentials === true) {
      return true;
    }
    if (fact.continue_on_host === true) {
      return false;
    }
  }
  return false;
}

/** Drop awaiting_credentials markers; keep other facts. */
export function clearAwaitingCredentials(contextFacts: unknown): unknown[] {
  if (!Array.isArray(contextFacts)) {
    return [];
  }
  return contextFacts.filter((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return true;
    }
    return (row as Record<string, unknown>).awaiting_credentials !== true;
  });
}

/** Speaker answers that belong in the Bing query (skip inventory / meta noise). */
export function isSearchableSpeakerFact(text: string): boolean {
  const t = text.trim();
  if (!t || t === "(empty reply)") {
    return false;
  }
  if (isNonMissionAnswerText(t)) {
    return false;
  }
  if (looksLikeCredentialAnswer(t)) {
    return false;
  }
  if (t.length > 200) {
    return false;
  }
  return true;
}

/** Strip Hebrew niqqud so 404 titles still match plain regexes. */
export function stripHebrewNikud(text: string): string {
  return text.replace(/[\u0591-\u05C7]/gu, "");
}

/** Dead / error pages — skip and try the next SERP URL. */
export function extractLooksLikeDeadPage(text: string): boolean {
  const raw = text || "";
  // Playwright/browser extract reported zero payload.
  if (/\(\s*0\s*chars?\)/i.test(raw)) {
    return true;
  }
  const body = extractTextFromToolSummary(raw);
  const bodyFlat = stripHebrewNikud(body).replace(/\s+/g, " ").trim();
  if (!bodyFlat) {
    return true;
  }
  const t = stripHebrewNikud(bodyFlat || raw)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (t.length < 20) {
    return true;
  }
  // Summary chrome only — no real page text after "Extracted …:".
  if (/^extracted\s+\w+/i.test(raw) && bodyFlat.length < 20) {
    return true;
  }
  return (
    /page not found|404\b|שגיאת\s*404|דף לא נמצא|הדף לא נמצא|cannot\s+get\b|not\s+found/i.test(
      t,
    ) || /chrome-error:|about:blank/i.test(t)
  );
}

/**
 * Bing often truncates crumbs to `/item` / `/article` with no slug — those 404.
 * Generic path-shape check, not a site list.
 */
export function looksLikeTruncatedSerpPath(url: string): boolean {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/u, "") || "/";
    if (
      /^\/(item|article|articles|post|posts|news|page|pages|story|id)$/i.test(
        path,
      )
    ) {
      return true;
    }
    // Bare CMS endpoint with no article id/query (Bing truncated crumb).
    if (/\/articles\.aspx$/i.test(path) && ![...u.searchParams.keys()].length) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Hub/template paths that need a missing id/slug (generic — any sports/catalog site).
 * e.g. `/football/team/matches` without a team segment.
 */
export function looksLikeGenericHubPath(url: string): boolean {
  if (looksLikeTruncatedSerpPath(url)) {
    return true;
  }
  try {
    const path = new URL(url).pathname.replace(/\/+$/u, "") || "/";
    if (/\/team\/matches$/i.test(path)) {
      return true;
    }
    if (/\/football\/team$/i.test(path)) {
      return true;
    }
    if (/\/match\/?$/i.test(path)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Visible past/results control on a fixtures page (language cues only — no site list).
 * Used when a fact goal needs yesterday/past and the extract still shows upcoming only.
 */
export function pastResultsControlLabel(extractText: string): string | null {
  const t = stripHebrewNikud(extractText);
  const m = t.match(
    /משחקים קודמים|תוצאות קודמות|תוצאות אחרונות|previous\s+matches|past\s+results|recent\s+results|results\s+history/iu,
  );
  return m?.[0]?.trim() || null;
}

/**
 * Football/result score — not a clock time like 15:00 / 20:30,
 * and not stadium gate numbers like 10-11.
 * Accepts 2-1, 2–1, 0-4, or 2:1 (single-digit side atypical for HH:MM).
 */
export function textLooksLikeMatchScore(text: string): boolean {
  const t = stripHebrewNikud(text);
  for (const m of t.matchAll(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/gu)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    // Classic football scores are small; both ≥10 is usually gates/sections.
    if (a <= 9 && b <= 9) {
      return true;
    }
  }
  for (const m of t.matchAll(/\b(\d{1,2})\s*:\s*(\d{1,2})\b/gu)) {
    const left = m[1] ?? "";
    const right = m[2] ?? "";
    const a = Number(left);
    const b = Number(right);
    // HH:MM clock (two-digit minutes 00–59, hour 0–23) — not a score.
    if (right.length === 2 && b <= 59 && a <= 23) {
      continue;
    }
    if (a <= 9 && b <= 9) {
      return true;
    }
  }
  return false;
}

/**
 * True when extract already answers a fact goal with an evidenced score
 * (team/entity tokens + match score). Win/loss promo blurbs alone are not enough —
 * those caused false «complete» pressure on SERP before digging.
 */
export function serpLooksLikeFactAnswer(goal: string, extractText: string): boolean {
  if (!isFactMissionGoal(goal)) {
    return false;
  }
  const text = stripHebrewNikud(extractText);
  if (!extractMatchesGoal(goal, text)) {
    return false;
  }
  return textLooksLikeMatchScore(text);
}

/**
 * Soft rank for a SERP line+URL — goal/snippet signals only (no site allowlists).
 * Higher is better.
 */
export function scoreSerpCandidate(
  goal: string,
  line: string,
  url: string,
): number {
  const shape = inferMissionShape(goal);
  const blob = `${line} ${url}`.toLowerCase();
  let score = extractMatchesGoal(goal, line) ? 4 : 0;
  if (/\/404\b|page[_-]?not[_-]?found|itunes\.apple|play\.google|apps\.apple/i.test(url)) {
    score -= 20;
  }
  if (looksLikeGenericHubPath(url) || looksLikeTruncatedSerpPath(url)) {
    score -= 25;
  }
  if (/מומחה|בלוג|blog|wordpress|מדריך ל|טיפים ל/iu.test(blob) && shape === "options") {
    score -= 6;
  }
  if (shape === "options") {
    if (/הזמנ|מלון|מלונות|טיסה|check[\s-]?in|price|מחיר|₪|\$|booking|hotels?/iu.test(blob)) {
      score += 5;
    }
  }
  if (shape === "fact") {
    if (/תוצא|livescore|משחק|fixtures|לוח משחקים|final|1\s*[:\-]\s*\d/iu.test(blob)) {
      score += 5;
    }
    // Prefer a concrete match URL over a team hub.
    if (/\/match\//i.test(url)) {
      score += 4;
    }
  }
  if (shape === "portal") {
    if (/כניסה|login|sign[\s-]?in|און[־\-]ליין|online|אזור אישי|personal/iu.test(blob)) {
      score += 5;
    }
  }
  // Prefer deeper paths over bare marketing homepages when both match.
  try {
    const path = new URL(url).pathname.replace(/\/+$/u, "");
    if (path.length > 1) {
      score += 1;
    }
  } catch {
    // ignore
  }
  return score;
}

/** Search-engine hosts — SERP pages, not destination portals. */
export function isSearchEngineHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return (
    h === "bing.com" ||
    h.endsWith(".bing.com") ||
    h === "google.com" ||
    h.endsWith(".google.com") ||
    h.includes("duckduckgo") ||
    h === "search.yahoo.com" ||
    h.endsWith(".yahoo.com")
  );
}

type RankedUrl = { url: string; score: number; line: string };

function parseCandidateUrl(raw: string): string | null {
  return (
    normalizeSerpDisplayUrl(raw) ??
    (() => {
      try {
        const u = new URL(raw.replace(/[),.;]+$/u, ""));
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          return null;
        }
        return u.toString();
      } catch {
        return null;
      }
    })()
  );
}

/**
 * Destination URLs from goal-matching SERP/option lines (search engines skipped).
 * Ranked by {@link scoreSerpCandidate} — caller may try the next URL if navigate fails.
 */
export function topRelevantResultUrls(
  goal: string,
  extractText: string,
  limit = 3,
): string[] {
  const matched = relevantOptionLinesFromExtract(goal, extractText);
  const lineCandidates =
    matched.length > 0
      ? matched
      : extractText
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && extractMatchesGoal(goal, l));
  const ranked: RankedUrl[] = [];
  const seen = new Set<string>();
  const consider = (line: string, rawUrl: string) => {
    const url = parseCandidateUrl(rawUrl);
    if (!url) {
      return;
    }
    const host = hostFromUrlOrSummary(url);
    if (!host || isSearchEngineHost(host)) {
      return;
    }
    // Hub/truncated paths never dig — they need a missing id/slug.
    if (looksLikeGenericHubPath(url)) {
      return;
    }
    const key = url.replace(/\/+$/u, "").toLowerCase();
    if (seen.has(key)) {
      return;
    }
    const score = scoreSerpCandidate(goal, line, url);
    if (score < -5) {
      return;
    }
    seen.add(key);
    ranked.push({ url, score, line });
  };
  for (const line of lineCandidates) {
    const fromLine = normalizeSerpDisplayUrl(line);
    if (fromLine) {
      consider(line, fromLine);
    }
  }
  const bare = extractText.match(/https?:\/\/[^\s<>"')\]]+/giu) ?? [];
  for (const raw of bare) {
    const idx = extractText.indexOf(raw);
    const window = extractText.slice(
      Math.max(0, idx - 80),
      Math.min(extractText.length, idx + raw.length + 80),
    );
    consider(window, raw);
  }
  ranked.sort((a, b) => b.score - a.score);
  const out = ranked.slice(0, limit).map((r) => r.url);
  // Last-resort origins for the top hits (deep Bing crumbs often 404).
  const withOrigins = [...out];
  for (const url of out) {
    try {
      const origin = `${new URL(url).origin}/`;
      const key = origin.replace(/\/+$/u, "").toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      withOrigins.push(origin);
    } catch {
      // ignore
    }
  }
  return withOrigins.slice(0, Math.max(limit, out.length) + 2);
}

/** First destination URL from {@link topRelevantResultUrls}. */
export function topRelevantResultUrl(
  goal: string,
  extractText: string,
): string | null {
  return topRelevantResultUrls(goal, extractText, 1)[0] ?? null;
}

/**
 * Pull a navigable URL from a SERP line. Bing often shows
 * `https://host › path › seg` with spaces around › — rebuild as https://host/path/seg.
 * Stops before ellipsis crumbs (`…` / `...`) that mark truncated Bing paths.
 */
export function normalizeSerpDisplayUrl(line: string): string | null {
  const m = line.match(
    /https?:\/\/[^\s<>"')\]]+(?:\s*›\s*[A-Za-z0-9._~/-]+)*/iu,
  );
  if (!m?.[0]) {
    return null;
  }
  let raw = m[0].replace(/[),.;]+$/u, "");
  if (/\s*›\s*/u.test(raw)) {
    const parts = raw
      .split(/\s*›\s*/u)
      .map((p) => p.trim())
      .filter(Boolean);
    const base = (parts[0] || "").replace(/\/+$/u, "");
    if (!/^https?:\/\//i.test(base)) {
      return null;
    }
    const segs: string[] = [];
    for (const part of parts.slice(1)) {
      const p = part.replace(/^\/+|\/+$/gu, "");
      // Bing marks truncated crumbs with … / ... — stop before incomplete tails.
      if (!p || p === "..." || p === "…" || p.includes("...")) {
        break;
      }
      segs.push(p);
    }
    raw = segs.length > 0 ? `${base}/${segs.join("/")}` : base;
  }
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return null;
    }
    return u.toString();
  } catch {
    return null;
  }
}

/** True when browse so far only touched search engines (no destination dig yet). */
export function stillOnSearchEngineOnly(
  toolResults: MissionToolResultFact[],
): boolean {
  const hosts = distinctHostsFromToolResults(toolResults);
  if (hosts.length === 0) {
    return true;
  }
  return hosts.every((h) => isSearchEngineHost(h));
}

/** Generic Bing search URL from a query string (model-driven browse start). */
export function bingSearchUrl(query: string): string {
  const q = query.trim() || "search";
  return `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=he`;
}

/** Query string for web search — strips speaker-filler noise; goal display text unchanged. */
export function searchQueryFromGoal(goal: string): string {
  let q = goal.trim().replace(/\s+/g, " ");
  if (!q) {
    return "search";
  }
  q = q.replace(/^לבצע:\s*/u, "");
  // Drop «לעמית» / «עבור X» style speaker tags that dilute shopping/gov search.
  q = q.replace(/\s*לעמית\s*/gu, " ");
  // Drop imperatives / infinitives / fillers so Zap/Bing get the product/service noun.
  q = q.replace(
    /(?:^|\s)(תקני|תקנה|תקנו|לקנות|לרכוש|קניות|תקבעי|תקבע|לקבוע|תבטלי|תבטל|לבטל|תחפשי|תחפש|תבדקי|תבדוק|לבדוק|למצוא|מתאים|מתאימה|לי|שלי|בבקשה|כמה\s+נגמר|מה\s+מצב|מצב\s+החשבון)(?=\s|$)/gu,
    " ",
  );
  q = q.replace(/\s+/g, " ").trim();
  return q || goal.trim() || "search";
}

/**
 * Search query from mission goal + latest speaker answers in context_facts.
 * Skips inventory/meta noise and credentials (those stay on-host).
 */
export function searchQueryFromMission(input: {
  goal: string;
  contextFacts?: unknown;
  now?: Date;
}): string {
  const base = searchQueryFromGoal(input.goal);
  const facts = Array.isArray(input.contextFacts) ? input.contextFacts : [];
  const extras: string[] = [];
  for (const row of facts.slice(-8)) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const rec = row as Record<string, unknown>;
    if (rec.source !== "speaker") {
      continue;
    }
    const text = typeof rec.text === "string" ? rec.text.trim() : "";
    if (isSearchableSpeakerFact(text)) {
      extras.push(text);
    }
  }
  // Pin relative day words to Asia/Jerusalem calendar dates for hosted search.
  // Note: JS \b is ASCII-only — use includes / unicode-aware checks for Hebrew.
  const now = input.now ?? new Date();
  const goal = input.goal;
  if (/אתמול|yesterday/iu.test(goal)) {
    extras.push(resolveRelativeDateLabel("אתמול", now));
  } else if (/(^|[^\p{L}])היום([^\p{L}]|$)|today/iu.test(goal)) {
    extras.push(resolveRelativeDateLabel("היום", now));
  } else if (/מחר|tomorrow/iu.test(goal)) {
    extras.push(resolveRelativeDateLabel("מחר", now));
  }
  const merged = [base, ...extras.slice(-4)].join(" ").replace(/\s+/g, " ").trim();
  return merged || base || "search";
}

export type MissionToolResultFact = {
  tool: string;
  status: string;
  result_summary?: string | null;
};

/**
 * Fact / generic live-lookup goals prefer OpenAI hosted web_search.
 * Options / portal keep Playwright Bing browse (forms, login, live catalogs).
 */
export function usesHostedWebSearchBootstrap(goal: string): boolean {
  const shape = inferMissionShape(goal);
  return shape === "fact" || shape === "generic";
}

/**
 * Hosted web.search often returns last-year sports blurbs when the query
 * lacks an absolute date. If the goal is today/yesterday and evidence only
 * cites another year → treat as stale and fall through to browser dig.
 */
export function webSearchLooksStaleForGoal(
  goal: string,
  evidence: string,
  now = new Date(),
): boolean {
  const g = goal.trim();
  if (!/אתמול|היום|yesterday|today/iu.test(g)) {
    return false;
  }
  const ymd = resolveRelativeDateLabel(
    /אתמול|yesterday/iu.test(g) ? "אתמול" : "היום",
    now,
  );
  const year = ymd.slice(0, 4);
  const years = [...evidence.matchAll(/\b(20\d{2})\b/g)].map((m) => m[1]!);
  if (years.length === 0) {
    return false;
  }
  const hasSessionYear = years.includes(year);
  const hasOtherYear = years.some((y) => y !== year);
  return hasOtherYear && !hasSessionYear;
}

export function hasWebSearchTool(
  toolResults: MissionToolResultFact[],
): boolean {
  return toolResults.some((row) => row.tool === WEB_SEARCH_TOOL);
}

/**
 * Strip tool header / SOURCES from a web.search resultSummary → user-facing Hebrew.
 */
export function answerTextFromWebSearchSummary(summary: string): string {
  let text = summary.trim();
  if (!text) {
    return "";
  }
  text = text.replace(/^web\.search:\s*[^\n]*\n*/iu, "");
  text = text.replace(/\n*SOURCES:\s*[\s\S]*$/iu, "");
  text = text.replace(/\*\*/g, "").trim();
  return text.slice(0, 1500);
}

/** True when hosted search already produced a usable public-fact answer. */
export function webSearchSummaryLooksComplete(summary: string): boolean {
  return answerTextFromWebSearchSummary(summary).length >= 20;
}

/**
 * Approved mission with no search/browse yet — engine may kick off search.
 * Shape picks hosted web.search (fact/generic) vs Bing navigate (options/portal).
 */
export function shouldStartEngineWebSearch(
  mission: Pick<
    Mission,
    "status" | "planApprovedAt" | "planUpdatedAt" | "goal"
  >,
  toolResults: MissionToolResultFact[],
): boolean {
  if (
    mission.status !== "running" &&
    mission.status !== "pending"
  ) {
    return false;
  }
  if (!planIsApproved(mission)) {
    return false;
  }
  if (hasWebSearchTool(toolResults)) {
    return false;
  }
  return countBrowseTools(toolResults) === 0;
}

/** Max browser.navigate + click + extract calls in the find-options phase. */
export const SEARCH_BROWSE_BUDGET = 16;
/** Max distinct hosts the mission may open while searching for options. */
export const SEARCH_MAX_HOSTS = 4;

export function isBrowseTool(tool: string): boolean {
  return (
    tool === "browser.navigate" ||
    tool === "browser.click" ||
    tool === "browser.extract"
  );
}

export function countBrowseTools(toolResults: MissionToolResultFact[]): number {
  return toolResults.filter((row) => isBrowseTool(row.tool)).length;
}

/** Host from a URL or tool summary that embeds a URL. */
export function hostFromUrlOrSummary(text: string): string | null {
  const m = text.match(/https?:\/\/([^/\s:?#]+)/i);
  if (!m?.[1]) {
    return null;
  }
  return m[1].toLowerCase().replace(/^www\./, "");
}

export function distinctHostsFromToolResults(
  toolResults: MissionToolResultFact[],
): string[] {
  const hosts = new Set<string>();
  for (const row of toolResults) {
    const h = hostFromUrlOrSummary(row.result_summary ?? "");
    if (h) {
      hosts.add(h);
    }
  }
  return [...hosts];
}

/** True when the two most recent extracts look like the same page dump. */
export function extractLooksRepeated(
  toolResults: MissionToolResultFact[],
): boolean {
  const extracts = toolResults.filter((row) => row.tool === "browser.extract");
  if (extracts.length < 2) {
    return false;
  }
  const a = (extracts[0]?.result_summary ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  const b = (extracts[1]?.result_summary ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  if (a.length < 40 || b.length < 40) {
    return false;
  }
  return a === b;
}

export type BrowseBudgetDecision =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Hard caps before running more browse tools — not product understanding.
 * `toolResults` are newest-first (same order as buildMissionTurnContext).
 */
export function evaluateBrowseBudget(
  prior: MissionToolResultFact[],
  nextTools: { tool: string; args?: Record<string, unknown> }[],
): BrowseBudgetDecision {
  const nextBrowse = nextTools.filter((t) => isBrowseTool(t.tool));
  if (nextBrowse.length === 0) {
    return { ok: true };
  }
  if (countBrowseTools(prior) + nextBrowse.length > SEARCH_BROWSE_BUDGET) {
    return { ok: false, reason: "browse_budget" };
  }
  if (
    nextBrowse.every((t) => t.tool === "browser.extract") &&
    extractLooksRepeated(prior)
  ) {
    return { ok: false, reason: "repeated_extract" };
  }
  if (
    shouldStopNavigateLoop(prior) &&
    nextBrowse.every((t) => t.tool === "browser.navigate")
  ) {
    return { ok: false, reason: "navigate_loop" };
  }
  const hosts = new Set(distinctHostsFromToolResults(prior));
  for (const t of nextBrowse) {
    if (t.tool !== "browser.navigate") {
      continue;
    }
    const url = typeof t.args?.url === "string" ? t.args.url : "";
    const h = hostFromUrlOrSummary(url);
    if (!h) {
      continue;
    }
    if (!hosts.has(h) && hosts.size >= SEARCH_MAX_HOSTS) {
      return { ok: false, reason: "host_budget" };
    }
    hosts.add(h);
  }
  return { ok: true };
}

export function formatSearchBudgetExhaustedAsk(goal: string): string {
  const g = goal.trim() || "המשימה";
  return `חיפשתי בכמה מקורות ל«${g}» ולא מצאתי אפשרויות מספיק רלוונטיות. תגידי העדפות אחרות או «תחפשי שוב» ואמשיך.`;
}

/**
 * Default search URL if the model navigates without choosing a host.
 * Always Bing — no Zap/MyVisit/Hot hard-routing (model owns the path).
 */
export function searchUrlForGoal(goal: string): string {
  return bingSearchUrl(searchQueryFromGoal(goal));
}

/** Alternate Bing query if primary extract is empty/chrome/bot-wall. */
export function searchFallbackUrlForGoal(goal: string): string {
  const q = searchQueryFromGoal(goal);
  return bingSearchUrl(`${q} אתר רשמי`);
}

/** True when a navigate tool result summary looks like a dead search page. */
export function navigateResultLooksUseless(summary: string): boolean {
  const t = summary.toLowerCase();
  // Legacy DDG HTML endpoint — always bot-walled for our Playwright sessions.
  if (t.includes("html.duckduckgo.com/html")) {
    return true;
  }
  return isUselessSearchExtract(summary);
}

/**
 * Engine must NOT force a first navigate — always false.
 * Kept so call sites / tests can assert model-owned browse start.
 */
export function shouldBootstrapWebSearch(
  _mission: Pick<
    Mission,
    "status" | "stepCount" | "planApprovedAt" | "planUpdatedAt"
  >,
  _priorToolResultCount: number,
): boolean {
  return false;
}

/** After navigate(s) with no extract yet — engine should extract then wake executor. */
export function shouldBootstrapExtract(
  mission: Pick<Mission, "status" | "planApprovedAt" | "planUpdatedAt">,
  toolResults: MissionToolResultFact[],
): boolean {
  if (
    mission.status !== "running" &&
    mission.status !== "pending"
  ) {
    return false;
  }
  if (!planIsApproved(mission)) {
    return false;
  }
  if (toolResults.some((row) => row.tool === "browser.extract")) {
    return false;
  }
  const navigates = toolResults.filter(
    (row) =>
      row.tool === "browser.navigate" &&
      (row.status === "done" || row.status === "failed"),
  );
  return navigates.length > 0;
}

/** Last 3 tools are navigates — stop re-search loops (even after a prior extract). */
export function shouldStopNavigateLoop(
  toolResults: MissionToolResultFact[],
): boolean {
  const recent = toolResults.slice(0, 3);
  return (
    recent.length >= 3 &&
    recent.every((row) => row.tool === "browser.navigate")
  );
}

/** True when extract is a search-engine error wall / empty junk — bot walls only. */
export function isUselessSearchExtract(extractText: string): boolean {
  const t = extractText.replace(/\s+/g, " ").trim().toLowerCase();
  if (t.length < 40) {
    return true;
  }
  // Bing/DDG chrome-only samples (accessibility skip + footer / challenge).
  if (
    t.includes("דלג לתוכן") &&
    (t.includes("© 202") ||
      t.includes("microsoft") ||
      t.includes("פרטיות") ||
      t.includes("rewards") ||
      t.includes("פתור את האתגר"))
  ) {
    return true;
  }
  return (
    t.includes("if this persists") ||
    t.includes("please email us") ||
    t.includes("anonymized error code") ||
    t.includes("unusual traffic") ||
    t.includes("our support email") ||
    (t.includes("duckduckgo") && t.includes("error")) ||
    t.includes("sorry, you have been blocked") ||
    t.includes("access denied") ||
    t.includes("captcha") ||
    t.includes("פתור את האתגר") ||
    t.includes("request rejected") ||
    t.includes("your support id") ||
    t.includes("home-error/418") ||
    t.includes("browsertype.launch") ||
    t.includes("executable doesn't exist")
  );
}

/**
 * Numbered product/option lines that already include a price (₪).
 * Formats tool extract output — does not invent products.
 */
export function productOptionLinesFromExtract(extractText: string): string[] {
  return collectNumberedExtractLines(extractText, { requirePrice: true });
}

/**
 * Prefer priced product lines; else Bing/SERP numbered hits that match the goal.
 * Still does not invent — only reformats extract lines.
 */
export function relevantOptionLinesFromExtract(
  goal: string,
  extractText: string,
): string[] {
  const priced = productOptionLinesFromExtract(extractText).filter((line) =>
    extractMatchesGoal(goal, line),
  );
  if (priced.length >= 1) {
    return priced;
  }
  return collectNumberedExtractLines(extractText, { requirePrice: false }).filter(
    (line) => extractMatchesGoal(goal, line),
  );
}

function collectNumberedExtractLines(
  extractText: string,
  opts: { requirePrice: boolean },
): string[] {
  const lines = extractText
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => {
      if (!/^\d+\.\s+\S/.test(line)) {
        return false;
      }
      if (opts.requirePrice && !/₪/u.test(line)) {
        return false;
      }
      return true;
    });
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const body = line.replace(/^\d+\.\s*/, "").trim();
    // Reject Zap facet/chrome blobs mistaken for a single product.
    if (
      /כל הקטגוריות|סינון תוצאות|שלום אורח|zapchoice|מיין לפי|דלג לתוכן/iu.test(
        body,
      )
    ) {
      continue;
    }
    const key = body.toLowerCase().slice(0, 80);
    if (seen.has(key) || body.length < 10) {
      continue;
    }
    seen.add(key);
    out.push(`${out.length + 1}. ${body.slice(0, 220)}`);
    if (out.length >= 5) {
      break;
    }
  }
  return out;
}

/** Ask the speaker to pick among already-extracted product lines. */
export function formatProductOptionsAsk(
  goal: string,
  lines: string[],
): string {
  const g = goal.trim() || "המשימה";
  const opts = lines.slice(0, 3);
  const body = opts
    .map((line, i) => `${i + 1}. ${line.replace(/^\d+\.\s*/, "")}`)
    .join("\n");
  return `מצאתי ${opts.length} אפשרויות ל«${g}»:\n\n${body}\n\nאיזו אפשרות להמשיך איתה / תקציב או העדפות?`;
}

/** Heuristic: page text looks like a login / identity gate (any locale/site). */
export function extractLooksLikeLogin(extractText: string): boolean {
  const t = extractText.replace(/\s+/g, " ").trim();
  if (t.length < 20) {
    return false;
  }
  // Strong signals only — nav "Sign in" chrome alone is not enough (flight sites etc.).
  return (
    /password|passwd|otp|one[-\s]?time/i.test(t) ||
    /סיסמ|תעודת זהות|מספר זהות|קוד סודי|קוד חד פעמי|אימות דו[־\-]שלבי|הזן סיסמה|שדה סיסמה/u.test(
      t,
    ) ||
    (/username|user name|שם משתמש/i.test(t) &&
      /password|passwd|סיסמ/i.test(t))
  );
}

/**
 * Portal/account entry without a classic password field yet
 * (online area / book appointment CTAs). Not generic "sign in" header chrome.
 */
export function extractLooksLikePortalGate(extractText: string): boolean {
  if (extractLooksLikeLogin(extractText)) {
    return true;
  }
  const t = extractText.replace(/\s+/g, " ").trim();
  return (
    /member\s*login|customer\s*login|sign\s*in\s*to\s*(your|my)/i.test(t) ||
    /אזור אישי|כניסה לאזור האישי|הזדהות|און[־\-]ליין|זימון תורים|קביעת תור/u.test(
      t,
    )
  );
}

/** Generic ask when the open page needs speaker credentials. */
export function formatLoginCredentialsAsk(goal: string, pageHint?: string): string {
  const g = goal.trim() || "המשימה";
  const hint = (pageHint || "").trim();
  const where = hint ? ` (${hint.slice(0, 80)})` : "";
  return `כדי להמשיך ב«${g}» צריך פרטי כניסה לאתר${where}. שלחי שם משתמש/ת.ז. וסיסמה (או אמרי להשתמש בפרטים שמורים בכספת אם יש).`;
}

/**
 * True when extract text shares at least one meaningful token with the search query.
 * Used only to decide Zap→Bing fallback — not to invent products.
 */
export function extractMatchesGoal(goal: string, extractText: string): boolean {
  const q = searchQueryFromGoal(goal);
  const tokens = q
    .split(/\s+/u)
    .map((t) => t.trim())
    .filter(
      (t) =>
        t.length >= 3 &&
        !/^(לגבר|לאישה|לילדים|לתינוק|מתאים|מתאימה)$/u.test(t),
    );
  if (tokens.length === 0) {
    return true;
  }
  const blob = extractText;
  return tokens.some((t) => blob.includes(t));
}

/** Pull multiline extract payload from a browser.extract resultSummary. */
export function extractTextFromToolSummary(resultSummary: string): string {
  const raw = resultSummary.trim();
  if (!raw) {
    return "";
  }
  const nl = raw.indexOf(":\n");
  if (nl >= 0) {
    return raw.slice(nl + 2).trim();
  }
  const colon = raw.indexOf(": ");
  if (colon >= 0) {
    return raw.slice(colon + 2).trim();
  }
  return raw;
}

/** Hebrew ask when search extract is empty or a bot/error page. */
export function formatSearchFailedAsk(goal: string): string {
  const g = goal.trim() || "המשימה";
  if (/לקבוע|תור|זימון|משרד הפנים|דרכון/u.test(g)) {
    return `החיפוש ל«${g}» לא החזיר תוצאות שימושיות. באיזה סניף/עיר לקבוע תור, ומתי נוח — או קישור לאתר הזימון אם יש לך?`;
  }
  return `החיפוש ל«${g}» לא החזיר תוצאות שימושיות כרגע. תגידי אתר/העדפות או «תחפשי שוב» ואמשיך.`;
}

export function formatAutomationBlockedAsk(goal: string): string {
  const g = goal.trim() || "המשימה";
  return `נתקעתי באימות/חומת בוטים בזמן החיפוש ל«${g}». אפשר להמשיך באתר אחר או לבחור ידנית איך להמשיך.`;
}

export function formatNavigateLoopAsk(goal: string): string {
  const g = goal.trim() || "המשימה";
  return `נתקעתי בלולאת חיפוש ל«${g}» בלי התקדמות. תגידי איך להמשיך (אתר/העדפות) ואמשיך משם.`;
}

/**
 * True when resume summary (ACTION field) asks to search again / on a site.
 * Reads model-emitted summary — not free-text utterance parsing for inventing work.
 */
export function resumeImpliesReSearch(summary: string): boolean {
  const t = summary.trim();
  if (!t) {
    return false;
  }
  return (
    /תחפש|לחפש|חפשי|\bחפש\b|search\s*again|re-?search/iu.test(t) ||
    (/שוב/u.test(t) && /חפש|search/iu.test(t))
  );
}

/** Latest context fact asks for a fresh web search cycle. */
export function missionNeedsFreshSearch(
  contextFacts: unknown,
): boolean {
  if (!Array.isArray(contextFacts) || contextFacts.length === 0) {
    return false;
  }
  for (let i = contextFacts.length - 1; i >= 0; i -= 1) {
    const row = contextFacts[i];
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const fact = row as Record<string, unknown>;
    if (fact.re_search === true || fact.reSearch === true) {
      return true;
    }
  }
  return false;
}

/** Clear re_search flags after a fresh search comeback starts (avoid loops). */
export function clearReSearchFlags(contextFacts: unknown): unknown[] {
  if (!Array.isArray(contextFacts)) {
    return [];
  }
  return contextFacts.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return row;
    }
    const fact = { ...(row as Record<string, unknown>) };
    delete fact.re_search;
    delete fact.reSearch;
    return fact;
  });
}

/** How many empty-executor dig retries the engine may give the model on a destination page. */
export const MAX_DIG_EMPTY_RETRIES = 4;

/** Count of engine dig-empty retries recorded in context_facts. */
export function digEmptyRetryCount(contextFacts: unknown): number {
  if (!Array.isArray(contextFacts)) {
    return 0;
  }
  let n = 0;
  for (const row of contextFacts) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const fact = row as Record<string, unknown>;
    if (fact.source === "engine" && typeof fact.dig_empty_retry === "number") {
      n = Math.max(n, fact.dig_empty_retry);
    }
  }
  return n;
}

/** Append / bump a dig-empty retry marker for another model turn. */
export function bumpDigEmptyRetry(contextFacts: unknown): unknown[] {
  const prev = Array.isArray(contextFacts) ? [...contextFacts] : [];
  const next = digEmptyRetryCount(prev) + 1;
  return [
    ...prev.filter((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        return true;
      }
      return (row as Record<string, unknown>).dig_empty_retry == null;
    }),
    {
      source: "engine",
      dig_empty_retry: next,
      at: new Date().toISOString(),
    },
  ];
}

/** Drop dig-empty retry markers after the model makes progress. */
export function clearDigEmptyRetries(contextFacts: unknown): unknown[] {
  if (!Array.isArray(contextFacts)) {
    return [];
  }
  return contextFacts.filter((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return true;
    }
    return (row as Record<string, unknown>).dig_empty_retry == null;
  });
}

/** When dig retries are exhausted — ask speaker how to continue (no invented answer). */
export function formatDigStuckAsk(goal: string, extractSample: string): string {
  const g = goal.trim() || "המשימה";
  const hint = extractSample.replace(/\s+/g, " ").trim().slice(0, 180);
  return `הגעתי לדף באתר עבור «${g}» וצריכה הכוונה להמשך${
    hint ? ` (ראיתי: ${hint}…)` : ""
  }. מה הצעד הבא?`;
}

/**
 * Prefer a short score/result line from extract (quote only — no invented facts).
 */
export function bestFactEvidenceSnippet(goal: string, extractText: string): string {
  const text = stripHebrewNikud(extractText);
  const numbered = relevantOptionLinesFromExtract(goal, text).slice(0, 3);
  if (numbered.length > 0) {
    return numbered
      .map((l, i) => `${i + 1}. ${l.replace(/^\d+\.\s*/, "")}`)
      .join("\n");
  }
  // Prefer a window around a match score + goal tokens.
  const scoreHit = text.match(
    /.{0,40}\b\d{1,2}\s*[:\-–]\s*\d{1,2}\b.{0,40}/u,
  );
  if (scoreHit && extractMatchesGoal(goal, scoreHit[0])) {
    return scoreHit[0].replace(/\s+/g, " ").trim();
  }
  const winLoss = text.match(
    /.{0,50}(?:ניצח(?:ה|ו)?|הפסיד(?:ה|ו)?|תיקו).{0,50}/iu,
  );
  if (winLoss && extractMatchesGoal(goal, winLoss[0])) {
    return winLoss[0].replace(/\s+/g, " ").trim();
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 280);
}

/**
 * Present SERP/extract evidence for a fact goal when the model failed to complete.
 * Reformats extract only — does not invent scores.
 */
export function formatSerpFactEvidenceAsk(
  goal: string,
  extractText: string,
): string {
  const g = goal.trim() || "המשימה";
  const body = bestFactEvidenceSnippet(goal, extractText);
  return `מצאתי ל«${g}»:\n\n${body}\n\nזה מה שחיפשת, או לחפש מקור נוסף?`;
}

/** Newest Bing/SERP extract body that already answers a fact goal, if any. */
export function priorSerpFactExtract(
  goal: string,
  toolResults: MissionToolResultFact[],
): string | null {
  for (const row of toolResults) {
    if (row.tool !== "browser.extract") {
      continue;
    }
    const host = hostFromUrlOrSummary(row.result_summary ?? "");
    if (!host || !isSearchEngineHost(host)) {
      continue;
    }
    const body = extractTextFromToolSummary(row.result_summary ?? "");
    if (serpLooksLikeFactAnswer(goal, body)) {
      return body;
    }
  }
  return null;
}

/** Park mission waiting on speaker and return ask_user notice id. */
export async function parkMissionAskUser(input: {
  missionId: string;
  summary: string;
  /** Extra engine context_fact fields (e.g. awaiting_credentials). */
  contextExtra?: Record<string, unknown>;
}): Promise<string> {
  const summary = input.summary.trim().slice(0, 2000) || "צריכה מידע ממך";
  const row = await prisma.mission.findUnique({
    where: { id: input.missionId },
    select: { contextFacts: true },
  });
  const prev = Array.isArray(row?.contextFacts)
    ? [...(row.contextFacts as unknown[])]
    : [];
  const nextFacts = input.contextExtra
    ? [
        ...prev,
        {
          source: "engine",
          at: new Date().toISOString(),
          ...input.contextExtra,
        },
      ]
    : prev;
  await prisma.mission.update({
    where: { id: input.missionId },
    data: {
      status: "waiting_user",
      waitingOn: "user",
      lastSummary: summary,
      wakeAt: null,
      ...(input.contextExtra
        ? { contextFacts: nextFacts as Prisma.InputJsonValue }
        : {}),
    },
  });
  return input.missionId;
}

/** Fallback plan only when the executor returns empty while planning. */
export const BOOTSTRAP_PLAN_STEPS = [
  "להשלים פרטים חסרים עם המשתמש אם צריך",
  "לחפש באינטרנט איך לבצע ולהגיע לאתר הרשמי",
  "לבצע באתר (כולל לוגין אם צריך)",
  "לאשר שלבים קריטיים ולוודא הצלחה",
] as const;

/** Lucy tracking task title derived from the mission goal. */
export function trackingTitleFromGoal(goal: string): string {
  const trimmed = goal.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return "משימה פתוחה";
  }
  if (/^(לקנות|לבטל|לקבוע|להזמין|לסגור|לבדוק)\s/u.test(trimmed)) {
    return trimmed.slice(0, 255);
  }
  return `לבצע: ${trimmed}`.slice(0, 255);
}

async function tasksListIdFor(employeeId: string): Promise<string> {
  const existing = await prisma.employeeList.findFirst({
    where: { employeeId, listType: "tasks", name: "", deletedAt: null },
  });
  if (existing) {
    return existing.id;
  }
  const created = await prisma.employeeList.create({
    data: { employeeId, listType: "tasks", name: "" },
  });
  return created.id;
}

/**
 * Ensure the orchestrator (Lucy) has a tasks row linked as mission tracking.
 * Lives on Lucy's tasks list, but addedById = mission speaker so WORKER_SAVED_DATA
 * inventory (scoped to the human) still includes it via workerItemTiedToSpeaker.
 */
export async function ensureOrchestratorTrackingTask(input: {
  missionId: string;
  orchestratorId: string;
  goal: string;
}): Promise<string | null> {
  const mission = await prisma.mission.findUnique({
    where: { id: input.missionId },
  });
  if (!mission) {
    return null;
  }
  const speakerId = mission.speakerId;
  if (mission.trackingItemId) {
    const existing = await prisma.employeeListItem.findFirst({
      where: {
        id: mission.trackingItemId,
        deletedAt: null,
        list: {
          employeeId: input.orchestratorId,
          listType: "tasks",
          deletedAt: null,
        },
      },
    });
    if (existing) {
      if (speakerId && existing.addedById !== speakerId) {
        await prisma.employeeListItem.update({
          where: { id: existing.id },
          data: { addedById: speakerId },
        });
      }
      return existing.id;
    }
  }

  const title = trackingTitleFromGoal(input.goal || mission.goal);
  const listId = await tasksListIdFor(input.orchestratorId);
  const item = await prisma.employeeListItem.create({
    data: {
      listId,
      itemKey: title,
      data: { "שם משימה": title } as Prisma.InputJsonValue,
      scope: "personal",
      visibleTo: [],
      // Speaker asked Lucy — same tie rule as OPEN_JOBS asker for inventory dump.
      addedById: speakerId,
    },
  });
  await prisma.mission.update({
    where: { id: input.missionId },
    data: { trackingItemId: item.id },
  });
  return item.id;
}

export async function listActiveMissionsForChat(input: {
  userId: string;
  speaker: PublicEmployee;
  seeAll: boolean;
}): Promise<ActiveMissionFact[]> {
  const rows = await prisma.mission.findMany({
    where: {
      userId: input.userId,
      status: { in: [...ACTIVE_MISSION_STATUSES] },
      ...(input.seeAll ? {} : { speakerId: input.speaker.id }),
    },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });
  return rows.map((row) => ({
    mission_id: row.id,
    goal: row.goal,
    success_criteria: row.successCriteria,
    status: row.status,
    last_summary: row.lastSummary,
    waiting_on: row.waitingOn,
    plan_steps: planStepsOf(row),
    plan_approved: planIsApproved(row),
    tracking_item_id: row.trackingItemId,
  }));
}

export function formatActiveMissionsBlock(
  missions: ActiveMissionFact[],
): string {
  if (missions.length === 0) {
    return "";
  }
  return [
    "ACTIVE_MISSIONS (live open-world work you orchestrate; executor runs tools in background):",
    JSON.stringify(missions, null, 2),
    "When status=waiting_plan_approval and the speaker approves → missions.approve_plan with mission_id.",
    "Ambiguous כן with multiple waiting_* rows → ASK which mission_id briefly.",
    "Do not claim browser/payment success without engine push / evidence.",
  ].join("\n");
}

export type ApplyMissionsResult = {
  createdIds: string[];
  wakeIds: string[];
  notices: string[];
  refused: string[];
};

export async function applyMissionActions(input: {
  userId: string;
  speaker: PublicEmployee;
  orchestrator: PublicEmployee;
  actions: LlmMissionAction[];
  /** When true, allow executor-only actions (run_tools, update_plan, …). */
  asExecutor?: boolean;
}): Promise<ApplyMissionsResult> {
  const result: ApplyMissionsResult = {
    createdIds: [],
    wakeIds: [],
    notices: [],
    refused: [],
  };
  if (!input.actions.length) {
    return result;
  }

  if (isGuestEmployee(input.speaker)) {
    result.refused.push("missions refused for guest speaker");
    return result;
  }

  const executor = await ensureMissionExecutor(input.userId);

  for (const action of input.actions) {
    try {
      if (action.action === "create") {
        if (input.asExecutor) {
          result.refused.push("executor cannot create missions");
          continue;
        }
        const goal = (action.goal ?? "").trim();
        const successCriteria = (action.successCriteria ?? "").trim();
        if (!goal || !successCriteria) {
          result.refused.push("missions.create needs goal + success_criteria");
          continue;
        }
        const created = await prisma.mission.create({
          data: {
            userId: input.userId,
            speakerId: input.speaker.id,
            orchestratorId: input.orchestrator.id,
            executorId: executor.id,
            goal,
            successCriteria,
            status: "planning",
            plan: [],
            contextFacts: (action.contextFacts ??
              []) as unknown as Prisma.InputJsonValue,
            trackingItemId: action.trackingItemId?.trim() || null,
            lastSummary: (action.summary ?? "").trim(),
            wakeAt: new Date(),
          },
        });
        await recordAuditEvent({
          userId: input.userId,
          actorEmployeeId: input.orchestrator.id,
          action: "mission_create",
          entityType: "Mission",
          entityId: created.id,
          summary: `Mission created: ${goal.slice(0, 120)}`,
        });
        result.createdIds.push(created.id);
        result.wakeIds.push(created.id);
        continue;
      }

      const missionId = (action.missionId ?? "").trim();
      if (!missionId) {
        result.refused.push(`${action.action} needs mission_id`);
        continue;
      }
      const mission = await prisma.mission.findFirst({
        where: { id: missionId, userId: input.userId },
      });
      if (!mission) {
        result.refused.push(`mission not found: ${missionId}`);
        continue;
      }
      if (
        mission.speakerId !== input.speaker.id &&
        !isAccountOwner(input.speaker) &&
        !input.asExecutor
      ) {
        result.refused.push(`mission not visible: ${missionId}`);
        continue;
      }
      if (TERMINAL.has(mission.status) && action.action !== "cancel") {
        result.refused.push(`mission already ${mission.status}`);
        continue;
      }

      switch (action.action) {
        case "approve_plan": {
          if (input.asExecutor) {
            result.refused.push("approve_plan is Lucy/speaker only");
            break;
          }
          if (mission.status !== "waiting_plan_approval" && !mission.planUpdatedAt) {
            result.refused.push("no plan waiting for approval");
            break;
          }
          const updated = await prisma.mission.update({
            where: { id: mission.id },
            data: {
              planApprovedAt: new Date(),
              status: "running",
              waitingOn: "",
              wakeAt: new Date(),
              lastSummary: (action.summary ?? "תכנית אושרה").trim(),
            },
          });
          await recordAuditEvent({
            userId: input.userId,
            actorEmployeeId: input.orchestrator.id,
            action: "mission_plan_approval",
            entityType: "Mission",
            entityId: updated.id,
            summary: "Plan approved",
          });
          result.wakeIds.push(updated.id);
          result.notices.push("plan_approved");
          break;
        }
        case "cancel": {
          await cancelMission(mission.id, input.orchestrator.id, action.summary);
          result.notices.push("cancelled");
          break;
        }
        case "update_plan": {
          const steps = action.planSteps ?? planStepsOf(mission);
          const major =
            action.planRevision === "major" ||
            mission.status === "planning" ||
            mission.status === "waiting_plan_approval" ||
            !planIsApproved(mission);
          await prisma.mission.update({
            where: { id: mission.id },
            data: {
              plan: steps as unknown as Prisma.InputJsonValue,
              planUpdatedAt: new Date(),
              ...(major
                ? {
                    planApprovedAt: null,
                    status: "planning",
                  }
                : {}),
              lastSummary: (action.summary ?? mission.lastSummary).trim(),
              wakeAt: new Date(),
            },
          });
          result.wakeIds.push(mission.id);
          break;
        }
        case "request_plan_approval": {
          const steps =
            action.planSteps && action.planSteps.length > 0
              ? action.planSteps
              : planStepsOf(mission);
          const summary =
            (action.summary ?? "").trim() ||
            formatPlanApprovalText(mission.goal, steps);
          await prisma.mission.update({
            where: { id: mission.id },
            data: {
              plan: steps as unknown as Prisma.InputJsonValue,
              planUpdatedAt: new Date(),
              planApprovedAt: null,
              status: "waiting_plan_approval",
              waitingOn: "plan_approval",
              lastSummary: summary,
              wakeAt: null,
            },
          });
          result.notices.push(`plan_approval:${mission.id}`);
          break;
        }
        case "ask_user": {
          const summary = (action.summary ?? "").trim() || "צריכה מידע ממך";
          await prisma.mission.update({
            where: { id: mission.id },
            data: {
              status: "waiting_user",
              waitingOn: "user",
              lastSummary: summary,
              wakeAt: null,
            },
          });
          result.notices.push(`ask_user:${mission.id}`);
          break;
        }
        case "resume": {
          if (input.asExecutor) {
            result.refused.push("resume is Lucy/speaker only");
            break;
          }
          const note = (action.summary ?? "").trim();
          const awaitingCreds = missionAwaitingCredentials(mission.contextFacts);
          const credentialReply =
            awaitingCreds || looksLikeCredentialAnswer(note);
          // Clarify/options answers → fresh Bing with new facts.
          // Login/OTP answers → stay on the open host (continue_on_host), no re_search.
          const reSearch =
            action.reSearch === true ||
            resumeImpliesReSearch(note) ||
            ((mission.status === "waiting_user" ||
              mission.waitingOn === "user") &&
              !credentialReply);
          let prevFacts = Array.isArray(mission.contextFacts)
            ? (mission.contextFacts as unknown[])
            : [];
          if (credentialReply) {
            prevFacts = clearAwaitingCredentials(prevFacts);
          }
          const nextFacts = [
            ...prevFacts,
            {
              source: "speaker",
              text: note || "(empty reply)",
              at: new Date().toISOString(),
              ...(reSearch ? { re_search: true } : {}),
              ...(credentialReply ? { continue_on_host: true } : {}),
            },
          ];
          await prisma.mission.update({
            where: { id: mission.id },
            data: {
              contextFacts: nextFacts as unknown as Prisma.InputJsonValue,
              status: "running",
              waitingOn: "",
              lastSummary: note || mission.lastSummary || "המשתמש ענה — ממשיכים",
              // re_search: chat/runner runs recoverMissionSearchComeback; no bare wake race.
              wakeAt: reSearch ? null : new Date(),
            },
          });
          if (reSearch) {
            result.notices.push(`re_search:${mission.id}`);
          } else {
            result.wakeIds.push(mission.id);
          }
          result.notices.push(`resumed:${mission.id}`);
          break;
        }
        case "request_approval": {
          const summary = (action.summary ?? "").trim() || "צריכה אישור לפעולה";
          await prisma.mission.update({
            where: { id: mission.id },
            data: {
              status: "waiting_approval",
              waitingOn: "step_approval",
              lastSummary: summary,
              wakeAt: null,
            },
          });
          result.notices.push(`step_approval:${mission.id}`);
          break;
        }
        case "run_tools": {
          if (!planIsApproved(mission)) {
            result.refused.push("run_tools blocked until plan approved");
            break;
          }
          if (mission.stepCount >= mission.maxSteps) {
            await prisma.mission.update({
              where: { id: mission.id },
              data: {
                status: "failed",
                lastSummary: "חריגה ממגבלת הצעדים",
                wakeAt: null,
              },
            });
            result.refused.push("max steps exceeded");
            break;
          }
          const tools = action.tools ?? [];
          if (tools.length === 0) {
            result.refused.push("run_tools needs tools[]");
            break;
          }
          if (tools.some((t) => isBrowseTool(t.tool))) {
            const priorCalls = await prisma.missionToolCall.findMany({
              where: { missionId: mission.id },
              orderBy: { createdAt: "desc" },
              take: 40,
              select: {
                tool: true,
                status: true,
                resultSummary: true,
              },
            });
            const priorFacts: MissionToolResultFact[] = priorCalls.map(
              (row) => ({
                tool: row.tool,
                status: row.status,
                result_summary: row.resultSummary,
              }),
            );
            const budget = evaluateBrowseBudget(
              priorFacts,
              tools.map((t) => ({
                tool: t.tool,
                args:
                  t.args &&
                  typeof t.args === "object" &&
                  !Array.isArray(t.args)
                    ? (t.args as Record<string, unknown>)
                    : {},
              })),
            );
            if (!budget.ok) {
              const summary = formatSearchBudgetExhaustedAsk(mission.goal);
              await prisma.mission.update({
                where: { id: mission.id },
                data: {
                  status: "waiting_user",
                  waitingOn: "user",
                  lastSummary: summary,
                  wakeAt: null,
                },
              });
              result.notices.push(`ask_user:${mission.id}`);
              result.refused.push(`browse_budget:${budget.reason}`);
              break;
            }
          }
          for (const tool of tools) {
            const requiresApproval = toolRequiresApproval(
              tool.tool,
              tool.requiresApproval,
            );
            const toolCall = await prisma.missionToolCall.create({
              data: {
                missionId: mission.id,
                tool: tool.tool,
                args: (tool.args ?? {}) as Prisma.InputJsonValue,
                requiresApproval,
                status: requiresApproval ? "waiting_approval" : "pending",
                approvalExpiresAt: requiresApproval
                  ? new Date(Date.now() + 60 * 60 * 1000)
                  : null,
              },
            });
            if (requiresApproval) {
              await prisma.mission.update({
                where: { id: mission.id },
                data: {
                  status: "waiting_approval",
                  waitingOn: `tool:${toolCall.id}`,
                  lastSummary:
                    (action.summary ?? "").trim() ||
                    `לאשר פעולה: ${tool.tool}`,
                  wakeAt: null,
                },
              });
              result.notices.push(`tool_approval:${toolCall.id}`);
              break;
            }
            const execResult = await runMissionTool(
              tool.tool,
              tool.args ?? {},
              {
                userId: input.userId,
                speakerId: mission.speakerId,
                orchestratorId: mission.orchestratorId,
                executorId: mission.executorId,
                missionId: mission.id,
              },
            );
            await prisma.missionToolCall.update({
              where: { id: toolCall.id },
              data: {
                status: execResult.ok ? "done" : "failed",
                resultSummary: execResult.summary.slice(0, 4000),
                evidenceAttachmentIds: (execResult.evidenceAttachmentIds ??
                  []) as unknown as Prisma.InputJsonValue,
              },
            });
            await recordAuditEvent({
              userId: input.userId,
              actorEmployeeId: mission.executorId,
              action: "mission_tool",
              entityType: "MissionToolCall",
              entityId: toolCall.id,
              summary: `${tool.tool}: ${execResult.summary}`.slice(0, 500),
            });
            const blocked =
              execResult.blockedReason === "automation_blocked";
            const needsUser = execResult.needsUser === true || blocked;
            const actionSummary = (action.summary ?? "").trim();
            const lastSummary = (
              blocked
                ? actionSummary ||
                  formatAutomationBlockedAsk(mission.goal)
                : actionSummary || execResult.summary
            ).slice(0, 2000);
            await prisma.mission.update({
              where: { id: mission.id },
              data: {
                stepCount: { increment: 1 },
                status: needsUser ? "waiting_user" : "running",
                waitingOn: execResult.needsUser
                  ? "user"
                  : blocked
                    ? execResult.blockedReason ?? "automation_blocked"
                    : "",
                lastSummary,
                // Keep wakeAt null mid-tool — the runner schedules the next
                // wake. Setting wakeAt=now races the ticker against this turn.
                wakeAt: null,
              },
            });
            if (needsUser) {
              result.notices.push(`ask_user:${mission.id}`);
              break;
            }
            result.wakeIds.push(mission.id);
          }
          break;
        }
        case "verify":
        case "complete": {
          const evidence = action.evidence ?? [];
          const attested = action.userAttested === true;
          if (!attested && evidence.length === 0 && action.action === "complete") {
            result.refused.push("complete needs evidence or user_attested");
            break;
          }
          await prisma.mission.update({
            where: { id: mission.id },
            data: {
              status: "done",
              waitingOn: "",
              lastSummary: (action.summary ?? "הושלם").trim(),
              wakeAt: null,
            },
          });
          if (mission.trackingItemId) {
            await softDeleteTrackingItem(mission.trackingItemId);
          }
          await clearBrowserSession(mission.id);
          await recordAuditEvent({
            userId: input.userId,
            actorEmployeeId: input.asExecutor
              ? mission.executorId
              : input.orchestrator.id,
            action: "mission_complete",
            entityType: "Mission",
            entityId: mission.id,
            summary: (action.summary ?? "done").slice(0, 500),
            detail: { evidence, attested },
          });
          result.notices.push(`done:${mission.id}`);
          break;
        }
        case "fail": {
          await prisma.mission.update({
            where: { id: mission.id },
            data: {
              status: "failed",
              waitingOn: "",
              lastSummary: (action.summary ?? "נכשל").trim(),
              wakeAt: null,
            },
          });
          await clearBrowserSession(mission.id);
          await recordAuditEvent({
            userId: input.userId,
            actorEmployeeId: mission.executorId,
            action: "mission_fail",
            entityType: "Mission",
            entityId: mission.id,
            summary: (action.summary ?? "failed").slice(0, 500),
          });
          result.notices.push(`failed:${mission.id}`);
          break;
        }
        default:
          result.refused.push(`unsupported action ${action.action}`);
      }
    } catch (error) {
      result.refused.push(
        error instanceof Error ? error.message : "mission apply failed",
      );
    }
  }

  return result;
}

export function formatPlanApprovalText(
  goal: string,
  steps: string[],
): string {
  const lines = steps.map((step, i) => `${i + 1}. ${step}`);
  return [
    `תכנית לביצוע: ${goal}`,
    ...lines,
    "שלבים כמו לוגין/תשלום/ביטול ידרשו אישור נפרד.",
    "לאשר את התכנית?",
  ].join("\n");
}

export async function cancelMission(
  missionId: string,
  actorEmployeeId: string,
  summary?: string,
): Promise<void> {
  const mission = await prisma.mission.findUnique({ where: { id: missionId } });
  if (!mission || TERMINAL.has(mission.status)) {
    return;
  }
  await prisma.missionToolCall.updateMany({
    where: {
      missionId,
      status: { in: ["pending", "waiting_approval", "running"] },
    },
    data: { status: "cancelled" },
  });
  await prisma.mission.update({
    where: { id: missionId },
    data: {
      status: "cancelled",
      waitingOn: "",
      lastSummary: (summary ?? "בוטל").trim(),
      wakeAt: null,
    },
  });
  await clearBrowserSession(missionId);
  await recordAuditEvent({
    userId: mission.userId,
    actorEmployeeId,
    action: "mission_cancel",
    entityType: "Mission",
    entityId: missionId,
    summary: (summary ?? "cancelled").slice(0, 500),
  });
}

export async function cancelMissionsForTrackingItem(
  trackingItemId: string,
  actorEmployeeId?: string | null,
): Promise<void> {
  const mission = await prisma.mission.findFirst({
    where: {
      trackingItemId,
      status: { in: [...ACTIVE_MISSION_STATUSES] },
    },
  });
  if (!mission) {
    return;
  }
  await cancelMission(
    mission.id,
    actorEmployeeId ?? mission.orchestratorId,
    "בוטל עם מטלת המעקב",
  );
}

async function softDeleteTrackingItem(itemId: string): Promise<void> {
  try {
    await prisma.employeeListItem.update({
      where: { id: itemId },
      data: { deletedAt: new Date() },
    });
  } catch {
    // Item may already be gone.
  }
}

export async function approvePendingToolCall(input: {
  userId: string;
  speakerId: string;
  toolCallId: string;
  actorEmployeeId: string;
}): Promise<{ missionId: string } | null> {
  const toolCall = await prisma.missionToolCall.findFirst({
    where: { id: input.toolCallId, status: "waiting_approval" },
    include: { mission: true },
  });
  if (!toolCall || toolCall.mission.userId !== input.userId) {
    return null;
  }
  if (toolCall.mission.speakerId !== input.speakerId) {
    return null;
  }
  if (
    toolCall.approvalExpiresAt &&
    toolCall.approvalExpiresAt.getTime() < Date.now()
  ) {
    await prisma.missionToolCall.update({
      where: { id: toolCall.id },
      data: { status: "rejected", rejectedAt: new Date() },
    });
    await prisma.mission.update({
      where: { id: toolCall.missionId },
      data: {
        status: "waiting_user",
        waitingOn: "approval_expired",
        lastSummary: "פג תוקף האישור — צריך להכין מחדש",
        wakeAt: new Date(),
      },
    });
    return { missionId: toolCall.missionId };
  }

  await prisma.missionToolCall.update({
    where: { id: toolCall.id },
    data: { status: "running", approvedAt: new Date() },
  });
  const args =
    toolCall.args &&
    typeof toolCall.args === "object" &&
    !Array.isArray(toolCall.args)
      ? (toolCall.args as Record<string, unknown>)
      : {};
  const execResult = await runMissionTool(toolCall.tool, args, {
    userId: toolCall.mission.userId,
    speakerId: toolCall.mission.speakerId,
    orchestratorId: toolCall.mission.orchestratorId,
    executorId: toolCall.mission.executorId,
    missionId: toolCall.missionId,
  });
  await prisma.missionToolCall.update({
    where: { id: toolCall.id },
    data: {
      status: execResult.ok ? "done" : "failed",
      resultSummary: execResult.summary.slice(0, 4000),
      evidenceAttachmentIds: (execResult.evidenceAttachmentIds ??
        []) as unknown as Prisma.InputJsonValue,
    },
  });
  await recordAuditEvent({
    userId: input.userId,
    actorEmployeeId: input.actorEmployeeId,
    action: "mission_tool",
    entityType: "MissionToolCall",
    entityId: toolCall.id,
    summary: `${toolCall.tool}: ${execResult.summary}`.slice(0, 500),
  });
  await prisma.mission.update({
    where: { id: toolCall.missionId },
    data: {
      stepCount: { increment: 1 },
      status: "running",
      waitingOn: "",
      lastSummary: execResult.summary.slice(0, 2000),
      wakeAt: new Date(),
    },
  });
  return { missionId: toolCall.missionId };
}

export async function rejectPendingToolCall(input: {
  userId: string;
  speakerId: string;
  toolCallId: string;
}): Promise<{ missionId: string } | null> {
  const toolCall = await prisma.missionToolCall.findFirst({
    where: { id: input.toolCallId, status: "waiting_approval" },
    include: { mission: true },
  });
  if (!toolCall || toolCall.mission.userId !== input.userId) {
    return null;
  }
  if (toolCall.mission.speakerId !== input.speakerId) {
    return null;
  }
  await prisma.missionToolCall.update({
    where: { id: toolCall.id },
    data: { status: "rejected", rejectedAt: new Date() },
  });
  await prisma.mission.update({
    where: { id: toolCall.missionId },
    data: {
      status: "running",
      waitingOn: "",
      lastSummary: "המשתמש דחה את הפעולה — מתכננים מחדש",
      wakeAt: new Date(),
    },
  });
  return { missionId: toolCall.missionId };
}

export async function buildMissionTurnContext(missionId: string): Promise<{
  mission: Mission;
  toolResults: unknown[];
  vaultMeta: unknown[];
} | null> {
  const mission = await prisma.mission.findUnique({ where: { id: missionId } });
  if (!mission) {
    return null;
  }
  const toolCalls = await prisma.missionToolCall.findMany({
    where: { missionId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const vaultMeta = await listVaultMetaForSpeaker({
    userId: mission.userId,
    speakerId: mission.speakerId,
  });
  return {
    mission,
    toolResults: toolCalls.map((row) => ({
      tool_call_id: row.id,
      tool: row.tool,
      status: row.status,
      result_summary: row.resultSummary,
      requires_approval: row.requiresApproval,
    })),
    vaultMeta,
  };
}

export async function linkTrackingItemToMission(
  missionId: string,
  trackingItemId: string,
): Promise<void> {
  const mission = await prisma.mission.findUnique({
    where: { id: missionId },
    select: { speakerId: true },
  });
  await prisma.mission.update({
    where: { id: missionId },
    data: { trackingItemId },
  });
  // Model-created Lucy tracking rows may still have addedById=Lucy; stamp speaker
  // so inventory «מה את צריכה» includes the mission task for that human.
  if (mission?.speakerId) {
    await prisma.employeeListItem.updateMany({
      where: { id: trackingItemId, deletedAt: null },
      data: { addedById: mission.speakerId },
    });
  }
}
