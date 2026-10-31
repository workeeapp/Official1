/**
 * Saved locations across filings / tasks / contacts — engine proof (stub LLM).
 * Not LIVE_MODEL. Covers factual dump + live resolve (weather/routes) + pin ignore.
 *
 * Run: npm run test:eval-db -w backend -- tests/saved-locations-cross-source.eval-db.test.ts
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { resetEnvCache } from "../src/config/env.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { applyDirectoryActions } from "../src/services/contact.service.js";
import {
  clearPendingLocation,
  getPendingLocation,
  resetPendingLocations,
  setPendingLocation,
} from "../src/services/pending-location.js";
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

const HOME_LAT = 32.099279;
const HOME_LNG = 34.8923104;
const WORK_LAT = 32.085;
const WORK_LNG = 34.781;
const PIN_LAT = 31.5;
const PIN_LNG = 34.5;
const GRANDMA_STREET = "הרצל 5 רמת גן";

type FetchProbe = { url: string; body: string | null };

function installStubbedProviderFetch(): {
  probes: FetchProbe[];
  restore: () => void;
} {
  const probes: FetchProbe[] = [];
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body != null
          ? String(init.body)
          : null;
    probes.push({ url, body });
    if (url.includes("api.open-meteo.com/v1/forecast")) {
      return new Response(
        JSON.stringify({
          timezone: "Asia/Jerusalem",
          current: {
            time: "2026-10-20T10:00",
            temperature_2m: 25,
            relative_humidity_2m: 50,
            weather_code: 0,
            wind_speed_10m: 12,
            wind_gusts_10m: 18,
            precipitation: 0,
          },
          daily: {
            time: ["2026-10-20"],
            weather_code: [0],
            temperature_2m_max: [28],
            temperature_2m_min: [18],
            precipitation_sum: [0],
            wind_speed_10m_max: [20],
          },
          hourly: {
            time: ["2026-10-20T10:00"],
            temperature_2m: [25],
            relative_humidity_2m: [50],
            weather_code: [0],
            wind_speed_10m: [12],
            wind_gusts_10m: [18],
            precipitation: [0],
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes("routes.googleapis.com")) {
      return new Response(
        JSON.stringify({
          routes: [
            {
              duration: "1200s",
              distanceMeters: 5000,
              legs: [
                {
                  duration: "1200s",
                  distanceMeters: 5000,
                  steps: [],
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("geocoding-api.open-meteo.com")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
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

function forecastUrls(probes: FetchProbe[]): string[] {
  return probes
    .map((p) => p.url)
    .filter((u) => u.includes("api.open-meteo.com/v1/forecast"));
}

describe("saved locations cross-source (eval-db, stub LLM)", () => {
  let account: HarnessAccount | null = null;
  let whatsappTextSpy: ReturnType<typeof vi.spyOn> | null = null;
  let fireDueSpy: ReturnType<typeof vi.spyOn> | null = null;
  let scheduleSoonSpy: ReturnType<typeof vi.spyOn> | null = null;
  let fetchProbe: ReturnType<typeof installStubbedProviderFetch> | null = null;

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
    if (!process.env.GOOGLE_ROUTES_API_KEY?.trim()) {
      process.env.GOOGLE_ROUTES_API_KEY = "eval-stub-routes-key";
      resetEnvCache();
    }
    if (!process.env.GOOGLE_PLACES_API_KEY?.trim()) {
      process.env.GOOGLE_PLACES_API_KEY = "eval-stub-places-key";
      resetEnvCache();
    }
    account = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(account, "You answer saved-location asks.");
    whatsappTextSpy = vi.spyOn(whatsappSend, "sendWhatsAppText");
    fireDueSpy = vi.spyOn(reminderFire, "fireDueReminders");
    scheduleSoonSpy = vi.spyOn(reminderFire, "scheduleSoon");
    fetchProbe = installStubbedProviderFetch();
    return lucyId;
  }

  async function seedHomeFiling(employeeId: string) {
    return prisma.employeeFiling.create({
      data: {
        employeeId,
        itemName: "מיקום הבית",
        itemInfo: `${HOME_LAT}, ${HOME_LNG}`,
        itemDescription: "harness",
        scope: "personal",
        visibleTo: [],
      },
    });
  }

  async function seedWorkTask(employeeId: string) {
    let list = await prisma.employeeList.findFirst({
      where: { employeeId, listType: "tasks", deletedAt: null },
    });
    if (!list) {
      list = await prisma.employeeList.create({
        data: {
          employeeId,
          listType: "tasks",
          name: "מטלות",
          scope: "personal",
          visibleTo: [employeeId],
        },
      });
    }
    return prisma.employeeListItem.create({
      data: {
        listId: list.id,
        itemKey: "העבודה",
        data: {
          "שם מטלה": "העבודה",
          כתובת: `${WORK_LAT}, ${WORK_LNG}`,
        },
      },
    });
  }

  it("1+2 factual: home filing dump + work task dump (pin unused)", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    const filing = await seedHomeFiling(account!.employeeId);
    const task = await seedWorkTask(account!.employeeId);
    setPendingLocation(account!.employeeId, {
      lat: PIN_LAT,
      lng: PIN_LNG,
      name: "סיכה",
      address: "",
    });

    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "מציגה.", buttons: [] }],
        metadata: {
          show_dump: "filings",
          show_dump_ids: [filing.id],
        },
      }),
    );
    const home = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "איפה אני גר?",
    });
    const homeSpoken = parseLlmReply(home.reply).response;
    expect(homeSpoken).toContain("מיקום הבית");
    expect(homeSpoken).not.toContain(String(PIN_LAT));

    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "מציגה.", buttons: [] }],
        metadata: {
          show_dump: "tasks",
          show_dump_ids: [task.id],
        },
      }),
    );
    const work = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "איפה אני עובד?",
    });
    const workSpoken = parseLlmReply(work.reply).response;
    expect(workSpoken).toContain("העבודה");
    expect(workSpoken).toMatch(/📍/);
    expect(workSpoken).not.toContain(String(PIN_LAT));
    expect(getPendingLocation(account!.employeeId)?.lat).toBeCloseTo(PIN_LAT);
    clearPendingLocation(account!.employeeId);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("3 factual: grandma contact address via phone_book dump", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    const dir = await applyDirectoryActions({
      userId: account!.userId,
      ownerEmployeeId: account!.employeeId,
      employees: account!.employees,
      actions: [
        {
          action: "add",
          name: "סבתא",
          phone: "0501112233",
          description: GRANDMA_STREET,
          contactId: "",
          targets: ["טל"],
        },
      ],
    });
    expect(dir.saved.length).toBe(1);
    const contactId = dir.saved[0]!.id;

    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "מציגה.", buttons: [] }],
        metadata: {
          show_dump: "phone_book",
          show_dump_ids: [contactId],
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מה הכתובת של סבתא?",
    });
    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toContain("סבתא");
    expect(spoken).toContain(GRANDMA_STREET);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("4+5 live: routes home→work + weather at home; pin ignored when place set", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    await seedHomeFiling(account!.employeeId);
    await seedWorkTask(account!.employeeId);
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
          routes: {
            origin: "מיקום הבית",
            destination: "העבודה",
            mode: "drive",
            aspects: ["summary"],
          },
        },
      }),
    );
    const routes = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "איך להגיע מהבית לעבודה?",
    });
    const routesSpoken = parseLlmReply(routes.reply).response;
    expect(routesSpoken).toMatch(/מיקום הבית|העבודה|מסלול|דק/);
    expect(routesSpoken).not.toContain(String(PIN_LAT));

    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: {
          weather: {
            place: "מיקום הבית",
            near: "",
            date: "",
            aspects: ["temp"],
          },
        },
      }),
    );
    await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מה מזג האוויר בבית?",
    });
    const forecasts = forecastUrls(fetchProbe!.probes);
    expect(forecasts.length).toBeGreaterThan(0);
    expect(forecasts.some((u) => u.includes(`latitude=${HOME_LAT}`))).toBe(
      true,
    );
    expect(forecasts.every((u) => !u.includes(`latitude=${PIN_LAT}`))).toBe(
      true,
    );
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });

  it("6 ambiguous saved labels → ask; no forecast", async () => {
    const before = await assertEvalDbAndGtfsUntouched();
    const lucyId = await boot();
    await prisma.employeeFiling.create({
      data: {
        employeeId: account!.employeeId,
        itemName: "בית הורים",
        itemInfo: `${HOME_LAT}, ${HOME_LNG}`,
        itemDescription: "a",
        scope: "personal",
        visibleTo: [],
      },
    });
    await prisma.employeeFiling.create({
      data: {
        employeeId: account!.employeeId,
        itemName: "בית סבתא",
        itemInfo: `${WORK_LAT}, ${WORK_LNG}`,
        itemDescription: "b",
        scope: "personal",
        visibleTo: [],
      },
    });
    setLlmClientForTests(
      stubLlmReply({
        responses: [{ text: "בודקת.", buttons: [] }],
        metadata: {
          weather: {
            place: "בית",
            near: "",
            date: "",
            aspects: ["temp"],
          },
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account!.userId,
      employeeId: account!.employeeId,
      digitalEmployeeId: lucyId,
      message: "מזג אוויר בבית?",
    });
    const spoken = parseLlmReply(result.reply).response;
    expect(spoken).toMatch(/כמה מיקומים|לאיזה/);
    expect(forecastUrls(fetchProbe!.probes)).toHaveLength(0);
    expect(await assertEvalDbAndGtfsUntouched()).toBe(before);
  });
});
