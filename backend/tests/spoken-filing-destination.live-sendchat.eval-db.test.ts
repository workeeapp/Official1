/**
 * Spoken filing destination (real model, full sendChatMessage, eval-db).
 *
 * No file attached. The speaker's words carry both a fact and an instruction.
 * Content, instruction, and destination stay separate:
 *  1. A clear existing filing is the home — update it, do not add another.
 *  2. The saved text is the fact, never the instruction sentence.
 *  3. The same fact already there is not saved again.
 *  4. A new filing only when nothing already fits.
 *  5. Two plausible homes → a short question, nothing saved.
 *
 * Run (cwd backend):
 *   npm run test:eval-db -- tests/spoken-filing-destination.live-sendchat.eval-db.test.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { resetEnvCache } from "../src/config/env.js";
import { prisma } from "../src/database/prisma.js";
import { getLlmClient, setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  injectProductEnvKey,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

const TIMEOUT = 300_000;

function loadLucyConfig() {
  const path = resolve(process.cwd(), "..", "LLM.config.json");
  expect(existsSync(path), path).toBe(true);
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    systemMessage: string[];
    model: string;
    temperature: number;
    reasoningEffort?: string;
  };
  return {
    instructions: raw.systemMessage.join("\n"),
    model: raw.model,
    temperature: raw.temperature,
    reasoningEffort: raw.reasoningEffort ?? null,
  };
}

type FilingRow = {
  id: string;
  itemName: string;
  itemInfo: string;
  itemDescription: string;
};

describe("spoken filing destination (real model, eval-db)", () => {
  let account: HarnessAccount | null = null;

  beforeAll(async () => {
    const key = injectProductEnvKey("OPENAI_API_KEY");
    expect(key.present, "OPENAI_API_KEY required").toBe(true);
    resetEnvCache();
    await assertEvalDbAndGtfsUntouched();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  async function setup() {
    account = await createHarnessAccount("טל");
    await prisma.employee.update({
      where: { id: account.employeeId },
      data: { addressGender: "male" },
    });
    const config = loadLucyConfig();
    const lucyId = await ensureLucy(account, config.instructions);
    await prisma.employee.update({
      where: { id: lucyId },
      data: {
        instructions: config.instructions,
        model: config.model,
        temperature: config.temperature,
        reasoningEffort: config.reasoningEffort,
      },
    });
    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent");
    vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent");
    vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0);
    vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => {});
    setLlmClientForTests(getLlmClient());
    const { userId, employeeId } = account;
    const say = (message: string) =>
      sendChatMessage({
        userId,
        employeeId,
        digitalEmployeeId: lucyId,
        message,
      });
    return { say };
  }

  async function seedFiling(name: string, info: string): Promise<string> {
    const filing = await prisma.employeeFiling.create({
      data: {
        employeeId: account!.employeeId,
        itemName: name,
        itemInfo: info,
        itemDescription: "",
        addedById: account!.employeeId,
        scope: "personal",
        visibleTo: [account!.employeeId],
      },
      select: { id: true },
    });
    return filing.id;
  }

  const liveFilings = (): Promise<FilingRow[]> =>
    prisma.employeeFiling.findMany({
      where: { employeeId: account!.employeeId, deletedAt: null },
      select: { id: true, itemName: true, itemInfo: true, itemDescription: true },
      orderBy: { createdAt: "asc" },
    });

  function blob(row: FilingRow): string {
    return `${row.itemName}\n${row.itemInfo}\n${row.itemDescription}`;
  }

  it(
    "1. a new gate code named with the existing gate filing is saved on that filing only",
    async () => {
      const { say } = await setup();
      const gate = await seedFiling("קוד שער הבניין", "1234");
      const turn = await say("תתייקי את הקוד 4821 אצל קוד השער");
      const spoken = parseLlmReply(turn.reply).response;
      const rows = await liveFilings();
      expect(rows.map((row) => row.id), spoken).toEqual([gate]);
      expect(blob(rows[0]!), spoken).toContain("4821");
      expect(blob(rows[0]!), spoken).not.toContain("תתייקי");
    },
    TIMEOUT,
  );

  it(
    "2. an address plus where it belongs saves the address, not the instruction",
    async () => {
      const { say } = await setup();
      const home = await seedFiling("פרטים אישיים", "טלפון 050-0000000");
      const turn = await say(
        "תתייקי את זה אצל הפרטים האישיים: הכתובת שלי היא רחוב הרצל 1 תל אביב",
      );
      const spoken = parseLlmReply(turn.reply).response;
      const rows = await liveFilings();
      expect(rows.map((row) => row.id), spoken).toEqual([home]);
      const text = blob(rows[0]!);
      expect(text, spoken).toMatch(/הרצל/);
      expect(text, spoken).toMatch(/תל אביב/);
      expect(text, spoken).not.toContain("תתייקי");
      expect(text, spoken).not.toContain("אצל הפרטים");
    },
    TIMEOUT,
  );

  it(
    "3. the same car number already filed is not saved again",
    async () => {
      const { say } = await setup();
      const car = await seedFiling("מספר רכב", "70-312-45");
      const turn = await say("תתייקי שמספר הרכב שלי הוא 70-312-45");
      const spoken = parseLlmReply(turn.reply).response;
      const rows = await liveFilings();
      expect(rows, spoken).toHaveLength(1);
      expect(rows[0]!.id).toBe(car);
      expect(rows[0]!.itemInfo).toBe("70-312-45");
      expect(blob(rows[0]!)).not.toContain("תתייקי");
    },
    TIMEOUT,
  );

  it(
    "4. a car number with no fitting filing becomes one new filing, not a row on an unrelated filing",
    async () => {
      const { say } = await setup();
      const gate = await seedFiling("קוד שער הבניין", "1234");
      const turn = await say("תתייקי שמספר הרכב שלי הוא 12-345-67");
      const spoken = parseLlmReply(turn.reply).response;
      const rows = await liveFilings();
      expect(rows, spoken).toHaveLength(2);
      const untouched = rows.find((row) => row.id === gate)!;
      expect(blob(untouched), spoken).toBe("קוד שער הבניין\n1234\n");
      const created = rows.find((row) => row.id !== gate)!;
      expect(blob(created), spoken).toContain("12-345-67");
      expect(blob(created), spoken).not.toContain("תתייקי");
    },
    TIMEOUT,
  );

  it(
    "5. a policy number that fits two filings asks which one and saves nothing",
    async () => {
      const { say } = await setup();
      const car = await seedFiling("ביטוח רכב", "פוליסה 11-111");
      const home = await seedFiling("ביטוח דירה", "פוליסה 22-222");
      const before = await liveFilings();
      const turn = await say("תתייקי את מספר הפוליסה 55-999");
      const spoken = parseLlmReply(turn.reply).response;
      const rows = await liveFilings();
      expect(rows, spoken).toEqual(before);
      expect(rows.map((row) => row.id).sort()).toEqual([car, home].sort());
      expect(rows.every((row) => !blob(row).includes("55-999")), spoken).toBe(true);
      expect(spoken).toMatch(/[?？]|איז[הו]|לאיז/);
    },
    TIMEOUT,
  );
});
