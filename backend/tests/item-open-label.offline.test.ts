/**
 * Item-open button label consistency (2026-11-05): the prompt said «title when
 * ≤12» while WhatsApp fitted at 20, so 13–20 char titles showed sometimes as
 * the title and sometimes as «להצגת המשימה». One rule now, enforced in
 * rendering: exact title when it fits (≤20), else the fixed label.
 */
import { describe, expect, it } from "vitest";
import {
  fitReplyButtonLabel,
  itemOpenButtonLabel,
} from "../src/services/whatsapp-send.js";

describe("itemOpenButtonLabel", () => {
  it("short task title → the title, whatever label the model chose", () => {
    const button = { label: "להצגת המשימה", command: "הציגי את המשימה תור לרופא" };
    expect(itemOpenButtonLabel(button)).toBe("תור לרופא");
    expect(fitReplyButtonLabel(button)).toBe("תור לרופא");
  });

  it("13–20 chars → still the title (was model-dependent)", () => {
    const title = "תור לרופא שיניים בבוקר"; // 22 → too long
    const mid = "תור לרופא שיניים ב"; // 18
    expect(itemOpenButtonLabel({ label: "x", command: `הציגי את המשימה ${mid}` })).toBe(mid);
    expect(itemOpenButtonLabel({ label: mid, command: `הציגי את המשימה ${title}` })).toBe(
      "להצגת המשימה",
    );
  });

  it("filing item-open uses «להצגת התיוק» when long", () => {
    expect(
      itemOpenButtonLabel({
        label: "x",
        command: "הציגי את התיוק קוד הכניסה לבניין של סבתא",
      }),
    ).toBe("להצגת התיוק");
    expect(itemOpenButtonLabel({ label: "x", command: "הציגי את התיוק קוד שער" })).toBe("קוד שער");
  });

  it("other buttons are untouched (null)", () => {
    expect(itemOpenButtonLabel({ label: "הצג משימות", command: "הצג רשימת משימות" })).toBeNull();
    expect(fitReplyButtonLabel({ label: "הצג משימות", command: "הצג רשימת משימות" })).toBe(
      "הצג משימות",
    );
  });
});
