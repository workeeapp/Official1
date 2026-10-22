import { describe, expect, it } from "vitest";
import {
  emptyLlmMetadata,
  type LlmReminderAction,
  type PublicEmployee,
} from "@workee/shared";
import {
  dropSpeakerTaskAddsForOutboundClocks,
  fallbackNotificationText,
  formatMissingSendTextNotice,
  planPhoneRelays,
  planRelayDeliveries,
  planScheduledJobDeliveries,
  planSelfJobDeliveries,
  planTargetedActions,
  resolveActionTargets,
  resolveRelayMessages,
  resolveSpokenMetadata,
  ensureSpeakerShowButtons,
  showButtonsForNotify,
  type ListItemOwnerRef,
} from "../src/services/employee-targets.service.js";

function ownerRef(
  ownerId: string,
  listType: string,
  extra: Partial<ListItemOwnerRef> = {},
): ListItemOwnerRef {
  return {
    ownerId,
    listType,
    listName: "",
    listScope: "personal",
    listVisibleTo: [],
    itemVisibleTo: [ownerId],
    ...extra,
  };
}

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

  it("saves a meeting with Tal once, shared with both, and skips the assignment note", () => {
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

    const meetingApps = plan.applications.filter((item) =>
      item.metadata.lists.some((list) =>
        list.items.some((entry) => entry["שם מטלה"] === "פגישה עם טל"),
      ),
    );
    expect(meetingApps.map((item) => item.employeeId)).toEqual([amit.id]);
    expect(meetingApps[0]?.visibility).toEqual({
      scope: "shared",
      addedById: amit.id,
      visibleTo: [amit.id, tal.id],
    });
    expect(plan.notifications.map((item) => item.employee.id)).toEqual([tal.id]);
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
      listOps: [],
      filing: [],
      directory: [],
      messages: [],
      reminders: [],
      jobs: [],
      handoff: null,
      confirm: null,
      reportSections: [],
      targets: [],
    });
  });

  it("keeps list_ops from the model for the engine", () => {
    const listOps = [
      {
        action: "alter_list" as const,
        listId: "7588a40b-ad10-4490-af80-207c62c1de28",
        newName: "",
        addColumns: [],
        removeColumns: [],
        renameColumns: [],
        addParticipants: ["טל"],
        removeParticipants: [],
      },
    ];
    const resolved = resolveSpokenMetadata(
      "תוסיפי את טל כשותף לרשימת באגים",
      { lists: [], filing: [], listOps },
      employees,
      amit.id,
    );
    expect(resolved.listOps).toEqual(listOps);
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
          composePlace: "",
          reminderId: "",
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
          composePlace: "",
          reminderId: "",
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
          composePlace: "",
          reminderId: "",
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

  it("saves an everyone action once on the speaker, shared with every employee", () => {
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

    expect(plan.applications.map((item) => item.employeeId)).toEqual([amit.id]);
    expect(plan.applications[0]?.visibility.scope).toBe("shared");
    expect(plan.applications[0]?.visibility.visibleTo).toEqual(
      expect.arrayContaining([amit.id, tal.id, shani.id]),
    );
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

  it("builds הצג buttons for partner list notifies", () => {
    expect(
      showButtonsForNotify({
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "custom",
            listName: "בדיקת שם",
            items: [{ שם: "פריט" }],
            targets: [],
          },
        ],
      }),
    ).toEqual([{ label: "הצג", command: "הצג רשימת בדיקת שם" }]);
    expect(
      showButtonsForNotify({
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "remove",
            listType: "shopping",
            listName: "",
            items: [{ item_id: "1", "שם פריט": "חלב" }],
            targets: [],
          },
        ],
      }),
    ).toEqual([{ label: "הצג", command: "הצג רשימת קניות" }]);
    expect(
      showButtonsForNotify({
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "tasks",
            listName: "",
            items: [{ item_id: "2", "שם מטלה": "להתקשר" }],
            targets: [],
          },
        ],
      }),
    ).toEqual([{ label: "הצג", command: "הצג רשימת מטלות" }]);
    expect(
      showButtonsForNotify({
        ...emptyLlmMetadata(),
        reminders: [
          {
            action: "add",
            item: "בדיקה",
            listType: "tasks",
            date: "",
            time: "",
            repeat: "once",
            ping: [],
            targets: [],
            text: "",
            inSeconds: 60,
            everyCount: null,
            everyUnit: null,
            weekdays: null,
            confirmed: false,
            compose: false,
            composeSource: "",
            composeLookbackHours: 0,
          composePlace: "",
            reminderId: "",
          },
        ],
      }),
    ).toEqual([{ label: "הצג", command: "הצג תזכורות" }]);
    expect(showButtonsForNotify(emptyLlmMetadata())).toEqual([]);
  });

  it("ensures speaker הצג תזכורות when reminders mutate and model omitted buttons", () => {
    const reminderAdd: LlmReminderAction = {
      action: "update",
      item: "לקחת אקמול",
      listType: "tasks",
      date: "",
      time: "14:50",
      repeat: "daily",
      ping: [],
      about: [],
      targets: [],
      text: "",
      inSeconds: null,
      everyCount: null,
      everyUnit: null,
      weekdays: null,
      confirmed: false,
      compose: false,
      composeSource: "",
      composeLookbackHours: 0,
          composePlace: "",
      reminderId: "r1",
    };
    expect(
      ensureSpeakerShowButtons({
        ...emptyLlmMetadata(),
        reminders: [reminderAdd],
      }),
    ).toEqual([{ label: "הצג", command: "הצג תזכורות" }]);
    expect(
      ensureSpeakerShowButtons(
        { ...emptyLlmMetadata(), reminders: [reminderAdd] },
        [{ label: "הצג", command: "הצג תזכורות" }],
      ),
    ).toEqual([{ label: "הצג", command: "הצג תזכורות" }]);
    // Model show for a list that did not mutate this turn is dropped — engine
    // show set wins (reminders-only → תזכורות alone).
    expect(
      ensureSpeakerShowButtons(
        { ...emptyLlmMetadata(), reminders: [reminderAdd] },
        [{ label: "הצג", command: "הצג רשימת מטלות" }],
      ),
    ).toEqual([{ label: "הצג", command: "הצג תזכורות" }]);
    expect(ensureSpeakerShowButtons(emptyLlmMetadata())).toEqual([]);
  });

  it("ensures only הצג תזכורות on a WATCH turn (not also מטלות)", () => {
    expect(
      ensureSpeakerShowButtons({
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [{ "שם מטלה": "לעדכן על מזג אוויר בפתח תקווה" }],
            targets: ["לוסי"],
          },
        ],
        reminders: [
          {
            action: "add",
            item: "מזג אוויר",
            listType: "tasks",
            date: "",
            time: "",
            repeat: "1:hours",
            ping: [],
            about: [],
            targets: [],
            text: "עדכון מזג אוויר",
            inSeconds: null,
            everyCount: 1,
            everyUnit: "hours",
            weekdays: null,
            confirmed: false,
            compose: true,
            composeSource: "weather",
            composeLookbackHours: 0,
            composePlace: "פתח תקווה",
            composeCondition: { type: "weather_changed" },
            reminderId: "",
          },
        ],
      }),
    ).toEqual([{ label: "הצג", command: "הצג תזכורות" }]);
  });

  it("custom list move emits only dest הצג (not source + dest)", () => {
    const moveMeta = {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "remove" as const,
          listType: "custom" as const,
          listName: "באגים בקוד",
          items: [
            {
              item_id: "5",
              שם: "לעיתים מוצגים שני כפתורי הצג",
            },
          ],
          targets: [] as string[],
        },
        {
          action: "add" as const,
          listType: "custom" as const,
          listName: "דברים שעלו לשרת",
          items: [{ שם: "לעיתים מוצגים שני כפתורי הצג" }],
          targets: [] as string[],
        },
      ],
    };
    expect(showButtonsForNotify(moveMeta)).toEqual([
      { label: "הצג", command: "הצג רשימת דברים שעלו לשרת" },
    ]);
    expect(ensureSpeakerShowButtons(moveMeta)).toEqual([
      { label: "הצג", command: "הצג רשימת דברים שעלו לשרת" },
    ]);
  });

  it("drops mismatched model הצג on move so typo never makes a 3rd button", () => {
    const moveMeta = {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "remove" as const,
          listType: "custom" as const,
          listName: "באגים בקוד",
          items: [{ item_id: "5", שם: "פריט" }],
          targets: [] as string[],
        },
        {
          action: "add" as const,
          listType: "custom" as const,
          listName: "דברים שעלו לשרת",
          items: [{ שם: "פריט" }],
          targets: [] as string[],
        },
      ],
    };
    expect(
      ensureSpeakerShowButtons(moveMeta, [
        { label: "הצג", command: "הצג רשימת דברים שעלו לשרט" },
        { label: "הצג", command: "הצג רשימת רשימת דברים שעלו לשרת" },
        { label: "כן", command: "כן" },
      ]),
    ).toEqual([
      { label: "הצג", command: "הצג רשימת דברים שעלו לשרת" },
      { label: "כן", command: "כן" },
    ]);
    expect(
      ensureSpeakerShowButtons(moveMeta, [
        { label: "הצג", command: "הצג רשימת דברים שעלו לשרת" },
      ]),
    ).toEqual([{ label: "הצג", command: "הצג רשימת דברים שעלו לשרת" }]);
  });

  it("canonicalizes «רשימת רשימת …» custom list names on show buttons", () => {
    expect(
      showButtonsForNotify({
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "custom",
            listName: "רשימת דברים שעלו לשרת",
            items: [{ שם: "פריט" }],
            targets: [],
          },
        ],
      }),
    ).toEqual([{ label: "הצג", command: "הצג רשימת דברים שעלו לשרת" }]);
  });

  it("shopping remove+add on the same builtin still yields one הצג רשימת קניות", () => {
    expect(
      showButtonsForNotify({
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "remove",
            listType: "shopping",
            listName: "",
            items: [{ item_id: "1", "שם פריט": "חלב" }],
            targets: [],
          },
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "חלב" }],
            targets: [],
          },
        ],
      }),
    ).toEqual([{ label: "הצג", command: "הצג רשימת קניות" }]);
  });

  it("ensures speaker הצג רשימת … when lists mutate and model omitted buttons", () => {
    expect(
      ensureSpeakerShowButtons({
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "remove",
            listType: "tasks",
            listName: "",
            items: [{ item_id: "6", "שם מטלה": "לשטוף את הרכב" }],
            targets: [],
          },
        ],
      }),
    ).toEqual([{ label: "הצג", command: "הצג רשימת מטלות" }]);
    expect(
      ensureSpeakerShowButtons({
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "shopping",
            listName: "",
            items: [{ item_id: "1", "שם פריט": "חלב", כמות: "2" }],
            targets: [],
          },
        ],
      }),
    ).toEqual([{ label: "הצג", command: "הצג רשימת קניות" }]);
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "remove",
              listType: "tasks",
              listName: "",
              items: [{ item_id: "6", "שם מטלה": "לשטוף את הרכב" }],
              targets: [],
            },
          ],
        },
        [{ label: "הצג", command: "הצג רשימת מטלות" }],
      ),
    ).toEqual([{ label: "הצג", command: "הצג רשימת מטלות" }]);
    expect(
      ensureSpeakerShowButtons({
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "custom",
            listName: "בדיקת שם",
            items: [{ שם: "פריט" }],
            targets: [],
          },
        ],
        filing: [
          {
            action: "add_filing",
            itemName: "עובדה",
            itemInfo: "",
            itemDescription: "עובדה",
            targets: [],
            filingId: "",
          },
        ],
      }),
    ).toEqual([
      { label: "הצג", command: "הצג רשימת בדיקת שם" },
      { label: "הצג", command: "הצג תיוקים" },
    ]);
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
          composePlace: "",
          reminderId: "",
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
          composePlace: "",
          reminderId: "",
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

  it("lists every action for one recipient and keeps each clock on its own line", () => {
    const eran: PublicEmployee = {
      id: "eran-1",
      name: "ערן",
      surname: "",
      nickname: "ערן",
      email: null,
      phone: null,
    };
    const clock = (item: string, ping: string, inSeconds: number): LlmReminderAction => ({
      action: "add",
      item,
      listType: "tasks",
      date: "",
      time: "",
      repeat: "once",
      ping: [ping],
      about: [],
      targets: [ping],
      text: "",
      inSeconds,
      everyCount: null,
      everyUnit: null,
      weekdays: null,
      confirmed: false,
      compose: false,
      composeSource: "",
      composeLookbackHours: 0,
          composePlace: "",
      reminderId: "",
    });
    const plan = planTargetedActions({
      actor: amit,
      employees: [amit, eran],
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [{ "שם מטלה": "לקנות תפוחים" }],
            targets: ["ערן", "עמית"],
          },
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [{ "שם מטלה": "לבדוק שזה עובד" }],
            targets: ["ערן"],
          },
        ],
        reminders: [
          clock("ערן צריך לקנות תפוחים", "עמית", 7200),
          clock("לבדוק שזה עובד", "ערן", 10800),
        ],
      },
    });
    const notify = plan.notifications.find((row) => row.employee.id === eran.id);
    expect(
      fallbackNotificationText(amit, notify!.metadata, { recipientIsOwner: true }),
    ).toBe(
      "עדכונים מעמית:\n• הוסיף לך מטלה: לקנות תפוחים\n• הוסיף לך מטלה: לבדוק שזה עובד\n• תזכורת אליך בעוד 3 שעות: לבדוק שזה עובד",
    );
  });

  it("does not drop a clock that cannot hang on a single task", () => {
    const reminder: LlmReminderAction = {
      action: "add",
      item: "לקנות תפוחים",
      listType: "shopping",
      date: "",
      time: "",
      repeat: "once",
      ping: ["טל"],
      about: [],
      targets: ["טל"],
      text: "",
      inSeconds: 3600,
      everyCount: null,
      everyUnit: null,
      weekdays: null,
      confirmed: false,
      compose: false,
      composeSource: "",
      composeLookbackHours: 0,
          composePlace: "",
      reminderId: "",
    };
    expect(
      fallbackNotificationText(amit, {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "תפוחים" }],
            targets: [],
          },
        ],
        reminders: [reminder],
      }),
    ).toBe(
      "עדכונים מעמית:\n• הוסיף תפוחים לרשימת הקניות שלך\n• תזכורת אליך בעוד שעה: לקנות תפוחים",
    );
    expect(
      fallbackNotificationText(amit, { ...emptyLlmMetadata(), reminders: [reminder] }),
    ).toBe("עמית קבע לך תזכורת בעוד שעה: לקנות תפוחים");
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
        { partnerNames: [] },
      ),
    ).toBe("טל הוסיף רשימה משותפת איתך: «באגים לתיקון»");
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
    expect(plan.notifications[0]!.partnerNames).toEqual([]);
    expect(plan.notifications[0]!.partnerNames).not.toContain("עמית");
    expect(
      fallbackNotificationText(tal, plan.notifications[0]!.metadata, {
        partnerNames: plan.notifications[0]!.partnerNames,
      }),
    ).toBe("טל הוסיף רשימה משותפת איתך: «באגים לתיקון»");
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

  it("carries expects_reply and the asker's question to the delivery", () => {
    const lucy: PublicEmployee = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "digital",
      name: "לוסי",
      surname: "",
      nickname: "לוסי",
      email: null,
      phone: null,
    };
    expect(
      planRelayDeliveries({
        actor: amit,
        sender: lucy,
        employees: [...employees, lucy],
        messages: [
          {
            targets: ["טל"],
            text: "עמית שואל אם קנית חלב?",
            expectsReply: true,
            askSummary: "אם קנית חלב?",
          },
        ],
      }),
    ).toEqual([
      {
        employeeId: tal.id,
        digitalEmployeeId: lucy.id,
        target: tal,
        text: "עמית שואל אם קנית חלב?",
        expectsReply: true,
        askSummary: "אם קנית חלב?",
      },
    ]);
  });

  it("plans self-job deliveries for speaker-targeted expects_reply checks", () => {
    expect(
      planSelfJobDeliveries({
        actor: amit,
        employees,
        messages: [
          {
            targets: ["עמית"],
            text: "קנית שוקו?",
            expectsReply: true,
            askSummary: "אם קנית שוקו?",
            urgency: "normal",
          },
          {
            targets: ["עמית"],
            text: "בוקר טוב",
            expectsReply: false,
            askSummary: "",
          },
          {
            targets: ["טל"],
            text: "עמית שואל אם קנית שמן?",
            expectsReply: true,
            askSummary: "אם קנית שמן?",
          },
        ],
      }),
    ).toEqual([
      {
        subjectId: amit.id,
        subjectName: "עמית",
        text: "קנית שוקו?",
        ask: "אם קנית שוקו?",
        urgency: "normal",
      },
    ]);
  });

  it("skips deferred checks from immediate relay and self-job planners", () => {
    const lucy: PublicEmployee = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "digital",
      name: "לוסי",
      surname: "",
      nickname: "לוסי",
      email: null,
      phone: null,
    };
    const deferredSelf = {
      targets: ["עמית"],
      text: "קנית חלב?",
      expectsReply: true as const,
      askSummary: "אם קניתי חלב?",
      inSeconds: 7200,
    };
    const deferredOther = {
      targets: ["טל"],
      text: "עמית שואל אם אתה מקליט?",
      expectsReply: true as const,
      askSummary: "אם מקליט?",
      date: "2026-10-09",
      time: "20:00",
    };
    expect(
      planSelfJobDeliveries({
        actor: amit,
        employees,
        messages: [deferredSelf],
      }),
    ).toEqual([]);
    expect(
      planRelayDeliveries({
        actor: amit,
        sender: lucy,
        employees: [...employees, lucy],
        messages: [deferredOther],
      }),
    ).toEqual([]);
    expect(
      planScheduledJobDeliveries({
        actor: amit,
        sender: lucy,
        employees: [...employees, lucy],
        messages: [deferredSelf, deferredOther],
      }),
    ).toEqual([
      {
        subjectId: amit.id,
        subjectName: "עמית",
        text: "קנית חלב?",
        ask: "אם קניתי חלב?",
        inSeconds: 7200,
      },
      {
        subjectId: tal.id,
        subjectName: "טל",
        text: "עמית שואל אם אתה מקליט?",
        ask: "אם מקליט?",
        date: "2026-10-09",
        time: "20:00",
      },
    ]);
  });

  it("builds a delete notification when someone removes a shared shopping item", () => {
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
    ).toBe("טל מחק «קופסת טונה» מרשימת «קניות»");
  });

  it("never echoes a raw item_id in a custom-list remove notification", () => {
    const itemId = "f233b21a-a56f-499d-b157-108db593f590";
    const removal = (item: Record<string, unknown>) =>
      fallbackNotificationText(
        amit,
        {
          lists: [
            {
              action: "remove",
              listType: "custom",
              listName: "באגים",
              items: [item],
              targets: [],
            },
          ],
          filing: [],
        },
        { partnerNames: ["ערן"] },
      );
    expect(removal({ item_id: itemId })).not.toContain(itemId);
    expect(removal({ item_id: itemId, name: "באג חדש לבדיקה" })).toBe(
      "עמית מחק «באג חדש לבדיקה» מרשימת «באגים»",
    );
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
    const lucyApply = plan.applications.find((row) => row.employeeId === lucy.id);
    expect(lucyApply?.visibility.scope).toBe("personal");
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
    expect(plan.notifications[0]?.partnerNames).not.toContain("טל");
    expect(plan.notifications[0]?.partnerNames).toEqual([]);
  });

  it("notifies a shared filing partner with איתך, never לך ו<recipient>", () => {
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
      employees: [...employees, michal],
      metadata: {
        ...emptyLlmMetadata(),
        filing: [
          {
            action: "add_filing",
            itemName: "קוד שער",
            itemInfo: "1234",
            targets: ["טל", "מיכל"],
          },
        ],
      },
    });
    expect(plan.notifications).toHaveLength(1);
    expect(plan.notifications[0]?.employee.id).toBe(michal.id);
    expect(plan.notifications[0]?.partnerNames).toEqual([]);
    expect(plan.notifications[0]?.partnerNames).not.toContain("מיכל");
    expect(
      fallbackNotificationText(tal, plan.notifications[0]!.metadata, {
        partnerNames: plan.notifications[0]!.partnerNames,
      }),
    ).toBe("טל הוסיף תיוק משותף איתך: «קוד שער»");
  });

  it("names other co-partners on a three-way shared filing notify", () => {
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
      employees: [...employees, michal],
      metadata: {
        ...emptyLlmMetadata(),
        filing: [
          {
            action: "add_filing",
            itemName: "קוד שער",
            itemInfo: "1234",
            targets: ["טל", "מיכל", "שני"],
          },
        ],
      },
    });
    const toMichal = plan.notifications.find((row) => row.employee.id === michal.id);
    expect(toMichal?.partnerNames).toEqual(["שני"]);
    expect(
      fallbackNotificationText(tal, toMichal!.metadata, {
        partnerNames: toMichal!.partnerNames,
      }),
    ).toBe("טל הוסיף תיוק משותף לך ולשני: «קוד שער»");
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

  it("saves shopping shared by speaker + partner as one row on the speaker", () => {
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
    expect(plan.applications).toHaveLength(1);
    expect(plan.applications[0]).toMatchObject({
      employeeId: amit.id,
      visibility: { scope: "shared", visibleTo: [amit.id, tal.id] },
    });
    expect(plan.applications[0]?.metadata.lists[0]?.listType).toBe("shopping");
    expect(plan.notifications.map((row) => row.employee.id)).toEqual([tal.id]);
  });

  it("still saves work assigned only to Tal on Tal's list", () => {
    const plan = planTargetedActions({
      actor: amit,
      employees,
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            targets: ["טל"],
            items: [{ "שם מטלה": "לבדוק שמן" }],
          },
        ],
      },
    });
    expect(plan.applications.map((row) => row.employeeId)).toEqual([tal.id]);
    expect(plan.applications[0]?.visibility.visibleTo).toEqual([amit.id, tal.id]);
  });

  it("shares an existing item on its owner's list (update by item_id)", () => {
    const coffeeId = "99ea236b-9203-4a4f-be3f-69882dacf8ac";
    const plan = planTargetedActions({
      actor: amit,
      employees,
      itemOwners: new Map([[coffeeId, ownerRef(amit.id, "shopping")]]),
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "shopping",
            listName: "",
            targets: ["טל"],
            items: [{ item_id: coffeeId }],
          },
        ],
      },
    });
    expect(plan.applications).toHaveLength(1);
    expect(plan.applications[0]).toMatchObject({
      employeeId: amit.id,
      visibility: { scope: "shared", visibleTo: [amit.id, tal.id] },
    });
    expect(plan.applications[0]?.metadata.lists[0]?.items).toEqual([
      { item_id: coffeeId },
    ]);
  });

  it("shares one item of a personal custom list by item_id (not the whole list)", () => {
    const aviId = "77201840-1bfb-45a3-9a26-d6d524e13953";
    const plan = planTargetedActions({
      actor: amit,
      employees,
      sharedLists: [
        {
          ownerId: amit.id,
          listName: "קישקושים פרטיים",
          visibleTo: [],
          scope: "personal",
        },
      ],
      itemOwners: new Map([
        [aviId, ownerRef(amit.id, "custom", { listName: "קישקושים פרטיים" })],
      ]),
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "custom",
            listName: "קישקושים פרטיים",
            targets: ["עמית", "טל"],
            items: [{ item_id: aviId }],
          },
        ],
      },
    });
    expect(plan.applications).toHaveLength(1);
    expect(plan.applications[0]).toMatchObject({
      employeeId: amit.id,
      visibility: { scope: "shared", visibleTo: [amit.id, tal.id], itemOnly: true },
    });
    expect(plan.applications[0]?.metadata.lists[0]).toMatchObject({
      listType: "custom",
      listName: "קישקושים פרטיים",
      items: [{ item_id: aviId }],
    });
  });

  describe("partner of one shared custom-list item", () => {
    const aviId = "77201840-1bfb-45a3-9a26-d6d524e13953";
    const aviOwner = () =>
      new Map([
        [
          aviId,
          ownerRef(amit.id, "custom", {
            listName: "קישקושים פרטיים",
            itemVisibleTo: [amit.id, tal.id],
          }),
        ],
      ]);

    it("routes the partner's edit to the owner's row (no list of their own)", () => {
      const plan = planTargetedActions({
        actor: tal,
        employees,
        sharedLists: [],
        itemOwners: aviOwner(),
        metadata: {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "update",
              listType: "custom",
              listName: "קישקושים פרטיים",
              targets: ["טל", "עמית"],
              items: [{ item_id: aviId, תיאור: "שחקן" }],
            },
          ],
        },
      });
      expect(plan.applications).toHaveLength(1);
      expect(plan.applications[0]).toMatchObject({
        employeeId: amit.id,
        visibility: { scope: "personal", visibleTo: [amit.id], itemOnly: true },
      });
      expect(plan.applications[0]?.metadata.lists[0]).toMatchObject({
        listName: "קישקושים פרטיים",
        items: [{ item_id: aviId, תיאור: "שחקן" }],
      });
    });

    it("routes the partner's remove to the owner's row", () => {
      const plan = planTargetedActions({
        actor: tal,
        employees,
        sharedLists: [],
        itemOwners: aviOwner(),
        metadata: {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "remove",
              listType: "custom",
              listName: "קישקושים פרטיים",
              targets: [],
              items: [{ item_id: aviId }],
            },
          ],
        },
      });
      expect(plan.applications).toHaveLength(1);
      expect(plan.applications[0]).toMatchObject({
        employeeId: amit.id,
        visibility: { itemOnly: true },
      });
      expect(plan.applications[0]?.metadata.lists[0]?.action).toBe("remove");
    });

    it("keeps a shared-list partner's edit on the list path", () => {
      const bugId = "88201840-1bfb-45a3-9a26-d6d524e13953";
      const plan = planTargetedActions({
        actor: amit,
        employees,
        sharedLists: [
          {
            ownerId: tal.id,
            listName: "בעיות",
            visibleTo: [tal.id, amit.id],
            scope: "shared",
          },
        ],
        itemOwners: new Map([
          [
            bugId,
            ownerRef(tal.id, "custom", {
              listName: "בעיות",
              listScope: "shared",
              listVisibleTo: [tal.id, amit.id],
              itemVisibleTo: [tal.id, amit.id],
            }),
          ],
        ]),
        metadata: {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "update",
              listType: "custom",
              listName: "בעיות",
              targets: [],
              items: [{ item_id: bugId, סטטוס: "טופל" }],
            },
          ],
        },
      });
      expect(plan.applications).toHaveLength(1);
      expect(plan.applications[0]?.visibility.itemOnly).toBeUndefined();
      expect(plan.applications[0]?.visibility.scope).toBe("shared");
    });
  });

  it("unshares one custom-list item by item_id", () => {
    const aviId = "77201840-1bfb-45a3-9a26-d6d524e13953";
    const plan = planTargetedActions({
      actor: amit,
      employees,
      sharedLists: [
        {
          ownerId: amit.id,
          listName: "קישקושים פרטיים",
          visibleTo: [],
          scope: "personal",
        },
      ],
      itemOwners: new Map([
        [
          aviId,
          ownerRef(amit.id, "custom", {
            listName: "קישקושים פרטיים",
            itemVisibleTo: [amit.id, tal.id],
          }),
        ],
      ]),
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "custom",
            listName: "קישקושים פרטיים",
            targets: ["עמית"],
            items: [{ item_id: aviId, unshare_with: ["טל"] }],
          },
        ],
      },
    });
    expect(plan.applications).toHaveLength(1);
    expect(plan.applications[0]).toMatchObject({
      employeeId: amit.id,
      visibility: { scope: "personal", removeIds: [tal.id] },
    });
    expect(plan.applications[0]?.metadata.lists[0]?.items).toEqual([
      { item_id: aviId },
    ]);
  });

  it("keeps a field edit on a shared custom list on the list audience", () => {
    const bugId = "88201840-1bfb-45a3-9a26-d6d524e13953";
    const plan = planTargetedActions({
      actor: amit,
      employees,
      sharedLists: [
        {
          ownerId: tal.id,
          listName: "בעיות",
          visibleTo: [tal.id, amit.id],
          scope: "shared",
        },
      ],
      itemOwners: new Map([
        [
          bugId,
          ownerRef(tal.id, "custom", {
            listName: "בעיות",
            listScope: "shared",
            listVisibleTo: [tal.id, amit.id],
            itemVisibleTo: [tal.id, amit.id],
          }),
        ],
      ]),
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "custom",
            listName: "בעיות",
            targets: ["עמית", "טל"],
            items: [{ item_id: bugId, סטטוס: "טופל" }],
          },
        ],
      },
    });
    expect(plan.applications).toHaveLength(1);
    expect(plan.applications[0]).toMatchObject({
      employeeId: tal.id,
      visibility: { scope: "shared", visibleTo: [tal.id, amit.id] },
    });
    expect(plan.notifications.map((row) => row.employee.id)).toEqual([tal.id]);
  });

  it("tells a newly added partner the item was shared, not updated", () => {
    const metadata = {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "update" as const,
          listType: "shopping" as const,
          listName: "",
          targets: [],
          items: [{ item_id: "x", "שם פריט": "קפה" }],
        },
      ],
    };
    expect(
      fallbackNotificationText(amit, metadata, {
        shared: true,
        recipientIsOwner: false,
        recipientIsPartner: true,
        ownerName: "עמית",
      }),
    ).toBe("עמית שיתף איתך קפה ברשימת הקניות");
    expect(
      fallbackNotificationText(
        amit,
        {
          ...metadata,
          lists: [{ ...metadata.lists[0]!, listType: "tasks", items: [{ "שם מטלה": "לבדוק שמן" }] }],
        },
        { shared: true, recipientIsOwner: false, recipientIsPartner: true },
      ),
    ).toBe("עמית שיתף איתך מטלה: לבדוק שמן");
  });

  it("does not call a shared item «של <owner>» when updating it for a partner", () => {
    const metadata = {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "update" as const,
          listType: "shopping" as const,
          listName: "",
          targets: [],
          items: [{ "שם פריט": "קפה", כמות: 2 }],
        },
      ],
    };
    expect(
      fallbackNotificationText(amit, metadata, {
        recipientIsOwner: false,
        recipientIsPartner: true,
        ownerName: "עמית",
      }),
    ).toBe("עמית עדכן קפה ברשימת הקניות");
    expect(
      fallbackNotificationText(tal, metadata, {
        recipientIsOwner: false,
        ownerName: "טל",
      }),
    ).toBe("טל עדכן קפה ברשימת הקניות של טל");
  });

  it("turns unshare_with into removeIds and never saves it as row data", () => {
    const coffeeId = "99ea236b-9203-4a4f-be3f-69882dacf8ac";
    const plan = planTargetedActions({
      actor: amit,
      employees,
      itemOwners: new Map([[coffeeId, ownerRef(amit.id, "shopping")]]),
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "shopping",
            listName: "",
            targets: ["עמית"],
            items: [{ item_id: coffeeId, unshare_with: ["טל"] }],
          },
        ],
      },
    });
    expect(plan.applications).toHaveLength(1);
    expect(plan.applications[0]).toMatchObject({
      employeeId: amit.id,
      visibility: { scope: "personal", removeIds: [tal.id] },
    });
    expect(plan.applications[0]?.metadata.lists[0]?.items).toEqual([
      { item_id: coffeeId },
    ]);
  });

  it("tells a removed partner the item is no longer shared with them", () => {
    expect(
      fallbackNotificationText(
        amit,
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "update",
              listType: "shopping",
              listName: "",
              targets: [],
              items: [{ "שם פריט": "קפה" }],
            },
          ],
        },
        { unshared: true, recipientIsOwner: false },
      ),
    ).toBe("עמית הפסיק לשתף איתך קפה מרשימת הקניות");
  });

  it("routes a partner's remove of a shared item to the owner's list", () => {
    const coffeeId = "99ea236b-9203-4a4f-be3f-69882dacf8ac";
    const plan = planTargetedActions({
      actor: tal,
      employees,
      itemOwners: new Map([[coffeeId, ownerRef(amit.id, "shopping")]]),
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "remove",
            listType: "tasks",
            listName: "",
            targets: [],
            items: [{ item_id: coffeeId }],
          },
        ],
      },
    });
    expect(plan.applications).toHaveLength(1);
    expect(plan.applications[0]).toMatchObject({
      employeeId: amit.id,
      visibility: { scope: "personal" },
    });
    expect(plan.applications[0]?.metadata.lists[0]?.listType).toBe("shopping");
  });

  it("forces filing co-share on the speaker when targets omit the speaker", () => {
    const plan = planTargetedActions({
      actor: tal,
      employees,
      metadata: {
        ...emptyLlmMetadata(),
        filing: [
          {
            action: "add_filing",
            itemName: "קוד שער",
            itemInfo: "1234",
            targets: ["עמית"],
          },
        ],
      },
    });
    expect(plan.applications).toHaveLength(1);
    expect(plan.applications[0]?.employeeId).toBe(tal.id);
    expect(plan.applications[0]?.visibility).toMatchObject({
      scope: "shared",
      visibleTo: expect.arrayContaining([tal.id, amit.id]),
    });
    expect(plan.notifications.map((row) => row.employee.id)).toEqual([amit.id]);
  });

  it("forces contacts co-share on the speaker (share-only, no assign fan-out)", () => {
    const plan = planTargetedActions({
      actor: tal,
      employees,
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "contacts",
            listName: "",
            targets: ["עמית"],
            items: [{ "שם פרטי": "דני", "טלפון": "0501111111" }],
          },
        ],
      },
    });
    expect(plan.applications).toHaveLength(1);
    expect(plan.applications[0]?.employeeId).toBe(tal.id);
    expect(plan.applications[0]?.visibility?.scope).toBe("shared");
    expect(plan.notifications.map((row) => row.employee.id)).toEqual([amit.id]);
  });

  it("keeps shopping assign when targets are the other person only", () => {
    const plan = planTargetedActions({
      actor: tal,
      employees,
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            targets: ["עמית"],
            items: [{ "שם פריט": "חלב" }],
          },
        ],
      },
    });
    expect(plan.applications).toHaveLength(1);
    expect(plan.applications[0]?.employeeId).toBe(amit.id);
  });

  it("adds הצג תיוקים on filing partner notify buttons", () => {
    const buttons = showButtonsForNotify({
      ...emptyLlmMetadata(),
      filing: [
        {
          action: "add_filing",
          itemName: "קוד",
          itemInfo: "",
          targets: ["טל", "עמית"],
        },
      ],
    });
    expect(buttons.some((row) => row.command === "הצג תיוקים")).toBe(true);
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
