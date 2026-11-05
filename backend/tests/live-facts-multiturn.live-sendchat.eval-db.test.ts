/**
 * Live facts per turn — real model via sendChatMessage on workee_test.
 *
 * Regression (Tal, 2026-11-04): every turn re-sent a full facts snapshot inside
 * the stored user message, so input tokens grew ~28k per turn and the model saw
 * one stale copy per earlier turn. Facts now ride on per-turn instructions only.
 *
 * One realistic conversation (40 tasks + 30 shopping rows) checks:
 *  - functionality: add task → «שעה לפני» reminder → show → delete by line →
 *    show again (no stale row) → move task (clock moves with it) → tasks ask;
 *  - performance: per-turn input / cached tokens and model latency (input must
 *    stop accumulating AND most of it must hit the prompt cache), written to
 *    .tmp-live-facts-perf-<label>.json. With PERF_LABEL=baseline the token
 *    budget is reported only (to measure the old code for comparison).
 *
 * Run (cwd backend):
 *   npm run test:eval-db -- tests/live-facts-multiturn.live-sendchat.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

const TIMEOUT = 900_000;
const LABEL = process.env.PERF_LABEL?.trim() || "new";
const BASELINE = LABEL === "baseline";
/** Per-turn growth budget once facts stop accumulating in history. */
const MAX_MEDIAN_GROWTH_PER_TURN = 4_000;
/** Prompt cache must keep working (the facts-in-instructions try had 0). */
const MIN_MEDIAN_CACHED_SHARE = 0.5;

type TurnPerf = {
  turn: number;
  say: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  llmMs: number;
  spoken: string;
};

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

const jerusalemDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const jerusalemClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** YYYY-MM-DD in Jerusalem, `days` from today. */
function isoInDays(days: number): string {
  return jerusalemDay.format(new Date(Date.now() + days * 86_400_000));
}
function spokenDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(d)}.${Number(m)}`;
}
function localSlot(at: Date): string {
  return `${jerusalemDay.format(at)} ${jerusalemClock.format(at)}`;
}

async function seedList(
  account: HarnessAccount,
  listType: "shopping" | "tasks",
  rows: Array<Record<string, string>>,
): Promise<Array<{ id: string; title: string }>> {
  const list = await prisma.employeeList.create({
    data: {
      employeeId: account.employeeId,
      listType,
      name: "",
      scope: "personal",
      visibleTo: [account.employeeId],
    },
    select: { id: true },
  });
  const key = listType === "shopping" ? "שם פריט" : "שם משימה";
  const out: Array<{ id: string; title: string }> = [];
  for (const row of rows) {
    const id = randomUUID();
    await prisma.employeeListItem.create({
      data: {
        id,
        listId: list.id,
        itemKey: row[key]!,
        data: row,
        scope: "personal",
        addedById: account.employeeId,
        visibleTo: [account.employeeId],
      },
    });
    out.push({ id, title: row[key]! });
  }
  return out;
}

function numberedLine(spoken: string, n: number): string {
  const match = spoken.match(new RegExp(`^\\s*${n}[.)]\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? "";
}

async function dentistTask(account: HarnessAccount) {
  const rows = await prisma.employeeListItem.findMany({
    where: {
      deletedAt: null,
      list: { employeeId: account.employeeId, listType: "tasks" },
      // The appointment itself — not a «להזכיר…» follow-up row.
      itemKey: "תור לרופא שיניים",
    },
    select: { id: true, data: true },
  });
  return rows;
}

async function speakerClocks(account: HarnessAccount) {
  return prisma.reminder.findMany({
    where: { userId: account.userId, status: "active" },
    select: { id: true, itemLabel: true, fireAt: true, pingIds: true },
  });
}

