import { describe, expect, it } from "vitest";
import {
  builtinListHebrew,
  builtinListTypeFromHebrew,
  SHOW_LIST_PREFIX,
  SHOW_REMINDERS_COMMAND,
  TASKS_HEBREW_LEGACY,
  showAllListButtonCommand,
  showAssigneeButtonCommand,
  showListButtonCommand,
  showSharedWithButtonCommand,
  showSharedWithButtonLabel,
  showWorkerTasksButtonCommand,
  staticShowButtonDumpMap,
} from "../src/services/builtin-lists.js";

describe("builtin-lists", () => {
  it("maps list types to product Hebrew labels", () => {
    expect(builtinListHebrew("shopping")).toBe("קניות");
    expect(builtinListHebrew("tasks")).toBe("משימות");
    expect(builtinListHebrew("contacts")).toBe("אנשי קשר");
  });

  it("inverts Hebrew labels to list types", () => {
    expect(builtinListTypeFromHebrew("קניות")).toBe("shopping");
    expect(builtinListTypeFromHebrew("משימות")).toBe("tasks");
    expect(builtinListTypeFromHebrew("מטלות")).toBe("tasks");
    expect(builtinListTypeFromHebrew("אנשי קשר")).toBe("contacts");
    expect(builtinListTypeFromHebrew("משימות לעבודה")).toBeNull();
  });

  it("builds opaque show-list button commands", () => {
    expect(showListButtonCommand("shopping")).toBe(`${SHOW_LIST_PREFIX}קניות`);
    expect(showListButtonCommand("tasks")).toBe(`${SHOW_LIST_PREFIX}משימות`);
    expect(showListButtonCommand("contacts")).toBe(
      `${SHOW_LIST_PREFIX}אנשי קשר`,
    );
    expect(showListButtonCommand("משימות לעבודה")).toBe(
      `${SHOW_LIST_PREFIX}משימות לעבודה`,
    );
    expect(showWorkerTasksButtonCommand("לוסי")).toBe("הצג משימות של לוסי");
  });

  it("exposes static button → dump kinds matching the allowlist", () => {
    const map = staticShowButtonDumpMap();
    expect(map[SHOW_REMINDERS_COMMAND]).toBe("reminders");
    expect(map["הצג תיוקים"]).toBe("filings");
    expect(map[showListButtonCommand("shopping")]).toBe("shopping");
    expect(map[showListButtonCommand("tasks")]).toBe("tasks");
    expect(map[`${SHOW_LIST_PREFIX}${TASKS_HEBREW_LEGACY}`]).toBe("tasks");
    expect(map[showListButtonCommand("contacts")]).toBe("phone_book");
    expect(map[showAllListButtonCommand("contacts")]).toBe("phone_book");
    expect(map[showAllListButtonCommand("shopping")]).toBe("shopping");
    expect(map[showAllListButtonCommand("tasks")]).toBe("tasks");
    expect(map["כל המטלות"]).toBe("tasks");
    expect(map[showAllListButtonCommand("filings")]).toBe("filings");
  });

  it("builds shared-with / assignee / all collab commands and short labels", () => {
    expect(showSharedWithButtonCommand("shopping", "מיכל")).toBe(
      "הצג קניות משותפות עם מיכל",
    );
    expect(showAssigneeButtonCommand("tasks", "מיכל")).toBe(
      "הצג משימות באחריות מיכל",
    );
    expect(showAllListButtonCommand("shopping")).toBe("כל הקניות");
    expect(showAllListButtonCommand("tasks")).toBe("כל המשימות");
    expect(showSharedWithButtonLabel("מיכל").length).toBeLessThanOrEqual(20);
  });
});
