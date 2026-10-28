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

import { emptyLlmMetadata, type LlmMetadata } from "@workee/shared";
import {
  applyListItemListLinks,
  fillBlankCustomListNameFromSameTurnLinks,
  isUnresolvedLinkOnlyUpdate,
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

describe("fillBlankCustomListNameFromSameTurnLinks", () => {
  const hostId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  function blankCreateAndLink(linkNames: string[]): LlmMetadata {
    return {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add",
          listType: "custom",
          listName: "",
          items: [{ שם: "עוגה" }, { שם: "שתייה" }],
          targets: [],
        },
        {
          action: "update",
          listType: "tasks",
          listName: "",
          items: [
            {
              item_id: hostId,
              linked_lists: linkNames.map((list_name) => ({
                list_type: "custom",
                list_name,
              })),
            },
          ],
          targets: [],
        },
      ],
    };
  }

  it("copies the sole unambiguous linked_lists name onto blank custom create", () => {
    const name = "כיבוד · ערב יום הולדת";
    const out = fillBlankCustomListNameFromSameTurnLinks(
      blankCreateAndLink([name]),
    );
    expect(out.lists?.[0]?.listName).toBe(name);
    expect(out.lists?.[1]?.listName).toBe("");
  });

  it("leaves blank create unchanged when link names are missing or ambiguous", () => {
    expect(
      fillBlankCustomListNameFromSameTurnLinks(blankCreateAndLink([])).lists?.[0]
        ?.listName,
    ).toBe("");
    expect(
      fillBlankCustomListNameFromSameTurnLinks(
        blankCreateAndLink(["כיבוד · א", "מי מגיע · א"]),
      ).lists?.[0]?.listName,
    ).toBe("");
  });

  it("does not rename built-in shopping adds or already-named custom creates", () => {
    const shopping: LlmMetadata = {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          items: [{ "שם פריט": "חלב" }],
          targets: [],
        },
        {
          action: "update",
          listType: "tasks",
          listName: "",
          items: [
            {
              item_id: hostId,
              linked_lists: [
                { list_type: "custom", list_name: "כיבוד · ערב יום הולדת" },
              ],
            },
          ],
          targets: [],
        },
      ],
    };
    expect(fillBlankCustomListNameFromSameTurnLinks(shopping).lists?.[0]).toEqual(
      shopping.lists?.[0],
    );

    const named = blankCreateAndLink(["כיבוד · ערב יום הולדת"]);
    named.lists![0]!.listName = "כיבוד · ערב יום הולדת";
    expect(fillBlankCustomListNameFromSameTurnLinks(named).lists?.[0]?.listName).toBe(
      "כיבוד · ערב יום הולדת",
    );
  });

  it("refuses fill when two blank custom creates share one link name", () => {
    const meta: LlmMetadata = {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add",
          listType: "custom",
          listName: "",
          items: [{ שם: "עוגה" }],
          targets: [],
        },
        {
          action: "add",
          listType: "custom",
          listName: "",
          items: [{ שם: "שתייה" }],
          targets: [],
        },
        {
          action: "update",
          listType: "tasks",
          listName: "",
          items: [
            {
              item_id: hostId,
              linked_lists: [
                { list_type: "custom", list_name: "כיבוד · ערב יום הולדת" },
              ],
            },
          ],
          targets: [],
        },
      ],
    };
    const out = fillBlankCustomListNameFromSameTurnLinks(meta);
    expect(out.lists?.[0]?.listName).toBe("");
    expect(out.lists?.[1]?.listName).toBe("");
  });
});

describe("isUnresolvedLinkOnlyUpdate", () => {
  const base = {
    contentFieldChanged: false,
    occurrenceChanged: false,
    hasDoneDate: false,
    visibilityUnchanged: true,
    shareIntent: false,
    attachmentLinked: 0,
    attachmentDetached: 0,
    requestedLinkOrUnlink: true,
    linked: 0,
    detached: 0,
  };

  it("is true when only requested change was an unresolved list link", () => {
    expect(isUnresolvedLinkOnlyUpdate(base)).toBe(true);
  });

  it("is false when a link was created or other fields changed", () => {
    expect(isUnresolvedLinkOnlyUpdate({ ...base, linked: 1 })).toBe(false);
    expect(
      isUnresolvedLinkOnlyUpdate({ ...base, contentFieldChanged: true }),
    ).toBe(false);
    expect(isUnresolvedLinkOnlyUpdate({ ...base, detached: 1 })).toBe(false);
    expect(
      isUnresolvedLinkOnlyUpdate({ ...base, requestedLinkOrUnlink: false }),
    ).toBe(false);
  });
});

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
