/**
 * Wave 1 Stage 2 — ProspectWriteGate (R1: zero LLM consent).
 * Detects durable personal / responsibility writes while consentPending.
 */
import {
  emptyLlmMetadata,
  type LlmMetadata,
} from "@workee/shared";

export type ProspectBlockedKind =
  | "save"
  | "reminder"
  | "list"
  | "filing"
  | "directory"
  | "assign_accept"
  | "job"
  | "mission";

export type ProspectWriteGateResult = {
  blocked: boolean;
  /** Metadata with durable mutates cleared (chat-safe). */
  metadata: LlmMetadata;
  actionKind: ProspectBlockedKind | null;
  summaryText: string;
  /** Snapshot to store for post-join execute. */
  snapshot: Record<string, unknown> | null;
};

function hasEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** True when metadata would persist personal / responsibility state. */
export function prospectMetadataHasDurableWrites(metadata: LlmMetadata): boolean {
  return (
    hasEntries(metadata.lists) ||
    hasEntries(metadata.listOps) ||
    hasEntries(metadata.filing) ||
    hasEntries(metadata.reminders) ||
    hasEntries(metadata.directory) ||
    hasEntries(metadata.jobs) ||
    hasEntries(metadata.missions) ||
    metadata.register != null
  );
}

export function classifyProspectBlockedKind(
  metadata: LlmMetadata,
): ProspectBlockedKind {
  if (hasEntries(metadata.reminders)) {
    return "reminder";
  }
  if (hasEntries(metadata.lists) || hasEntries(metadata.listOps)) {
    return "list";
  }
  if (hasEntries(metadata.filing)) {
    return "filing";
  }
  if (hasEntries(metadata.directory)) {
    return "directory";
  }
  if (hasEntries(metadata.jobs)) {
    return "job";
  }
  if (hasEntries(metadata.missions)) {
    return "mission";
  }
  return "save";
}

function summaryForKind(kind: ProspectBlockedKind, metadata: LlmMetadata): string {
  if (kind === "reminder" && metadata.reminders?.[0]) {
    const item = String(
      (metadata.reminders[0] as { item?: unknown }).item ?? "תזכורת",
    ).trim();
    return item.slice(0, 120) || "תזכורת";
  }
  if (kind === "list" && metadata.lists?.[0]) {
    const row = metadata.lists[0] as {
      items?: Array<Record<string, unknown>>;
      listName?: string;
    };
    const first = row.items?.[0];
    const label =
      (first &&
        String(
          first["שם פריט"] ?? first["שם משימה"] ?? first.name ?? first.title ?? "",
        ).trim()) ||
      String(row.listName ?? "").trim();
    return label.slice(0, 120) || "רשימה";
  }
  if (kind === "filing" && metadata.filing?.[0]) {
    return String(
      (metadata.filing[0] as { itemName?: unknown }).itemName ?? "תיעוד",
    )
      .trim()
      .slice(0, 120);
  }
  return "שמירה אישית";
}

/**
 * Strip durable writes for Prospects. Caller must stage PendingProspectAction
 * and attach Explicit Join CTA — never claim the action was saved.
 */
export function applyProspectWriteGate(
  metadata: LlmMetadata,
): ProspectWriteGateResult {
  if (!prospectMetadataHasDurableWrites(metadata)) {
    return {
      blocked: false,
      metadata,
      actionKind: null,
      summaryText: "",
      snapshot: null,
    };
  }
  const actionKind = classifyProspectBlockedKind(metadata);
  const summaryText = summaryForKind(actionKind, metadata);
  const snapshot = {
    v: 1,
    type: "prospect_pending_writes",
    metadata: {
      lists: metadata.lists ?? [],
      listOps: metadata.listOps ?? [],
      filing: metadata.filing ?? [],
      reminders: metadata.reminders ?? [],
      directory: metadata.directory ?? [],
      jobs: metadata.jobs ?? [],
      missions: metadata.missions ?? [],
      register: metadata.register ?? null,
    },
  };
  return {
    blocked: true,
    metadata: {
      ...emptyLlmMetadata(),
      // Keep conversational responses / messages empty of durable mutates.
      responses: metadata.responses,
      confirm: metadata.confirm,
    },
    actionKind,
    summaryText,
    snapshot,
  };
}

/** Hebrew join CTA body — never claims already saved. */
export function formatProspectJoinOfferText(input: {
  actionKind: ProspectBlockedKind | "circuit_breaker";
  summaryText?: string;
}): string {
  if (input.actionKind === "circuit_breaker") {
    return "כדי להמשיך לדבר איתי בחופשיות (בכפוף לתנאי השימוש), אשרי למטה:";
  }
  if (input.actionKind === "assign_accept") {
    return "בשמחה! כדי שאוכל לשמור אחריות על המשימה אצלך (בכפוף לתנאי השימוש), אשרי למטה ואז נאשר את הקבלה:";
  }
  const what = input.summaryText?.trim() || "את זה";
  return `בשמחה! כדי שאוכל לשמור לך תזכורות ורשימות אישיות (בכפוף לתנאי השימוש), אשרי למטה ומיד אשמור לך את «${what}»:`;
}

export function prospectJoinButtonLabel(
  actionKind: ProspectBlockedKind | "circuit_breaker",
): string {
  if (actionKind === "circuit_breaker") {
    return "להמשך שימוש חופשי בלוסי";
  }
  if (actionKind === "assign_accept") {
    return "אישור והצטרפות";
  }
  return "כן, תשמרי לי";
}

/** Free-text must never flip consent (R1). Hebrew has no JS `\b`, so use end/punct. */
export function freeTextLooksLikeJoinConsent(text: string): boolean {
  const t = text.trim();
  if (!t) {
    return false;
  }
  return /^(כן|תאשרי|תאשרו|תרשמי אותי|תרשום אותי|אני מסכים|אני מסכימה|מאשר|מאשרת|הצטרף|הצטרפי|הצטרפות)(?:[!?.,…\s]|$)/i.test(
    t,
  );
}
