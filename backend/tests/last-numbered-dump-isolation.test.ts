/**
 * Regression: shopping dump → custom-list show → delete 1,2 must not hit shopping.
 * Root cause was free-written custom inventory leaving a stale shopping LAST_NUMBERED_DUMP.
 */
import { describe, expect, it } from "vitest";
import {
  packAssistantLlmRawForTests,
  pickLastNumberedDumpFromAssistantRaws,
} from "../src/services/chat.service.js";
import {
  emptyLlmMetadata,
  type LlmListAction,
  type PublicEmployee,
} from "@workee/shared";
import {
  formatShowDumpWithLineMap,
  looksLikeFreeWrittenNumberedInventory,
  mapShowButtonCommandToDump,
  restrictListMutatesToLastNumberedDump,
  type LastNumberedDumpLine,
} from "../src/services/show-button-dump.js";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";
import { planTargetedActions } from "../src/services/employee-targets.service.js";

const shoppingId1 = "shop-glida";
const shoppingId2 = "shop-skazi";
const customId1 = "custom-vcard";
const customId2 = "custom-share-bug";
const customId3 = "custom-geo";

const snap: EmployeeRecordSnapshot = {
  lists: [
    {
      list_type: "shopping",
      list_name: "",
      owner: "טל",
      scope: "personal",
      items: [
        { item_id: shoppingId1, "שם פריט": "גלידה", כמות: "1" },
        { item_id: shoppingId2, "שם פריט": "חטיף לסקאזי", כמות: "1" },
      ],
    },
    {
      list_type: "custom",
      list_name: "משימות לטל",
      owner: "טל",
      scope: "personal",
      title_field: "שם",
      columns: ["שם"],
      items: [
        { item_id: customId1, שם: "תמיכה מלאה באנשי קשר בהתאם לvcard" },
        { item_id: customId2, שם: "באג לא ניתן לעדכן משימה משותפת" },
        { item_id: customId3, שם: "תמיכה בזיהוי כתובת/עיר לפי קואורדינטות" },
      ],
    },
  ],
  filing: [],
};

