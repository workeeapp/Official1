/**
 * Phase 1 dual-path engine — integration against real service modules
 * (mocked Prisma). Proves nested packages, dedup, flag, cascade join cleanup,
 * retry/no-steal, and that exact-key stays ON by default.
 *
 * Run: npx vitest run tests/reminder-soft-link-phase1.offline.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reminderActionFromNestedRemind } from "@workee/shared";

const {
  itemUpdate,
  itemUpdateMany,
  itemFindMany,
  reminderUpdate,
  reminderCreate,
  reminderFindMany,
  linkCreate,
  linkFindUnique,
  linkFindMany,
  linkDeleteMany,
  employeeFindMany,
  transaction,
} = vi.hoisted(() => ({
  itemUpdate: vi.fn(),
  itemUpdateMany: vi.fn(),
  itemFindMany: vi.fn(),
  reminderUpdate: vi.fn(),
  reminderCreate: vi.fn(),
  reminderFindMany: vi.fn(),
  linkCreate: vi.fn(),
  linkFindUnique: vi.fn(),
  linkFindMany: vi.fn(),
  linkDeleteMany: vi.fn(),
  employeeFindMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    employee: { findMany: employeeFindMany },
    employeeListItem: {
      update: itemUpdate,
      updateMany: itemUpdateMany,
      findMany: itemFindMany,
    },
    employeeListItemReminderLink: {
      create: linkCreate,
      findUnique: linkFindUnique,
      findMany: linkFindMany,
      deleteMany: linkDeleteMany,
    },
    reminder: {
      update: reminderUpdate,
      create: reminderCreate,
      findMany: reminderFindMany,
    },
    $transaction: transaction,
  },
}));

vi.mock("../src/services/audit.service.js", () => ({
  recordAuditEvent: vi.fn(async () => undefined),
}));

vi.mock("../src/services/reminder-fire.js", () => ({
  scheduleSoon: vi.fn(),
}));

import {
  applyNestedReminderPackages,
  clocksEligibleForExactKeySoftLink,
  excludeNestedItemsFromSoftLinkCandidates,
  filterTopLevelRemindersAgainstNested,
  linkRemindersToItems,
  removeReminderAndLinkedWorkerTask,
} from "../src/services/reminder.service.js";
import {
  buildReminderClockFingerprint,
  fingerprintFromReminderAction,
  isExactKeySoftLinkEnabled,
  ymdHm,
} from "../src/services/reminder-soft-link.js";
import { splitItemRemind } from "../src/services/reminder-soft-link.js";

const USER = "user-1";
const ACTOR = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "טל",
  kind: "human" as const,
  isOwner: true,
  nickname: null,
  phone: null,
};
const ITEM_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REM_1 = "11111111-1111-4111-8111-111111111111";

describe("Phase 1 dual-path engine (service integration)", () => {
  beforeEach(() => {
    itemUpdate.mockReset();
    itemUpdateMany.mockReset();
    itemFindMany.mockReset();
    reminderUpdate.mockReset();
    reminderCreate.mockReset();
    reminderFindMany.mockReset();
    linkCreate.mockReset();
    linkFindUnique.mockReset();
    linkFindMany.mockReset();
    linkDeleteMany.mockReset();
    employeeFindMany.mockReset();
    transaction.mockReset();
    linkFindUnique.mockResolvedValue(null);
    linkFindMany.mockResolvedValue([]);
    linkDeleteMany.mockResolvedValue({ count: 0 });
    reminderFindMany.mockResolvedValue([]);
    itemUpdateMany.mockResolvedValue({ count: 0 });
    itemFindMany.mockResolvedValue([]);
    reminderUpdate.mockResolvedValue({});
    linkCreate.mockResolvedValue({});
    delete process.env.WORKEE_SOFT_LINK_EXACT_KEY;
  });

  describe("schema/parse — nested remind peel + ACTION expansion", () => {
    it("splitItemRemind peels remind without leaving it on the item", () => {
      const { item, reminds } = splitItemRemind({
        "שם מטלה": "תור לווטרינר",
        remind: { date: "2026-11-10", time: "09:00", ping: ["טל"] },
      });
      expect(item).toEqual({ "שם מטלה": "תור לווטרינר" });
      expect(reminds).toHaveLength(1);
      expect(reminds[0]?.date).toBe("2026-11-10");
    });

    it("reminderActionFromNestedRemind sets item_id for join path", () => {
      const action = reminderActionFromNestedRemind(
        { date: "2026-11-10", time: "09:00", text: "תזכורת" },
        { itemLabel: "תור לווטרינר", listType: "tasks", itemId: ITEM_A },
      );
      expect(action?.action).toBe("add");
      expect(action?.itemId).toBe(ITEM_A);
      expect(action?.date).toBe("2026-11-10");
      expect(action?.time).toBe("09:00");
    });
  });

  describe("exact-key flag default ON", () => {
    it("absent env → linkRemindersToItems still pairs", async () => {
      expect(isExactKeySoftLinkEnabled()).toBe(true);
      await linkRemindersToItems(
        [{ id: REM_1, itemKey: "vet", itemLabel: "תור" }],
        [{ id: ITEM_A, itemKey: "vet", itemLabel: "תור" }],
      );
      expect(linkCreate).toHaveBeenCalledWith({
        data: { listItemId: ITEM_A, reminderId: REM_1 },
      });
    });

    it("WORKEE_SOFT_LINK_EXACT_KEY=0 → linkRemindersToItems no-op", async () => {
      process.env.WORKEE_SOFT_LINK_EXACT_KEY = "0";
      await linkRemindersToItems(
        [{ id: REM_1, itemKey: "vet", itemLabel: "תור" }],
        [{ id: ITEM_A, itemKey: "vet", itemLabel: "תור" }],
      );
      expect(linkCreate).not.toHaveBeenCalled();
    });

    it("explicit exactKeyEnabled:true still links when env is 0", async () => {
      process.env.WORKEE_SOFT_LINK_EXACT_KEY = "0";
      await linkRemindersToItems(
        [{ id: REM_1, itemKey: "vet", itemLabel: "תור" }],
        [{ id: ITEM_A, itemKey: "vet", itemLabel: "תור" }],
        { exactKeyEnabled: true },
      );
      expect(linkCreate).toHaveBeenCalled();
    });
  });

  describe("Stage 5a — NEW/EXISTING excluded from exact-key clocks", () => {
    const REM_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const REM_3 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    it("drops nested clock ids and ESD requestedItemId; keeps legacy", () => {
      const saved = [
        { id: REM_1, itemKey: "nested", requestedItemId: ITEM_A },
        { id: REM_2, itemKey: "existing", requestedItemId: ITEM_B },
        { id: REM_3, itemKey: "legacy" },
      ];
      const eligible = clocksEligibleForExactKeySoftLink(saved, [REM_1]);
      expect(eligible.map((r) => r.id)).toEqual([REM_3]);
    });

    it("requestedItemId alone excludes EXISTING even without nested set", () => {
      const saved = [
        { id: REM_1, requestedItemId: ITEM_A },
        { id: REM_2, requestedItemId: "  " },
        { id: REM_3 },
      ];
      expect(
        clocksEligibleForExactKeySoftLink(saved).map((r) => r.id),
      ).toEqual([REM_2, REM_3]);
    });

    it("nested id excludes even when requestedItemId missing", () => {
      const saved = [{ id: REM_1, itemKey: "x" }, { id: REM_2, itemKey: "y" }];
      expect(
        clocksEligibleForExactKeySoftLink(saved, [REM_1]).map((r) => r.id),
      ).toEqual([REM_2]);
    });
  });

  describe("nested package txn + compensate", () => {
    it("creates reminder + join inside $transaction", async () => {
      transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          reminder: {
            create: reminderCreate,
          },
          employeeListItemReminderLink: {
            create: linkCreate,
            findUnique: linkFindUnique,
          },
        };
        reminderCreate.mockResolvedValue({
          id: REM_1,
          fireAt: ymdHm(2026, 11, 10, 9, 0),
        });
        return fn(tx);
      });
      linkFindMany.mockResolvedValue([]);

      const result = await applyNestedReminderPackages({
        userId: USER,
        actor: ACTOR,
        employees: [ACTOR],
        packages: [
          {
            itemId: ITEM_A,
            ownerEmployeeId: ACTOR.id,
            listType: "tasks",
            itemLabel: "תור לווטרינר",
            reminds: [{ date: "2026-11-10", time: "09:00", ping: ["טל"] }],
            nestedCompensate: { kind: "soft_delete_item" },
          },
        ],
      });

      expect(transaction).toHaveBeenCalled();
      expect(reminderCreate).toHaveBeenCalled();
      expect(linkCreate).toHaveBeenCalledWith({
        data: { listItemId: ITEM_A, reminderId: REM_1 },
      });
      expect(result.saved).toHaveLength(1);
      expect(result.saved[0]?.requestedItemId).toBe(ITEM_A);
      expect(result.failedItemIds).toEqual([]);
      expect(itemUpdate).not.toHaveBeenCalled();
    });

    it("on txn failure soft-deletes the new item (no partial success)", async () => {
      transaction.mockRejectedValue(new Error("boom"));
      itemUpdate.mockResolvedValue({});

      const result = await applyNestedReminderPackages({
        userId: USER,
        actor: ACTOR,
        employees: [ACTOR],
        packages: [
          {
            itemId: ITEM_A,
            ownerEmployeeId: ACTOR.id,
            listType: "tasks",
            itemLabel: "תור",
            reminds: [{ date: "2026-11-10", time: "09:00" }],
            nestedCompensate: { kind: "soft_delete_item" },
          },
        ],
      });

      expect(result.saved).toHaveLength(0);
      expect(result.failedItemIds).toEqual([ITEM_A]);
      expect(itemUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: ITEM_A },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });

    it("on txn failure restores prior update snapshot", async () => {
      transaction.mockRejectedValue(new Error("boom"));
      itemUpdate.mockResolvedValue({});
      const prior = { "שם מטלה": "ישן" };

      await applyNestedReminderPackages({
        userId: USER,
        actor: ACTOR,
        employees: [ACTOR],
        packages: [
          {
            itemId: ITEM_A,
            ownerEmployeeId: ACTOR.id,
            listType: "tasks",
            itemLabel: "תור",
            reminds: [{ date: "2026-11-10", time: "09:00" }],
            nestedCompensate: {
              kind: "restore_data",
              data: prior,
              itemKey: "ישן",
              urgency: "normal",
            },
          },
        ],
      });

      expect(itemUpdate).toHaveBeenCalledWith({
        where: { id: ITEM_A },
        data: {
          data: prior,
          itemKey: "ישן",
          urgency: "normal",
        },
      });
    });
  });

  describe("retry + no-steal", () => {
    it("reuses active clock with same fingerprint and does not create", async () => {
      const fireAt = ymdHm(2026, 11, 10, 9, 0);
      // Empty ping → resolve falls back to actor id; DB must store the same.
      linkFindMany.mockResolvedValue([{ reminderId: REM_1, listItemId: ITEM_A }]);
      reminderFindMany.mockResolvedValue([
        {
          id: REM_1,
          fireAt,
          itemLabel: "תור לווטרינר",
          listType: "tasks",
          messageText: "",
          composeAtFire: false,
          composeSource: "",
          composePlace: "",
          pingIds: [ACTOR.id],
          recurrence: null,
          status: "active",
        },
      ]);
      linkFindUnique.mockResolvedValue({ listItemId: ITEM_A });
      transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          reminder: { create: reminderCreate },
          employeeListItemReminderLink: {
            create: linkCreate,
            findUnique: linkFindUnique,
          },
        };
        return fn(tx);
      });

      const result = await applyNestedReminderPackages({
        userId: USER,
        actor: ACTOR,
        employees: [ACTOR],
        packages: [
          {
            itemId: ITEM_A,
            ownerEmployeeId: ACTOR.id,
            listType: "tasks",
            itemLabel: "תור לווטרינר",
            reminds: [{ date: "2026-11-10", time: "09:00", text: "" }],
          },
        ],
      });

      expect(reminderCreate).not.toHaveBeenCalled();
      expect(result.saved[0]?.id).toBe(REM_1);
    });

    it("refuses to steal join owned by another item", async () => {
      const fireAt = ymdHm(2026, 11, 10, 9, 0);
      linkFindMany.mockResolvedValue([{ reminderId: REM_1, listItemId: ITEM_A }]);
      reminderFindMany.mockResolvedValue([
        {
          id: REM_1,
          fireAt,
          itemLabel: "תור",
          listType: "tasks",
          messageText: "",
          composeAtFire: false,
          composeSource: "",
          composePlace: "",
          pingIds: [ACTOR.id],
          recurrence: null,
          status: "active",
        },
      ]);
      // Inconsistent join owner → refuse_steal inside txn.
      linkFindUnique.mockResolvedValue({ listItemId: ITEM_B });
      itemUpdate.mockResolvedValue({});
      transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          reminder: { create: reminderCreate },
          employeeListItemReminderLink: {
            create: linkCreate,
            findUnique: linkFindUnique,
          },
        };
        return fn(tx);
      });

      const result = await applyNestedReminderPackages({
        userId: USER,
        actor: ACTOR,
        employees: [ACTOR],
        packages: [
          {
            itemId: ITEM_A,
            ownerEmployeeId: ACTOR.id,
            listType: "tasks",
            itemLabel: "תור",
            reminds: [{ date: "2026-11-10", time: "09:00", text: "" }],
            nestedCompensate: { kind: "soft_delete_item" },
          },
        ],
      });

      expect(result.failedItemIds).toContain(ITEM_A);
      expect(reminderCreate).not.toHaveBeenCalled();
    });
  });

  describe("dual-path dedup + soft-link exclusion", () => {
    it("filters top-level duplicate with same fingerprint as nested", () => {
      const fireAt = ymdHm(2026, 11, 10, 9, 0);
      const nestedAction = reminderActionFromNestedRemind(
        { date: "2026-11-10", time: "09:00", text: "תזכורת", ping: ["טל"] },
        { itemLabel: "תור", listType: "tasks", itemId: ITEM_A },
      )!;
      const fp = fingerprintFromReminderAction({
        itemId: ITEM_A,
        reminder: nestedAction,
        fireAt,
        hasExplicitTime: true,
        pingKeys: [ACTOR.id],
      })!;
      const topLevel = [
        {
          ...nestedAction,
          itemId: ITEM_A,
        },
        {
          ...nestedAction,
          itemId: ITEM_A,
          time: "18:00",
          text: "ערב",
        },
      ];
      const filtered = filterTopLevelRemindersAgainstNested({
        topLevel,
        nestedSaved: [
          {
            id: REM_1,
            item: "תור",
            itemKey: "תור",
            itemLabel: "תור",
            fireAt: "2026-11-10 09:00",
            requestedItemId: ITEM_A,
          },
        ],
        nestedFingerprints: new Map([[REM_1, fp]]),
        nestedItemIds: [ITEM_A],
        employees: [ACTOR],
        actorId: ACTOR.id,
        // now must be before the scheduled fire or resolveReminderFireAt rolls forward.
        now: ymdHm(2026, 11, 9, 8, 0),
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.time).toBe("18:00");
    });

    it("excludes nested item ids from exact-key candidates", () => {
      const items = [
        { id: ITEM_A, itemKey: "a", itemLabel: "a" },
        { id: ITEM_B, itemKey: "b", itemLabel: "b" },
      ];
      expect(
        excludeNestedItemsFromSoftLinkCandidates(items, [ITEM_A]).map((r) => r.id),
      ).toEqual([ITEM_B]);
    });

    it("two intentional clocks keep different fingerprints", () => {
      const morning = buildReminderClockFingerprint({
        itemId: ITEM_A,
        resolvedFireAt: ymdHm(2026, 11, 10, 9, 0),
        hasExplicitTime: true,
        inSeconds: null,
        recurrence: null,
        ping: ["טל"],
        messageText: "בוקר",
        compose: false,
        composeSource: "",
        composeMeta: "",
      });
      const evening = buildReminderClockFingerprint({
        itemId: ITEM_A,
        resolvedFireAt: ymdHm(2026, 11, 10, 18, 0),
        hasExplicitTime: true,
        inSeconds: null,
        recurrence: null,
        ping: ["טל"],
        messageText: "ערב",
        compose: false,
        composeSource: "",
        composeMeta: "",
      });
      expect(morning).not.toBe(evening);
    });
  });

  describe("cascade — join cleanup on reminder cancel", () => {
    it("removeReminderAndLinkedWorkerTask deletes join rows", async () => {
      await removeReminderAndLinkedWorkerTask({
        id: REM_1,
        userId: USER,
        label: "תור",
      });
      expect(linkDeleteMany).toHaveBeenCalledWith({
        where: { reminderId: REM_1 },
      });
      expect(reminderUpdate).toHaveBeenCalledWith({
        where: { id: REM_1 },
        data: { status: "cancelled", workerItemId: null },
      });
    });
  });
});
