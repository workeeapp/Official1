import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmListOp, PublicEmployee } from "@workee/shared";

const {
  listFindFirst,
  listUpdate,
  itemUpdate,
  itemUpdateMany,
  recordAuditEvent,
  cancelReminderLinkedToWorkerItem,
  cancelActiveRemindersMatchingWork,
} = vi.hoisted(() => ({
  listFindFirst: vi.fn(),
  listUpdate: vi.fn(),
  itemUpdate: vi.fn(),
  itemUpdateMany: vi.fn(),
  recordAuditEvent: vi.fn(),
  cancelReminderLinkedToWorkerItem: vi.fn(),
  cancelActiveRemindersMatchingWork: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => {
  const prisma = {
    employeeList: { findFirst: listFindFirst, update: listUpdate },
    employeeListItem: { update: itemUpdate, updateMany: itemUpdateMany },
    $transaction: (run: (tx: unknown) => Promise<unknown>) => run(prisma),
  };
  return { prisma };
});

vi.mock("../src/services/audit.service.js", () => ({ recordAuditEvent }));

vi.mock("../src/services/reminder.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/reminder.service.js")>()),
  cancelReminderLinkedToWorkerItem,
  cancelActiveRemindersMatchingWork,
}));

import {
  applyListOps,
  formatListOpFallback,
  formatListOpRefusals,
} from "../src/services/list-ops.service.js";

const amitId = "415ff13e-38d0-4dee-98b5-71e5dd11a38d";
const talId = "4cded1a2-c4c1-4edc-9d87-fe5ac740c1f4";
const listId = "9b2f6c1e-2d6a-4a7b-9c3e-1f0a2b3c4d5e";

function person(id: string, name: string, extra: Partial<PublicEmployee> = {}): PublicEmployee {
  return {
    id,
    kind: "human",
    name,
    surname: "",
    nickname: null,
    email: null,
    phone: null,
    ...extra,
  };
}

const amit = person(amitId, "עמית");
const tal = person(talId, "טל");

function op(fields: Partial<LlmListOp>): LlmListOp {
  return {
    action: "alter_list",
    listId,
    newName: "",
    addColumns: [],
    removeColumns: [],
    renameColumns: [],
    addParticipants: [],
    removeParticipants: [],
    ...fields,
  };
}

function bugsList(extra: Record<string, unknown> = {}) {
  return {
    id: listId,
    employeeId: amitId,
    listType: "custom",
    name: "בעיות",
    titleField: "שם הבאג",
    columns: ["שם הבאג", "סטטוס", "עיר"],
    hiddenColumns: [],
    scope: "shared",
    visibleTo: [amitId, talId],
    employee: { id: amitId, kind: "human" },
    items: [
      {
        id: "bug-1",
        itemKey: "כפתור שבור",
        data: { "שם הבאג": "כפתור שבור", סטטוס: "פתוח", עיר: "תל אביב" },
        visibleTo: [amitId, talId],
      },
    ],
    ...extra,
  };
}

async function run(ops: LlmListOp[], actor = amit) {
  return applyListOps({ userId: "user-1", actor, employees: [amit, tal], ops });
}

