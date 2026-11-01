/**
 * Final-QA gap probe (eval-db + real OpenAI via product .env).
 * Not a product change — measurement only. Stub WA outbound.
 */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyLlmMetadata,
  parseLlmReply,
  parseReplyMetadata,
} from "@workee/shared";
import { resetEnvCache } from "../src/config/env.js";
import { prisma } from "../src/database/prisma.js";
import { setLlmClientForTests, getLlmClient } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import * as employeeRecords from "../src/services/employee-records.service.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  injectProductEnvKey,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

type Row = Record<string, unknown>;
const rows: Row[] = [];

function wrapClient(base: ReturnType<typeof getLlmClient>) {
  let createResponse = 0;
  let createConversation = 0;
  return {
    counts: () => ({ createResponse, createConversation }),
    client: {
      createConversation: async (...args: unknown[]) => {
        createConversation += 1;
        return (base.createConversation as Function)(...args);
      },
      createResponse: async (...args: unknown[]) => {
        createResponse += 1;
        return (base.createResponse as Function)(...args);
      },
      appendAssistantMessage: base.appendAssistantMessage?.bind(base),
    },
  };
}

function shoppingTexts(snapshot: employeeRecords.EmployeeRecordSnapshot): string[] {
  const out: string[] = [];
  for (const list of snapshot.lists ?? []) {
    if (list.list_type !== "shopping") continue;
    for (const item of list.items ?? []) {
      const rec = item as Record<string, unknown>;
      const t = String(
        rec["שם פריט"] ?? rec["שם"] ?? rec.name ?? rec.title ?? "",
      ).trim();
      if (t) out.push(t);
    }
  }
  return out;
}

describe("Result-flow gap LIVE sendChat (eval-db + OpenAI)", () => {
  let account: HarnessAccount;
  let lucyId: string;
  const marker = `gap-${randomUUID().slice(0, 8)}`;
  const itemName = `אורז-${marker}`;

  beforeEach(async () => {
    const key = injectProductEnvKey("OPENAI_API_KEY");
    expect(key.present).toBe(true);
    resetEnvCache();
    setLlmClientForTests(null);

    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue({
      ok: true as const,
      messageId: "gap",
    });
    vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(undefined);

    account = await createHarnessAccount("טל");
    lucyId = await ensureLucy(account);
    await employeeRecords.applyEmployeeRecords(
      account.employeeId,
      {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            targets: [],
            items: [{ "שם פריט": `בסיס-${marker}` }],
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
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    if (account?.userId) await cleanupHarnessAccount(account);
  });

  it(
    "mutate+show, failed delete, intervening continuity",
    async () => {
      const real = getLlmClient();

      async function turn(label: string, message: string) {
        const wrapped = wrapClient(real);
        setLlmClientForTests(wrapped.client as never);
        const t0 = performance.now();
        const result = await sendChatMessage({
          userId: account.userId,
          employeeId: account.employeeId,
          digitalEmployeeId: lucyId,
          message,
        });
        const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
        const parsed = parseLlmReply(result.reply);
        const spoken = parsed.response ?? "";
        const meta = parseReplyMetadata(result.reply);
        const row = {
          label,
          message,
          latencyMs,
          llmCreateResponse: wrapped.counts().createResponse,
          response: spoken,
          actions: parsed.actions ?? [],
          showDump: meta.showDump ?? null,
          lists: (meta.lists ?? []).map((r) => ({
            action: r.action,
            listType: r.listType,
            n: r.items?.length ?? 0,
          })),
          successClaim: /הוספתי|מחקתי|עדכנתי|תייקתי|שמרתי/.test(spoken),
          hasDumpFormat: /🛒|קניות:/.test(spoken),
          mentionsNewItem: spoken.includes(itemName) || spoken.includes("אורז"),
          mentionsBase: spoken.includes(`בסיס-${marker}`),
        };
        rows.push(row);
        return row;
      }

      // 1) mutate + show same turn
      const ms = await turn(
        "mutate_show_same_turn",
        `תוסיפי ${itemName} לקניות ותראי לי את רשימת הקניות`,
      );
      const db = shoppingTexts(
        await employeeRecords.getEmployeeRecordSnapshot(account.employeeId),
      );
      rows.push({
        label: "db_after_mutate_show",
        shoppingItemTexts: db,
        dbHasNewItem: db.some((t) => t.includes("אורז") && t.includes(marker)),
        dbHasBase: db.some((t) => t.includes(`בסיס-${marker}`)),
      });

      // 2) failed / miss delete
      const fail = await turn(
        "failed_delete_missing_item",
        "תמחק מהקניות את האבוקדו-שלא-קיים-xyz999",
      );
      if (/מחקתי/.test(String(fail.response)) && /אבוקדו/.test(String(fail.response))) {
        rows.push({
          label: "FAILED_FALSE_SUCCESS",
          detail: String(fail.response).slice(0, 300),
        });
      }

      // 3) intervening automated Lucy between reminder draft turns
      await turn("continuity_start_ask", "תזכירי לי לקנות חלב");
      const conv = await prisma.chatConversation.findFirst({
        where: {
          userId: account.userId,
          employeeId: account.employeeId,
          digitalEmployeeId: lucyId,
        },
      });
      const injectText =
        "בינתיים — קיבלתי עדכון מערכת. כשתהיה מוכן, המשך.";
      if (conv) {
        await prisma.chatMessage.create({
          data: {
            conversationId: conv.id,
            author: "assistant",
            speaker: "לוסי",
            text: injectText,
          },
        });
        try {
          await real.appendAssistantMessage?.(
            conv.openaiConversationId,
            injectText,
          );
        } catch {
          rows.push({ label: "inject_openai_memory_failed" });
        }
      } else {
        rows.push({ label: "conversation_missing_for_inject" });
      }
      const cont = await turn("continuity_after_intervening", "מחר ב־09:00");

      const dbAfter = rows.find((r) => r.label === "db_after_mutate_show");
      const falseSuccess = rows.some((r) => r.label === "FAILED_FALSE_SUCCESS");
      // eslint-disable-next-line no-console
      console.log(
        "RESULT_FLOW_GAP_LIVE_REPORT\n" +
          JSON.stringify(
            {
              marker,
              itemName,
              mutateShow: ms,
              dbAfter,
              failedDelete: fail,
              continuity: cont,
              falseSuccessClaim: falseSuccess,
              baselineComparison: null,
              all: rows,
            },
            null,
            2,
          ),
      );

      // Keep the run green for harness health; scenario verdicts are in the report.
      expect(ms.llmCreateResponse).toBeGreaterThanOrEqual(1);
      expect(ms.hasDumpFormat).toBe(true);
      expect(falseSuccess).toBe(false);
      void dbAfter;
    },
    300_000,
  );
});
