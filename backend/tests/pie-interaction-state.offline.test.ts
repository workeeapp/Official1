import { describe, expect, it } from "vitest";
import {
  declinedSuppressMs,
  isExplicitScopedSuppressUtterance,
  isLiftScopedSuppressUtterance,
  reminderOfferOpportunityKey,
  tipOpportunityKey,
  PIE_DECLINED_ACT_FOLLOWUP_MS,
  PIE_DECLINED_CAPABILITY_MS,
} from "../src/services/pie-interaction-state.js";

describe("PIE-2 interaction state helpers", () => {
  it("builds stable opportunity keys", () => {
    expect(reminderOfferOpportunityKey("abc")).toBe(
      "act_followup:reminder_offer:abc",
    );
    expect(tipOpportunityKey("tasks_basic_add")).toBe(
      "capability_opportunity:tip:tasks_basic_add",
    );
  });

  it("maps decline TTL by kind", () => {
    expect(declinedSuppressMs("act_followup")).toBe(PIE_DECLINED_ACT_FOLLOWUP_MS);
    expect(declinedSuppressMs("capability_opportunity")).toBe(
      PIE_DECLINED_CAPABILITY_MS,
    );
    expect(declinedSuppressMs("open_item_raise")).toBe(
      PIE_DECLINED_ACT_FOLLOWUP_MS,
    );
  });

  it("detects scoped suppress without treating it as global Quiet wording alone", () => {
    expect(isExplicitScopedSuppressUtterance("אל תציעי לי את זה")).toBe(true);
    expect(isExplicitScopedSuppressUtterance("אל תציעי את ההצעה הזאת")).toBe(
      true,
    );
    expect(isExplicitScopedSuppressUtterance("תפסיקי להציע")).toBe(false);
    expect(isExplicitScopedSuppressUtterance("תוסיפי חלב")).toBe(false);
  });

  it("detects lift of scoped suppress", () => {
    expect(isLiftScopedSuppressUtterance("אפשר להציע שוב")).toBe(true);
    expect(isLiftScopedSuppressUtterance("תציעי שוב")).toBe(true);
    expect(isLiftScopedSuppressUtterance("אל תציעי לי את זה")).toBe(false);
  });
});
