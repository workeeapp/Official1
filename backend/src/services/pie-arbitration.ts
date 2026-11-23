/**
 * PIE-1/2 — Proactive Interaction Engine arbitration.
 *
 * Single gate for turn initiatives: consent CTA, raise, act_followup (reminder
 * offer), First Interaction (fi_*), capability tips. Max one initiative per
 * turn; Balanced cadence = at most one initiative per 3 inbound user messages.
 *
 * PIE-2: durable preference + suppressKeys hydrate the gate. Quiet blocks
 * discovery (capability/tip + FI) only — not act_followup reminder-offer,
 * consent, or critical raise. Raise is Opportunity — never Value here (PIE-3).
 * proactive preference is stored but behaves like balanced in PIE-2.
 */

import type { LlmSpokenBubble } from "@workee/shared";
import {
  bubblesHaveOpenAsk,
  type FiOpportunityKind,
} from "./first-interaction.js";
import {
  bubblesHaveSoftYesNoOffer,
  injectPostSaveReminderOfferBubbles,
  shouldInjectPostSaveReminderOffer,
} from "./post-save-reminder-offer.js";
import type { InitiativePreferenceMode } from "./pie-interaction-state.js";

export type PieOpportunityKind =
  | "consent_cta"
  | "open_item_raise"
  | "act_followup"
  | "fi_invite_act"
  | "fi_first_try"
  | "fi_member_first_save"
  | "capability_opportunity";

export type PieArbitrationDecision = {
  /** Kind chosen for this turn, or null = Quiet (no new initiative). */
  chosenKind: PieOpportunityKind | null;
  /** Inject post-save reminder offer bubble. */
  injectReminderOffer: boolean;
  /** Inject First Interaction soft Act offer (record-before-emit in chat). */
  injectFirstInteraction: boolean;
  /**
   * Inject invite FI direct present (item + act taps) — not a show Offer.
   * Delivery of pending invite context; still one initiative slot.
   */
  injectInviteDirectPresent: boolean;
  /** Allow tip resolver to emit (still subject to tip next-step filter). */
  allowTipResolve: boolean;
  /** Never enable legacy prospect auto-pick. */
  allowProspectAuto: boolean;
  /** Why Quiet / why this pick — for tests and logs. */
  reason: string;
};

function emptyDecision(
  partial: Partial<PieArbitrationDecision> & { reason: string },
): PieArbitrationDecision {
  return {
    chosenKind: null,
    injectReminderOffer: false,
    injectFirstInteraction: false,
    injectInviteDirectPresent: false,
    allowTipResolve: false,
    allowProspectAuto: false,
    ...partial,
  };
}

/** Inbound spacing for Balanced: initiative on turn T → next at T+3 or later. */
export const PIE_BALANCED_INBOUND_GAP = 3;

/**
 * Global Quiet preference utterances.
 * Scoped «אל תציעי לי את זה» is handled separately (opportunityKey suppress) —
 * do not treat it as Quiet here.
 */
const QUIET_UTTERANCE_RE =
  /תפסיק[י]? להציע|פחות הצעות|בלי הצעות|די עם ההצעות|תפסיק[י]? עם ההצעות|אל תציע[י]?\s+יותר/u;

const PROACTIVE_UTTERANCE_RE = /תציע[י]?\s+יותר|יותר הצעות/u;
const BALANCED_UTTERANCE_RE = /^(רגיל|חזרה לרגיל|הצעות רגילות)$/u;

/**
 * Primary raise actions (overdue / stale OPEN_JOBS raises).
 * LIST/show nav («הצג משימות») is NOT a raise — those are post-mutate
 * taps from employee-targets plainButtonForListKey / show_dump commands.
 * A raise bubble may *also* include «הצג את המשימות» as a secondary tap;
 * detection requires at least one primary action below.
 */
const RAISE_ACTION_LABEL_RE =
  /^(סגירה|עדכן מועד(?: להיום)?|להוסיף תאריך)$/u;

/** Engine LIST / overview / item-open navigation — never counts as raise. */
const LIST_NAV_COMMAND_RE =
  /^(הצג משימות|הצג קניות|הצג אנשי קשר|הצג תיוקים|הצג רשימות|הצג רשימת\b|הצג משימות של\b|הציגי את |הצג את המשימה|מה יש לי\b)/u;

