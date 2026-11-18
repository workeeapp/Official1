import { describe, expect, it } from "vitest";
import {
  humanFacingChoreFromTitle,
  isWorkerTrackingTitle,
  sanitizeReminderPingFields,
} from "../src/services/worker-tracking-title.js";

describe("humanFacingChoreFromTitle", () => {
  it("strips להזכיר ל<name> to the chore", () => {
    expect(humanFacingChoreFromTitle("להזכיר לטל לשתות חלב")).toBe("לשתות חלב");
    expect(humanFacingChoreFromTitle("להזכיר לטל תור לשיננית")).toBe(
      "תור לשיננית",
    );
    expect(humanFacingChoreFromTitle("תזכורת: להזכיר לטל לקנות חלב")).toBe(
      "לקנות חלב",
    );
  });

  it("passes ordinary chores through", () => {
    expect(humanFacingChoreFromTitle("לשתות חלב")).toBe("לשתות חלב");
    expect(isWorkerTrackingTitle("לשתות חלב")).toBe(false);
  });

  it("sanitizes reminder ping fields for fire/save", () => {
    expect(
      sanitizeReminderPingFields({
        item: "להזכיר לטל לשתות חלב",
        text: "להזכיר לטל לשתות חלב",
      }),
    ).toEqual({ item: "לשתות חלב", text: "לשתות חלב" });
  });
});
