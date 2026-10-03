import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  employeeFindUnique,
  employeeFindMany,
  listFindMany,
  itemFindMany,
  filingFindMany,
  reminderFindMany,
} = vi.hoisted(() => ({
  employeeFindUnique: vi.fn(),
  employeeFindMany: vi.fn(),
  listFindMany: vi.fn(),
  itemFindMany: vi.fn(),
  filingFindMany: vi.fn(),
  reminderFindMany: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    employee: {
      findUnique: employeeFindUnique,
      findMany: employeeFindMany,
    },
    employeeList: { findMany: listFindMany },
    employeeListItem: { findMany: itemFindMany },
    employeeFiling: { findMany: filingFindMany },
    reminder: { findMany: reminderFindMany },
  },
}));

import { getEmployeeRecordSnapshot } from "../src/services/employee-records.service.js";

const talId = "tal-id";
const amitId = "amit-id";
const userId = "user-id";

describe("account owner visibility", () => {
  beforeEach(() => {
    employeeFindUnique.mockReset();
    employeeFindMany.mockReset();
    listFindMany.mockReset();
    itemFindMany.mockReset();
    filingFindMany.mockReset();
    reminderFindMany.mockReset();
  });

  it("limits a non-owner snapshot to their own clocks", async () => {
    employeeFindUnique.mockResolvedValue({
      userId,
      isOwner: false,
      kind: "human",
    });
    listFindMany.mockResolvedValue([]);
    itemFindMany.mockResolvedValue([]);
    filingFindMany.mockResolvedValue([]);
    reminderFindMany.mockResolvedValue([
      {
        itemLabel: "לשתות מים",
        itemKey: "לשתות מים",
        listType: "tasks",
        fireAt: new Date("2026-09-28T10:00:00.000Z"),
        status: "active",
        sendStatus: "pending",
        sentAt: null,
        repeat: "once",
        pingIds: [talId],
        messageText: "",
        ownerId: talId,
        actorId: amitId,
      },
      {
        itemLabel: "לפהק",
        itemKey: "לפהק",
        listType: "tasks",
        fireAt: new Date("2026-09-28T11:00:00.000Z"),
        status: "active",
        sendStatus: "pending",
        sentAt: null,
        repeat: "once",
        pingIds: [amitId],
        messageText: "",
        ownerId: amitId,
        actorId: amitId,
      },
    ]);
    employeeFindMany.mockResolvedValue([
      { id: talId, name: "טל", nickname: "טל", surname: "" },
      { id: amitId, name: "עמית", nickname: "עמית", surname: "" },
    ]);

    const snapshot = await getEmployeeRecordSnapshot(talId);
    expect(snapshot.reminders?.map((row) => row.item)).toEqual(["לשתות מים"]);
    expect(listFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { employeeId: talId } }),
    );
  });

  it("gives the account owner every human list and every clock", async () => {
    employeeFindUnique.mockResolvedValue({
      userId,
      isOwner: true,
      kind: "human",
    });
    listFindMany.mockResolvedValue([
      {
        listType: "tasks",
        name: "",
        employee: { id: amitId, name: "עמית", nickname: "עמית" },
        items: [
          {
            id: "1",
            itemKey: "חלב",
            data: { "שם מטלה": "לקנות חלב" },
            scope: "personal",
            addedById: amitId,
            visibleTo: [amitId],
            createdAt: new Date(),
          },
        ],
      },
    ]);
    filingFindMany.mockResolvedValue([]);
    reminderFindMany.mockResolvedValue([
      {
        itemLabel: "לפהק",
        itemKey: "לפהק",
        listType: "tasks",
        fireAt: new Date("2026-09-28T11:00:00.000Z"),
        status: "active",
        sendStatus: "pending",
        sentAt: null,
        repeat: "once",
        pingIds: [amitId],
        messageText: "",
        ownerId: amitId,
        actorId: amitId,
      },
    ]);
    employeeFindMany.mockResolvedValue([
      { id: talId, name: "טל", nickname: "טל", surname: "" },
      { id: amitId, name: "עמית", nickname: "עמית", surname: "" },
    ]);

    const snapshot = await getEmployeeRecordSnapshot(talId);
    expect(snapshot.reminders?.map((row) => row.item)).toEqual(["לפהק"]);
    expect(snapshot.lists[0]?.owner).toBe("עמית");
    expect(listFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { employee: { userId, kind: "human" } },
      }),
    );
    expect(itemFindMany).not.toHaveBeenCalled();
  });
});
