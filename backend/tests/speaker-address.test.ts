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
    expect(formatSpeakerAddressContext(null)).toContain("לפנות אליך בלשון זכר או נקבה");
  });
});
