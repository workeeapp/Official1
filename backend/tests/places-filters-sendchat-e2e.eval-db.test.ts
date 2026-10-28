/**
 * Real Google Places filter E2E (eval-db, non-destructive).
 * open_now + min_rating via fetchPlacesFacts + stubbed-LLM sendChatMessage.
 * Real HTTP to places.googleapis.com — never mocks fetch for Places.
 * Does not wipe GTFS or reload fixtures.
 *
 * Run: npm run test:eval-db -w backend -- tests/places-filters-sendchat-e2e.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLlmReply, placesMinRatingProviderFloor } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { resetEnvCache } from "../src/config/env.js";
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
import { fetchPlacesFacts } from "../src/services/places.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";

/** Keep the validated MOT day-slice put (this suite must not touch GTFS). */
const EXPECTED_GENERATION_ID = "22cebd10-1204-47ee-8a7e-80508fbe3e73";
const QUERY = "בית קפה";
const PLACE = "תל אביב";
const MIN_RATING_EXACT = 4.1;

type PlacesProbe = {
  host: string;
  path: string;
  request: {
    openNow: boolean | null;
    minRating: number | null;
    textQuery: string | null;
  };
  raw: Array<{
    name: string;
    rating: number | null;
    openNow: boolean | null;
  }>;
};

function readProductPlacesApiKey(): string {
  for (const candidate of [
    resolve(process.cwd(), "../.env"),
    resolve(process.cwd(), ".env"),
  ]) {
    if (!existsSync(candidate)) continue;
    const match = readFileSync(candidate, "utf8").match(
      /^GOOGLE_PLACES_API_KEY\s*=\s*(.+)$/m,
    );
    if (!match?.[1]) continue;
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) return value;
  }
  return "";
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
      instructions: "You answer local business questions in Hebrew.",
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
  expect(activeId).toBe(EXPECTED_GENERATION_ID);
  return activeId!;
}

/**
 * Spy real fetch: record Places request filter fields + raw openness/ratings.
 * Never logs headers (API key).
 */
function installRealPlacesProbe(): {
  probes: PlacesProbe[];
  restore: () => void;
} {
  const probes: PlacesProbe[] = [];
  const realFetch = globalThis.fetch.bind(globalThis);
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let host = "";
    let path = "";
    try {
      const u = new URL(url);
      host = u.host;
      path = u.pathname;
    } catch {
      host = "(unparseable)";
    }
    let request = {
      openNow: null as boolean | null,
      minRating: null as number | null,
      textQuery: null as string | null,
    };
    if (init?.body) {
      try {
        const body = JSON.parse(String(init.body)) as {
          openNow?: boolean;
          minRating?: number;
          textQuery?: string;
        };
        request = {
          openNow: body.openNow === true ? true : null,
          minRating:
            typeof body.minRating === "number" ? body.minRating : null,
          textQuery: typeof body.textQuery === "string" ? body.textQuery : null,
        };
      } catch {
        /* ignore */
      }
    }
    const res = await realFetch(input, init);
    const clone = res.clone();
    let raw: PlacesProbe["raw"] = [];
    try {
      const json = (await clone.json()) as {
        places?: Array<{
          displayName?: { text?: string };
          rating?: number;
          currentOpeningHours?: { openNow?: boolean };
          regularOpeningHours?: { openNow?: boolean };
        }>;
      };
      raw = (Array.isArray(json.places) ? json.places : []).map((p) => ({
        name: String(p.displayName?.text ?? "").slice(0, 80),
        rating: typeof p.rating === "number" ? p.rating : null,
        openNow:
          typeof p.currentOpeningHours?.openNow === "boolean"
            ? p.currentOpeningHours.openNow
            : typeof p.regularOpeningHours?.openNow === "boolean"
              ? p.regularOpeningHours.openNow
              : null,
      }));
    } catch {
      raw = [];
    }
    if (host === "places.googleapis.com") {
      probes.push({ host, path, request, raw });
    }
    return res;
  });
  vi.stubGlobal("fetch", spy);
  return {
    probes,
    restore() {
      vi.unstubAllGlobals();
    },
  };
}

