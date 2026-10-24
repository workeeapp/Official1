/**
 * Gate 4A.1/4A.3 — sendChatMessage orchestration E2E for live_arrivals.
 * Stub LLM + mocked SIRI HTTP only. Never hits the real MOT provider.
 *
 * Run: npm run test:eval-db -w backend -- tests/live-arrivals-sendchat-e2e.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLlmReply, readSpokenBubbles } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { ingestParsedFeed } from "../src/services/gtfs-ingest.js";
import { buildMiniGtfsFeed } from "./gtfs-fixture.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";

function loadFreshSiriFixture(now: Date = new Date()): unknown {
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, "fixtures/siri-sm-valid.json"), "utf8"),
  ) as {
    Siri: {
      ServiceDelivery: {
        ResponseTimestamp: string;
        StopMonitoringDelivery: Array<{
          ResponseTimestamp: string;
          MonitoredStopVisit: unknown[];
        }>;
      };
    };
  };
  const ts = now.toISOString();
  raw.Siri.ServiceDelivery.ResponseTimestamp = ts;
  for (const d of raw.Siri.ServiceDelivery.StopMonitoringDelivery) {
    d.ResponseTimestamp = ts;
    for (const v of d.MonitoredStopVisit as Array<{ RecordedAtTime?: string }>) {
      v.RecordedAtTime = ts;
    }
  }
  return raw;
}

/** Multi-operator board: agency 25 + distinctive 18:45 visit from agency 3. */
function loadMultiOperatorSiriFixture(now: Date = new Date()): unknown {
  const body = loadFreshSiriFixture(now) as {
    Siri: {
      ServiceDelivery: {
        StopMonitoringDelivery: Array<{ MonitoredStopVisit: unknown[] }>;
      };
    };
  };
  body.Siri.ServiceDelivery.StopMonitoringDelivery[0]!.MonitoredStopVisit.push({
    RecordedAtTime: now.toISOString(),
    MonitoringRef: "2007",
    MonitoredVehicleJourney: {
      LineRef: "R51B",
      PublishedLineName: "51",
      OperatorRef: "3",
      FramedVehicleJourneyRef: {
        DataFrameRef: "2026-10-24",
        DatedVehicleJourneyRef: "other-op-51",
      },
      VehicleRef: "egged-only",
      MonitoredCall: {
        StopPointRef: "2007",
        ExpectedArrivalTime: "2099-01-01T18:45:00.000+03:00",
        ArrivalStatus: "onTime",
      },
    },
  });
  return body;
}

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

