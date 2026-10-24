/**
 * Non-destructive sendChatMessage E2E for MOT GTFS schedule + nearest_stop.
 * Uses the already-active day-slice generation on workee_test — never wipes
 * or replaces GtfsFeedGeneration / mini fixture.
 *
 * Run: npm run test:eval-db -w backend -- tests/gtfs-schedule-sendchat-e2e.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLlmReply, readSpokenBubbles } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import {
  assertApprovedEvalDatabaseUrl,
  evalDatabaseNameFromUrl,
} from "../src/eval/studio-db-guard.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { getActiveGenerationId } from "../src/services/gtfs-query.js";
import {
  resetPendingLocations,
  setPendingLocation,
} from "../src/services/pending-location.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";

/** Active MOT day-slice from one-day nationwide ingest (must stay put). */
const EXPECTED_GENERATION_ID = "a629a522-f283-4fe3-9420-b438366a4b46";
const SERVICE_DATE = "2026-10-24";
/** Near שער שכם / מסוף סולטאן סולימאן area (Jerusalem). */
const SHAAR_SHECHEM = { lat: 31.784232, lng: 35.228601 };

function stubReply(payload: unknown) {
  return {
    async createConversation() {
      return `conv-${randomUUID()}`;
    },
    async createResponse() {
      return { reply: JSON.stringify(payload), raw: {} };
    },
  };
}

async function ensureLucy(account: HarnessAccount): Promise<string> {
  const existing = await prisma.employee.findFirst({
    where: { userId: account.userId, kind: "digital" },
  });
  if (existing) return existing.id;
  const lucy = await prisma.employee.create({
    data: {
      userId: account.userId,
      kind: "digital",
      isProtected: true,
      name: "לוסי",
      surname: "",
      nickname: "לוסי",
      model: "gpt-4.1-mini",
      temperature: 0,
      instructions: "You answer transit questions in Hebrew.",
    },
  });
  return lucy.id;
}

async function cleanupAccount(account: HarnessAccount) {
  await prisma.tipProgress
    .deleteMany({ where: { tip: { userId: account.userId } } })
    .catch(() => undefined);
  await prisma.tip
    .deleteMany({ where: { userId: account.userId } })
    .catch(() => undefined);
  await prisma.chatMessage
    .deleteMany({ where: { conversation: { userId: account.userId } } })
    .catch(() => undefined);
  await prisma.chatConversation
    .deleteMany({ where: { userId: account.userId } })
    .catch(() => undefined);
  await destroyHarnessAccount(account);
}

async function assertExpectedGenerationActive(): Promise<string> {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  const activeId = await getActiveGenerationId(prisma);
  expect(
    activeId,
    `expected active GTFS generation ${EXPECTED_GENERATION_ID}`,
  ).toBe(EXPECTED_GENERATION_ID);
  const row = await prisma.gtfsFeedGeneration.findUnique({
    where: { id: EXPECTED_GENERATION_ID },
    select: { status: true, feedStartDate: true, feedEndDate: true },
  });
  expect(row?.status).toBe("active");
  expect(row?.feedStartDate).toBe("20261024");
  expect(row?.feedEndDate).toBe("20261024");
  return activeId!;
}

