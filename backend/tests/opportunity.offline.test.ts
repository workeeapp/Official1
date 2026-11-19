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

const { findMany, create } = vi.hoisted(() => ({
  findMany: vi.fn(),
  create: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    auditEvent: { findMany, create },
  },
}));

import {
  capabilitiesFromTurn,
  settleMemberOpportunity,
} from "../src/services/opportunity.service.js";

const userId = "11111111-1111-4111-8111-111111111111";
const speakerId = "22222222-2222-4222-8222-222222222222";
const digitalId = "33333333-3333-4333-8333-333333333333";

function resetAudit(): void {
  rows.length = 0;
  findMany.mockImplementation(async (args: { where?: { action?: { in?: string[] } } }) => {
    const actions = args.where?.action?.in;
    return rows.filter((row) => !actions || actions.includes(row.action));
  });
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
  applied: new Set<"lists" | "reminders" | "filing" | "share">(),
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
      },
    });
    expect(parsed.opportunity).toEqual({
      capability: "reminders",
      preview: "כך זה יכול להיראות.",
    });
    expect(
      parseLlmMetadata({ opportunity: { capability: "poker", preview: "x" } })
        .opportunity,
    ).toBeUndefined();
  });

  it("keeps a Member preview and records the offer", async () => {
    resetAudit();
    const result = await settleMemberOpportunity({
      ...base,
      opportunity: { capability: "reminders", preview: "תצוגה בלבד" },
    });
    expect(result.preview).toBe("תצוגה בלבד");
    expect(result.offerId).toBeTruthy();
    expect(rows.filter((row) => row.action === "opportunity_offer")).toHaveLength(1);
  });

  it("stays silent for a Prospect and does not record an offer", async () => {
    resetAudit();
    const result = await settleMemberOpportunity({
      ...base,
      member: false,
      opportunity: { capability: "lists", preview: "לא אמור להופיע" },
    });
    expect(result).toEqual({ preview: null, offerId: null });
    expect(rows).toHaveLength(0);
  });

  it("drops the preview when the tip slot is taken and records slot", async () => {
    resetAudit();
    const result = await settleMemberOpportunity({
      ...base,
      slotTaken: true,
      opportunity: { capability: "filing", preview: "לא להציג" },
    });
    expect(result.preview).toBeNull();
    expect(rows[0]?.action).toBe("opportunity_suppress");
    expect(rows[0]?.detail).toMatchObject({ reason: "slot", capability: "filing" });
  });

  it("suppresses a second offer of the same capability inside the cooldown", async () => {
    resetAudit();
    await settleMemberOpportunity({
      ...base,
      opportunity: { capability: "lists", preview: "פעם ראשונה" },
    });
    const again = await settleMemberOpportunity({
      ...base,
      opportunity: { capability: "lists", preview: "פעם שנייה" },
    });
    expect(again.preview).toBeNull();
    expect(rows.filter((row) => row.action === "opportunity_suppress")).toEqual([
      expect.objectContaining({
        detail: expect.objectContaining({ reason: "cooldown" }),
      }),
    ]);
  });

  it("counts acceptance only when the apply names that offer", async () => {
    resetAudit();
    const offered = await settleMemberOpportunity({
      ...base,
      opportunity: { capability: "reminders", preview: "תצוגה" },
    });
    const independent = await settleMemberOpportunity({
      ...base,
      applied: new Set(["reminders"]),
      opportunity: null,
    });
    expect(independent.offerId).toBeNull();
    expect(rows.some((row) => row.action === "opportunity_accept")).toBe(false);

    const unnamed = await settleMemberOpportunity({
      ...base,
      applied: new Set(["reminders"]),
      opportunity: { capability: "reminders", preview: "עוד אחת" },
    });
    expect(unnamed.preview).toBeNull();

    const accepted = await settleMemberOpportunity({
      ...base,
      applied: new Set(["reminders"]),
      opportunity: { accept: offered.offerId! },
    });
    expect(accepted.preview).toBeNull();
    expect(rows.filter((row) => row.action === "opportunity_accept")).toHaveLength(1);
    expect(rows.find((row) => row.action === "opportunity_accept")?.entityId).toBe(
      offered.offerId,
    );
  });

  it("does not accept an offer when that capability was not applied", async () => {
    resetAudit();
    const offered = await settleMemberOpportunity({
      ...base,
      opportunity: { capability: "filing", preview: "תצוגה" },
    });
    await settleMemberOpportunity({
      ...base,
      applied: new Set(["lists"]),
      opportunity: { accept: offered.offerId! },
    });
    expect(rows.some((row) => row.action === "opportunity_accept")).toBe(false);
  });

  it("treats a targeted list write as share and an untargeted one as lists", () => {
    expect(
      capabilitiesFromTurn({
        tipOps: [],
        listApplied: true,
        listActions: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [],
            targets: ["מיכל"],
          },
        ],
        filingApplied: false,
        remindersApplied: false,
      }).has("share"),
    ).toBe(true);
    expect(
      capabilitiesFromTurn({
        tipOps: [],
        listApplied: true,
        listActions: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [],
            targets: [],
          },
        ],
        filingApplied: false,
        remindersApplied: false,
      }).has("lists"),
    ).toBe(true);
  });
});
