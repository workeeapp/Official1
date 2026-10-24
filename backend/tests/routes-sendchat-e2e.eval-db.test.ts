/**
 * Real Google Routes TRANSIT E2E (eval-db, non-destructive).
 * resolveRoutesReply + stubbed-LLM sendChatMessage; real HTTP.
 * Uses GOOGLE_ROUTES_API_KEY or GOOGLE_PLACES_API_KEY fallback from product .env.
 *
 * Run: npm run test:eval-db -w backend -- tests/routes-sendchat-e2e.eval-db.test.ts
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { resolveRoutesReply } from "../src/services/routes.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  injectProductEnvKey,
  installRealFetchHostProbe,
  stubLlmReply,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

const ORIGIN = "תחנה מרכזית פתח תקווה";
const DESTINATION = "תחנה מרכזית תל אביב";

describe("Routes sendChat E2E (eval-db, real Google Routes)", () => {
  let account: HarnessAccount | null = null;
  let whatsappTextSpy: ReturnType<typeof vi.spyOn> | null = null;
  let fireDueSpy: ReturnType<typeof vi.spyOn> | null = null;
  let scheduleSoonSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
    const routes = injectProductEnvKey("GOOGLE_ROUTES_API_KEY");
    const places = injectProductEnvKey("GOOGLE_PLACES_API_KEY");
    expect(
      routes.present || places.present,
      "GOOGLE_ROUTES_API_KEY or GOOGLE_PLACES_API_KEY required in repo .env",
    ).toBe(true);
  });

  beforeEach(async () => {
    await assertEvalDbAndGtfsUntouched();
    injectProductEnvKey("GOOGLE_ROUTES_API_KEY");
    injectProductEnvKey("GOOGLE_PLACES_API_KEY");
  });

  afterEach(async () => {
    setLlmClientForTests(null);
    vi.unstubAllGlobals();
    whatsappTextSpy?.mockRestore();
    fireDueSpy?.mockRestore();
    scheduleSoonSpy?.mockRestore();
    whatsappTextSpy = null;
    fireDueSpy = null;
    scheduleSoonSpy = null;
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  it("resolver + sendChat: Petah Tikva → Tel Aviv transit via real Google", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const probe = installRealFetchHostProbe([
      "routes.googleapis.com",
      "places.googleapis.com",
    ]);

    const { text: serviceText } = await resolveRoutesReply({
      origin: ORIGIN,
      destination: DESTINATION,
      aspects: ["summary"],
    });

    expect(
      probe.probes.some(
        (p) =>
          p.host === "routes.googleapis.com" ||
          p.host === "places.googleapis.com",
      ),
    ).toBe(true);
    expect(serviceText).not.toMatch(/לא מוגדר|לא מופעלים|חסר מפתח/);
    expect(serviceText).toMatch(/מסלול|אפשרויות|דקות|תחבורה/);
    expect(serviceText.length).toBeGreaterThan(30);

    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account, "You answer transit routes in Hebrew.");
    whatsappTextSpy = vi.spyOn(whatsappSend, "sendWhatsAppText");
    fireDueSpy = vi.spyOn(reminderFire, "fireDueReminders");
    scheduleSoonSpy = vi.spyOn(reminderFire, "scheduleSoon");

    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת מסלול.", buttons: [] }],
        metadata: {
          routes: {
            origin: ORIGIN,
            destination: DESTINATION,
            aspects: ["summary"],
          },
        },
      }),
    );

    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "איך מגיעים מתחנה מרכזית פתח תקווה לתחנה מרכזית תל אביב בתחבורה ציבורית?",
    });

    expect(whatsappTextSpy).not.toHaveBeenCalled();
    expect(fireDueSpy).not.toHaveBeenCalled();
    expect(scheduleSoonSpy).not.toHaveBeenCalled();

    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).not.toMatch(/לא מוגדר|לא מופעלים/);
    expect(spoken).toMatch(/מסלול|אפשרויות|דקות|בודקת|תחבורה/);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
    probe.restore();
  }, 60_000);
});
