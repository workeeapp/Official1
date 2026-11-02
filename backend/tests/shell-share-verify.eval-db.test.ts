/**
 * Focused verification for uniform shopping shell share (no product changes).
 *
 * Proves partner snapshot access from shell vs explicit item co-share,
 * clear→add inherit, and backward-compat item share when shell is personal.
 *
 * Run: npm run test:eval-db -- tests/shell-share-verify.eval-db.test.ts
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { emptyLlmMetadata, type LlmMetadata } from "@workee/shared";
import {
  applyEmployeeRecords,
  getEmployeeRecordSnapshot,
  loadListItemOwners,
  readItemId,
  type EmployeeRecordSnapshot,
} from "../src/services/employee-records.service.js";
import {
  planTargetedActions,
  type SharedListRef,
} from "../src/services/employee-targets.service.js";
import { applyListOps } from "../src/services/list-ops.service.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { prisma } from "../src/database/prisma.js";

const SPEAKER = "טל";
const PARTNER = "עמית";

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  const u = new URL(process.env.DATABASE_URL!);
  expect(u.pathname.replace(/^\//, "").split("/")[0]).toBe("workee_test");
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
});

/** Mirrors chat.service listSharedCustomListsForActor (shopping/tasks/custom). */
async function loadSharedListsForActor(
  actorId: string,
): Promise<SharedListRef[]> {
  const rows = await prisma.employeeList.findMany({
    where: {
      listType: { in: ["custom", "shopping", "tasks"] },
      deletedAt: null,
      employee: { kind: "human" },
      OR: [{ employeeId: actorId }, { scope: "shared" }],
    },
    select: {
      employeeId: true,
      name: true,
      listType: true,
      visibleTo: true,
      scope: true,
    },
  });
  return rows
    .map((row) => {
      const visibleTo = Array.isArray(row.visibleTo)
        ? row.visibleTo.filter((id): id is string => typeof id === "string")
        : [];
      const scope = row.scope === "shared" ? "shared" : "personal";
      return {
        ownerId: row.employeeId,
        listName: row.name,
        listType: row.listType,
        visibleTo: [...new Set([row.employeeId, ...visibleTo])],
        scope: scope as "personal" | "shared",
      };
    })
    .filter((row) => {
      const builtin = row.listType === "shopping" || row.listType === "tasks";
      const namedOk = builtin || Boolean(row.listName.trim());
      return (
        namedOk &&
        (row.ownerId === actorId ||
          (row.scope === "shared" && row.visibleTo.includes(actorId)))
      );
    });
}

function shoppingTitles(snap: EmployeeRecordSnapshot): string[] {
  const out: string[] = [];
  for (const list of snap.lists) {
    if (list.list_type !== "shopping") {
      continue;
    }
    for (const item of list.items) {
      const title = String(
        (item as Record<string, unknown>)["שם פריט"] ?? "",
      ).trim();
      if (title) {
        out.push(title);
      }
    }
  }
  return out;
}

function shoppingListMeta(snap: EmployeeRecordSnapshot): Array<{
  scope: string;
  shared_with?: unknown;
  titles: string[];
}> {
  return snap.lists
    .filter((list) => list.list_type === "shopping")
    .map((list) => ({
      scope: String(list.scope ?? ""),
      shared_with: list.shared_with,
      titles: list.items.map((item) =>
        String((item as Record<string, unknown>)["שם פריט"] ?? "").trim(),
      ),
    }));
}

async function applyLists(
  account: HarnessAccount,
  metadata: LlmMetadata,
  sharedLists: SharedListRef[] = [],
) {
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
    sharedLists,
  });
  for (const application of plan.applications) {
    await applyEmployeeRecords(
      application.employeeId,
      application.metadata,
      application.visibility,
      account.actor.id,
    );
  }
  return plan;
}

async function shoppingListId(ownerId: string): Promise<string> {
  const row = await prisma.employeeList.findFirst({
    where: {
      employeeId: ownerId,
      listType: "shopping",
      deletedAt: null,
    },
    select: { id: true, scope: true, visibleTo: true },
  });
  expect(row?.id).toBeTruthy();
  return row!.id;
}

