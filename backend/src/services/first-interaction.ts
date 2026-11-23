/**
 * First Interaction (FI) — Stage 1 skeleton (+ invite UX correction).
 *
 * Invite (`fi_invite_act`): direct present of the invite item — no Offer/Accept
 * to show. Value only after a meaningful user mutate (not mere display).
 * Cold / Member: engine no longer injects a fixed soft Act (חלב / רופא).
 * First Value is model-led via Stage A + live facts; builders remain for tests.
 */

import type { LlmReplyButton, LlmSpokenBubble } from "@workee/shared";
import type { PendingInviteContext } from "./whatsapp-invite.service.js";

export type FiOpportunityKind =
  | "fi_invite_act"
  | "fi_first_try"
  | "fi_member_first_save";

export type FiPhase =
  | "invite_act"
  | "cold_first_try"
  | "member_first_save"
  | "done"
  | "skip";

/** Soft כן/לא Act offer (cold + member only). */
export type FiCandidate = {
  kind: FiOpportunityKind;
  opportunityKey: string;
  entityRef: string | null;
  text: string;
  buttons: LlmReplyButton[];
  /** Concrete inbound command that counts as Accept → drive the act. */
  acceptCommand: string;
};

/** Engine-led invite opening: show the item + act taps (no כן/לא show Offer). */
export type FiInviteDirectPresent = {
  kind: "fi_invite_act";
  opportunityKey: string;
  entityRef: string | null;
  text: string;
  buttons: LlmReplyButton[];
  /** Task/activity title used for act commands. */
  itemTitle: string;
};

export type InvitePresentCollabHint = {
  inviteId: string;
  askerName: string;
  askSummary: string;
  kind: "share" | "assign";
  /** Scoped value when available; omit / empty / "unavailable" → not safe. */
  inviteValueText?: string | null;
};

export const FI_COLD_SHOP_ITEM = "חלב";
export const FI_MEMBER_TASK_TITLE = "להתקשר לרופא";

export function isFiOpportunityKind(kind: string): kind is FiOpportunityKind {
  return (
    kind === "fi_invite_act" ||
    kind === "fi_first_try" ||
    kind === "fi_member_first_save"
  );
}

export function isFiOpportunityKey(key: string): boolean {
  return (
    key.startsWith("fi_invite_act:") ||
    key.startsWith("fi_first_try:") ||
    key.startsWith("fi_member_first_save:")
  );
}

export function fiInviteOpportunityKey(inviteId: string): string {
  return `fi_invite_act:${inviteId.trim()}`;
}

export function fiColdOpportunityKey(employeeId: string): string {
  return `fi_first_try:${employeeId.trim()}`;
}

export function fiMemberOpportunityKey(employeeId: string): string {
  return `fi_member_first_save:${employeeId.trim()}`;
}

/** Soft כן/לא labels; Accept command carries the concrete act utterance. */
function yesNoActButtons(acceptCommand: string): LlmReplyButton[] {
  return [
    { label: "כן", command: acceptCommand },
    { label: "לא", command: "לא" },
  ];
}

/**
 * @deprecated Invite no longer uses soft show-Offer. Kept for tests / fallbacks.
 */
export function buildInviteFiCandidate(input: {
  invite: PendingInviteContext;
}): FiCandidate {
  const activity = input.invite.askSummary.trim() || "הפריט מההזמנה";
  const asker = input.invite.askerName.trim() || "מישהו";
  const acceptCommand = `הציגי את המשימה מההזמנה של ${asker}`;
  return {
    kind: "fi_invite_act",
    opportunityKey: fiInviteOpportunityKey(input.invite.inviteId),
    entityRef: input.invite.inviteId,
    text: `רוצה שאראה לך את «${activity}» מ${asker}?`,
    buttons: yesNoActButtons(acceptCommand),
    acceptCommand,
  };
}

export function buildColdFiCandidate(input: {
  employeeId: string;
}): FiCandidate {
  const acceptCommand = `תוסיפי ${FI_COLD_SHOP_ITEM} לקניות`;
  return {
    kind: "fi_first_try",
    opportunityKey: fiColdOpportunityKey(input.employeeId),
    entityRef: input.employeeId,
    text: `רוצה שנתחיל בקניות — אוסיף ${FI_COLD_SHOP_ITEM}?`,
    buttons: yesNoActButtons(acceptCommand),
    acceptCommand,
  };
}