describe("Places filters sendChat E2E (eval-db, real Google HTTP)", () => {
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

    // Eval lock blocks product dotenv; inject Places key without logging it.
    const key = readProductPlacesApiKey();
    expect(
      key.length,
      "GOOGLE_PLACES_API_KEY must be set in repo .env for this real-provider suite",
    ).toBeGreaterThan(0);
    process.env.GOOGLE_PLACES_API_KEY = key;
    resetEnvCache();

    await assertExpectedGenerationActive();
  });

  beforeEach(async () => {
    assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
    await assertExpectedGenerationActive();
  });

  afterEach(async () => {
    setLlmClientForTests(null);
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

  it("open_now: real request openNow=true; returned places open; sendChat preserves filter", async () => {
    const before = await assertExpectedGenerationActive();
    const probe = installRealPlacesProbe();

    const facts = await fetchPlacesFacts({
      query: QUERY,
      place: PLACE,
      aspects: ["summary", "hours"],
      openNow: true,
    });

    const serviceCall = probe.probes[0];
    expect(serviceCall?.host).toBe("places.googleapis.com");
    expect(serviceCall?.path).toContain("/v1/places:searchText");
    expect(serviceCall?.request.openNow).toBe(true);
    expect(facts.openNowFilter).toBe(true);
    expect(facts.results.length).toBeGreaterThan(0);
    expect(facts.results.every((r) => r.openNow === true)).toBe(true);
    expect(serviceCall?.raw.every((r) => r.openNow !== false)).toBe(true);
    expect(serviceCall?.raw.some((r) => r.openNow === true)).toBe(true);

    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    installOutboundGuards();
    setLlmClientForTests(
      stubReply({
        responses: [{ text: "מחפשת פתוח עכשיו.", buttons: [] }],
        metadata: {
          places: {
            query: QUERY,
            place: PLACE,
            open_now: true,
            aspects: ["summary", "hours"],
          },
        },
      }),
    );

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תמצאי בית קפה פתוח עכשיו בתל אביב",
    });

    assertNoOutbound();
    const chatCall = probe.probes[probe.probes.length - 1];
    expect(chatCall?.request.openNow).toBe(true);
    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/סינון:\s*פתוח עכשיו/);
    expect(spoken).toMatch(/פתוח עכשיו/);
    expect(await assertExpectedGenerationActive()).toBe(before);
    probe.restore();
  });

  it("min_rating 4.1: provider minRating=4; finals ≥4.1; sendChat preserves filter", async () => {
    const before = await assertExpectedGenerationActive();
    const expectedFloor = placesMinRatingProviderFloor(MIN_RATING_EXACT);
    expect(expectedFloor).toBe(4);

    const probe = installRealPlacesProbe();
    const facts = await fetchPlacesFacts({
      query: QUERY,
      place: PLACE,
      aspects: ["summary"],
      minRating: MIN_RATING_EXACT,
    });

    const serviceCall = probe.probes[0];
    expect(serviceCall?.host).toBe("places.googleapis.com");
    expect(serviceCall?.request.minRating).toBe(expectedFloor);
    expect(facts.minRating).toBe(MIN_RATING_EXACT);
    expect(facts.minRatingProvider).toBe(expectedFloor);
    expect(facts.results.length).toBeGreaterThan(0);
    expect(
      facts.results.every(
        (r) => r.rating != null && r.rating >= MIN_RATING_EXACT,
      ),
    ).toBe(true);

    // Local exact drop vs provider floor is covered offline; real pages often
    // already sit above 4.1 — do not fail when no 4.0–4.09 samples appear.
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account);
    installOutboundGuards();
    setLlmClientForTests(
      stubReply({
        responses: [{ text: "מחפשת לפי דירוג.", buttons: [] }],
        metadata: {
          places: {
            query: QUERY,
            place: PLACE,
            min_rating: MIN_RATING_EXACT,
            aspects: ["summary"],
          },
        },
      }),
    );

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תמצאי בית קפה בתל אביב עם דירוג לפחות 4.1",
    });

    assertNoOutbound();
    const chatCall = probe.probes[probe.probes.length - 1];
    expect(chatCall?.request.minRating).toBe(expectedFloor);
    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/סינון:\s*דירוג\s*≥\s*4\.1/);
    expect(await assertExpectedGenerationActive()).toBe(before);
    probe.restore();
  });
});
