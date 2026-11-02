/**
 * Prove ListItemMutation.calendarYmd comes from DB row data
 * (post-save add/update; pre-delete remove).
 *
 * Run: npm run test:eval-db -- tests/dated-day-show-mutation.eval-db.test.ts
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { emptyLlmMetadata, type LlmMetadata } from "@workee/shared";
import {
  applyEmployeeRecords,
  calendarYmdFromItemData,
  loadListItemOwners,
  readItemId,
} from "../src/services/employee-records.service.js";
import { planTargetedActions } from "../src/services/employee-targets.service.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { prisma } from "../src/database/prisma.js";
import { jerusalemYmd } from "../src/utils/relative-date.js";

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  const u = new URL(process.env.DATABASE_URL!);
  expect(u.pathname.replace(/^\//, "").split("/")[0]).toBe("workee_test");
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
});

async function applyLists(account: HarnessAccount, metadata: LlmMetadata) {
  const itemIds = (metadata.lists ?? []).flatMap((list) =>
    list.items
      .map((raw) => readItemId(raw as Record<string, unknown>))
      .filter(Boolean),
  );
  const itemOwners = await loadListItemOwners(account.userId, itemIds);
  const plan = planTargetedActions({
    actor: account.actor,
    employees: account.employees,
    metadata,
    itemOwners,
  });
  const mutations = [];
  for (const application of plan.applications) {
    const applied = await applyEmployeeRecords(
      application.employeeId,
      application.metadata,
      application.visibility,
      account.actor.id,
    );
    mutations.push(...applied.mutations);
  }
  return mutations;
}

describe("dated day-show mutation calendarYmd (eval-db)", () => {
  let account: HarnessAccount | null = null;
  const today = jerusalemYmd();
  const tomorrow = (() => {
    const [y, m, d] = today.split("-").map(Number);
    const dt = new Date(Date.UTC(y!, m! - 1, d! + 1));
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  })();
  const dayAfter = (() => {
    const [y, m, d] = today.split("-").map(Number);
    const dt = new Date(Date.UTC(y!, m! - 1, d! + 2));
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  })();

  afterEach(async () => {
    if (account) {
      await destroyHarnessAccount(account);
      account = null;
    }
  });

  it("add/update/remove: mutation.calendarYmd matches DB field", async () => {
    account = await createHarnessAccount("טל");

    const added = await applyLists(account, {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add",
          listType: "tasks",
          listName: "",
          targets: [],
          items: [
            {
              "שם מטלה": "פגישה-יום",
              "תאריך לביצוע": tomorrow,
            },
          ],
        },
      ],
    });
    expect(added).toHaveLength(1);
    expect(added[0]!.calendarYmd).toBe(tomorrow);
    const row = await prisma.employeeListItem.findUniqueOrThrow({
      where: { id: added[0]!.itemId },
    });
    expect(calendarYmdFromItemData(row.data as Record<string, unknown>)).toBe(
      tomorrow,
    );
    expect(added[0]!.calendarYmd).toBe(
      calendarYmdFromItemData(row.data as Record<string, unknown>),
    );

    const updated = await applyLists(account, {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "update",
          listType: "tasks",
          listName: "",
          targets: [],
          items: [
            {
              item_id: added[0]!.itemId,
              "תאריך לביצוע": dayAfter,
            },
          ],
        },
      ],
    });
    expect(updated).toHaveLength(1);
    expect(updated[0]!.calendarYmd).toBe(dayAfter);
    const afterUpdate = await prisma.employeeListItem.findUniqueOrThrow({
      where: { id: added[0]!.itemId },
    });
    expect(
      calendarYmdFromItemData(afterUpdate.data as Record<string, unknown>),
    ).toBe(dayAfter);

    const removed = await applyLists(account, {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "remove",
          listType: "tasks",
          listName: "",
          targets: [],
          items: [{ item_id: added[0]!.itemId }],
        },
      ],
    });
    expect(removed).toHaveLength(1);
    expect(removed[0]!.calendarYmd).toBe(dayAfter);
    const soft = await prisma.employeeListItem.findUniqueOrThrow({
      where: { id: added[0]!.itemId },
    });
    expect(soft.deletedAt).not.toBeNull();
    // Soft-deleted row still holds the date payload we captured before delete.
    expect(calendarYmdFromItemData(soft.data as Record<string, unknown>)).toBe(
      dayAfter,
    );
  });

  it("shopping dated add carries calendarYmd from DB", async () => {
    account = await createHarnessAccount("טל");
    const added = await applyLists(account, {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          targets: [],
          items: [
            {
              "שם פריט": "חלב-יום",
              "תאריך לביצוע": tomorrow,
            },
          ],
        },
      ],
    });
    expect(added[0]!.calendarYmd).toBe(tomorrow);
    const row = await prisma.employeeListItem.findUniqueOrThrow({
      where: { id: added[0]!.itemId },
    });
    expect(calendarYmdFromItemData(row.data as Record<string, unknown>)).toBe(
      tomorrow,
    );
  });

  it("custom dated add carries calendarYmd + listName from DB", async () => {
    account = await createHarnessAccount("טל");
    const listName = "אירוע משפחתי";
    const added = await applyLists(account, {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add",
          listType: "custom",
          listName,
          targets: [],
          items: [
            {
              שם: "עוגה",
              "תאריך לביצוע": tomorrow,
            },
          ],
        },
      ],
    });
    const itemMut = added.filter((row) => !row.listShell);
    expect(itemMut.length).toBeGreaterThanOrEqual(1);
    expect(itemMut[0]!.calendarYmd).toBe(tomorrow);
    expect(itemMut[0]!.listName).toBe(listName);
    const row = await prisma.employeeListItem.findUniqueOrThrow({
      where: { id: itemMut[0]!.itemId },
    });
    expect(calendarYmdFromItemData(row.data as Record<string, unknown>)).toBe(
      tomorrow,
    );
  });

  it("undated add has no calendarYmd", async () => {
    account = await createHarnessAccount("טל");
    const added = await applyLists(account, {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add",
          listType: "tasks",
          listName: "",
          targets: [],
          items: [{ "שם מטלה": "בלי-תאריך" }],
        },
      ],
    });
    expect(added[0]!.calendarYmd).toBeUndefined();
  });
});
