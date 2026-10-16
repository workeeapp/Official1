import { describe, expect, it } from "vitest";
import {
  builtinListHebrew,
  builtinListTypeFromHebrew,
  SHOW_LIST_PREFIX,
  SHOW_REMINDERS_COMMAND,
  showListButtonCommand,
  staticShowButtonDumpMap,
} from "../src/services/builtin-lists.js";

describe("builtin-lists", () => {
  it("maps list types to product Hebrew labels", () => {
    expect(builtinListHebrew("shopping")).toBe("קניות");
    expect(builtinListHebrew("tasks")).toBe("מטלות");
    expect(builtinListHebrew("contacts")).toBe("אנשי קשר");
  });

  it("inverts Hebrew labels to list types", () => {
    expect(builtinListTypeFromHebrew("קניות")).toBe("shopping");
    expect(builtinListTypeFromHebrew("מטלות")).toBe("tasks");
    expect(builtinListTypeFromHebrew("אנשי קשר")).toBe("contacts");
    expect(builtinListTypeFromHebrew("משימות לעבודה")).toBeNull();
  });

  it("builds opaque show-list button commands", () => {
    expect(showListButtonCommand("shopping")).toBe(`${SHOW_LIST_PREFIX}קניות`);
    expect(showListButtonCommand("tasks")).toBe(`${SHOW_LIST_PREFIX}מטלות`);
    expect(showListButtonCommand("contacts")).toBe(
      `${SHOW_LIST_PREFIX}אנשי קשר`,
    );
    expect(showListButtonCommand("משימות לעבודה")).toBe(
      `${SHOW_LIST_PREFIX}משימות לעבודה`,
    );
  });

  it("exposes static button → dump kinds matching the allowlist", () => {
    const map = staticShowButtonDumpMap();
    expect(map[SHOW_REMINDERS_COMMAND]).toBe("reminders");
    expect(map["הצג תיוקים"]).toBe("filings");
    expect(map[showListButtonCommand("shopping")]).toBe("shopping");
    expect(map[showListButtonCommand("tasks")]).toBe("tasks");
    expect(map[showListButtonCommand("contacts")]).toBe("contacts");
  });
});
