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
  listRecentMutationHistory: vi.fn().mockResolvedValue([]),
}));

import {
  alignSpokenListType,
  applyEmployeeMetadata,
  applyEmployeeRecords,
  chooseSavedListType,
  deleteEmployeeRecord,
  deriveCustomListName,
  formatEmployeeContext,
  formatTeamSchedules,
  getEmployeeOwnedRecords,
  getEmployeeRecordSnapshot,
  updateEmployeeRecord,
  itemIdentity,
  parseAssignmentNote,
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
    employeeFindUnique.mockReset().mockResolvedValue({ userId: "user-1" });
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
    expect(deriveCustomListName([{ תאריך: "2026-09-29" }])).toBe("");
    expect(deriveCustomListName([])).toBe("");
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
    itemUpdateMany.mockResolvedValue({ count: 1 });

    const result = await applyEmployeeRecords(employeeId, {
      lists: [
        {
          action: "remove",
          listType: "shopping",
          listName: "",
          items: [{ "שם פריט": "להכין חביתה לילדים" }],
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
    expect(itemUpdateMany).toHaveBeenCalledWith({
      where: {
        listId: "tasks-1",
        itemKey: "להכין חביתה לילדים",
        deletedAt: null,
      },
      data: { deletedAt: expect.any(Date), reminderId: null },
    });
    expect(listCreate).not.toHaveBeenCalled();
  });

  it("parses assignment notes for another employee's shopping", () => {
    expect(parseAssignmentNote("טל צריך לקנות קופסת טונה")).toEqual({
      targetLabel: "טל",
      items: ["קופסת טונה"],
    });
    expect(parseAssignmentNote("כולם צריכים לקנות חלב וגבינה")).toEqual({
      targetLabel: "כולם",
      items: ["חלב", "גבינה"],
    });
    expect(parseAssignmentNote("לקנות מתנה")).toBeNull();
  });

  it("formats saved employee data for a new LLM conversation", () => {
    const context = formatEmployeeContext({
      lists: [
        {
          list_type: "shopping",
          owner: "עמית",
          items: [{ "שם פריט": "חלב", scope: "personal", owner: "עמית" }],
        },
        {
          list_type: "tasks",
          owner: "עמית",
          items: [{ "שם מטלה": "לקנות מתנה", scope: "personal", owner: "עמית" }],
        },
      ],
      filing: [
        {
          item_name: "מספר רכב",
          item_info: "3434343",
          owner: "עמית",
          scope: "personal",
        },
      ],
    });

    expect(context).toContain("EMPLOYEE_SAVED_DATA");
    expect(context).toContain("חלב");
    expect(context).toContain("לקנות מתנה");
    expect(context).toContain("מספר רכב");
    expect(context).toContain("durable personal facts");
    expect(context).toContain("filing");
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
    expect(schedules).toContain("טל");
    expect(schedules).toContain("10:00");
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
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "item-1",
        listId: list.id,
        itemKey: "חלב",
        data: { "שם פריט": "חלב", כמות: 1 },
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null); // filing add
    itemCreate.mockResolvedValue({ id: "item-1" });
    itemUpdate.mockResolvedValue({ id: "item-1" });
    itemUpdateMany.mockResolvedValue({ count: 1 });
    itemFindMany.mockResolvedValue([]);
    filingFindFirst.mockResolvedValue(null);
    filingCreate.mockResolvedValue({ id: "filing-1" });
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
          items: [{ "שם פריט": "חלב", כמות: 2 }],
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
          targets: [],
        },
        {
          action: "remove_filing",
          itemName: "רישיון ישן",
          itemInfo: "",
          targets: [],
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
    expect(itemUpdateMany).toHaveBeenCalledWith({
      where: { listId: "list-1", itemKey: "לחם", deletedAt: null },
      data: { deletedAt: expect.any(Date), reminderId: null },
    });
    expect(filingCreate).toHaveBeenCalledWith({
      data: {
        employeeId,
        itemName: "מספר רכב",
        itemInfo: "3434343",
        addedById: employeeId,
      },
    });
    expect(filingUpdateMany).toHaveBeenCalledWith({
      where: { employeeId, itemName: "רישיון ישן", deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it("updates the only task when the new name does not match the stored key", async () => {
    const list = { id: "lucy-tasks", employeeId, listType: "tasks", name: "" };
    listFindUnique.mockResolvedValue(list);
    itemFindUnique.mockResolvedValue(null);
    itemFindMany
      .mockResolvedValueOnce([
        {
          id: "task-1",
          listId: list.id,
          itemKey: "להזכיר לעמית לבדוק מייל",
          data: { "שם מטלה": "להזכיר לעמית לבדוק מייל" },
          scope: "personal",
          addedById: employeeId,
          visibleTo: [employeeId],
        },
      ])
      .mockResolvedValue([]);
    itemUpdate.mockResolvedValue({ id: "task-1" });

    await applyEmployeeMetadata(employeeId, {
      lists: [
        {
          action: "update",
          listType: "tasks",
          listName: "",
          items: [{ "שם מטלה": "להזכיר לטל לבדוק מייל" }],
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
    itemUpdateMany.mockResolvedValue({ count: 1 });

    const events = await applyEmployeeMetadata(
      talId,
      {
        lists: [
          {
            action: "remove",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "קופסת טונה" }],
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
              items: [{ "שם פריט": "קופסת טונה" }],
            }),
          ],
          filing: [],
        },
        listOwnerId: talId,
        purchased: true,
      },
    ]);
    expect(itemUpdateMany).toHaveBeenCalledWith({
      where: {
        listId: list.id,
        itemKey: "קופסת טונה",
        deletedAt: null,
      },
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
        employee: { name: "עמית", nickname: "עמית" },
        items: [{ data: { "שם מטלה": "לקנות מתנה" }, scope: "personal" }],
      },
    ]);
    filingFindMany.mockResolvedValue([
      {
        itemName: "מספר רכב",
        itemInfo: "3434343",
        employee: { name: "עמית", nickname: "עמית" },
      },
    ]);

    await expect(getEmployeeRecordSnapshot(employeeId)).resolves.toEqual({
      lists: [
        {
          list_type: "tasks",
          owner: "עמית",
          items: [{ "שם מטלה": "לקנות מתנה", scope: "personal", owner: "עמית" }],
        },
      ],
      filing: [
        {
          item_name: "מספר רכב",
          item_info: "3434343",
          owner: "עמית",
          scope: "personal",
        },
      ],
      reminders: [],
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

  it("hides leftover assignment tasks when the shopping item is gone", async () => {
    listFindMany.mockResolvedValue([
      {
        listType: "tasks",
        name: "",
        employee: { name: "עמית", nickname: "עמית" },
        items: [
          {
            data: { "שם מטלה": "טל צריך לקנות קופסת טונה" },
            scope: "personal",
            itemKey: "טל צריך לקנות קופסת טונה",
          },
        ],
      },
    ]);
    itemFindMany.mockResolvedValue([]);
    filingFindMany.mockResolvedValue([]);

    await expect(getEmployeeRecordSnapshot(employeeId)).resolves.toEqual({
      lists: [],
      filing: [],
      reminders: [],
    });
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

  it("matches a shorter bought name to the saved shared item", async () => {
    const list = { id: "tal-shop", employeeId: talId, listType: "shopping", name: "" };
    listFindUnique.mockResolvedValue(list);
    itemFindFirst.mockResolvedValue(null);
    itemFindMany.mockResolvedValue([
      {
        id: "tuna-1",
        listId: list.id,
        itemKey: "קופסת טונה",
        scope: "shared",
        addedById: employeeId,
        visibleTo: [employeeId, talId],
        data: { "שם פריט": "קופסת טונה" },
      },
    ]);
    itemUpdateMany.mockResolvedValue({ count: 1 });

    const events = await applyEmployeeMetadata(
      talId,
      {
        lists: [
          {
            action: "remove",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "טונה" }],
            targets: [],
          },
        ],
        filing: [],
      },
      undefined,
      talId,
    );

    expect(events[0]?.notifyEmployeeIds).toEqual([employeeId]);
    expect(events[0]?.purchased).toBe(true);
    expect(itemUpdateMany).toHaveBeenCalledWith({
      where: {
        listId: list.id,
        itemKey: "קופסת טונה",
        deletedAt: null,
      },
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
    itemUpdateMany.mockResolvedValue({ count: 1 });

    const events = await applyEmployeeMetadata(
      talId,
      {
        lists: [
          {
            action: "remove",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "טונה" }],
            targets: [],
          },
        ],
        filing: [],
      },
      undefined,
      talId,
    );

    expect(events[0]?.notifyEmployeeIds).toEqual([employeeId]);
    expect(events[0]?.purchased).toBe(true);
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