export function buildMemberFiCandidate(input: {
  employeeId: string;
}): FiCandidate {
  const acceptCommand = `תוסיפי משימה: ${FI_MEMBER_TASK_TITLE}`;
  return {
    kind: "fi_member_first_save",
    opportunityKey: fiMemberOpportunityKey(input.employeeId),
    entityRef: input.employeeId,
    text: `רוצה שאשמור לך משימה ראשונה — ${FI_MEMBER_TASK_TITLE}?`,
    buttons: yesNoActButtons(acceptCommand),
    acceptCommand,
  };
}

function normalizeInviteTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^משימה:\s*/i, "")
    .replace(/\s+/g, " ");
}

/**
 * Resolve whether the invite item can be shown safely (no ACL/Gate bypass).
 * Prefer collab scoped value when present; else pending askSummary.
 */
export function resolveInviteFiDirectPresent(input: {
  invite: PendingInviteContext;
  collabInvites?: InvitePresentCollabHint[] | null;
}):
  | { status: "present"; present: FiInviteDirectPresent }
  | { status: "unavailable"; opportunityKey: string } {
  const opportunityKey = fiInviteOpportunityKey(input.invite.inviteId);
  const matched =
    (input.collabInvites ?? []).find(
      (row) => row.inviteId === input.invite.inviteId,
    ) ??
    (input.collabInvites ?? []).find(
      (row) =>
        normalizeInviteTitle(row.askSummary) ===
        normalizeInviteTitle(input.invite.askSummary),
    ) ??
    null;

  const asker =
    matched?.askerName.trim() ||
    input.invite.askerName.trim() ||
    "מישהו";

  const scoped = matched?.inviteValueText?.trim() ?? "";
  if (scoped && !/^unavailable$/i.test(scoped)) {
    const itemTitle = normalizeInviteTitle(scoped.split("\n")[0] ?? scoped);
    if (!itemTitle) {
      return { status: "unavailable", opportunityKey };
    }
    return {
      status: "present",
      present: buildInviteDirectPresent({
        inviteId: input.invite.inviteId,
        opportunityKey,
        asker,
        itemTitle,
      }),
    };
  }

  // Assign often has no inviteValueText — askSummary is the activity title.
  const fromPending = normalizeInviteTitle(input.invite.askSummary);
  if (
    !fromPending ||
    fromPending === "פריט" ||
    fromPending === "פריט משותף" ||
    fromPending === "משימה"
  ) {
    return { status: "unavailable", opportunityKey };
  }

  return {
    status: "present",
    present: buildInviteDirectPresent({
      inviteId: input.invite.inviteId,
      opportunityKey,
      asker,
      itemTitle: fromPending,
    }),
  };
}

function buildInviteDirectPresent(input: {
  inviteId: string;
  opportunityKey: string;
  asker: string;
  itemTitle: string;
}): FiInviteDirectPresent {
  const title = input.itemTitle;
  return {
    kind: "fi_invite_act",
    opportunityKey: input.opportunityKey,
    entityRef: input.inviteId,
    itemTitle: title,
    text: `מאת ${input.asker}: ${title}`,
    buttons: [
      { label: "סמן כבוצע", command: `סמן כבוצע: ${title}` },
      { label: "עדכן", command: `עדכן את: ${title}` },
    ],
  };
}

/**
 * Decide which FI opportunity (if any) may be offered this turn.
 * Invite phase returns no soft candidate — chat uses direct present instead.
 */
export function resolveFiPhase(input: {
  isProspect: boolean;
  guestSpeaker?: boolean;
  pendingInvite: PendingInviteContext | null;
  /** Speaker already has owned lists / filings / reminders in ESD. */
  hasPersonalRecords: boolean;
  /** Keys actively suppressed (offered / accepted / declined TTL / indefinite). */
  suppressKeys: ReadonlySet<string>;
  employeeId: string;
}): { phase: FiPhase; candidate: FiCandidate | null } {
  if (input.guestSpeaker) {
    return { phase: "skip", candidate: null };
  }

  if (input.isProspect && input.pendingInvite) {
    const key = fiInviteOpportunityKey(input.pendingInvite.inviteId);
    if (input.suppressKeys.has(key)) {
      return { phase: "done", candidate: null };
    }
    // Soft show-Offer removed: delivery is direct present (or unavailable fallback).
    return { phase: "invite_act", candidate: null };
  }

  if (input.isProspect) {
    const key = fiColdOpportunityKey(input.employeeId);
    if (input.suppressKeys.has(key) || input.hasPersonalRecords) {
      return { phase: "done", candidate: null };
    }
    // Model-led First Value — do not inject fixed «חלב» soft offer.
    return { phase: "cold_first_try", candidate: null };
  }

  const key = fiMemberOpportunityKey(input.employeeId);
  if (input.suppressKeys.has(key) || input.hasPersonalRecords) {
    return { phase: "done", candidate: null };
  }
  // Model-led First Value — do not inject fixed «להתקשר לרופא» soft offer.
  return { phase: "member_first_save", candidate: null };
}

