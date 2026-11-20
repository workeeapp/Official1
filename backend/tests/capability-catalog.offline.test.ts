import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CATALOG,
  UNMAPPED_TIP_KEYS,
  UNVERIFIED_CAPABILITY_IDS,
  capabilityIdsForTipKey,
  getCapability,
} from "../src/services/capability-catalog.js";
import { SYSTEM_TIP_SEEDS } from "../src/services/tip-catalog.js";
import {
  evaluateCapabilityFamiliarity,
  evidenceFromListItemRows,
  evidenceFromReminderRows,
  matchEvidenceMatcher,
  reminderClockAttrs,
  shouldSuppressTipOffer,
  tasksItemIsMeeting,
  tasksItemIsStanding,
  tipOfferGateForKey,
  type CapabilityEvidenceEvent,
} from "../src/services/capability-evidence.js";

const now = new Date("2026-11-19T12:00:00.000Z");

function remEvent(
  overrides: Partial<CapabilityEvidenceEvent["attrs"]> & { at?: Date; id?: string },
): CapabilityEvidenceEvent {
  const { at, id, ...attrs } = overrides;
  return {
    kind: "reminder.clock",
    at: at ?? now,
    entityId: id ?? "r1",
    attrs: {
      recurring: false,
      watch: false,
      digest: false,
      active: true,
      ...attrs,
    },
  };
}

describe("capability catalog integrity", () => {
  it("has unique capability ids and matcher ids", () => {
    const ids = CAPABILITY_CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const cap of CAPABILITY_CATALOG) {
      expect(cap.enginePath.trim().length).toBeGreaterThan(5);
      expect(cap.evidenceMatchers.length).toBeGreaterThan(0);
      const matcherIds = cap.evidenceMatchers.map((m) => m.id);
      expect(new Set(matcherIds).size).toBe(matcherIds.length);
    }
  });

  it("maps tip keys only to seeded catalog keys", () => {
    const seedKeys = new Set(SYSTEM_TIP_SEEDS.map((s) => s.key));
    for (const cap of CAPABILITY_CATALOG) {
      for (const key of cap.tipKeys) {
        expect(seedKeys.has(key), `unknown tip key ${key} on ${cap.id}`).toBe(
          true,
        );
      }
    }
  });

  it("does not put unverified live domains in the catalog", () => {
    const ids = new Set(CAPABILITY_CATALOG.map((c) => c.id));
    for (const id of UNVERIFIED_CAPABILITY_IDS) {
      expect(ids.has(id)).toBe(false);
    }
  });

  it("leaves unmapped tip keys without capability binding", () => {
    for (const key of UNMAPPED_TIP_KEYS) {
      expect(capabilityIdsForTipKey(key)).toEqual([]);
    }
  });
});

describe("reminderClockAttrs near-misses", () => {
  it("one-shot is not recurring or watch", () => {
    expect(
      reminderClockAttrs({
        recurrence: null,
        repeat: "once",
        composeCondition: null,
        composeAtFire: false,
        composeSource: "",
        status: "active",
      }),
    ).toEqual({
      recurring: false,
      watch: false,
      digest: false,
      active: true,
    });
  });

  it("recurring calendar rule is not one-shot", () => {
    const attrs = reminderClockAttrs({
      recurrence: { freq: "weekly", weekdays: [2] },
      repeat: "once",
      composeCondition: null,
      status: "active",
    });
    expect(attrs.recurring).toBe(true);
    expect(attrs.watch).toBe(false);
  });

  it("watch composeCondition is not one-shot and not recurring evidence", () => {
    const attrs = reminderClockAttrs({
      recurrence: { freq: "interval", unit: "minutes", interval: 15 },
      repeat: "once",
      composeCondition: { type: "market_price" },
      status: "active",
    });
    expect(attrs.watch).toBe(true);
    expect(attrs.recurring).toBe(false);
  });

  it("digest composeAtFire is not one-shot", () => {
    const attrs = reminderClockAttrs({
      recurrence: null,
      repeat: "once",
      composeCondition: null,
      composeAtFire: true,
      composeSource: "weather",
      status: "active",
    });
    expect(attrs.digest).toBe(true);
    expect(attrs.recurring).toBe(false);
  });
});

