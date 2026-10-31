/**
 * Jewish place ladder via sendChat (eval-db, stubbed Hebcal — engine proof).
 * Stubbed LLM ACTION; proves PIN / saved coords reach Hebcal URL + LAST_LIVE pack.
 * Not LIVE_MODEL proof.
 *
 * Run: npm run test:eval-db -w backend -- tests/jewish-location-sendchat.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import {
  loadLastLiveLocationForConversation,
  sendChatMessage,
} from "../src/services/chat.service.js";
import {
  resetPendingLocations,
  setPendingLocation,
} from "../src/services/pending-location.js";
import { JEWISH_SPEAKER_MISSING_PIN_ASK } from "../src/services/jewish.js";
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

const PIN_LAT = 32.08;
const PIN_LNG = 34.78;
const HOME_LAT = 32.099279;
const HOME_LNG = 34.8923104;

type FetchProbe = { url: string };

function installStubbedHebcalFetch(): {
  probes: FetchProbe[];
  restore: () => void;
} {
  const probes: FetchProbe[] = [];
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    probes.push({ url });
    if (url.includes("hebcal.com/shabbat") || url.includes("hebcal.com/hebcal")) {
      return new Response(
        JSON.stringify({
          location: { title: "Stub City" },
          items: [
            {
              category: "candles",
              title: "Candle lighting: 5:30pm",
              hebrew: "הַדְלָקַת נֵרוֹת: 17:30",
              date: "2026-10-23T17:30:00+03:00",
            },
            {
              category: "havdalah",
              title: "Havdalah: 6:30pm",
              hebrew: "הַבְדָּלָה: 18:30",
              date: "2026-10-24T18:30:00+03:00",
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("geocoding-api.open-meteo.com")) {
      return new Response(
        JSON.stringify({
          results: [
            {
              name: "Tel Aviv",
              latitude: 32.08,
              longitude: 34.78,
              timezone: "Asia/Jerusalem",
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("unexpected", { status: 500 });
  });
  vi.stubGlobal("fetch", spy);
  return {
    probes,
    restore() {
      vi.unstubAllGlobals();
    },
  };
}

function hebcalUrls(probes: FetchProbe[]): string[] {
  return probes.map((p) => p.url).filter((u) => u.includes("hebcal.com"));
}

function stubLlmQueue(payloads: unknown[]) {
  let i = 0;
  return {
    async createConversation() {
      return `conv-${randomUUID()}`;
    },
    async createResponse() {
      const payload = payloads[Math.min(i, payloads.length - 1)];
      i += 1;
      return { reply: JSON.stringify(payload), raw: {} };
    },
  };
}

function requestInputText(request: unknown): string {
  if (!request || typeof request !== "object") return "";
  const input = (request as Record<string, unknown>).input;
  return typeof input === "string" ? input : JSON.stringify(input ?? "");
}

const jewishPayload = (place: string, aspects: string[] = ["candles"]) => ({
  responses: [{ text: "בודקת.", buttons: [] }],
  metadata: {
    jewish: { place, date: "", aspects },
  },
});

async function seedHomeFiling(
  employeeId: string,
  itemInfo: string,
  itemName = "מיקום הבית",
) {
  return prisma.employeeFiling.create({
    data: {
      employeeId,
      itemName,
      itemInfo,
      itemDescription: "harness",
      scope: "personal",
      visibleTo: [],
    },
  });
}

describe("Jewish location sendChat (eval-db, stubbed Hebcal)", () => {
  let account: HarnessAccount | null = null;
  let whatsappTextSpy: ReturnType<typeof vi.spyOn> | null = null;
  let fireDueSpy: ReturnType<typeof vi.spyOn> | null = null;
  let scheduleSoonSpy: ReturnType<typeof vi.spyOn> | null = null;
  let fetchProbe: ReturnType<typeof installStubbedHebcalFetch> | null = null;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
  });

  beforeEach(async () => {
    await assertEvalDbAndGtfsUntouched();
    resetPendingLocations();
  });

  afterEach(async () => {
    setLlmClientForTests(null);
    fetchProbe?.restore();
    fetchProbe = null;
    whatsappTextSpy?.mockRestore();
    fireDueSpy?.mockRestore();
    scheduleSoonSpy?.mockRestore();
    whatsappTextSpy = null;
    fireDueSpy = null;
    scheduleSoonSpy = null;
    resetPendingLocations();
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  async function boot() {
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account, "You answer Shabbat times.");
    whatsappTextSpy = vi.spyOn(whatsappSend, "sendWhatsAppText");
    fireDueSpy = vi.spyOn(reminderFire, "fireDueReminders");
    scheduleSoonSpy = vi.spyOn(reminderFire, "scheduleSoon");
    fetchProbe = installStubbedHebcalFetch();
    return lucyId;
  }

  it("PIN: place=speaker → Hebcal lat/lng (stub LLM + engine)", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    setPendingLocation(account!.employeeId, {
      lat: PIN_LAT,
      lng: PIN_LNG,
      name: "",
      address: "",
    });
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: {
          jewish: { place: "speaker", date: "", aspects: ["candles"] },
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מתי נכנסת שבת כאן?",
    });
    expect(whatsappTextSpy).not.toHaveBeenCalled();
    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/17:30|נרות/);
    const urls = hebcalUrls(fetchProbe!.probes);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((u) => u.includes(`latitude=${PIN_LAT}`))).toBe(true);
    expect(urls.some((u) => u.includes(`longitude=${PIN_LNG}`))).toBe(true);
    expect(urls.every((u) => !u.includes("geonameid="))).toBe(true);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("saved home label → Hebcal lat/lng; no Open-Meteo geocode of label", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    await seedHomeFiling(account!.employeeId, `${HOME_LAT}, ${HOME_LNG}`);
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: {
          jewish: {
            place: "מיקום הבית",
            date: "",
            aspects: ["candles"],
          },
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מתי נכנסת שבת בבית?",
    });
    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/17:30|נרות|מיקום הבית/);
    const urls = hebcalUrls(fetchProbe!.probes);
    expect(urls.some((u) => u.includes(`latitude=${HOME_LAT}`))).toBe(true);
    expect(urls.some((u) => u.includes(`longitude=${HOME_LNG}`))).toBe(true);
    expect(
      fetchProbe!.probes.every(
        (p) => !p.url.includes("geocoding-api.open-meteo.com"),
      ),
    ).toBe(true);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("speaker without PIN → ask; no Hebcal fetch", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: {
          jewish: { place: "speaker", date: "", aspects: ["candles"] },
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מתי נכנסת שבת כאן?",
    });
    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toContain(JEWISH_SPEAKER_MISSING_PIN_ASK);
    expect(hebcalUrls(fetchProbe!.probes)).toHaveLength(0);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("named city still uses geonameid path", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: {
          jewish: { place: "רמת גן", date: "", aspects: ["havdalah"] },
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מתי יוצאת שבת ברמת גן?",
    });
    expect(parseLlmReply(result.reply).response).toMatch(/18:30|הבדלה|יציאת/);
    const urls = hebcalUrls(fetchProbe!.probes);
    expect(urls.some((u) => u.includes("geonameid=293788"))).toBe(true);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("successful Shabbat city packs LAST_LIVE; follow-up injects it for «שם»", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    setLlmClientForTests(
      stubLlmQueue([
        jewishPayload("פתח תקווה", ["candles"]),
        jewishPayload("פתח תקווה", ["havdalah"]),
      ]),
    );

    await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מתי נכנסת שבת בפתח תקווה?",
    });
    const conv = await prisma.chatConversation.findFirst({
      where: {
        userId: account!.userId,
        employeeId: account!.employeeId,
        digitalEmployeeId: lucyId,
      },
      orderBy: { updatedAt: "desc" },
    });
    expect(conv?.id).toBeTruthy();
    const packed = await loadLastLiveLocationForConversation(conv!.id);
    expect(packed?.label).toBe("פתח תקווה");
    expect(packed?.domain).toBe("jewish");

    const hebcalBefore = hebcalUrls(fetchProbe!.probes).length;
    const second = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "ומה לגבי שם?",
    });
    const injected = requestInputText(second.request);
    expect(injected).toContain("LAST_LIVE_LOCATION:");
    expect(injected).toContain("פתח תקווה");
    expect(injected).toContain('"domain":"jewish"');
    expect(hebcalUrls(fetchProbe!.probes).length).toBeGreaterThan(hebcalBefore);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("ASK speaker-without-pin does not pack LAST_LIVE", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: {
          jewish: { place: "speaker", date: "", aspects: ["candles"] },
        },
      }),
    );
    await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מתי נכנסת שבת כאן?",
    });
    const conv = await prisma.chatConversation.findFirst({
      where: {
        userId: account!.userId,
        employeeId: account!.employeeId,
        digitalEmployeeId: lucyId,
      },
      orderBy: { updatedAt: "desc" },
    });
    expect(await loadLastLiveLocationForConversation(conv!.id)).toBeNull();
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });
});