/**
 * Consent / high-risk / Prospect Join CTAs that own the turn.
 * Includes Explicit Join labels from prospect-write-gate (כן תשמרי לי,
 * להמשך שימוש חופשי בלוסי, אישור והצטרפות) so tips cannot compete.
 */
const CONSENT_BUTTON_RE =
  /^(אני מאשר|אני מאשרת|ביטול|דחה|דחייה|אשר מחיקה|אל תמחק)$|הצטרפ|Accept|Decline|כן,\s*תשמרי לי|להמשך שימוש חופשי בלוסי|אישור והצטרפות/iu;

/** Last inbound turn index (1-based count) when an initiative was emitted. */
const lastInitiativeInboundByConversation = new Map<string, number>();

/** Conversation ids with explicit Quiet this session (also derived from messages). */
const sessionQuietConversations = new Set<string>();

/** @internal tests */
export function resetPieArbitrationStateForTests(): void {
  lastInitiativeInboundByConversation.clear();
  sessionQuietConversations.clear();
}

export function isExplicitQuietUtterance(text: string): boolean {
  const t = String(text ?? "").trim();
  // Scoped suppress is not Quiet.
  if (/אל תציע[י]?(?:\s+לי)?\s+את\s+/u.test(t)) {
    return false;
  }
  return QUIET_UTTERANCE_RE.test(t);
}

export function isExplicitProactiveUtterance(text: string): boolean {
  return PROACTIVE_UTTERANCE_RE.test(String(text ?? "").trim());
}

export function isExplicitBalancedUtterance(text: string): boolean {
  return BALANCED_UTTERANCE_RE.test(String(text ?? "").trim());
}

export function markSessionQuiet(conversationId: string): void {
  if (conversationId) {
    sessionQuietConversations.add(conversationId);
  }
}

export function isSessionQuiet(conversationId: string): boolean {
  return Boolean(conversationId) && sessionQuietConversations.has(conversationId);
}

export function notePieInitiativeEmitted(
  conversationId: string,
  inboundTurnCount: number,
): void {
  if (!conversationId) {
    return;
  }
  lastInitiativeInboundByConversation.set(
    conversationId,
    Math.max(1, inboundTurnCount),
  );
}

export function pieCadenceAllowsInitiative(
  conversationId: string,
  inboundTurnCount: number,
): boolean {
  const last = lastInitiativeInboundByConversation.get(conversationId);
  if (last == null) {
    return true;
  }
  return inboundTurnCount - last >= PIE_BALANCED_INBOUND_GAP;
}

/** True when label/command is post-mutate LIST or dump navigation. */
export function buttonIsListNavigation(button: {
  label: string;
  command: string;
}): boolean {
  const label = button.label.trim();
  const command = button.command.trim();
  return LIST_NAV_COMMAND_RE.test(command) || LIST_NAV_COMMAND_RE.test(label);
}

/** True when label/command is a primary overdue/stale raise action. */
export function buttonIsRaiseAction(button: {
  label: string;
  command: string;
}): boolean {
  if (buttonIsListNavigation(button)) {
    return false;
  }
  const label = button.label.trim();
  const command = button.command.trim();
  return (
    RAISE_ACTION_LABEL_RE.test(label) || RAISE_ACTION_LABEL_RE.test(command)
  );
}

export function bubbleLooksLikeRaise(bubble: LlmSpokenBubble): boolean {
  return (bubble.buttons ?? []).some((button) => buttonIsRaiseAction(button));
}

export function bubbleLooksLikeConsentCta(bubble: LlmSpokenBubble): boolean {
  return (bubble.buttons ?? []).some((button) => {
    if (buttonIsListNavigation(button)) {
      return false;
    }
    return CONSENT_BUTTON_RE.test(button.label.trim());
  });
}

export function bubblesHaveRaise(bubbles: LlmSpokenBubble[]): boolean {
  return bubbles.some((bubble) => bubbleLooksLikeRaise(bubble));
}

export function bubblesHaveConsentCta(bubbles: LlmSpokenBubble[]): boolean {
  return bubbles.some((bubble) => bubbleLooksLikeConsentCta(bubble));
}

/**
 * Strict next-step: tip must invite an immediate user action (question + verb),
 * not a bare capability ad («אפשר גם…» / «דרך אגב…»).
 */