describe("reminder_one_shot vs reminder_recurring vs reminder_watch matchers", () => {
  const oneShot = getCapability("reminder_one_shot")!;
  const recurring = getCapability("reminder_recurring")!;
  const watch = getCapability("reminder_watch")!;

  it("one-shot matches one_shot only", () => {
    const event = remEvent({ recurring: false, watch: false, digest: false });
    expect(
      oneShot.evidenceMatchers.some((m) => matchEvidenceMatcher(m, event)),
    ).toBe(true);
    expect(
      recurring.evidenceMatchers.some((m) => matchEvidenceMatcher(m, event)),
    ).toBe(false);
    expect(
      watch.evidenceMatchers.some((m) => matchEvidenceMatcher(m, event)),
    ).toBe(false);
  });

  it("recurring clock matches recurring only (not one-shot)", () => {
    const event = remEvent({ recurring: true, watch: false, digest: false });
    expect(
      oneShot.evidenceMatchers.some((m) => matchEvidenceMatcher(m, event)),
    ).toBe(false);
    expect(
      recurring.evidenceMatchers.some((m) => matchEvidenceMatcher(m, event)),
    ).toBe(true);
  });

  it("watch matches watch only (not one-shot / not recurring)", () => {
    const event = remEvent({ recurring: false, watch: true, digest: false });
    expect(
      oneShot.evidenceMatchers.some((m) => matchEvidenceMatcher(m, event)),
    ).toBe(false);
    expect(
      recurring.evidenceMatchers.some((m) => matchEvidenceMatcher(m, event)),
    ).toBe(false);
    expect(
      watch.evidenceMatchers.some((m) => matchEvidenceMatcher(m, event)),
    ).toBe(true);
  });

  it("evidenceFromReminderRows preserves the distinction", () => {
    const events = evidenceFromReminderRows([
      {
        id: "a",
        createdAt: now,
        recurrence: null,
        repeat: "once",
        composeCondition: null,
        status: "done",
      },
      {
        id: "b",
        createdAt: now,
        recurrence: { freq: "daily" },
        repeat: "once",
        composeCondition: null,
        status: "active",
      },
      {
        id: "c",
        createdAt: now,
        recurrence: null,
        repeat: "once",
        composeCondition: { type: "weather_rain" },
        status: "active",
      },
    ]);
    const famOnce = evaluateCapabilityFamiliarity(
      oneShot,
      events,
      new Set(),
      now,
    );
    const famRec = evaluateCapabilityFamiliarity(
      recurring,
      events,
      new Set(),
      now,
    );
    const famWatch = evaluateCapabilityFamiliarity(
      watch,
      events,
      new Set(),
      now,
    );
    expect(famOnce.tried).toBe(true);
    expect(famOnce.matchCount).toBe(1);
    expect(famRec.tried).toBe(true);
    expect(famRec.using).toBe(true); // active recurring
    expect(famWatch.tried).toBe(true);
    expect(famWatch.using).toBe(true); // active watch
  });
});

describe("list / standing / meeting near-misses", () => {
  it("shopping item does not prove tasks_list", () => {
    const events = evidenceFromListItemRows([
      {
        id: "i1",
        createdAt: now,
        listType: "shopping",
        data: { שם: "חלב" },
      },
    ]);
    const shopping = evaluateCapabilityFamiliarity(
      getCapability("shopping_list")!,
      events,
      new Set(),
      now,
    );
    const tasks = evaluateCapabilityFamiliarity(
      getCapability("tasks_list")!,
      events,
      new Set(),
      now,
    );
    expect(shopping.tried).toBe(true);
    expect(tasks.tried).toBe(false);
  });

  it("standing task proves standing_tasks not plain tasks_list", () => {
    expect(tasksItemIsStanding({ __recurrence: { freq: "weekly" } })).toBe(
      true,
    );
    const events = evidenceFromListItemRows([
      {
        id: "i2",
        createdAt: now,
        listType: "tasks",
        data: { __recurrence: { freq: "weekly" }, "שם משימה": "סירופ" },
      },
    ]);
    expect(
      evaluateCapabilityFamiliarity(
        getCapability("standing_tasks")!,
        events,
        new Set(),
        now,
      ).tried,
    ).toBe(true);
    expect(
      evaluateCapabilityFamiliarity(
        getCapability("tasks_list")!,
        events,
        new Set(),
        now,
      ).tried,
    ).toBe(false);
  });

  it("timed meeting proves meetings_calendar not plain tasks_list", () => {
    expect(
      tasksItemIsMeeting({
        "תאריך לביצוע": "2026-11-20",
        "שעה לביצוע": "10:00",
        "שעת סיום": "11:00",
      }),
    ).toBe(true);
    const events = evidenceFromListItemRows([
      {
        id: "i3",
        createdAt: now,
        listType: "tasks",
        data: {
          "שם משימה": "פגישה",
          "תאריך לביצוע": "2026-11-20",
          "שעה לביצוע": "10:00",
          "שעת סיום": "11:00",
        },
      },
    ]);
    expect(
      evaluateCapabilityFamiliarity(
        getCapability("meetings_calendar")!,
        events,
        new Set(),
        now,
      ).tried,
    ).toBe(true);
    expect(
      evaluateCapabilityFamiliarity(
        getCapability("tasks_list")!,
        events,
        new Set(),
        now,
      ).tried,
    ).toBe(false);
  });
});

