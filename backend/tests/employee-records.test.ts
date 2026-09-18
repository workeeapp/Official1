import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  listFindMany,
  listFindUnique,
  listCreate,
  itemFindMany,
  itemFindFirst,
  itemFindUnique,
  itemCreate,
  itemUpdate,
  itemDelete,
  itemDeleteMany,
  filingFindMany,
  filingFindFirst,
  filingUpsert,
  filingUpdate,
  filingDelete,
  filingDeleteMany,
  employeeFindMany,
} = vi.hoisted(() => ({
  listFindMany: vi.fn(),
  listFindUnique: vi.fn(),
  listCreate: vi.fn(),
  itemFindMany: vi.fn(),
  itemFindFirst: vi.fn(),
  itemFindUnique: vi.fn(),
  itemCreate: vi.fn(),
  itemUpdate: vi.fn(),
  itemDelete: vi.fn(),
  itemDeleteMany: vi.fn(),
  filingFindMany: vi.fn(),
  filingFindFirst: vi.fn(),
  filingUpsert: vi.fn(),
  filingUpdate: vi.fn(),
  filingDelete: vi.fn(),
  filingDeleteMany: vi.fn(),
  employeeFindMany: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    employeeList: {
      findMany: listFindMany,
      findUnique: listFindUnique,
      create: listCreate,
    },
    employeeListItem: {
      findMany: itemFindMany,
      findFirst: itemFindFirst,
      findUnique: itemFindUnique,
      create: itemCreate,
      update: itemUpdate,
      delete: itemDelete,
      deleteMany: itemDeleteMany,
    },
    employeeFiling: {
      findMany: filingFindMany,
      findFirst: filingFindFirst,
      upsert: filingUpsert,
      update: filingUpdate,
      delete: filingDelete,
      deleteMany: filingDeleteMany,
    },
    employee: {
      findMany: employeeFindMany,
    },
  },
}));

import {
  applyEmployeeMetadata,
  deleteEmployeeRecord,
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
    listFindMany.mockReset();
    listFindUnique.mockReset();
    listCreate.mockReset();
    itemFindMany.mockReset().mockResolvedValue([]);
    itemFindFirst.mockReset();
    itemFindUnique.mockReset();
    itemCreate.mockReset();
    itemUpdate.mockReset();
    itemDelete.mockReset();
    itemDeleteMany.mockReset();
    filingFindMany.mockReset();
    filingFindFirst.mockReset();
    filingUpsert.mockReset();
    filingUpdate.mockReset();
    filingDelete.mockReset();
    filingDeleteMany.mockReset();
    employeeFindMany.mockReset().mockResolvedValue([]);
  });

  it("builds an identity key from Hebrew shopping and task fields", () => {
    expect(itemIdentity("shopping", { "שם פריט": "חלב", כמות: 1 })).toBe("חלב");
    expect(itemIdentity("tasks", { "שם מטלה": "לקנות מתנה" })).toBe("לקנות מתנה");
    expect(
      itemIdentity("contacts", { "שם פרטי": "דנה", "שם משפחה": "לוי" }),
    ).toBe("דנה|לוי");
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
    itemCreate.mockResolvedValue({ id: "item-1" });
    itemUpdate.mockResolvedValue({ id: "item-1" });
    itemDeleteMany.mockResolvedValue({ count: 1 });
    filingUpsert.mockResolvedValue({ id: "filing-1" });
    filingDeleteMany.mockResolvedValue({ count: 1 });

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
    expect(itemDeleteMany).toHaveBeenCalledWith({
      where: { listId: "list-1", itemKey: "לחם" },
    });
    expect(filingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          employeeId,
          itemName: "מספר רכב",
          itemInfo: "3434343",
          addedById: employeeId,
        },
      }),
    );
    expect(filingDeleteMany).toHaveBeenCalledWith({
      where: { employeeId, itemName: "רישיון ישן" },
    });
  });

  it("notifies watchers and clears assignment tasks when the owner buys a shared item", async () => {
    const list = { id: "tal-shop", employeeId: talId, listType: "shopping", name: "" };
    listFindUnique.mockResolvedValue(list);
    itemFindUnique.mockResolvedValue({
      id: "tuna-1",
      listId: list.id,
      itemKey: "קופסת טונה",
      scope: "shared",
      addedById: employeeId,
      visibleTo: [employeeId, talId],
      data: { "שם פריט": "קופסת טונה", כמות: 1 },
    });
    itemDeleteMany.mockResolvedValue({ count: 1 });

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
    expect(itemDeleteMany).toHaveBeenCalledWith({
      where: { listId: list.id, itemKey: "קופסת טונה" },
    });
    expect(itemDeleteMany).toHaveBeenCalledWith({
      where: {
        itemKey: { contains: "קופסת טונה" },
        list: {
          listType: "tasks",
          employeeId: { in: [talId, employeeId] },
        },
      },
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
    itemFindUnique.mockResolvedValue(null);
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
    itemDeleteMany.mockResolvedValue({ count: 1 });

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
    expect(itemDeleteMany).toHaveBeenCalledWith({
      where: { listId: list.id, itemKey: "קופסת טונה" },
    });
  });

  it("notifies assignment watchers when a bought item was not marked shared", async () => {
    const list = { id: "tal-shop", employeeId: talId, listType: "shopping", name: "" };
    listFindUnique.mockResolvedValue(list);
    itemFindUnique.mockResolvedValue({
      id: "tuna-1",
      listId: list.id,
      itemKey: "טונה",
      scope: "personal",
      addedById: talId,
      visibleTo: [talId],
      data: { "שם פריט": "טונה" },
    });
    itemFindMany.mockResolvedValue([{ list: { employeeId } }]);
    itemDeleteMany.mockResolvedValue({ count: 1 });

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
    itemDelete.mockResolvedValue({ id: "item-tuna" });
    itemDeleteMany.mockResolvedValue({ count: 1 });

    const events = await deleteEmployeeRecord(talId, "item-tuna", employeeId);

    expect(itemDelete).toHaveBeenCalledWith({ where: { id: "item-tuna" } });
    expect(events[0]?.notifyEmployeeIds).toEqual([talId]);
    expect(events[0]?.metadata.lists[0]?.action).toBe("remove");
    expect(events[0]?.purchased).toBeUndefined();
  });
});
