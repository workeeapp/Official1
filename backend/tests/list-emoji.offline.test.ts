import { describe, expect, it, vi, beforeEach } from "vitest";
import type { LlmListOp, PublicEmployee } from "@workee/shared";
import {
  CUSTOM_LIST_EMOJI_DEFAULT,
  effectiveListEmoji,
  emojiForNewCustomList,
  normalizeListEmoji,
} from "../src/services/list-emoji.js";
import { formatShowDumpFromKind } from "../src/services/show-button-dump.js";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";

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

vi.mock("../src/services/attachment.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/attachment.service.js")>();
  return {
    ...actual,
    applyAttachmentLinks: vi.fn(),
  };
});

vi.mock("../src/services/reminder.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/reminder.service.js")>()),
  cancelReminderLinkedToWorkerItem,
  cancelActiveRemindersMatchingWork,
}));

import { applyListOps } from "../src/services/list-ops.service.js";
import { parseReplyMetadata } from "@workee/shared";

const amitId = "415ff13e-38d0-4dee-98b5-71e5dd11a38d";
const listId = "9b2f6c1e-2d6a-4a7b-9c3e-1f0a2b3c4d5e";

function person(id: string, name: string): PublicEmployee {
  return {
    id,
    kind: "human",
    name,
    surname: "",
    nickname: null,
    email: null,
    phone: null,
  };
}

const amit = person(amitId, "עמית");

function alterOp(fields: Partial<LlmListOp>): LlmListOp {
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

function listRow(
  listType: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id: listId,
    employeeId: amitId,
    listType,
    name,
    emoji: null as string | null,
    titleField: listType === "custom" ? "שם" : "",
    columns: listType === "custom" ? ["שם"] : [],
    hiddenColumns: [],
    scope: "personal",
    visibleTo: [],
    deletedAt: null,
    employee: { id: amitId, kind: "human" },
    items: [],
    ...extra,
  };
}

describe("list-emoji helpers", () => {
  it("resolves builtin canonical defaults when stored is null", () => {
    expect(effectiveListEmoji({ listType: "shopping", storedEmoji: null })).toBe(
      "🛒",
    );
    expect(effectiveListEmoji({ listType: "tasks", storedEmoji: null })).toBe(
      "✅",
    );
    expect(effectiveListEmoji({ listType: "contacts", storedEmoji: null })).toBe(
      "👤",
    );
    expect(effectiveListEmoji({ listType: "custom", storedEmoji: null })).toBe(
      CUSTOM_LIST_EMOJI_DEFAULT,
    );
  });

  it("prefers a stored override and accepts multi-codepoint emoji", () => {
    expect(
      effectiveListEmoji({ listType: "shopping", storedEmoji: "🛍️" }),
    ).toBe("🛍️");
    expect(normalizeListEmoji(" 👨‍👩‍👧‍👦 ")).toBe("👨‍👩‍👧‍👦");
  });

  it("falls back to 📋 on custom create when emoji omitted/invalid", () => {
    expect(emojiForNewCustomList(undefined)).toBe("📋");
    expect(emojiForNewCustomList("")).toBe("📋");
    expect(emojiForNewCustomList(12)).toBe("📋");
    expect(emojiForNewCustomList("🐛")).toBe("🐛");
  });
});

describe("list-emoji alter_list apply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listUpdate.mockResolvedValue({});
    recordAuditEvent.mockResolvedValue(undefined);
  });

  it("allows emoji-only override on shopping without structural share", async () => {
    listFindFirst.mockResolvedValue(listRow("shopping", ""));
    const [result] = await applyListOps({
      userId: "u1",
      actor: amit,
      employees: [amit],
      ops: [alterOp({ emoji: "🛍️" })],
    });
    expect(result.applied).toBe(true);
    expect(listUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ emoji: "🛍️" }),
      }),
    );
  });

  it("clears override to null on restore (emoji:null)", async () => {
    listFindFirst.mockResolvedValue(listRow("tasks", "", { emoji: "📌" }));
    const [result] = await applyListOps({
      userId: "u1",
      actor: amit,
      employees: [amit],
      ops: [alterOp({ emoji: null })],
    });
    expect(result.applied).toBe(true);
    expect(listUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ emoji: null }),
      }),
    );
  });

  it("omitted emoji does not clear an existing override", async () => {
    listFindFirst
      .mockResolvedValueOnce(listRow("custom", "בעיות", { emoji: "🐛" }))
      .mockResolvedValueOnce(null); // rename clash check
    const [result] = await applyListOps({
      userId: "u1",
      actor: amit,
      employees: [amit],
      ops: [alterOp({ newName: "באגים" })],
    });
    expect(result.applied).toBe(true);
    const data = listUpdate.mock.calls[0]?.[0]?.data ?? {};
    expect(data).not.toHaveProperty("emoji");
    expect(data).toEqual(expect.objectContaining({ name: "באגים" }));
  });

  it("still refuses structural alter on shopping", async () => {
    listFindFirst.mockResolvedValue(listRow("shopping", ""));
    const [result] = await applyListOps({
      userId: "u1",
      actor: amit,
      employees: [amit],
      ops: [alterOp({ newName: "סופר", emoji: "🛒" })],
    });
    expect(result.applied).toBe(false);
    expect(result.refusal?.reason).toBe("builtin");
    expect(listUpdate).not.toHaveBeenCalled();
  });
});

