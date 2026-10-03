import { describe, expect, it } from "vitest";
import { formatAttributedOutbound } from "../src/services/outbound-text.js";

describe("formatAttributedOutbound", () => {
  it("leaves a self-reminder without who asked", () => {
    expect(
      formatAttributedOutbound({
        actorName: "טל",
        destIsActor: true,
        item: "חלב",
        text: "",
      }),
    ).toBe("תזכורת: חלב");
  });

  it("uses one תזכורת line when item and text are the same", () => {
    expect(
      formatAttributedOutbound({
        actorName: "טל",
        destIsActor: true,
        item: "התאמן",
        text: "התאמן",
      }),
    ).toBe("תזכורת: להתאמן");
  });

  it("says who asked when reminding someone else", () => {
    expect(
      formatAttributedOutbound({
        actorName: "טל",
        destIsActor: false,
        item: "להביא חלב",
        text: "",
      }),
    ).toBe("טל ביקש לתזכר אותך\nתזכורת: להביא חלב");
  });

  it("keeps a dictated message to self or a digital worker as the message", () => {
    expect(
      formatAttributedOutbound({
        actorName: "עמית",
        destIsActor: true,
        text: "עמית שואל מה מחיר הטיסה ?",
      }),
    ).toBe("עמית שואל מה מחיר הטיסה ?");
  });

  it("says who sent a dictated message", () => {
    expect(
      formatAttributedOutbound({
        actorName: "טל",
        destIsActor: false,
        text: "היום אנחנו נפגשים",
      }),
    ).toBe("מאת טל: היום אנחנו נפגשים");
  });

  it("does not double the speaker name", () => {
    expect(
      formatAttributedOutbound({
        actorName: "טל",
        destIsActor: false,
        text: "טל שואל מה שלומך?",
      }),
    ).toBe("טל שואל מה שלומך?");
  });
});
