import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  tipFindMany,
  tipFindUnique,
  tipFindFirst,
  tipCreate,
  tipUpdate,
  tipDelete,
  tipDeleteMany,
  tipProgressFindMany,
  tipProgressFindUnique,
  tipProgressCreate,
  tipProgressUpdate,
  employeeFindMany,
  employeeFindFirst,
  sendWhatsAppText,
  composeCatalogTip,
} = vi.hoisted(() => ({
  tipFindMany: vi.fn(),
  tipFindUnique: vi.fn(),
  tipFindFirst: vi.fn(),
  tipCreate: vi.fn(),
  tipUpdate: vi.fn(),
  tipDelete: vi.fn(),
  tipDeleteMany: vi.fn(),
  tipProgressFindMany: vi.fn(),
  tipProgressFindUnique: vi.fn(),
  tipProgressCreate: vi.fn(),
  tipProgressUpdate: vi.fn(),
  employeeFindMany: vi.fn(),
  employeeFindFirst: vi.fn(),
  sendWhatsAppText: vi.fn(),
  composeCatalogTip: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    tip: {
      findMany: tipFindMany,
      findUnique: tipFindUnique,
      findFirst: tipFindFirst,
      create: tipCreate,
      update: tipUpdate,
      delete: tipDelete,
      deleteMany: tipDeleteMany,
    },
    tipProgress: {
      findMany: tipProgressFindMany,
      findUnique: tipProgressFindUnique,
      create: tipProgressCreate,
      update: tipProgressUpdate,
    },
    employee: {
      findMany: employeeFindMany,
      findFirst: employeeFindFirst,
    },
  },
}));

vi.mock("../src/services/whatsapp-send.js", () => ({
  sendWhatsAppText,
}));

vi.mock("../src/services/tip-compose.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/tip-compose.js")>();
  return {
    ...actual,
    composeCatalogTip,
  };
});

