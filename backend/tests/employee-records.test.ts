import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  listFindMany,
  listFindUnique,
  listCreate,
  listUpdate,
  itemFindMany,
  itemFindFirst,
  itemFindUnique,
  itemCreate,
  itemUpdate,
  itemUpdateMany,
  itemDelete,
  itemDeleteMany,
  filingFindMany,
  filingFindFirst,
  filingCreate,
  filingUpsert,
  filingUpdate,
  filingUpdateMany,
  filingDelete,
  filingDeleteMany,
  employeeFindMany,
  employeeFindUnique,
  reminderFindMany,
  reminderFindFirst,
  reminderUpdate,
  reminderDelete,
  auditCreate,
} = vi.hoisted(() => ({
  listFindMany: vi.fn(),
  listFindUnique: vi.fn(),
  listCreate: vi.fn(),
  listUpdate: vi.fn(),
  itemFindMany: vi.fn(),
  itemFindFirst: vi.fn(),
  itemFindUnique: vi.fn(),
  itemCreate: vi.fn(),
  itemUpdate: vi.fn(),
  itemUpdateMany: vi.fn(),
  itemDelete: vi.fn(),
  itemDeleteMany: vi.fn(),
  filingFindMany: vi.fn(),
  filingFindFirst: vi.fn(),
  filingCreate: vi.fn(),
  filingUpsert: vi.fn(),
  filingUpdate: vi.fn(),
  filingUpdateMany: vi.fn(),
  filingDelete: vi.fn(),
  filingDeleteMany: vi.fn(),
  employeeFindMany: vi.fn(),
  employeeFindUnique: vi.fn(),
  reminderFindMany: vi.fn(),
  reminderFindFirst: vi.fn(),
  reminderUpdate: vi.fn(),
  reminderDelete: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    employeeList: {
      findMany: listFindMany,
      findUnique: listFindUnique,
      create: listCreate,
      update: listUpdate,
    },
    employeeListItem: {
      findMany: itemFindMany,
      findFirst: itemFindFirst,
      findUnique: itemFindUnique,
      create: itemCreate,
      update: itemUpdate,
      updateMany: itemUpdateMany,
      delete: itemDelete,
      deleteMany: itemDeleteMany,
    },
    employeeFiling: {
      findMany: filingFindMany,
      findFirst: filingFindFirst,
      create: filingCreate,
      upsert: filingUpsert,
      update: filingUpdate,
      updateMany: filingUpdateMany,
      delete: filingDelete,
      deleteMany: filingDeleteMany,
    },
    employee: {
      findMany: employeeFindMany,
      findUnique: employeeFindUnique,
    },
    reminder: {
      findMany: reminderFindMany,
      findFirst: reminderFindFirst,
      update: reminderUpdate,
      delete: reminderDelete,
    },
    auditEvent: {
      create: auditCreate,
    },
  },
}));

vi.mock("../src/services/audit.service.js", () => ({
  recordAuditEvent: vi.fn(),
}));

import {
  alignSpokenListType,
  applyEmployeeMetadata,
  applyEmployeeRecords,
  chooseSavedListType,
  deleteEmployeeRecord,
  deriveCustomListName,
  formatAppliedMutationFallback,
  formatEmployeeContext,
  formatTeamSchedules,
  getEmployeeOwnedRecords,
  getEmployeeRecordSnapshot,
  getTeamSchedules,
  workerItemTiedToSpeaker,
  updateEmployeeRecord,
  itemIdentity,
  isPhantomCustomListItem,
  mergeListItemData,
  normalizeListItemData,
} from "../src/services/employee-records.service.js";

const talId = "4cded1a2-c4c1-4edc-9d87-fe5ac740c1f4";

const employeeId = "415ff13e-38d0-4dee-98b5-71e5dd11a38d";

