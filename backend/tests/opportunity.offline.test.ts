import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLlmMetadata } from "@workee/shared";

type AuditRow = {
  action: string;
  entityId: string | null;
  actorEmployeeId: string | null;
  userId: string;
  summary: string;
  detail: unknown;
  createdAt: Date;
};

const rows: AuditRow[] = [];

const { findFirst, create } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    auditEvent: { findFirst, create },
  },
}));

import {
  persistedRowsFromApply,
  presentOpportunityReply,
  settleMemberOpportunity,
  subjectConfirmed,
} from "../src/services/opportunity.service.js";

const userId = "11111111-1111-4111-8111-111111111111";
const speakerId = "22222222-2222-4222-8222-222222222222";
const digitalId = "33333333-3333-4333-8333-333333333333";
const itemId = "44444444-4444-4444-8444-444444444444";

function resetAudit(): void {
  rows.length = 0;
  findFirst.mockImplementation(
    async (args: {
      where?: {
        action?: string;
        summary?: string;
        entityId?: string;
        createdAt?: { gte?: Date };
      };
      orderBy?: { createdAt?: "asc" | "desc" };
    }) => {
      const where = args.where ?? {};
      let list = rows.filter((row) => {
        if (where.action && row.action !== where.action) return false;
        if (where.summary && row.summary !== where.summary) return false;
        if (where.entityId && row.entityId !== where.entityId) return false;
        if (where.createdAt?.gte && row.createdAt < where.createdAt.gte) return false;
        return true;
      });
      list = [...list].sort((a, b) =>
        args.orderBy?.createdAt === "asc"
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : b.createdAt.getTime() - a.createdAt.getTime(),
      );
      return list[0] ?? null;
    },
  );
  create.mockImplementation(async ({ data }: { data: AuditRow }) => {
    rows.push({ ...data, createdAt: data.createdAt ?? new Date() });
    return data;
  });
}

const base = {
  userId,
  speakerId,
  digitalEmployeeId: digitalId,
  member: true,
  slotTaken: false,
  applied: [] as ReturnType<typeof persistedRowsFromApply>,
};

