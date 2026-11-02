/**
 * Phase 0 fixtures — ACTION shapes + expected fingerprint / decision outcomes.
 * Offline only; no DB.
 */
import type { ClockFingerprintInput } from "./contract.js";
import { ymdHm } from "./contract.js";

const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REM_1 = "11111111-1111-4111-8111-111111111111";
const REM_2 = "22222222-2222-4222-8222-222222222222";

export const IDS = { ITEM_A, ITEM_B, REM_1, REM_2 } as const;

/** Base: one-shot 09:00 on ITEM_A. */
export function fixtureMorningVet(): ClockFingerprintInput {
  return {
    itemId: ITEM_A,
    resolvedFireAt: ymdHm(2026, 11, 10, 9, 0),
    hasExplicitTime: true,
    inSeconds: null,
    recurrence: null,
    ping: ["טל"],
    messageText: "תזכורת לווטרינר",
    compose: false,
    composeSource: "",
    composeMeta: "",
  };
}

/** Same as morning but 18:00 — must NOT merge. */
export function fixtureEveningVet(): ClockFingerprintInput {
  return {
    ...fixtureMorningVet(),
    resolvedFireAt: ymdHm(2026, 11, 10, 18, 0),
  };
}

/** Same day, no explicit time → time=none in F. */
export function fixtureAllDayVet(): ClockFingerprintInput {
  return {
    ...fixtureMorningVet(),
    resolvedFireAt: ymdHm(2026, 11, 10, 12, 0),
    hasExplicitTime: false,
  };
}

/** Same fire as morning, weekly Friday recurrence — must NOT merge with once. */
export function fixtureWeeklyMorning(): ClockFingerprintInput {
  return {
    ...fixtureMorningVet(),
    recurrence: {
      freq: "weekly",
      interval: 1,
      weekdays: [5],
      time: "09:00",
    },
  };
}

/** Same fire+rec as morning, different ping — must NOT merge. */
export function fixtureMorningDifferentPing(): ClockFingerprintInput {
  return {
    ...fixtureMorningVet(),
    ping: ["שני"],
  };
}

/** Same fire, different message text — must NOT merge. */
export function fixtureMorningDifferentText(): ClockFingerprintInput {
  return {
    ...fixtureMorningVet(),
    messageText: "להביא מסמכים",
  };
}

/** Compose weather watch — must NOT merge with plain clock. */
export function fixtureMorningComposeWeather(): ClockFingerprintInput {
  return {
    ...fixtureMorningVet(),
    compose: true,
    composeSource: "weather",
    composeMeta: '{"place":"תל אביב"}',
  };
}

/** Same logical clock as morning (whitespace in text) — F identical after normalize. */
export function fixtureMorningVetNormalizedText(): ClockFingerprintInput {
  return {
    ...fixtureMorningVet(),
    messageText: "  תזכורת   לווטרינר  ",
  };
}

/** Nested+legacy same-turn duplicate candidate (identical F). */
export function fixtureNestedAndTopLevelSame(): {
  nested: ClockFingerprintInput;
  topLevel: ClockFingerprintInput;
} {
  return {
    nested: fixtureMorningVet(),
    topLevel: fixtureMorningVet(),
  };
}

/** Retry: DB already has active clock+join for ITEM_A with morning F. */
export function fixtureRetryAlreadySaved(fingerprint: string) {
  return {
    itemId: ITEM_A,
    fingerprint,
    existing: [
      {
        reminderId: REM_1,
        itemId: ITEM_A,
        status: "active" as const,
        fingerprint,
      },
    ],
  };
}

/** Reuse without steal: REM_1 already joined to ITEM_B. */
export function fixtureRefuseStealJoin() {
  return {
    targetItemId: ITEM_A,
    reminderId: REM_1,
    joinOwnerItemId: ITEM_B,
  };
}

/** Orphan clock (no join) → may link to target. */
export function fixtureLinkOrphan() {
  return {
    targetItemId: ITEM_A,
    reminderId: REM_2,
    joinOwnerItemId: null as string | null,
  };
}