describe("employee records", () => {
  beforeEach(() => {
    listFindMany.mockReset().mockResolvedValue([]);
    listFindUnique.mockReset();
    listCreate.mockReset();
    listUpdate.mockReset();
    itemFindMany.mockReset().mockResolvedValue([]);
    itemFindFirst.mockReset();
    itemFindUnique.mockReset();
    itemCreate.mockReset();
    itemUpdate.mockReset();
    itemUpdateMany.mockReset().mockResolvedValue({ count: 0 });
    itemDelete.mockReset();
    itemDeleteMany.mockReset();
    filingFindMany.mockReset().mockResolvedValue([]);
    filingFindFirst.mockReset().mockResolvedValue(null);
    filingCreate.mockReset();
    filingUpsert.mockReset();
    filingUpdate.mockReset();
    filingUpdateMany.mockReset().mockResolvedValue({ count: 0 });
    filingDelete.mockReset();
    filingDeleteMany.mockReset();
    employeeFindMany.mockReset().mockResolvedValue([]);
    employeeFindUnique.mockReset().mockResolvedValue({
      userId: "user-1",
      kind: "human",
      name: "טל",
      nickname: null,
      isOwner: false,
    });
    reminderFindMany.mockReset().mockResolvedValue([]);
    reminderFindFirst.mockReset().mockResolvedValue(null);
    reminderUpdate.mockReset();
    reminderDelete.mockReset();
    auditCreate.mockReset();
  });

  it("builds an identity key from Hebrew shopping and task fields", () => {
    expect(itemIdentity("shopping", { "שם פריט": "חלב", כמות: 1 })).toBe("חלב");
    expect(itemIdentity("tasks", { "שם מטלה": "לקנות מתנה" })).toBe("לקנות מתנה");
    expect(itemIdentity("custom", { "שם החנות": "אדידס" })).toBe("אדידס");
    expect(itemIdentity("custom", { brand: "פומה" })).toBe("פומה");
    expect(
      itemIdentity("contacts", { "שם פרטי": "דנה", "שם משפחה": "לוי" }),
    ).toBe("דנה|לוי");
  });

  it("collapses update-draft keys onto the real column", () => {
    expect(
      mergeListItemData(
        { שם: "להוריד את הגרסה" },
        { שם: "להוריד את הגרסה", "שם חדש": "לא להוריד את הגרסה" },
      ),
    ).toEqual({ שם: "לא להוריד את הגרסה" });
    expect(
      normalizeListItemData({
        שם: "ישן",
        "שם חדש": "חדש",
        הערה: "נשאר",
      }),
    ).toEqual({ שם: "חדש", הערה: "נשאר" });
    expect(
      mergeListItemData({ "שם מטלה": "ישן" }, { "שם מטלה חדש": "חדש" }),
    ).toEqual({ "שם מטלה": "חדש" });
  });

  it("on lists update, stores only the new name (not שם + שם חדש)", async () => {
    const list = {
      id: "bugs-list",
      employeeId: talId,
      listType: "custom",
      name: "באגים",
      scope: "shared",
      visibleTo: [talId, employeeId],
    };
    const stored = {
      id: "bug-1",
      itemKey: "להוריד את הגרסה",
      data: { שם: "להוריד את הגרסה" },
      scope: "shared",
      addedById: talId,
      visibleTo: [talId, employeeId],
      deletedAt: null,
    };
    listFindUnique.mockResolvedValue(list);
    itemFindMany.mockResolvedValue([stored]);
    itemFindFirst.mockResolvedValue(stored);
    itemUpdate.mockResolvedValue({ id: "bug-1" });

    await applyEmployeeMetadata(
      talId,
      {
        lists: [
          {
            action: "update",
            listType: "custom",
            listName: "באגים",
            items: [
              {
                item_id: "bug-1",
                שם: "להוריד את הגרסה",
                "שם חדש": "לא להוריד את הגרסה",
              },
            ],
            targets: [],
          },
        ],
        filing: [],
      },
      undefined,
      talId,
    );

    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "bug-1" },
      data: expect.objectContaining({
        itemKey: "לא להוריד את הגרסה",
        data: { שם: "לא להוריד את הגרסה" },
      }),
    });
  });

  it("snapshot hides leftover שם חדש draft keys", async () => {
    listFindMany.mockResolvedValue([
      {
        id: "bugs-list",
        employeeId: talId,
        listType: "custom",
        name: "באגים",
        scope: "shared",
        visibleTo: [talId, employeeId],
        employee: { id: talId, name: "טל", nickname: null },
        items: [
          {
            id: "bug-1",
            itemKey: "להוריד את הגרסה",
            data: {
              שם: "להוריד את הגרסה",
              "שם חדש": "לא להוריד את הגרסה",
            },
            scope: "shared",
            addedById: talId,
            visibleTo: [talId, employeeId],
          },
        ],
      },
    ]);
    employeeFindMany.mockResolvedValue([
      { id: talId, name: "טל", nickname: null },
      { id: employeeId, name: "עמית", nickname: null },
    ]);
    filingFindMany.mockResolvedValue([]);
    reminderFindMany.mockResolvedValue([]);

    const snapshot = await getEmployeeRecordSnapshot(talId);
    expect(snapshot.lists[0]?.items[0]).toEqual(
      expect.objectContaining({
        שם: "לא להוריד את הגרסה",
        scope: "shared",
        owner: "טל",
      }),
    );
    expect(snapshot.lists[0]?.items[0]).not.toHaveProperty("שם חדש");
  });

  it("guest snapshot excludes personal shopping and keeps shared partner lists", async () => {
    const guestId = "449eb6c9-14b8-44e4-b6d5-988bab53b396";
    employeeFindUnique.mockResolvedValue({
      userId: "user-1",
      kind: "human",
      name: "אורח",
      nickname: "מיכל",
      isOwner: false,
    });
    listFindMany
      .mockResolvedValueOnce([
        {
          id: "guest-shop",
          employeeId: guestId,
          listType: "shopping",
          name: "",
          scope: "personal",
          visibleTo: [],
          employee: { id: guestId, name: "אורח", nickname: "מיכל" },
          items: [
            {
              data: { "שם פריט": "ביצים" },
              scope: "personal",
              itemKey: "ביצים",
            },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "maya-lessons",
          employeeId: talId,
          listType: "custom",
          name: "שיעורי הנהיגה של מאיה",
          scope: "shared",
          visibleTo: [talId, guestId],
          employee: { id: talId, name: "טל", nickname: "טל" },
          items: [
            {
              data: { שם: "שיעור 1" },
              scope: "shared",
              itemKey: "שיעור 1",
            },
          ],
        },
      ]);
    itemFindMany.mockResolvedValue([]);
    employeeFindMany.mockResolvedValue([
      { id: guestId, name: "אורח", nickname: "מיכל" },
      { id: talId, name: "טל", nickname: "טל" },
    ]);
    filingFindMany.mockResolvedValue([]);
    reminderFindMany.mockResolvedValue([
      {
        id: "rem-1",
        ownerId: guestId,
        status: "active",
        item: "לקנות ביצים",
        pingIds: [guestId],
      },
    ]);

    const snapshot = await getEmployeeRecordSnapshot(guestId);
    expect(snapshot.lists).toEqual([
      expect.objectContaining({
        list_type: "custom",
        list_name: "שיעורי הנהיגה של מאיה",
        scope: "shared",
        owner: "טל",
      }),
    ]);
    expect(snapshot.lists.some((row) => row.list_type === "shopping")).toBe(
      false,
    );
    expect(snapshot.reminders).toEqual([]);
  });

  it("ignores list_name when identifying a custom row", () => {
    expect(
      itemIdentity("custom", {
        list_name: "בעיות",
        תיאור: "לבדוק שוב את הפונקציונליות",
      }),
    ).toBe("לבדוק שוב את הפונקציונליות");
    expect(
      itemIdentity("custom", {
        list_name: "בעיות",
        תיאור: "לתמוך ברשימה ריקה",
      }),
    ).toBe("לתמוך ברשימה ריקה");
  });

  it("fills a spoken fallback when remove applied but model left response empty", () => {
    expect(
      formatAppliedMutationFallback([
        {
          action: "remove",
          itemId: "1",
          employeeId: talId,
          listType: "custom",
          itemKey: "לבדוק",
          itemLabel: "לבדוק שוב את הפונקציונליות",
          listName: "בעיות",
        },
      ]),
    ).toBe('הסרתי את «לבדוק שוב את הפונקציונליות» מרשימת «בעיות».');
  });

  it("removes a custom row found on another list name for the same owner", async () => {
    const bugs = {
      id: "bugs-list",
      employeeId: talId,
      listType: "custom",
      name: "באגים",
      scope: "shared",
      visibleTo: [talId, employeeId],
    };
    const stored = {
      id: "bug-sys",
      listId: bugs.id,
      itemKey: "מערכת לא עובדת",
      data: { תיאור: "מערכת לא עובדת" },
      scope: "shared",
      addedById: talId,
      visibleTo: [talId, employeeId],
      deletedAt: null,
    };
    // Primary lookup uses a different/empty list name first.
    listFindUnique.mockResolvedValue({
      id: "empty-list",
      employeeId: talId,
      listType: "custom",
      name: "",
      scope: "shared",
      visibleTo: [talId, employeeId],
    });
    listFindMany
      .mockResolvedValueOnce([{ ...bugs, items: [stored] }]) // resolveListActionAgainstSaved
      .mockResolvedValueOnce([{ ...bugs, items: [stored] }]); // across-employee search
    itemFindFirst.mockResolvedValue(null);
    itemFindMany.mockResolvedValue([]);
    itemUpdateMany.mockResolvedValue({ count: 1 });
    // Id-only remove looks up the live row by item_id on the owner.
    itemFindFirst.mockResolvedValueOnce(stored);
    itemUpdate.mockResolvedValue({ id: stored.id });

    const result = await applyEmployeeRecords(
      talId,
      {
        lists: [
          {
            action: "remove",
            listType: "custom",
            listName: "באגים",
            items: [{ item_id: stored.id, תיאור: "מערכת לא עובדת" }],
            targets: [],
          },
        ],
        filing: [],
      },
      {
        scope: "shared",
        addedById: employeeId,
        visibleTo: [talId, employeeId],
      },
      employeeId,
    );

    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: stored.id },
      data: { deletedAt: expect.any(Date), reminderId: null },
    });
    expect(result.mutations.some((row) => row.action === "remove")).toBe(true);
  });

  it("prefers the saved list type when the model guesses wrong", () => {
    expect(chooseSavedListType("shopping", ["tasks"])).toBe("tasks");
    expect(chooseSavedListType("shopping", ["shopping", "tasks"])).toBe(
      "shopping",
    );
    expect(chooseSavedListType("tasks", ["shopping", "tasks"])).toBe("tasks");
    expect(chooseSavedListType("custom", [])).toBeNull();
  });

  it("derives a custom list title from item list_name when the list row name is empty", () => {
    expect(
      deriveCustomListName([
        {
          list_name: "שיעורי הנהיגה של מאיה",
          תאריך: "2026-09-29",
          "מספר שיעור": 1,
        },
      ]),
    ).toBe("שיעורי הנהיגה של מאיה");
    expect(
      deriveCustomListName([{ listName: "Maya driving lessons", paid: "no" }]),
    ).toBe("Maya driving lessons");
    expect(
      deriveCustomListName([{ "שם הרשימה": "משימות לעבודה", שם: "פריט" }]),
    ).toBe("משימות לעבודה");
    expect(deriveCustomListName([{ תאריך: "2026-09-29" }])).toBe("");
    expect(deriveCustomListName([])).toBe("");
  });

  it("treats list-title placeholders as phantom custom items", () => {
    const title = "המטרות של הפועל פתח תקווה עד 2030";
    expect(isPhantomCustomListItem(title, { שנה: title })).toBe(true);
    expect(isPhantomCustomListItem(title, { list_name: title })).toBe(true);
    expect(isPhantomCustomListItem(title, { שנה: "", "הישג נדרש": "" })).toBe(
      true,
    );
    expect(
      isPhantomCustomListItem(title, { שנה: "2027", "הישג נדרש": "אליפות" }),
    ).toBe(false);
  });

  it("rewrites shopping wording when the remove was from tasks", () => {
    expect(
      alignSpokenListType("בתיאבון! הסרתי את «להכין חביתה לילדים» מרשימת הקניות שלך.", [
        { action: "remove", listType: "tasks" },
      ]),
    ).toContain("רשימת המטלות");
  });

  it("removes a task even when the model labeled it shopping", async () => {
    const tasksList = {
      id: "tasks-1",
      employeeId,
      listType: "tasks",
      name: "",
      items: [
        {
          id: "task-1",
          itemKey: "להכין חביתה לילדים",
          data: { "שם מטלה": "להכין חביתה לילדים" },
        },
      ],
    };
    listFindMany.mockResolvedValue([tasksList]);
    listFindUnique.mockResolvedValue({
      id: "tasks-1",
      employeeId,
      listType: "tasks",
      name: "",
    });
    itemFindUnique.mockResolvedValue(tasksList.items[0]);
    itemFindFirst.mockResolvedValue(tasksList.items[0]);
    itemFindMany.mockResolvedValue([]);
    itemUpdate.mockResolvedValue({ id: "task-1" });

    const result = await applyEmployeeRecords(employeeId, {
      lists: [
        {
          action: "remove",
          listType: "shopping",
          listName: "",
          items: [
            { item_id: "task-1", "שם פריט": "להכין חביתה לילדים" },
          ],
          targets: [],
        },
      ],
      filing: [],
    });

    expect(result.mutations).toEqual([
      expect.objectContaining({
        action: "remove",
        listType: "tasks",
        itemKey: "להכין חביתה לילדים",
      }),
    ]);
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: { deletedAt: expect.any(Date), reminderId: null },
    });
    expect(listCreate).not.toHaveBeenCalled();
  });

  it("formats saved employee data for a new LLM conversation", () => {
    const context = formatEmployeeContext({
      lists: [
        {
          list_type: "shopping",
          owner: "עמית",
          scope: "personal",
          items: [
            {
              item_id: "item-milk",
              "שם פריט": "חלב",
              scope: "personal",
              owner: "עמית",
            },
          ],
        },
        {
          list_type: "tasks",
          owner: "עמית",
          scope: "personal",
          items: [
            {
              item_id: "item-gift",
              "שם מטלה": "לקנות מתנה",
              scope: "personal",
              owner: "עמית",
            },
          ],
        },
      ],
      filing: [
        {
          filing_id: "filing-car",
          item_name: "מספר רכב",
          item_info: "3434343",
          item_description: "רכב שלי",
          owner: "עמית",
          scope: "personal",
        },
      ],
    });

    expect(context).toContain("EMPLOYEE_SAVED_DATA");
    expect(context).toContain("חלב");
    expect(context).toContain("לקנות מתנה");
    expect(context).toContain("מספר רכב");
    expect(context).toContain("רכב שלי");
    expect(context).toContain("item_description");
    expect(context).toContain("durable personal facts");
    expect(context).toContain("filing");
    expect(context).toContain("LIVE FACTS THIS TURN");
    expect(context).toContain("MUTATE BY ID");
    expect(context).toContain("item_id");
    expect(context).toContain("filing_id");
  });

  it("formats dated team schedules for meeting conflict checks", () => {
    const schedules = formatTeamSchedules([
      {
        owner: "טל",
        item_name: "פגישה עם לקוח",
        date: "יום ראשון",
        time: "10:00",
        all_day: false,
      },
    ]);

    expect(schedules).toContain("TEAM_SCHEDULES");
    expect(schedules).toContain("same ownership rules");
    expect(schedules).toContain("טל");
    expect(schedules).toContain("10:00");
  });

  it("scopes team schedules with the same ownership gate as saved data", async () => {
    listFindMany.mockResolvedValueOnce([
      {
        listType: "tasks",
        employee: { name: "טל", nickname: null },
        items: [
          {
            itemKey: "פגישה שלי",
            data: { "שם מטלה": "פגישה שלי", "תאריך לביצוע": "יום שלישי" },
            deletedAt: null,
          },
        ],
      },
    ]);

    const nonOwner = await getTeamSchedules(employeeId);
    expect(listFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { listType: "tasks", employeeId },
      }),
    );
    expect(nonOwner).toEqual([
      {
        owner: "טל",
        item_name: "פגישה שלי",
        date: "יום שלישי",
        time: null,
        all_day: false,
      },
    ]);

    employeeFindUnique.mockResolvedValueOnce({
      userId: "user-1",
      kind: "human",
      name: "טל",
      nickname: null,
      isOwner: true,
    });
    listFindMany.mockResolvedValueOnce([]);
    await getTeamSchedules(employeeId);
    expect(listFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          listType: "tasks",
          employee: { userId: "user-1", kind: "human" },
        },
      }),
    );
  });

  it("ties worker items to a speaker via addedBy, visibleTo, or reminder owner/ping", () => {
    const reminders = new Map([
      [
        "rem-maya",
        { ownerId: "maya-id", pingIds: ["maya-id"] },
      ],
      [
        "rem-tal",
        { ownerId: employeeId, pingIds: ["michal-id"] },
      ],
    ]);
    expect(
      workerItemTiedToSpeaker(
        {
          addedById: "maya-id",
          visibleTo: ["maya-id", "lucy-id"],
          reminderId: "rem-maya",
        },
        employeeId,
        reminders,
      ),
    ).toBe(false);
    expect(
      workerItemTiedToSpeaker(
        {
          addedById: employeeId,
          visibleTo: [employeeId, "lucy-id"],
          reminderId: "rem-tal",
        },
        employeeId,
        reminders,
      ),
    ).toBe(true);
    expect(
      workerItemTiedToSpeaker(
        {
          addedById: "lucy-id",
          visibleTo: ["lucy-id"],
          reminderId: "rem-tal",
        },
        employeeId,
        reminders,
      ),
    ).toBe(true);
  });

  it("scopes WORKER_SAVED_DATA items to the current human viewer", async () => {
    const workerId = "lucy-id";
    const mayaId = "maya-id";
    employeeFindUnique
      .mockResolvedValueOnce({
        userId: "user-1",
        kind: "digital",
        name: "לוסי",
        nickname: "לוסי",
        isOwner: false,
      })
      .mockResolvedValueOnce({
        userId: "user-1",
        kind: "human",
        name: "טל",
        nickname: "טל",
        isOwner: false,
      });
    listFindMany.mockResolvedValueOnce([
      {
        id: "lucy-tasks",
        listType: "tasks",
        name: "",
        scope: "personal",
        visibleTo: [],
        employee: { id: workerId, name: "לוסי", nickname: "לוסי" },
        items: [
          {
            id: "item-maya",
            itemKey: "להזכיר למאיוש",
            data: { "שם מטלה": "להזכיר למאיוש לקבוע שיעור" },
            scope: "shared",
            addedById: mayaId,
            visibleTo: [mayaId, workerId],
            reminderId: "rem-maya",
            deletedAt: null,
          },
          {
            id: "item-tal",
            itemKey: "לשלוח הודעה למיכל",
            data: { "שם מטלה": "לשלוח הודעה למיכל" },
            scope: "personal",
            addedById: employeeId,
            visibleTo: [employeeId],
            reminderId: "rem-tal",
            deletedAt: null,
          },
        ],
      },
    ]);
    reminderFindMany.mockResolvedValueOnce([
      { id: "rem-maya", ownerId: mayaId, pingIds: [mayaId] },
      { id: "rem-tal", ownerId: employeeId, pingIds: ["michal-id"] },
    ]);

    const snap = await getEmployeeRecordSnapshot(workerId, {
      scopeItemsToViewerId: employeeId,
    });
    const labels = snap.lists.flatMap((list) =>
      list.items.map((item) => String(item["שם מטלה"] ?? "")),
    );
    expect(labels).toEqual(["לשלוח הודעה למיכל"]);
    expect(labels.join(" ")).not.toContain("מאיוש");
  });

  it("applies add, update, and remove actions for lists, tasks, and filings", async () => {
    const list = { id: "list-1", employeeId, listType: "shopping", name: "" };
    listFindUnique.mockResolvedValueOnce(null).mockResolvedValue(list);
    listCreate.mockResolvedValue(list);
    itemFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "item-1",
        listId: list.id,
        itemKey: "חלב",
        data: { "שם פריט": "חלב", כמות: 1 },
      });
    itemFindFirst
      .mockResolvedValueOnce(null) // add: no existing by key
      .mockResolvedValueOnce({
        // update by item_id
        id: "item-1",
        listId: list.id,
        itemKey: "חלב",
        data: { "שם פריט": "חלב", כמות: 1 },
      })
      .mockResolvedValueOnce(null) // remove without id → skipped (no lookup)
      .mockResolvedValueOnce(null); // filing add by name
    itemCreate.mockResolvedValue({ id: "item-1" });
    itemUpdate.mockResolvedValue({ id: "item-1" });
    itemUpdateMany.mockResolvedValue({ count: 1 });
    itemFindMany.mockResolvedValue([]);
    filingFindFirst
      .mockResolvedValueOnce(null) // add_filing no existing name
      .mockResolvedValueOnce({
        // remove_filing by filing_id
        id: "filing-old",
        employeeId,
        itemName: "רישיון ישן",
        itemInfo: "",
        itemDescription: "",
      });
    filingCreate.mockResolvedValue({ id: "filing-1" });
    filingUpdate.mockResolvedValue({ id: "filing-old" });
    filingFindMany.mockResolvedValue([{ id: "filing-old" }]);
    filingUpdateMany.mockResolvedValue({ count: 1 });

    await applyEmployeeMetadata(employeeId, {
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          items: [{ "שם פריט": "חלב", כמות: 1 }],
          targets: [],
        },
        {
          action: "update",
          listType: "shopping",
          listName: "",
          items: [{ item_id: "item-1", "שם פריט": "חלב", כמות: 2 }],
          targets: [],
        },
        {
          action: "remove",
          listType: "shopping",
          listName: "",
          items: [{ "שם פריט": "לחם" }],
          targets: [],
        },
      ],
      filing: [
        {
          action: "add_filing",
          itemName: "מספר רכב",
          itemInfo: "3434343",
          itemDescription: "מספר רכב",
          targets: [],
          filingId: "",
        },
        {
          action: "remove_filing",
          itemName: "רישיון ישן",
          itemInfo: "",
          itemDescription: "",
          targets: [],
          filingId: "filing-old",
        },
      ],
    });

    expect(itemCreate).toHaveBeenCalledWith({
      data: {
        listId: "list-1",
        itemKey: "חלב",
        data: { "שם פריט": "חלב", כמות: 1 },
        scope: "personal",
        addedById: employeeId,
        visibleTo: [employeeId],
      },
    });
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "item-1" },
      data: {
        data: { "שם פריט": "חלב", כמות: 2 },
        scope: "personal",
        addedById: employeeId,
        visibleTo: [employeeId],
      },
    });
    // Remove without item_id must not soft-delete by guessed key.
    expect(itemUpdateMany).not.toHaveBeenCalledWith({
      where: { listId: "list-1", itemKey: "לחם", deletedAt: null },
      data: { deletedAt: expect.any(Date), reminderId: null },
    });
    expect(filingCreate).toHaveBeenCalledWith({
      data: {
        employeeId,
        itemName: "מספר רכב",
        itemInfo: "3434343",
        itemDescription: "מספר רכב",
        addedById: employeeId,
      },
    });
    expect(filingUpdate).toHaveBeenCalledWith({
      where: { id: "filing-old" },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it("updates the only task when the new name does not match the stored key", async () => {
    const list = { id: "lucy-tasks", employeeId, listType: "tasks", name: "" };
    listFindUnique.mockResolvedValue(list);
    itemFindFirst.mockResolvedValue({
      id: "task-1",
      listId: list.id,
      itemKey: "להזכיר לעמית לבדוק מייל",
      data: { "שם מטלה": "להזכיר לעמית לבדוק מייל" },
      scope: "personal",
      addedById: employeeId,
      visibleTo: [employeeId],
    });
    itemFindMany.mockResolvedValue([]);
    itemUpdate.mockResolvedValue({ id: "task-1" });

    await applyEmployeeMetadata(employeeId, {
      lists: [
        {
          action: "update",
          listType: "tasks",
          listName: "",
          items: [{ item_id: "task-1", "שם מטלה": "להזכיר לטל לבדוק מייל" }],
          targets: [],
        },
      ],
      filing: [],
    });

    expect(itemCreate).not.toHaveBeenCalled();
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: expect.objectContaining({
        itemKey: "להזכיר לטל לבדוק מייל",
        data: expect.objectContaining({
          "שם מטלה": "להזכיר לטל לבדוק מייל",
        }),
      }),
    });
  });

  it("notifies watchers and clears assignment tasks when the owner buys a shared item", async () => {
    const list = { id: "tal-shop", employeeId: talId, listType: "shopping", name: "" };
    listFindUnique.mockResolvedValue(list);
    itemFindFirst.mockResolvedValue({
      id: "tuna-1",
      listId: list.id,
      itemKey: "קופסת טונה",
      scope: "shared",
      addedById: employeeId,
      visibleTo: [employeeId, talId],
      data: { "שם פריט": "קופסת טונה", כמות: 1 },
    });
    itemUpdate.mockResolvedValue({ id: "tuna-1" });
    itemUpdateMany.mockResolvedValue({ count: 1 });

    const events = await applyEmployeeMetadata(
      talId,
      {
        lists: [
          {
            action: "remove",
            listType: "shopping",
            listName: "",
            items: [{ item_id: "tuna-1", "שם פריט": "קופסת טונה" }],
            targets: [],
          },
        ],
        filing: [],
      },
      undefined,
      talId,
    );

    expect(events).toEqual([
      {
        notifyEmployeeIds: [employeeId],
        metadata: {
          lists: [
            expect.objectContaining({
              action: "remove",
              listType: "shopping",
              items: [{ item_id: "tuna-1", "שם פריט": "קופסת טונה" }],
            }),
          ],
          filing: [],
        },
        listOwnerId: talId,
      },
    ]);
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "tuna-1" },
      data: { deletedAt: expect.any(Date), reminderId: null },
    });
    expect(itemUpdateMany).toHaveBeenCalledWith({
      where: {
        itemKey: { contains: "קופסת טונה" },
        deletedAt: null,
        list: {
          listType: "tasks",
          employeeId: { in: [talId, employeeId] },
        },
      },
      data: { deletedAt: expect.any(Date), reminderId: null },
    });
  });

  it("returns a snapshot of saved lists and filings", async () => {
    listFindMany.mockResolvedValue([
      {
        listType: "tasks",
        name: "",
        scope: "personal",
        visibleTo: [],
        employee: { id: employeeId, name: "עמית", nickname: "עמית" },
        items: [
          {
            id: "task-gift",
            data: { "שם מטלה": "לקנות מתנה" },
            scope: "personal",
          },
        ],
      },
    ]);
    filingFindMany.mockResolvedValue([
      {
        id: "filing-car",
        itemName: "מספר רכב",
        itemInfo: "3434343",
        itemDescription: "רכב שלי",
        employee: { name: "עמית", nickname: "עמית" },
      },
    ]);

    await expect(getEmployeeRecordSnapshot(employeeId)).resolves.toEqual({
      lists: [
        {
          list_type: "tasks",
          owner: "עמית",
          scope: "personal",
          items: [
            {
              item_id: "task-gift",
              "שם מטלה": "לקנות מתנה",
              scope: "personal",
              owner: "עמית",
            },
          ],
        },
      ],
      filing: [
        {
          filing_id: "filing-car",
          item_name: "מספר רכב",
          item_info: "3434343",
          item_description: "רכב שלי",
          owner: "עמית",
          scope: "personal",
        },
      ],
      reminders: [],
    });
  });

  it("adds the FK-linked active reminder to a list item and nothing to unlinked items", async () => {
    listFindMany.mockResolvedValue([
      {
        listType: "tasks",
        name: "",
        scope: "personal",
        visibleTo: [],
        employee: { id: employeeId, name: "עמית", nickname: "עמית" },
        items: [
          {
            id: "task-milk",
            data: { "שם מטלה": "לקנות חלב" },
            scope: "personal",
            reminderId: "rem-milk",
          },
          {
            id: "task-stale",
            data: { "שם מטלה": "להתקשר לבנק" },
            scope: "personal",
            reminderId: "rem-gone",
          },
          {
            id: "task-gift",
            data: { "שם מטלה": "לקנות מתנה" },
            scope: "personal",
            reminderId: null,
          },
          {
            id: "task-speaker",
            data: { "שם מטלה": "לבדוק שטויות" },
            scope: "personal",
            reminderId: null,
            linkedReminderId: "rem-milk",
          },
        ],
      },
    ]);
    reminderFindMany.mockResolvedValue([
      {
        id: "rem-milk",
        itemLabel: "לקנות חלב",
        listType: "tasks",
        fireAt: new Date("2026-10-07T06:00:00.000Z"),
        repeat: "none",
        pingIds: [employeeId],
        ownerId: employeeId,
        messageText: "לקנות חלב",
        status: "active",
      },
      {
        id: "rem-gift-lookalike",
        itemLabel: "לקנות מתנה",
        listType: "tasks",
        fireAt: new Date("2026-10-08T06:00:00.000Z"),
        repeat: "none",
        pingIds: [employeeId],
        ownerId: employeeId,
        messageText: "לקנות מתנה",
        status: "active",
      },
    ]);

    const snap = await getEmployeeRecordSnapshot(employeeId);
    const items = snap.lists[0]?.items ?? [];
    expect(items.find((item) => item.item_id === "task-milk")).toMatchObject({
      reminder: {
        reminder_id: "rem-milk",
        fire_at: "2026-10-07 09:00",
        repeat: "none",
      },
    });
    expect(items.find((item) => item.item_id === "task-stale")).not.toHaveProperty(
      "reminder",
    );
    expect(items.find((item) => item.item_id === "task-gift")).not.toHaveProperty(
      "reminder",
    );
    expect(items.find((item) => item.item_id === "task-speaker")).toMatchObject({
      reminder: { reminder_id: "rem-milk", fire_at: "2026-10-07 09:00" },
    });
  });

  it("includes empty shared custom lists with shared_with partners", async () => {
    listFindMany.mockResolvedValue([
      {
        id: "bugs",
        listType: "custom",
        name: "בעיות",
        scope: "shared",
        visibleTo: [employeeId, talId],
        employee: { id: employeeId, name: "עמית", nickname: "עמית" },
        items: [],
      },
    ]);
    employeeFindMany.mockResolvedValue([
      { id: employeeId, name: "עמית", nickname: "עמית" },
      { id: talId, name: "טל", nickname: "טל" },
    ]);
    filingFindMany.mockResolvedValue([]);

    await expect(getEmployeeRecordSnapshot(employeeId)).resolves.toEqual({
      lists: [
        {
          list_type: "custom",
          list_name: "בעיות",
          owner: "עמית",
          scope: "shared",
          shared_with: ["עמית", "טל"],
          items: [],
        },
      ],
      filing: [],
      reminders: [],
    });
  });

  it("derives list_name from שם הרשימה when the list row name is empty", async () => {
    listFindMany.mockResolvedValue([
      {
        listType: "custom",
        name: "",
        scope: "shared",
        visibleTo: [employeeId, talId],
        employee: { id: employeeId, name: "עמית", nickname: "עמית" },
        items: [
          {
            data: { "שם הרשימה": "משימות לעבודה", שם: "לטפל באורח" },
            scope: "shared",
          },
        ],
      },
    ]);
    employeeFindMany.mockResolvedValue([
      { id: employeeId, name: "עמית", nickname: "עמית" },
      { id: talId, name: "טל", nickname: "טל" },
    ]);
    filingFindMany.mockResolvedValue([]);

    const snap = await getEmployeeRecordSnapshot(employeeId);
    expect(snap.lists[0]).toMatchObject({
      list_type: "custom",
      list_name: "משימות לעבודה",
      scope: "shared",
      shared_with: ["עמית", "טל"],
    });
  });

  it("returns owned records with creator and created time", async () => {
    const createdAt = new Date("2026-09-13T07:00:00.000Z");
    listFindMany.mockResolvedValue([
      {
        listType: "shopping",
        name: "",
        employee: { name: "טל", nickname: "טל" },
        items: [
          {
            id: "item-milk",
            itemKey: "חלב",
            data: { "שם פריט": "חלב", כמות: 1 },
            addedById: talId,
            createdAt,
          },
          {
            id: "item-tuna",
            itemKey: "טונה",
            data: { "שם פריט": "טונה", כמות: 2 },
            addedById: employeeId,
            createdAt,
          },
        ],
      },
      {
        listType: "tasks",
        name: "",
        employee: { name: "טל", nickname: "טל" },
        items: [
          {
            id: "item-book",
            itemKey: "לקרוא ספר",
            data: { "שם מטלה": "לקרוא ספר" },
            addedById: talId,
            createdAt,
          },
        ],
      },
    ]);
    filingFindMany.mockResolvedValue([
      {
        id: "filing-1",
        itemName: "מספר רכב",
        itemInfo: "3434343",
        itemDescription: "",
        addedById: employeeId,
        createdAt,
        employee: { name: "טל", nickname: "טל" },
      },
    ]);
    employeeFindMany.mockResolvedValue([
      { id: employeeId, name: "עמית", nickname: "עמית" },
      { id: talId, name: "טל", nickname: "טל" },
    ]);

    await expect(getEmployeeOwnedRecords(talId)).resolves.toEqual({
      employeeId: talId,
      groups: [
        {
          type: "shopping",
          title: "Shopping",
          items: [
            {
              id: "item-milk",
              kind: "list",
              title: "חלב",
              details: [{ label: "כמות", value: "1" }],
              fields: [
                { label: "שם פריט", value: "חלב" },
                { label: "כמות", value: "1" },
              ],
              createdBy: "טל",
              createdAt: createdAt.toISOString(),
            },
            {
              id: "item-tuna",
              kind: "list",
              title: "טונה",
              details: [{ label: "כמות", value: "2" }],
              fields: [
                { label: "שם פריט", value: "טונה" },
                { label: "כמות", value: "2" },
              ],
              createdBy: "עמית",
              createdAt: createdAt.toISOString(),
            },
          ],
        },
        {
          type: "tasks",
          title: "Tasks",
          items: [
            {
              id: "item-book",
              kind: "list",
              title: "לקרוא ספר",
              details: [],
              fields: [{ label: "שם מטלה", value: "לקרוא ספר" }],
              createdBy: "טל",
              createdAt: createdAt.toISOString(),
            },
          ],
        },
        {
          type: "filing",
          title: "Filings",
          items: [
            {
              id: "filing-1",
              kind: "filing",
              title: "מספר רכב",
              details: [{ label: "Details", value: "3434343" }],
              fields: [
                { label: "Name", value: "מספר רכב" },
                { label: "Description", value: "" },
                { label: "Details", value: "3434343" },
              ],
              createdBy: "עמית",
              createdAt: createdAt.toISOString(),
            },
          ],
        },
      ],
    });
  });

  it("keeps a «X צריך לקנות Y» task in the snapshot and never deletes it while reading", async () => {
    listFindMany.mockResolvedValue([
      {
        listType: "tasks",
        name: "",
        scope: "shared",
        visibleTo: [],
        employee: { id: employeeId, name: "לוסי", nickname: "לוסי" },
        items: [
          {
            id: "lucy-apples",
            data: { "שם מטלה": "להזכיר לעמית שערן צריך לקנות תפוחים" },
            scope: "shared",
            itemKey: "להזכיר לעמית שערן צריך לקנות תפוחים",
            reminderId: null,
          },
        ],
      },
    ]);
    itemFindMany.mockResolvedValue([]);
    filingFindMany.mockResolvedValue([]);

    const snap = await getEmployeeRecordSnapshot(employeeId);
    expect(snap.lists[0]?.items).toEqual([
      expect.objectContaining({
        item_id: "lucy-apples",
        "שם מטלה": "להזכיר לעמית שערן צריך לקנות תפוחים",
      }),
    ]);
    expect(itemUpdateMany).not.toHaveBeenCalled();
  });

  it("emits watcher events when a shared item is added", async () => {
    const list = { id: "tal-shop", employeeId: talId, listType: "shopping", name: "" };
    listFindUnique.mockResolvedValue(list);
    itemFindUnique.mockResolvedValue(null);
    itemFindMany.mockResolvedValue([]);
    itemCreate.mockResolvedValue({ id: "tuna-1" });

    const events = await applyEmployeeMetadata(
      talId,
      {
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "קופסת טונה" }],
            targets: [],
          },
        ],
        filing: [],
      },
      {
        scope: "shared",
        addedById: employeeId,
        visibleTo: [employeeId, talId],
      },
      employeeId,
    );

    expect(events).toEqual([
      {
        notifyEmployeeIds: [talId],
        metadata: {
          lists: [
            expect.objectContaining({
              action: "add",
              items: [{ "שם פריט": "קופסת טונה" }],
            }),
          ],
          filing: [],
        },
        listOwnerId: talId,
      },
    ]);
  });

  it("removes a shared custom row even when the model repeats list_name on the item", async () => {
    const list = {
      id: "bugs-list",
      employeeId: talId,
      listType: "custom",
      name: "בעיות",
      scope: "shared",
      visibleTo: [talId, employeeId],
    };
    const stored = {
      id: "bug-1",
      listId: list.id,
      itemKey: "לבדוק שוב את הפונקציונליות",
      data: { תיאור: "לבדוק שוב את הפונקציונליות" },
      scope: "shared",
      addedById: talId,
      visibleTo: [talId, employeeId],
      deletedAt: null,
    };
    listFindUnique.mockResolvedValue(list);
    listFindMany.mockResolvedValue([
      {
        id: "other-custom",
        employeeId: talId,
        listType: "custom",
        name: "חנויות",
        items: [
          {
            id: "store-1",
            itemKey: "אדידס",
            data: { "שם החנות": "אדידס" },
            deletedAt: null,
          },
        ],
      },
      {
        ...list,
        items: [stored],
      },
    ]);
    itemFindFirst.mockResolvedValue(stored);
    itemFindMany.mockResolvedValue([stored]);
    itemUpdate.mockResolvedValue({ id: stored.id });

    const result = await applyEmployeeRecords(
      talId,
      {
        lists: [
          {
            action: "remove",
            listType: "custom",
            listName: "בעיות",
            items: [
              {
                item_id: stored.id,
                list_name: "בעיות",
                תיאור: "לבדוק שוב את הפונקציונליות",
              },
            ],
            targets: [],
          },
        ],
        filing: [],
      },
      {
        scope: "shared",
        addedById: employeeId,
        visibleTo: [talId, employeeId],
      },
      employeeId,
    );

    expect(listFindUnique).toHaveBeenCalledWith({
      where: {
        employeeId_listType_name: {
          employeeId: talId,
          listType: "custom",
          name: "בעיות",
        },
      },
    });
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: stored.id },
      data: { deletedAt: expect.any(Date), reminderId: null },
    });
    expect(result.mutations.some((row) => row.action === "remove")).toBe(true);
  });

  it("updates a shared custom row matched by תיאור, not list_name", async () => {
    const list = {
      id: "bugs-list",
      employeeId: talId,
      listType: "custom",
      name: "בעיות",
      scope: "shared",
      visibleTo: [talId, employeeId],
    };
    const stored = {
      id: "bug-2",
      listId: list.id,
      itemKey: "לתמוך ברשימה ריקה",
      data: { תיאור: "לתמוך ברשימה ריקה" },
      scope: "shared",
      addedById: talId,
      visibleTo: [talId, employeeId],
    };
    listFindUnique.mockResolvedValue(list);
    itemFindFirst.mockResolvedValue(stored);
    itemFindMany.mockResolvedValue([stored]);
    itemUpdate.mockResolvedValue({ id: stored.id });

    const result = await applyEmployeeRecords(
      talId,
      {
        lists: [
          {
            action: "update",
            listType: "custom",
            listName: "בעיות",
            items: [
              {
                item_id: stored.id,
                list_name: "בעיות",
                תיאור: "לתמוך ברשימה ריקה",
                סטטוס: "בטיפול",
              },
            ],
            targets: [],
          },
        ],
        filing: [],
      },
      {
        scope: "shared",
        addedById: employeeId,
        visibleTo: [talId, employeeId],
      },
      employeeId,
    );

    expect(itemUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: stored.id },
        data: expect.objectContaining({
          data: expect.objectContaining({
            תיאור: "לתמוך ברשימה ריקה",
            סטטוס: "בטיפול",
          }),
        }),
      }),
    );
    expect(result.mutations.some((row) => row.action === "update")).toBe(true);
  });

  it("matches a shorter bought name to the saved shared item", async () => {
    const list = { id: "tal-shop", employeeId: talId, listType: "shopping", name: "" };
    listFindUnique.mockResolvedValue(list);
    itemFindFirst.mockResolvedValue({
      id: "tuna-1",
      listId: list.id,
      itemKey: "קופסת טונה",
      scope: "shared",
      addedById: employeeId,
      visibleTo: [employeeId, talId],
      data: { "שם פריט": "קופסת טונה" },
    });
    itemUpdate.mockResolvedValue({ id: "tuna-1" });
    itemUpdateMany.mockResolvedValue({ count: 1 });

    const events = await applyEmployeeMetadata(
      talId,
      {
        lists: [
          {
            action: "remove",
            listType: "shopping",
            listName: "",
            items: [{ item_id: "tuna-1", "שם פריט": "טונה" }],
            targets: [],
          },
        ],
        filing: [],
      },
      undefined,
      talId,
    );

    expect(events[0]?.notifyEmployeeIds).toEqual([employeeId]);
    expect(events[0]?.purchased).toBeUndefined();
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "tuna-1" },
      data: { deletedAt: expect.any(Date), reminderId: null },
    });
  });

  it("notifies assignment watchers when a bought item was not marked shared", async () => {
    const list = { id: "tal-shop", employeeId: talId, listType: "shopping", name: "" };
    listFindUnique.mockResolvedValue(list);
    itemFindFirst.mockResolvedValue({
      id: "tuna-1",
      listId: list.id,
      itemKey: "טונה",
      scope: "personal",
      addedById: talId,
      visibleTo: [talId],
      data: { "שם פריט": "טונה" },
    });
    itemFindMany.mockResolvedValue([{ list: { employeeId } }]);
    itemUpdate.mockResolvedValue({ id: "tuna-1" });
    itemUpdateMany.mockResolvedValue({ count: 1 });

    const events = await applyEmployeeMetadata(
      talId,
      {
        lists: [
          {
            action: "remove",
            listType: "shopping",
            listName: "",
            items: [{ item_id: "tuna-1", "שם פריט": "טונה" }],
            targets: [],
          },
        ],
        filing: [],
      },
      undefined,
      talId,
    );

    expect(events[0]?.notifyEmployeeIds).toEqual([employeeId]);
    expect(events[0]?.purchased).toBeUndefined();
  });

  it("notifies watchers when a shared item is updated from employee records", async () => {
    itemFindFirst.mockResolvedValue({
      id: "item-tuna",
      itemKey: "טונה",
      data: { "שם פריט": "טונה", כמות: 1 },
      scope: "shared",
      addedById: employeeId,
      visibleTo: [employeeId, talId],
      list: { id: "tal-shop", employeeId: talId, listType: "shopping", name: "" },
    });
    itemUpdate.mockResolvedValue({ id: "item-tuna" });

    const events = await updateEmployeeRecord(
      talId,
      "item-tuna",
      [
        { label: "שם פריט", value: "טונה" },
        { label: "כמות", value: "3" },
      ],
      employeeId,
    );

    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "item-tuna" },
      data: {
        itemKey: "טונה",
        data: { "שם פריט": "טונה", כמות: 3 },
      },
    });
    expect(events[0]?.notifyEmployeeIds).toEqual([talId]);
    expect(events[0]?.metadata.lists[0]?.action).toBe("update");
  });

  it("notifies watchers when a shared item is deleted from employee records", async () => {
    itemFindFirst.mockResolvedValue({
      id: "item-tuna",
      itemKey: "טונה",
      data: { "שם פריט": "טונה" },
      scope: "shared",
      addedById: employeeId,
      visibleTo: [employeeId, talId],
      list: { employeeId: talId, listType: "shopping", name: "" },
    });
    itemUpdate.mockResolvedValue({ id: "item-tuna" });
    itemUpdateMany.mockResolvedValue({ count: 1 });

    const events = await deleteEmployeeRecord(talId, "item-tuna", employeeId);

    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "item-tuna" },
      data: { deletedAt: expect.any(Date), reminderId: null },
    });
    expect(events[0]?.notifyEmployeeIds).toEqual([talId]);
    expect(events[0]?.metadata.lists[0]?.action).toBe("remove");
    expect(events[0]?.purchased).toBeUndefined();
  });
});