async function captureState(account: HarnessAccount) {
  const [tasks, clocks, links] = await Promise.all([
    prisma.employeeListItem.findMany({
      where: { deletedAt: null, itemKey: { contains: "שיניים" }, list: { employee: { userId: account.userId } } },
      select: {
        id: true,
        itemKey: true,
        data: true,
        linkedReminderId: true,
        list: { select: { listType: true, employee: { select: { name: true } } } },
      },
    }),
    prisma.reminder.findMany({
      where: { userId: account.userId },
      select: { id: true, itemLabel: true, status: true, fireAt: true, workerItemId: true },
    }),
    prisma.employeeListItemReminderLink.findMany({
      where: { reminder: { userId: account.userId } },
      select: { listItemId: true, reminderId: true },
    }),
  ]);
  return {
    tasks,
    clocks: clocks.map((row) => ({ ...row, local: localSlot(row.fireAt) })),
    links,
  };
}

describe("live facts per turn (real model, eval-db)", () => {
  let account: HarnessAccount | null = null;
  const perf: TurnPerf[] = [];
  let failure: string | null = null;
  let finalState: unknown = null;

  beforeAll(async () => {
    const key = injectProductEnvKey("OPENAI_API_KEY");
    expect(key.present, "OPENAI_API_KEY required").toBe(true);
    resetEnvCache();
    await assertEvalDbAndGtfsUntouched();
  });

  afterAll(async () => {
    if (account) {
      // Evidence for a failed run: where the clocks are and what they link to.
      finalState = await captureState(account).catch((error) => String(error));
    }
    writeFileSync(
      resolve(process.cwd(), `.tmp-live-facts-perf-${LABEL}.json`),
      JSON.stringify(
        { label: LABEL, at: new Date().toISOString(), failure, finalState, perf },
        null,
        2,
      ),
    );
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    if (account) await cleanupHarnessAccount(account);
  });

  it(
    "multi-turn conversation stays correct and input tokens stop accumulating",
    async () => {
      try {
        await runConversation();
      } catch (error) {
        failure = error instanceof Error ? error.message.slice(0, 2000) : String(error);
        throw error;
      }
    },
    TIMEOUT,
  );

  async function runConversation(): Promise<void> {
    {
      account = await createHarnessAccount("טל");
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
      setLlmClientForTests(null);
      setLlmClientForTests(getLlmClient());

      // Realistic volume: a busy speaker's book (the 28k/turn came from this).
      await seedList(
        account,
        "tasks",
        Array.from({ length: 40 }, (_, i) => ({
          "שם משימה": `משימת רקע מספר ${i + 1} — לבדוק מסמכים ולהתקשר לספק`,
          "תאריך לביצוע": isoInDays(10 + (i % 20)),
          "שעה לביצוע": `${String(8 + (i % 10)).padStart(2, "0")}:00`,
        })),
      );
      const shopping = await seedList(
        account,
        "shopping",
        Array.from({ length: 30 }, (_, i) => ({
          "שם פריט": [
            "חלב", "לחם", "ביצים", "גבינה", "עגבניות", "מלפפונים", "תפוחים",
            "בננות", "אורז", "פסטה", "שמן זית", "סוכר", "קמח", "קפה", "תה",
            "דבש", "טחינה", "חומוס", "יוגורט", "חמאה", "שוקולד", "עוף",
            "דגים", "בצל", "שום", "תפוחי אדמה", "גזר", "לימונים", "מים", "מיץ",
          ][i]!,
          "כמות": "1",
        })),
      );

      const userId = account.userId;
      const employeeId = account.employeeId;
      async function say(text: string): Promise<string> {
        const turn = await sendChatMessage({
          userId,
          employeeId,
          digitalEmployeeId: lucyId,
          message: text,
        });
        const usage = await prisma.llmUsage.findFirst({
          where: { employeeId, purpose: "chat" },
          orderBy: { createdAt: "desc" },
          select: { inputTokens: true, cachedTokens: true, outputTokens: true },
        });
        const spoken = parseLlmReply(turn.reply).response.trim();
        perf.push({
          turn: perf.length + 1,
          say: text,
          inputTokens: usage?.inputTokens ?? 0,
          cachedTokens: usage?.cachedTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          llmMs: turn.timing?.llmMs ?? 0,
          spoken,
        });
        return spoken;
      }

      const day1 = isoInDays(5);
      const day2 = isoInDays(6);

      // 1–2. Add a timed task, then the exact WhatsApp follow-up «שעה לפני».
      await say(`תוסיפי לי משימה: תור לרופא שיניים ב-${spokenDate(day1)} בשעה 10:00`);
      let tasks = await dentistTask(account);
      expect(tasks.length, JSON.stringify(perf.at(-1))).toBe(1);
      expect(JSON.stringify(tasks[0]!.data)).toContain(day1);
      await say("כן, תזכירי לי שעה לפני");
      let clocks = await speakerClocks(account);
      expect(
        clocks.some((row) => localSlot(row.fireAt) === `${day1} 09:00`),
        `clock at ${day1} 09:00: ${JSON.stringify(clocks)} / ${perf.at(-1)?.spoken}`,
      ).toBe(true);

      // 3–5. Show, delete by line number, show again — no stale row.
      const show = await say("מה יש לי ברשימת הקניות?");
      const line2 = numberedLine(show, 2);
      expect(line2, show).not.toBe("");
      const victim = shopping.find((row) => line2.includes(row.title));
      expect(victim, `line 2 «${line2}» maps to a seeded row`).toBeTruthy();
      await say("תמחקי את 2");
      const gone = await prisma.employeeListItem.findUnique({
        where: { id: victim!.id },
        select: { deletedAt: true },
      });
      expect(gone?.deletedAt, perf.at(-1)?.spoken).not.toBeNull();
      const again = await say("מה יש לי ברשימת הקניות?");
      expect(again.split("\n").some((line) => line.includes(victim!.title)), again).toBe(false);

      // 6. Move the task — its clock moves with it (server-side shift).
      await say(`תזיזי את התור לרופא שיניים ל-${spokenDate(day2)} באותה שעה`);
      tasks = await dentistTask(account);
      expect(JSON.stringify(tasks[0]?.data), perf.at(-1)?.spoken).toContain(day2);
      clocks = await speakerClocks(account);
      expect(
        clocks.some((row) => localSlot(row.fireAt) === `${day2} 09:00`),
        `clock moved to ${day2} 09:00: ${JSON.stringify(clocks)}`,
      ).toBe(true);

      // 7–8. Reads after many turns still come from live facts.
      const agenda = await say(`מה יש לי ב-${spokenDate(day2)}?`);
      expect(agenda, agenda).toMatch(/שיניים/);
      await say("הצג תזכורות");

      // Performance: history must not accumulate fact snapshots.
      const inputs = perf.map((row) => row.inputTokens);
      const growth = inputs.slice(1).map((value, i) => value - inputs[i]!);
      const sorted = [...growth].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      console.table(
        perf.map(({ spoken: _s, ...row }) => ({ ...row, say: row.say.slice(0, 30) })),
      );
      console.log(`[${LABEL}] median input growth per turn: ${median}`);
      if (!BASELINE) {
        expect(median, `growth per turn: ${growth.join(", ")}`).toBeLessThan(
          MAX_MEDIAN_GROWTH_PER_TURN,
        );
        // Instructions + replayed history are last turn's exact prefix → cached.
        const cacheRatios = perf.slice(1).map((row) => row.cachedTokens / Math.max(1, row.inputTokens));
        console.log(`[${LABEL}] cached ratio per turn: ${cacheRatios.map((r) => r.toFixed(2)).join(", ")}`);
        const sortedRatios = [...cacheRatios].sort((a, b) => a - b);
        expect(
          sortedRatios[Math.floor(sortedRatios.length / 2)] ?? 0,
          "median cached share of input from turn 2 on",
        ).toBeGreaterThan(MIN_MEDIAN_CACHED_SHARE);
      }
    }
  }
});
