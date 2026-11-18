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
  { id: "weather", labelHe: "מזג אוויר עכשיו או מתוזמן", audience: "member" },
  { id: "markets", labelHe: "מניות, מדדים וקריפטו", audience: "member" },
  { id: "mashov", labelHe: "משוב בית־ספר (ציונים/שיעורים)", audience: "member" },
  { id: "places", labelHe: "חיפוש עסקים מקומיים (שעות פתיחה / בעל מקצוע בעיר)", audience: "member", externalLookup: true },
  { id: "jewish", labelHe: "שבת ולוח עברי (זמנים + תזכורת לפני הדלקה)", audience: "member", externalLookup: true },
  { id: "transit", labelHe: "תחבורה ציבורית / יציאה עד / קווים בתחנה", audience: "member" },
  { id: "flights", labelHe: "לוח טיסות ו־ETA", audience: "member" },
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

/** Numbered Hebrew catalog for member Lucy «מה את יודעת לעשות». */
export function formatMemberCapabilityCatalogHe(): string {
  const rows = forAudience("member");
  const body = rows
    .map((row, i) => `(${i + 1}) ${row.labelHe}`)
    .join("; ");
  return `Lead «${CAPABILITY_LEAD_HE}» then ALL: ${body}. Saved data does not limit that answer. No git digests / schema jargon.`;
}

/** Compact English instruction line embedding the Hebrew catalog. */
export function formatMemberCapabilityPromptRule(): string {
  return `If asked what you can do / מה את יודעת לעשות: FULL catalog (same for every employee; not from saved data). ${formatMemberCapabilityCatalogHe()}`;
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