async function findShoppingItemByTitle(listId: string, title: string) {
  const rows = await prisma.employeeListItem.findMany({
    where: { listId, deletedAt: null },
  });
  return (
    rows.find((row) => {
      const data = row.data as Record<string, unknown>;
      return String(data["שם פריט"] ?? "").trim() === title;
    }) ?? null
  );
}

describe("shell share verify (eval-db)", () => {
  let account: HarnessAccount | null = null;

  afterEach(async () => {
    if (account) {
      await destroyHarnessAccount(account);
      account = null;
    }
  });

  it("1+3: shell unshare drops shell-derived access; keeps explicit item co-share", async () => {
    account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
    const partner = account.partners[0]!;

    // Explicit item co-share while shell is still personal.
    await applyLists(account, {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          targets: [SPEAKER, PARTNER],
          items: [{ "שם פריט": "חלב-מפורש" }],
        },
      ],
    });

    const listId = await shoppingListId(account.employeeId);
    const explicitRow = await findShoppingItemByTitle(listId, "חלב-מפורש");
    expect(explicitRow).toBeTruthy();
    const explicitVisible = Array.isArray(explicitRow!.visibleTo)
      ? (explicitRow!.visibleTo as string[])
      : [];
    expect(explicitVisible).toEqual(
      expect.arrayContaining([account.employeeId, partner.id]),
    );

    // Shell share with partner.
    const [shareOp] = await applyListOps({
      userId: account.userId,
      actor: account.actor,
      employees: account.employees,
      ops: [
        {
          action: "alter_list",
          listId,
          listType: "shopping",
          listName: "",
          newName: "",
          addColumns: [],
          removeColumns: [],
          renameColumns: [],
          addParticipants: [PARTNER],
          removeParticipants: [],
        },
      ],
    });
    expect(shareOp.applied).toBe(true);

    const shellAfterShare = await prisma.employeeList.findUniqueOrThrow({
      where: { id: listId },
    });
    expect(shellAfterShare.scope).toBe("shared");
    expect(shellAfterShare.visibleTo).toEqual(
      expect.arrayContaining([account.employeeId, partner.id]),
    );

    // Shell-derived item (empty targets) while shell is shared.
    const sharedLists = await loadSharedListsForActor(account.employeeId);
    await applyLists(
      account,
      {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            targets: [],
            items: [{ "שם פריט": "לחם-מעטפת" }],
          },
        ],
      },
      sharedLists,
    );

    const shellItem = await findShoppingItemByTitle(listId, "לחם-מעטפת");
    expect(shellItem).toBeTruthy();
    const shellItemVisible = Array.isArray(shellItem!.visibleTo)
      ? (shellItem!.visibleTo as string[])
      : [];
    // Proof of permission source: shell-derived row is owner-only at item level.
    expect(shellItemVisible).toEqual([account.employeeId]);
    expect(shellItemVisible).not.toContain(partner.id);

    const partnerBefore = await getEmployeeRecordSnapshot(partner.id);
    const titlesBefore = shoppingTitles(partnerBefore);
    expect(titlesBefore).toContain("לחם-מעטפת");
    expect(titlesBefore).toContain("חלב-מפורש");
    const metaBefore = shoppingListMeta(partnerBefore);
    // Shell-derived arrives via scope=shared partner list.
    expect(
      metaBefore.some(
        (row) =>
          row.scope === "shared" && row.titles.includes("לחם-מעטפת"),
      ),
    ).toBe(true);

    // Unshare shell.
    const [unshareOp] = await applyListOps({
      userId: account.userId,
      actor: account.actor,
      employees: account.employees,
      ops: [
        {
          action: "alter_list",
          listId,
          listType: "shopping",
          listName: "",
          newName: "",
          addColumns: [],
          removeColumns: [],
          renameColumns: [],
          addParticipants: [],
          removeParticipants: [PARTNER],
        },
      ],
    });
    expect(unshareOp.applied).toBe(true);

    const shellAfterUnshare = await prisma.employeeList.findUniqueOrThrow({
      where: { id: listId },
    });
    expect(shellAfterUnshare.scope).toBe("personal");
    expect(shellAfterUnshare.visibleTo).toEqual([]);

    // Explicit item visibleTo unchanged after shell unshare.
    const explicitAfter = await prisma.employeeListItem.findUniqueOrThrow({
      where: { id: explicitRow!.id },
    });
    expect(explicitAfter.visibleTo).toEqual(
      expect.arrayContaining([account.employeeId, partner.id]),
    );
    const shellItemAfter = await prisma.employeeListItem.findUniqueOrThrow({
      where: { id: shellItem!.id },
    });
    expect(shellItemAfter.visibleTo).toEqual([account.employeeId]);

    const partnerAfter = await getEmployeeRecordSnapshot(partner.id);
    const titlesAfter = shoppingTitles(partnerAfter);
    // Shell-derived gone from partner snapshot; explicit item-share remains.
    expect(titlesAfter).not.toContain("לחם-מעטפת");
    expect(titlesAfter).toContain("חלב-מפורש");
  });

  it("2: share shell → clear → add without targets → partner sees new item", async () => {
    account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
    const partner = account.partners[0]!;

    await applyLists(account, {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          targets: [],
          items: [{ "שם פריט": "ישן-לניקוי" }],
        },
      ],
    });
    const listId = await shoppingListId(account.employeeId);

    const [shareOp] = await applyListOps({
      userId: account.userId,
      actor: account.actor,
      employees: account.employees,
      ops: [
        {
          action: "alter_list",
          listId,
          listType: "shopping",
          listName: "",
          newName: "",
          addColumns: [],
          removeColumns: [],
          renameColumns: [],
          addParticipants: [PARTNER],
          removeParticipants: [],
        },
      ],
    });
    expect(shareOp.applied).toBe(true);

    const [clearOp] = await applyListOps({
      userId: account.userId,
      actor: account.actor,
      employees: account.employees,
      ops: [
        {
          action: "delete_list",
          listId,
          listType: "shopping",
          listName: "",
          newName: "",
          addColumns: [],
          removeColumns: [],
          renameColumns: [],
          addParticipants: [],
          removeParticipants: [],
        },
      ],
    });
    expect(clearOp.applied).toBe(true);
    expect(clearOp.cleared).toBe(true);

    const shellAfterClear = await prisma.employeeList.findUniqueOrThrow({
      where: { id: listId },
    });
    expect(shellAfterClear.scope).toBe("shared");
    expect(shellAfterClear.visibleTo).toEqual(
      expect.arrayContaining([account.employeeId, partner.id]),
    );
    const liveCount = await prisma.employeeListItem.count({
      where: { listId, deletedAt: null },
    });
    expect(liveCount).toBe(0);

    const sharedLists = await loadSharedListsForActor(account.employeeId);
    await applyLists(
      account,
      {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            targets: [],
            items: [{ "שם פריט": "חדש-אחרי-ניקוי" }],
          },
        ],
      },
      sharedLists,
    );

    const ownerSnap = await getEmployeeRecordSnapshot(account.employeeId);
    const partnerSnap = await getEmployeeRecordSnapshot(partner.id);
    expect(shoppingTitles(ownerSnap)).toContain("חדש-אחרי-ניקוי");
    expect(shoppingTitles(partnerSnap)).toContain("חדש-אחרי-ניקוי");

    const newRow = await findShoppingItemByTitle(listId, "חדש-אחרי-ניקוי");
    expect(newRow).toBeTruthy();
    expect(newRow!.visibleTo).toEqual([account.employeeId]);
  });

  it("3: personal shell + direct item share stays visible to partner", async () => {
    account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
    const partner = account.partners[0]!;

    await applyLists(account, {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          targets: [SPEAKER, PARTNER],
          items: [{ "שם פריט": "רק-פריט" }],
        },
      ],
    });

    const listId = await shoppingListId(account.employeeId);
    const shell = await prisma.employeeList.findUniqueOrThrow({
      where: { id: listId },
    });
    expect(shell.scope).toBe("personal");

    const partnerSnap = await getEmployeeRecordSnapshot(partner.id);
    expect(shoppingTitles(partnerSnap)).toContain("רק-פריט");
    // Not via shared shell — item-level path (shared_items / merged into own).
    const sharedShell = shoppingListMeta(partnerSnap).find(
      (row) => row.scope === "shared",
    );
    expect(sharedShell?.titles.includes("רק-פריט") ?? false).toBe(false);
  });
});