describe("opportunity gate", () => {
  afterEach(() => {
    resetAudit();
  });

  it("parses a preview and ignores an unknown capability", () => {
    const parsed = parseLlmMetadata({
      opportunity: {
        capability: "reminders",
        preview: "כך זה יכול להיראות.",
        subject: "להתקשר לרופא",
      },
    });
    expect(parsed.opportunity).toEqual({
      capability: "reminders",
      preview: "כך זה יכול להיראות.",
      subject: "להתקשר לרופא",
    });
    expect(
      parseLlmMetadata({ opportunity: { capability: "poker", preview: "x" } })
        .opportunity,
    ).toBeUndefined();
  });

  it("keeps a Member preview only after the offer row is stored", async () => {
    resetAudit();
    const result = await settleMemberOpportunity({
      ...base,
      opportunity: {
        capability: "reminders",
        preview: "תצוגה בלבד",
        subject: "להתקשר לרופא",
      },
    });
    expect(result.showPreview).toBe("תצוגה בלבד");
    expect(result.hidePreview).toBeNull();
    expect(result.offerId).toBeTruthy();
    expect(rows.filter((row) => row.action === "opportunity_offer")).toHaveLength(1);
  });

  it("hides the preview when the offer row cannot be stored", async () => {
    resetAudit();
    create.mockRejectedValueOnce(new Error("db down"));
    const result = await settleMemberOpportunity({
      ...base,
      opportunity: { capability: "lists", preview: "לא לשמור", subject: "חלב" },
    });
    expect(result.showPreview).toBeNull();
    expect(result.hidePreview).toBe("לא לשמור");
    expect(result.offerId).toBeNull();
  });

  it("stays silent for a Prospect and does not record an offer", async () => {
    resetAudit();
    const result = await settleMemberOpportunity({
      ...base,
      member: false,
      opportunity: { capability: "lists", preview: "לא אמור להופיע" },
    });
    expect(result.showPreview).toBeNull();
    expect(result.hidePreview).toBe("לא אמור להופיע");
    expect(rows).toHaveLength(0);
  });

  it("drops the structured preview when the tip slot is taken", async () => {
    resetAudit();
    const result = await settleMemberOpportunity({
      ...base,
      slotTaken: true,
      opportunity: { capability: "filing", preview: "לא להציג", subject: "שער" },
    });
    expect(result.showPreview).toBeNull();
    expect(result.hidePreview).toBe("לא להציג");
    expect(rows[0]?.action).toBe("opportunity_suppress");
    expect(rows[0]?.detail).toMatchObject({ reason: "slot", capability: "filing" });
  });

  it("removes an exact copy from responses and leaves a paraphrase", () => {
    const preview = "אפשר לשים תזכורת מחר ב־9 להתקשר לרופא.";
    const paraphrase = "אם בא לך, אוכל להזכיר לך מחר בבוקר.";
    const reply = JSON.stringify({
      responses: ["אין לי מה להוסיף.", preview, paraphrase],
      metadata: {},
    });
    const hidden = presentOpportunityReply(reply, { hide: preview, show: null });
    expect(hidden).not.toContain(preview);
    expect(hidden).toContain(paraphrase);
    expect(hidden).toContain("אין לי מה להוסיף.");

    const kept = presentOpportunityReply(reply, { hide: null, show: preview });
    expect(kept.match(new RegExp(preview.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
  });

  it("suppresses a second offer of the same capability inside the cooldown", async () => {
    resetAudit();
    await settleMemberOpportunity({
      ...base,
      opportunity: { capability: "lists", preview: "פעם ראשונה", subject: "חלב" },
    });
    const again = await settleMemberOpportunity({
      ...base,
      opportunity: { capability: "lists", preview: "פעם שנייה", subject: "לחם" },
    });
    expect(again.showPreview).toBeNull();
    expect(again.hidePreview).toBe("פעם שנייה");
    expect(rows.filter((row) => row.action === "opportunity_suppress")[0]?.detail).toMatchObject({
      reason: "cooldown",
    });
  });

  it("keeps the newest offer when older rows would have filled a 50-row page", async () => {
    resetAudit();
    const oldest = new Date("2026-11-19T00:00:00.000Z");
    for (let i = 0; i < 60; i += 1) {
      rows.push({
        action: "opportunity_offer",
        entityId: `55555555-5555-4555-8555-${String(i).padStart(12, "0")}`,
        actorEmployeeId: speakerId,
        userId,
        summary: "lists",
        detail: { capability: "lists", subject: `ישן ${i}` },
        createdAt: new Date(oldest.getTime() + i * 1000),
      });
    }
    const newestId = "66666666-6666-4666-8666-666666666666";
    rows.push({
      action: "opportunity_offer",
      entityId: newestId,
      actorEmployeeId: speakerId,
      userId,
      summary: "reminders",
      detail: { capability: "reminders", subject: "להתקשר לרופא" },
      createdAt: new Date("2026-11-19T12:00:00.000Z"),
    });
    const { formatRecentOffersForSpeaker } = await import(
      "../src/services/opportunity.service.js"
    );
    const block = await formatRecentOffersForSpeaker({
      userId,
      speakerId,
      now: new Date("2026-11-19T12:30:00.000Z"),
    });
    expect(block).toContain(newestId);
    expect(block).toContain("capability: reminders");
    expect(block).not.toContain("55555555-5555-4555-8555-000000000000");
  });

  it("counts acceptance only when the saved row confirms the subject", async () => {
    resetAudit();
    const offered = await settleMemberOpportunity({
      ...base,
      opportunity: {
        capability: "reminders",
        preview: "תצוגה",
        subject: "להתקשר לרופא",
      },
    });
    const unrelated = await settleMemberOpportunity({
      ...base,
      applied: persistedRowsFromApply({
        lists: [],
        filings: [],
        reminders: [{ id: itemId, title: "לקנות חלב", created: true }],
      }),
      opportunity: { accept: offered.offerId! },
    });
    expect(unrelated.showPreview).toBeNull();
    expect(rows.some((row) => row.action === "opportunity_accept")).toBe(false);

    const accepted = await settleMemberOpportunity({
      ...base,
      applied: persistedRowsFromApply({
        lists: [],
        filings: [],
        reminders: [{ id: itemId, title: "להתקשר לרופא", created: true }],
      }),
      opportunity: { accept: offered.offerId! },
    });
    expect(accepted.offerId).toBeNull();
    expect(rows.filter((row) => row.action === "opportunity_accept")).toHaveLength(1);
    expect(rows.find((row) => row.action === "opportunity_accept")?.entityId).toBe(
      offered.offerId,
    );
  });

  it("matches an existing item by the saved id and fails closed without one saved row", () => {
    const rowsForId = persistedRowsFromApply({
      lists: [
        {
          action: "update",
          itemId,
          itemLabel: "חלב",
          shareOutcome: { newlySharedCount: 1 },
        },
      ],
      filings: [],
      reminders: [],
    });
    expect(subjectConfirmed(itemId, "share", rowsForId)).toBe(true);
    expect(subjectConfirmed(itemId, "lists", rowsForId)).toBe(true);
    expect(
      subjectConfirmed("חלב", "lists", [
        {
          capability: "lists",
          id: itemId,
          title: "חלב",
          created: true,
        },
        {
          capability: "lists",
          id: "77777777-7777-4777-8777-777777777777",
          title: "חלב",
          created: true,
        },
      ]),
    ).toBe(false);
    expect(subjectConfirmed("", "reminders", rowsForId)).toBe(false);
    expect(
      subjectConfirmed(itemId, "share", [
        {
          capability: "lists",
          id: itemId,
          title: "חלב",
          created: false,
        },
      ]),
    ).toBe(false);
  });
});