import {
  collectAppliedTipOps,
  createTipForUser,
  ensureDefaultTips,
  resolveAndRecordTipsForTurn,
  sendTipForUser,
  tipAudienceMatchesForTest,
  tipCooldownOk,
} from "../src/services/tips.service.js";
import { renderStaticTipText } from "../src/services/tip-compose.js";
import { SYSTEM_TIP_SEEDS } from "../src/services/tip-catalog.js";
import { ValidationError } from "../src/utils/errors.js";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPEAKER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LUCY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GUEST_LUCY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function tipRow(
  overrides: Partial<{
    id: string;
    key: string;
    audience: string;
    digitalEmployeeId: string | null;
    triggerKind: string;
    triggerArea: string | null;
    triggerOp: string | null;
    tier: string;
    topic: string | null;
    listType: string | null;
    unlockAfterKey: string | null;
    systemSeed: boolean;
    outputMode: string;
    minIntervalMinutes: number;
    maxShows: number;
    order: number;
    text: string;
    enabled: boolean;
  }> = {},
) {
  return {
    id: overrides.id ?? "tip-1",
    userId: USER,
    key: overrides.key ?? "reminders_basic_store",
    audience: overrides.audience ?? "member",
    digitalEmployeeId: overrides.digitalEmployeeId ?? LUCY,
    triggerKind: overrides.triggerKind ?? "action",
    triggerArea: overrides.triggerArea ?? "reminders",
    triggerOp: overrides.triggerOp ?? "add",
    tier: overrides.tier ?? "basic",
    topic: overrides.topic ?? "reminders",
    listType: overrides.listType ?? "reminders",
    unlockAfterKey: overrides.unlockAfterKey ?? null,
    systemSeed: overrides.systemSeed ?? true,
    outputMode: overrides.outputMode ?? "static",
    minIntervalMinutes: overrides.minIntervalMinutes ?? 0,
    maxShows: overrides.maxShows ?? 1,
    order: overrides.order ?? 0,
    text: overrides.text ?? "tip text",
    enabled: overrides.enabled ?? true,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

const speaker = {
  id: SPEAKER,
  name: "עמית",
  surname: "כ",
  nickname: null,
  email: null,
  phone: null,
  kind: "human" as const,
};

describe("tips service", () => {
  beforeEach(() => {
    tipFindMany.mockReset();
    tipFindUnique.mockReset();
    tipFindFirst.mockReset();
    tipCreate.mockReset();
    tipUpdate.mockReset();
    tipDelete.mockReset();
    tipDeleteMany.mockReset();
    tipProgressFindMany.mockReset();
    tipProgressFindUnique.mockReset();
    tipProgressCreate.mockReset();
    tipProgressUpdate.mockReset();
    employeeFindMany.mockReset();
    employeeFindFirst.mockReset();
    composeCatalogTip.mockReset();
    employeeFindMany.mockResolvedValue([]);
    tipFindUnique.mockResolvedValue(null);
    tipDeleteMany.mockResolvedValue({ count: 0 });
  });

  it("filters audience guest vs member", () => {
    expect(tipAudienceMatchesForTest("guest", true)).toBe(true);
    expect(tipAudienceMatchesForTest("guest", false)).toBe(false);
    expect(tipAudienceMatchesForTest("member", true)).toBe(false);
    expect(tipAudienceMatchesForTest("member", false)).toBe(true);
    expect(tipAudienceMatchesForTest("any", true)).toBe(true);
  });

  it("collectAppliedTipOps maps listType to topics", () => {
    const ops = collectAppliedTipOps({
      listMutations: [
        { action: "add", listType: "shopping" },
        { action: "add", listType: "tasks" },
      ],
      filingMutations: [{ action: "add_filing" }],
      reminderSavedCount: 1,
      reminderUpdateCount: 0,
      reminderRemovedCount: 0,
      reminderRequestedAdd: true,
      directorySavedCount: 0,
      directoryRemovedCount: 1,
      directoryRequestedUpdate: false,
    });
    expect(ops).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: "shopping",
          listType: "shopping",
          op: "add",
        }),
        expect.objectContaining({ topic: "tasks", op: "add" }),
        expect.objectContaining({ topic: "meetings", op: "add", listType: "tasks" }),
        expect.objectContaining({ topic: "filing", op: "add" }),
        expect.objectContaining({ topic: "reminders", op: "add" }),
        expect.objectContaining({ topic: "directory", op: "remove" }),
      ]),
    );
  });

  it("upserts ladder catalog without rotating ids", async () => {
    employeeFindMany.mockResolvedValue([
      {
        id: LUCY,
        name: "לוסי",
        nickname: "לוסי",
        isProtected: true,
      },
      {
        id: GUEST_LUCY,
        name: "לוסי-אורח",
        nickname: "לוסי-אורח",
        isProtected: false,
      },
    ]);
    tipFindMany.mockResolvedValue([
      {
        id: "keep-id",
        key: "shopping_basic_add",
        systemSeed: true,
      },
    ]);
    tipCreate.mockResolvedValue({});
    tipUpdate.mockResolvedValue({});
    tipDeleteMany.mockResolvedValue({ count: 0 });
    await ensureDefaultTips(USER);
    expect(tipDeleteMany).toHaveBeenCalled();
    expect(tipUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "keep-id" },
        data: expect.objectContaining({
          text: expect.any(String),
          systemSeed: true,
        }),
      }),
    );
    const createdKeys = tipCreate.mock.calls.map(
      (call: unknown[]) => (call[0] as { data: { key: string } }).data.key,
    );
    expect(createdKeys).toContain("guest_terms");
    expect(createdKeys).toContain("reminders_adv_repeat");
    expect(createdKeys).not.toContain("shopping_basic_add");
    expect(createdKeys.length).toBe(SYSTEM_TIP_SEEDS.length - 1);
  });

  it("leaves user-edited tips alone when key matches a seed", async () => {
    employeeFindMany.mockResolvedValue([
      {
        id: LUCY,
        name: "לוסי",
        nickname: "לוסי",
        isProtected: true,
      },
    ]);
    tipFindMany.mockResolvedValue([
      {
        id: "customized",
        key: "shopping_basic_add",
        systemSeed: false,
      },
    ]);
    tipCreate.mockResolvedValue({});
    tipUpdate.mockResolvedValue({});
    tipDeleteMany.mockResolvedValue({ count: 0 });
    await ensureDefaultTips(USER);
    expect(tipUpdate).not.toHaveBeenCalled();
    const createdKeys = tipCreate.mock.calls.map(
      (call: unknown[]) => (call[0] as { data: { key: string } }).data.key,
    );
    expect(createdKeys).not.toContain("shopping_basic_add");
  });

  it("createTipForUser rejects unknown digital", async () => {
    employeeFindFirst.mockResolvedValue(null);
    await expect(
      createTipForUser(USER, {
        key: "custom_tip",
        audience: "member",
        digitalEmployeeId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        triggerKind: "general",
        triggerArea: null,
        triggerOp: null,
        maxShows: 1,
        order: 0,
        text: "hello",
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("fires lowest-order basic tip then unlocks mid after any basic shown", async () => {
    const basic1 = tipRow({
      id: "b1",
      key: "reminders_basic_store",
      tier: "basic",
      topic: "reminders",
      order: 500,
      text: "basic one",
    });
    const basic2 = tipRow({
      id: "b2",
      key: "reminders_basic_ask",
      tier: "basic",
      topic: "reminders",
      order: 501,
      text: "basic two",
    });
    const mid = tipRow({
      id: "m1",
      key: "reminders_mid_relative",
      tier: "intermediate",
      topic: "reminders",
      order: 502,
      text: "mid tip",
    });
    tipFindMany.mockResolvedValue([basic1, basic2, mid]);
    tipProgressFindMany.mockResolvedValue([]);
    tipProgressFindUnique.mockResolvedValue(null);
    tipProgressCreate.mockResolvedValue({});
    tipDeleteMany.mockResolvedValue({ count: 0 });
    employeeFindMany.mockResolvedValue([]);

    const first = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker,
      digitalEmployeeId: LUCY,
      appliedOps: [
        {
          area: "reminders",
          op: "add",
          listType: "reminders",
          topic: "reminders",
        },
      ],
      modelTipKeys: [],
    });
    expect(first.texts).toEqual(["basic one"]);

    tipProgressFindMany.mockResolvedValue([
      {
        tipId: basic1.id,
        employeeId: SPEAKER,
        digitalEmployeeId: LUCY,
        showCount: 1,
      },
    ]);
    tipProgressCreate.mockClear();
    const second = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker,
      digitalEmployeeId: LUCY,
      appliedOps: [
        {
          area: "reminders",
          op: "add",
          listType: "reminders",
          topic: "reminders",
        },
      ],
      modelTipKeys: [],
    });
    // Still prefer remaining basic (order 501) before mid
    expect(second.texts).toEqual(["basic two"]);

    tipProgressFindMany.mockResolvedValue([
      {
        tipId: basic1.id,
        employeeId: SPEAKER,
        digitalEmployeeId: LUCY,
        showCount: 1,
      },
      {
        tipId: basic2.id,
        employeeId: SPEAKER,
        digitalEmployeeId: LUCY,
        showCount: 1,
      },
    ]);
    const third = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker,
      digitalEmployeeId: LUCY,
      appliedOps: [
        {
          area: "reminders",
          op: "add",
          listType: "reminders",
          topic: "reminders",
        },
      ],
      modelTipKeys: [],
    });
    expect(third.texts).toEqual(["mid tip"]);
  });

  it("substitutes static placeholders from turn FACTS", async () => {
    const tip = tipRow({
      id: "shop-del",
      key: "shopping_delete_howto",
      topic: "shopping",
      listType: "shopping",
      triggerArea: "lists",
      text: "תמחקי את {item_label}",
      outputMode: "static",
    });
    tipFindMany.mockResolvedValue([tip]);
    tipProgressFindMany.mockResolvedValue([]);
    tipProgressFindUnique.mockResolvedValue(null);
    tipProgressCreate.mockResolvedValue({});
    employeeFindMany.mockResolvedValue([]);

    const turn = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker,
      digitalEmployeeId: LUCY,
      appliedOps: [
        { area: "lists", op: "add", listType: "shopping", topic: "shopping" },
      ],
      modelTipKeys: [],
      turnFactItems: [
        { listType: "shopping", op: "add", itemLabel: "חלב", itemKey: "חלב" },
      ],
    });
    expect(turn.texts).toEqual(["תמחקי את חלב"]);
    expect(composeCatalogTip).not.toHaveBeenCalled();
    expect(tipProgressCreate).toHaveBeenCalled();
  });

  it("skips static tip when placeholder FACTS missing", async () => {
    const tip = tipRow({
      id: "shop-del",
      key: "shopping_delete_howto",
      topic: "shopping",
      listType: "shopping",
      triggerArea: "lists",
      text: "תמחקי את {item_label}",
      outputMode: "static",
    });
    tipFindMany.mockResolvedValue([tip]);
    tipProgressFindMany.mockResolvedValue([]);
    tipProgressFindUnique.mockResolvedValue(null);
    tipProgressCreate.mockResolvedValue({});
    employeeFindMany.mockResolvedValue([]);

    const turn = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker,
      digitalEmployeeId: LUCY,
      appliedOps: [
        { area: "lists", op: "add", listType: "shopping", topic: "shopping" },
      ],
      modelTipKeys: [],
      turnFactItems: [],
    });
    expect(turn.texts).toEqual([]);
    expect(tipProgressCreate).not.toHaveBeenCalled();
  });

  it("composes dynamic tip and bumps progress; skips on compose fail", async () => {
    const tip = tipRow({
      id: "dyn-1",
      key: "shopping_dyn",
      topic: "shopping",
      listType: "shopping",
      triggerArea: "lists",
      text: "כתוב טיפ עם שם הפריט מ-FACTS",
      outputMode: "dynamic",
    });
    tipFindMany.mockResolvedValue([tip]);
    tipProgressFindMany.mockResolvedValue([]);
    tipProgressFindUnique.mockResolvedValue(null);
    tipProgressCreate.mockResolvedValue({});
    employeeFindMany.mockResolvedValue([]);
    composeCatalogTip.mockResolvedValue("לידיעתך תמחקי את החלב");

    const billing = {
      conversationId: "conv-1",
      employeeId: SPEAKER,
      digitalEmployeeId: LUCY,
    };
    const ok = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker,
      digitalEmployeeId: LUCY,
      appliedOps: [
        { area: "lists", op: "add", listType: "shopping", topic: "shopping" },
      ],
      modelTipKeys: [],
      turnFactItems: [
        { listType: "shopping", op: "add", itemLabel: "חלב", itemKey: "חלב" },
      ],
      billing,
    });
    expect(ok.texts).toEqual(["לידיעתך תמחקי את החלב"]);
    expect(composeCatalogTip).toHaveBeenCalledWith(
      expect.objectContaining({
        billing,
        facts: expect.objectContaining({ item_label: "חלב" }),
      }),
    );
    expect(tipProgressCreate).toHaveBeenCalled();

    tipProgressCreate.mockClear();
    composeCatalogTip.mockResolvedValue(null);
    const fail = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker,
      digitalEmployeeId: LUCY,
      appliedOps: [
        { area: "lists", op: "add", listType: "shopping", topic: "shopping" },
      ],
      modelTipKeys: [],
      turnFactItems: [
        { listType: "shopping", op: "add", itemLabel: "חלב", itemKey: "חלב" },
      ],
      billing,
    });
    expect(fail.texts).toEqual([]);
    expect(tipProgressCreate).not.toHaveBeenCalled();
  });

  it("respects minIntervalMinutes cooldown", async () => {
    const tip = tipRow({
      id: "cool-1",
      key: "shopping_cool",
      topic: "shopping",
      listType: "shopping",
      triggerArea: "lists",
      text: "tip",
      maxShows: 5,
      minIntervalMinutes: 60,
    });
    tipFindMany.mockResolvedValue([tip]);
    tipProgressFindMany.mockResolvedValue([
      {
        tipId: tip.id,
        employeeId: SPEAKER,
        digitalEmployeeId: LUCY,
        showCount: 1,
        lastShownAt: new Date(),
      },
    ]);
    tipProgressCreate.mockResolvedValue({});
    employeeFindMany.mockResolvedValue([]);

    const blocked = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker,
      digitalEmployeeId: LUCY,
      appliedOps: [
        { area: "lists", op: "add", listType: "shopping", topic: "shopping" },
      ],
      modelTipKeys: [],
    });
    expect(blocked.texts).toEqual([]);

    tipProgressFindMany.mockResolvedValue([
      {
        tipId: tip.id,
        employeeId: SPEAKER,
        digitalEmployeeId: LUCY,
        showCount: 1,
        lastShownAt: new Date(Date.now() - 2 * 60 * 60_000),
      },
    ]);
    tipProgressFindUnique.mockResolvedValue({
      id: "prog-1",
      tipId: tip.id,
      showCount: 1,
    });
    tipProgressUpdate.mockResolvedValue({});
    const allowed = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker,
      digitalEmployeeId: LUCY,
      appliedOps: [
        { area: "lists", op: "add", listType: "shopping", topic: "shopping" },
      ],
      modelTipKeys: [],
    });
    expect(allowed.texts).toEqual(["tip"]);
  });

  it("falls back to a general tip when no action/model tip matches", async () => {
    const general = tipRow({
      id: "g-weather",
      key: "general_weather",
      triggerKind: "general",
      triggerArea: null,
      triggerOp: null,
      topic: null,
      listType: null,
      order: 800,
      maxShows: 2,
      text: "אגב, אפשר לשאול אותי מה מזג האוויר היום או בימים הקרובים.",
    });
    tipFindMany.mockResolvedValue([general]);
    tipProgressFindMany.mockResolvedValue([]);
    tipProgressFindUnique.mockResolvedValue(null);
    tipProgressCreate.mockResolvedValue({});
    employeeFindMany.mockResolvedValue([]);

    const turn = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker,
      digitalEmployeeId: LUCY,
      appliedOps: [],
      modelTipKeys: [],
    });
    expect(turn.texts).toEqual([general.text]);
    expect(tipProgressCreate).toHaveBeenCalled();
  });

  it("prefers a matching action tip over general tips", async () => {
    const action = tipRow({
      id: "a1",
      key: "shopping_basic_add",
      topic: "shopping",
      listType: "shopping",
      triggerArea: "lists",
      triggerOp: "add",
      order: 100,
      text: "action tip",
    });
    const general = tipRow({
      id: "g1",
      key: "general_weather",
      triggerKind: "general",
      triggerArea: null,
      triggerOp: null,
      topic: null,
      order: 1,
      text: "general tip",
    });
    tipFindMany.mockResolvedValue([general, action]);
    tipProgressFindMany.mockResolvedValue([]);
    tipProgressFindUnique.mockResolvedValue(null);
    tipProgressCreate.mockResolvedValue({});
    employeeFindMany.mockResolvedValue([]);

    const turn = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker,
      digitalEmployeeId: LUCY,
      appliedOps: [
        { area: "lists", op: "add", listType: "shopping", topic: "shopping" },
      ],
      modelTipKeys: [],
    });
    expect(turn.texts).toEqual(["action tip"]);
    expect(turn.texts).not.toContain("general tip");
  });

  it("emits at most one tip per turn even if several match", async () => {
    const shopping = tipRow({
      id: "s1",
      key: "shopping_basic_add",
      topic: "shopping",
      listType: "shopping",
      triggerArea: "lists",
      order: 100,
      text: "shop tip",
    });
    const tasks = tipRow({
      id: "t1",
      key: "tasks_basic_add",
      topic: "tasks",
      listType: "tasks",
      triggerArea: "lists",
      order: 200,
      text: "task tip",
    });
    tipFindMany.mockResolvedValue([shopping, tasks]);
    tipProgressFindMany.mockResolvedValue([]);
    tipProgressFindUnique.mockResolvedValue(null);
    tipProgressCreate.mockResolvedValue({});
    employeeFindMany.mockResolvedValue([]);

    const turn = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker,
      digitalEmployeeId: LUCY,
      appliedOps: [
        { area: "lists", op: "add", listType: "shopping", topic: "shopping" },
        { area: "lists", op: "add", listType: "tasks", topic: "tasks" },
      ],
      modelTipKeys: [],
    });
    expect(turn.texts).toHaveLength(1);
    expect(turn.texts[0]).toBe("shop tip");
  });
});

