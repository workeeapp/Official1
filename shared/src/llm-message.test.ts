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
        hold: null,
        confirm: true,
      },
    });
    const parsed = parseLlmReply(raw);
    expect(parsed.response).toBe("");
    expect(parsed.response).not.toContain("metadata");
    expect(parsed.response).not.toContain("confirm");
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
      reportSections: [],
      reportHistoryKinds: [],
      hold: null,
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
            hold: {
              kind: "messages",
              need: "text",
              messages: [{ targets: ["מאיה"], text: "" }],
            },
          },
        }),
      ),
    ).toMatchObject({
      messages: [{ targets: ["מאיה"], text: "" }],
      hold: {
        kind: "messages",
        need: "text",
        messages: [{ targets: ["מאיה"], text: "" }],
      },
    });
    expect(
      parseReplyMetadata(
        JSON.stringify({
          response: "מה שם המשפחה?",
          metadata: {
            hold: {
              kind: "directory",
              need: "שם משפחה",
              directory: [
                { action: "add", name: "יואב", phone: "0515520802", contactId: "" },
              ],
            },
          },
        }),
      ),
    ).toMatchObject({
      hold: {
        kind: "directory",
        need: "שם משפחה",
        directory: [{ action: "add", name: "יואב", phone: "0515520802", contactId: "" }],
      },
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
        reminderId: "",
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
