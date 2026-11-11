/**
 * Bare STOP SERIES after a ping must bind to RECENT_OUTBOUND.reminder_id —
 * never a different active clock (e.g. SOLT market watch).
 */
import { describe, expect, it } from "vitest";
import { emptyLlmMetadata, type LlmReminderAction } from "@workee/shared";
import {
  applyStopSeriesAfterPingSafetyNet,
  formatStopSeriesAfterPingAck,
  isBareStopSeriesAfterPingMessage,
} from "../src/services/stop-series-after-ping.js";

function removeAction(
  reminderId: string,
  item: string,
): LlmReminderAction {
  return {
    action: "remove",
    item,
    listType: "tasks",
    date: "",
    time: "",
    repeat: "once",
    ping: [],
    about: [],
    targets: [],
    text: "",
    inSeconds: null,
    everyCount: null,
    everyUnit: null,
    weekdays: null,
    confirmed: false,
    compose: false,
    composeSource: "",
    composeLookbackHours: 0,
    composePlace: "",
    reminderId,
  };
}

describe("stop-series-after-ping engine safety-net", () => {
  const milkId = "milk-series-id";
  const soltId = "solt-watch-id";
  const recentOutbound = [
    { reminder_id: milkId, item: "לשתות חלב" },
  ];

  it("detects bare stop cues including הפסיקי", () => {
    expect(isBareStopSeriesAfterPingMessage("הפסיקי")).toBe(true);
    expect(isBareStopSeriesAfterPingMessage("תפסיקי")).toBe(true);
    expect(isBareStopSeriesAfterPingMessage("אל תזכירי לי יותר")).toBe(true);
    expect(isBareStopSeriesAfterPingMessage("בטלי")).toBe(true);
    expect(isBareStopSeriesAfterPingMessage("הפסיקי בבקשה")).toBe(true);
    expect(isBareStopSeriesAfterPingMessage("הפסיקי את ההתראה על SOLT")).toBe(
      false,
    );
    expect(isBareStopSeriesAfterPingMessage("תפסיקי להזכיר לי לשתות חלב")).toBe(
      false,
    );
  });

  it("rewrites mistaken SOLT watch remove to the just-pinged milk series", () => {
    const metadata = {
      ...emptyLlmMetadata(),
      reminders: [removeAction(soltId, "SOLT ל־20")],
    };
    const next = applyStopSeriesAfterPingSafetyNet({
      message: "הפסיקי",
      recentOutbound,
      metadata,
    });
    expect(next.rewrote).toBe(true);
    expect(next.targetReminderId).toBe(milkId);
    expect(next.targetItem).toBe("לשתות חלב");
    expect(next.metadata.reminders).toHaveLength(1);
    expect(next.metadata.reminders[0]?.action).toBe("remove");
    expect(next.metadata.reminders[0]?.reminderId).toBe(milkId);
    expect(next.metadata.reminders[0]?.reminderId).not.toBe(soltId);
  });

  it("injects remove when model claimed stop with empty reminders", () => {
    const next = applyStopSeriesAfterPingSafetyNet({
      message: "הפסיקי",
      recentOutbound,
      metadata: emptyLlmMetadata(),
    });
    expect(next.rewrote).toBe(true);
    expect(next.metadata.reminders?.[0]?.reminderId).toBe(milkId);
  });

  it("is a no-op when model already removed the outbound id only", () => {
    const metadata = {
      ...emptyLlmMetadata(),
      reminders: [removeAction(milkId, "לשתות חלב")],
    };
    const next = applyStopSeriesAfterPingSafetyNet({
      message: "הפסיקי",
      recentOutbound,
      metadata,
    });
    expect(next.rewrote).toBe(false);
    expect(next.metadata.reminders).toEqual(metadata.reminders);
  });

  it("does not rewrite when there is no RECENT_OUTBOUND bind", () => {
    const metadata = {
      ...emptyLlmMetadata(),
      reminders: [removeAction(soltId, "SOLT")],
    };
    const next = applyStopSeriesAfterPingSafetyNet({
      message: "הפסיקי",
      recentOutbound: [],
      metadata,
    });
    expect(next.rewrote).toBe(false);
    expect(next.metadata.reminders?.[0]?.reminderId).toBe(soltId);
  });

  it("does not rewrite named stop of a different chore", () => {
    const metadata = {
      ...emptyLlmMetadata(),
      reminders: [removeAction(soltId, "SOLT")],
    };
    const next = applyStopSeriesAfterPingSafetyNet({
      message: "הפסיקי את ההתראה על SOLT",
      recentOutbound,
      metadata,
    });
    expect(next.rewrote).toBe(false);
    expect(next.metadata.reminders?.[0]?.reminderId).toBe(soltId);
  });

  it("ack names the outbound chore, not an unrelated watch", () => {
    expect(formatStopSeriesAfterPingAck("לשתות חלב")).toContain("לשתות חלב");
    expect(formatStopSeriesAfterPingAck("לשתות חלב")).not.toContain("SOLT");
  });
});