describe("list ops", () => {
  beforeEach(() => {
    listFindFirst.mockReset().mockResolvedValue(null);
    listUpdate.mockReset().mockResolvedValue({});
    itemUpdate.mockReset().mockResolvedValue({});
    itemUpdateMany.mockReset().mockResolvedValue({ count: 0 });
    recordAuditEvent.mockReset();
    cancelReminderLinkedToWorkerItem.mockReset().mockResolvedValue(undefined);
    cancelActiveRemindersMatchingWork
      .mockReset()
      .mockResolvedValue({ cancelledReminders: [], removedWorkerTasks: [] });
  });

  it("applies rename, column changes, and the new list name in one alter_list", async () => {
    listFindFirst.mockResolvedValueOnce(bugsList()).mockResolvedValueOnce(null);

    const [result] = await run([
      op({
        newName: "באגים",
        renameColumns: [{ from: "סטטוס", to: "מצב" }],
        removeColumns: ["עיר"],
        addColumns: ["עדיפות"],
      }),
    ]);

    expect(result).toMatchObject({ applied: true, listLabel: "באגים" });
    expect(listUpdate).toHaveBeenCalledWith({
      where: { id: listId },
      data: {
        name: "באגים",
        columns: ["שם הבאג", "מצב", "עדיפות"],
        hiddenColumns: ["עיר"],
        titleField: "שם הבאג",
      },
    });
    // Removed column value stays in the row (hidden), renamed key keeps its value.
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "bug-1" },
      data: { data: { "שם הבאג": "כפתור שבור", מצב: "פתוח", עיר: "תל אביב" } },
    });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "list_alter", entityId: listId }),
    );
    expect(result.notices).toEqual([
      {
        employeeId: talId,
        text: expect.stringContaining("«עמית» עדכן את הרשימה «בעיות»"),
      },
    ]);
  });

  it("follows a renamed title column", async () => {
    listFindFirst.mockResolvedValueOnce(bugsList());

    await run([op({ renameColumns: [{ from: "שם הבאג", to: "כותרת" }] })]);

    expect(listUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ titleField: "כותרת" }),
      }),
    );
  });

  it("refuses the whole alter_list when one part is invalid", async () => {
    listFindFirst.mockResolvedValueOnce(bugsList());

    const [result] = await run([
      op({ newName: "באגים", removeColumns: ["שם הבאג"] }),
    ]);

    expect(result.applied).toBe(false);
    expect(result.refusal).toEqual({ reason: "title_column", detail: "שם הבאג" });
    expect(listUpdate).not.toHaveBeenCalled();
    expect(itemUpdate).not.toHaveBeenCalled();
    expect(formatListOpRefusals([result])).toBe(
      "אי אפשר להסיר את העמודה «שם הבאג» — היא מזהה כל שורה ברשימה. לא שיניתי את הרשימה.",
    );
  });

  it("refuses a rename onto another live list's name", async () => {
    listFindFirst
      .mockResolvedValueOnce(bugsList())
      .mockResolvedValueOnce({ id: "other-list" });

    const [result] = await run([op({ newName: "חנויות" })]);

    expect(result.refusal).toEqual({ reason: "name_taken", detail: "חנויות" });
    expect(listFindFirst).toHaveBeenLastCalledWith({
      where: {
        employeeId: amitId,
        listType: "custom",
        name: "חנויות",
        deletedAt: null,
        NOT: { id: listId },
      },
    });
    expect(listUpdate).not.toHaveBeenCalled();
  });

  it("allows only participant changes on a built-in list", async () => {
    listFindFirst.mockResolvedValue(
      bugsList({ listType: "shopping", name: "", titleField: "", columns: [] }),
    );

    const [renamed] = await run([op({ newName: "סופר" })]);
    expect(renamed.refusal?.reason).toBe("builtin");

    const [shared] = await run([op({ removeParticipants: ["טל"] })]);
    expect(shared.applied).toBe(true);
  });

  it("removes a participant from the list and from its rows", async () => {
    listFindFirst.mockResolvedValueOnce(bugsList());

    const [result] = await run([op({ removeParticipants: ["טל"] })]);

    expect(listUpdate).toHaveBeenCalledWith({
      where: { id: listId },
      data: { scope: "personal", visibleTo: [] },
    });
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "bug-1" },
      data: { visibleTo: [amitId] },
    });
    expect(result.notices.map((row) => row.employeeId)).toEqual([talId]);
  });

  it("adds a partner to a shared list and tells every other partner who joined", async () => {
    const eranId = "5964b8b8-9ff1-4173-b50f-fb4e436b7cca";
    const eran = person(eranId, "ערן");
    listFindFirst.mockResolvedValueOnce(
      bugsList({ name: "באגים", visibleTo: [amitId, eranId], items: [] }),
    );

    const [result] = await applyListOps({
      userId: "user-1",
      actor: amit,
      employees: [amit, tal, eran],
      ops: [op({ addParticipants: ["טל"] })],
    });

    expect(listUpdate).toHaveBeenCalledWith({
      where: { id: listId },
      data: { scope: "shared", visibleTo: [amitId, eranId, talId] },
    });
    expect(result.notices).toEqual([
      { employeeId: eranId, text: "עמית שיתף את רשימת «באגים» עם «טל»" },
      { employeeId: talId, text: "עמית שיתף את רשימת «באגים» עם «טל»" },
    ]);
  });

  it("refuses an unknown participant without writing", async () => {
    listFindFirst.mockResolvedValueOnce(bugsList());

    const [result] = await run([op({ addParticipants: ["מישהו"] })]);

    expect(result.refusal).toEqual({ reason: "unknown_participant", detail: "מישהו" });
    expect(listUpdate).not.toHaveBeenCalled();
  });

  it("refuses an empty alter_list", async () => {
    listFindFirst.mockResolvedValueOnce(bugsList());

    const [result] = await run([op({})]);

    expect(result.refusal?.reason).toBe("empty");
  });

  it("lets only the owner or an account owner change the list", async () => {
    listFindFirst.mockResolvedValueOnce(bugsList());

    const [partner] = await run([op({ newName: "באגים" })], tal);
    expect(partner.refusal?.reason).toBe("not_owner");

    listFindFirst.mockResolvedValueOnce(bugsList()).mockResolvedValueOnce(null);
    const [accountOwner] = await run(
      [op({ newName: "באגים" })],
      person(talId, "טל", { isOwner: true }),
    );
    expect(accountOwner.applied).toBe(true);
  });

  it("deletes a custom list, its rows, and their linked clocks", async () => {
    listFindFirst.mockResolvedValueOnce(bugsList());

    const [result] = await run([op({ action: "delete_list" })]);

    expect(cancelReminderLinkedToWorkerItem).toHaveBeenCalledWith("bug-1");
    expect(itemUpdateMany).toHaveBeenCalledWith({
      where: { listId, deletedAt: null },
      data: { deletedAt: expect.any(Date), reminderId: null },
    });
    expect(listUpdate).toHaveBeenCalledWith({
      where: { id: listId },
      data: { deletedAt: expect.any(Date) },
    });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "list_delete", entityId: listId }),
    );
    expect(result.notices).toEqual([
      { employeeId: talId, text: "«עמית» מחק את הרשימה «בעיות»." },
    ]);
    expect(formatListOpFallback([result])).toBe("מחקתי את הרשימה «בעיות».");
  });

  it("clears a built-in list instead of deleting it", async () => {
    listFindFirst.mockResolvedValueOnce(
      bugsList({ listType: "shopping", name: "", scope: "personal", visibleTo: [] }),
    );

    const [result] = await run([op({ action: "delete_list" })]);

    expect(result).toMatchObject({ applied: true, cleared: true, listLabel: "קניות" });
    expect(itemUpdateMany).toHaveBeenCalled();
    expect(listUpdate).not.toHaveBeenCalled();
    expect(formatListOpFallback([result])).toBe("ניקיתי את רשימת «קניות».");
  });

  it("treats a missing or malformed list_id as not found", async () => {
    const [malformed] = await run([op({ listId: "בעיות" })]);
    expect(malformed.refusal?.reason).toBe("not_found");
    expect(listFindFirst).not.toHaveBeenCalled();

    const [missing] = await run([op({ action: "delete_list" })]);
    expect(missing.refusal?.reason).toBe("not_found");
    expect(listFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: listId, deletedAt: null, employee: { userId: "user-1" } },
      }),
    );
    expect(formatListOpRefusals([missing])).toBe("לא מצאתי את הרשימה.");
  });
});