describe("list-emoji parse + dump", () => {
  it("parses alter_list emoji set and clear; omit leaves undefined", () => {
    const set = parseReplyMetadata(
      JSON.stringify({
        responses: [{ text: "ok" }],
        metadata: {
          lists: [
            { action: "alter_list", list_id: "l1", emoji: " 🛒 ", items: [] },
          ],
        },
      }),
    );
    expect(set.listOps?.[0]?.emoji).toBe("🛒");

    const clear = parseReplyMetadata(
      JSON.stringify({
        responses: [{ text: "ok" }],
        metadata: {
          lists: [
            { action: "alter_list", list_id: "l1", emoji: null, items: [] },
          ],
        },
      }),
    );
    expect(clear.listOps?.[0]?.emoji).toBeNull();

    const omit = parseReplyMetadata(
      JSON.stringify({
        responses: [{ text: "ok" }],
        metadata: {
          lists: [
            { action: "alter_list", list_id: "l1", new_name: "א", items: [] },
          ],
        },
      }),
    );
    expect(omit.listOps?.[0]).not.toHaveProperty("emoji");
  });

  it("recommendation-only / ambiguous cases are no-mutation (empty lists)", () => {
    const recommend = parseReplyMetadata(
      JSON.stringify({
        responses: [{ text: "אפשר 🛒 ליד הקניות" }],
        metadata: { lists: [] },
      }),
    );
    expect(recommend.lists).toEqual([]);
    expect(recommend.listOps ?? []).toEqual([]);

    const ask = parseReplyMetadata(
      JSON.stringify({
        responses: [{ text: "לאיזו רשימה?" }],
        metadata: { lists: [] },
      }),
    );
    expect(ask.listOps ?? []).toEqual([]);
  });

  it("dump headers use effective emoji (default and override)", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          emoji: "🛒",
          owner: "עמית",
          scope: "personal",
          items: [{ item_id: "i1", "שם פריט": "חלב" }],
        },
        {
          list_type: "tasks",
          emoji: "📌",
          owner: "עמית",
          scope: "personal",
          items: [{ item_id: "i2", "שם מטלה": "להתקשר" }],
        },
        {
          list_type: "custom",
          list_name: "בעיות",
          emoji: "🐛",
          owner: "עמית",
          scope: "personal",
          items: [{ item_id: "i3", שם: "באג" }],
        },
      ],
      filing: [],
    };
    expect(formatShowDumpFromKind("shopping", snap)).toMatch(/^🛒 קניות:/m);
    expect(formatShowDumpFromKind("tasks", snap)).toMatch(/^📌 מטלות:/m);
    expect(formatShowDumpFromKind("בעיות", snap)).toMatch(/^🐛 רשימת «בעיות»:/m);
  });

  it("phone_book dump uses 👤 אנשי קשר header", () => {
    const snap: EmployeeRecordSnapshot = { lists: [], filing: [] };
    expect(
      formatShowDumpFromKind("contacts", snap, {
        phoneBook: [{ contact_id: "c1", name: "דני", phone: "050" }],
      }),
    ).toMatch(/^👤 אנשי קשר:/m);
  });

  it("full dump headers reuse list emoji; custom counts too", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          emoji: "🛍️",
          owner: "עמית",
          scope: "personal",
          items: [{ item_id: "s1", "שם פריט": "חלב" }],
        },
        {
          list_type: "tasks",
          emoji: "✅",
          owner: "עמית",
          scope: "personal",
          items: [{ item_id: "t1", "שם מטלה": "להתקשר" }],
        },
        {
          list_type: "custom",
          list_name: "בעיות",
          emoji: "🐛",
          owner: "עמית",
          scope: "personal",
          items: [{ item_id: "c1", שם: "באג" }],
        },
      ],
      filing: [],
    };
    const full = formatShowDumpFromKind("full", snap, {
      phoneBook: [{ contact_id: "p1", name: "דני", phone: "050" }],
    })!;
    expect(full).toMatch(/^🛍️ קניות:/m);
    expect(full).toMatch(/^✅ מטלות:/m);
    expect(full).toContain("🐛 *בעיות*");
    expect(full).toMatch(/^👤 אנשי קשר:/m);
  });

  it("filtered shared/partner dump keeps source emoji and co-share marks", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          emoji: "🛒",
          owner: "עמית",
          scope: "personal",
          items: [
            { item_id: "s1", "שם פריט": "חלב" },
            {
              item_id: "s2",
              "שם פריט": "לחם",
              shared_with: ["עמית", "מיכל"],
            },
          ],
        },
      ],
      filing: [],
    };
    const shared = formatShowDumpFromKind("shopping", snap, {
      section: "shared",
      viewerName: "עמית",
    })!;
    expect(shared).toMatch(/^🛒 קניות:/m);
    expect(shared).toContain("לחם");
    expect(shared).toContain("(מיכל, עמית)");
    expect(shared).not.toContain("חלב");

    const overridden: EmployeeRecordSnapshot = {
      ...snap,
      lists: snap.lists.map((list) =>
        list.list_type === "shopping" ? { ...list, emoji: "🛍️" } : list,
      ),
    };
    const after = formatShowDumpFromKind("shopping", overridden, {
      section: "shared",
      viewerName: "עמית",
    })!;
    expect(after).toMatch(/^🛍️ קניות:/m);
    expect(after).toContain("(מיכל, עמית)");
    expect(after).toContain("לחם");
  });

  it("item dump / assign slice reuse source-list emoji; marks unchanged", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          emoji: "📌",
          owner: "מיכל",
          scope: "personal",
          items: [
            {
              item_id: "t1",
              "שם מטלה": "לטפל בעמידר",
              assigned_by: "עמית",
            },
            { item_id: "t2", "שם מטלה": "אישית" },
          ],
        },
        {
          list_type: "shopping",
          emoji: "🛍️",
          owner: "עמית",
          scope: "personal",
          items: [
            { item_id: "s-keep", "שם פריט": "חלב" },
            { item_id: "s-other", "שם פריט": "לחם" },
          ],
        },
      ],
      filing: [],
    };

    const assign = formatShowDumpFromKind("tasks", snap, {
      section: "shared",
      assignee: "מיכל",
      collaboration: "assign",
      viewerName: "מיכל",
    })!;
    expect(assign).toMatch(/^📌 מטלות:/m);
    expect(assign).toContain("לטפל בעמידר");
    expect(assign).toContain("(באחריות מיכל · מאת עמית)");
    expect(assign).not.toContain("אישית");

    const item = formatShowDumpFromKind("shopping", snap, {
      itemIds: new Set(["s-keep"]),
      omitEmptySentence: true,
      viewerName: "עמית",
    })!;
    expect(item).toMatch(/^🛍️ קניות:/m);
    expect(item).toContain("חלב");
    expect(item).not.toContain("לחם");
  });

  it("item dump picks emoji from the source shell when several shopping lists exist", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          emoji: "🛒",
          owner: "עמית",
          scope: "personal",
          items: [{ item_id: "mine", "שם פריט": "חלב" }],
        },
        {
          list_type: "shopping",
          emoji: "🛍️",
          owner: "מיכל",
          scope: "shared",
          shared_with: ["עמית", "מיכל"],
          items: [{ item_id: "theirs", "שם פריט": "יין" }],
        },
      ],
      filing: [],
    };
    const theirs = formatShowDumpFromKind("shopping", snap, {
      itemIds: new Set(["theirs"]),
      omitEmptySentence: true,
      viewerName: "עמית",
    })!;
    expect(theirs).toMatch(/^🛍️ קניות:/m);
    expect(theirs).toContain("יין");
    expect(theirs).not.toContain("חלב");

    const mine = formatShowDumpFromKind("shopping", snap, {
      itemIds: new Set(["mine"]),
      omitEmptySentence: true,
      viewerName: "עמית",
    })!;
    expect(mine).toMatch(/^🛒 קניות:/m);
    expect(mine).toContain("חלב");
  });

  it("day-agenda tasks dump has no list header today (date headers only)", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          emoji: "📌",
          owner: "עמית",
          scope: "personal",
          items: [
            {
              item_id: "t1",
              "שם מטלה": "פגישה",
              "תאריך לביצוע": "2026-10-18",
              "שעה לביצוע": "10:00",
            },
          ],
        },
      ],
      filing: [],
    };
    const agenda = formatShowDumpFromKind("tasks", snap, {
      dateFrom: "2026-10-18",
      dateTo: "2026-10-18",
      viewerName: "עמית",
    })!;
    expect(agenda).not.toMatch(/📌 מטלות:/);
    expect(agenda).not.toMatch(/^מטלות:/m);
    expect(agenda).toContain("פגישה");
  });
});
