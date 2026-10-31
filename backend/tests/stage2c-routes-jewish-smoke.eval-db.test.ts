/**
 * Stage 2C sendChat smoke (eval-db): Routes/Jewish via Core with stub LLM.
 * Google/OM mocked — no paid live calls.
 *
 * Run: npm run test:eval-db -w backend -- tests/stage2c-routes-jewish-smoke.eval-db.test.ts
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { resetEnvCache } from "../src/config/env.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import * as geographicResolve from "../src/services/geographic-resolve.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  stubLlmReply,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

describe("Stage 2C Routes/Jewish sendChat smoke (eval-db, mocked providers)", () => {
  let account: HarnessAccount | null = null;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
    process.env.GOOGLE_ROUTES_API_KEY = "eval-dummy-routes-key";
    process.env.GOOGLE_PLACES_API_KEY = "eval-dummy-places-key";
    resetEnvCache();
  });

  beforeEach(async () => {
    await assertEvalDbAndGtfsUntouched();
  });

  afterEach(async () => {
    setLlmClientForTests(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  it("Routes: saved origin with coords uses Core saved path (no Places geocode)", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account, "You answer routes.");
    await prisma.employeeFiling.create({
      data: {
        employeeId: account.employeeId,
        itemName: "בית",
        itemInfo: "32.099279, 34.8923104",
        itemDescription: "smoke",
        scope: "personal",
        visibleTo: [],
      },
    });
    const core = vi.spyOn(geographicResolve, "resolveGeographic");
    vi.spyOn(whatsappSend, "sendWhatsAppText");
    vi.spyOn(reminderFire, "fireDueReminders");
    vi.spyOn(reminderFire, "scheduleSoon");

    const placesQueries: string[] = [];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("routes.googleapis.com")) {
        return new Response(
          JSON.stringify({
            routes: [
              {
                duration: "600s",
                distanceMeters: 3000,
                legs: [{ duration: "600s", distanceMeters: 3000, steps: [] }],
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("places.googleapis.com")) {
        const body = String(init?.body ?? "");
        placesQueries.push(body);
        // Destination geocode only — saved origin must not appear as textQuery.
        expect(body).not.toMatch(/"textQuery":"בית"/);
        return new Response(
          JSON.stringify({
            places: [
              {
                displayName: { text: "דיזנגוף סנטר" },
                location: { latitude: 32.075, longitude: 34.775 },
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: {
          routes: {
            origin: "בית",
            destination: "דיזנגוף סנטר",
            mode: "drive",
            aspects: ["summary"],
          },
        },
      }),
    );

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "איך להגיע מהבית לדיזנגוף סנטר ברכב?",
    });
    const spoken = parseLlmReply(result.reply).response;
    expect(core).toHaveBeenCalled();
    expect(
      core.mock.calls.some(
        (c) => (c[0] as { ask?: { rawText?: string } }).ask?.rawText === "בית",
      ),
    ).toBe(true);
    expect(placesQueries.length).toBeGreaterThan(0);
    expect(spoken).toMatch(/בית|מסלול|דק|בודקת/);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  }, 30_000);

  it("Jewish: saved place with coords via Core (Hebcal mocked)", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account, "You answer jewish.");
    await prisma.employeeFiling.create({
      data: {
        employeeId: account.employeeId,
        itemName: "בית",
        itemInfo: "32.08, 34.78",
        itemDescription: "",
        scope: "personal",
        visibleTo: [],
      },
    });
    const core = vi.spyOn(geographicResolve, "resolveGeographic");
    vi.spyOn(whatsappSend, "sendWhatsAppText");
    vi.spyOn(reminderFire, "fireDueReminders");
    vi.spyOn(reminderFire, "scheduleSoon");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("www.hebcal.com")) {
          return new Response(
            JSON.stringify({
              location: { title: "בית" },
              items: [
                {
                  category: "candles",
                  title: "Candle lighting",
                  date: "2026-10-30T17:00:00+03:00",
                },
              ],
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: {
          jewish: {
            place: "בית",
            date: "",
            aspects: ["candles"],
          },
        },
      }),
    );

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "מתי מדליקים נרות בבית?",
    });
    const spoken = parseLlmReply(result.reply).response;
    expect(core).toHaveBeenCalled();
    expect(spoken).toMatch(/נר|17:00|בית|בודקת/);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  }, 30_000);
});
