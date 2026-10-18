import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  employeeFindUnique,
  listFindMany,
  linkFindUnique,
  linkCreate,
  linkDeleteMany,
  linkFindMany,
  auditCreate,
} = vi.hoisted(() => ({
  employeeFindUnique: vi.fn(),
  listFindMany: vi.fn(),
  linkFindUnique: vi.fn(),
  linkCreate: vi.fn(),
  linkDeleteMany: vi.fn(),
  linkFindMany: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    employee: { findUnique: employeeFindUnique },
    employeeList: { findMany: listFindMany },
    listItemListLink: {
      findUnique: linkFindUnique,
      create: linkCreate,
      deleteMany: linkDeleteMany,
      findMany: linkFindMany,
    },
    auditEvent: { create: auditCreate },
  },
}));

import {
  applyListItemListLinks,
  splitItemListLinks,
  withLinkedListRefs,
} from "../src/services/list-item-list-link.service.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const TASK_ITEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOST_LIST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SHOP_LIST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CUSTOM_LIST = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_USER_LIST = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

describe("splitItemListLinks", () => {
  it("strips link fields from item data", () => {
    const result = splitItemListLinks({
      item_id: TASK_ITEM,
      "שם מטלה": "ערב פוקר",
      linked_list_ids: [SHOP_LIST, CUSTOM_LIST],
      linked_lists: [{ list_type: "custom", list_name: "מי מגיע" }],
      unlink_list_ids: [SHOP_LIST],
    });
    expect(result.item).toEqual({
      item_id: TASK_ITEM,
      "שם מטלה": "ערב פוקר",
    });
    expect(result.linkedListIds).toEqual([SHOP_LIST, CUSTOM_LIST]);
    expect(result.linkedLists).toEqual([
      { listType: "custom", listName: "מי מגיע" },
    ]);
    expect(result.unlinkListIds).toEqual([SHOP_LIST]);
  });
});

