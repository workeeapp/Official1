/**
 * E2E: engine day-show button after dated *tasks* add → click via
 * sendChatMessage with real OpenAI (no engine dump enforcement).
 * Dates are tasks-only for now.
 *
 * Run: npm run test:eval-db -- tests/dated-day-show-click.live-sendchat.eval-db.test.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  emptyLlmMetadata,
  parseLlmReply,
  parseReplyMetadata,
  readSpokenBubbles,
} from "@workee/shared";
import { resetEnvCache } from "../src/config/env.js";
import { prisma } from "../src/database/prisma.js";
import { setLlmClientForTests, getLlmClient } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { applyEmployeeRecords } from "../src/services/employee-records.service.js";
import { datedDayShowButtonForMutation } from "../src/services/employee-targets.service.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import { jerusalemYmd } from "../src/utils/relative-date.js";
import {
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  injectProductEnvKey,
  stubLlmReply,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

function loadLucyInstructions(): string {
  const path = resolve(process.cwd(), "..", "LLM.config.json");
  expect(existsSync(path), path).toBe(true);
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    systemMessage: string[];
  };
  return raw.systemMessage.join("\n");
}

function tomorrowYmd(now = new Date()): string {
  const today = jerusalemYmd(now);
  const [y, m, d] = today.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + 1));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function bubbleButtons(reply: string): Array<{ label: string; command: string }> {
  const parsed = parseLlmReply(reply);
  const fromBubbles = readSpokenBubbles(parsed).flatMap((b) => b.buttons ?? []);
  if (fromBubbles.length > 0) {
    return fromBubbles.map((b) => ({ label: b.label, command: b.command }));
  }
  return (parsed.buttons ?? []).map((b) => ({
    label: b.label,
    command: b.command,
  }));
}

describe("dated day-show click LIVE sendChat (model path)", () => {
  let account: HarnessAccount | null = null;
  const now = new Date();
  const tomorrow = tomorrowYmd(now);
  const marker = `dds-${Date.now().toString(36)}`;

  beforeAll(() => {
    const key = injectProductEnvKey("OPENAI_API_KEY");
    expect(key.present, "OPENAI_API_KEY required for this LIVE probe").toBe(
      true,
    );
    resetEnvCache();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  async function setupLucy(): Promise<{ account: HarnessAccount; lucyId: string }> {
    const acc = await createHarnessAccount("טל");
    const lucyId = await ensureLucy(acc, loadLucyInstructions());
    await prisma.employee.update({
      where: { id: lucyId },
      data: {
        instructions: loadLucyInstructions(),
        model: "gpt-4.1-mini",
        temperature: 0,
      },
    });
    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue({
      ok: true as const,
      messageId: "dds",
    });
    vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(undefined);
    vi.spyOn(reminderFire, "scheduleSoon").mockReturnValue(undefined);
    return { account: acc, lucyId };
  }

  /** Stub createConversation ids are not valid OpenAI ids — drop thread before LIVE. */
  async function resetThreadForLive(userId: string) {
    await prisma.chatMessage
      .deleteMany({ where: { conversation: { userId } } })
      .catch(() => undefined);
    await prisma.chatConversation
      .deleteMany({ where: { userId } })
      .catch(() => undefined);
    setLlmClientForTests(null);
    setLlmClientForTests(getLlmClient());
  }

  it(
    "tasks: button after add → LIVE click day dump excludes shopping + other day",
    async () => {
      const setup = await setupLucy();
      account = setup.account;
      const target = `פגישה-${marker}`;
      const distractor = `חלב-זר-${marker}`;
      const otherDayTask = `פגישה-אתמול-${marker}`;
      await applyEmployeeRecords(
        account.employeeId,
        {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "add",
              listType: "shopping",
              listName: "",
              targets: [],
              items: [
                {
                  "שם פריט": distractor,
                  "תאריך לביצוע": tomorrow,
                },
              ],
            },
            {
              action: "add",
              listType: "tasks",
              listName: "",
              targets: [],
              items: [
                {
                  "שם משימה": otherDayTask,
                  "תאריך לביצוע": jerusalemYmd(now),
                },
              ],
            },
          ],
        },
        {
          scope: "personal",
          addedById: account.employeeId,
          visibleTo: [account.employeeId],
        },
        account.employeeId,
      );

      const expectedBtn = datedDayShowButtonForMutation(
        { calendarYmd: tomorrow, listType: "tasks" },
        now,
      );
      expect(expectedBtn).toEqual({
        label: "מה מחר",
        command: "מה יש לי מחר ברשימת משימות",
      });
      expect(
        datedDayShowButtonForMutation(
          { calendarYmd: tomorrow, listType: "shopping" },
          now,
        ),
      ).toBeNull();

      setLlmClientForTests(
        stubLlmReply({
          responses: [{ text: "הוספתי משימה.", buttons: [] }],
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "tasks",
                list_name: "",
                items: [
                  {
                    "שם משימה": target,
                    "תאריך לביצוע": tomorrow,
                  },
                ],
                targets: [],
              },
            ],
          },
        }),
      );
      const addTurn = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: setup.lucyId,
        message: `תוסיפי משימה ${target} למחר`,
      });
      const dayBtn = bubbleButtons(addTurn.reply).find(
        (b) => b.command === expectedBtn!.command,
      );
      expect(dayBtn, JSON.stringify(bubbleButtons(addTurn.reply))).toBeTruthy();

      await resetThreadForLive(account.userId);
      const click = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: setup.lucyId,
        message: dayBtn!.command,
      });
      const spoken = parseLlmReply(click.reply).response;
      const meta = parseReplyMetadata(click.reply);
      // eslint-disable-next-line no-console
      console.log(
        "DATED_DAY_SHOW_CLICK_REPORT\n" +
          JSON.stringify(
            {
              listKind: "tasks",
              button: dayBtn,
              showDump: meta.showDump ?? null,
              showDumpFrom: meta.showDumpFrom ?? null,
              showDumpTo: meta.showDumpTo ?? null,
              showDumpAbout: meta.showDumpAbout ?? null,
              spoken,
              hasTarget: spoken.includes(target),
              hasDistractor: spoken.includes(distractor),
              hasOtherDayTask: spoken.includes(otherDayTask),
            },
            null,
            2,
          ),
      );
      expect(spoken.includes(target), spoken).toBe(true);
      expect(spoken.includes(distractor), spoken).toBe(false);
      expect(
        spoken.includes(otherDayTask),
        `same-list other-day must not appear; got: ${spoken}`,
      ).toBe(false);
    },
    180_000,
  );
});