export function tipTextHasNextStep(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) {
    return false;
  }
  const directsOfferOrAsk =
    /offer|ask (them|whether)|yes\/no|כן\/לא|רוצה/i.test(t);
  // Dynamic / author instructions (shown only after compose) — require an offer/ask.
  // Covers "Write one short…" and entity follow-ups like web_lookup ("After… offer…").
  if (
    /^Write one short/i.test(t) ||
    /^After\b/i.test(t) ||
    /\bwrite one short hebrew tip\b/i.test(t)
  ) {
    return directsOfferOrAsk;
  }
  // Capability broadcast patterns without a clear ask → reject.
  if (
    /^(לידיעתך|דרך אגב|אפשר גם|כדאי לנסות|אני ממליצה)/u.test(t) &&
    !/\?/.test(t)
  ) {
    return false;
  }
  return /\?/.test(t) && /(רוצה|נשמור|אוסיף|לשתף|להוסיף|אשמור|נרצה)/u.test(t);
}

export function tipKeyExcludedAsCapabilityAd(key: string): boolean {
  const k = key.trim();
  if (k.startsWith("prospect_onboard_")) {
    return true;
  }
  if (k.startsWith("general_")) {
    return true;
  }
  return false;
}

function discoveryQuiet(input: {
  conversationId: string;
  preferenceMode?: InitiativePreferenceMode | null;
}): boolean {
  if (input.preferenceMode === "quiet") {
    return true;
  }
  return isSessionQuiet(input.conversationId);
}

/**
 * Decide which single initiative may fire this turn.
 * Cadence uses process maps; Quiet/suppress hydrate from PIE-2 State.
 */
