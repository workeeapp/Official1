import { describe, expect, it } from "vitest";
import {
  applyShowButtonsToBubbles,
  coerceMetadataFromPayload,
  normalizeListsField,
  parseLlmReply,
  parseReplyMetadata,
  parseWatchExprNode,
  redactMetadataSecrets,
  redactRegisterSecrets,
  wazeNavigateUrl,
  distributeReplyButtons,
  isClosedChoiceReplyButton,
  isShowListReplyButton,
} from "./llm-message.js";

describe("custom list title_field", () => {
  it("reads title_field for custom lists only", () => {
    const meta = parseReplyMetadata(
      JSON.stringify({
        response: "",
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "custom",
              list_name: "באגים",
              title_field: "שם הבאג",
              targets: [],
              items: [{ "שם הבאג": "כפתור לא עובד", סטטוס: "פתוח" }],
            },
            {
              action: "add",
              list_type: "shopping",
              title_field: "שם פריט",
              targets: [],
              items: [{ "שם פריט": "חלב" }],
            },
          ],
        },
      }),
    );
    expect(meta.lists[0]?.titleField).toBe("שם הבאג");
    expect(meta.lists[1]?.titleField).toBeUndefined();
  });
});

describe("list_ops", () => {
  const reply = (metadata: unknown) => JSON.stringify({ response: "", metadata });

  it("parses alter_list and delete_list and drops ops without list_id", () => {
    const meta = parseReplyMetadata(
      reply({
        list_ops: [
          {
            action: "ALTER_LIST",
            list_id: "l1",
            new_name: " באגים ",
            add_columns: ["עדיפות", "עדיפות", ""],
            rename_columns: [{ from: "סטטוס", to: "מצב" }, { from: "x", to: "x" }],
            remove_participants: ["טל"],
          },
          { action: "delete_list", list_id: "l2" },
          { action: "delete_list" },
          { action: "drop_list", list_id: "l3" },
        ],
      }),
    );
    expect(meta.listOps).toEqual([
      {
        action: "alter_list",
        listId: "l1",
        newName: "באגים",
        addColumns: ["עדיפות"],
        removeColumns: [],
        renameColumns: [{ from: "סטטוס", to: "מצב" }],
        addParticipants: [],
        removeParticipants: ["טל"],
      },
      {
        action: "delete_list",
        listId: "l2",
        newName: "",
        addColumns: [],
        removeColumns: [],
        renameColumns: [],
        addParticipants: [],
        removeParticipants: [],
      },
    ]);
  });

  it("parses shell ops and filing from unified metadata.lists", () => {
    const meta = parseReplyMetadata(
      reply({
        lists: [
          {
            action: "add",
            list_type: "shopping",
            list_name: "",
            targets: [],
            items: [{ "שם פריט": "חלב" }],
          },
          {
            action: "alter_list",
            list_id: "l1",
            new_name: "באגים",
            add_participants: ["טל"],
            items: [],
          },
          {
            action: "add",
            list_type: "filing",
            list_name: "",
            targets: ["עמית"],
            items: [
              {
                item_name: "משפחה",
                item_info: "שני ילדים",
                item_description: "",
              },
            ],
          },
          {
            action: "remove",
            list_type: "filing",
            targets: [],
            items: [{ filing_id: "f1" }],
          },
          { action: "delete_list", list_id: "l2", items: [] },
        ],
      }),
    );
    expect(meta.lists).toHaveLength(1);
    expect(meta.lists[0]?.listType).toBe("shopping");
    expect(meta.listOps).toEqual([
      {
        action: "alter_list",
        listId: "l1",
        newName: "באגים",
        addColumns: [],
        removeColumns: [],
        renameColumns: [],
        addParticipants: ["טל"],
        removeParticipants: [],
      },
      {
        action: "delete_list",
        listId: "l2",
        newName: "",
        addColumns: [],
        removeColumns: [],
        renameColumns: [],
        addParticipants: [],
        removeParticipants: [],
      },
    ]);
    expect(meta.filing).toEqual([
      {
        action: "add_filing",
        itemName: "משפחה",
        itemInfo: "שני ילדים",
        itemDescription: "",
        targets: ["עמית"],
        filingId: "",
      },
      {
        action: "remove_filing",
        itemName: "",
        itemInfo: "",
        itemDescription: "",
        targets: [],
        filingId: "f1",
      },
    ]);
  });

  it("still accepts legacy metadata.filing alongside unified lists", () => {
    const meta = parseReplyMetadata(
      reply({
        lists: [
          {
            action: "add",
            list_type: "filing",
            targets: [],
            items: [{ item_name: "קוד", item_info: "1", item_description: "" }],
          },
        ],
        filing: [
          {
            action: "add_filing",
            targets: [],
            item_name: "כתובת",
            item_info: "ת״א",
            item_description: "",
          },
        ],
      }),
    );
    expect(meta.filing.map((f) => f.itemName)).toEqual(["קוד", "כתובת"]);
  });

  it("parses list_type reminders into LlmReminderAction and keeps wrapper list_type", () => {
    const meta = parseReplyMetadata(
      reply({
        lists: [
          {
            action: "add",
            list_type: "reminders",
            list_name: "",
            targets: [],
            items: [
              {
                item: "לקנות חלב",
                list_type: "shopping",
                in: 3600,
                ping: ["עמית"],
              },
            ],
          },
          {
            action: "remove",
            list_type: "reminders",
            targets: [],
            items: [{ reminder_id: "r1" }],
          },
        ],
      }),
    );
    expect(meta.lists).toEqual([]);
    expect(meta.reminders).toHaveLength(2);
    expect(meta.reminders[0]?.action).toBe("add");
    expect(meta.reminders[0]?.item).toBe("לקנות חלב");
    expect(meta.reminders[0]?.listType).toBe("shopping");
    expect(meta.reminders[0]?.inSeconds).toBe(3600);
    expect(meta.reminders[0]?.ping).toEqual(["עמית"]);
    expect(meta.reminders[1]?.action).toBe("remove");
    expect(meta.reminders[1]?.reminderId).toBe("r1");
  });

  it("still accepts legacy metadata.reminders alongside unified lists", () => {
    const meta = parseReplyMetadata(
      reply({
        lists: [
          {
            action: "add",
            list_type: "reminders",
            targets: [],
            items: [{ item: "לשתות מים", list_type: "tasks", time: "09:00" }],
          },
        ],
        reminders: [
          {
            action: "add",
            item: "לקנות לחם",
            list_type: "shopping",
            in: 600,
            ping: ["טל"],
          },
        ],
      }),
    );
    expect(meta.reminders.map((r) => r.item)).toEqual(["לשתות מים", "לקנות לחם"]);
  });

  it("reads declared columns when a custom list is created", () => {
    const meta = parseReplyMetadata(
      reply({
        lists: [
          {
            action: "add",
            list_type: "custom",
            list_name: "חנויות",
            columns: ["שם החנות", "עיר"],
            items: [],
          },
        ],
      }),
    );
    expect(meta.lists[0]?.columns).toEqual(["שם החנות", "עיר"]);
  });

  it("describes list ops for the action log", () => {
    expect(
      parseLlmReply(
        reply({
          list_ops: [
            { action: "alter_list", list_id: "l1", new_name: "באגים" },
            { action: "delete_list", list_id: "l2" },
          ],
        }),
      ).actions,
    ).toEqual(["Alter list: rename to באגים", "Delete list"]);
  });
});

