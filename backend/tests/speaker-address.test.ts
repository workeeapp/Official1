import { describe, expect, it } from "vitest";
import {
  addressGenderFromFilingAction,
  formatSpeakerAddressContext,
} from "../src/services/speaker-address.js";

describe("addressGenderFromFilingAction", () => {
  it("reads male/female from לשון פנייה filing ACTION fields", () => {
    expect(
      addressGenderFromFilingAction({
        itemName: "לשון פנייה",
        itemInfo: "זכר — לפנות בלשון זכר",
        itemDescription: "לשון פנייה",
      }),
    ).toBe("male");
    expect(
      addressGenderFromFilingAction({
        itemName: "לשון פנייה",
        itemInfo: "נקבה — לפנות בלשון נקבה",
        itemDescription: "לשון פנייה",
      }),
    ).toBe("female");
  });

  it("ignores unrelated filings", () => {
    expect(
      addressGenderFromFilingAction({
        itemName: "משפחה",
        itemInfo: "יש לי שני ילדים",
        itemDescription: "משפחה",
      }),
    ).toBeNull();
  });
});

describe("formatSpeakerAddressContext", () => {
  it("emits male, female, and unknown blocks", () => {
    expect(formatSpeakerAddressContext("male")).toContain("gender: male");
    expect(formatSpeakerAddressContext("male")).toContain("אתה");
    expect(formatSpeakerAddressContext("female")).toContain("gender: female");
    expect(formatSpeakerAddressContext("female")).toContain("את,");
    expect(formatSpeakerAddressContext(null)).toContain("gender: unknown");
    expect(formatSpeakerAddressContext(null)).toContain("ask once how they would like to be addressed (male or female)");
  });

  it("unknown gender must not block a complete same-turn durable address filing", () => {
    const unknown = formatSpeakerAddressContext(null);
    expect(unknown).toMatch(/FORBIDDEN/i);
    expect(unknown).toContain("תייקי שהכתובת שלי היא רחוב הרצל 1 תל אביב");
    expect(unknown).toMatch(/never block|FORBIDDEN[\s\S]*empty actions/i);
    // Still keeps the gender ask for turns that need conjugation only.
    expect(unknown).toContain("ask once how they would like to be addressed (male or female)");
  });

  // Regression (eval-db reminder-link-existing-task, 2026-11-04): once the
  // corrupted Hebrew was restored, an unknown-gender speaker asking «תזכירי לי
  // מחר ב־09:00 על התור לווטרינר» got «לפנות אליך בלשון זכר או נקבה?» and NO
  // action. The gender ask may only FOLLOW a done action — never replace it.
  it("unknown gender never blocks ANY complete action (reminders too); ask comes last", () => {
    const unknown = formatSpeakerAddressContext(null);
    expect(unknown).toMatch(/FIRST/);
    expect(unknown).toMatch(/LAST responses entry/);
    expect(unknown).toContain("reminders");
    expect(unknown).toContain("תזכירי לי מחר ב־09:00 על התור לווטרינר");
    expect(unknown).toMatch(/FORBIDDEN asking about the request itself/);
  });
});
