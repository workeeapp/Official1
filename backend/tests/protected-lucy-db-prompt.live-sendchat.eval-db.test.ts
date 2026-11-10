/**
 * Protected Lucy runtime from the saved Employees.instructions column.
 *
 * workee_test's existing protected Lucy (f6908afa…) holds an older prompt and
 * is not used. The synced prompt is not on this database. These cases create
 * a disposable protected לוסי, store the synced prompt bytes in her row, and
 * refuse to chat unless that row's sha256 is the synced hash. sendChatMessage
 * then reads the row. Empty instructions would fall back to the file; that
 * path fails this check.
 *
 * Run (cwd backend):
 *   npm run test:eval-db -- tests/protected-lucy-db-prompt.live-sendchat.eval-db.test.ts
 */
import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { resetEnvCache } from "../src/config/env.js";
import { loadLlmConfig } from "../src/config/llm.js";
import { prisma } from "../src/database/prisma.js";
import { looksLikeAsk } from "../src/eval/constraints.js";
import { getLlmClient, setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  injectProductEnvKey,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

const TIMEOUT = 300_000;
const SYNCED_PROMPT_SHA =
  "8cda96d36be8682a44a3ca72649c91c1ad19d972497a19b4e50516cf6ec93f90";
const STALE_WORKEE_TEST_LUCY = "f6908afa-c09a-481e-b3f6-dadc019fa34f";

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

type LucyIdentity = {
  employeeId: string;
  userId: string;
  sha256: string;
};

describe("protected Lucy saved-prompt runtime (workee_test)", () => {
  let account: HarnessAccount | null = null;

  beforeAll(async () => {
    const key = injectProductEnvKey("OPENAI_API_KEY");
    expect(key.present, "OPENAI_API_KEY required").toBe(true);
    resetEnvCache();
    await assertEvalDbAndGtfsUntouched();
    const url = new URL(process.env.DATABASE_URL!);
    expect(url.port).toBe("5436");
    expect(url.pathname.endsWith("/workee_test")).toBe(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  async function setup(): Promise<{
    say: (message: string) => ReturnType<typeof sendChatMessage>;
    lucy: LucyIdentity;
  }> {
    const seeded = loadLlmConfig();
    const seededSha = sha256(seeded.systemMessage);
    expect(seededSha, "seed bytes are not the synced prompt").toBe(SYNCED_PROMPT_SHA);

    account = await createHarnessAccount("טל");
    await prisma.employee.update({
      where: { id: account.employeeId },
      data: { addressGender: "male" },
    });
    const created = await prisma.employee.create({
      data: {
        userId: account.userId,
        kind: "digital",
        isProtected: true,
        name: "לוסי",
        surname: "",
        nickname: "לוסי",
        model: seeded.model,
        temperature: seeded.temperature,
        reasoningEffort: seeded.reasoningEffort,
        instructions: seeded.systemMessage,
      },
      select: { id: true },
    });
    const row = await prisma.employee.findFirst({
      where: { id: created.id, userId: account.userId, kind: "digital", isProtected: true },
      select: { id: true, userId: true, name: true, instructions: true },
    });
    const stored = row?.instructions?.trim() ?? "";
    expect(row?.name).toBe("לוסי");
    expect(stored.length, "empty instructions would fall back to the file").toBeGreaterThan(0);
    expect(sha256(stored)).toBe(SYNCED_PROMPT_SHA);
    expect(row!.id).not.toBe(STALE_WORKEE_TEST_LUCY);

    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent");
    vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent");
    vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0);
    vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => {});
    setLlmClientForTests(getLlmClient());

    const lucy: LucyIdentity = {
      employeeId: row!.id,
      userId: row!.userId,
      sha256: sha256(stored),
    };
    console.info(`protected Lucy ${lucy.employeeId} account ${lucy.userId} prompt ${lucy.sha256}`);
    const { userId, employeeId } = account;
    return {
      lucy,
      say: (message: string) =>
        sendChatMessage({
          userId,
          employeeId,
          digitalEmployeeId: lucy.employeeId,
          message,
        }),
    };
  }

  async function seedPokerList(): Promise<void> {
    const list = await prisma.employeeList.create({
      data: {
        employeeId: account!.employeeId,
        listType: "custom",
        name: "מה מביאים · ערב פוקר",
        titleField: "פריט",
        columns: ["פריט", "אחראי", "סטטוס"],
        scope: "personal",
        visibleTo: [account!.employeeId],
      },
      select: { id: true },
    });
    for (const item of [
      { פריט: "שתייה", אחראי: "דניאל", סטטוס: "טרם הובא" },
      { פריט: "חטיפים", אחראי: "שרה", סטטוס: "ממתין" },
    ]) {
      await prisma.employeeListItem.create({
        data: {
          listId: list.id,
          itemKey: item.פריט,
          data: item,
          scope: "personal",
          addedById: account!.employeeId,
          visibleTo: [account!.employeeId],
        },
      });
    }
  }

  async function pokerRows() {
    return prisma.employeeListItem.findMany({
      where: {
        deletedAt: null,
        list: {
          employeeId: account!.employeeId,
          listType: "custom",
          name: "מה מביאים · ערב פוקר",
          deletedAt: null,
        },
      },
      select: { data: true },
    });
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

  const filings = () =>
    prisma.employeeFiling.findMany({
      where: { employeeId: account!.employeeId, deletedAt: null },
      select: { id: true, itemName: true, itemInfo: true, itemDescription: true },
      orderBy: { createdAt: "asc" },
    });

  it(
    "1. a casual mention offers an update and leaves the poker list unchanged",
    async () => {
      const { say, lucy } = await setup();
      await seedPokerList();
      const turn = await say("אגב, דניאל כבר הביא את השתייה לערב הפוקר");
      const spoken = parseLlmReply(turn.reply).response;
      const rows = await pokerRows();
      const drinks = rows.find((row) => (row.data as { פריט?: string }).פריט === "שתייה");
      const snacks = rows.find((row) => (row.data as { פריט?: string }).פריט === "חטיפים");
      expect(lucy.sha256, `${lucy.employeeId} ${lucy.userId}`).toBe(SYNCED_PROMPT_SHA);
      expect(rows, spoken).toHaveLength(2);
      expect(drinks?.data).toMatchObject({ אחראי: "דניאל", סטטוס: "טרם הובא" });
      expect(snacks?.data).toMatchObject({ אחראי: "שרה", סטטוס: "ממתין" });
      expect(looksLikeAsk(spoken) || /לעדכן|אעדכן/.test(spoken), spoken).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "2. an explicit change updates the drinks row and leaves the snacks row",
    async () => {
      const { say, lucy } = await setup();
      await seedPokerList();
      const turn = await say("תעדכני ברשימה של ערב הפוקר שדניאל כבר הביא את השתייה");
      const spoken = parseLlmReply(turn.reply).response;
      const rows = await pokerRows();
      const drinks = rows.find((row) => (row.data as { פריט?: string }).פריט === "שתייה");
      const snacks = rows.find((row) => (row.data as { פריט?: string }).פריט === "חטיפים");
      expect(lucy.sha256, `${lucy.employeeId} ${lucy.userId}`).toBe(SYNCED_PROMPT_SHA);
      expect(rows, spoken).toHaveLength(2);
      expect((drinks?.data as { סטטוס?: string })?.סטטוס, spoken).not.toBe("טרם הובא");
      expect(drinks?.data).toMatchObject({ פריט: "שתייה", אחראי: "דניאל" });
      expect(snacks?.data).toMatchObject({ פריט: "חטיפים", אחראי: "שרה", סטטוס: "ממתין" });
    },
    TIMEOUT,
  );

  it(
    "3. a spoken fact for an existing filing updates that filing only",
    async () => {
      const { say, lucy } = await setup();
      const gate = await seedFiling("קוד שער הבניין", "1234");
      const turn = await say("תתייקי את הקוד 4821 אצל קוד השער");
      const spoken = parseLlmReply(turn.reply).response;
      const rows = await filings();
      expect(lucy.sha256, `${lucy.employeeId} ${lucy.userId}`).toBe(SYNCED_PROMPT_SHA);
      expect(rows.map((row) => row.id), spoken).toEqual([gate]);
      expect(`${rows[0]!.itemName} ${rows[0]!.itemInfo}`, spoken).toContain("4821");
      expect(`${rows[0]!.itemName} ${rows[0]!.itemInfo}`, spoken).not.toContain("תתייקי");
    },
    TIMEOUT,
  );

  it(
    "4. a spoken fact with no fitting filing creates one new filing",
    async () => {
      const { say, lucy } = await setup();
      const gate = await seedFiling("קוד שער הבניין", "1234");
      const turn = await say("תתייקי שמספר הרכב שלי הוא 12-345-67");
      const spoken = parseLlmReply(turn.reply).response;
      const rows = await filings();
      expect(lucy.sha256, `${lucy.employeeId} ${lucy.userId}`).toBe(SYNCED_PROMPT_SHA);
      expect(rows, spoken).toHaveLength(2);
      const untouched = rows.find((row) => row.id === gate)!;
      expect(`${untouched.itemName}\n${untouched.itemInfo}`).toBe("קוד שער הבניין\n1234");
      const created = rows.find((row) => row.id !== gate)!;
      expect(`${created.itemName} ${created.itemInfo} ${created.itemDescription}`, spoken).toContain("12-345-67");
      expect(`${created.itemName} ${created.itemInfo}`).not.toContain("תתייקי");
    },
    TIMEOUT,
  );

  it(
    "5. an ambiguous filing destination asks which one and saves nothing",
    async () => {
      const { say, lucy } = await setup();
      const car = await seedFiling("ביטוח רכב", "פוליסה 11-111");
      const home = await seedFiling("ביטוח דירה", "פוליסה 22-222");
      const before = await filings();
      const turn = await say("תתייקי את מספר הפוליסה 55-999");
      const spoken = parseLlmReply(turn.reply).response;
      const rows = await filings();
      expect(lucy.sha256, `${lucy.employeeId} ${lucy.userId}`).toBe(SYNCED_PROMPT_SHA);
      expect(rows, spoken).toEqual(before);
      expect(rows.map((row) => row.id).sort()).toEqual([car, home].sort());
      expect(rows.every((row) => !`${row.itemInfo} ${row.itemName}`.includes("55-999")), spoken).toBe(true);
      expect(spoken, spoken).toMatch(/[?？]|איז[הו]|לאיז/);
      expect(spoken, spoken).toMatch(/(^|\n)\s*1[.)]/);
    },
    TIMEOUT,
  );
});