describe("LAST_NUMBERED_DUMP isolation after intervening custom dump", () => {
  it("allowlists free-typed «הצג משימות לטל» to the custom list", () => {
    expect(mapShowButtonCommandToDump("הצג משימות לטל", snap)).toBe(
      "משימות לטל",
    );
  });

  it("custom show_dump line map uses custom item_ids (not shopping)", () => {
    const shopping = formatShowDumpWithLineMap("shopping", snap);
    expect(shopping.lines.map((row) => row.id)).toEqual([
      shoppingId1,
      shoppingId2,
    ]);
    expect(shopping.lines.every((row) => row.kind === "shopping")).toBe(true);

    const custom = formatShowDumpWithLineMap("משימות לטל", snap);
    expect(custom.text).toContain("משימות לטל");
    expect(custom.text).toContain("«");
    expect(custom.lines.map((row) => row.id)).toEqual([
      customId1,
      customId2,
      customId3,
    ]);
    expect(custom.lines.every((row) => row.kind === "custom")).toBe(true);
  });

  it("newest custom dump map wins over older shopping map", () => {
    const shoppingRaw = packAssistantLlmRawForTests({
      lastNumberedDump: [
        {
          n: 1,
          id: shoppingId1,
          kind: "shopping",
          title_stem: "גלידה",
        },
        {
          n: 2,
          id: shoppingId2,
          kind: "shopping",
          title_stem: "חטיף לסקאזי",
        },
      ],
    });
    const customRaw = packAssistantLlmRawForTests({
      lastNumberedDump: [
        {
          n: 1,
          id: customId1,
          kind: "custom",
          title_stem: "תמיכה מלאה באנשי קשר בהתאם לvcard",
        },
        {
          n: 2,
          id: customId2,
          kind: "custom",
          title_stem: "באג לא ניתן לעדכן משימה משותפת",
        },
      ],
    });
    const picked = pickLastNumberedDumpFromAssistantRaws([
      customRaw,
      shoppingRaw,
    ]);
    expect(picked.map((row) => row.id)).toEqual([customId1, customId2]);
    expect(picked.map((row) => row.id)).not.toContain(shoppingId1);
  });

  it("detects model-written custom inventory without server guillemets", () => {
    const freeWritten = [
      "📋 רשימת משימות לטל:",
      "1. תמיכה מלאה באנשי קשר בהתאם לvcard",
      "2. באג לא ניתן לעדכן משימה משותפת",
      "3. תמיכה בזיהוי כתובת/עיר לפי קואורדינטות",
    ].join("\n");
    expect(looksLikeFreeWrittenNumberedInventory(freeWritten)).toBe(true);
    expect(
      looksLikeFreeWrittenNumberedInventory("מחקתי את הגלידה מרשימת הקניות."),
    ).toBe(false);
  });

  it("free-written inventory tombstone clears stale shopping LAST_NUMBERED_DUMP", () => {
    const shoppingRaw = packAssistantLlmRawForTests({
      lastNumberedDump: [
        {
          n: 1,
          id: shoppingId1,
          kind: "shopping",
          title_stem: "גלידה",
        },
        {
          n: 2,
          id: shoppingId2,
          kind: "shopping",
          title_stem: "חטיף לסקאזי",
        },
      ],
    });
    const freeWrittenRaw = packAssistantLlmRawForTests({
      response: {
        responses: [
          {
            text: [
              "📋 רשימת משימות לטל:",
              "1. תמיכה מלאה באנשי קשר בהתאם לvcard",
              "2. באג לא ניתן לעדכן משימה משותפת",
            ].join("\n"),
          },
        ],
      },
      lastNumberedDumpCleared: true,
    });
    // Newest-first: cleared tombstone must NOT fall through to shopping.
    expect(
      pickLastNumberedDumpFromAssistantRaws([freeWrittenRaw, shoppingRaw]),
    ).toEqual([]);
  });

  it("delete-by-index after custom dump must copy custom ids 1,2 only", () => {
    const custom = formatShowDumpWithLineMap("משימות לטל", snap);
    const removeIds = custom.lines
      .filter((row) => row.n === 1 || row.n === 2)
      .map((row) => row.id);
    expect(removeIds).toEqual([customId1, customId2]);
    expect(removeIds).not.toContain(shoppingId1);
    expect(removeIds).not.toContain(shoppingId2);
  });

  it("SERVER GUARD: drops shopping remove ids when active dump is custom", () => {
    const customDump = formatShowDumpWithLineMap("משימות לטל", snap).lines;
    const staleShoppingRemove: LlmListAction = {
      action: "remove",
      listType: "shopping",
      listName: "",
      items: [
        { item_id: shoppingId1, "שם פריט": "גלידה" },
        { item_id: shoppingId2, "שם פריט": "חטיף לסקאזי" },
      ],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump(
      [staleShoppingRemove],
      customDump,
    );
    expect(guarded.droppedOutsideDump).toBe(true);
    expect(guarded.lists).toEqual([]);
  });

  it("SERVER GUARD: keeps custom remove ids that match the active dump", () => {
    const customDump = formatShowDumpWithLineMap("משימות לטל", snap).lines;
    const correctRemove: LlmListAction = {
      action: "remove",
      listType: "custom",
      listName: "משימות לטל",
      items: [
        { item_id: customId1 },
        { item_id: customId2 },
      ],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump(
      [correctRemove],
      customDump,
    );
    expect(guarded.droppedOutsideDump).toBe(false);
    expect(guarded.lists).toHaveLength(1);
    expect(guarded.lists[0]?.items).toHaveLength(2);
  });

  it("SERVER GUARD: no dump → does not filter (title mutates still apply)", () => {
    const remove: LlmListAction = {
      action: "remove",
      listType: "shopping",
      listName: "",
      items: [{ item_id: shoppingId1 }],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump([remove], []);
    expect(guarded.droppedOutsideDump).toBe(false);
    expect(guarded.lists).toEqual([remove]);
  });

  it("SERVER GUARD: mixed ids keeps only those in the dump", () => {
    const customDump = formatShowDumpWithLineMap("משימות לטל", snap).lines;
    const mixed: LlmListAction = {
      action: "remove",
      listType: "custom",
      listName: "משימות לטל",
      items: [
        { item_id: shoppingId1 },
        { item_id: customId1 },
      ],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump([mixed], customDump);
    expect(guarded.droppedOutsideDump).toBe(true);
    expect(guarded.lists).toHaveLength(1);
    expect(guarded.lists[0]?.items).toEqual([{ item_id: customId1 }]);
  });

  it("SERVER GUARD: tasks remove of ESD id outside date-filtered tasks dump still applies", () => {
    // After «מה יש לי היום» then «ומחר?», LAST_NUMBERED_DUMP is only tomorrow —
    // completing «דיברתי עם yes» (today's row) must not be dropped when the id
    // is grounded in this turn's ESD (not merely same list_type as the dump).
    const tomorrowOnlyDump: LastNumberedDumpLine[] = [
      { n: 1, id: "task-tomorrow-1", kind: "tasks" },
      { n: 2, id: "task-tomorrow-2", kind: "tasks" },
    ];
    const todayId = "task-today-yes";
    const finishTodayTask: LlmListAction = {
      action: "remove",
      listType: "tasks",
      listName: "",
      items: [{ item_id: todayId, "שם משימה": "לדבר עם yes" }],
      targets: [],
    };
    expect(
      restrictListMutatesToLastNumberedDump(
        [finishTodayTask],
        tomorrowOnlyDump,
      ).lists,
    ).toEqual([]);
    const guarded = restrictListMutatesToLastNumberedDump(
      [finishTodayTask],
      tomorrowOnlyDump,
      { groundedIds: new Set([todayId]) },
    );
    expect(guarded.droppedOutsideDump).toBe(false);
    expect(guarded.lists).toEqual([finishTodayTask]);
  });

  it("SERVER GUARD: still drops tasks remove when active dump is custom (cross-domain)", () => {
    const customDump = formatShowDumpWithLineMap("משימות לטל", snap).lines;
    const tasksRemove: LlmListAction = {
      action: "remove",
      listType: "tasks",
      listName: "",
      items: [{ item_id: "task-today-yes" }],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump(
      [tasksRemove],
      customDump,
    );
    expect(guarded.droppedOutsideDump).toBe(true);
    expect(guarded.lists).toEqual([]);
  });

  it("SERVER GUARD: allows shopping|tasks add while custom dump is active", () => {
    const customDump = formatShowDumpWithLineMap("משימות לטל", snap).lines;
    expect(customDump.every((row) => row.list_name === "משימות לטל")).toBe(
      true,
    );
    const shoppingAdd: LlmListAction = {
      action: "add",
      listType: "shopping",
      listName: "",
      items: [{ "שם פריט": "חלב", כמות: "1" }],
      targets: [],
    };
    const tasksAdd: LlmListAction = {
      action: "add",
      listType: "tasks",
      listName: "",
      items: [{ "שם משימה": "קבצי זיפ לאוטומציה" }],
      targets: [],
    };
    const shoppingGuarded = restrictListMutatesToLastNumberedDump(
      [shoppingAdd],
      customDump,
    );
    expect(shoppingGuarded.droppedOutsideDump).toBe(false);
    expect(shoppingGuarded.lists).toEqual([shoppingAdd]);
    const tasksGuarded = restrictListMutatesToLastNumberedDump(
      [tasksAdd],
      customDump,
    );
    expect(tasksGuarded.droppedOutsideDump).toBe(false);
    expect(tasksGuarded.lists).toEqual([tasksAdd]);
  });

  it("SERVER GUARD: allows tasks add while shopping dump is active", () => {
    const shoppingDump = formatShowDumpWithLineMap("shopping", snap).lines;
    expect(shoppingDump.every((row) => row.kind === "shopping")).toBe(true);
    const tasksAdd: LlmListAction = {
      action: "add",
      listType: "tasks",
      listName: "",
      items: [{ "שם משימה": "להוסיף קבצי זיפ לאוטומציה בשביל ניר" }],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump(
      [tasksAdd],
      shoppingDump,
    );
    expect(guarded.droppedOutsideDump).toBe(false);
    expect(guarded.lists).toEqual([tasksAdd]);
  });

  it("SERVER GUARD: allows add to the same custom list as the dump", () => {
    const customDump = formatShowDumpWithLineMap("משימות לטל", snap).lines;
    const customAdd: LlmListAction = {
      action: "add",
      listType: "custom",
      listName: "משימות לטל",
      items: [{ שם: "פריט חדש" }],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump(
      [customAdd],
      customDump,
    );
    expect(guarded.droppedOutsideDump).toBe(false);
    expect(guarded.lists).toEqual([customAdd]);
  });

  it("SERVER GUARD: allows explicit add to a different named custom than the dump", () => {
    const customDump = formatShowDumpWithLineMap("משימות לטל", snap).lines;
    const otherAdd: LlmListAction = {
      action: "add",
      listType: "custom",
      listName: "באגים",
      items: [{ שם: "משהו אחר" }],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump([otherAdd], customDump);
    expect(guarded.droppedOutsideDump).toBe(false);
    expect(guarded.lists).toEqual([otherAdd]);
  });

  it("SERVER GUARD: allows named custom create+item while shopping dump is active", () => {
    const shoppingDump = formatShowDumpWithLineMap("shopping", snap).lines;
    expect(shoppingDump.every((row) => row.kind === "shopping")).toBe(true);
    const createCars: LlmListAction = {
      action: "add",
      listType: "custom",
      listName: "מכוניות",
      titleField: "יצרן",
      columns: ["יצרן", "מודל"],
      items: [{ יצרן: "מאזדה", מודל: "2026" }],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump(
      [createCars],
      shoppingDump,
    );
    expect(guarded.droppedOutsideDump).toBe(false);
    expect(guarded.lists).toEqual([createCars]);
  });

  it("SERVER GUARD: allows empty custom shell create while shopping dump is active", () => {
    const shoppingDump = formatShowDumpWithLineMap("shopping", snap).lines;
    const emptyShell: LlmListAction = {
      action: "add",
      listType: "custom",
      listName: "מכוניות",
      items: [],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump(
      [emptyShell],
      shoppingDump,
    );
    expect(guarded.droppedOutsideDump).toBe(false);
    expect(guarded.lists).toEqual([emptyShell]);
  });

  it("SERVER GUARD: allows plain item add to named custom while shopping dump is active", () => {
    const shoppingDump = formatShowDumpWithLineMap("shopping", snap).lines;
    const plainAdd: LlmListAction = {
      action: "add",
      listType: "custom",
      listName: "מכוניות",
      items: [{ יצרן: "מאזדה", מודל: "2026" }],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump(
      [plainAdd],
      shoppingDump,
    );
    expect(guarded.droppedOutsideDump).toBe(false);
    expect(guarded.lists).toEqual([plainAdd]);
  });

  it("SERVER GUARD: drops custom add without list_name while shopping dump is active", () => {
    const shoppingDump = formatShowDumpWithLineMap("shopping", snap).lines;
    const unnamed: LlmListAction = {
      action: "add",
      listType: "custom",
      listName: "",
      items: [{ שם: "בלי שם רשימה" }],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump(
      [unnamed],
      shoppingDump,
    );
    expect(guarded.droppedOutsideDump).toBe(true);
    expect(guarded.lists).toEqual([]);
  });

  it("SERVER GUARD: contacts/filing explicit adds pass under shopping dump", () => {
    const shoppingDump = formatShowDumpWithLineMap("shopping", snap).lines;
    const contactsAdd: LlmListAction = {
      action: "add",
      listType: "contacts",
      listName: "",
      items: [{ "שם פרטי": "דני" }],
      targets: [],
    };
    const filingAdd: LlmListAction = {
      action: "add",
      listType: "filing",
      listName: "",
      items: [{ item_name: "כתובת", item_info: "הרצל 1" }],
      targets: [],
    };
    const contactsGuarded = restrictListMutatesToLastNumberedDump(
      [contactsAdd],
      shoppingDump,
    );
    const filingGuarded = restrictListMutatesToLastNumberedDump(
      [filingAdd],
      shoppingDump,
    );
    expect(contactsGuarded.droppedOutsideDump).toBe(false);
    expect(contactsGuarded.lists).toEqual([contactsAdd]);
    expect(filingGuarded.droppedOutsideDump).toBe(false);
    expect(filingGuarded.lists).toEqual([filingAdd]);
  });

  it("SERVER GUARD: ESD-grounded item_id remove passes under other-domain dump", () => {
    const shoppingDump = formatShowDumpWithLineMap("shopping", snap).lines;
    const taskId = "task-live-esd-1";
    const remove: LlmListAction = {
      action: "remove",
      listType: "tasks",
      listName: "",
      items: [{ item_id: taskId }],
      targets: [],
    };
    const blocked = restrictListMutatesToLastNumberedDump([remove], shoppingDump);
    expect(blocked.droppedOutsideDump).toBe(true);
    expect(blocked.lists).toEqual([]);
    expect(blocked.droppedItems).toEqual([
      expect.objectContaining({ itemId: taskId, reason: "outside_dump" }),
    ]);

    const allowed = restrictListMutatesToLastNumberedDump(
      [remove],
      shoppingDump,
      { groundedIds: new Set([taskId]) },
    );
    expect(allowed.droppedOutsideDump).toBe(false);
    expect(allowed.lists).toEqual([remove]);
  });

  it("SERVER GUARD: invented item_id is still dropped even with dump active", () => {
    const shoppingDump = formatShowDumpWithLineMap("shopping", snap).lines;
    const fakeId = "invented-not-in-esd-or-dump";
    const remove: LlmListAction = {
      action: "remove",
      listType: "shopping",
      listName: "",
      items: [{ item_id: fakeId }],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump(
      [remove],
      shoppingDump,
      { groundedIds: new Set([shoppingId1]) },
    );
    expect(guarded.droppedOutsideDump).toBe(true);
    expect(guarded.lists).toEqual([]);
    expect(guarded.droppedItems).toEqual([
      expect.objectContaining({ itemId: fakeId, reason: "outside_dump" }),
    ]);
  });

  it("SERVER GUARD: dump-line id still kept; Stage-2 passThrough kept", () => {
    const shoppingDump = formatShowDumpWithLineMap("shopping", snap).lines;
    const dumpId = shoppingDump[0]!.id;
    const removeDump: LlmListAction = {
      action: "remove",
      listType: "shopping",
      listName: "",
      items: [{ item_id: dumpId }],
      targets: [],
    };
    expect(
      restrictListMutatesToLastNumberedDump([removeDump], shoppingDump).lists,
    ).toEqual([removeDump]);

    const otherId = "saved-data-pass-through";
    const removeSaved: LlmListAction = {
      action: "remove",
      listType: "tasks",
      listName: "",
      items: [{ item_id: otherId }],
      targets: [],
    };
    expect(
      restrictListMutatesToLastNumberedDump([removeSaved], shoppingDump, {
        passThroughIds: new Set([otherId]),
      }).lists,
    ).toEqual([removeSaved]);
  });
});

describe("LAST_NUMBERED_DUMP builtin add does not rewrite ownership", () => {
  const speaker: PublicEmployee = {
    id: "speaker-own-1",
    name: "עמית",
    surname: "",
    nickname: "עמית",
    email: null,
    phone: null,
  };
  const partner: PublicEmployee = {
    id: "partner-other-2",
    name: "טל",
    surname: "",
    nickname: "טל",
    email: null,
    phone: null,
  };
  const humans = [speaker, partner];

  it("empty-target tasks add under foreign dump ids → plan only speaker book", () => {
    // Dump map ids look like another person's rows — must not become owner ids.
    const foreignDump: LastNumberedDumpLine[] = [
      { n: 1, id: partner.id, kind: "custom", list_name: "משימות לטל" },
      { n: 2, id: "foreign-item-uuid", kind: "custom", list_name: "משימות לטל" },
    ];
    const tasksAdd: LlmListAction = {
      action: "add",
      listType: "tasks",
      listName: "",
      items: [{ "שם משימה": "קבצי זיפ לאוטומציה" }],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump(
      [tasksAdd],
      foreignDump,
    );
    expect(guarded.lists).toEqual([tasksAdd]);

    const plan = planTargetedActions({
      actor: speaker,
      employees: humans,
      metadata: {
        ...emptyLlmMetadata(),
        lists: guarded.lists,
      },
    });

    expect(plan.applications).toHaveLength(1);
    expect(plan.applications[0]?.employeeId).toBe(speaker.id);
    expect(plan.applications.map((row) => row.employeeId)).not.toContain(
      partner.id,
    );
    // Dump line ids must never become application owners for an add.
    for (const line of foreignDump) {
      expect(plan.applications.map((row) => row.employeeId)).not.toContain(
        line.id,
      );
    }
  });

  it("empty-target shopping add under partner-owned dump → speaker book only", () => {
    const shoppingDump: LastNumberedDumpLine[] = [
      { n: 1, id: "shop-on-partner-book", kind: "shopping" },
    ];
    const shoppingAdd: LlmListAction = {
      action: "add",
      listType: "shopping",
      listName: "",
      items: [{ "שם פריט": "חלב", כמות: "1" }],
      targets: [],
    };
    const guarded = restrictListMutatesToLastNumberedDump(
      [shoppingAdd],
      shoppingDump,
    );
    const plan = planTargetedActions({
      actor: speaker,
      employees: humans,
      metadata: {
        ...emptyLlmMetadata(),
        lists: guarded.lists,
      },
    });
    expect(plan.applications).toEqual([
      expect.objectContaining({ employeeId: speaker.id }),
    ]);
    expect(plan.applications).toHaveLength(1);
  });
});