describe("applyListItemListLinks", () => {
  beforeEach(() => {
    employeeFindUnique.mockReset();
    listFindMany.mockReset();
    linkFindUnique.mockReset();
    linkCreate.mockReset();
    linkDeleteMany.mockReset();
    auditCreate.mockReset();
    employeeFindUnique.mockResolvedValue({
      id: ACTOR,
      userId: USER,
      isOwner: false,
    });
    linkFindUnique.mockResolvedValue(null);
    linkCreate.mockResolvedValue({});
    linkDeleteMany.mockResolvedValue({ count: 0 });
    auditCreate.mockResolvedValue({});
  });

  it("links shopping/custom lists onto a tasks host and audits", async () => {
    listFindMany.mockResolvedValue([
      {
        id: SHOP_LIST,
        employeeId: ACTOR,
        scope: "personal",
        visibleTo: [],
      },
      {
        id: CUSTOM_LIST,
        employeeId: ACTOR,
        scope: "personal",
        visibleTo: [],
      },
    ]);

    const result = await applyListItemListLinks({
      actorId: ACTOR,
      listItemId: TASK_ITEM,
      hostListId: HOST_LIST,
      hostListType: "tasks",
      linkedListIds: [SHOP_LIST, CUSTOM_LIST],
    });

    expect(result).toEqual({ linked: 2, detached: 0 });
    expect(linkCreate).toHaveBeenCalledTimes(2);
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "list_item_list_link",
          entityId: TASK_ITEM,
        }),
      }),
    );
  });

  it("refuses non-tasks hosts", async () => {
    const result = await applyListItemListLinks({
      actorId: ACTOR,
      listItemId: TASK_ITEM,
      hostListId: HOST_LIST,
      hostListType: "shopping",
      linkedListIds: [SHOP_LIST],
    });
    expect(result).toEqual({ linked: 0, detached: 0 });
    expect(listFindMany).not.toHaveBeenCalled();
    expect(linkCreate).not.toHaveBeenCalled();
  });

  it("does not link lists the actor cannot see (no auto-share)", async () => {
    listFindMany.mockResolvedValue([
      {
        id: OTHER_USER_LIST,
        employeeId: "99999999-9999-4999-8999-999999999999",
        scope: "personal",
        visibleTo: [],
      },
    ]);

    const result = await applyListItemListLinks({
      actorId: ACTOR,
      listItemId: TASK_ITEM,
      hostListId: HOST_LIST,
      hostListType: "tasks",
      linkedListIds: [OTHER_USER_LIST],
    });
    expect(result).toEqual({ linked: 0, detached: 0 });
    expect(linkCreate).not.toHaveBeenCalled();
  });

  it("resolves same-turn linked_lists by name and unlinks by id", async () => {
    listFindMany.mockResolvedValue([
      {
        id: CUSTOM_LIST,
        employeeId: ACTOR,
        scope: "personal",
        visibleTo: [],
      },
    ]);
    linkDeleteMany.mockResolvedValue({ count: 1 });

    const result = await applyListItemListLinks({
      actorId: ACTOR,
      listItemId: TASK_ITEM,
      hostListId: HOST_LIST,
      hostListType: "tasks",
      linkedLists: [{ listType: "custom", listName: "מי מגיע" }],
      unlinkListIds: [SHOP_LIST],
    });

    expect(result).toEqual({ linked: 1, detached: 1 });
    expect(linkCreate).toHaveBeenCalledWith({
      data: {
        listItemId: TASK_ITEM,
        listId: CUSTOM_LIST,
        addedById: ACTOR,
      },
    });
    expect(linkDeleteMany).toHaveBeenCalledWith({
      where: {
        listItemId: TASK_ITEM,
        listId: { in: [SHOP_LIST] },
      },
    });
  });

  it("skips linking the host's own parent list", async () => {
    listFindMany.mockResolvedValue([
      {
        id: HOST_LIST,
        employeeId: ACTOR,
        scope: "personal",
        visibleTo: [],
      },
    ]);
    const result = await applyListItemListLinks({
      actorId: ACTOR,
      listItemId: TASK_ITEM,
      hostListId: HOST_LIST,
      hostListType: "tasks",
      linkedListIds: [HOST_LIST],
    });
    expect(result).toEqual({ linked: 0, detached: 0 });
    expect(linkCreate).not.toHaveBeenCalled();
  });
});

describe("withLinkedListRefs", () => {
  beforeEach(() => {
    linkFindMany.mockReset();
  });

  it("decorates task items and reverse list refs", async () => {
    linkFindMany.mockResolvedValue([
      {
        listItemId: TASK_ITEM,
        listId: CUSTOM_LIST,
        list: { id: CUSTOM_LIST, listType: "custom", name: "מי מגיע" },
        listItem: {
          id: TASK_ITEM,
          itemKey: "ערב פוקר",
          data: { "שם מטלה": "ערב פוקר" },
          list: { listType: "tasks", titleField: "" },
        },
      },
    ]);

    const snapshot = await withLinkedListRefs({
      lists: [
        {
          list_id: HOST_LIST,
          list_type: "tasks",
          items: [{ item_id: TASK_ITEM, "שם מטלה": "ערב פוקר" }],
        },
        {
          list_id: CUSTOM_LIST,
          list_type: "custom",
          list_name: "מי מגיע",
          items: [{ item_id: "guest1", שם: "דני" }],
        },
      ],
    });

    expect(snapshot.lists[0]?.items[0]).toMatchObject({
      linked_lists: [
        {
          list_id: CUSTOM_LIST,
          list_type: "custom",
          list_name: "מי מגיע",
        },
      ],
    });
    expect(snapshot.lists[1]).toMatchObject({
      linked_from_items: [
        { item_id: TASK_ITEM, list_type: "tasks", title: "ערב פוקר" },
      ],
    });
  });
});