describe("sendChatMessage GTFS schedule/nearest_stop E2E (eval-db, non-destructive)", () => {
  let account: HarnessAccount | null = null;
  let whatsappTextSpy: ReturnType<typeof vi.spyOn> | null = null;
  let fireDueSpy: ReturnType<typeof vi.spyOn> | null = null;
  let scheduleSoonSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeAll(async () => {
    assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
    expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
    expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
    expect(process.env.WORKEE_DISABLE_REMINDER_FIRE).toBe("1");

    const dbUrl = process.env.DATABASE_URL!;
    const u = new URL(dbUrl);
    expect(u.hostname).toBe("127.0.0.1");
    expect(u.port).toBe("5436");
    expect(evalDatabaseNameFromUrl(dbUrl)).toBe("workee_test");

    process.env.GTFS_ENABLED = "1";
    await assertExpectedGenerationActive();
  });

  beforeEach(async () => {
    assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
    process.env.GTFS_ENABLED = "1";
    // Fail closed: never proceed if the day-slice was replaced or retired.
    await assertExpectedGenerationActive();
    // Block accidental Google / SIRI / Places network use in this suite.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        throw new Error(`Unexpected fetch in GTFS schedule E2E: ${url}`);
      }),
    );
  });

  afterEach(async () => {
    setLlmClientForTests(null);
    resetPendingLocations();
    vi.unstubAllGlobals();
    whatsappTextSpy?.mockRestore();
    whatsappTextSpy = null;
    fireDueSpy?.mockRestore();
    fireDueSpy = null;
    scheduleSoonSpy?.mockRestore();
    scheduleSoonSpy = null;
    if (account) {
      await cleanupAccount(account);
      account = null;
    }
  });

  function installOutboundGuards() {
    whatsappTextSpy = vi.spyOn(whatsappSend, "sendWhatsAppText");
    fireDueSpy = vi.spyOn(reminderFire, "fireDueReminders");
    scheduleSoonSpy = vi.spyOn(reminderFire, "scheduleSoon");
  }

  function assertNoOutbound() {
    expect(whatsappTextSpy).not.toHaveBeenCalled();
    expect(fireDueSpy).not.toHaveBeenCalled();
    expect(scheduleSoonSpy).not.toHaveBeenCalled();
  }

  it("schedule: stop 253 / line 201 / agency 49 / direction 1 → Hebrew departures", async () => {
    const before = await assertExpectedGenerationActive();
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    installOutboundGuards();

    setLlmClientForTests(
      stubReply({
        responses: [{ text: "בודקת את הלוח הרשמי.", buttons: [] }],
        metadata: {
          routes: {
            stop_code: "253",
            line: "201",
            agency: "49",
            headsign: "1",
            service_date: SERVICE_DATE,
            departure: "08:00",
            window_end: "10:00",
            aspects: ["schedule"],
          },
        },
      }),
    );

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "מה הלוח הרשמי לתחנה 253 קו 201 מפעיל 49 כיוון 1?",
    });

    assertNoOutbound();
    expect(await assertExpectedGenerationActive()).toBe(before);

    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/יציאות מתוזמנות/);
    expect(spoken).toMatch(/08:07/);
    expect(spoken).toMatch(/253/);
    expect(spoken).toMatch(/קו 201/);
    expect(spoken).toMatch(/עיסאוויה/);
    expect(spoken).toMatch(/משרד התחבורה|לא זמן אמת/);
    expect(spoken).not.toMatch(/הגעות חזויות \(זמן אמת\)/);
    expect(spoken).not.toMatch(/גוגל/);

    const bubbles = readSpokenBubbles(
      JSON.parse(result.reply) as Record<string, unknown>,
    );
    expect(bubbles?.length ?? 0).toBeGreaterThan(0);
  });

  it("schedule: stop 6054 / line 275 / agency ירושלים-רמאללה → Hebrew departures", async () => {
    const before = await assertExpectedGenerationActive();
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    installOutboundGuards();

    setLlmClientForTests(
      stubReply({
        responses: [{ text: "", buttons: [] }],
        metadata: {
          routes: {
            stop_code: "6054",
            line: "275",
            agency: "ירושלים-רמאללה",
            service_date: SERVICE_DATE,
            departure: "08:00",
            window_end: "10:00",
            aspects: ["schedule"],
          },
        },
      }),
    );

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "לוח רשמי תחנה 6054 קו 275 ירושלים-רמאללה",
    });

    assertNoOutbound();
    expect(await assertExpectedGenerationActive()).toBe(before);

    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/יציאות מתוזמנות/);
    expect(spoken).toMatch(/08:00/);
    expect(spoken).toMatch(/6054/);
    expect(spoken).toMatch(/קו 275/);
    expect(spoken).toMatch(/סולימאן|מרכזית/);
    expect(spoken).toMatch(/משרד התחבורה|לא זמן אמת/);
  });

  it("nearest_stop: line 201 near שער שכם via origin speaker + pin", async () => {
    const before = await assertExpectedGenerationActive();
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    installOutboundGuards();

    setPendingLocation(account.employeeId, {
      lat: SHAAR_SHECHEM.lat,
      lng: SHAAR_SHECHEM.lng,
      name: "שער שכם",
      address: "שער שכם, ירושלים",
    });

    setLlmClientForTests(
      stubReply({
        responses: [{ text: "מחפשת תחנה קרובה.", buttons: [] }],
        metadata: {
          routes: {
            origin: "speaker",
            line: "201",
            agency: "49",
            headsign: "1",
            service_date: SERVICE_DATE,
            aspects: ["nearest_stop"],
          },
        },
      }),
    );

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "איפה התחנה הקרובה לקו 201 ליד שער שכם?",
    });

    assertNoOutbound();
    expect(await assertExpectedGenerationActive()).toBe(before);

    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/התחנות הקרובות/);
    expect(spoken).toMatch(/קו 201/);
    expect(spoken).toMatch(/מ׳/);
    expect(spoken).toMatch(/4136|253|255/);
    expect(spoken).toMatch(/משרד התחבורה|מתוזמן/);
  });

  it("schedule: line 201 without agency → ask which operator (no silent pick)", async () => {
    const before = await assertExpectedGenerationActive();
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    installOutboundGuards();

    setLlmClientForTests(
      stubReply({
        responses: [{ text: "", buttons: [] }],
        metadata: {
          routes: {
            stop_code: "253",
            line: "201",
            service_date: SERVICE_DATE,
            departure: "08:00",
            window_end: "10:00",
            aspects: ["schedule"],
          },
        },
      }),
    );

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "מה הלוח הרשמי לתחנה 253 קו 201?",
    });

    assertNoOutbound();
    expect(await assertExpectedGenerationActive()).toBe(before);

    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/מפעיל/);
    expect(spoken).toMatch(/אגד/);
    expect(spoken).toMatch(/קווים/);
    expect(spoken).toMatch(/עיסאוויה/);
    expect(spoken).not.toMatch(/יציאות מתוזמנות/);
  });
});