describe("sendChatMessage live_arrivals E2E (eval-db, mocked SIRI)", () => {
  let account: HarnessAccount | null = null;
  let fetchMock: ReturnType<typeof vi.fn> | null = null;
  let whatsappTextSpy: ReturnType<typeof vi.spyOn> | null = null;
  let fireDueSpy: ReturnType<typeof vi.spyOn> | null = null;
  let scheduleSoonSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeAll(() => {
    assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
    expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
    expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
    expect(process.env.WORKEE_DISABLE_REMINDER_FIRE).toBe("1");
  });

  beforeEach(async () => {
    assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
    process.env.GTFS_ENABLED = "1";
    process.env.SIRI_ENABLED = "1";
    process.env.SIRI_SM_BASE_URL = "https://example.test/siri";
    process.env.SIRI_SM_KEY = "TESTKEY-OFFLINE";
    await prisma.gtfsFeedGeneration.deleteMany({});
    await ingestParsedFeed(prisma, buildMiniGtfsFeed(), {
      sourceLabel: "live-arrivals-e2e-mini",
    });
  });

  afterEach(async () => {
    setLlmClientForTests(null);
    vi.unstubAllGlobals();
    fetchMock = null;
    whatsappTextSpy?.mockRestore();
    whatsappTextSpy = null;
    fireDueSpy?.mockRestore();
    fireDueSpy = null;
    scheduleSoonSpy?.mockRestore();
    scheduleSoonSpy = null;
    delete process.env.SIRI_ENABLED;
    delete process.env.SIRI_SM_BASE_URL;
    delete process.env.SIRI_SM_KEY;
    if (account) {
      await cleanupAccount(account);
      account = null;
    }
  });

  it("parses live_arrivals ACTION, filters Hebrew agency→OperatorRef, asserts final reply", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);

    const body = loadMultiOperatorSiriFixture(new Date());
    fetchMock = vi.fn(async (url: string) => {
      const href = String(url);
      if (
        !href.includes("example.test/siri") &&
        !href.includes("MonitoringRef=")
      ) {
        throw new Error(`Unexpected fetch in live_arrivals E2E: ${href}`);
      }
      expect(href).not.toContain(encodeURIComponent("אלקטרה"));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    whatsappTextSpy = vi.spyOn(whatsappSend, "sendWhatsAppText");
    fireDueSpy = vi.spyOn(reminderFire, "fireDueReminders");
    scheduleSoonSpy = vi.spyOn(reminderFire, "scheduleSoon");

    const payload = {
      responses: [{ text: "בודקת תחזית חיה לתחנה.", buttons: [] }],
      metadata: {
        routes: {
          stop_code: "2007",
          line: "51",
          agency: "אלקטרה",
          headsign: "1",
          aspects: ["live_arrivals"],
        },
      },
    };
    setLlmClientForTests(stubReply(payload));

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "מתי האוטובוס מגיע לתחנה 2007 קו 51 אלקטרה?",
    });

    expect(fetchMock).toHaveBeenCalled();
    const calledUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(calledUrl).toContain("MonitoringRef=2007");
    expect(calledUrl).toContain("Key=TESTKEY-OFFLINE");
    expect(calledUrl).not.toMatch(/mot\.gov|bus\.gov|siri\.mot/);
    expect(calledUrl).not.toMatch(/OperatorRef=אלקטרה|אלקטרה/);

    expect(whatsappTextSpy).not.toHaveBeenCalled();
    expect(fireDueSpy).not.toHaveBeenCalled();
    expect(scheduleSoonSpy).not.toHaveBeenCalled();

    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/הגעות חזויות \(זמן אמת\)/);
    expect(spoken).toMatch(/SIRI|משרד התחבורה/);
    expect(spoken).toMatch(/קו 51/);
    // OperatorRef=3 distinctive arrival must be excluded after Hebrew→25.
    expect(spoken).not.toMatch(/18:45/);
    expect(spoken).not.toMatch(/מתוזמנ/);
    expect(spoken).not.toMatch(/גוגל/);

    const bubbles = readSpokenBubbles(
      JSON.parse(result.reply) as Record<string, unknown>,
    );
    expect(bubbles?.length ?? 0).toBeGreaterThan(0);
  });

  it("truthful schedule fallback when SIRI response has no freshness timestamp", async () => {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);

    const body = loadFreshSiriFixture(new Date()) as {
      Siri: {
        ServiceDelivery: {
          ResponseTimestamp?: string;
          StopMonitoringDelivery: Array<{ ResponseTimestamp?: string }>;
        };
      };
    };
    delete body.Siri.ServiceDelivery.ResponseTimestamp;
    for (const d of body.Siri.ServiceDelivery.StopMonitoringDelivery) {
      delete d.ResponseTimestamp;
    }

    fetchMock = vi.fn(async (url: string) => {
      const href = String(url);
      if (!href.includes("example.test/siri")) {
        throw new Error(`Unexpected fetch: ${href}`);
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    fireDueSpy = vi.spyOn(reminderFire, "fireDueReminders");
    scheduleSoonSpy = vi.spyOn(reminderFire, "scheduleSoon");

    setLlmClientForTests(
      stubReply({
        responses: [{ text: "", buttons: [] }],
        metadata: {
          routes: {
            stop_code: "2007",
            line: "1",
            agency: "אלקטרה",
            service_date: "2026-10-24",
            departure: "09:00",
            window_end: "11:00",
            aspects: ["live_arrivals"],
          },
        },
      }),
    );

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תחזית חיה לתחנה 2007",
    });

    expect(fireDueSpy).not.toHaveBeenCalled();
    expect(scheduleSoonSpy).not.toHaveBeenCalled();

    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).not.toMatch(/הגעות חזויות \(זמן אמת\)/);
    expect(spoken).toMatch(/לא ניתן לאמת|מתוזמנ/);
  });
});
