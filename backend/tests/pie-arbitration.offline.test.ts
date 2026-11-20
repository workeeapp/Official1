import { describe, expect, it, beforeEach } from "vitest";
import {
  PIE_BALANCED_INBOUND_GAP,
  bubbleLooksLikeRaise,
  bubblesHaveRaise,
  buttonIsListNavigation,
  buttonIsRaiseAction,
  decidePieArbitration,
  isExplicitQuietUtterance,
  notePieInitiativeEmitted,
  pieCadenceAllowsInitiative,
  resetPieArbitrationStateForTests,
  tipKeyExcludedAsCapabilityAd,
  tipTextHasNextStep,
} from "../src/services/pie-arbitration.js";
import {
  POST_SAVE_REMINDER_OFFER_BUTTONS,
  POST_SAVE_REMINDER_OFFER_TEXT,
} from "../src/services/post-save-reminder-offer.js";

const CONV = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("PIE-1 arbitration", () => {
  beforeEach(() => {
    resetPieArbitrationStateForTests();
  });

  it("detects explicit Quiet utterances", () => {
    expect(isExplicitQuietUtterance("תפסיקי להציע בבקשה")).toBe(true);
    expect(isExplicitQuietUtterance("פחות הצעות")).toBe(true);
    expect(isExplicitQuietUtterance("תוסיפי חלב לקניות")).toBe(false);
  });

  it("rejects capability ads and prospect keys for next-step", () => {
    expect(tipKeyExcludedAsCapabilityAd("prospect_onboard_tasks")).toBe(true);
    expect(tipKeyExcludedAsCapabilityAd("general_weather")).toBe(true);
    expect(
      tipTextHasNextStep("דרך אגב, אפשר גם לבקש מזג אוויר."),
    ).toBe(false);
    expect(
      tipTextHasNextStep("רוצה שאוסיף לזה גם תזכורת?"),
    ).toBe(true);
  });

  it("consent CTA wins over reminder offer and tips", () => {
    const decision = decidePieArbitration({
      conversationId: CONV,
      inboundTurnCount: 1,
      inboundUserText: "מחק",
      bubbles: [
        {
          text: "לאשר מחיקה?",
          buttons: [{ label: "אני מאשר", command: "אני מאשר" }],
        },
      ],
      reminderOfferEligible: true,
      tipCandidateAvailable: true,
      consentOwnsTurn: true,
    });
    expect(decision.chosenKind).toBe("consent_cta");
    expect(decision.injectReminderOffer).toBe(false);
    expect(decision.allowTipResolve).toBe(false);
    expect(decision.allowProspectAuto).toBe(false);
  });

  it("J1: Prospect Join CTA labels own the turn (no tip)", () => {
    for (const label of [
      "כן, תשמרי לי",
      "להמשך שימוש חופשי בלוסי",
      "אישור והצטרפות",
    ] as const) {
      const decision = decidePieArbitration({
        conversationId: CONV,
        inboundTurnCount: 1,
        inboundUserText: "תוסיפי חלב",
        bubbles: [
          {
            text: "אשרי למטה",
            buttons: [{ label, command: "explicit_join_accept:x" }],
          },
        ],
        reminderOfferEligible: true,
        tipCandidateAvailable: true,
      });
      expect(decision.chosenKind, label).toBe("consent_cta");
      expect(decision.allowTipResolve, label).toBe(false);
      expect(decision.injectReminderOffer, label).toBe(false);
    }
  });

  it("J1b: consentOwnsTurn flag from Join gates blocks tips without bubble match", () => {
    const decision = decidePieArbitration({
      conversationId: CONV,
      inboundTurnCount: 1,
      inboundUserText: "היי",
      bubbles: [{ text: "היי" }],
      reminderOfferEligible: false,
      tipCandidateAvailable: true,
      consentOwnsTurn: true,
    });
    expect(decision.chosenKind).toBe("consent_cta");
    expect(decision.allowTipResolve).toBe(false);
  });

  it("J2: without Join/consent, tip resolve may still be allowed", () => {
    const decision = decidePieArbitration({
      conversationId: CONV,
      inboundTurnCount: 1,
      inboundUserText: "היי",
      bubbles: [{ text: "היי" }],
      reminderOfferEligible: false,
      tipCandidateAvailable: true,
      consentOwnsTurn: false,
    });
    expect(decision.chosenKind).toBe("capability_opportunity");
    expect(decision.allowTipResolve).toBe(true);
  });

  it("«הצג משימות» LIST nav is not a Raise", () => {
    const nav = {
      label: "הצג משימות",
      command: "הצג רשימת משימות",
    };
    expect(buttonIsListNavigation(nav)).toBe(true);
    expect(buttonIsRaiseAction(nav)).toBe(false);
    expect(
      bubbleLooksLikeRaise({
        text: "שמרתי.",
        buttons: [
          nav,
          { label: "רופא", command: "הציגי את המשימה רופא" },
          { label: "מה מחר", command: "מה יש לי ב־2026-11-20 ברשימת משימות" },
        ],
      }),
    ).toBe(false);
    expect(
      bubblesHaveRaise([
        {
          text: "שמרתי.",
          buttons: [nav],
        },
      ]),
    ).toBe(false);
  });

  it("real overdue Raise is detected even with secondary show tap", () => {
    const raiseBubble = {
      text: "יש משימה שעבר זמנה",
      buttons: [
        { label: "סגירה", command: "סגירה" },
        { label: "עדכן מועד להיום", command: "עדכן מועד להיום" },
        { label: "הצג את המשימות", command: "הצג את המשימות" },
      ],
    };
    expect(buttonIsRaiseAction(raiseBubble.buttons[0]!)).toBe(true);
    expect(buttonIsListNavigation(raiseBubble.buttons[2]!)).toBe(false);
    // Secondary overdue show tap is not LIST nav command shape — ignored as
    // raise-action; primary סגירה still marks the bubble.
    expect(bubbleLooksLikeRaise(raiseBubble)).toBe(true);
  });

  it("raise opportunity occupies the turn (not Value by itself)", () => {
    const bubbles = [
      { text: "היי" },
      {
        text: "יש משימה שעבר זמנה",
        buttons: [
          { label: "סגירה", command: "סגירה" },
          { label: "עדכן מועד להיום", command: "עדכן מועד להיום" },
        ],
      },
    ];
    expect(bubblesHaveRaise(bubbles)).toBe(true);
    const decision = decidePieArbitration({
      conversationId: CONV,
      inboundTurnCount: 1,
      inboundUserText: "היי",
      bubbles,
      reminderOfferEligible: true,
      tipCandidateAvailable: true,
    });
    expect(decision.chosenKind).toBe("open_item_raise");
    expect(decision.injectReminderOffer).toBe(false);
    expect(decision.allowTipResolve).toBe(false);
  });

  it("post-save reminder still injects when LIST nav buttons are present", () => {
    const decision = decidePieArbitration({
      conversationId: CONV,
      inboundTurnCount: 1,
      inboundUserText: "משימה מחר ב־10",
      bubbles: [
        {
          text: "שמרתי.",
          buttons: [
            { label: "הצג משימות", command: "הצג רשימת משימות" },
            { label: "רופא", command: "הציגי את המשימה רופא" },
          ],
        },
      ],
      reminderOfferEligible: true,
      tipCandidateAvailable: true,
    });
    expect(decision.chosenKind).toBe("act_followup");
    expect(decision.injectReminderOffer).toBe(true);
    expect(decision.allowTipResolve).toBe(false);
  });

  it("real Raise beats reminder offer (Arbitration priority)", () => {
    const decision = decidePieArbitration({
      conversationId: CONV,
      inboundTurnCount: 1,
      inboundUserText: "היי",
      bubbles: [
        { text: "היי" },
        {
          text: "משימה ממתינה",
          buttons: [
            { label: "סגירה", command: "סגירה" },
            { label: "להוסיף תאריך", command: "להוסיף תאריך" },
          ],
        },
      ],
      reminderOfferEligible: true,
      tipCandidateAvailable: true,
    });
    expect(decision.chosenKind).toBe("open_item_raise");
    expect(decision.injectReminderOffer).toBe(false);
  });

  it("prefers act_followup reminder over tips (one initiative)", () => {
    const decision = decidePieArbitration({
      conversationId: CONV,
      inboundTurnCount: 1,
      inboundUserText: "תוסיפי משימה לרופא מחר ב־10",
      bubbles: [{ text: "הוספתי" }],
      reminderOfferEligible: true,
      tipCandidateAvailable: true,
    });
    expect(decision.chosenKind).toBe("act_followup");
    expect(decision.injectReminderOffer).toBe(true);
    expect(decision.allowTipResolve).toBe(false);
  });

  it("session Quiet blocks discovery tips but allows act_followup reminder", () => {
    decidePieArbitration({
      conversationId: CONV,
      inboundTurnCount: 1,
      inboundUserText: "תפסיקי להציע",
      bubbles: [{ text: "בסדר" }],
      reminderOfferEligible: false,
      tipCandidateAvailable: false,
    });
    const tipBlocked = decidePieArbitration({
      conversationId: CONV,
      inboundTurnCount: 2,
      inboundUserText: "היי",
      bubbles: [{ text: "היי" }],
      reminderOfferEligible: false,
      tipCandidateAvailable: true,
    });
    expect(tipBlocked.reason).toBe("session_quiet");
    expect(tipBlocked.allowTipResolve).toBe(false);

    const reminderOk = decidePieArbitration({
      conversationId: CONV,
      inboundTurnCount: 2,
      inboundUserText: "תוסיפי משימה לרופא מחר",
      bubbles: [{ text: "הוספתי" }],
      reminderOfferEligible: true,
      tipCandidateAvailable: true,
      reminderOpportunityKey: "act_followup:reminder_offer:task-1",
    });
    expect(reminderOk.chosenKind).toBe("act_followup");
    expect(reminderOk.injectReminderOffer).toBe(true);
    expect(reminderOk.reason).toBe("act_followup_reminder_offer_under_quiet");

    const consent = decidePieArbitration({
      conversationId: CONV,
      inboundTurnCount: 3,
      inboundUserText: "מחק הכל",
      bubbles: [{ text: "x" }],
      reminderOfferEligible: true,
      tipCandidateAvailable: true,
      consentOwnsTurn: true,
    });
    expect(consent.chosenKind).toBe("consent_cta");
  });

  it("suppressKeys blocks reminder re-offer; accepted key stays suppressed", () => {
    const key = "act_followup:reminder_offer:task-9";
    const suppressed = decidePieArbitration({
      conversationId: CONV,
      inboundTurnCount: 1,
      inboundUserText: "משימה",
      bubbles: [{ text: "הוספתי" }],
      reminderOfferEligible: true,
      tipCandidateAvailable: true,
      reminderOpportunityKey: key,
      suppressKeys: new Set([key]),
    });
    expect(suppressed.injectReminderOffer).toBe(false);
    expect(suppressed.allowTipResolve).toBe(true);
  });

  it("durable quiet preferenceMode blocks tips like session Quiet", () => {
    const decision = decidePieArbitration({
      conversationId: "other-conv",
      inboundTurnCount: 1,
      inboundUserText: "היי",
      bubbles: [{ text: "היי" }],
      reminderOfferEligible: false,
      tipCandidateAvailable: true,
      preferenceMode: "quiet",
    });
    expect(decision.reason).toBe("session_quiet");
    expect(decision.allowTipResolve).toBe(false);
  });

  it("proactive preferenceMode does not change cadence vs balanced", () => {
    notePieInitiativeEmitted(CONV, 1);
    const proactive = decidePieArbitration({
      conversationId: CONV,
      inboundTurnCount: 2,
      inboundUserText: "עוד",
      bubbles: [{ text: "ok" }],
      reminderOfferEligible: true,
      tipCandidateAvailable: true,
      preferenceMode: "proactive",
      reminderOpportunityKey: "act_followup:reminder_offer:t1",
    });
    expect(proactive.reason).toBe("cadence_1_per_3_inbound");
    expect(proactive.injectReminderOffer).toBe(false);
  });

  it("scoped «אל תציעי לי את זה» is not Quiet", () => {
    expect(isExplicitQuietUtterance("אל תציעי לי את זה")).toBe(false);
    expect(isExplicitQuietUtterance("תפסיקי להציע")).toBe(true);
  });

  it("enforces Balanced cadence: 1 initiative per 3 inbound", () => {
    expect(PIE_BALANCED_INBOUND_GAP).toBe(3);
    notePieInitiativeEmitted(CONV, 1);
    expect(pieCadenceAllowsInitiative(CONV, 1)).toBe(false);
    expect(pieCadenceAllowsInitiative(CONV, 2)).toBe(false);
    expect(pieCadenceAllowsInitiative(CONV, 3)).toBe(false);
    expect(pieCadenceAllowsInitiative(CONV, 4)).toBe(true);

    const blocked = decidePieArbitration({
      conversationId: CONV,
      inboundTurnCount: 2,
      inboundUserText: "עוד משהו",
      bubbles: [{ text: "ok" }],
      reminderOfferEligible: true,
      tipCandidateAvailable: true,
    });
    expect(blocked.reason).toBe("cadence_1_per_3_inbound");
    expect(blocked.injectReminderOffer).toBe(false);
  });

  it("soft offer already in bubbles blocks a second initiative", () => {
    const decision = decidePieArbitration({
      conversationId: CONV,
      inboundTurnCount: 1,
      inboundUserText: "משימה",
      bubbles: [
        {
          text: POST_SAVE_REMINDER_OFFER_TEXT,
          buttons: POST_SAVE_REMINDER_OFFER_BUTTONS,
        },
      ],
      reminderOfferEligible: true,
      tipCandidateAvailable: true,
    });
    expect(decision.chosenKind).toBe("act_followup");
    expect(decision.injectReminderOffer).toBe(false);
    expect(decision.allowTipResolve).toBe(false);
  });

  it("never enables prospect auto", () => {
    const decision = decidePieArbitration({
      conversationId: CONV,
      inboundTurnCount: 1,
      inboundUserText: "היי",
      bubbles: [{ text: "היי" }],
      reminderOfferEligible: false,
      tipCandidateAvailable: false,
    });
    expect(decision.allowProspectAuto).toBe(false);
    expect(decision.chosenKind).toBeNull();
  });
});
