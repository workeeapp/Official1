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

import {
  collectAppliedTipOps,
  createTipForUser,
  ensureDefaultTips,
  resolveAndRecordTipsForTurn,
  sendTipForUser,
  tipAudienceMatchesForTest,
} from "../src/services/tips.service.js";
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
    tipFindFirst.mockResolvedValue({ id: tipId, text: "  Preview tip  " });
    await sendTipForUser(USER, tipId);
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      "972544365812",
      "Preview tip",
      { ignoreSession: true },
    );
  });
});
