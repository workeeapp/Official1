/**
 * Offline end-to-end verification for the two Lucy incidents.
 * Uses production apply / reply-truth / gate / fire paths with mocks —
 * no Prisma product DB writes and no WhatsApp sends.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyLlmMetadata, type LlmMetadata, type LlmReminderAction, type PublicEmployee } from "@workee/shared";
import { correctModelApplyTurnResponse } from "../src/eval/run-model-apply.js";
import {
  LIST_ADD_MISS,
  REMINDER_ONLY_PARTIAL,
} from "../src/services/employee-records.service.js";
import {
  baselineShaForWatch,
  evaluateComposeCondition,
  normalizeMarketPriceForLiveQuote,
} from "../src/services/compose-condition.js";
import { resolveWatchOnceForMarketCondition } from "../src/services/reminder.service.js";

const { reminderFindMany, reminderCreate, reminderUpdate, fetchQuote, seedWatchBaseline } =
  vi.hoisted(() => ({
    reminderFindMany: vi.fn(),
    reminderCreate: vi.fn(),
    reminderUpdate: vi.fn(),
    fetchQuote: vi.fn(),
    seedWatchBaseline: vi.fn(),
  }));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    reminder: {
      findMany: reminderFindMany,
      create: reminderCreate,
      update: reminderUpdate,
    },
  },
}));
vi.mock("../src/services/audit.service.js", () => ({
  recordAuditEvent: vi.fn(),
}));
vi.mock("../src/services/reminder-fire.js", () => ({
  scheduleSoon: vi.fn(),
}));
vi.mock("../src/services/market.js", () => ({
  fetchQuote,
}));
vi.mock("../src/services/watch-baseline.js", () => ({
  seedWatchBaseline,
}));

import { applyReminders } from "../src/services/reminder.service.js";

const speaker: PublicEmployee = {
  id: "tal-1",
  name: "טל",
  surname: "",
  nickname: "טל",
  email: null,
  phone: "972501111111",
  kind: "human",
  protected: false,
} as PublicEmployee;

function meta(partial: Partial<LlmMetadata> = {}): LlmMetadata {
  return { ...emptyLlmMetadata(), ...partial };
}

function marketAddAction(
  overrides: Partial<LlmReminderAction> = {},
): LlmReminderAction {
  return {
    action: "add",
    item: "התראת מחיר",
    listType: "tasks",
    date: "",
    time: "",
    repeat: "once",
    ping: ["טל"],
    about: [],
    targets: [],
    text: "תתריעי כשהמחיר מגיע ליעד",
    inSeconds: null,
    everyCount: 5,
    everyUnit: "minutes",
    weekdays: null,
    confirmed: true,
    compose: true,
    composeSource: "market",
    composeLookbackHours: 0,
    composePlace: "SOLT",
    composeCondition: { type: "market_price", op: "eq", value: 20 },
    watchOnce: false,
    recurrence: { freq: "interval", interval: 5, unit: "minutes" },
    reminderId: "",
    ...overrides,
  } as LlmReminderAction;
}

describe("Incident 1 e2e — execution truth (model-apply pipeline)", () => {
  it("reminder applied, lists.add omitted, הוספתי claim → no task success", () => {
    const out = correctModelApplyTurnResponse({
      response:
        "הוספתי למטלות להביא 2 בקבוקי מיץ לבית הספר עבור יואב, ואזכיר לך ביום שני ב־8 תזכורת.",
      metadata: meta({
        // No lists.add — model claimed success without ACTION.
        lists: [],
        reminders: [
          {
            action: "add",
            item: "להביא 2 בקבוקי מיץ",
            listType: "tasks",
            date: "2026-11-03",
            time: "08:00",
            repeat: "once",
            ping: ["טל"],
            about: [],
            targets: [],
            text: "",
            inSeconds: null,
            everyCount: null,
            everyUnit: null,
            weekdays: null,
            confirmed: true,
            compose: false,
            composeSource: "",
            composeLookbackHours: 0,
            composePlace: "",
            reminderId: "",
          } as LlmReminderAction,
        ],
      }),
      mutations: [],
      appliedReminderAdd: true,
      reminderAddFallback: "שמרתי תזכורת «להביא 2 בקבוקי מיץ».",
    });
    expect(out).not.toMatch(/הוספתי/);
    expect(out).toMatch(/תזכורת/);
    expect(out === REMINDER_ONLY_PARTIAL || out.includes("תזכורת")).toBe(true);
  });

  it("neither task nor reminder applied + הוספתי → add miss", () => {
    const out = correctModelApplyTurnResponse({
      response: "הוספתי למטלות לקנות חלב.",
      metadata: meta(),
      mutations: [],
      appliedReminderAdd: false,
    });
    expect(out).toBe(LIST_ADD_MISS);
  });

  it("both list add and reminder applied → keeps dual claim", () => {
    const reply =
      "הוספתי למטלות לקנות חלב ואזכיר לך מחר ב־9 תזכורת.";
    const out = correctModelApplyTurnResponse({
      response: reply,
      metadata: meta({
        lists: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [{ שם: "לקנות חלב" }],
            targets: [],
          },
        ],
      }),
      mutations: [
        {
          action: "add",
          itemId: "t1",
          employeeId: speaker.id,
          listType: "tasks",
          itemKey: "לקנות חלב",
          itemLabel: "לקנות חלב",
          listName: "מטלות",
        },
      ],
      appliedReminderAdd: true,
    });
    expect(out).toBe(reply);
  });
});

describe("Incident 2 e2e — apply persist (target arrival)", () => {
  beforeEach(() => {
    reminderFindMany.mockReset().mockResolvedValue([]);
    reminderCreate.mockReset().mockImplementation(async ({ data }) => ({
      id: "new-clock-1",
      workerItemId: null,
      ...data,
    }));
    reminderUpdate.mockReset().mockResolvedValue({});
    seedWatchBaseline.mockReset().mockResolvedValue({
      sha: "market:above",
      alreadyHolding: false,
    });
    fetchQuote.mockReset().mockResolvedValue({
      symbol: "SOLT",
      name: "SOLT",
      price: 46.7,
      changePct: -10,
      changeAbs: -5,
      dayHigh: 50,
      dayLow: 45,
      currency: "USD",
      query: "SOLT",
    });
  });

  it("eq + live above target → persists lte + watchOnce true (forces over model false)", async () => {
    const result = await applyReminders({
      userId: "u1",
      actor: speaker,
      employees: [speaker],
      reminders: [marketAddAction()],
    });
    expect(result.saved).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    expect(reminderCreate).toHaveBeenCalled();
    const data = reminderCreate.mock.calls[0][0].data;
    expect(data.composeCondition).toEqual({
      type: "market_price",
      op: "lte",
      value: 20,
    });
    expect(data.watchOnce).toBe(true);
    expect(seedWatchBaseline).toHaveBeenCalled();
    const seedArg = seedWatchBaseline.mock.calls[0][0];
    expect(seedArg.alertWhileHolding).toBe(false);
    expect(seedArg.composeCondition).toEqual({
      type: "market_price",
      op: "lte",
      value: 20,
    });
  });

  it("upward target: live 10, eq 20 → persists gte + watchOnce true", async () => {
    fetchQuote.mockResolvedValue({
      symbol: "AAPL",
      name: "Apple",
      price: 10,
      changePct: 0,
      changeAbs: 0,
      dayHigh: 11,
      dayLow: 9,
      currency: "USD",
      query: "AAPL",
    });
    await applyReminders({
      userId: "u1",
      actor: speaker,
      employees: [speaker],
      reminders: [
        marketAddAction({
          composePlace: "AAPL",
          composeCondition: { type: "market_price", op: "eq", value: 20 },
        }),
      ],
    });
    const data = reminderCreate.mock.calls[0][0].data;
    expect(data.composeCondition).toEqual({
      type: "market_price",
      op: "gte",
      value: 20,
    });
    expect(data.watchOnce).toBe(true);
  });

  it("explicit level gte + watchOnce false → preserves op and level", async () => {
    await applyReminders({
      userId: "u1",
      actor: speaker,
      employees: [speaker],
      reminders: [
        marketAddAction({
          composeCondition: { type: "market_price", op: "gte", value: 20 },
          watchOnce: false,
          recurrence: { freq: "daily", interval: 1, time: "21:00" },
          everyCount: null,
          everyUnit: null,
        }),
      ],
    });
    const data = reminderCreate.mock.calls[0][0].data;
    expect(data.composeCondition).toEqual({
      type: "market_price",
      op: "gte",
      value: 20,
    });
    expect(data.watchOnce).toBe(false);
  });
});

describe("Incident 2 e2e — gate quiet / cross once / no duplicates", () => {
  it("downward lte: quiet while above, one edge send on cross, then quiet while holding", () => {
    const condition = { type: "market_price" as const, op: "lte" as const, value: 20 };
    const baseline = baselineShaForWatch({
      condition,
      facts: { marketPrice: 46.7 },
    });
    expect(baseline).toBe("market:above");

    expect(
      evaluateComposeCondition({
        condition,
        facts: { marketPrice: 46.7 },
        lastReportSha: baseline,
        alertWhileHolding: false,
      }).skipSend,
    ).toBe(true);

    const cross = evaluateComposeCondition({
      condition,
      facts: { marketPrice: 19.5 },
      lastReportSha: baseline,
      alertWhileHolding: false,
    });
    expect(cross.skipSend).toBe(false);
    expect(cross.immediateSha).toBe("market:below");

    // After send, edge stamps holding — further polls while still ≤20 stay quiet.
    expect(
      evaluateComposeCondition({
        condition,
        facts: { marketPrice: 18 },
        lastReportSha: "market:below",
        alertWhileHolding: false,
      }).skipSend,
    ).toBe(true);
  });

  it("upward gte: quiet while below, one edge send on cross", () => {
    const condition = { type: "market_price" as const, op: "gte" as const, value: 20 };
    const baseline = baselineShaForWatch({
      condition,
      facts: { marketPrice: 10 },
    });
    expect(baseline).toBe("market:above");
    expect(
      evaluateComposeCondition({
        condition,
        facts: { marketPrice: 10 },
        lastReportSha: baseline,
        alertWhileHolding: false,
      }).skipSend,
    ).toBe(true);
    expect(
      evaluateComposeCondition({
        condition,
        facts: { marketPrice: 21 },
        lastReportSha: baseline,
        alertWhileHolding: false,
      }).skipSend,
    ).toBe(false);
  });

  it("explicit level gte: re-alerts while holding when alertWhileHolding", () => {
    const condition = { type: "market_price" as const, op: "gte" as const, value: 20 };
    expect(
      evaluateComposeCondition({
        condition,
        facts: { marketPrice: 46.7 },
        lastReportSha: "market:below",
        alertWhileHolding: true,
      }).skipSend,
    ).toBe(false);
  });

  it("target-arrival pipeline: eq→lte + forced watch_once + no create-time send", () => {
    const proposed = false; // model wrongly asked level
    const watchOnce = resolveWatchOnceForMarketCondition({
      condition: { type: "market_price", op: "eq" },
      proposedWatchOnce: proposed,
    });
    expect(watchOnce).toBe(true);
    const normalized = normalizeMarketPriceForLiveQuote({
      condition: { type: "market_price", op: "eq", value: 20 },
      livePrice: 46.7,
      alertWhileHolding: watchOnce === false,
    });
    expect(normalized.condition.op).toBe("lte");
    const sha = baselineShaForWatch({
      condition: normalized.condition,
      facts: { marketPrice: 46.7 },
    });
    expect(
      evaluateComposeCondition({
        condition: normalized.condition,
        facts: { marketPrice: 46.7 },
        lastReportSha: sha,
        alertWhileHolding: false,
      }).skipSend,
    ).toBe(true);
  });
});
