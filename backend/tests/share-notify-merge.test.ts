import { describe, expect, it } from "vitest";
import { emptyLlmMetadata, type PublicEmployee } from "@workee/shared";
import { mergeEventsForTargetNotify } from "../src/services/chat.service.js";
import { fallbackNotificationText } from "../src/services/employee-targets.service.js";
import type { SharedItemEvent } from "../src/services/employee-records.service.js";

const michal: PublicEmployee = {
  id: "michal-id",
  name: "מיכל",
  surname: "",
  nickname: "מיכל",
  email: null,
  phone: null,
};

const talId = "tal-id";
const michalId = "michal-id";

function shoppingShareEvent(
  itemId: string,
  title: string,
): SharedItemEvent {
  return {
    notifyEmployeeIds: [talId],
    listOwnerId: michalId,
    addedById: michalId,
    shared: true,
    metadata: {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "update",
          listType: "shopping",
          listName: "",
          targets: [],
          items: [{ item_id: itemId, "שם פריט": title }],
        },
      ],
    },
  };
}

describe("mergeEventsForTargetNotify", () => {
  it("merges three shared shopping events into one metadata", () => {
    const merged = mergeEventsForTargetNotify(
      [
        shoppingShareEvent("1", "שמן זית"),
        shoppingShareEvent("2", "רסק"),
        shoppingShareEvent("3", "אורז"),
      ],
      talId,
    );
    expect(merged.shared).toBe(true);
    expect(merged.metadata.lists).toHaveLength(1);
    expect(merged.metadata.lists[0]!.items).toHaveLength(3);
    expect(
      fallbackNotificationText(michal, merged.metadata, {
        shared: true,
        recipientIsOwner: false,
        recipientIsPartner: true,
        ownerName: "מיכל",
      }),
    ).toBe("מיכל שיתף איתך שמן זית ורסק ואורז ברשימת הקניות");
  });

  it("merges unshared events the same way", () => {
    const events = ["שמן זית", "רסק", "אורז"].map((title, i) => ({
      ...shoppingShareEvent(String(i + 1), title),
      shared: undefined,
      unshared: true,
    }));
    const merged = mergeEventsForTargetNotify(events, talId);
    expect(merged.unshared).toBe(true);
    expect(
      fallbackNotificationText(michal, merged.metadata, {
        unshared: true,
        recipientIsOwner: false,
        recipientIsPartner: true,
      }),
    ).toBe("מיכל הפסיק לשתף איתך שמן זית ורסק ואורז מרשימת הקניות");
  });

  it("prefers purchased over shared and does not merge across classes", () => {
    const purchased: SharedItemEvent = {
      notifyEmployeeIds: [talId],
      listOwnerId: michalId,
      purchased: true,
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "remove",
            listType: "shopping",
            listName: "",
            targets: [],
            items: [{ item_id: "p1", "שם פריט": "חלב" }],
          },
        ],
      },
    };
    const merged = mergeEventsForTargetNotify(
      [shoppingShareEvent("1", "שמן זית"), purchased, shoppingShareEvent("2", "רסק")],
      talId,
    );
    expect(merged.purchased).toBe(true);
    expect(merged.shared).toBeUndefined();
    expect(merged.metadata.lists[0]!.items).toHaveLength(1);
    expect(merged.metadata.lists[0]!.items[0]).toMatchObject({
      "שם פריט": "חלב",
    });
  });

  it("dedupes the same item_id when merging", () => {
    const merged = mergeEventsForTargetNotify(
      [
        shoppingShareEvent("1", "שמן זית"),
        shoppingShareEvent("1", "שמן זית"),
        shoppingShareEvent("2", "רסק"),
      ],
      talId,
    );
    expect(merged.metadata.lists[0]!.items).toHaveLength(2);
  });
});
