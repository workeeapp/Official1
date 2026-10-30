/**
 * Slim multi-clock item↔reminder links — offline (no DB / OpenAI / WhatsApp).
 *
 * Implementation closed (slim). Follow-up coverage (it.todo below / eval-db):
 * - worker path in linkedReminderField union
 * - missing / malformed / unauthorized item_id (clock saved, no link)
 * - full chat E2E + migration abort vs duplicate legacy (eval-db todos)
 */
import { describe, expect, it } from "vitest";
import { parseReplyMetadata } from "@workee/shared";
import {
  linkedReminderField,
  sortLinkedReminderRows,
} from "../src/services/employee-records.service.js";
import {
  formatLinkedReminderParen,
  itemHasLinkedReminder,
} from "../src/services/show-button-dump.js";
import { findDuplicateLegacyLinkedReminderIds } from "../src/services/reminder.service.js";

describe("multi-clock item↔reminder links (offline)", () => {
  // --- Follow-up coverage (do not implement until Tal asks) ---
  it.todo(
    "FOLLOW-UP: linkedReminderField worker path (reminderId + activeByWorkerItemId) unions without dupes",
  );
  it.todo(
    "FOLLOW-UP: missing / non-UUID / unauthorized item_id → clock saved, no join",
  );
  it("parses reminders[].item_id on add without aliasing to reminder_id", () => {
    const parsed = parseReplyMetadata(
      JSON.stringify({
        response: "ok",
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "reminders",
              list_name: "",
              items: [
                {
                  item: "וטרינר",
                  list_type: "tasks",
                  time: "10:00",
                  ping: ["טל"],
                  item_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                },
              ],
            },
          ],
        },
      }),
    );
    expect(parsed.reminders).toHaveLength(1);
    expect(parsed.reminders?.[0]?.itemId).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(parsed.reminders?.[0]?.reminderId).toBe("");
  });

  it("still aliases item_id → reminder_id on remove (legacy)", () => {
    const parsed = parseReplyMetadata(
      JSON.stringify({
        response: "ok",
        metadata: {
          lists: [
            {
              action: "remove",
              list_type: "reminders",
              list_name: "",
              items: [
                {
                  item_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                },
              ],
            },
          ],
        },
      }),
    );
    expect(parsed.reminders?.[0]?.reminderId).toBe(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
    expect(parsed.reminders?.[0]?.itemId).toBeUndefined();
  });

  it("sortLinkedReminderRows prefers earliest future as primary", () => {
    const now = new Date("2026-10-30T08:00:00.000Z");
    const past = {
      id: "r-past",
      fireAt: new Date("2026-10-29T10:00:00.000Z"),
      repeat: "once",
    };
    const noon = {
      id: "r-noon",
      fireAt: new Date("2026-10-30T10:00:00.000Z"),
      repeat: "once",
    };
    const evening = {
      id: "r-eve",
      fireAt: new Date("2026-10-30T16:00:00.000Z"),
      repeat: "once",
    };
    const sorted = sortLinkedReminderRows([evening, past, noon], now);
    expect(sorted?.primary.id).toBe("r-noon");
    expect(sorted?.all.map((r) => r.id)).toEqual([
      "r-past",
      "r-noon",
      "r-eve",
    ]);
  });

  it("linkedReminderField unions join + legacy + worker and dedupes", () => {
    const active = new Map([
      [
        "r1",
        {
          id: "r1",
          fireAt: new Date("2026-10-30T07:00:00.000Z"),
          repeat: "once",
        },
      ],
      [
        "r2",
        {
          id: "r2",
          fireAt: new Date("2026-10-30T09:00:00.000Z"),
          repeat: "once",
        },
      ],
    ]);
    const field = linkedReminderField(
      {
        id: "item-1",
        linkedReminderId: "r1",
        linkedReminderIds: ["r1", "r2"],
      },
      active,
      undefined,
      undefined,
      null,
      new Date("2026-10-29T00:00:00.000Z"),
    );
    expect((field.reminder as { reminder_id: string }).reminder_id).toBe("r1");
    expect(
      (field.reminders as Array<{ reminder_id: string }>).map(
        (r) => r.reminder_id,
      ),
    ).toEqual(["r1", "r2"]);
  });

  it("legacy-only linked_reminder_id still emits singular reminder", () => {
    const active = new Map([
      [
        "r-legacy",
        {
          id: "r-legacy",
          fireAt: new Date("2026-10-30T11:00:00.000Z"),
          repeat: "once",
        },
      ],
    ]);
    const field = linkedReminderField(
      { id: "item-1", linkedReminderId: "r-legacy" },
      active,
    );
    expect((field.reminder as { reminder_id: string }).reminder_id).toBe(
      "r-legacy",
    );
    expect(field.reminders).toHaveLength(1);
  });

  it("dump: single clock formatting unchanged; multi uses middot", () => {
    const now = new Date("2026-10-30T00:00:00Z");
    const single = {
      reminder: {
        reminder_id: "r1",
        fire_at: "2026-10-30 09:30",
        repeat: "once",
      },
    };
    const singleMark = formatLinkedReminderParen(single, now);
    expect(singleMark.startsWith("🔔 תזכורת:")).toBe(true);
    expect(singleMark).toContain("09:30");
    expect(singleMark).not.toContain(" · ");
    expect(itemHasLinkedReminder(single)).toBe(true);

    const multi = {
      reminder: {
        reminder_id: "r1",
        fire_at: "2026-10-30 09:30",
        repeat: "once",
      },
      reminders: [
        {
          reminder_id: "r1",
          fire_at: "2026-10-30 09:30",
          repeat: "once",
        },
        {
          reminder_id: "r2",
          fire_at: "2026-10-30 14:00",
          repeat: "once",
        },
      ],
    };
    const multiMark = formatLinkedReminderParen(multi, now);
    expect(multiMark).toContain(" · ");
    expect(multiMark).toContain("09:30");
    expect(multiMark).toContain("14:00");
    // Single-clock path must stay byte-stable vs the same singular input.
    expect(formatLinkedReminderParen({ reminder: single.reminder }, now)).toBe(
      singleMark,
    );
  });

  it("preflight: duplicate live linked_reminder_id → abort signal ids", () => {
    const dups = findDuplicateLegacyLinkedReminderIds([
      {
        id: "a",
        linkedReminderId: "r-dup",
        deletedAt: null,
      },
      {
        id: "b",
        linkedReminderId: "r-dup",
        deletedAt: null,
      },
      {
        id: "c",
        linkedReminderId: "r-ok",
        deletedAt: null,
      },
      {
        id: "d",
        linkedReminderId: "r-dup",
        deletedAt: new Date(),
      },
    ]);
    expect(dups).toEqual(["r-dup"]);
    expect(
      findDuplicateLegacyLinkedReminderIds([
        { id: "a", linkedReminderId: "r1", deletedAt: null },
        { id: "b", linkedReminderId: "r2", deletedAt: null },
      ]),
    ).toEqual([]);
  });
});
