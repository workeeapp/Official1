import { describe, expect, it } from "vitest";
import { emptyLlmMetadata, type PublicEmployee } from "@workee/shared";
import {
  dropSpeakerTaskAddsForOutboundClocks,
  fallbackNotificationText,
  formatMissingSendTextNotice,
  planPhoneRelays,
  planRelayDeliveries,
  planTargetedActions,
  resolveActionTargets,
  resolveRelayMessages,
  resolveSpokenMetadata,
} from "../src/services/employee-targets.service.js";

const amit: PublicEmployee = {
  id: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
  name: "עמית",
  surname: "חתן",
  nickname: "עמית",
  email: null,
  phone: null,
};

const tal: PublicEmployee = {
  id: "4cded1a2-c4c1-4edc-9d87-fe5ac740c1f4",
  name: "טל",
  surname: "דור",
  nickname: "טל",
  email: null,
  phone: null,
};

const shani: PublicEmployee = {
  id: "5cded1a2-c4c1-4edc-9d87-fe5ac740c1f5",
  name: "שני",
  surname: "כהן",
  nickname: "שני",
  email: null,
  phone: null,
};

const employees = [amit, tal, shani];

describe("employee targets", () => {
  it("applies metadata targets without reading the user sentence", () => {
    const resolved = resolveSpokenMetadata(
      "טל צריך לקחת מחר בבוקר את הילדים לגינה",
      {
        lists: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [{ "שם מטלה": "לקחת מחר בבוקר את הילדים לגינה" }],
            targets: ["טל"],
          },
        ],
        filing: [],
      },
      employees,
      amit.id,
    );

    expect(resolved.lists[0]?.targets).toEqual(["טל"]);
    expect(resolved.lists[0]?.items[0]?.["שם מטלה"]).toBe(
      "לקחת מחר בבוקר את הילדים לגינה",
    );

    const plan = planTargetedActions({
      actor: amit,
      employees,
      metadata: resolved,
    });
    expect(plan.applications.some((item) => item.employeeId === tal.id)).toBe(
      true,
    );
    expect(plan.notifications.map((item) => item.employee.id)).toEqual([tal.id]);
  });

  it("puts a meeting with Tal on both calendars and skips the assignment note", () => {
    const resolved = resolveSpokenMetadata(
      "שמור פגישה עם טל ליום ראשון בשעה 10",
      {
        lists: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [
              {
                "שם מטלה": "פגישה עם טל",
                "תאריך לביצוע": "יום ראשון",
                "שעה לביצוע": "10:00",
              },
            ],
            targets: ["עמית", "טל"],
          },
        ],
        filing: [],
      },
      employees,
      amit.id,
    );

    expect(resolved.lists[0]?.targets).toEqual(["עמית", "טל"]);

    const plan = planTargetedActions({
      actor: amit,
      employees,
      metadata: resolved,
    });

    expect(
      plan.applications.filter((item) =>
        item.metadata.lists.some((list) =>
          list.items.some((entry) => entry["שם מטלה"] === "פגישה עם טל"),
        ),
      ).map((item) => item.employeeId).sort(),
    ).toEqual([amit.id, tal.id].sort());
    expect(
      plan.applications.some((item) =>
        item.metadata.lists.some((list) =>
          list.items.some(
            (entry) =>
              typeof entry["שם מטלה"] === "string" &&
              String(entry["שם מטלה"]).includes("קיבל מטלה"),
          ),
        ),
      ),
    ).toBe(false);
  });

  it("does not invent a task from a question about someone else", () => {
    expect(
      resolveSpokenMetadata(
        "מה טל צריך לעשות",
        { lists: [], filing: [] },
        employees,
        amit.id,
      ),
    ).toEqual({
      lists: [],
      filing: [],
      directory: [],
      messages: [],
      reminders: [],
      handoff: null,
      query: null,
      confirm: null,
      reportSections: [],
      targets: [],
    });
  });

  it("does not invent a task when the LLM returns no actions", () => {
    const resolved = resolveSpokenMetadata(
      "טל צריך לקחת מחר בבוקר את הילדים לגינה",
      { lists: [], filing: [] },
      employees,
      amit.id,
    );
    expect(resolved.lists).toEqual([]);
  });

  it("defaults to the speaker when no target is given", () => {
    expect(resolveActionTargets([], employees, amit.id)).toEqual([amit]);
  });

  it("resolves one employee, several employees, or everyone", () => {
    expect(resolveActionTargets(["טל"], employees, amit.id)).toEqual([tal]);
    expect(resolveActionTargets(["טל", "שני"], employees, amit.id)).toEqual([
      tal,
      shani,
    ]);
    expect(resolveActionTargets(["כולם"], employees, amit.id)).toEqual(employees);
  });

  it("plans Tal's shopping item and a notification without a speaker assignment note", () => {
    const plan = planTargetedActions({
      actor: amit,
      employees,
      metadata: {
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "חלב" }],
            targets: ["טל"],
          },
        ],
        filing: [],
      },
    });

    expect(plan.applications).toEqual([
      expect.objectContaining({
        employeeId: tal.id,
        metadata: expect.objectContaining({
          lists: [
            expect.objectContaining({
              listType: "shopping",
              items: [{ "שם פריט": "חלב" }],
            }),
          ],
        }),
      }),
    ]);
    expect(
      plan.applications.some((item) => item.employeeId === amit.id),
    ).toBe(false);
    expect(plan.notifications).toEqual([
      expect.objectContaining({
        employee: tal,
      }),
    ]);
  });

  it("drops a speaker task add when the same turn only clocks an outbound send", () => {
    const lucy: PublicEmployee = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "digital",
      name: "לוסי",
      surname: "",
      nickname: "לוסי",
      email: null,
      phone: null,
    };
    const stripped = dropSpeakerTaskAddsForOutboundClocks({
      actorId: amit.id,
      employees,
      workers: [lucy],
      reminders: [
        {
          action: "add",
          item: "לשלוח הודעה למיכל",
          listType: "tasks",
          date: "",
          time: "09:00",
          repeat: "1:days",
          ping: ["מיכל"],
          targets: ["מיכל"],
          text: "ברכת בוקר חמה",
          inSeconds: null,
          everyCount: 1,
          everyUnit: "days",
          weekdays: null,
          confirmed: false,
          compose: true,
          composeSource: "",
          composeLookbackHours: 0,
        },
      ],
      lists: [
        {
          action: "add",
          listType: "tasks",
          listName: "",
          items: [{ "שם מטלה": "לשלוח הודעה למיכל" }],
          targets: ["עמית"],
        },
        {
          action: "add",
          listType: "tasks",
          listName: "",
          items: [{ "שם מטלה": "לשלוח הודעה למיכל" }],
          targets: ["לוסי"],
        },
      ],
    });
    expect(stripped).toEqual([
      expect.objectContaining({
        targets: ["לוסי"],
      }),
    ]);

    const plan = planTargetedActions({
      actor: amit,
      employees,
      workers: [lucy],
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [{ "שם מטלה": "לשלוח הודעה למיכל" }],
            targets: ["עמית"],
          },
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [{ "שם מטלה": "לשלוח הודעה למיכל" }],
            targets: ["לוסי"],
          },
        ],
        reminders: [
          {
            action: "add",
            item: "לשלוח הודעה למיכל",
            listType: "tasks",
            date: "",
            time: "09:00",
            repeat: "1:days",
            ping: ["טל"],
            targets: ["טל"],
            text: "ברכת בוקר חמה",
            inSeconds: null,
            everyCount: 1,
            everyUnit: "days",
            weekdays: null,
            confirmed: false,
            compose: true,
            composeSource: "",
            composeLookbackHours: 0,
          },
        ],
      },
    });
    expect(plan.applications.map((row) => row.employeeId)).toEqual([lucy.id]);
  });

  it("keeps a speaker self-nudge task when the clock pings the speaker", () => {
    const lists = dropSpeakerTaskAddsForOutboundClocks({
      actorId: amit.id,
      employees,
      reminders: [
        {
          action: "add",
          item: "לשתות מים",
          listType: "tasks",
          date: "",
          time: "",
          repeat: "once",
          ping: ["עמית"],
          targets: ["עמית"],
          text: "",
          inSeconds: 3600,
          everyCount: null,
          everyUnit: null,
          weekdays: null,
          confirmed: false,
          compose: false,
          composeSource: "",
          composeLookbackHours: 0,
        },
      ],
      lists: [
        {
          action: "add",
          listType: "tasks",
          listName: "",
          items: [{ "שם מטלה": "לשתות מים" }],
          targets: [],
        },
      ],
    });
    expect(lists).toHaveLength(1);
  });

  it("applies an everyone action to each employee", () => {
    const plan = planTargetedActions({
      actor: amit,
      employees,
      metadata: {
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "חלב" }, { "שם פריט": "גבינה" }],
            targets: ["all"],
          },
        ],
        filing: [],
      },
    });

    expect(
      [...new Set(plan.applications.map((item) => item.employeeId))].sort(),
    ).toEqual([amit.id, shani.id, tal.id].sort());
    expect(
      plan.applications.find(
        (item) => item.employeeId === tal.id && item.visibility.scope === "shared",
      )?.visibility.visibleTo,
    ).toEqual(expect.arrayContaining([amit.id, tal.id, shani.id]));
    expect(plan.notifications.map((item) => item.employee.id).sort()).toEqual(
      [shani.id, tal.id].sort(),
    );
    const amitApps = plan.applications.filter((item) => item.employeeId === amit.id);
    expect(
      amitApps.some((item) =>
        item.metadata.lists.some((list) => list.listType === "shopping"),
      ),
    ).toBe(true);
    expect(
      amitApps.some((item) =>
        item.metadata.lists.some(
          (list) =>
            list.listType === "tasks" &&
            list.items.some((entry) =>
              String(entry["שם מטלה"] ?? "").includes("צריכים לקנות"),
            ),
        ),
      ),
    ).toBe(false);
  });

  it("builds a fallback notification for Tal's assistant", () => {
    expect(
      fallbackNotificationText(amit, {
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "חלב" }],
            targets: [],
          },
        ],
        filing: [],
      }),
    ).toBe("עמית הוסיף חלב לרשימת הקניות שלך");
    expect(
      fallbackNotificationText(
        amit,
        {
          lists: [
            {
              action: "add",
              listType: "shopping",
              listName: "",
              items: [{ "שם פריט": "חלב" }],
              targets: [],
            },
          ],
          filing: [],
        },
        { partnerNames: ["טל"] },
      ),
    ).toBe("עמית הוסיף חלב לרשימת הקניות שלך");
  });

  it("appends a linked reminder clock to a task notification", () => {
    expect(
      fallbackNotificationText(tal, {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [{ "שם מטלה": "ללכת לקוסמטיקאית" }],
            targets: [],
          },
        ],
        reminders: [
          {
            action: "add",
            item: "להזכיר למיכל ללכת לקוסמטיקאית",
            listType: "tasks",
            date: "",
            time: "",
            repeat: "once",
            ping: ["מיכל"],
            targets: ["מיכל"],
            text: "",
            inSeconds: 3600,
            everyCount: null,
            everyUnit: null,
            weekdays: null,
            confirmed: false,
            compose: false,
            composeSource: "",
            composeLookbackHours: 0,
          },
        ],
      }),
    ).toBe(
      "טל הוסיף לך מטלה: ללכת לקוסמטיקאית, ותזכורת בעוד שעה",
    );
  });

  it("attaches same-turn reminders onto the targeted person's notify metadata", () => {
    const michal: PublicEmployee = {
      id: "michal-1",
      name: "מיכל",
      surname: "",
      nickname: "מיכל",
      email: null,
      phone: null,
    };
    const plan = planTargetedActions({
      actor: tal,
      employees: [tal, michal],
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [{ "שם מטלה": "ללכת לקוסמטיקאית" }],
            targets: ["מיכל"],
          },
        ],
        reminders: [
          {
            action: "add",
            item: "להזכיר למיכל ללכת לקוסמטיקאית",
            listType: "tasks",
            date: "",
            time: "",
            repeat: "once",
            ping: ["מיכל"],
            targets: ["מיכל"],
            text: "",
            inSeconds: 3600,
            everyCount: null,
            everyUnit: null,
            weekdays: null,
            confirmed: false,
            compose: false,
            composeSource: "",
            composeLookbackHours: 0,
          },
        ],
      },
    });
    const notify = plan.notifications.find((row) => row.employee.id === michal.id);
    expect(notify?.metadata.reminders).toHaveLength(1);
    expect(
      fallbackNotificationText(tal, notify!.metadata, {
        recipientIsOwner: true,
      }),
    ).toBe(
      "טל הוסיף לך מטלה: ללכת לקוסמטיקאית, ותזכורת בעוד שעה",
    );
  });

  it("notifies a shared custom-list partner with item and list names", () => {
    expect(
      fallbackNotificationText(
        amit,
        {
          lists: [
            {
              action: "add",
              listType: "custom",
              listName: "משימות לעבודה",
              items: [{ תיאור: "להוסיף לתיאור גם מידע כללי" }],
              targets: [],
            },
          ],
          filing: [],
        },
        { partnerNames: ["טל"] },
      ),
    ).toBe(
      "עמית הוסיף פריט חדש «להוסיף לתיאור גם מידע כללי» לרשימת «משימות לעבודה»",
    );
  });

  it("treats a title-only custom item as opening a shared list", () => {
    expect(
      fallbackNotificationText(
        tal,
        {
          lists: [
            {
              action: "add",
              listType: "custom",
              listName: "",
              items: [{ "שם פריט": "באגים לתיקון" }],
              targets: [],
            },
          ],
          filing: [],
        },
        { partnerNames: ["עמית"] },
      ),
    ).toBe("טל הוסיף רשימה משותפת לך ולעמית: «באגים לתיקון»");
  });

  it("opens a shared custom list when the model stuffed the title as the only item", () => {
    const plan = planTargetedActions({
      actor: tal,
      employees,
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "custom",
            listName: "",
            targets: ["טל", "עמית"],
            items: [{ "שם פריט": "באגים לתיקון" }],
          },
        ],
      },
    });
    expect(plan.applications.map((row) => row.employeeId)).toEqual([tal.id]);
    expect(plan.applications[0]?.metadata.lists[0]).toMatchObject({
      listName: "באגים לתיקון",
      items: [],
    });
    expect(plan.notifications).toHaveLength(1);
    expect(
      fallbackNotificationText(tal, plan.notifications[0]!.metadata, {
        partnerNames: plan.notifications[0]!.partnerNames,
      }),
    ).toBe("טל הוסיף רשימה משותפת לך ולעמית: «באגים לתיקון»");
  });

  it("keeps a real custom row when list_name is missing but columns are not a title", () => {
    const plan = planTargetedActions({
      actor: tal,
      employees,
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "custom",
            listName: "משימות לעבודה",
            targets: ["טל", "עמית"],
            items: [{ תיאור: "להוסיף לתיאור גם מידע כללי" }],
          },
        ],
      },
    });
    expect(plan.applications[0]?.metadata.lists[0]?.items).toEqual([
      { תיאור: "להוסיף לתיאור גם מידע כללי" },
    ]);
  });

  it("routes a partner add onto the existing shared list owner", () => {
    const plan = planTargetedActions({
      actor: amit,
      employees,
      sharedLists: [
        {
          ownerId: tal.id,
          listName: "באגים",
          visibleTo: [tal.id, amit.id],
        },
      ],
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "custom",
            listName: "באגים",
            targets: [],
            items: [{ שם: "הבאג בחלון צ'ט" }],
          },
        ],
      },
    });
    expect(plan.applications.map((row) => row.employeeId)).toEqual([tal.id]);
    expect(plan.applications[0]?.visibility.scope).toBe("shared");
    expect(plan.applications[0]?.visibility.visibleTo.sort()).toEqual(
      [tal.id, amit.id].sort(),
    );
    expect(plan.notifications.map((row) => row.employee.id)).toEqual([tal.id]);
    expect(
      fallbackNotificationText(amit, plan.notifications[0]!.metadata, {
        partnerNames: plan.notifications[0]!.partnerNames,
      }),
    ).toBe('עמית הוסיף פריט חדש «הבאג בחלון צ\'ט» לרשימת «באגים»');
  });

  it("removes a shared-list item from every duplicate owner copy", () => {
    const plan = planTargetedActions({
      actor: tal,
      employees,
      sharedLists: [
        {
          ownerId: tal.id,
          listName: "בעיות",
          visibleTo: [tal.id, amit.id],
        },
        {
          ownerId: amit.id,
          listName: "בעיות",
          visibleTo: [tal.id, amit.id],
        },
      ],
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "remove",
            listType: "custom",
            listName: "בעיות",
            targets: [],
            items: [{ תיאור: "לבדוק שוב את הפונקציונליות" }],
          },
        ],
      },
    });
    expect(plan.applications.map((row) => row.employeeId).sort()).toEqual(
      [tal.id, amit.id].sort(),
    );
    for (const row of plan.applications) {
      expect(row.metadata.lists[0]).toMatchObject({
        action: "remove",
        listName: "בעיות",
        items: [{ תיאור: "לבדוק שוב את הפונקציונליות" }],
      });
    }
  });

  it("adds onto one canonical shared list when duplicates exist", () => {
    const plan = planTargetedActions({
      actor: tal,
      employees,
      sharedLists: [
        {
          ownerId: amit.id,
          listName: "בעיות",
          visibleTo: [tal.id, amit.id],
        },
        {
          ownerId: tal.id,
          listName: "בעיות",
          visibleTo: [tal.id, amit.id],
        },
      ],
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "custom",
            listName: "בעיות",
            targets: [],
            items: [{ תיאור: "פריט חדש" }],
          },
        ],
      },
    });
    expect(plan.applications).toHaveLength(1);
    expect(plan.applications[0]?.employeeId).toBe(amit.id);
  });

  it("does not notify partners when updating a personal custom list even if LLM targets include them", () => {
    const plan = planTargetedActions({
      actor: tal,
      employees,
      sharedLists: [
        {
          ownerId: tal.id,
          listName: "שיעורי נהיגה של מאיה",
          visibleTo: [tal.id],
          scope: "personal",
        },
      ],
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "custom",
            listName: "שיעורי נהיגה של מאיה",
            // Model wrongly re-states teammates as targets.
            targets: ["טל", "עמית"],
            items: [{ שיעור: "שיעור 5" }],
          },
        ],
      },
    });
    expect(plan.applications).toHaveLength(1);
    expect(plan.applications[0]?.employeeId).toBe(tal.id);
    expect(plan.applications[0]?.visibility.scope).toBe("personal");
    expect(plan.applications[0]?.visibility.visibleTo).toEqual([tal.id]);
    expect(plan.notifications).toHaveLength(0);
  });

  it("does not match an unrelated shared list by substring name", () => {
    const plan = planTargetedActions({
      actor: tal,
      employees,
      sharedLists: [
        {
          ownerId: tal.id,
          listName: "שיעורי",
          visibleTo: [tal.id, amit.id],
          scope: "shared",
        },
        {
          ownerId: tal.id,
          listName: "שיעורי נהיגה של מאיה",
          visibleTo: [tal.id],
          scope: "personal",
        },
      ],
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "custom",
            listName: "שיעורי נהיגה של מאיה",
            targets: ["טל", "עמית"],
            items: [{ שיעור: "שיעור 6" }],
          },
        ],
      },
    });
    expect(plan.applications[0]?.visibility.scope).toBe("personal");
    expect(plan.notifications.map((row) => row.employee.id)).toEqual([]);
  });

  it("notifies only DB partners of a shared list, ignoring extra LLM targets", () => {
    const plan = planTargetedActions({
      actor: tal,
      employees,
      sharedLists: [
        {
          ownerId: tal.id,
          listName: "בעיות",
          visibleTo: [tal.id, amit.id],
          scope: "shared",
        },
      ],
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "custom",
            listName: "בעיות",
            targets: ["טל", "עמית", "שני"],
            items: [{ תיאור: "עודכן" }],
          },
        ],
      },
    });
    expect(plan.notifications.map((row) => row.employee.id).sort()).toEqual(
      [amit.id].sort(),
    );
  });

  it("notifies an item add on an existing shared list, not a new list shell", () => {
    const plan = planTargetedActions({
      actor: tal,
      employees,
      sharedLists: [
        {
          ownerId: tal.id,
          listName: "בעיות",
          visibleTo: [tal.id, amit.id],
        },
      ],
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "custom",
            listName: "בעיות",
            // Model often re-states partners when adding a row to a shared list.
            targets: ["טל", "עמית"],
            items: [
              {
                תיאור: "הוספת פריט מצוינת כהוספת רשימה בהודעה",
              },
            ],
          },
        ],
      },
    });
    expect(plan.notifications.map((row) => row.employee.id)).toEqual([amit.id]);
    expect(
      fallbackNotificationText(tal, plan.notifications[0]!.metadata, {
        partnerNames: plan.notifications[0]!.partnerNames,
      }),
    ).toBe(
      "טל הוסיף פריט חדש «הוספת פריט מצוינת כהוספת רשימה בהודעה» לרשימת «בעיות»",
    );
  });

  it("does not notify partners when re-touching an existing shared list with no rows", () => {
    const plan = planTargetedActions({
      actor: tal,
      employees,
      sharedLists: [
        {
          ownerId: tal.id,
          listName: "בעיות",
          visibleTo: [tal.id, amit.id],
        },
      ],
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "custom",
            listName: "בעיות",
            targets: ["טל", "עמית"],
            items: [],
          },
        ],
      },
    });
    expect(plan.applications).toHaveLength(1);
    expect(plan.notifications).toHaveLength(0);
  });

  it("prefers a real item mutation when a shell open is merged into the same notice", () => {
    expect(
      fallbackNotificationText(
        tal,
        {
          lists: [
            {
              action: "add",
              listType: "custom",
              listName: "בעיות",
              items: [],
              targets: [],
            },
            {
              action: "add",
              listType: "custom",
              listName: "בעיות",
              items: [
                {
                  תיאור: "הוספת פריט מצוינת כהוספת רשימה בהודעה",
                },
              ],
              targets: [],
            },
          ],
          filing: [],
        },
        { partnerNames: ["עמית"] },
      ),
    ).toBe(
      "טל הוסיף פריט חדש «הוספת פריט מצוינת כהוספת רשימה בהודעה» לרשימת «בעיות»",
    );
  });

  it("does not use the item text as the list title when list_name is missing", () => {
    expect(
      fallbackNotificationText(
        amit,
        {
          lists: [
            {
              action: "add",
              listType: "custom",
              listName: "",
              items: [{ תיאור: "לתמוך ברשימה ריקה" }],
              targets: [],
            },
          ],
          filing: [],
        },
        { partnerNames: ["טל"] },
      ),
    ).not.toContain("לרשימת «לתמוך ברשימה ריקה»");
  });

  it("keeps בעיות as the list title when adding a row to that shared list", () => {
    const plan = planTargetedActions({
      actor: amit,
      employees,
      sharedLists: [
        {
          ownerId: tal.id,
          listName: "בעיות",
          visibleTo: [tal.id, amit.id],
        },
      ],
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "custom",
            // Model stuffed the row into list_name; item list_name has the real title.
            listName: "לתמוך ברשימה ריקה",
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
    });
    expect(plan.applications[0]?.metadata.lists[0]?.listName).toBe("בעיות");
    expect(
      fallbackNotificationText(amit, plan.notifications[0]!.metadata, {
        partnerNames: plan.notifications[0]!.partnerNames,
      }),
    ).toBe(
      "עמית הוסיף פריט חדש «לתמוך ברשימה ריקה» לרשימת «בעיות»",
    );
  });

  it("ignores list_name stuffed into the item when labeling shared adds", () => {
    expect(
      fallbackNotificationText(amit, {
        lists: [
          {
            action: "add",
            listType: "custom",
            listName: "משימות לעבודה",
            items: [
              {
                list_name: "משימות לעבודה",
                תיאור: "להוסיף לתיאור גם מידע כללי",
              },
            ],
            targets: [],
          },
        ],
        filing: [],
      }),
    ).toBe(
      "עמית הוסיף פריט חדש «להוסיף לתיאור גם מידע כללי» לרשימת «משימות לעבודה»",
    );
  });

  it("plans a Lucy message for Tal and a digital employee", () => {
    const lucy: PublicEmployee = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "digital",
      name: "לוסי",
      surname: "",
      nickname: "לוסי",
      email: null,
      phone: null,
    };
    const diana: PublicEmployee = {
      id: "8bbbe1a2-c4c1-4edc-9d87-fe5ac740c1f4",
      kind: "digital",
      name: "דיאנה",
      surname: "",
      nickname: "דיאנה",
      email: null,
      phone: null,
    };
    const roster = [...employees, lucy, diana];

    expect(
      resolveRelayMessages([
        {
          targets: ["טל"],
          text: "עמית שואל מה שלומך?\nמה לענות לו ?",
        },
      ]),
    ).toEqual([
      {
        targets: ["טל"],
        text: "עמית שואל מה שלומך?\nמה לענות לו ?",
      },
    ]);

    expect(resolveRelayMessages([])).toEqual([]);
    expect(
      formatMissingSendTextNotice([{ targets: ["עמית"], text: "" }]),
    ).toBe("מה לשלוח ל«עמית»? אפשר גם שלום.");
    expect(
      formatMissingSendTextNotice([{ targets: ["עמית"], text: "היי" }]),
    ).toBe("");

    expect(
      planRelayDeliveries({
        actor: amit,
        sender: lucy,
        employees: roster,
        messages: [
          { targets: ["טל"], text: "עמית שואל מה שלומך ?" },
          { targets: ["דיאנה"], text: "עמית שואל מה מחיר הטיסה ?" },
        ],
      }),
    ).toEqual([
      {
        employeeId: tal.id,
        digitalEmployeeId: lucy.id,
        target: tal,
        text: "עמית שואל מה שלומך ?",
      },
      {
        employeeId: amit.id,
        digitalEmployeeId: diana.id,
        target: diana,
        text: "עמית שואל מה מחיר הטיסה ?",
      },
    ]);
  });

  it("builds a purchase notification when someone buys a shared item", () => {
    expect(
      fallbackNotificationText(
        tal,
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
        { completed: true },
      ),
    ).toBe("טל קנה קופסת טונה");
  });

  it("applies a named digital worker task without an assignment on the speaker", () => {
    const lucy: PublicEmployee = {
      id: "lucy-1",
      kind: "digital",
      name: "לוסי",
      surname: "",
      nickname: "לוסי",
      email: null,
      phone: null,
      protected: true,
    };
    const plan = planTargetedActions({
      actor: amit,
      employees,
      workers: [lucy],
      metadata: {
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "חלב" }],
            targets: ["עמית"],
          },
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [{ "שם מטלה": "להזכיר לעמית לקנות חלב ב-08:00" }],
            targets: ["לוסי"],
          },
        ],
        filing: [],
      },
    });
    expect(plan.applications.some((row) => row.employeeId === lucy.id)).toBe(
      true,
    );
    expect(plan.applications.some((row) => row.employeeId === amit.id)).toBe(
      true,
    );
    expect(
      plan.applications.some(
        (row) =>
          row.employeeId === amit.id &&
          row.metadata.lists.some((list) =>
            list.items.some((item) =>
              String(item["שם מטלה"] ?? "").includes("לוסי"),
            ),
          ),
      ),
    ).toBe(false);
    expect(plan.notifications.map((row) => row.employee.id)).not.toContain(
      lucy.id,
    );
  });

  it("plans a WhatsApp send to a raw phone number", () => {
    expect(
      planPhoneRelays(
        [{ targets: ["050-222-2222"], text: "היי מהמטה" }],
        employees,
        amit.id,
      ),
    ).toEqual([{ phone: "0502222222", text: "היי מהמטה", label: "0502222222" }]);
  });

  it("does not double-send when the recipient is both an employee and a contact", () => {
    expect(
      planPhoneRelays(
        [{ targets: ["טל"], text: "שלום" }],
        employees,
        amit.id,
        [{ id: "c1", name: "טל", phone: "0501111111" }],
      ),
    ).toEqual([]);
  });

  it("keeps one shared custom list on the speaker and notifies partners", () => {
    const plan = planTargetedActions({
      actor: amit,
      employees,
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "custom",
            listName: "איסוף ילדים מהחוגים",
            targets: ["עמית", "טל"],
            items: [{ פעילות: "שחייה" }],
          },
        ],
      },
    });
    expect(plan.guestMutationBlocked).toBe(false);
    expect(plan.applications.map((row) => row.employeeId)).toEqual([amit.id]);
    expect(plan.applications[0]?.visibility.scope).toBe("shared");
    expect(plan.applications[0]?.visibility.visibleTo.sort()).toEqual(
      [amit.id, tal.id].sort(),
    );
    expect(plan.notifications.map((row) => row.employee.id)).toEqual([tal.id]);
    expect(plan.notifications[0]?.partnerNames).toContain("טל");
  });

  it("opens an empty shared custom list without inventing a speaker task", () => {
    const plan = planTargetedActions({
      actor: tal,
      employees,
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "custom",
            listName: "המטרות של הפועל פתח תקווה עד 2030",
            targets: ["טל", "עמית"],
            items: [
              {
                שנה: "המטרות של הפועל פתח תקווה עד 2030",
              },
            ],
          },
        ],
      },
    });
    expect(plan.applications.map((row) => row.employeeId)).toEqual([tal.id]);
    expect(
      plan.applications.some((row) =>
        row.metadata.lists.some((list) => list.listType === "tasks"),
      ),
    ).toBe(false);
  });

  it("does not collapse shopping item sharing when speaker is also in targets", () => {
    const plan = planTargetedActions({
      actor: amit,
      employees,
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            targets: ["עמית", "טל"],
            items: [{ "שם פריט": "חלב" }],
          },
        ],
      },
    });
    expect(
      [...new Set(plan.applications.map((row) => row.employeeId))].sort(),
    ).toEqual([amit.id, tal.id].sort());
    expect(
      plan.applications.some(
        (row) =>
          row.employeeId === tal.id &&
          row.metadata.lists[0]?.listType === "shopping",
      ),
    ).toBe(true);
  });

  it("blocks list and filing mutations from guest speakers", () => {
    const guest: PublicEmployee = {
      id: "guest-1",
      kind: "human",
      name: "אורח",
      surname: "",
      nickname: "אורח …1495",
      email: null,
      phone: "0509999999",
      protected: false,
      isOwner: false,
    };
    const plan = planTargetedActions({
      actor: guest,
      employees: [...employees, guest],
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            targets: [],
            items: [{ "שם פריט": "חלב" }],
          },
        ],
      },
    });
    expect(plan.guestMutationBlocked).toBe(true);
    expect(plan.applications).toEqual([]);
    expect(plan.notifications).toEqual([]);
  });
});
