import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  tipFindMany,
  tipFindUnique,
  tipFindFirst,
  tipCreate,
  tipUpdate,
  tipDelete,
  tipProgressFindMany,
  tipProgressFindUnique,
  tipProgressCreate,
  tipProgressUpdate,
  employeeFindMany,
  employeeFindFirst,
} = vi.hoisted(() => ({
  tipFindMany: vi.fn(),
  tipFindUnique: vi.fn(),
  tipFindFirst: vi.fn(),
  tipCreate: vi.fn(),
  tipUpdate: vi.fn(),
  tipDelete: vi.fn(),
  tipProgressFindMany: vi.fn(),
  tipProgressFindUnique: vi.fn(),
  tipProgressCreate: vi.fn(),
  tipProgressUpdate: vi.fn(),
  employeeFindMany: vi.fn(),
  employeeFindFirst: vi.fn(),
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

import {
  collectAppliedTipOps,
  createTipForUser,
  ensureDefaultTips,
  formatAvailableTipsContext,
  resolveAndRecordTipsForTurn,
  tipAudienceMatchesForTest,
} from "../src/services/tips.service.js";

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
    maxShows: number;
    order: number;
    text: string;
    enabled: boolean;
  }> = {},
) {
  return {
    id: overrides.id ?? "tip-1",
    userId: USER,
    key: overrides.key ?? "reminders_intro",
    audience: overrides.audience ?? "member",
    digitalEmployeeId: overrides.digitalEmployeeId ?? LUCY,
    triggerKind: overrides.triggerKind ?? "action",
    triggerArea: overrides.triggerArea ?? "reminders",
    triggerOp: overrides.triggerOp ?? "add",
    maxShows: overrides.maxShows ?? 1,
    order: overrides.order ?? 0,
    text: overrides.text ?? "tip text",
    enabled: overrides.enabled ?? true,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

describe("tips service", () => {
  beforeEach(() => {
    tipFindMany.mockReset();
    tipFindUnique.mockReset();
    tipFindFirst.mockReset();
    tipCreate.mockReset();
    tipUpdate.mockReset();
    tipDelete.mockReset();
    tipProgressFindMany.mockReset();
    tipProgressFindUnique.mockReset();
    tipProgressCreate.mockReset();
    tipProgressUpdate.mockReset();
    employeeFindMany.mockReset();
    employeeFindFirst.mockReset();
    // resolveAndRecordTipsForTurn calls ensureDefaultTips first — empty digitals = no seed work.
    employeeFindMany.mockResolvedValue([]);
    tipFindUnique.mockResolvedValue(null);
  });

  it("filters audience guest vs member", () => {
    expect(tipAudienceMatchesForTest("guest", true)).toBe(true);
    expect(tipAudienceMatchesForTest("guest", false)).toBe(false);
    expect(tipAudienceMatchesForTest("member", true)).toBe(false);
    expect(tipAudienceMatchesForTest("member", false)).toBe(true);
    expect(tipAudienceMatchesForTest("any", true)).toBe(true);
  });

  it("collectAppliedTipOps maps mutations to areas", () => {
    const ops = collectAppliedTipOps({
      listMutations: [{ action: "add" }],
      filingMutations: [{ action: "add" }],
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
        { area: "lists", op: "add" },
        { area: "filing", op: "add" },
        { area: "reminders", op: "add" },
        { area: "directory", op: "remove" },
      ]),
    );
  });

  it("does not treat reminder update-only saved as add", () => {
    const ops = collectAppliedTipOps({
      listMutations: [],
      filingMutations: [],
      reminderSavedCount: 1,
      reminderUpdateCount: 1,
      reminderRemovedCount: 0,
      reminderRequestedAdd: true,
      directorySavedCount: 0,
      directoryRemovedCount: 0,
      directoryRequestedUpdate: false,
    });
    expect(ops.some((op) => op.area === "reminders" && op.op === "add")).toBe(
      false,
    );
    expect(ops.some((op) => op.area === "reminders" && op.op === "update")).toBe(
      true,
    );
  });

  it("seeds default tips once per key", async () => {
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
    tipFindUnique.mockResolvedValue(null);
    tipCreate.mockResolvedValue({});
    await ensureDefaultTips(USER);
    expect(tipCreate).toHaveBeenCalled();
    const keys = tipCreate.mock.calls.map(
      (call: unknown[]) => (call[0] as { data: { key: string } }).data.key,
    );
    expect(keys).toEqual(
      expect.arrayContaining([
        "reminders_intro",
        "filing_media",
        "guest_terms",
        "general_lists",
        "general_reminders",
      ]),
    );
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

  it("fires action tip once then stops at maxShows", async () => {
    const tip = tipRow({
      id: "tip-rem",
      key: "reminders_intro",
      maxShows: 1,
      text: "reminders tip",
    });
    tipFindMany.mockResolvedValue([tip]);
    tipProgressFindMany.mockResolvedValue([]);
    tipProgressFindUnique.mockResolvedValue(null);
    tipProgressCreate.mockResolvedValue({});

    const first = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker: {
        id: SPEAKER,
        name: "עמית",
        surname: "כ",
        nickname: null,
        email: null,
        phone: null,
        kind: "human",
      },
      digitalEmployeeId: LUCY,
      appliedOps: [{ area: "reminders", op: "add" }],
      modelTipKeys: [],
    });
    expect(first.texts).toEqual(["reminders tip"]);
    expect(tipProgressCreate).toHaveBeenCalled();

    tipProgressFindMany.mockResolvedValue([
      {
        tipId: tip.id,
        employeeId: SPEAKER,
        digitalEmployeeId: LUCY,
        showCount: 1,
      },
    ]);
    tipProgressCreate.mockClear();
    const second = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker: {
        id: SPEAKER,
        name: "עמית",
        surname: "כ",
        nickname: null,
        email: null,
        phone: null,
        kind: "human",
      },
      digitalEmployeeId: LUCY,
      appliedOps: [{ area: "reminders", op: "add" }],
      modelTipKeys: [],
    });
    expect(second.texts).toEqual([]);
  });

  it("rotates general tips one per turn by order", async () => {
    const g1 = tipRow({
      id: "g1",
      key: "general_lists",
      triggerKind: "general",
      triggerArea: null,
      triggerOp: null,
      order: 10,
      maxShows: 3,
      text: "general A",
    });
    const g2 = tipRow({
      id: "g2",
      key: "general_reminders",
      triggerKind: "general",
      triggerArea: null,
      triggerOp: null,
      order: 20,
      maxShows: 3,
      text: "general B",
    });
    tipFindMany.mockResolvedValue([g1, g2]);
    tipProgressFindMany.mockResolvedValue([]);
    tipProgressFindUnique.mockResolvedValue(null);
    tipProgressCreate.mockResolvedValue({});

    const turn1 = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker: {
        id: SPEAKER,
        name: "עמית",
        surname: "כ",
        nickname: null,
        email: null,
        phone: null,
        kind: "human",
      },
      digitalEmployeeId: LUCY,
      appliedOps: [],
      modelTipKeys: [],
    });
    expect(turn1.texts).toEqual(["general A"]);

    tipProgressFindMany.mockResolvedValue([
      {
        tipId: g1.id,
        employeeId: SPEAKER,
        digitalEmployeeId: LUCY,
        showCount: 1,
      },
    ]);
    const turn2 = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker: {
        id: SPEAKER,
        name: "עמית",
        surname: "כ",
        nickname: null,
        email: null,
        phone: null,
        kind: "human",
      },
      digitalEmployeeId: LUCY,
      appliedOps: [],
      modelTipKeys: [],
    });
    expect(turn2.texts).toEqual(["general B"]);
  });

  it("skips general when a contextual tip fired", async () => {
    const action = tipRow({
      id: "a1",
      key: "reminders_intro",
      order: 100,
      text: "action tip",
    });
    const general = tipRow({
      id: "g1",
      key: "general_lists",
      triggerKind: "general",
      triggerArea: null,
      triggerOp: null,
      order: 10,
      text: "general tip",
    });
    tipFindMany.mockResolvedValue([action, general]);
    tipProgressFindMany.mockResolvedValue([]);
    tipProgressFindUnique.mockResolvedValue(null);
    tipProgressCreate.mockResolvedValue({});

    const result = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker: {
        id: SPEAKER,
        name: "עמית",
        surname: "כ",
        nickname: null,
        email: null,
        phone: null,
        kind: "human",
      },
      digitalEmployeeId: LUCY,
      appliedOps: [{ area: "reminders", op: "add" }],
      modelTipKeys: [],
    });
    expect(result.texts).toEqual(["action tip"]);
  });

  it("honors model tip keys for guests only on guest digital", async () => {
    const guestTip = tipRow({
      id: "gt",
      key: "guest_terms",
      audience: "guest",
      digitalEmployeeId: GUEST_LUCY,
      triggerKind: "model",
      triggerArea: null,
      triggerOp: null,
      text: "terms",
    });
    tipFindMany.mockResolvedValue([guestTip]);
    tipProgressFindMany.mockResolvedValue([]);
    tipProgressFindUnique.mockResolvedValue(null);
    tipProgressCreate.mockResolvedValue({});

    const asGuest = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker: {
        id: SPEAKER,
        name: "אורח",
        surname: "",
        nickname: "אורח …1495",
        email: null,
        phone: null,
        kind: "human",
      },
      digitalEmployeeId: GUEST_LUCY,
      appliedOps: [],
      modelTipKeys: ["guest_terms"],
    });
    expect(asGuest.texts).toEqual(["terms"]);

    tipProgressCreate.mockClear();
    const asMember = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker: {
        id: SPEAKER,
        name: "עמית",
        surname: "כ",
        nickname: null,
        email: null,
        phone: null,
        kind: "human",
      },
      digitalEmployeeId: GUEST_LUCY,
      appliedOps: [],
      modelTipKeys: ["guest_terms"],
    });
    expect(asMember.texts).toEqual([]);
  });

  it("ignores unknown model tip keys", async () => {
    tipFindMany.mockResolvedValue([
      tipRow({
        triggerKind: "model",
        triggerArea: null,
        key: "guest_terms",
        text: "terms",
      }),
    ]);
    tipProgressFindMany.mockResolvedValue([]);
    const result = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker: {
        id: SPEAKER,
        name: "עמית",
        surname: "כ",
        nickname: null,
        email: null,
        phone: null,
        kind: "human",
      },
      digitalEmployeeId: LUCY,
      appliedOps: [],
      modelTipKeys: ["not_a_real_tip"],
    });
    expect(result.texts).toEqual([]);
  });

  it("allows maxShows across separate turns", async () => {
    const tip = tipRow({
      id: "g1",
      key: "general_lists",
      triggerKind: "general",
      triggerArea: null,
      triggerOp: null,
      maxShows: 3,
      text: "again",
    });
    tipFindMany.mockResolvedValue([tip]);
    tipProgressFindUnique.mockResolvedValue({
      id: "prog",
      tipId: tip.id,
      employeeId: SPEAKER,
      digitalEmployeeId: LUCY,
      showCount: 2,
    });
    tipProgressFindMany.mockResolvedValue([
      {
        tipId: tip.id,
        employeeId: SPEAKER,
        digitalEmployeeId: LUCY,
        showCount: 2,
      },
    ]);
    tipProgressUpdate.mockResolvedValue({});

    const result = await resolveAndRecordTipsForTurn({
      userId: USER,
      speaker: {
        id: SPEAKER,
        name: "עמית",
        surname: "כ",
        nickname: null,
        email: null,
        phone: null,
        kind: "human",
      },
      digitalEmployeeId: LUCY,
      appliedOps: [],
      modelTipKeys: [],
    });
    expect(result.texts).toEqual(["again"]);
    expect(tipProgressUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ showCount: 3 }),
      }),
    );
  });

  it("injects catalog tip text into AVAILABLE_TIPS for model tips", async () => {
    tipFindUnique.mockResolvedValue({ id: "exists" });
    tipFindMany.mockResolvedValue([
      tipRow({
        id: "tip-terms",
        key: "guest_terms",
        audience: "guest",
        digitalEmployeeId: GUEST_LUCY,
        triggerKind: "model",
        text: "תקנון שימוש\n(תמצית)",
        maxShows: 1,
        order: 1,
      }),
      tipRow({
        id: "tip-other",
        key: "custom_help",
        audience: "any",
        digitalEmployeeId: GUEST_LUCY,
        triggerKind: "model",
        text: "אפשר לבקש עזרה בכל רגע",
        maxShows: 1,
        order: 2,
      }),
    ]);
    tipProgressFindMany.mockResolvedValue([]);

    const context = await formatAvailableTipsContext({
      userId: USER,
      speaker: {
        id: SPEAKER,
        name: "אורח",
        surname: "",
        nickname: null,
        email: null,
        phone: null,
        kind: "human",
      },
      digitalEmployeeId: GUEST_LUCY,
    });

    expect(context).toContain("AVAILABLE_TIPS");
    expect(context).toContain("key=guest_terms text: תקנון שימוש (תמצית)");
    expect(context).toContain("key=custom_help text: אפשר לבקש עזרה בכל רגע");
    expect(context).not.toContain("when: guest asks");
    expect(context).not.toContain("model tip key=");
  });
});
