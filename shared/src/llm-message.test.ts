import { describe, expect, it } from "vitest";
import { parseLlmReply, parseReplyMetadata } from "./llm-message.js";

describe("parseLlmReply", () => {
  it("returns plain text when the reply is not JSON", () => {
    expect(parseLlmReply("Hello from the assistant")).toEqual({
      response: "Hello from the assistant",
      actions: [],
    });
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
      filing: [
        {
          action: "add_filing",
          itemName: "מספר רכב",
          itemInfo: "3434343",
          targets: [],
        },
      ],
      messages: [],
      reminders: [],
      handoff: null,
      query: null,
      confirm: null,
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
          metadata: { query: "reminders", confirm: true },
        }),
      ),
    ).toMatchObject({ query: "reminders", confirm: true });
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

  it("keeps a numeric phone in reminder ping", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "אשלח",
          metadata: {
            reminders: [
              { action: "add", item: "הודעה", in: "10s", ping: [502222222] },
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
                in: "10 seconds",
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
        targets: [],
        text: "",
        inSeconds: 10,
        everyCount: null,
        everyUnit: null,
        weekdays: null,
        confirmed: false,
      },
    ]);
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
              in: "20s",
            },
          },
        }),
      ).reminders,
    ).toMatchObject([
      { action: "add", item: "חלב", inSeconds: 20 },
    ]);
  });

  it("reads a weekly every field", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "אשמור",
          metadata: {
            reminders: [
              { action: "add", item: "התאמן", time: "08:05", every: "כל שבוע" },
            ],
          },
        }),
      ).reminders,
    ).toMatchObject([
      { item: "התאמן", everyCount: 1, everyUnit: "weeks", repeat: "weekly" },
    ]);
  });

  it("reads a Hebrew when field as date plus evening ping", () => {
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "אשמור",
          metadata: {
            reminders: [
              { action: "add", item: "חלב", when: "מחר בערב" },
            ],
          },
        }),
      ).reminders,
    ).toMatchObject([{ action: "add", item: "חלב", date: "מחר", time: "20:00" }]);
  });
});