/** Nested update package failure points for rollback drill. */
export const NESTED_UPDATE_FAIL_STEPS = [
  "update_fields",
  "create_reminder",
  "insert_join",
] as const;

/**
 * Legacy top-level reminders + ESD item_id — EXISTING-row / dedup-hazard only.
 * NEW chore+clock must use FIXTURE_NESTED_ADD_ACTION (items[].remind); do not mint UUID.
 */
export const FIXTURE_LEGACY_ACTION = {
  response: "שמרתי",
  metadata: {
    lists: [
      {
        action: "add",
        list_type: "reminders",
        list_name: "",
        items: [
          {
            item: "תור לווטרינר",
            list_type: "tasks",
            date: "2026-11-10",
            time: "09:00",
            ping: ["טל"],
            item_id: ITEM_A,
          },
        ],
      },
      {
        action: "add",
        list_type: "tasks",
        list_name: "",
        targets: ["לוסי"],
        items: [{ "שם משימה": "להזכיר לטל: תור לווטרינר" }],
      },
    ],
  },
} as const;

/**
 * LINK-ONLY NEW task+clock: items[].remind — no worker row.
 * Proves user-task↔clock join does not require Worker in the ACTION.
 */
export const FIXTURE_NESTED_ADD_LINK_ONLY = {
  response: "שמרתי",
  metadata: {
    lists: [
      {
        action: "add",
        list_type: "tasks",
        list_name: "",
        items: [
          {
            "שם משימה": "תור לווטרינר",
            remind: {
              date: "2026-11-10",
              time: "09:00",
              ping: ["טל"],
              text: "תזכורת לווטרינר",
            },
          },
        ],
      },
    ],
  },
} as const;

/**
 * Preferred NEW self-nudge product shape: LINK (remind) + separate Worker להזכיר.
 * Worker is product tracking — not required for the join.
 */
export const FIXTURE_NESTED_ADD_ACTION = {
  response: "שמרתי",
  metadata: {
    lists: [
      {
        action: "add",
        list_type: "tasks",
        list_name: "",
        items: [
          {
            "שם משימה": "תור לווטרינר",
            remind: {
              date: "2026-11-10",
              time: "09:00",
              ping: ["טל"],
              text: "תזכורת לווטרינר",
            },
          },
        ],
      },
      {
        action: "add",
        list_type: "tasks",
        list_name: "",
        targets: ["לוסי"],
        items: [{ "שם משימה": "להזכיר לטל: תור לווטרינר" }],
      },
    ],
  },
} as const;

/** Nested remind on lists.update (existing item). */
export const FIXTURE_NESTED_UPDATE_ACTION = {
  response: "עדכנתי",
  metadata: {
    lists: [
      {
        action: "update",
        list_type: "tasks",
        list_name: "",
        items: [
          {
            item_id: ITEM_A,
            "שם משימה": "תור לווטרינר — מעודכן",
            remind: {
              date: "2026-11-10",
              time: "09:00",
              ping: ["טל"],
              text: "תזכורת לווטרינר",
            },
          },
        ],
      },
    ],
  },
} as const;

/** Dual path hazard: nested + top-level same clock. */
export const FIXTURE_DUAL_NESTED_AND_TOPLEVEL = {
  response: "שמרתי",
  metadata: {
    lists: [
      {
        action: "add",
        list_type: "tasks",
        list_name: "",
        items: [
          {
            "שם משימה": "תור לווטרינר",
            item_id: ITEM_A,
            remind: {
              date: "2026-11-10",
              time: "09:00",
              ping: ["טל"],
              text: "תזכורת לווטרינר",
            },
          },
        ],
      },
      {
        action: "add",
        list_type: "reminders",
        list_name: "",
        items: [
          {
            item: "תור לווטרינר",
            list_type: "tasks",
            date: "2026-11-10",
            time: "09:00",
            ping: ["טל"],
            item_id: ITEM_A,
            text: "תזכורת לווטרינר",
          },
        ],
      },
    ],
  },
} as const;
