/**
 * Coverage G1 + G4 (real model, full sendChatMessage, eval-db).
 *
 * G1 — button taps: a tap is a normal message (often with the WhatsApp quoted-reply
 *      prefix). Read-only taps (open filing / open task / list nav / day view) must
 *      show the right rows and change NOTHING: no row, filing, reminder or file link
 *      created / removed, no celebration rendered.
 * G4 — filing for a named person: a person's name in a filing title is title text
 *      (speaker's book, no assign); an explicit «בתיוקים שלה» is an assign onto that
 *      person's book; an alias (nickname) of an existing filing never creates a
 *      duplicate or lands on another filing.
 *
 * Speaker is a NON-owner (production default). Persisted state is asserted for every case.
 *
 * Run (cwd backend):
 *   npm run test:eval-db -- tests/taps-and-person-filing.live-sendchat.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLlmReply, parseReplyMetadata } from "@workee/shared";
import { resetEnvCache } from "../src/config/env.js";
import { prisma } from "../src/database/prisma.js";
import { getLlmClient, setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { loadTurnAttachmentsByIds } from "../src/services/attachment.service.js";
import {
  setAttachmentStorageForTests,
  type AttachmentStorage,
} from "../src/services/attachment-storage.js";
import { formatWhatsAppReplyContext } from "../src/services/whatsapp-outbound-memory.js";
import { addJerusalemDays, jerusalemParts } from "@workee/shared";
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

function memoryStorage(): AttachmentStorage {
  const bytes = new Map<string, Buffer>();
  return {
    async put(key, data) {
      bytes.set(key, data);
    },
    async read(key) {
      const hit = bytes.get(key);
      if (!hit) throw new Error(`missing ${key}`);
      return hit;
    },
    getStream(key) {
      return Readable.from(bytes.get(key) ?? Buffer.alloc(0));
    },
    async delete(key) {
      bytes.delete(key);
    },
  };
}

const idList = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.map(String) : typeof raw === "string" && raw ? [raw] : [];

describe("G1 button taps + G4 person filing (real model, eval-db)", () => {
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
    setAttachmentStorageForTests(null);
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  /** Seed the incident-shaped account: Maya (מאיוש), tasks, filings with files, shopping. */
  async function setup() {
    account = await createHarnessAccount("טל");
    await prisma.employee.update({
      where: { id: account.employeeId },
      data: { isOwner: false, addressGender: "male" },
    });
    const maya = await prisma.employee.create({
      data: { userId: account.userId, kind: "human", name: "מאיה", nickname: "מאיוש", surname: "" },
      select: { id: true },
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
    setAttachmentStorageForTests(memoryStorage());
    setLlmClientForTests(null);
    setLlmClientForTests(getLlmClient());

    const me = account.employeeId;
    const t = jerusalemParts(addJerusalemDays(new Date(), 1));
    const tomorrow = `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
    const tasks = await prisma.employeeList.create({
      data: { employeeId: me, listType: "tasks", name: "", scope: "personal", visibleTo: [me] },
      select: { id: true },
    });
    const task = async (data: Record<string, string>) =>
      (
        await prisma.employeeListItem.create({
          data: {
            listId: tasks.id,
            itemKey: data["שם משימה"]!,
            data,
            scope: "personal",
            addedById: me,
            visibleTo: [me],
          },
          select: { id: true },
        })
      ).id;
    const trash = await task({ "שם משימה": "להוריד את הזבל", "תאריך לביצוע": tomorrow });
    const transfer = await task({ "שם משימה": "להעביר את קבלת יואב לדניאל" });
    const shopping = await prisma.employeeList.create({
      data: { employeeId: me, listType: "shopping", name: "", scope: "personal", visibleTo: [me] },
      select: { id: true },
    });
    await prisma.employeeListItem.create({
      data: { listId: shopping.id, itemKey: "חלב", data: { "שם פריט": "חלב" }, scope: "personal", addedById: me, visibleTo: [me] },
    });
    const file = async (fileName: string, uploaderId = me) => {
      const id = randomUUID();
      await prisma.attachment.create({
        data: {
          id,
          userId: account!.userId,
          uploaderId,
          kind: "document",
          mimeType: "application/pdf",
          fileName,
          storageKey: `eval/${id}`,
        },
      });
      return id;
    };
    const filing = async (name: string, files: string[], owner = me) => {
      const row = await prisma.employeeFiling.create({
        data: { employeeId: owner, itemName: name, itemInfo: "", itemDescription: "", addedById: me, scope: "personal", visibleTo: [owner] },
        select: { id: true },
      });
      for (const attachmentId of files) {
        await prisma.attachmentLink.create({ data: { attachmentId, filingId: row.id, addedById: me } });
      }
      return row.id;
    };
    const fileA = await file("CamScanner yoav.pdf");
    const fileB = await file("CamScanner maya.pdf");
    const yoavFiling = await filing("קבלה של יואב", [fileA]);
    const mayaFiling = await filing("קבלה של מאיה", [fileB]);

    const userId = account.userId;
    const say = async (message: string, attachmentIds: string[] = []) =>
      sendChatMessage({
        userId,
        employeeId: me,
        digitalEmployeeId: lucyId,
        message,
        ...(attachmentIds.length
          ? { attachments: await loadTurnAttachmentsByIds(userId, me, attachmentIds) }
          : {}),
      });
    return { say, me, maya: maya.id, tomorrow, trash, transfer, yoavFiling, mayaFiling, fileA, fileB, file };
  }

  /** Everything a tap must never change. */
  async function stateSnapshot() {
    const userId = account!.userId;
    const [items, filings, reminders, links, celebrations] = await Promise.all([
      prisma.employeeListItem.findMany({
        where: { deletedAt: null, list: { employee: { userId } } },
        select: { id: true, data: true },
        orderBy: { id: "asc" },
      }),
      prisma.employeeFiling.findMany({
        where: { deletedAt: null, employee: { userId } },
        select: { id: true, employeeId: true, itemName: true },
        orderBy: { id: "asc" },
      }),
      prisma.reminder.findMany({ where: { userId }, select: { id: true, status: true }, orderBy: { id: "asc" } }),
      prisma.attachmentLink.findMany({
        where: { attachment: { userId } },
        select: { attachmentId: true, filingId: true, listItemId: true, listId: true },
        orderBy: { id: "asc" },
      }),
      prisma.attachment.count({ where: { userId, fileName: { startsWith: "celebration" } } }),
    ]);
    // Task rows may gain engine-only display keys; compare titles + ids, not raw JSON.
    return JSON.stringify({
      items: items.map((row) => [row.id, (row.data as Record<string, unknown>)["שם משימה"] ?? (row.data as Record<string, unknown>)["שם פריט"]]),
      filings,
      reminders,
      links,
      celebrations,
    });
  }

  const dump = (reply: string) => {
    const meta = parseReplyMetadata(reply) as { showDump?: string | null; showDumpIds?: unknown; showDumpFrom?: string | null };
    return { kind: meta.showDump ?? null, ids: idList(meta.showDumpIds), from: meta.showDumpFrom ?? null };
  };

  // ---------------- G1 ----------------

  it(
    "G1-1 open-filing tap (quoted reply, after a filings dump) → shows that filing only; nothing changes",
    async () => {
      const ctx = await setup();
      await ctx.say("הצג תיוקים");
      const before = await stateSnapshot();
      const tap = await ctx.say(
        formatWhatsAppReplyContext("תייקתי את *קבלה של מאיה*.", "הציגי את התיוק קבלה של מאיה"),
      );
      const shown = dump(tap.reply);
      expect(shown.kind, parseLlmReply(tap.reply).response).toBe("filings");
      expect(shown.ids).toEqual([ctx.mayaFiling]);
      expect(await stateSnapshot(), "read-only tap changed state").toBe(before);
    },
    TIMEOUT,
  );

  it(
    "G1-2 open-task tap (quoted reply, after a tasks dump) → shows that task only; trash task untouched",
    async () => {
      const ctx = await setup();
      await ctx.say("הצג משימות");
      const before = await stateSnapshot();
      const tap = await ctx.say(
        formatWhatsAppReplyContext(
          "הוספתי למשימות שלך: *להעביר את קבלת יואב לדניאל*.",
          "הציגי את המשימה להעביר את קבלת יואב לדניאל",
        ),
      );
      const shown = dump(tap.reply);
      expect(shown.kind, parseLlmReply(tap.reply).response).toBe("tasks");
      expect(shown.ids).toEqual([ctx.transfer]);
      expect(await stateSnapshot(), "read-only tap changed state").toBe(before);
    },
    TIMEOUT,
  );

  it(
    "G1-3 nav tap to another domain right after a filings dump → tasks list; nothing changes",
    async () => {
      const ctx = await setup();
      await ctx.say("הצג תיוקים");
      const before = await stateSnapshot();
      const tap = await ctx.say("הצג משימות");
      expect(dump(tap.reply).kind, parseLlmReply(tap.reply).response).toBe("tasks");
      expect(await stateSnapshot(), "read-only tap changed state").toBe(before);
    },
    TIMEOUT,
  );

  it(
    "G1-4 day-view tap → tasks for that day; nothing changes",
    async () => {
      const ctx = await setup();
      const before = await stateSnapshot();
      const tap = await ctx.say(`מה יש לי ב־${ctx.tomorrow} ברשימת משימות`);
      const shown = dump(tap.reply);
      expect(shown.kind, parseLlmReply(tap.reply).response).toBe("tasks");
      expect(shown.from).toBe(ctx.tomorrow);
      expect(await stateSnapshot(), "read-only tap changed state").toBe(before);
    },
    TIMEOUT,
  );

  // ---------------- G4 ----------------

  it(
    "G4-1 file + «זו הקבלה של מאיה, תתייקי» → speaker's filing titled with Maya, file linked; no assign",
    async () => {
      const ctx = await setup();
      const fileC = await ctx.file("CamScanner new.pdf");
      const mayaBookBefore = await prisma.employeeFiling.count({ where: { employeeId: ctx.maya, deletedAt: null } });
      const turn = await ctx.say("זו הקבלה של מאיה מהחוג, תתייקי אותה", [fileC]);
      const links = await prisma.attachmentLink.findMany({ where: { attachmentId: fileC }, select: { filingId: true } });
      expect(links.length, `filed: ${parseLlmReply(turn.reply).response}`).toBe(1);
      const target = await prisma.employeeFiling.findUnique({ where: { id: links[0]!.filingId! } });
      expect(target?.employeeId, "on the speaker's book").toBe(ctx.me);
      expect(target?.itemName).toMatch(/מאיה|מאיוש/);
      expect(links[0]!.filingId, "never the Yoav filing").not.toBe(ctx.yoavFiling);
      expect(
        await prisma.employeeFiling.count({ where: { employeeId: ctx.maya, deletedAt: null } }),
        "nothing assigned onto Maya's book",
      ).toBe(mayaBookBefore);
      expect(
        (await prisma.attachmentLink.findMany({ where: { filingId: ctx.yoavFiling }, select: { attachmentId: true } })).map((r) => r.attachmentId),
        "Yoav filing unchanged",
      ).toEqual([ctx.fileA]);
    },
    TIMEOUT,
  );

  it(
    "G4-2 explicit «בתיוקים שלה» → filing assigned onto Maya's book with the file; speaker's filings unchanged",
    async () => {
      const ctx = await setup();
      const fileC = await ctx.file("CamScanner for-maya.pdf");
      const mine = () => prisma.employeeFiling.findMany({ where: { employeeId: ctx.me, deletedAt: null }, select: { id: true }, orderBy: { id: "asc" } });
      const mineBefore = JSON.stringify(await mine());
      const turn = await ctx.say("תתייקי את הקבלה הזאת אצל מאיוש, בתיוקים שלה", [fileC]);
      const links = await prisma.attachmentLink.findMany({ where: { attachmentId: fileC }, select: { filingId: true } });
      expect(links.length, `filed: ${parseLlmReply(turn.reply).response}`).toBe(1);
      const target = await prisma.employeeFiling.findUnique({ where: { id: links[0]!.filingId! } });
      expect(target?.employeeId, "assigned onto Maya's book").toBe(ctx.maya);
      expect(
        await prisma.attachmentLink.count({
          where: { attachmentId: fileC, filing: { employeeId: ctx.me } },
        }),
        "file not also linked to any filing in the speaker's book",
      ).toBe(0);
      expect(JSON.stringify(await mine()), "speaker's filings unchanged").toBe(mineBefore);
    },
    TIMEOUT,
  );

  it(
    "G4-3 nickname alias «מאיוש» for an existing filing → that filing (or ask); never a duplicate or another filing",
    async () => {
      const ctx = await setup();
      const fileC = await ctx.file("CamScanner second.pdf");
      const filingsBefore = await prisma.employeeFiling.count({ where: { deletedAt: null, employee: { userId: account!.userId } } });
      const turn = await ctx.say("תוסיפי את הקובץ הזה לקבלה של מאיוש", [fileC]);
      const spoken = parseLlmReply(turn.reply).response;
      const links = await prisma.attachmentLink.findMany({ where: { attachmentId: fileC }, select: { filingId: true } });
      const onMaya = links.length === 1 && links[0]!.filingId === ctx.mayaFiling;
      const asked = links.length === 0 && /\?|？/.test(spoken);
      expect(onMaya || asked, `attached to Maya's filing or asked: ${spoken}`).toBe(true);
      expect(
        await prisma.employeeFiling.count({ where: { deletedAt: null, employee: { userId: account!.userId } } }),
        "no duplicate filing",
      ).toBe(filingsBefore);
      expect(
        (await prisma.attachmentLink.findMany({ where: { filingId: ctx.yoavFiling }, select: { attachmentId: true } })).map((r) => r.attachmentId),
        "Yoav filing unchanged",
      ).toEqual([ctx.fileA]);
    },
    TIMEOUT,
  );
});