describe("parseLlmReply", () => {
  it("returns plain text when the reply is not JSON", () => {
    expect(parseLlmReply("Hello from the assistant")).toEqual({
      response: "Hello from the assistant",
      responses: ["Hello from the assistant"],
      responseBubbles: [{ text: "Hello from the assistant" }],
      actions: [],
    });
  });

  it("reads responses as separate messages in order", () => {
    const parsed = parseLlmReply(
      JSON.stringify({
        responses: ["הי, איך אפשר לעזור?", " ", "אגב, ביקשת שאבדוק אם קנית חלב?"],
        metadata: { lists: [] },
      }),
    );
    expect(parsed.responses).toEqual([
      "הי, איך אפשר לעזור?",
      "אגב, ביקשת שאבדוק אם קנית חלב?",
    ]);
    expect(parsed.response).toBe(
      "הי, איך אפשר לעזור?\n\nאגב, ביקשת שאבדוק אם קנית חלב?",
    );
  });

  it("wraps a legacy response string as one message", () => {
    const parsed = parseLlmReply(
      JSON.stringify({ response: "הוספתי חלב", metadata: {} }),
    );
    expect(parsed.responses).toEqual(["הוספתי חלב"]);
    expect(parsed.response).toBe("הוספתי חלב");
  });

  it("shows only the response field from JSON", () => {
    const parsed = parseLlmReply(
      JSON.stringify({
        response: "Milk was added.",
        metadata: {
          lists: [],
          filing: [],
        },
      }),
    );

    expect(parsed.response).toBe("Milk was added.");
    expect(parsed.actions).toEqual([]);
  });

  it("keeps an empty response string empty (never leaks raw JSON)", () => {
    const raw = JSON.stringify({
      response: "",
      metadata: {
        lists: [],
        filing: [],
        messages: [],
        directory: [],
        reminders: [],
        handoff: { worker: "" },
        sections: [],
        history_kinds: [],
        confirm: true,
      },
    });
    const parsed = parseLlmReply(raw);
    expect(parsed.response).toBe("");
    expect(parsed.response).not.toContain("metadata");
    expect(parsed.response).not.toContain("confirm");
  });

  it("rescues top-level lists into metadata when metadata.lists is empty", () => {
    const itemId = "f143906b-89e1-4749-b894-93ec2ebe7f21";
    const coerced = coerceMetadataFromPayload({
      responses: [],
      lists: [{ action: "remove", item_id: itemId }],
      metadata: { lists: [], filing: [] },
    });
    expect(coerced).toMatchObject({
      lists: [{ action: "remove", item_id: itemId }],
    });
    const meta = parseReplyMetadata(
      JSON.stringify({
        responses: [],
        lists: [
          {
            action: "remove",
            item_id: itemId,
          },
        ],
        metadata: { lists: [] },
      }),
    );
    expect(meta.lists).toHaveLength(1);
    expect(meta.lists[0]?.action).toBe("remove");
    expect(meta.lists[0]?.items[0]).toMatchObject({ item_id: itemId });
  });

  it("does not override non-empty metadata.lists with top-level lists", () => {
    const meta = parseReplyMetadata(
      JSON.stringify({
        responses: [],
        lists: [{ action: "remove", item_id: "top-level" }],
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "shopping",
              targets: [],
              items: [{ "שם פריט": "חלב" }],
            },
          ],
        },
      }),
    );
    expect(meta.lists).toHaveLength(1);
    expect(meta.lists[0]?.action).toBe("add");
  });

  it("normalizes lists object buckets { remove: [...] } into actions", () => {
    const itemId = "f143906b-89e1-4749-b894-93ec2ebe7f21";
    expect(
      normalizeListsField({
        remove: [{ item_id: itemId }],
      }),
    ).toEqual([{ item_id: itemId, action: "remove" }]);
    const meta = parseReplyMetadata(
      JSON.stringify({
        lists: { remove: [{ item_id: itemId }] },
        responses: [{ text: "מחקתי את גרביים מרשימת הקניות." }],
      }),
    );
    expect(meta.lists).toHaveLength(1);
    expect(meta.lists[0]?.action).toBe("remove");
    expect(meta.lists[0]?.items[0]).toMatchObject({ item_id: itemId });
  });

  it("unwraps top-level text instead of leaking raw JSON", () => {
    const hebrew =
      "השבוע:\n• שני 12.10 — פגישה (עמית, חרש) ב־14:00.";
    const parsed = parseLlmReply(
      JSON.stringify({
        text: hebrew,
        metadata: { lists: [], reminders: [] },
      }),
    );
    expect(parsed.responses).toEqual([hebrew]);
    expect(parsed.response).toBe(hebrew);
    expect(parsed.response).not.toContain('"text"');
    expect(parsed.response).not.toContain("metadata");
  });

  it("unwraps responses entries shaped as { text }", () => {
    const parsed = parseLlmReply(
      JSON.stringify({
        responses: [{ text: "הי, איך אפשר לעזור?" }, { text: "אגב, ביקשת שאבדוק אם קנית חלב?" }],
        metadata: { lists: [] },
      }),
    );
    expect(parsed.responses).toEqual([
      "הי, איך אפשר לעזור?",
      "אגב, ביקשת שאבדוק אם קנית חלב?",
    ]);
  });

  it("unwraps a stringified { text } inside responses", () => {
    const parsed = parseLlmReply(
      JSON.stringify({
        responses: [JSON.stringify({ text: "השבוע: פגישה ב־14:00" })],
        metadata: {},
      }),
    );
    expect(parsed.responses).toEqual(["השבוע: פגישה ב־14:00"]);
    expect(parsed.response).not.toContain('"text"');
  });

  it("unwraps legacy response object with text", () => {
    const parsed = parseLlmReply(
      JSON.stringify({
        response: { text: "הוספתי חלב" },
        metadata: { lists: [] },
      }),
    );
    expect(parsed.responses).toEqual(["הוספתי חלב"]);
    expect(parsed.response).toBe("הוספתי חלב");
  });

  it("does not leak raw JSON when metadata-only payload has no spoken text", () => {
    const raw = JSON.stringify({
      metadata: { lists: [], confirm: true },
    });
    const parsed = parseLlmReply(raw);
    expect(parsed.responses).toEqual([]);
    expect(parsed.response).toBe("");
    expect(parsed.response).not.toContain("metadata");
    expect(parsed.response).not.toContain("confirm");
  });

  it("reads show buttons from metadata", () => {
    const parsed = parseLlmReply(
      JSON.stringify({
        response: "הוספתי חלב לרשימת הקניות שלך",
        metadata: {
          lists: [{ action: "add", list_type: "shopping", targets: [], items: [{ "שם פריט": "חלב" }] }],
          buttons: [
            { label: " הצג ", command: " הצג רשימת קניות " },
            { label: "הצג", command: "הצג רשימת קניות" },
            { label: "", command: "הצג רשימת מטלות" },
            { label: "הצג", command: "" },
            "bad",
            { label: "הצג את הרשימה הארוכה מאוד", command: "הצג רשימת בעיות" },
            { label: "הצג", command: "הצג רשימת מטלות" },
            { label: "הצג", command: "הצג רשימת אנשי קשר" },
          ],
        },
      }),
    );

    expect(parsed.buttons).toEqual([
      { label: "הצג", command: "הצג רשימת קניות" },
      { label: "הצג את הרשימה הארוכה", command: "הצג רשימת בעיות" },
      { label: "הצג", command: "הצג רשימת מטלות" },
    ]);
  });

  it("omits buttons when metadata has none", () => {
    const parsed = parseLlmReply(
      JSON.stringify({ response: "שלום", metadata: { lists: [], buttons: [] } }),
    );
    expect(parsed.buttons).toBeUndefined();
  });

  it("reads navigate_address from metadata", () => {
    const parsed = parseLlmReply(
      JSON.stringify({
        responses: ["הכתובת שלך היא הרצל 12, תל אביב"],
        metadata: { navigate_address: "  הרצל 12, תל אביב " },
      }),
    );
    expect(parsed.navigateAddress).toBe("הרצל 12, תל אביב");
  });

  it("reads show_icon from metadata", () => {
    const parsed = parseLlmReply(
      JSON.stringify({
        responses: ["הוספתי חלב לרשימת הקניות"],
        metadata: { show_icon: " 👍 " },
      }),
    );
    expect(parsed.showIcon).toBe("👍");
  });

  it("omits show_icon when null or empty", () => {
    expect(
      parseLlmReply(
        JSON.stringify({
          responses: ["שלום"],
          metadata: { show_icon: null },
        }),
      ).showIcon,
    ).toBeUndefined();
    expect(
      parseLlmReply(
        JSON.stringify({
          responses: ["שלום"],
          metadata: { show_icon: "   " },
        }),
      ).showIcon,
    ).toBeUndefined();
  });

  it("reads show_dump from metadata", () => {
    const meta = parseReplyMetadata(
      JSON.stringify({
        responses: ["..."],
        metadata: { lists: [], show_dump: " tasks " },
      }),
    );
    expect(meta.showDump).toBe("tasks");
  });

  it("strips wrapping quotes from show_dump custom list names", () => {
    const meta = parseReplyMetadata(
      JSON.stringify({
        responses: ["..."],
        metadata: {
          lists: [],
          show_dump: '"בדיקה של שיתוף עם עמית"',
        },
      }),
    );
    expect(meta.showDump).toBe("בדיקה של שיתוף עם עמית");
  });

  it("reads show_dump_section and show_dump_partner", () => {
    const meta = parseReplyMetadata(
      JSON.stringify({
        responses: ["..."],
        metadata: {
          lists: [],
          show_dump: "shopping",
          show_dump_section: "shared",
          show_dump_partner: " מיכל ",
        },
      }),
    );
    expect(meta.showDump).toBe("shopping");
    expect(meta.showDumpSection).toBe("shared");
    expect(meta.showDumpPartner).toBe("מיכל");
  });

  it("reads show_dump_assignee and show_dump_about", () => {
    const meta = parseReplyMetadata(
      JSON.stringify({
        responses: ["..."],
        metadata: {
          lists: [],
          show_dump: "tasks",
          show_dump_section: "shared",
          show_dump_partner: "מיכל",
          show_dump_assignee: "self",
          show_dump_about: " מיכל ",
        },
      }),
    );
    expect(meta.showDumpAssignee).toBe("self");
    expect(meta.showDumpAbout).toBe("מיכל");
  });

  it("reads partner/assignee/about as string arrays (OR within field)", () => {
    const meta = parseReplyMetadata(
      JSON.stringify({
        responses: ["..."],
        metadata: {
          lists: [],
          show_dump: "tasks",
          show_dump_partner: [" מיכל ", "עמית", "מיכל"],
          show_dump_assignee: ["self", "מיכל"],
          show_dump_about: ["טל", "מיכל"],
        },
      }),
    );
    expect(meta.showDumpPartner).toEqual(["מיכל", "עמית"]);
    expect(meta.showDumpAssignee).toEqual(["self", "מיכל"]);
    expect(meta.showDumpAbout).toEqual(["טל", "מיכל"]);
  });

  it("reads show_dump_from and show_dump_to as YYYY-MM-DD", () => {
    const meta = parseReplyMetadata(
      JSON.stringify({
        responses: ["..."],
        metadata: {
          lists: [],
          show_dump: "tasks",
          show_dump_from: "2026-10-17",
          show_dump_to: "2026-10-20",
        },
      }),
    );
    expect(meta.showDumpFrom).toBe("2026-10-17");
    expect(meta.showDumpTo).toBe("2026-10-20");

    const bad = parseReplyMetadata(
      JSON.stringify({
        responses: ["..."],
        metadata: {
          lists: [],
          show_dump: "tasks",
          show_dump_from: "17/10/2026",
          show_dump_to: "not-a-date",
        },
      }),
    );
    expect(bad.showDumpFrom).toBeUndefined();
    expect(bad.showDumpTo).toBeUndefined();
  });

  it("reads show_dump_urgency", () => {
    const meta = parseReplyMetadata(
      JSON.stringify({
        responses: ["..."],
        metadata: {
          lists: [],
          show_dump: "tasks",
          show_dump_urgency: "urgent",
        },
      }),
    );
    expect(meta.showDumpUrgency).toBe("urgent");
    const bad = parseReplyMetadata(
      JSON.stringify({
        responses: ["..."],
        metadata: { lists: [], show_dump: "tasks", show_dump_urgency: "normal" },
      }),
    );
    expect(bad.showDumpUrgency).toBeUndefined();
  });

  it("omits navigate_address when null, empty, or not a string", () => {
    for (const navigate_address of [null, "", "   ", 12]) {
      const parsed = parseLlmReply(
        JSON.stringify({ responses: ["שלום"], metadata: { navigate_address } }),
      );
      expect(parsed.navigateAddress).toBeUndefined();
    }
  });

  it("builds an encoded Waze navigate URL", () => {
    expect(wazeNavigateUrl("הרצל 12, תל אביב")).toBe(
      `https://waze.com/ul?q=${encodeURIComponent("הרצל 12, תל אביב")}&navigate=yes`,
    );
    expect(wazeNavigateUrl("a&b=c")).toBe("https://waze.com/ul?q=a%26b%3Dc&navigate=yes");
  });

  it("classifies classic and content-aware show taps vs closed choices", () => {
    expect(
      isShowListReplyButton({ label: "הצג", command: "הצג רשימת מטלות" }),
    ).toBe(true);
    // POST-MUTATE SHOW: short label + longer natural ask in command.
    expect(
      isShowListReplyButton({
        label: "מחר",
        command: "מה יש לי מחר",
      }),
    ).toBe(true);
    expect(
      isShowListReplyButton({
        label: "למי להתקשר",
        command: "למי אני צריך להתקשר",
      }),
    ).toBe(true);
    expect(
      isShowListReplyButton({
        label: "מה טל לקנות",
        command: "מה טל צריך לקנות",
      }),
    ).toBe(true);
    expect(isShowListReplyButton({ label: "כן", command: "כן" })).toBe(false);
    expect(isClosedChoiceReplyButton({ label: "כן", command: "כן" })).toBe(
      true,
    );
    expect(
      isClosedChoiceReplyButton({ label: "כיבוד", command: "כיבוד" }),
    ).toBe(true);
    // Invented complex-event axes (label≈command, short) stay closed-choice.
    expect(
      isClosedChoiceReplyButton({ label: "איזה סרט", command: "איזה סרט" }),
    ).toBe(true);
    expect(
      isShowListReplyButton({ label: "איזה סרט", command: "איזה סרט" }),
    ).toBe(false);
    expect(
      isClosedChoiceReplyButton({
        label: "באיזו שעה",
        command: "באיזו שעה",
      }),
    ).toBe(true);
    expect(
      isShowListReplyButton({
        label: "באיזו שעה",
        command: "באיזו שעה",
      }),
    ).toBe(false);
  });

  it("distributes show buttons to first bubble and choices to last", () => {
    const buttons = [
      { label: "הצג", command: "הצג רשימת מטלות" },
      { label: "כן", command: "כן" },
      { label: "לא", command: "לא" },
    ];
    expect(distributeReplyButtons(1, buttons)).toEqual([buttons]);
    expect(distributeReplyButtons(2, buttons)).toEqual([
      [{ label: "הצג", command: "הצג רשימת מטלות" }],
      [
        { label: "כן", command: "כן" },
        { label: "לא", command: "לא" },
      ],
    ]);
    expect(
      distributeReplyButtons(2, [
        { label: "כן", command: "כן" },
        { label: "לא", command: "לא" },
      ]),
    ).toEqual([
      [],
      [
        { label: "כן", command: "כן" },
        { label: "לא", command: "לא" },
      ],
    ]);
  });

  it("binds per-bubble buttons and Waze from object responses", () => {
    const parsed = parseLlmReply(
      JSON.stringify({
        responses: [
          {
            text: "הוספתי מטלה.",
            buttons: [{ label: "הצג", command: "הצג רשימת מטלות" }],
          },
          {
            text: "רוצה תזכורת?",
            buttons: [
              { label: "כן", command: "כן" },
              { label: "לא", command: "לא" },
            ],
          },
          {
            text: "הכתובת: הרצל 12, תל אביב",
            navigate_address: "הרצל 12, תל אביב",
          },
        ],
        metadata: {
          buttons: [{ label: "כן", command: "כן" }],
          navigate_address: "ignored when per-bubble set",
        },
      }),
    );
    expect(parsed.responseBubbles[0]?.buttons).toEqual([
      { label: "הצג", command: "הצג רשימת מטלות" },
    ]);
    expect(parsed.responseBubbles[1]?.buttons).toEqual([
      { label: "כן", command: "כן" },
      { label: "לא", command: "לא" },
    ]);
    expect(parsed.responseBubbles[2]?.navigateAddress).toBe("הרצל 12, תל אביב");
    expect(parsed.navigateAddress).toBe("הרצל 12, תל אביב");
  });

  it("legacy turn-level buttons still distribute first/last", () => {
    const parsed = parseLlmReply(
      JSON.stringify({
        responses: ["אישור", "רוצה תזכורת?"],
        metadata: {
          buttons: [
            { label: "הצג", command: "הצג רשימת מטלות" },
            { label: "כן", command: "כן" },
            { label: "לא", command: "לא" },
          ],
        },
      }),
    );
    expect(parsed.responseBubbles[0]?.buttons).toEqual([
      { label: "הצג", command: "הצג רשימת מטלות" },
    ]);
    expect(parsed.responseBubbles[1]?.buttons).toEqual([
      { label: "כן", command: "כן" },
      { label: "לא", command: "לא" },
    ]);
  });

  it("applyShowButtonsToBubbles keeps choices on their bubble", () => {
    const bubbles = applyShowButtonsToBubbles(
      [
        {
          text: "הוספתי",
          buttons: [{ label: "הצג", command: "הצג רשימת מטלות" }],
        },
        {
          text: "רוצה?",
          buttons: [
            { label: "כן", command: "כן" },
            { label: "לא", command: "לא" },
          ],
        },
        { text: "טיפ" },
      ],
      [
        { label: "הצג", command: "הצג רשימת מטלות" },
        { label: "כן", command: "כן" },
        { label: "לא", command: "לא" },
      ],
    );
    expect(bubbles[0]?.buttons).toEqual([
      { label: "הצג", command: "הצג רשימת מטלות" },
    ]);
    expect(bubbles[1]?.buttons).toEqual([
      { label: "כן", command: "כן" },
      { label: "לא", command: "לא" },
    ]);
    expect(bubbles[2]?.buttons).toBeUndefined();
  });

  it("applyShowButtonsToBubbles puts content-aware show on the first bubble", () => {
    const bubbles = applyShowButtonsToBubbles(
      [
        {
          text: "הוספתי התקשרות ליוסי.",
          buttons: [
            {
              label: "למי להתקשר",
              command: "למי אני צריך להתקשר",
            },
          ],
        },
        {
          text: "רוצה תזכורת?",
          buttons: [
            { label: "כן", command: "כן" },
            { label: "לא", command: "לא" },
          ],
        },
      ],
      [
        {
          label: "למי להתקשר",
          command: "למי אני צריך להתקשר",
        },
        { label: "כן", command: "כן" },
        { label: "לא", command: "לא" },
      ],
    );
    expect(bubbles[0]?.buttons).toEqual([
      {
        label: "למי להתקשר",
        command: "למי אני צריך להתקשר",
      },
    ]);
    expect(bubbles[1]?.buttons).toEqual([
      { label: "כן", command: "כן" },
      { label: "לא", command: "לא" },
    ]);
  });

  it("ignores a null metadata action", () => {
    const parsed = parseLlmReply(
      JSON.stringify({
        response: "What would you like to add?",
        metadata: { action: null, lists: [], filing: [] },
      }),
    );

    expect(parsed.response).toBe("What would you like to add?");
    expect(parsed.actions).toEqual([]);
  });

  it("describes list and filing actions when they are present", () => {
    const parsed = parseLlmReply(`\`\`\`json
{
  "response": "Done.",
  "metadata": {
    "lists": [
      {
        "action": "add",
        "list_type": "shopping",
        "items": [{ "name": "milk" }]
      }
    ],
    "filing": [
      {
        "action": "add_filing",
        "item_name": "car number",
        "item_info": "3434343"
      }
    ]
  }
}
\`\`\``);

    expect(parsed.response).toBe("Done.");
    expect(parsed.actions).toEqual([
      "Add to shopping list: milk",
      "File: car number — 3434343",
    ]);
  });

  it("keeps action targets and mentions them in the description", () => {
    const reply = JSON.stringify({
      response: "Told Tal.",
      metadata: {
        lists: [
          {
            action: "add",
            list_type: "shopping",
            targets: ["טל"],
            items: [{ name: "חלב" }],
          },
        ],
        filing: [],
      },
    });

    expect(parseLlmReply(reply).actions).toEqual([
      "Add to shopping list for טל: חלב",
    ]);
    expect(parseReplyMetadata(reply).lists[0].targets).toEqual(["טל"]);
  });

  it("reads filing description from metadata (model resolves כמו השם)", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "שמרתי",
          metadata: {
            filing: [
              {
                action: "add_filing",
                item_name: "קוד לשער של לבנת",
                item_info: "1234",
                item_description: "קוד לשער של לבנת",
              },
            ],
          },
        }),
      ).filing,
    ).toEqual([
      {
        action: "add_filing",
        itemName: "קוד לשער של לבנת",
        itemInfo: "1234",
        itemDescription: "קוד לשער של לבנת",
        targets: [],
        filingId: "",
      },
    ]);
  });

  it("extracts structured list, task, and filing actions", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "Done.",
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "shopping",
                items: [{ "שם פריט": "חלב", כמות: 1 }],
              },
              {
                action: "add",
                list_type: "tasks",
                items: [{ "שם מטלה": "לקנות מתנה" }],
              },
            ],
            filing: [
              {
                action: "add_filing",
                item_name: "מספר רכב",
                item_info: "3434343",
              },
            ],
          },
        }),
      ),
    ).toEqual({
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          items: [{ "שם פריט": "חלב", כמות: 1 }],
          targets: [],
        },
        {
          action: "add",
          listType: "tasks",
          listName: "",
          items: [{ "שם מטלה": "לקנות מתנה" }],
          targets: [],
        },
      ],
      listOps: [],
      filing: [
        {
          action: "add_filing",
          itemName: "מספר רכב",
          itemInfo: "3434343",
          itemDescription: "",
          targets: [],
          filingId: "",
        },
      ],
      messages: [],
      reminders: [],
      directory: [],
      jobs: [],
      handoff: null,
      register: null,
      reportSections: [],
      reportHistoryKinds: [],
      confirm: null,
      targets: [],
    });
  });

  it("extracts a conversation handoff from any metadata shape", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "מעבירה אותך לדוד",
          metadata: { handoff: { worker: "דוד" } },
        }),
      ).handoff,
    ).toEqual({ worker: "דוד" });
    expect(
      parseLlmReply(
        JSON.stringify({
          response: "Sure.",
          metadata: { talk_to: "Lucy" },
        }),
      ).actions,
    ).toEqual(["Handoff to Lucy"]);
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "רגע",
          metadata: { confirm: true },
        }),
      ),
    ).toMatchObject({ confirm: true });
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "רגע",
          metadata: { targets: ["לוסי"] },
        }),
      ),
    ).toMatchObject({ targets: ["לוסי"] });
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "רגע",
          metadata: {
            sections: ["tasks", "קניות", "sends"],
          },
        }),
      ).reportSections,
    ).toEqual(expect.arrayContaining(["tasks", "shopping", "sends"]));
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "מה לשלוח למאיה?",
          metadata: {
            messages: [{ targets: ["מאיה"], text: "" }],
          },
        }),
      ),
    ).toMatchObject({
      messages: [{ targets: ["מאיה"], text: "" }],
    });
  });

  it("extracts a relayed message for another employee", () => {
    const reply = JSON.stringify({
      response: "שלחתי לטל",
      metadata: {
        lists: [],
        filing: [],
        messages: [
          {
            targets: ["טל"],
            text: "עמית שואל מה שלומך?\nמה לענות לו ?",
          },
        ],
      },
    });

    expect(parseReplyMetadata(reply).messages).toEqual([
      {
        targets: ["טל"],
        text: "עמית שואל מה שלומך?\nמה לענות לו ?",
      },
    ]);
    expect(parseLlmReply(reply).actions).toEqual([
      "Send message for טל: עמית שואל מה שלומך?\nמה לענות לו ?",
    ]);
  });

  it("reads expects_reply and the asker's question off a relayed message", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "שלחתי לערן",
          metadata: {
            messages: [
              {
                targets: ["ערן"],
                text: "עמית שואל אם קנית חלב?",
                expects_reply: true,
                ask_summary: "אם קנית חלב?",
              },
            ],
          },
        }),
      ).messages,
    ).toEqual([
      {
        targets: ["ערן"],
        text: "עמית שואל אם קנית חלב?",
        expectsReply: true,
        askSummary: "אם קנית חלב?",
      },
    ]);
  });

  it("reads deferred check-with clock fields on a messages entry", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "אבדוק איתך בעוד שעתיים",
          metadata: {
            messages: [
              {
                targets: ["עמית"],
                text: "קנית חלב?",
                expects_reply: true,
                ask_summary: "אם קניתי חלב?",
                urgency: "normal",
                in: 7200,
              },
              {
                targets: ["טל"],
                text: "עמית שואל אם אתה מקליט?",
                expects_reply: true,
                ask_summary: "אם מקליט את המשחק?",
                urgency: "normal",
                date: "2026-10-09",
                time: "20:00",
              },
              {
                targets: ["עמית"],
                text: "לקחת אקמול?",
                expects_reply: true,
                ask_summary: "אם לקחתי אקמול?",
                recurrence: {
                  freq: "monthly",
                  interval: 1,
                  month_day: 1,
                  time: "17:00",
                },
              },
            ],
          },
        }),
      ).messages,
    ).toEqual([
      {
        targets: ["עמית"],
        text: "קנית חלב?",
        expectsReply: true,
        askSummary: "אם קניתי חלב?",
        inSeconds: 7200,
      },
      {
        targets: ["טל"],
        text: "עמית שואל אם אתה מקליט?",
        expectsReply: true,
        askSummary: "אם מקליט את המשחק?",
        date: "2026-10-09",
        time: "20:00",
      },
      {
        targets: ["עמית"],
        text: "לקחת אקמול?",
        expectsReply: true,
        askSummary: "אם לקחתי אקמול?",
        recurrence: {
          freq: "monthly",
          interval: 1,
          monthDay: 1,
          time: "17:00",
        },
      },
    ]);
  });

  it("reads the urgency the model set on a relayed message and drops normal", () => {
    const parsed = parseReplyMetadata(
      JSON.stringify({
        response: "שלחתי לערן",
        metadata: {
          messages: [
            {
              targets: ["ערן"],
              text: "דחוף מאוד — עמית מבקש תשובה עכשיו: מה שלומך?",
              expects_reply: true,
              ask_summary: "מה שלומך?",
              urgency: "very_urgent",
            },
            {
              targets: ["טל"],
              text: "עמית שואל מה שלומך?",
              expects_reply: true,
              ask_summary: "מה שלומך?",
              urgency: "normal",
            },
            {
              targets: ["מיכל"],
              text: "עמית שואל מה שלומך?",
              expects_reply: true,
              ask_summary: "מה שלומך?",
              urgency: "whenever",
            },
          ],
        },
      }),
    );
    expect(parsed.messages?.[0].urgency).toBe("very_urgent");
    expect(parsed.messages?.[1]).not.toHaveProperty("urgency");
    expect(parsed.messages?.[2]).not.toHaveProperty("urgency");
  });

  it("parses counter with job_id date and time from OPEN_JOBS-shaped ACTION", () => {
    const parsed = parseReplyMetadata(
      JSON.stringify({
        response: "אעדכן את עמית.",
        metadata: {
          jobs: [
            {
              action: "counter",
              job_id: "275996ef-4853-40ca-bae1-8c4e24c502dc",
              answer_text: "יום רביעי ב-21:00",
              report_text:
                "טל רוצה לשנות את מועד הפגישה ליום רביעי בשעה 21:00. האם לאשר?",
              date: "2026-10-07",
              time: "21:00",
            },
          ],
        },
      }),
    );
    expect(parsed.jobs).toEqual([
      {
        action: "counter",
        jobId: "275996ef-4853-40ca-bae1-8c4e24c502dc",
        answerText: "יום רביעי ב-21:00",
        reportText:
          "טל רוצה לשנות את מועד הפגישה ליום רביעי בשעה 21:00. האם לאשר?",
        time: "21:00",
        in: null,
        date: "2026-10-07",
      },
    ]);
  });

  it("reads a booking slot off a relayed message and drops an incomplete one", () => {
    const parsed = parseReplyMetadata(
      JSON.stringify({
        response: "שלחתי לערן",
        metadata: {
          messages: [
            {
              targets: ["ערן"],
              text: "עמית מבקש לתאם איתך שיחת עדכון מחר ב-08:00. מתאים לך?",
              expects_reply: true,
              ask_summary: "לתאם שיחת עדכון מחר ב-08:00",
              book: { title: "שיחת עדכון", date: "2026-10-04", time: "8:00" },
            },
            {
              targets: ["טל"],
              text: "עמית שואל מה שלומך?",
              expects_reply: true,
              ask_summary: "מה שלומך?",
              book: { title: "x", date: "מחר", time: "08:00" },
            },
          ],
        },
      }),
    ).messages;
    expect(parsed[0].book).toEqual({
      title: "שיחת עדכון",
      date: "2026-10-04",
      time: "08:00",
    });
    expect(parsed[1].book).toBeUndefined();
  });

  it("reads a booking range, a window flag, and a counter end", () => {
    const parsed = parseReplyMetadata(
      JSON.stringify({
        response: "שלחתי לטל",
        metadata: {
          messages: [
            {
              targets: ["טל"],
              text: "עמית רוצה לתאם איתך פגישה ביום רביעי בין 10:00 ל־12:00. באיזו שעה נוח לך?",
              expects_reply: true,
              ask_summary: "לתאם פגישה ביום רביעי בין 10:00 ל־12:00",
              book: { title: "פגישה", date: "2026-10-07", time: "10:00", end_time: "12:00", window: true },
            },
          ],
          jobs: [
            { action: "counter", job_id: "job-1", time: "11:00", end_time: "13:00", date: "2026-10-07" },
            { action: "counter", job_id: "job-2", time: "11:00", end_time: "", date: "2026-10-07" },
          ],
        },
      }),
    );
    expect(parsed.messages?.[0]?.book).toEqual({
      title: "פגישה",
      date: "2026-10-07",
      time: "10:00",
      endTime: "12:00",
      window: true,
    });
    expect(parsed.jobs?.[0]?.endTime).toBe("13:00");
    expect(parsed.jobs?.[1]?.endTime).toBeUndefined();
  });

  it("drops end_time from a clock's recurrence", () => {
    const parsed = parseReplyMetadata(
      JSON.stringify({
        response: "אזכיר לך",
        metadata: {
          reminders: [
            {
              action: "add",
              item: "פגישה",
              ping: ["עמית"],
              recurrence: { freq: "weekly", weekdays: [1], time: "10:00", end_time: "12:00" },
            },
          ],
        },
      }),
    );
    expect(parsed.reminders?.[0]?.recurrence).toEqual({
      freq: "weekly",
      interval: 1,
      weekdays: [1],
      time: "10:00",
    });
  });

  it("parses reminders.about separately from ping", () => {
    const parsed = parseReplyMetadata(
      JSON.stringify({
        response: "ok",
        metadata: {
          reminders: [
            {
              action: "add",
              item: "יום ההולדת של עמית",
              time: "09:00",
              ping: ["טל"],
              about: ["עמית"],
              recurrence: {
                freq: "yearly",
                interval: 1,
                month: 10,
                month_day: 13,
                time: "09:00",
              },
            },
          ],
        },
      }),
    );
    expect(parsed.reminders?.[0]).toMatchObject({
      ping: ["טל"],
      about: ["עמית"],
    });
  });

  it("keeps a job action that forgot its id and drops unknown actions", () => {
    const parsed = parseReplyMetadata(
      JSON.stringify({
        response: "מסרתי לעמית",
        metadata: {
          jobs: [
            {
              action: "answer",
              job_id: "job-1",
              answer_text: "כן, קניתי",
              report_text: "ערן מוסר שכן",
            },
            { action: "snooze", job_id: "job-2", in: 600 },
            { action: "snooze", job_id: "job-3", time: "19:30" },
            { action: "answer", answer_text: "כן" },
            { action: "explode", job_id: "job-4" },
          ],
        },
      }),
    );
    expect(parsed.jobs).toEqual([
      {
        action: "answer",
        jobId: "job-1",
        answerText: "כן, קניתי",
        reportText: "ערן מוסר שכן",
        time: "",
        in: null,
        date: "",
      },
      {
        action: "snooze",
        jobId: "job-2",
        answerText: "",
        reportText: "",
        time: "",
        in: 600,
        date: "",
      },
      {
        action: "snooze",
        jobId: "job-3",
        answerText: "",
        reportText: "",
        time: "19:30",
        in: null,
        date: "",
      },
      {
        action: "answer",
        jobId: "",
        answerText: "כן",
        reportText: "",
        time: "",
        in: null,
        date: "",
      },
    ]);
  });

  it("keeps a numeric phone in reminder ping", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "אשלח",
          metadata: {
            reminders: [
              { action: "add", item: "הודעה", in: 10, ping: [502222222] },
            ],
          },
        }),
      ).reminders?.[0]?.ping,
    ).toEqual(["502222222"]);
  });

  it("extracts a reminder that fires in a few seconds", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "תזכיר בעוד 10 שניות",
          metadata: {
            lists: [],
            filing: [],
            reminders: [
              {
                action: "add",
                item: "חלב",
                list_type: "shopping",
                in: 10,
              },
            ],
          },
        }),
      ).reminders,
    ).toEqual([
      {
        action: "add",
        item: "חלב",
        listType: "shopping",
        date: "",
        time: "",
        repeat: "once",
        ping: [],
        about: [],
        targets: [],
        text: "",
        inSeconds: 10,
        everyCount: null,
        everyUnit: null,
        weekdays: null,
        confirmed: false,
        compose: false,
        composeSource: "",
        composeLookbackHours: 0,
        composePlace: "",
        scheduleAnchor: "",
        scheduleOffsetMinutes: 0,
        composeCondition: null,
        watchOnce: undefined,
        composeAspects: [],
        reminderId: "",
      },
    ]);
  });

  it("reads schedule_anchor jewish_candles and offset_minutes", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            reminders: [
              {
                action: "add",
                item: "להדליק נרות",
                schedule_anchor: "jewish_candles",
                offset_minutes: -10,
                compose_place: "פתח תקווה",
                ping: ["SPEAKER"],
              },
            ],
          },
        }),
      ).reminders,
    ).toMatchObject([
      {
        action: "add",
        item: "להדליק נרות",
        scheduleAnchor: "jewish_candles",
        scheduleOffsetMinutes: -10,
        composePlace: "פתח תקווה",
      },
    ]);
  });

  it("maps minutes_before to negative offset_minutes", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            reminders: {
              action: "add",
              item: "להדליק נרות",
              schedule_anchor: "jewish_candles",
              minutes_before: 10,
              place: "תל אביב",
            },
          },
        }),
      ).reminders?.[0],
    ).toMatchObject({
      scheduleAnchor: "jewish_candles",
      scheduleOffsetMinutes: -10,
      composePlace: "תל אביב",
    });
  });

  it("accepts create, a single reminder object, and compact delay text", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "אשמור",
          metadata: {
            reminders: {
              action: "Create",
              item: "חלב",
              in: 20,
            },
          },
        }),
      ).reminders,
    ).toMatchObject([
      { action: "add", item: "חלב", inSeconds: 20 },
    ]);
  });

  it("reads compose:true as compose-at-fire brief mode", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "אשמור",
          metadata: {
            reminders: [
              {
                action: "add",
                item: "לשלוח ברכת בוקר לעמית",
                time: "09:00",
                ping: ["עמית"],
                text: "ברכת בוקר חמה וקצרה",
                compose: true,
              },
            ],
          },
        }),
      ).reminders,
    ).toMatchObject([
      {
        item: "לשלוח ברכת בוקר לעמית",
        text: "ברכת בוקר חמה וקצרה",
        compose: true,
        composeSource: "",
      },
    ]);
  });

  it("reads compose_source git_log as a platform digest clock", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "אשמור",
          metadata: {
            reminders: [
              {
                action: "add",
                item: "לשלוח סיכום פיתוח לעמית",
                time: "09:00",
                ping: ["עמית"],
                text: "Summarize product features and bug fixes since the last report in clear English.",
                compose: true,
                compose_source: "git_log",
                compose_lookback_hours: 168,
              },
            ],
          },
        }),
      ).reminders,
    ).toMatchObject([
      {
        compose: true,
        composeSource: "git_log",
        composeLookbackHours: 168,
  reminderId: "",
      },
    ]);
  });

  it("reads compose_source mashov and compose_place child", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "אשלח",
          metadata: {
            reminders: [
              {
                action: "add",
                item: "לשלוח ציוני משוב",
                compose: true,
                compose_source: "mashov",
                compose_place: "דניאל",
                text: "מה הציונים",
                in: 60,
                ping: ["עמית"],
              },
            ],
          },
        }),
      ).reminders,
    ).toMatchObject([
      {
        compose: true,
        composeSource: "mashov",
        composePlace: "דניאל",
      },
    ]);
  });

  it("reads compose_condition for conditional watches", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "אבדוק",
          metadata: {
            reminders: [
              {
                action: "add",
                item: "לבדוק שער ביטקוין",
                compose: true,
                compose_source: "market",
                compose_place: "BTC-USD",
                compose_condition: {
                  type: "market_price",
                  op: "lt",
                  value: 80000,
                },
                text: "עדכון ביטקוין",
                ping: ["עמית"],
              },
              {
                action: "add",
                item: "לעדכן כשיורד גשם",
                compose: true,
                compose_source: "weather",
                compose_place: "פתח תקווה",
                compose_condition: { type: "weather_rain" },
                text: "גשם",
                ping: ["עמית"],
              },
              {
                action: "add",
                item: "לבדוק עדכון משוב",
                compose: true,
                compose_source: "mashov",
                compose_place: "דניאל",
                compose_condition: { type: "mashov_new" },
                text: "משוב",
                ping: ["עמית"],
              },
            ],
          },
        }),
      ).reminders,
    ).toMatchObject([
      {
        composeCondition: {
          type: "market_price",
          op: "lt",
          value: 80000,
        },
      },
      { composeCondition: { type: "weather_rain" } },
      { composeCondition: { type: "mashov_new" } },
    ]);
  });

  it("rejects invalid expr AST (unknown op / too deep)", () => {
    expect(
      parseWatchExprNode({
        op: "pow",
        args: [{ const: 2 }, { const: 3 }],
      }),
    ).toBeNull();
    expect(
      parseWatchExprNode({
        op: "add",
        args: [
          {
            op: "add",
            args: [
              {
                op: "add",
                args: [
                  {
                    op: "add",
                    args: [{ const: 1 }, { const: 2 }],
                  },
                  { const: 3 },
                ],
              },
              { const: 4 },
            ],
          },
          { const: 5 },
        ],
      }),
    ).toBeNull();
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "x",
          metadata: {
            reminders: [
              {
                action: "add",
                item: "bad",
                compose: true,
                compose_condition: {
                  type: "expr",
                  compare: "eq",
                  left: { op: "xor", args: [{ const: 1 }, { const: 2 }] },
                  right: { const: 3 },
                },
                ping: ["עמית"],
              },
            ],
          },
        }),
      ).reminders[0]?.composeCondition,
    ).toBeNull();
  });

  it("reads expr and field_changed compose_condition", () => {
    const reminders = parseReplyMetadata(
      JSON.stringify({
        response: "אבדוק",
        metadata: {
          reminders: [
            {
              action: "add",
              item: "טמפ×2",
              compose: true,
              compose_source: "weather",
              compose_place: "פתח תקווה",
              compose_condition: {
                type: "expr",
                compare: "eq",
                left: {
                  op: "mul",
                  args: [
                    { field: "weather.temp_now", place: "פתח תקווה" },
                    { const: 2 },
                  ],
                },
                right: { const: 50 },
              },
              ping: ["עמית"],
            },
            {
              action: "add",
              item: "שינוי טמפ",
              compose: true,
              compose_source: "weather",
              compose_condition: {
                type: "field_changed",
                field: "weather.temp_now",
                place: "פתח תקווה",
              },
              ping: ["עמית"],
            },
            {
              action: "add",
              item: "יורו+דולר",
              compose: true,
              compose_source: "market",
              compose_condition: {
                type: "expr",
                compare: "approx",
                tol: 0.5,
                left: {
                  op: "add",
                  args: [
                    { field: "market.price", symbol: "יורו" },
                    { field: "market.price", symbol: "דולר" },
                  ],
                },
                right: { const: 10 },
              },
              ping: ["עמית"],
            },
          ],
        },
      }),
    ).reminders;
    expect(reminders).toMatchObject([
      {
        composeCondition: {
          type: "expr",
          compare: "eq",
          left: { op: "mul" },
          right: { const: 50 },
        },
      },
      {
        composeCondition: {
          type: "field_changed",
          field: "weather.temp_now",
          place: "פתח תקווה",
        },
      },
      {
        composeCondition: {
          type: "expr",
          compare: "approx",
          tol: 0.5,
        },
      },
    ]);
  });

  it("reads watch_once, compose_aspects, weather_changed, market_change_compare", () => {
    const reminders = parseReplyMetadata(
      JSON.stringify({
        response: "אבדוק",
        metadata: {
          reminders: [
            {
              action: "add",
              item: "שינוי מזג אוויר",
              compose: true,
              compose_source: "weather",
              compose_place: "פתח תקווה",
              compose_condition: { type: "weather_changed" },
              watch_once: true,
              text: "עדכון מזג אוויר",
              ping: ["עמית"],
            },
            {
              action: "add",
              item: "משוב רחב",
              compose: true,
              compose_source: "mashov",
              compose_place: "דניאל",
              compose_condition: { type: "mashov_new" },
              compose_aspects: [
                "grades",
                "behavior",
                "homework",
                "absences",
                "messages",
              ],
              text: "משוב",
              ping: ["עמית"],
            },
            {
              action: "add",
              item: "דולר מול יורו",
              compose: true,
              compose_source: "market",
              compose_condition: {
                type: "market_change_compare",
                left: "דולר",
                right: "יורו",
                op: "gt",
                metric: "daily_change_pct",
                left_day_offset: 0,
                right_day_offset: -1,
              },
              text: "השוואת שינוי",
              ping: ["עמית"],
            },
          ],
        },
      }),
    ).reminders;
    expect(reminders).toMatchObject([
      {
        watchOnce: true,
        composeCondition: { type: "weather_changed" },
      },
      {
        composeAspects: [
          "grades",
          "behavior",
          "homework",
          "absences",
          "messages",
        ],
        composeCondition: { type: "mashov_new" },
      },
      {
        composeCondition: {
          type: "market_change_compare",
          left: "דולר",
          right: "יורו",
          op: "gt",
          leftDayOffset: 0,
          rightDayOffset: -1,
        },
      },
    ]);
  });

  it("reads metadata.places for local business search", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            places: {
              query: "חשמלאי",
              place: "פתח תקווה",
              aspects: ["phone", "bogus"],
            },
          },
        }),
      ).places,
    ).toEqual({
      query: "חשמלאי",
      place: "פתח תקווה",
      near: "",
      lat: null,
      lng: null,
      aspects: ["phone"],
    });
  });

  it("reads metadata.jewish for Shabbat / parasha", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            jewish: {
              place: "פתח תקווה",
              date: "",
              aspects: ["candles", "bogus"],
            },
          },
        }),
      ).jewish,
    ).toEqual({
      place: "פתח תקווה",
      date: "",
      aspects: ["candles"],
    });
  });

  it("allows jewish parasha without place", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            jewish: { place: "", aspects: ["parasha"] },
          },
        }),
      ).jewish,
    ).toEqual({
      place: "",
      date: "",
      aspects: ["parasha"],
    });
  });

  it("ignores jewish summary without place", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            jewish: { place: "", aspects: ["summary"] },
          },
        }),
      ).jewish,
    ).toBeUndefined();
  });

  it("reads metadata.routes for transit trips", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            routes: {
              origin: "ז׳בוטינסקי פתח תקווה",
              destination: "דיזנגוף סנטר",
              line: "קו 51",
              aspects: ["eta", "bogus"],
            },
          },
        }),
      ).routes,
    ).toEqual({
      origin: "ז׳בוטינסקי פתח תקווה",
      destination: "דיזנגוף סנטר",
      departure: "",
      arrival: "",
      line: "51",
      headsign: "",
      aspects: ["eta"],
    });
  });

  it("ignores routes missing destination", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            routes: { origin: "תחנה מרכזית", destination: "" },
          },
        }),
      ).routes,
    ).toBeUndefined();
  });

  it("reads routes stop-board with lines aspect and empty destination", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            routes: {
              origin: "שלום דורני פתח תקווה",
              destination: "",
              aspects: ["lines"],
            },
          },
        }),
      ).routes,
    ).toEqual({
      origin: "שלום דורני פתח תקווה",
      destination: "",
      departure: "",
      arrival: "",
      line: "",
      headsign: "",
      aspects: ["lines"],
    });
  });

  it("reads places near speaker", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            places: { query: "מסעדות", place: "", near: "speaker" },
          },
        }),
      ).places,
    ).toEqual({
      query: "מסעדות",
      place: "",
      near: "speaker",
      lat: null,
      lng: null,
      aspects: ["summary"],
    });
  });

  it("reads bus_eta compose_condition", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "reminders",
                items: [
                  {
                    item: "לצאת לאוטובוס",
                    compose_condition: {
                      type: "bus_eta",
                      origin: "שלום דורני פתח תקווה",
                      destination: "תל אביב",
                      line: "51",
                      minutes_before: 10,
                    },
                  },
                ],
              },
            ],
          },
        }),
      ).reminders?.[0]?.composeCondition,
    ).toEqual({
      type: "bus_eta",
      origin: "שלום דורני פתח תקווה",
      destination: "תל אביב",
      line: "51",
      headsign: "",
      minutesBefore: 10,
    });
  });

  it("reads metadata.flights", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            flights: {
              airport: "TLV",
              direction: "arrivals",
              airline: "אל על",
              city: "פריז",
              flight: "3242CXD",
              date: "2026-10-23",
              aspects: ["next", "status", "bogus"],
            },
          },
        }),
      ).flights,
    ).toEqual({
      airport: "TLV",
      direction: "arrivals",
      airline: "אל על",
      city: "פריז",
      flight: "3242CXD",
      date: "2026-10-23",
      withinMinutes: 0,
      aspects: ["next", "status"],
    });
  });

  it("reads flights within_minutes", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            flights: {
              direction: "arrivals",
              within_minutes: 30,
              aspects: ["board"],
            },
          },
        }),
      ).flights,
    ).toEqual({
      airport: "",
      direction: "arrivals",
      airline: "",
      city: "",
      flight: "",
      date: "",
      withinMinutes: 30,
      aspects: ["board"],
    });
  });

  it("reads flight_eta and flight_changed compose_condition", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "reminders",
                items: [
                  {
                    item: "לפני נחיתה",
                    compose_condition: {
                      type: "flight_eta",
                      airport: "TLV",
                      direction: "arrivals",
                      flight: "LY831",
                      hours_before: 30,
                    },
                  },
                ],
              },
            ],
          },
        }),
      ).reminders?.[0]?.composeCondition,
    ).toEqual({
      type: "flight_eta",
      airport: "TLV",
      direction: "arrivals",
      flight: "LY831",
      airline: "",
      city: "",
      minutesBefore: 0,
      hoursBefore: 30,
    });
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "reminders",
                items: [
                  {
                    item: "שינויי טיסה",
                    compose_condition: {
                      type: "flight_changed",
                      airport: "TLV",
                      direction: "departures",
                      flight: "LY831",
                    },
                  },
                ],
              },
            ],
          },
        }),
      ).reminders?.[0]?.composeCondition,
    ).toEqual({
      type: "flight_changed",
      airport: "TLV",
      direction: "departures",
      flight: "LY831",
    });
  });

  it("reads metadata.mashov without requiring password", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            mashov: {
              child: "דניאל",
              aspects: ["grades", "homework", "bogus"],
            },
          },
        }),
      ).mashov,
    ).toEqual({
      child: "דניאל",
      aspects: ["grades", "homework"],
    });
  });

  it("reads compose_source market and compose_place tickers", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "אשלח",
          metadata: {
            reminders: [
              {
                action: "add",
                item: "לשלוח ציטוטי שוק",
                list_type: "tasks",
                compose: true,
                compose_source: "market",
                compose_place: "AAPL,BTC-USD",
                text: "מה המחירים",
                in: 60,
                ping: ["עמית"],
              },
            ],
          },
        }),
      ).reminders,
    ).toMatchObject([
      {
        compose: true,
        composeSource: "market",
        composePlace: "AAPL,BTC-USD",
      },
    ]);
  });

  it("reads metadata.market for a live ask", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            market: {
              queries: ["AAPL", "ביטקוין"],
              aspects: ["price", "bogus"],
            },
          },
        }),
      ).market,
    ).toEqual({
      queries: ["AAPL", "ביטקוין"],
      aspects: ["price"],
    });
  });

  it("ignores market without queries", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            market: { queries: [], aspects: ["summary"] },
          },
        }),
      ).market,
    ).toBeUndefined();
  });

  it("reads compose_source weather and compose_place", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "אשלח",
          metadata: {
            reminders: [
              {
                action: "add",
                item: "לשלוח מזג אוויר",
                list_type: "tasks",
                compose: true,
                compose_source: "weather",
                compose_place: "תל אביב",
                text: "מה מזג האוויר היום",
                in: 60,
                ping: ["עמית"],
              },
            ],
          },
        }),
      ).reminders,
    ).toMatchObject([
      {
        compose: true,
        composeSource: "weather",
        composePlace: "תל אביב",
      },
    ]);
  });

  it("reads metadata.weather for a live ask", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            weather: {
              place: "New York",
              date: "2026-10-21",
              aspects: ["wind", "waves", "bogus"],
            },
          },
        }),
      ).weather,
    ).toEqual({
      place: "New York",
      date: "2026-10-21",
      aspects: ["wind", "waves"],
    });
  });

  it("ignores weather without place", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "",
          metadata: {
            weather: { place: "", aspects: ["summary"] },
          },
        }),
      ).weather,
    ).toBeUndefined();
  });

  it("reads compose_source saved_data as a live status clock", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "אשלח כל בוקר",
          metadata: {
            reminders: [
              {
                action: "add",
                item: "לשלוח סטטוס יומי",
                time: "08:00",
                every_count: 1,
                every_unit: "days",
                ping: ["טל"],
                text: "מה יש לי היום במטלות ובתזכורות",
                compose: true,
                compose_source: "saved_data",
              },
            ],
          },
        }),
      ).reminders,
    ).toMatchObject([
      {
        compose: true,
        composeSource: "saved_data",
      },
    ]);
  });

  it("reads fractional compose_lookback_hours for short windows", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "אשלח",
          metadata: {
            reminders: [
              {
                action: "add",
                item: "סיכום 5 דקות",
                in: 10,
                ping: ["טל"],
                text: "Summarize code changes from the last 5 minutes.",
                compose: true,
                compose_source: "git_log",
                compose_lookback_hours: 0.083,
              },
            ],
          },
        }),
      ).reminders[0]?.composeLookbackHours,
    ).toBeCloseTo(0.083, 3);
  });

  it("reads structured every_count and weekdays", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "אשמור",
          metadata: {
            reminders: [
              {
                action: "add",
                item: "התאמן",
                time: "08:05",
                every_count: 1,
                every_unit: "weeks",
              },
            ],
          },
        }),
      ).reminders,
    ).toMatchObject([
      { item: "התאמן", everyCount: 1, everyUnit: "weeks", repeat: "weekly" },
    ]);
  });

  it("reads a structured recurrence rule", () => {
    const [reminder] = parseReplyMetadata(
      JSON.stringify({
        response: "אשמור",
        metadata: {
          reminders: [
            {
              action: "add",
              item: "חדר כושר",
              recurrence: { freq: "weekly", interval: 1, weekdays: [2, 4], time: "19:00", count: 8 },
            },
          ],
        },
      }),
    ).reminders;
    expect(reminder).toMatchObject({
      item: "חדר כושר",
      repeat: "weekly",
      everyCount: null,
      recurrence: { freq: "weekly", interval: 1, weekdays: [2, 4], time: "19:00", count: 8 },
    });
  });

  it("freq none on update means stop repeating; null means unchanged", () => {
    const [stop, keep] = parseReplyMetadata(
      JSON.stringify({
        response: "עדכנתי",
        metadata: {
          reminders: [
            { action: "update", reminder_id: "r1", item: "ארנונה", recurrence: { freq: "none" } },
            { action: "update", reminder_id: "r2", item: "מים", recurrence: null },
          ],
        },
      }),
    ).reminders;
    expect(stop.recurrence).toBeNull();
    expect(keep).not.toHaveProperty("recurrence");
  });

  it("reads occurrence_change on a reminders update only", () => {
    const [cancel, move, add] = parseReplyMetadata(
      JSON.stringify({
        response: "עדכנתי",
        metadata: {
          reminders: [
            { action: "update", reminder_id: "r1", occurrence_change: { date: "2026-10-23", cancel: true } },
            { action: "update", reminder_id: "r2", occurrence_change: { date: "2026-10-23", time: "11:00" } },
            { action: "add", item: "x", time: "10:00", occurrence_change: { date: "2026-10-23", cancel: true } },
          ],
        },
      }),
    ).reminders!;
    expect(cancel.occurrenceChange).toEqual({ date: "2026-10-23", cancel: true });
    expect(move.occurrenceChange).toEqual({ date: "2026-10-23", time: "11:00" });
    expect(add).not.toHaveProperty("occurrenceChange");
  });

  it("does not translate Hebrew when or every fields", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "אשמור",
          metadata: {
            reminders: [
              { action: "add", item: "חלב", when: "מחר בערב", every: "כל שבוע" },
            ],
          },
        }),
      ).reminders,
    ).toMatchObject([
      { action: "add", item: "חלב", date: "", time: "", everyCount: null },
    ]);
  });

  it("accepts a named custom list with empty items (columns only)", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "פתחתי",
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "custom",
                list_name: "המטרות של הפועל פתח תקווה עד 2030",
                targets: ["טל", "עמית"],
                items: [],
              },
            ],
          },
        }),
      ).lists,
    ).toEqual([
      {
        action: "add",
        listType: "custom",
        listName: "המטרות של הפועל פתח תקווה עד 2030",
        items: [],
        targets: ["טל", "עמית"],
      },
    ]);
  });

  it("does not treat a top-level name as list_name when adding a real row", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "הוספתי",
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "custom",
                name: "לתמוך ברשימה ריקה",
                targets: [],
                items: [
                  {
                    list_name: "בעיות",
                    תיאור: "לתמוך ברשימה ריקה",
                  },
                ],
              },
            ],
          },
        }),
      ).lists,
    ).toEqual([
      {
        action: "add",
        listType: "custom",
        listName: "בעיות",
        items: [
          {
            list_name: "בעיות",
            תיאור: "לתמוך ברשימה ריקה",
          },
        ],
        targets: [],
      },
    ]);
  });

  it("clears list_name when it was copied from the new row text", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "הוספתי",
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "custom",
                list_name: "לתמוך ברשימה ריקה",
                targets: [],
                items: [{ תיאור: "לתמוך ברשימה ריקה" }],
              },
            ],
          },
        }),
      ).lists[0]?.listName,
    ).toBe("");
  });
});

