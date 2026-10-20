import { describe, expect, it } from "vitest";
import { emptyLlmMetadata, type LlmMetadata } from "@workee/shared";
import { actionRepeatsSubHourly } from "../src/services/chat.service.js";

function meta(extra: Partial<LlmMetadata>): LlmMetadata {
  return { ...emptyLlmMetadata(), ...extra };
}

const reminder = {
  action: "add",
  item: "בוקר טוב",
  listType: "tasks",
  date: "",
  time: "",
  repeat: "once",
  ping: [],
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
  reminderId: "",
} as NonNullable<LlmMetadata["reminders"]>[number];

describe("actionRepeatsSubHourly", () => {
  it("flags a clock every N minutes, and the legacy every_unit form", () => {
    expect(
      actionRepeatsSubHourly(
        meta({
          reminders: [
            { ...reminder, recurrence: { freq: "interval", interval: 10, unit: "minutes" } },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      actionRepeatsSubHourly(
        meta({ reminders: [{ ...reminder, everyCount: 30, everyUnit: "seconds" }] }),
      ),
    ).toBe(true);
  });

  it("flags a standing task or a scheduled message every N minutes", () => {
    expect(
      actionRepeatsSubHourly(
        meta({
          lists: [
            {
              action: "add",
              listType: "tasks",
              listName: "",
              targets: [],
              items: [
                { "שם מטלה": "לשתות מים", recurrence: { freq: "interval", interval: 5, unit: "minutes" } },
              ],
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      actionRepeatsSubHourly(
        meta({
          messages: [
            {
              targets: ["טל"],
              text: "עשית?",
              recurrence: { freq: "interval", interval: 20, unit: "minutes" },
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("allows hourly repeats and one-time minute delays", () => {
    expect(
      actionRepeatsSubHourly(
        meta({
          reminders: [
            { ...reminder, recurrence: { freq: "interval", interval: 1, unit: "hours" } },
            { ...reminder, inSeconds: 600 },
          ],
        }),
      ),
    ).toBe(false);
  });
});
