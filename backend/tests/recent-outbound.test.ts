import { beforeEach, describe, expect, it, vi } from "vitest";

const { reminderFindMany } = vi.hoisted(() => ({
  reminderFindMany: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    reminder: {
      findMany: reminderFindMany,
    },
  },
}));

import {
  formatRecentOutboundContext,
  listRecentReminderOutbounds,
} from "../src/services/recent-outbound.service.js";

describe("listRecentReminderOutbounds", () => {
  beforeEach(() => {
    reminderFindMany.mockReset();
  });

  it("returns only the latest sent reminder for the pinged employee", async () => {
    const now = new Date("2026-10-02T00:00:00.000Z");
    reminderFindMany.mockResolvedValue([
      {
        itemLabel: "לשלוח סיכום שינויי קוד לטל",
        messageText: "brief",
        lastComposedText: "היי טל, סיכום…",
        pingIds: ["tal-id"],
        sentAt: new Date("2026-10-01T22:00:00.000Z"),
      },
      {
        itemLabel: "לשלוח ברכה",
        messageText: "older",
        lastComposedText: "בוקר טוב ישן",
        pingIds: ["tal-id"],
        sentAt: new Date("2026-10-01T09:00:00.000Z"),
      },
      {
        itemLabel: "לשלוח לעמית",
        messageText: "other",
        lastComposedText: "היי עמית",
        pingIds: ["amit-id"],
        sentAt: new Date("2026-10-01T21:00:00.000Z"),
      },
    ]);

    const rows = await listRecentReminderOutbounds({
      userId: "user-1",
      employeeId: "tal-id",
      now,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.item).toContain("סיכום");
    expect(rows[0]?.text).toBe("היי טל, סיכום…");
    expect(rows[0]?.sent_at).toBeTruthy();
  });

  it("falls back to messageText when lastComposedText is empty", async () => {
    reminderFindMany.mockResolvedValue([
      {
        itemLabel: "לשלוח הודעה",
        messageText: "בוקר טוב",
        lastComposedText: "",
        pingIds: ["tal-id"],
        sentAt: new Date("2026-10-01T22:00:00.000Z"),
      },
    ]);

    const rows = await listRecentReminderOutbounds({
      userId: "user-1",
      employeeId: "tal-id",
      now: new Date("2026-10-02T00:00:00.000Z"),
    });
    expect(rows[0]?.text).toBe("בוקר טוב");
  });
});

describe("formatRecentOutboundContext", () => {
  it("returns empty when there are no rows", () => {
    expect(formatRecentOutboundContext([])).toBe("");
  });

  it("formats a RECENT_OUTBOUND facts block", () => {
    const text = formatRecentOutboundContext([
      {
        sent_at: "2026-10-01 22:00",
        item: "לשלוח סיכום",
        text: "היי טל, סיכום…",
      },
    ]);
    expect(text).toContain("RECENT_OUTBOUND:");
    expect(text).toContain("Do NOT resend");
    expect(text).toContain("היי טל, סיכום…");
  });
});