describe("metadata.register", () => {
  it("parses a complete register action", () => {
    const meta = parseReplyMetadata(
      JSON.stringify({
        responses: ["נרשמת"],
        metadata: {
          register: {
            name: "מיכל",
            surname: "כהן",
            username: "michal",
            password: "SecretPass1",
          },
        },
      }),
    );
    expect(meta.register).toEqual({
      name: "מיכל",
      surname: "כהן",
      username: "michal",
      password: "SecretPass1",
    });
  });

  it("returns null when register fields are incomplete", () => {
    const meta = parseReplyMetadata(
      JSON.stringify({
        responses: ["?"],
        metadata: {
          register: {
            name: "מיכל",
            surname: "",
            username: "michal",
            password: "SecretPass1",
          },
        },
      }),
    );
    expect(meta.register).toBeNull();
  });

  it("redacts passwords from text and metadata", () => {
    const register = {
      name: "מיכל",
      surname: "כהן",
      username: "michal",
      password: "SecretPass1",
    };
    expect(redactRegisterSecrets("הסיסמה שלי SecretPass1 תודה", register)).toBe(
      "הסיסמה שלי •••••••• תודה",
    );
    expect(
      redactMetadataSecrets({
        lists: [],
        filing: [],
        register,
      }).register?.password,
    ).toBe("••••••••");
  });
});
