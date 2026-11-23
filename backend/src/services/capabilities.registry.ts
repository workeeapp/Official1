/**
 * Single capability manifest — fed into Lucy / guest prompt builders.
 * Keep entries stable so Prompt Caching sees an unchanged prefix block.
 */

export type CapabilityAudience = "member" | "guest" | "any";

export type CapabilityDef = {
  /** Stable id (prompt-cache friendly). */
  id: string;
  /** Short Hebrew label for catalog lists. */
  labelHe: string;
  audience: CapabilityAudience;
  /** When true, highlighted in “מה את יודעת לעשות” live/external section. */
  externalLookup?: boolean;
};

/** Active product capabilities (order = catalog order). */
export const CAPABILITY_REGISTRY: readonly CapabilityDef[] = [
  { id: "lists", labelHe: "ניהול כל רשימה (הוספה/הסרה/עדכון + עמודות מותאמות)", audience: "member" },
  { id: "share", labelHe: "שיתוף רשימות ותיוקים", audience: "member" },
  { id: "meetings", labelHe: "פגישות ביומן משימות + תיאום עם משתתפים", audience: "member" },
  { id: "standing_tasks", labelHe: "משימות קבועות/חוזרות", audience: "member" },
  { id: "agenda", labelHe: "סדר יום ליום/שבוע", audience: "member" },
  { id: "filings", labelHe: "תיוקים", audience: "member" },
  { id: "phone_book", labelHe: "ספר טלפונים אישי", audience: "member" },
  { id: "messages", labelHe: "הודעות עכשיו או מאוחר יותר", audience: "member" },
  { id: "checks_nudges", labelHe: "בדיקות ונדנודים", audience: "member" },
  { id: "reminders", labelHe: "תזכורות", audience: "member" },
  { id: "scheduled_digests", labelHe: "שליחות מתוזמנות וסיכומים חיים", audience: "member" },
  {
    id: "weather",
    labelHe: "מזג אוויר עכשיו או מתוזמן (מטמון ExternalDataCache)",
    audience: "member",
    externalLookup: true,
  },
  {
    id: "markets",
    labelHe: "מניות, מדדים, קריפטו ושערי FX (מטמון ExternalDataCache)",
    audience: "member",
    externalLookup: true,
  },
  { id: "mashov", labelHe: "משוב בית־ספר (ציונים/שיעורים)", audience: "member" },
  { id: "places", labelHe: "חיפוש עסקים מקומיים (שעות פתיחה / בעל מקצוע בעיר)", audience: "member", externalLookup: true },
  {
    id: "jewish",
    labelHe: "שבת ולוח עברי מקומי (הדלקה/הבדלה/פרשה/חגים — חישוב דטרמיניסטי בלי רשת)",
    audience: "member",
  },
  { id: "transit", labelHe: "תחבורה ציבורית / יציאה עד / קווים בתחנה", audience: "member" },
  {
    id: "flights",
    labelHe: "לוח טיסות נתב״ג / TLV (מטמון קצר + ETA/שינויים)",
    audience: "member",
    externalLookup: true,
  },
  { id: "waze", labelHe: "ניווט Waze", audience: "member" },
  { id: "handoff", labelHe: "העברה לעובד דיגיטלי אחר", audience: "member" },
  {
    id: "web_lookup",
    labelHe: "חיפוש מאומת ברשת באותו תור (שעות פתיחה, אירועים/קולנוע/הופעות, עובדות חיצוניות)",
    audience: "member",
    externalLookup: true,
  },
  {
    id: "events_cinema",
    labelHe: "אירועים, קונצרטים ולוח קולנוע (דרך חיפוש מאומת + מטמון)",
    audience: "member",
    externalLookup: true,
  },
  {
    id: "guest_shared_view",
    labelHe: "צפייה ברשימות ששותפו איתך",
    audience: "guest",
  },
  {
    id: "guest_register",
    labelHe: "הרשמה לחשבון Workee משלך",
    audience: "guest",
  },
] as const;

export const CAPABILITY_LEAD_HE = "אני יודעת לנהל כל רשימה";

export const GUEST_CAPABILITY_LEAD_HE =
  "אני לוסי-אורח — אפשר לראות רשימות ששותפו איתך, ואפשר להירשם לחשבון Workee משלך.";

function forAudience(audience: CapabilityAudience): CapabilityDef[] {
  return CAPABILITY_REGISTRY.filter(
    (row) => row.audience === audience || row.audience === "any",
  );
}

/** Numbered Hebrew catalog — only for an explicit «הכול» / full-list ask. */
export function formatMemberCapabilityCatalogHe(): string {
  const rows = forAudience("member");
  const body = rows
    .map((row, i) => `(${i + 1}) ${row.labelHe}`)
    .join("; ");
  return `Lead «${CAPABILITY_LEAD_HE}» then ALL: ${body}. Saved data does not invent extra capabilities. No git digests / schema jargon.`;
}

/**
 * Default = VALUE DISCOVERY (short everyday examples + one question).
 * FULL catalog only when they explicitly ask for every capability / «הכול».
 * Registry body stays as a non-spoken support bound (do not invent beyond it).
 */
export function formatMemberCapabilityPromptRule(): string {
  const rows = forAudience("member");
  const body = rows
    .map((row, i) => `(${i + 1}) ${row.labelHe}`)
    .join("; ");
  return [
    "CAPABILITIES ASK / מה את יודעת לעשות / מה אפשר לעשות / איך להשתמש / מה עוד / forgetful «הכול בראש»:",
    "DEFAULT = VALUE DISCOVERY — short Hebrew, 2–3 concrete everyday examples from remember / save-find / manage (fit the utterance + THIS turn's live facts; do NOT mechanically dump all three pillars), then ONE natural question. Empty actions.",
    "FORBIDDEN on these asks: FULL catalog / numbered brochure / listing live tools (weather, markets, Mashov, transit, flights, Waze, handoff…) unless they explicitly asked for הכול / every capability / the full list.",
    `Only on that explicit full-list ask: ${formatMemberCapabilityCatalogHe()}`,
    `Supported surface (internal bound — never invent beyond these; do NOT recite on discovery): ${body}.`,
  ].join(" ");
}

export function formatGuestCapabilityPromptRule(): string {
  const rows = forAudience("guest")
    .map((row) => row.labelHe)
    .join("; ");
  return `If asked what you can do: «${GUEST_CAPABILITY_LEAD_HE}» (${rows}).`;
}

/** Stable prompt-cache block (append after static SYSTEM prefix). */
export function formatCapabilityRegistryPromptBlock(kind: "member" | "guest"): string {
  return kind === "guest"
    ? formatGuestCapabilityPromptRule()
    : formatMemberCapabilityPromptRule();
}

export function capabilityIds(): string[] {
  return CAPABILITY_REGISTRY.map((row) => row.id);
}