describe("shown vs tried vs using", () => {
  it("TipProgress shown alone does not set tried/using", () => {
    const fam = evaluateCapabilityFamiliarity(
      getCapability("reminder_one_shot")!,
      [],
      new Set(["prospect_onboard_reminders", "reminders_basic_store"]),
      now,
    );
    expect(fam.shown).toBe(true);
    expect(fam.tried).toBe(false);
    expect(fam.using).toBe(false);
  });

  it("single evidence → tried, not using", () => {
    const fam = evaluateCapabilityFamiliarity(
      getCapability("reminder_one_shot")!,
      [remEvent({ id: "only" })],
      new Set(),
      now,
    );
    expect(fam.tried).toBe(true);
    expect(fam.using).toBe(false);
  });

  it("two evidence events in window → using", () => {
    const fam = evaluateCapabilityFamiliarity(
      getCapability("reminder_one_shot")!,
      [
        remEvent({ id: "a", at: new Date("2026-11-01T00:00:00.000Z") }),
        remEvent({ id: "b", at: new Date("2026-11-10T00:00:00.000Z") }),
      ],
      new Set(),
      now,
    );
    expect(fam.tried).toBe(true);
    expect(fam.using).toBe(true);
    expect(fam.matchesInWindow).toBe(2);
  });
});

describe("soft-try / action tip suppression gates", () => {
  it("suppresses prospect soft-try when reminder_one_shot tried", () => {
    const familiarity = new Map([
      [
        "reminder_one_shot",
        {
          capabilityId: "reminder_one_shot",
          shown: false,
          tried: true,
          using: false,
          matchCount: 1,
          matchesInWindow: 1,
        },
      ],
    ]);
    expect(
      shouldSuppressTipOffer({
        tipKey: "prospect_onboard_reminders",
        triggerKind: "general",
        familiarityById: familiarity,
      }),
    ).toBe(true);
    // Action tip still allowed when only tried (not using)
    expect(
      shouldSuppressTipOffer({
        tipKey: "reminders_basic_store",
        triggerKind: "action",
        familiarityById: familiarity,
      }),
    ).toBe(false);
  });

  it("suppresses action tip when using", () => {
    const familiarity = new Map([
      [
        "shopping_list",
        {
          capabilityId: "shopping_list",
          shown: true,
          tried: true,
          using: true,
          matchCount: 3,
          matchesInWindow: 3,
        },
      ],
    ]);
    expect(
      tipOfferGateForKey("shopping_basic_add", "action", familiarity)
        .suppressActionTip,
    ).toBe(true);
    expect(
      tipOfferGateForKey("prospect_onboard_shopping", "general", familiarity)
        .suppressSoftTry,
    ).toBe(true);
  });

  it("does not suppress unmapped general tips via empty binding", () => {
    const familiarity = new Map([
      [
        "reminder_one_shot",
        {
          capabilityId: "reminder_one_shot",
          shown: false,
          tried: true,
          using: true,
          matchCount: 5,
          matchesInWindow: 5,
        },
      ],
    ]);
    expect(
      shouldSuppressTipOffer({
        tipKey: "general_weather",
        triggerKind: "general",
        familiarityById: familiarity,
      }),
    ).toBe(false);
  });

  it("one-shot tried does not suppress reminders_adv_repeat (recurring soft/action)", () => {
    const familiarity = new Map([
      [
        "reminder_one_shot",
        {
          capabilityId: "reminder_one_shot",
          shown: false,
          tried: true,
          using: false,
          matchCount: 1,
          matchesInWindow: 1,
        },
      ],
      [
        "reminder_recurring",
        {
          capabilityId: "reminder_recurring",
          shown: false,
          tried: false,
          using: false,
          matchCount: 0,
          matchesInWindow: 0,
        },
      ],
    ]);
    expect(
      shouldSuppressTipOffer({
        tipKey: "reminders_adv_repeat",
        triggerKind: "action",
        familiarityById: familiarity,
      }),
    ).toBe(false);
  });
});
