import { describe, expect, it } from "vitest";
import type { PublicEmployee } from "@workee/shared";
import {
  fallbackNotificationText,
  fallbackRelayText,
  inferTargetsFromMessage,
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
  it("assigns a spoken task to Tal even when the LLM omitted targets", () => {
    expect(
      inferTargetsFromMessage(
        "טל צריך לקחת מחר בבוקר את הילדים לגינה",
        employees,
        amit.id,
      ),
    ).toEqual(["טל"]);

    const resolved = resolveSpokenMetadata(
      "טל צריך לקחת מחר בבוקר את הילדים לגינה",
      {
        lists: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [
              { "שם מטלה": "טל צריך לקחת מחר בבוקר את הילדים לגינה" },
            ],
            targets: [],
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

  it("does not invent a task from a question about someone else", () => {
    expect(
      resolveSpokenMetadata(
        "מה טל צריך לעשות",
        { lists: [], filing: [] },
        employees,
        amit.id,
      ),
    ).toEqual({ lists: [], filing: [], messages: [] });
  });

  it("synthesizes a task when the LLM returns no actions", () => {
    const resolved = resolveSpokenMetadata(
      "טל צריך לקחת מחר בבוקר את הילדים לגינה",
      { lists: [], filing: [] },
      employees,
      amit.id,
    );
    expect(resolved.lists).toEqual([
      {
        action: "add",
        listType: "tasks",
        listName: "",
        items: [{ "שם מטלה": "לקחת מחר בבוקר את הילדים לגינה" }],
        targets: ["טל"],
      },
    ]);
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

  it("plans Tal's shopping item, Amit's assignment note, and a notification", () => {
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

    expect(plan.applications).toEqual(
      expect.arrayContaining([
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
        expect.objectContaining({
          employeeId: amit.id,
          metadata: expect.objectContaining({
            lists: [
              expect.objectContaining({
                listType: "tasks",
                items: [{ "שם מטלה": "טל צריך לקנות חלב" }],
              }),
            ],
          }),
        }),
      ]),
    );
    expect(plan.notifications).toEqual([
      expect.objectContaining({
        employee: tal,
      }),
    ]);
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
            list.items.some((entry) => entry["שם מטלה"] === "כולם צריכים לקנות חלב וגבינה"),
        ),
      ),
    ).toBe(true);
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
      resolveRelayMessages(
        "תשלחי הודעה לטל - מה שלומך ?",
        [
          {
            targets: ["טל"],
            text: "עמית שואל מה שלומך?\nמה לענות לו ?",
          },
        ],
        roster,
        amit.id,
      ),
    ).toEqual([
      {
        targets: ["טל"],
        text: "עמית שואל מה שלומך?\nמה לענות לו ?",
      },
    ]);

    expect(
      fallbackRelayText("עמית", "תבדקי עם טל אם הוא קנה שמן", ["טל"]),
    ).toBe("עמית שואל אם קנית שמן ?");

    expect(
      resolveRelayMessages("תבדקי עם טל אם הוא קנה שמן", [], roster, amit.id),
    ).toEqual([
      {
        targets: ["טל"],
        text: "עמית שואל אם קנית שמן ?",
      },
    ]);

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
});