export function decidePieArbitration(input: {
  conversationId: string;
  inboundTurnCount: number;
  inboundUserText: string;
  bubbles: LlmSpokenBubble[];
  /** Engine would inject post-save reminder offer. */
  reminderOfferEligible: boolean;
  /** High-risk / join CTA already owns the turn (engine flag). */
  consentOwnsTurn?: boolean;
  /** Tip resolver has at least one next-step-eligible candidate ready. */
  tipCandidateAvailable?: boolean;
  /**
   * Soft FI candidate (cold / member). Invite uses inviteDirectPresent instead.
   * Soft FI is discovery — Quiet / open Ask / other Act block it.
   */
  fiCandidate?: {
    kind: FiOpportunityKind;
    opportunityKey: string;
  } | null;
  /**
   * Invite item can be shown this turn (pendingInvite + safe title).
   * Not blocked by Quiet — delivering the invite they arrived for.
   */
  inviteDirectPresent?: {
    opportunityKey: string;
  } | null;
  /**
   * Open invite FI (presented, not yet Valued) — user still on that item.
   * Blocks competing tips / soft FI; does not inject anything.
   * Prefer `progressEngagementActive` (W1); this flag remains for Invite FI callers.
   */
  inviteEngagementActive?: boolean;
  /**
   * W1 Progress Arbitration: live progress candidate (open FI and/or raisable
   * OPEN_JOBS including overdue/stale). Blocks tips / soft FI; does not inject
   * a second raise (model/engine raise paths unchanged).
   */
  progressEngagementActive?: boolean;
  /** PIE-2 durable preference (proactive ≡ balanced behavior). */
  preferenceMode?: InitiativePreferenceMode | null;
  /** PIE-2 keys that must not be re-offered. */
  suppressKeys?: ReadonlySet<string> | null;
  /** Candidate reminder opportunityKey (for suppress check). */
  reminderOpportunityKey?: string | null;
}): PieArbitrationDecision {
  const inboundTurnCount = Math.max(1, input.inboundTurnCount);
  if (isExplicitQuietUtterance(input.inboundUserText)) {
    markSessionQuiet(input.conversationId);
  }
  const quietDiscovery = discoveryQuiet({
    conversationId: input.conversationId,
    preferenceMode: input.preferenceMode,
  });

  const consent =
    input.consentOwnsTurn === true || bubblesHaveConsentCta(input.bubbles);
  if (consent) {
    return emptyDecision({
      chosenKind: "consent_cta",
      reason: "consent_cta_owns_turn",
    });
  }

  if (bubblesHaveRaise(input.bubbles)) {
    // Raise is Opportunity occupying the slot — not Value by itself.
    return emptyDecision({
      chosenKind: "open_item_raise",
      reason: "raise_opportunity_occupies_turn",
    });
  }

  if (bubblesHaveSoftYesNoOffer(input.bubbles)) {
    return emptyDecision({
      chosenKind: "act_followup",
      reason: "soft_offer_already_in_bubbles",
    });
  }

  if (bubblesHaveOpenAsk(input.bubbles)) {
    return emptyDecision({
      reason: "open_ask_owns_turn",
    });
  }

  const reminderKey = input.reminderOpportunityKey?.trim() || "";
  const reminderSuppressed =
    Boolean(reminderKey) &&
    Boolean(input.suppressKeys?.has(reminderKey));
  const reminderEligible =
    input.reminderOfferEligible && !reminderSuppressed;

  const inviteKey = input.inviteDirectPresent?.opportunityKey?.trim() || "";
  const inviteDirectEligible =
    Boolean(inviteKey) && !input.suppressKeys?.has(inviteKey);

  // Quiet blocks discovery only — reminder + invite direct present still allowed.
  if (quietDiscovery && !reminderEligible && !inviteDirectEligible) {
    return emptyDecision({ reason: "session_quiet" });
  }

  if (!pieCadenceAllowsInitiative(input.conversationId, inboundTurnCount)) {
    return emptyDecision({ reason: "cadence_1_per_3_inbound" });
  }

  // Priority: act_followup > invite direct present > soft FI > tips.
  // Prospect auto is never enabled (must not bypass).
  if (reminderEligible) {
    return emptyDecision({
      chosenKind: "act_followup",
      injectReminderOffer: true,
      reason: quietDiscovery
        ? "act_followup_reminder_offer_under_quiet"
        : "act_followup_reminder_offer",
    });
  }

  if (inviteDirectEligible) {
    return emptyDecision({
      chosenKind: "fi_invite_act",
      injectInviteDirectPresent: true,
      reason: "fi_invite_direct_present",
    });
  }

  // Progress candidate live — no competing tip / soft FI (raise inject stays model-led).
  if (
    input.progressEngagementActive === true ||
    input.inviteEngagementActive === true
  ) {
    return emptyDecision({
      reason:
        input.progressEngagementActive === true
          ? "progress_engagement_active"
          : "fi_invite_engagement_active",
    });
  }

  if (quietDiscovery) {
    return emptyDecision({ reason: "session_quiet" });
  }

  const fiKey = input.fiCandidate?.opportunityKey?.trim() || "";
  const fiKind = input.fiCandidate?.kind;
  const fiEligible =
    Boolean(fiKey) &&
    Boolean(fiKind) &&
    !input.suppressKeys?.has(fiKey);
  if (fiEligible && fiKind) {
    return emptyDecision({
      chosenKind: fiKind,
      injectFirstInteraction: true,
      reason: `first_interaction_${fiKind}`,
    });
  }

  if (input.tipCandidateAvailable) {
    return emptyDecision({
      chosenKind: "capability_opportunity",
      allowTipResolve: true,
      reason: "capability_opportunity_with_next_step",
    });
  }

  return emptyDecision({ reason: "quiet_no_qualified_candidate" });
}

/**
 * Apply arbitration to bubbles + tip gate for the chat turn.
 * Call instead of independently injecting reminder offer and resolving tips.
 */
export function applyPieReminderOfferIfChosen(input: {
  decision: PieArbitrationDecision;
  metadata: Parameters<typeof shouldInjectPostSaveReminderOffer>[0]["metadata"];
  listMutations: Parameters<
    typeof shouldInjectPostSaveReminderOffer
  >[0]["listMutations"];
  reminderSavedCount: number;
  bubbles: LlmSpokenBubble[];
}): LlmSpokenBubble[] {
  if (!input.decision.injectReminderOffer) {
    return input.bubbles;
  }
  if (
    !shouldInjectPostSaveReminderOffer({
      metadata: input.metadata,
      listMutations: input.listMutations,
      reminderSavedCount: input.reminderSavedCount,
      bubbles: input.bubbles,
    })
  ) {
    return input.bubbles;
  }
  return injectPostSaveReminderOfferBubbles(input.bubbles);
}
