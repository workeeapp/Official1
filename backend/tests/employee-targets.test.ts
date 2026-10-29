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
  formatScheduleSkippedWithoutQueueNotice,
  planPhoneRelays,
  planRelayDeliveries,
  planScheduledJobDeliveries,
  planSelfJobDeliveries,
  planTargetedActions,
  resolveActionTargets,
  resolveRelayMessages,
  resolveSpokenMetadata,
  buildCollabByListKey,
  ensureSpeakerShowButtons,
  isEngineOwnedListNavButton,
  normalizeShowNavCommand,
  parseItemOpenButton,
  shouldKeepItemOpenButton,
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
    expect(
      showButtonsForNotify({
        ...emptyLlmMetadata(),
        directory: [
          {
            action: "add",
            name: "נועה",
            phone: "0521111111",
            contactId: "",
            targets: ["עמית"],
          },
        ],
      }),
    ).toEqual([{ label: "הצג", command: "הצג רשימת אנשי קשר" }]);
    expect(showButtonsForNotify(emptyLlmMetadata())).toEqual([]);
  });

  it("speaker show buttons keep model taps; reminder-only still injects nothing", () => {
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
    ).toEqual([]);
    expect(
      ensureSpeakerShowButtons(
        { ...emptyLlmMetadata(), reminders: [reminderAdd] },
        [{ label: "הצג", command: "הצג תזכורות" }],
      ),
    ).toEqual([{ label: "הצג", command: "הצג תזכורות" }]);
    // Model commands are kept as-is (no allowlist replace / inject).
    expect(
      ensureSpeakerShowButtons(
        { ...emptyLlmMetadata(), reminders: [reminderAdd] },
        [{ label: "מה יש לי מחר", command: "מה יש לי מחר" }],
      ),
    ).toEqual([{ label: "מה יש לי מחר", command: "מה יש לי מחר" }]);
    expect(ensureSpeakerShowButtons(emptyLlmMetadata())).toEqual([]);
  });

  it("WATCH tasks add gets worker inventory nav (not speaker הצג מטלות)", () => {
    expect(
      ensureSpeakerShowButtons(
        {
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
        },
        [],
        { speakerNames: ["טל"], workerNames: ["לוסי"] },
      ),
    ).toEqual([{ label: "המטלות שלך", command: "הצג מטלות של לוסי" }]);
  });

  it("WATCH: model speaker LIST is rewritten to worker inventory", () => {
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "add",
              listType: "tasks",
              listName: "",
              items: [{ "שם מטלה": "לבדוק גשם בפתח תקווה" }],
              targets: ["לוסי"],
            },
          ],
        },
        [{ label: "הצג מטלות", command: "הצג רשימת מטלות" }],
        { speakerNames: ["טל"], workerNames: ["לוסי"] },
      ),
    ).toEqual([{ label: "המטלות שלך", command: "הצג מטלות של לוסי" }]);
  });

  it("WATCH cadence update with appliedWorkerWatchName gets worker inventory nav", () => {
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          reminders: [
            {
              action: "update",
              item: "משוב יואב",
              listType: "tasks",
              date: "",
              time: "",
              repeat: "1:hours",
              ping: [],
              about: [],
              targets: [],
              text: "",
              inSeconds: null,
              everyCount: 1,
              everyUnit: "hours",
              weekdays: null,
              confirmed: false,
              compose: true,
              composeSource: "mashov",
              composeLookbackHours: 0,
              composePlace: "יואב",
              composeCondition: { type: "mashov_new" },
              reminderId: "r1",
            },
          ],
        },
        [],
        {
          speakerNames: ["טל"],
          workerNames: ["לוסי"],
          appliedWorkerWatchName: "לוסי",
        },
      ),
    ).toEqual([{ label: "המטלות שלך", command: "הצג מטלות של לוסי" }]);
  });

  it("WATCH cadence update without appliedWorkerWatchName injects nothing", () => {
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          reminders: [
            {
              action: "update",
              item: "משוב יואב",
              listType: "tasks",
              date: "",
              time: "",
              repeat: "1:hours",
              ping: [],
              about: [],
              targets: [],
              text: "",
              inSeconds: null,
              everyCount: 1,
              everyUnit: "hours",
              weekdays: null,
              confirmed: false,
              compose: true,
              composeSource: "mashov",
              composeLookbackHours: 0,
              composePlace: "יואב",
              composeCondition: { type: "mashov_new" },
              reminderId: "r1",
            },
          ],
        },
        [],
        { speakerNames: ["טל"], workerNames: ["לוסי"] },
      ),
    ).toEqual([]);
  });

  it("ordinary reminder update without apply proof injects nothing", () => {
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          reminders: [
            {
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
            },
          ],
        },
        [],
        { speakerNames: ["טל"], workerNames: ["לוסי"] },
      ),
    ).toEqual([]);
  });

  it("WATCH create + appliedWorkerWatchName dedupes to one worker inventory button", () => {
    expect(
      ensureSpeakerShowButtons(
        {
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
        },
        [],
        {
          speakerNames: ["טל"],
          workerNames: ["לוסי"],
          appliedWorkerWatchName: "לוסי",
        },
      ),
    ).toEqual([{ label: "המטלות שלך", command: "הצג מטלות של לוסי" }]);
  });

  it("chat appliedWorkerWatchName predicate follows saved.hasComposeCondition", () => {
    // Mirrors chat.service: only pass the worker name when apply proved a watch clock.
    const resolveName = (
      saved: Array<{ hasComposeCondition?: boolean }>,
    ): string | undefined =>
      saved.some((row) => row.hasComposeCondition === true)
        ? "לוסי"
        : undefined;
    expect(
      resolveName([{ hasComposeCondition: true }, {}]),
    ).toBe("לוסי");
    expect(resolveName([{}])).toBeUndefined();
    expect(resolveName([])).toBeUndefined();
  });

  it("speaker-book tasks + appliedWorkerWatchName still yields speaker הצג מטלות only", () => {
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "add",
              listType: "tasks",
              listName: "",
              items: [{ "שם מטלה": "לשתות מים" }],
              targets: [],
            },
          ],
        },
        [],
        {
          speakerNames: ["טל"],
          workerNames: ["לוסי"],
          appliedWorkerWatchName: "לוסי",
        },
      ),
    ).toEqual([{ label: "הצג מטלות", command: "הצג רשימת מטלות" }]);
  });

  it("speaker tasks + worker להזכיר still gets speaker הצג מטלות (not worker-only rewrite)", () => {
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "add",
              listType: "tasks",
              listName: "",
              items: [{ "שם מטלה": "לשתות מים" }],
              targets: [],
            },
            {
              action: "add",
              listType: "tasks",
              listName: "",
              items: [{ "שם מטלה": "להזכיר לטל לשתות מים" }],
              targets: ["לוסי"],
            },
          ],
        },
        [],
        { speakerNames: ["טל"], workerNames: ["לוסי"] },
      ),
    ).toEqual([{ label: "הצג מטלות", command: "הצג רשימת מטלות" }]);
  });

  it("custom list move emits only dest הצג for partner notify (not source + dest)", () => {
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
    // Speaker LIST BUTTON: dest list only (same move skip as notify).
    expect(ensureSpeakerShowButtons(moveMeta)).toEqual([
      { label: "הצג רשימה", command: "הצג רשימת דברים שעלו לשרת" },
    ]);
  });

  it("keeps conversational taps; keeps validated model dest LIST on move (no double inject)", () => {
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
    // Model dest LIST kept; כן kept; no second inject for same list.
    expect(
      ensureSpeakerShowButtons(moveMeta, [
        { label: "מה ברשימה", command: "הצג רשימת דברים שעלו לשרת" },
        { label: "כן", command: "כן" },
      ]),
    ).toEqual([
      { label: "מה ברשימה", command: "הצג רשימת דברים שעלו לשרת" },
      { label: "כן", command: "כן" },
    ]);
    // Three content-aware + כן fills the max — no room for safety-net LIST.
    expect(
      ensureSpeakerShowButtons(moveMeta, [
        { label: "למי להתקשר", command: "למי אני צריך להתקשר" },
        { label: "מה טל לקנות", command: "מה טל צריך לקנות" },
        { label: "מה ביום שלישי", command: "מה יש לטל ביום שלישי" },
        { label: "כן", command: "כן" },
      ]),
    ).toEqual([
      { label: "למי להתקשר", command: "למי אני צריך להתקשר" },
      { label: "מה טל לקנות", command: "מה טל צריך לקנות" },
      { label: "מה ביום שלישי", command: "מה יש לטל ביום שלישי" },
    ]);
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

  it("collab nav: model-emitted shapes kept only with apply evidence; else plain LIST", () => {
    const nameById = new Map([
      ["tal", "טל"],
      ["michal", "מיכל"],
      ["amit", "עמית"],
    ]);
    const bulkMap = buildCollabByListKey(
      [
        {
          listType: "shopping",
          collabApply: { mode: "co_share", partnerIds: ["michal"] },
        },
        {
          listType: "shopping",
          collabApply: { mode: "co_share", partnerIds: ["michal"] },
        },
      ],
      nameById,
    );
    const bulkShare = ensureSpeakerShowButtons(
      {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "shopping",
            listName: "",
            items: [
              { item_id: "a", "שם פריט": "חלב" },
              { item_id: "b", "שם פריט": "לחם" },
            ],
            targets: ["טל", "מיכל"],
          },
        ],
      },
      [
        {
          label: "משותף עם מיכל",
          command: "הצג קניות משותפות עם מיכל",
        },
        { label: "כל הקניות", command: "כל הקניות" },
      ],
      {
        speakerNames: ["טל"],
        appliedNav: {
          listKeys: new Set(["shopping"]),
          filing: false,
          collabByListKey: bulkMap,
        },
      },
    );
    expect(bulkShare.map((b) => b.command)).toEqual([
      "הצג קניות משותפות עם מיכל",
      "כל הקניות",
    ]);
    expect(bulkShare[0]?.label).toBe("משותף עם מיכל");

    const singleMap = buildCollabByListKey(
      [
        {
          listType: "shopping",
          collabApply: { mode: "co_share", partnerIds: ["michal"] },
        },
      ],
      nameById,
    );
    const singleShare = ensureSpeakerShowButtons(
      {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "חלב" }],
            targets: ["טל", "מיכל"],
          },
        ],
      },
      [
        {
          label: "משותף עם מיכל",
          command: "הצג קניות משותפות עם מיכל",
        },
      ],
      {
        speakerNames: ["טל"],
        appliedNav: {
          listKeys: new Set(["shopping"]),
          filing: false,
          collabByListKey: singleMap,
        },
      },
    );
    expect(singleShare.map((b) => b.command)).toEqual([
      "הצג קניות משותפות עם מיכל",
    ]);

    const assignMap = buildCollabByListKey(
      [
        {
          listType: "tasks",
          collabApply: { mode: "assign", partnerIds: ["michal"] },
        },
      ],
      nameById,
    );
    const assign = ensureSpeakerShowButtons(
      {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [{ "שם מטלה": "לקנות חלב" }],
            targets: ["מיכל"],
          },
        ],
      },
      [
        {
          label: "באחריות מיכל",
          command: "הצג מטלות באחריות מיכל",
        },
      ],
      {
        speakerNames: ["טל"],
        appliedNav: {
          listKeys: new Set(["tasks"]),
          filing: false,
          collabByListKey: assignMap,
        },
      },
    );
    expect(assign.map((b) => b.command)).toEqual([
      "הצג מטלות באחריות מיכל",
    ]);
    expect(assign[0]?.label).toBe("באחריות מיכל");

    const multiMap = buildCollabByListKey(
      [
        {
          listType: "shopping",
          collabApply: {
            mode: "co_share",
            partnerIds: ["michal", "amit"],
          },
        },
      ],
      nameById,
    );
    const multi = ensureSpeakerShowButtons(
      {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "shopping",
            listName: "",
            items: [
              { item_id: "a", "שם פריט": "חלב" },
              { item_id: "b", "שם פריט": "לחם" },
            ],
            targets: ["טל", "מיכל", "עמית"],
          },
        ],
      },
      [{ label: "כל הקניות", command: "כל הקניות" }],
      {
        speakerNames: ["טל"],
        appliedNav: {
          listKeys: new Set(["shopping"]),
          filing: false,
          collabByListKey: multiMap,
        },
      },
    );
    expect(multi.map((b) => b.command)).toEqual(["כל הקניות"]);

    // Safety net without model buttons → plain LIST only (never invents collab).
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "add",
              listType: "shopping",
              listName: "",
              items: [{ "שם פריט": "חלב" }],
              targets: ["טל", "מיכל"],
            },
          ],
        },
        [],
        {
          speakerNames: ["טל"],
          appliedNav: {
            listKeys: new Set(["shopping"]),
            filing: false,
            collabByListKey: singleMap,
          },
        },
      ).map((b) => b.command),
    ).toEqual(["הצג רשימת קניות"]);
  });

  it("collab nav from apply evidence only: share/assign/fail/noop/mixed/bulk", () => {
    const nameById = new Map([
      ["tal", "טל"],
      ["michal", "מיכל"],
      ["amit", "עמית"],
    ]);

    // Successful co-share: model collab kept when evidence matches.
    const shareMap = buildCollabByListKey(
      [
        {
          listType: "shopping",
          collabApply: { mode: "co_share", partnerIds: ["michal"] },
        },
      ],
      nameById,
    );
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "add",
              listType: "shopping",
              listName: "",
              items: [{ "שם פריט": "חלב" }],
              targets: ["טל", "מיכל"],
            },
          ],
        },
        [
          {
            label: "משותף עם מיכל",
            command: "הצג קניות משותפות עם מיכל",
          },
        ],
        {
          speakerNames: ["טל"],
          appliedNav: {
            listKeys: new Set(["shopping"]),
            filing: false,
            collabByListKey: shareMap,
          },
        },
      ).map((b) => b.command),
    ).toEqual(["הצג קניות משותפות עם מיכל"]);
    // Safety net alone never invents collab — plain LIST only.
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "add",
              listType: "shopping",
              listName: "",
              items: [{ "שם פריט": "חלב" }],
              targets: ["טל", "מיכל"],
            },
          ],
        },
        [],
        {
          speakerNames: ["טל"],
          appliedNav: {
            listKeys: new Set(["shopping"]),
            filing: false,
            collabByListKey: shareMap,
          },
        },
      ).map((b) => b.command),
    ).toEqual(["הצג רשימת קניות"]);

    // Successful assign → model באחריות kept.
    const assignMap = buildCollabByListKey(
      [
        {
          listType: "tasks",
          collabApply: { mode: "assign", partnerIds: ["michal"] },
        },
      ],
      nameById,
    );
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "add",
              listType: "tasks",
              listName: "",
              items: [{ "שם מטלה": "לקנות חלב" }],
              targets: ["מיכל"],
            },
          ],
        },
        [
          {
            label: "באחריות מיכל",
            command: "הצג מטלות באחריות מיכל",
          },
        ],
        {
          speakerNames: ["טל"],
          appliedNav: {
            listKeys: new Set(["tasks"]),
            filing: false,
            collabByListKey: assignMap,
          },
        },
      ).map((b) => b.command),
    ).toEqual(["הצג מטלות באחריות מיכל"]);

    // Failed share: model collab without evidence → normalize to plain LIST.
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "update",
              listType: "shopping",
              listName: "",
              items: [{ item_id: "a", "שם פריט": "חלב" }],
              targets: ["טל", "מיכל"],
            },
          ],
        },
        [
          {
            label: "משותף עם מיכל",
            command: "הצג קניות משותפות עם מיכל",
          },
        ],
        {
          speakerNames: ["טל"],
          appliedNav: {
            listKeys: new Set(["shopping"]),
            filing: false,
            collabByListKey: new Map(),
          },
        },
      ).map((b) => ({ label: b.label, command: b.command })),
    ).toEqual([{ label: "הצג קניות", command: "הצג רשימת קניות" }]);

    // shareOutcome noop (already shared) still proves co_share via collabApply.
    const noopMap = buildCollabByListKey(
      [
        {
          listType: "shopping",
          collabApply: { mode: "co_share", partnerIds: ["michal"] },
        },
      ],
      nameById,
    );
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "update",
              listType: "shopping",
              listName: "",
              items: [{ item_id: "a", "שם פריט": "חלב" }],
              targets: ["טל", "מיכל"],
            },
          ],
        },
        [
          {
            label: "משותף עם מיכל",
            command: "הצג קניות משותפות עם מיכל",
          },
        ],
        {
          speakerNames: ["טל"],
          appliedNav: {
            listKeys: new Set(["shopping"]),
            filing: false,
            collabByListKey: noopMap,
          },
        },
      ).map((b) => ({ label: b.label, command: b.command })),
    ).toEqual([
      {
        label: "משותף עם מיכל",
        command: "הצג קניות משותפות עם מיכל",
      },
    ]);

    // Personal mutate succeeded on same list while share ACTION targets failed → plain.
    const personalOnly = buildCollabByListKey(
      [{ listType: "shopping" /* no collabApply */ }],
      nameById,
    );
    expect(personalOnly.size).toBe(0);
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "add",
              listType: "shopping",
              listName: "",
              items: [{ "שם פריט": "לחם" }],
              targets: ["טל", "מיכל"],
            },
          ],
        },
        [{ label: "כן", command: "כן" }],
        {
          speakerNames: ["טל"],
          appliedNav: {
            listKeys: new Set(["shopping"]),
            filing: false,
            collabByListKey: personalOnly,
          },
        },
      ).map((b) => b.command),
    ).toEqual(["כן", "הצג רשימת קניות"]);

    // Bulk co-share: model emits shared-with + כל — both kept with evidence.
    const bulkMap = buildCollabByListKey(
      [
        {
          listType: "shopping",
          collabApply: { mode: "co_share", partnerIds: ["michal"] },
        },
        {
          listType: "shopping",
          collabApply: { mode: "co_share", partnerIds: ["michal"] },
        },
      ],
      nameById,
    );
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "update",
              listType: "shopping",
              listName: "",
              items: [
                { item_id: "a", "שם פריט": "חלב" },
                { item_id: "b", "שם פריט": "לחם" },
              ],
              targets: ["טל", "מיכל"],
            },
          ],
        },
        [
          {
            label: "משותף עם מיכל",
            command: "הצג קניות משותפות עם מיכל",
          },
          { label: "כל הקניות", command: "כל הקניות" },
        ],
        {
          speakerNames: ["טל"],
          appliedNav: {
            listKeys: new Set(["shopping"]),
            filing: false,
            collabByListKey: bulkMap,
          },
        },
      ).map((b) => b.command),
    ).toEqual(["הצג קניות משותפות עם מיכל", "כל הקניות"]);

    const multiPartnerMap = buildCollabByListKey(
      [
        {
          listType: "shopping",
          collabApply: {
            mode: "co_share",
            partnerIds: ["michal", "amit"],
          },
        },
      ],
      nameById,
    );
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "update",
              listType: "shopping",
              listName: "",
              items: [{ item_id: "a", "שם פריט": "חלב" }],
              targets: ["טל", "מיכל", "עמית"],
            },
          ],
        },
        [{ label: "כל הקניות", command: "כל הקניות" }],
        {
          speakerNames: ["טל"],
          appliedNav: {
            listKeys: new Set(["shopping"]),
            filing: false,
            collabByListKey: multiPartnerMap,
          },
        },
      ).map((b) => b.command),
    ).toEqual(["כל הקניות"]);

    // Conversational taps still kept alongside apply-gated plain nav.
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "add",
              listType: "tasks",
              listName: "",
              items: [{ "שם מטלה": "בדיקה" }],
              targets: ["טל", "מיכל"],
            },
          ],
        },
        [
          { label: "כן", command: "כן" },
          { label: "לא", command: "לא" },
        ],
        {
          speakerNames: ["טל"],
          appliedNav: {
            listKeys: new Set(["tasks"]),
            filing: false,
            collabByListKey: new Map(),
          },
        },
      ).map((b) => b.command),
    ).toEqual(["כן", "לא", "הצג רשימת מטלות"]);
  });

  it("item-open: keeps existing-row tap without mutate; drops failed save; keeps proven apply", () => {
    const openTask = {
      label: "ללכת לספר",
      command: "הציגי את המטלה ללכת לספר",
    };
    expect(parseItemOpenButton(openTask)).toEqual({
      kind: "tasks",
      title: "ללכת לספר",
    });

    // No mutate intent this turn → existing item open stays.
    expect(
      shouldKeepItemOpenButton(openTask, emptyLlmMetadata(), {
        lists: [],
        filings: [],
      }),
    ).toBe(true);
    expect(
      ensureSpeakerShowButtons(emptyLlmMetadata(), [openTask, { label: "כן", command: "כן" }], {
        appliedItems: { lists: [], filings: [] },
      }),
    ).toEqual([openTask, { label: "כן", command: "כן" }]);

    const addMeta = {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add" as const,
          listType: "tasks" as const,
          listName: "",
          items: [{ "שם מטלה": "ללכת לספר" }],
          targets: [] as string[],
        },
      ],
    };
    // Mutate claimed but not applied → drop item-open; keep כן.
    expect(
      ensureSpeakerShowButtons(addMeta, [openTask, { label: "כן", command: "כן" }], {
        appliedItems: { lists: [], filings: [] },
        appliedNav: { listKeys: new Set(), filing: false },
      }),
    ).toEqual([{ label: "כן", command: "כן" }]);

    // Applied add (unique title) → keep item-open + engine list nav.
    expect(
      ensureSpeakerShowButtons(addMeta, [openTask], {
        appliedItems: {
          lists: [
            {
              action: "add",
              itemId: "task-1",
              itemLabel: "ללכת לספר",
              listType: "tasks",
            },
          ],
          filings: [],
        },
        appliedNav: { listKeys: new Set(["tasks"]), filing: false },
      }),
    ).toEqual([
      openTask,
      { label: "הצג מטלות", command: "הצג רשימת מטלות" },
    ]);

    // Prefer item_id when ACTION carries it.
    const updateMeta = {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "update" as const,
          listType: "tasks" as const,
          listName: "",
          items: [{ item_id: "task-9", "שם מטלה": "ללכת לספר" }],
          targets: [] as string[],
        },
      ],
    };
    expect(
      ensureSpeakerShowButtons(updateMeta, [openTask], {
        appliedItems: {
          lists: [
            {
              action: "update",
              itemId: "task-9",
              itemLabel: "ללכת לספר",
              listType: "tasks",
            },
          ],
          filings: [],
        },
      }),
    ).toEqual([
      openTask,
      { label: "הצג מטלות", command: "הצג רשימת מטלות" },
    ]);
    // Wrong id applied → drop.
    expect(
      shouldKeepItemOpenButton(openTask, updateMeta, {
        lists: [
          {
            action: "update",
            itemId: "other",
            itemLabel: "ללכת לספר",
            listType: "tasks",
          },
        ],
        filings: [],
      }),
    ).toBe(false);

    // Ambiguous title (two applied adds same label) → drop.
    expect(
      shouldKeepItemOpenButton(openTask, addMeta, {
        lists: [
          {
            action: "add",
            itemId: "a",
            itemLabel: "ללכת לספר",
            listType: "tasks",
          },
          {
            action: "add",
            itemId: "b",
            itemLabel: "ללכת לספר",
            listType: "tasks",
          },
        ],
        filings: [],
      }),
    ).toBe(false);

    // Filing: proven add keeps; missing apply drops; existing (no intent) keeps.
    const openFiling = {
      label: "רישיון",
      command: "הציגי את התיוק רישיון",
    };
    const filingAdd = {
      ...emptyLlmMetadata(),
      filing: [
        {
          action: "add_filing" as const,
          itemName: "רישיון",
          itemInfo: "",
          itemDescription: "",
          filingId: "",
          targets: [] as string[],
        },
      ],
    };
    expect(
      shouldKeepItemOpenButton(openFiling, filingAdd, {
        lists: [],
        filings: [],
      }),
    ).toBe(false);
    expect(
      shouldKeepItemOpenButton(openFiling, filingAdd, {
        lists: [],
        filings: [{ action: "add", itemName: "רישיון" }],
      }),
    ).toBe(true);
    expect(
      shouldKeepItemOpenButton(openFiling, emptyLlmMetadata(), {
        lists: [],
        filings: [],
      }),
    ).toBe(true);

    // Remove applied → drop item-open.
    expect(
      shouldKeepItemOpenButton(openTask, addMeta, {
        lists: [
          {
            action: "remove",
            itemId: "task-1",
            itemLabel: "ללכת לספר",
            listType: "tasks",
          },
        ],
        filings: [],
      }),
    ).toBe(false);
  });

  it("LIST BUTTON: validates model fixed nav; dedupes messy duplicate command", () => {
    expect(
      normalizeShowNavCommand("הצג רשימת רשימת דברים שעלו לשרת"),
    ).toBe("הצג רשימת דברים שעלו לשרת");
    expect(
      isEngineOwnedListNavButton({
        label: "הצג רשימה",
        command: "הצג רשימת רשימת דברים שעלו לשרת",
      }),
    ).toBe(true);
    expect(
      isEngineOwnedListNavButton({
        label: "כן",
        command: "כן",
      }),
    ).toBe(false);
    expect(
      isEngineOwnedListNavButton({
        label: "ללכת לספר",
        command: "הציגי את המטלה ללכת לספר",
      }),
    ).toBe(false);

    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "remove",
              listType: "custom",
              listName: "דברים שעלו לשרת",
              items: [{ item_id: "2", נושא: "כפתור waze" }],
              targets: [],
            },
          ],
        },
        [
          {
            label: "הצג רשימה",
            command: "הצג רשימת רשימת דברים שעלו לשרת",
          },
          { label: "הצג רשימה", command: "הצג רשימת דברים שעלו לשרת" },
        ],
      ),
    ).toEqual([
      { label: "הצג רשימה", command: "הצג רשימת דברים שעלו לשרת" },
    ]);
  });

  it("LIST BUTTON: keeps conversational כן/לא; keeps model list nav once (no double)", () => {
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "add",
              listType: "tasks",
              listName: "",
              items: [{ "שם מטלה": "ללכת לספר" }],
              targets: [],
            },
          ],
        },
        [
          {
            label: "ללכת לספר",
            command: "הציגי את המטלה ללכת לספר",
          },
          { label: "הצג מטלות", command: "הצג רשימת מטלות" },
        ],
      ),
    ).toEqual([
      {
        label: "ללכת לספר",
        command: "הציגי את המטלה ללכת לספר",
      },
      { label: "הצג מטלות", command: "הצג רשימת מטלות" },
    ]);
  });

  it("keeps model reminder day-angle taps; does not invent אצלך/לתור; adds LIST BUTTON", () => {
    const meta = {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add" as const,
          listType: "reminders" as const,
          listName: "",
          items: [{ item: "תור לספר", time: "09:00" }],
          targets: [] as string[],
        },
        {
          action: "add" as const,
          listType: "tasks" as const,
          listName: "",
          items: [{ "שם מטלה": "תור לספר" }],
          targets: [] as string[],
        },
      ],
    };
    const modelAngles = [
      {
        label: "יום ד׳ אצלך",
        command: "מה יש לך ביום רביעי",
      },
      { label: "התור", command: "מה יש לי ביום רביעי" },
    ];
    // Engine preserves model content-aware taps; never synthesizes אצלך/לתור alone.
    expect(ensureSpeakerShowButtons(meta, modelAngles)).toEqual([
      ...modelAngles,
      { label: "הצג מטלות", command: "הצג רשימת מטלות" },
    ]);
    expect(
      ensureSpeakerShowButtons(meta, []).map((b) => b.command),
    ).toEqual(["הצג רשימת מטלות"]);
    expect(
      ensureSpeakerShowButtons(meta, []).every(
        (b) =>
          !b.label.includes("אצלך") &&
          !b.label.includes("לתור") &&
          !b.command.includes("מה יש לך"),
      ),
    ).toBe(true);
  });

  it("LIST BUTTON: appliedNav empty → no fixed nav even if metadata has remove", () => {
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "remove",
              listType: "custom",
              listName: "דברים שעלו לשרת",
              items: [{ item_id: "2", נושא: "x" }],
              targets: [],
            },
          ],
        },
        [{ label: "הצג רשימה", command: "הצג רשימת דברים שעלו לשרת" }],
        { appliedNav: { listKeys: new Set(), filing: false } },
      ),
    ).toEqual([]);
  });

  it("LIST SHELL: listsOverview → safety-net הצג רשימות (full dump)", () => {
    expect(
      ensureSpeakerShowButtons(emptyLlmMetadata(), [], {
        appliedNav: {
          listKeys: new Set(),
          filing: false,
          listsOverview: true,
        },
      }),
    ).toEqual([{ label: "הצג רשימות", command: "הצג רשימות" }]);
  });

  it("LIST-LEVEL ATTACH: applied list key without listsOverview → הצג רשימה only", () => {
    expect(
      ensureSpeakerShowButtons(emptyLlmMetadata(), [], {
        appliedNav: {
          listKeys: new Set(["custom:ציוד"]),
          filing: false,
          listsOverview: false,
        },
      }),
    ).toEqual([{ label: "הצג רשימה", command: "הצג רשימת ציוד" }]);
  });

  it("LIST-LEVEL ATTACH: model הצג רשימות dropped when listsOverview false", () => {
    expect(
      ensureSpeakerShowButtons(
        emptyLlmMetadata(),
        [{ label: "הצג רשימות", command: "הצג רשימות" }],
        {
          appliedNav: {
            listKeys: new Set(["custom:ציוד"]),
            filing: false,
            listsOverview: false,
          },
        },
      ),
    ).toEqual([{ label: "הצג רשימה", command: "הצג רשימת ציוד" }]);
  });

  it("LIST SHELL: item-only mutate must NOT get הצג רשימות", () => {
    const buttons = ensureSpeakerShowButtons(
      {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "custom",
            listName: "ציוד",
            items: [{ נושא: "מברג" }],
            targets: [],
          },
        ],
      },
      [],
      {
        appliedNav: {
          listKeys: new Set(["custom:ציוד"]),
          filing: false,
          listsOverview: false,
        },
      },
    );
    expect(buttons.map((b) => b.command)).toEqual(["הצג רשימת ציוד"]);
    expect(buttons.some((b) => b.command === "הצג רשימות")).toBe(false);
  });

  it("LIST SHELL: model הצג רשימות kept only when listsOverview applied", () => {
    const overview = { label: "הצג רשימות", command: "הצג רשימות" };
    expect(
      ensureSpeakerShowButtons(emptyLlmMetadata(), [overview], {
        appliedNav: {
          listKeys: new Set(),
          filing: false,
          listsOverview: true,
        },
      }),
    ).toEqual([overview]);
    expect(
      ensureSpeakerShowButtons(emptyLlmMetadata(), [overview], {
        appliedNav: {
          listKeys: new Set(["shopping"]),
          filing: false,
          listsOverview: false,
        },
      }),
    ).toEqual([{ label: "הצג קניות", command: "הצג רשימת קניות" }]);
    expect(isEngineOwnedListNavButton(overview)).toBe(true);
  });

  it("LIST SHELL: shell create key + listsOverview → specific list + overview", () => {
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "add",
              listType: "custom",
              listName: "ציוד",
              items: [],
              targets: [],
            },
          ],
        },
        [],
        {
          appliedNav: {
            listKeys: new Set(["custom:ציוד"]),
            filing: false,
            listsOverview: true,
          },
        },
      ),
    ).toEqual([
      { label: "הצג רשימה", command: "הצג רשימת ציוד" },
      { label: "הצג רשימות", command: "הצג רשימות" },
    ]);
  });

  it("LIST BUTTON: model plain LIST + appliedNav keep → original label, no safety-net duplicate", () => {
    const modelList = {
      label: "מה בקניות",
      command: "הצג רשימת קניות",
    };
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "add",
              listType: "shopping",
              listName: "",
              items: [{ "שם פריט": "חלב" }],
              targets: [],
            },
          ],
        },
        [modelList],
        {
          appliedNav: {
            listKeys: new Set(["shopping"]),
            filing: false,
            collabByListKey: new Map(),
          },
        },
      ),
    ).toEqual([modelList]);
  });

  it("LIST BUTTON: injects missing show-list after list/filing mutate; no duplicate", () => {
    expect(
      ensureSpeakerShowButtons({
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "חלב" }],
            targets: [],
          },
        ],
      }),
    ).toEqual([{ label: "הצג קניות", command: "הצג רשימת קניות" }]);

    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "add",
              listType: "shopping",
              listName: "",
              items: [{ "שם פריט": "חלב" }],
              targets: [],
            },
          ],
        },
        [{ label: "הצג קניות", command: "הצג רשימת קניות" }],
      ),
    ).toEqual([{ label: "הצג קניות", command: "הצג רשימת קניות" }]);

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
    ).toEqual([{ label: "הצג מטלות", command: "הצג רשימת מטלות" }]);

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
    ).toEqual([{ label: "הצג קניות", command: "הצג רשימת קניות" }]);

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
        [{ label: "מה יש לי מחר", command: "מה יש לי מחר" }],
      ),
    ).toEqual([
      { label: "מה יש לי מחר", command: "מה יש לי מחר" },
      { label: "הצג מטלות", command: "הצג רשימת מטלות" },
    ]);

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
      { label: "הצג רשימה", command: "הצג רשימת בדיקת שם" },
      { label: "הצג תיוקים", command: "הצג תיוקים" },
    ]);

    expect(
      ensureSpeakerShowButtons({
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "contacts",
            listName: "",
            items: [{ "שם פרטי": "דני", טלפון: "0501111111" }],
            targets: [],
          },
        ],
      }),
    ).toEqual([{ label: "הצג אנשי קשר", command: "הצג רשימת אנשי קשר" }]);

    // Contacts v2: directory add/update/remove → same LIST nav as other domains.
    expect(
      ensureSpeakerShowButtons({
        ...emptyLlmMetadata(),
        directory: [
          {
            action: "add",
            name: "דני",
            phone: "0501111111",
            contactId: "",
            targets: [],
          },
        ],
      }),
    ).toEqual([{ label: "הצג אנשי קשר", command: "הצג רשימת אנשי קשר" }]);
    expect(
      ensureSpeakerShowButtons(
        {
          ...emptyLlmMetadata(),
          directory: [
            {
              action: "update",
              name: "דני",
              phone: "0501111111",
              contactId: "c1",
              targets: [],
            },
          ],
        },
        [],
        { appliedNav: { listKeys: new Set(["contacts"]), filing: false } },
      ),
    ).toEqual([{ label: "הצג אנשי קשר", command: "הצג רשימת אנשי קשר" }]);
  });

  it("LIST BUTTON: does not invent הצג תזכורות on reminder-only turns", () => {
    expect(
      ensureSpeakerShowButtons({
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
    ).toEqual([]);
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

  it("does not send a phone target immediately when the message is scheduled for later", () => {
    expect(
      planPhoneRelays(
        [
          {
            targets: ["050-222-2222"],
            text: "היי מחר",
            inSeconds: 3600,
          },
        ],
        employees,
        amit.id,
      ),
    ).toEqual([]);
    expect(
      planPhoneRelays(
        [
          {
            targets: ["דני"],
            text: "שלום בערב",
            date: "2026-10-29",
            time: "20:00",
            expectsReply: false,
          },
        ],
        employees,
        amit.id,
        [{ id: "c1", name: "דני", phone: "0503333333" }],
      ),
    ).toEqual([]);
  });

  it("Send LATER rule: scheduled messages never go through immediate named relay", () => {
    // Contract: deferred check-with (expects_reply) is queued separately;
    // pure-info + schedule must not WhatsApp now (Send LATER → reminders).
    const lucy: PublicEmployee = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "digital",
      name: "לוסי",
      surname: "",
      nickname: "לוסי",
      email: null,
      phone: null,
    };
    const roster = [...employees, lucy];
    expect(
      planRelayDeliveries({
        actor: amit,
        sender: lucy,
        employees: roster,
        messages: [
          {
            targets: ["טל"],
            text: "עדכון מחר",
            expectsReply: false,
            inSeconds: 7200,
          },
        ],
      }),
    ).toEqual([]);
    expect(
      planRelayDeliveries({
        actor: amit,
        sender: lucy,
        employees: roster,
        messages: [
          {
            targets: ["טל"],
            text: "עמית שואל מחר?",
            expectsReply: true,
            askSummary: "שאלה",
            date: "2026-10-29",
            time: "09:00",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("does not claim deferred delivery when schedule was only skipped", () => {
    expect(
      formatScheduleSkippedWithoutQueueNotice({
        messages: [
          {
            targets: ["050-222-2222"],
            text: "היי בערב",
            time: "20:00",
            expectsReply: false,
          },
        ],
        scheduledJobCount: 0,
      }),
    ).toContain("לא תוזמנה");
    expect(
      formatScheduleSkippedWithoutQueueNotice({
        messages: [
          {
            targets: ["טל"],
            text: "קנית חלב?",
            expectsReply: true,
            inSeconds: 3600,
          },
        ],
        scheduledJobCount: 1,
      }),
    ).toBe("");
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

  it("refuses shopping update that addresses a tasks item_id (no cross-kind remap)", () => {
    // Share-by-index wrong-entity: shopping ACTION + tasks row must not remap
    // list_type via itemOwners and co-share the task. Semantic cross-kind
    // show_dump retrieval is a separate path and stays allowed.
    const taskId = "7dc44b7b-3c12-4694-ac49-75b5d8d92f9d";
    const plan = planTargetedActions({
      actor: amit,
      employees,
      itemOwners: new Map([[taskId, ownerRef(amit.id, "tasks")]]),
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "shopping",
            listName: "",
            targets: ["טל"],
            items: [{ item_id: taskId }],
          },
        ],
      },
    });
    expect(plan.applications).toHaveLength(0);
  });

  it("lifts item-nested targets onto list share visibility (model shape drift)", () => {
    // Live miss: lists.update with targets only inside items[] → SHARE_CLAIM_MISS.
    const birthdayId = "7dc44b7b-3c12-4694-ac49-75b5d8d92f9d";
    const plan = planTargetedActions({
      actor: tal,
      employees,
      itemOwners: new Map([[birthdayId, ownerRef(tal.id, "tasks")]]),
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "tasks",
            listName: "",
            targets: [],
            items: [
              {
                item_id: birthdayId,
                targets: ["טל", "עמית"],
              },
            ],
          },
        ],
      },
    });
    expect(plan.applications).toHaveLength(1);
    expect(plan.applications[0]).toMatchObject({
      employeeId: tal.id,
      visibility: {
        scope: "shared",
        visibleTo: expect.arrayContaining([tal.id, amit.id]),
        itemOnly: true,
      },
    });
    expect(plan.applications[0]?.metadata.lists[0]?.items).toEqual([
      { item_id: birthdayId },
    ]);
  });

  it("item-level targets win over list-level when both are present on the same row", () => {
    const coffeeId = "99ea236b-9203-4a4f-be3f-69882dacf8ac";
    const plan = planTargetedActions({
      actor: tal,
      employees,
      itemOwners: new Map([[coffeeId, ownerRef(tal.id, "shopping")]]),
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "shopping",
            listName: "",
            // List says Amit; item says Shani — item wins.
            targets: ["טל", "עמית"],
            items: [{ item_id: coffeeId, targets: ["טל", "שני"] }],
          },
        ],
      },
    });
    expect(plan.applications).toHaveLength(1);
    expect(plan.applications[0]?.visibility.visibleTo).toEqual(
      expect.arrayContaining([tal.id, shani.id]),
    );
    expect(plan.applications[0]?.visibility.visibleTo).not.toContain(amit.id);
  });

  it("splits multi-item updates so different nested targets do not mix recipients", () => {
    const milkId = "11111111-1111-4111-8111-111111111101";
    const breadId = "11111111-1111-4111-8111-111111111102";
    const plan = planTargetedActions({
      actor: tal,
      employees,
      itemOwners: new Map([
        [milkId, ownerRef(tal.id, "shopping")],
        [breadId, ownerRef(tal.id, "shopping")],
      ]),
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "shopping",
            listName: "",
            targets: [],
            items: [
              { item_id: milkId, targets: ["טל", "עמית"] },
              { item_id: breadId, targets: ["טל", "שני"] },
            ],
          },
        ],
      },
    });
    expect(plan.applications).toHaveLength(2);
    const milkApp = plan.applications.find((row) =>
      row.metadata.lists[0]?.items.some(
        (item) =>
          item &&
          typeof item === "object" &&
          (item as { item_id?: string }).item_id === milkId,
      ),
    );
    const breadApp = plan.applications.find((row) =>
      row.metadata.lists[0]?.items.some(
        (item) =>
          item &&
          typeof item === "object" &&
          (item as { item_id?: string }).item_id === breadId,
      ),
    );
    expect(milkApp?.visibility.visibleTo).toEqual(
      expect.arrayContaining([tal.id, amit.id]),
    );
    expect(milkApp?.visibility.visibleTo).not.toContain(shani.id);
    expect(breadApp?.visibility.visibleTo).toEqual(
      expect.arrayContaining([tal.id, shani.id]),
    );
    expect(breadApp?.visibility.visibleTo).not.toContain(amit.id);
  });

  it("inherits list-level targets for items without nested targets in a mixed update", () => {
    const milkId = "11111111-1111-4111-8111-111111111201";
    const breadId = "11111111-1111-4111-8111-111111111202";
    const plan = planTargetedActions({
      actor: tal,
      employees,
      itemOwners: new Map([
        [milkId, ownerRef(tal.id, "shopping")],
        [breadId, ownerRef(tal.id, "shopping")],
      ]),
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "shopping",
            listName: "",
            targets: ["טל", "עמית"],
            items: [
              { item_id: milkId },
              { item_id: breadId, targets: ["טל", "שני"] },
            ],
          },
        ],
      },
    });
    expect(plan.applications).toHaveLength(2);
    const milkApp = plan.applications.find((row) =>
      JSON.stringify(row.metadata.lists[0]?.items).includes(milkId),
    );
    const breadApp = plan.applications.find((row) =>
      JSON.stringify(row.metadata.lists[0]?.items).includes(breadId),
    );
    expect(milkApp?.visibility.visibleTo).toEqual(
      expect.arrayContaining([tal.id, amit.id]),
    );
    expect(breadApp?.visibility.visibleTo).toEqual(
      expect.arrayContaining([tal.id, shani.id]),
    );
  });

  it("packs whole shopping fan-out (many item_ids) into one owner application", () => {
    const milkId = "11111111-1111-4111-8111-111111111101";
    const breadId = "11111111-1111-4111-8111-111111111102";
    const plan = planTargetedActions({
      actor: amit,
      employees,
      itemOwners: new Map([
        [milkId, ownerRef(amit.id, "shopping")],
        [breadId, ownerRef(amit.id, "shopping")],
      ]),
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "shopping",
            listName: "",
            targets: ["עמית", "טל"],
            items: [{ item_id: milkId }, { item_id: breadId }],
          },
        ],
      },
    });
    expect(plan.applications).toHaveLength(1);
    expect(plan.applications[0]).toMatchObject({
      employeeId: amit.id,
      visibility: {
        scope: "shared",
        visibleTo: expect.arrayContaining([amit.id, tal.id]),
        itemOnly: true,
      },
    });
    expect(plan.applications[0]?.metadata.lists[0]?.items).toEqual([
      { item_id: milkId },
      { item_id: breadId },
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

  it("routes a partner's content update of a co-shared task to the owner's list", () => {
    const taskId = "a9ea236b-9203-4a4f-be3f-69882dacf8ac";
    const plan = planTargetedActions({
      actor: tal,
      employees,
      itemOwners: new Map([
        [
          taskId,
          {
            ...ownerRef(amit.id, "tasks"),
            itemVisibleTo: [amit.id, tal.id],
          },
        ],
      ]),
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "tasks",
            listName: "",
            targets: [],
            items: [
              {
                item_id: taskId,
                "שם מטלה": "לקנות עוגה גדולה",
                "תאריך לביצוע": "2026-10-31",
              },
            ],
          },
        ],
      },
    });
    expect(plan.applications).toHaveLength(1);
    expect(plan.applications[0]).toMatchObject({
      employeeId: amit.id,
      visibility: {
        scope: "personal",
        itemOnly: true,
        visibleTo: [amit.id],
      },
    });
    expect(plan.applications[0]?.metadata.lists[0]?.items).toEqual([
      expect.objectContaining({
        item_id: taskId,
        "שם מטלה": "לקנות עוגה גדולה",
      }),
    ]);
  });

  it("assigns filing onto the other person when targets omit the speaker", () => {
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
    expect(plan.applications[0]?.employeeId).toBe(amit.id);
    expect(plan.applications[0]?.visibility).toMatchObject({
      addedById: tal.id,
      visibleTo: expect.arrayContaining([tal.id, amit.id]),
    });
    expect(plan.notifications.map((row) => row.employee.id)).toEqual([amit.id]);
  });

  it("co-shares filing on the speaker when targets include speaker+partner", () => {
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
            targets: ["טל", "עמית"],
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
  });

  it("assigns contacts onto the other person when targets omit the speaker", () => {
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
    expect(plan.applications[0]?.employeeId).toBe(amit.id);
    expect(plan.applications[0]?.visibility?.addedById).toBe(tal.id);
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
      isGuest: true,
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

  it("resolves cross-account partners from extras without expanding כולם", () => {
    const foreign: PublicEmployee = {
      id: "foreign-michal-1",
      kind: "human",
      name: "Michal",
      surname: "Cohen",
      nickname: "מיכל",
      email: null,
      phone: "972501111111",
      isGuest: false,
    };
    expect(
      resolveActionTargets(["מיכל"], employees, amit.id, [foreign]),
    ).toEqual([foreign]);
    expect(resolveActionTargets(["כולם"], employees, amit.id, [foreign])).toEqual(
      employees,
    );
  });

  it("co-shares onto the speaker book with a cross-account external partner", () => {
    const foreign: PublicEmployee = {
      id: "foreign-michal-2",
      kind: "human",
      name: "Michal",
      surname: "Cohen",
      nickname: "מיכל",
      email: null,
      phone: "972502222222",
      isGuest: false,
    };
    const plan = planTargetedActions({
      actor: amit,
      employees,
      externalPartners: [foreign],
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "לחם" }],
            targets: ["עמית", "מיכל"],
          },
        ],
      },
    });
    expect(plan.applications).toEqual([
      expect.objectContaining({
        employeeId: amit.id,
        visibility: expect.objectContaining({
          scope: "shared",
          visibleTo: expect.arrayContaining([amit.id, foreign.id]),
        }),
      }),
    ]);
    expect(plan.notifications.map((row) => row.employee.id)).toEqual([
      foreign.id,
    ]);
  });

  it("assigns shopping onto a cross-account partner book", () => {
    const foreign: PublicEmployee = {
      id: "foreign-eran-1",
      kind: "human",
      name: "Eran",
      surname: "Levy",
      nickname: "ערן",
      email: null,
      phone: "972503333333",
      isGuest: false,
    };
    const plan = planTargetedActions({
      actor: amit,
      employees,
      externalPartners: [foreign],
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "חלב" }],
            targets: ["ערן"],
          },
        ],
      },
    });
    expect(plan.applications).toEqual([
      expect.objectContaining({
        employeeId: foreign.id,
      }),
    ]);
    expect(
      plan.applications.some((row) => row.employeeId === amit.id),
    ).toBe(false);
    expect(plan.notifications.map((row) => row.employee.id)).toEqual([
      foreign.id,
    ]);
  });

  it("mutates a foreign-owned item_id when the owner is only in itemOwners", () => {
    const foreignOwnerId = "foreign-owner-item-1";
    const itemId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const plan = planTargetedActions({
      actor: amit,
      employees,
      itemOwners: new Map([
        [
          itemId,
          ownerRef(foreignOwnerId, "shopping", {
            itemVisibleTo: [foreignOwnerId, amit.id],
          }),
        ],
      ]),
      metadata: {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "update",
            listType: "shopping",
            listName: "",
            items: [{ item_id: itemId, "שם פריט": "חלב", כמות: "2" }],
            targets: [],
          },
        ],
      },
    });
    expect(plan.applications).toEqual([
      expect.objectContaining({
        employeeId: foreignOwnerId,
      }),
    ]);
  });
});