/**
 * True when this turn’s applied work counts as FI Value for the kind.
 *
 * Invite: meaningful user mutate only — dump / direct present is NOT Value
 * (goal is user action on the invite item).
 */
export function fiActSucceeded(input: {
  kind: FiOpportunityKind;
  listMutations: Array<{ action: string }>;
  reminderSavedCount: number;
  /** @deprecated Ignored for fi_invite_act (display ≠ Value). */
  dumpReplaced?: boolean;
}): boolean {
  const reminderOk = input.reminderSavedCount > 0;
  if (input.kind === "fi_invite_act") {
    return (
      input.listMutations.some(
        (row) =>
          row.action === "add" ||
          row.action === "update" ||
          row.action === "remove",
      ) || reminderOk
    );
  }
  // Cold + member: durable personal save only (not Join-gated empty apply).
  return (
    input.listMutations.some((row) => row.action === "add") || reminderOk
  );
}

export function bubblesHaveFiOffer(bubbles: LlmSpokenBubble[]): boolean {
  return bubbles.some((bubble) =>
    (bubble.buttons ?? []).some(
      (button) =>
        button.command.trim() !== "לא" &&
        (button.label.trim() === "כן" ||
          /הציגי את המשימה מההזמנה|תוסיפי .+ לקניות|תוסיפי משימה:/u.test(
            button.command.trim(),
          )),
    ),
  );
}

export function bubblesHaveFiInvitePresent(
  bubbles: LlmSpokenBubble[],
): boolean {
  return bubbles.some((bubble) =>
    (bubble.buttons ?? []).some(
      (button) =>
        button.label.trim() === "סמן כבוצע" ||
        /^סמן כבוצע:/u.test(button.command.trim()),
    ),
  );
}

export function injectFiOfferBubble(
  bubbles: LlmSpokenBubble[],
  candidate: FiCandidate,
): LlmSpokenBubble[] {
  if (bubblesHaveFiOffer(bubbles)) {
    return bubbles;
  }
  return [
    ...bubbles,
    {
      text: candidate.text,
      buttons: candidate.buttons,
    },
  ];
}

export function injectFiInviteDirectPresentBubble(
  bubbles: LlmSpokenBubble[],
  present: FiInviteDirectPresent,
): LlmSpokenBubble[] {
  if (bubblesHaveFiInvitePresent(bubbles)) {
    return bubbles;
  }
  // Prefer a single opening composition: if the model only greeted, replace
  // with the invite present; otherwise append so consent/raise stay intact.
  const onlyGreeting =
    bubbles.length === 1 &&
    (bubbles[0]?.buttons?.length ?? 0) === 0 &&
    !/\?\s*$/u.test(String(bubbles[0]?.text ?? "").trim());
  const presentBubble: LlmSpokenBubble = {
    text: present.text,
    buttons: present.buttons,
  };
  if (onlyGreeting || bubbles.length === 0) {
    return [presentBubble];
  }
  return [...bubbles, presentBubble];
}

/** Clarifying Ask without CTA buttons — blocks FI/tips discovery this turn. */
export function bubblesHaveOpenAsk(bubbles: LlmSpokenBubble[]): boolean {
  return bubbles.some((bubble) => {
    const buttons = bubble.buttons ?? [];
    if (buttons.length > 0) {
      return false;
    }
    const text = String(bubble.text ?? "").trim();
    return /\?\s*$/u.test(text);
  });
}

export function inboundMatchesFiDecline(text: string): boolean {
  return /^(לא)$/u.test(String(text ?? "").trim());
}

export function inboundMatchesFiAccept(
  text: string,
  acceptCommand: string,
): boolean {
  const t = String(text ?? "").trim();
  if (!t) {
    return false;
  }
  if (t === acceptCommand.trim()) {
    return true;
  }
  return t === "כן";
}