describe("sendTipForUser", () => {
  const tipId = "tip-send-1";
  const previousPhone = process.env.TIPS_PREVIEW_PHONE;

  beforeEach(() => {
    tipFindFirst.mockReset();
    sendWhatsAppText.mockReset();
    sendWhatsAppText.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    if (previousPhone === undefined) {
      delete process.env.TIPS_PREVIEW_PHONE;
    } else {
      process.env.TIPS_PREVIEW_PHONE = previousPhone;
    }
  });

  it("rejects when TIPS_PREVIEW_PHONE is missing", async () => {
    delete process.env.TIPS_PREVIEW_PHONE;
    tipFindFirst.mockResolvedValue({ id: tipId, text: "Hello tip" });
    await expect(sendTipForUser(USER, tipId)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("sends tip text to the normalized preview phone", async () => {
    process.env.TIPS_PREVIEW_PHONE = "0544365812";
    tipFindFirst.mockResolvedValue({
      id: tipId,
      text: "  Preview tip  ",
      outputMode: "static",
    });
    await sendTipForUser(USER, tipId);
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      "972544365812",
      "Preview tip",
      { ignoreSession: true },
    );
  });

  it("preview substitutes static placeholders with sample FACTS", async () => {
    process.env.TIPS_PREVIEW_PHONE = "0544365812";
    tipFindFirst.mockResolvedValue({
      id: tipId,
      text: "תמחקי את {item_label}",
      outputMode: "static",
    });
    await sendTipForUser(USER, tipId);
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      "972544365812",
      "תמחקי את חלב",
      { ignoreSession: true },
    );
  });
});

describe("renderStaticTipText / tipCooldownOk", () => {
  it("replaces known tokens and skips when missing", () => {
    expect(
      renderStaticTipText("תמחקי את {item_label}", {
        item_label: "חלב",
        items: ["חלב"],
      }),
    ).toBe("תמחקי את חלב");
    expect(
      renderStaticTipText("תמחקי את {item_label}", { item_label: "" }),
    ).toBeNull();
    expect(renderStaticTipText("plain tip", {})).toBe("plain tip");
  });

  it("gates cooldown by minutes", () => {
    const now = new Date("2026-10-23T12:00:00Z");
    expect(tipCooldownOk(undefined, 30, now)).toBe(true);
    expect(tipCooldownOk(new Date("2026-10-23T11:45:00Z"), 30, now)).toBe(false);
    expect(tipCooldownOk(new Date("2026-10-23T11:20:00Z"), 30, now)).toBe(true);
  });
});
