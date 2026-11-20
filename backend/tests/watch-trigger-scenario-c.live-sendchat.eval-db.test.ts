/**
 * Scenario C — NL → Watch → Apply on workee_test (:5436).
 * Real sendChatMessage + real model. External poll = fixtures. WhatsApp mocked.
 *
 *   npm run test:eval-db -- tests/watch-trigger-scenario-c.live-sendchat.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  emptyLlmMetadata,
  parseComposeCondition,
  parseLlmReply,
  parseReplyMetadata,
} from "@workee/shared";
import { getEnv, resetEnvCache } from "../src/config/env.js";
import * as envConfig from "../src/config/env.js";
import { loadLlmConfig } from "../src/config/llm.js";
import { prisma } from "../src/database/prisma.js";
import {
  getLlmClient,
  setLlmClientForTests,
} from "../src/services/llm-client.js";
import {
  buildLucyInstructions,
  sendChatMessage,
} from "../src/services/chat.service.js";
import { listEmployeesForUser } from "../src/services/employee.service.js";
import { applyEmployeeRecords } from "../src/services/employee-records.service.js";
import { setWebMonitorPollImplForTests } from "../src/services/reminder-fire.js";
import { uwmApplyGate } from "../src/services/uwm-apply-gate.js";
import {
  parseWatchTriggerExecLedger,
  parseWatchTriggerPackage,
} from "../src/services/watch-trigger-actions.service.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  injectProductEnvKey,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

const TIMEOUT = 360_000;
const REPORT = resolve(
  process.cwd(),
  "scripts/.tmp-watch-trigger-scenario-c.jsonl",
);
const RUN = randomUUID().slice(0, 8);
const MESSAGE =
  "אם אל על תשנה את מדיניות הכבודה שלה, תוסיפי לי משימה לבדוק אם צריך לעדכן את ההזמנה.";

function logReport(row: Record<string, unknown>) {
  appendFileSync(REPORT, `${JSON.stringify(row)}\n`, "utf8");
  console.info(JSON.stringify(row, null, 2));
}

async function fireDueForEval(now = new Date()): Promise<number> {
  const baseline = envConfig.getEnv();
  const spy = vi.spyOn(envConfig, "getEnv").mockReturnValue({
    ...baseline,
    NODE_ENV: "development",
    WHATSAPP_ACCESS_TOKEN: "test-token",
    WHATSAPP_PHONE_NUMBER_ID: "test-phone-id",
  });
  try {
    return await reminderFire.fireDueReminders(now);
  } finally {
    spy.mockRestore();
  }
}

function cannedPoll(opts: {
  shouldNotify: boolean;
  grade: "unverified" | "observed";
  fp: string;
  reason?: "unverified" | "no_match";
}) {
  return {
    notify: {
      shouldNotify: opts.shouldNotify,
      fingerprint: opts.fp,
      bodyHe: "scenario-c-notify",
      reason: opts.reason,
      item: {
        itemId: opts.fp,
        title: "מדיניות כבודה אל על",
        contentFp: opts.fp,
        confidence: 0.9,
        retrievedAt: new Date().toISOString(),
        verified: opts.grade === "observed",
        evidenceGrade: opts.grade,
        provenance: [],
        retrievalOk: opts.grade === "observed",
      },
    },
    monitorState: {
      version: 1 as const,
      items: {},
      boundSources: [],
      nextPrecise: null,
    },
    discoveryUsed: true,
    boundPageUsed: false,
    itemsFound: 1,
    itemsMatched: 1,
    nextPrecise: null,
  };
}

describe(`Scenario C NL→Watch→Apply ${RUN} (workee_test)`, () => {
  let account: HarnessAccount | null = null;
  let lucyId = "";
  let tasksListId = "";

  beforeAll(async () => {
    const key = injectProductEnvKey("OPENAI_API_KEY");
    expect(key.present, "OPENAI_API_KEY required").toBe(true);
    resetEnvCache();
    await assertEvalDbAndGtfsUntouched();
    const url = new URL(process.env.DATABASE_URL!);
    expect(url.port).toBe("5436");
    expect(url.pathname.endsWith("/workee_test")).toBe(true);
    // silence unused import lint for getEnv re-export path
    expect(typeof getEnv).toBe("function");
  });

  afterEach(async () => {
    setWebMonitorPollImplForTests(null);
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
      lucyId = "";
      tasksListId = "";
    }
  });

  async function setup() {
    account = await createHarnessAccount("טל");
    await prisma.employee.update({
      where: { id: account.employeeId },
      data: { addressGender: "male" },
    });
    const seeded = loadLlmConfig();
    const lucy = await prisma.employee.create({
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
    lucyId = lucy.id;

    await applyEmployeeRecords(
      account.employeeId,
      {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [{ "שם משימה": `seed-c-${RUN}` }],
            targets: [],
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
    const list = await prisma.employeeList.findFirstOrThrow({
      where: {
        employeeId: account.employeeId,
        listType: "tasks",
        deletedAt: null,
      },
      select: { id: true },
    });
    tasksListId = list.id;

    const employees = await listEmployeesForUser(account.userId);
    const digital = employees.find((e) => e.id === lucyId)!;
    const speaker = employees.find((e) => e.id === account!.employeeId)!;
    const runtime = buildLucyInstructions({
      digital,
      employees,
      speaker: speaker.name,
      speakerIsOwner: true,
      guestSpeaker: false,
      pendingInvite: null,
      consultFrom: "",
    });
    expect(runtime.includes("WATCH DEFERRED ACTIONS (P0)")).toBe(true);
    expect(runtime.includes("WEB MONITOR (open-domain")).toBe(true);

    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent");
    vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent");
    vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => {});
    setLlmClientForTests(getLlmClient());

    return () =>
      sendChatMessage({
        userId: account!.userId,
        employeeId: account!.employeeId,
        digitalEmployeeId: lucyId,
        message: MESSAGE,
      });
  }

  it(
    "NL creates deferred web_monitor Watch; unverified blocks Apply; observed applies once",
    async () => {
      const say = await setup();
      const result = await say();
      const parsed = parseLlmReply(result.reply ?? "");
      const meta = parsed.metadata ?? parseReplyMetadata(result.reply ?? "");
      const reminders = meta.reminders ?? [];
      const withDeferred = reminders.filter(
        (r) =>
          r.onTriggerActions != null &&
          Array.isArray(r.onTriggerActions.lists) &&
          r.onTriggerActions.lists.length > 0,
      );

      const rows = await prisma.reminder.findMany({
        where: { userId: account!.userId, status: "active" },
      });
      const row =
        rows.find((r) => parseWatchTriggerPackage(r.onTriggerActions)) ?? null;

      logReport({
        stage: "capture",
        replyLen: (result.reply ?? "").length,
        modelDeferred: withDeferred.length,
        modelComposeTypes: reminders
          .map((r) => r.composeCondition?.type ?? null)
          .filter(Boolean),
        dbCount: rows.length,
        persisted: row
          ? {
              id: row.id,
              type: parseComposeCondition(row.composeCondition)?.type ?? null,
              pkg: parseWatchTriggerPackage(row.onTriggerActions),
            }
          : null,
        skipHint: /לא נשמרה/.test(result.reply ?? "") ? "persist_skip_in_reply" : null,
      });

      expect(
        withDeferred.length,
        "model must emit on_trigger_actions",
      ).toBeGreaterThan(0);
      expect(
        row,
        "Watch with normalized onTriggerActions must persist to DB",
      ).toBeTruthy();
      expect(parseComposeCondition(row!.composeCondition)?.type).toBe(
        "web_monitor",
      );

      const pkg = parseWatchTriggerPackage(row!.onTriggerActions)!;
      expect(pkg.actions.length).toBeGreaterThan(0);
      expect(pkg.actions[0]!.list.listType).toBe("tasks");

      const taskTitle = `בדיקת-כבודה-${RUN}`;
      const patched = {
        ...pkg,
        actions: pkg.actions.map((a, i) =>
          i === 0
            ? {
                ...a,
                list: {
                  ...a.list,
                  listType: "tasks" as const,
                  listId: tasksListId,
                  items: [{ "שם משימה": taskTitle }],
                  targets: [] as string[],
                },
              }
            : a,
        ),
      };

      await prisma.reminder.update({
        where: { id: row!.id },
        data: {
          fireAt: new Date(Date.now() - 120_000),
          sendStatus: "pending",
          status: "active",
          onTriggerActions: patched as object,
        },
      });

      // Unverified — must not Apply
      const gate = uwmApplyGate({
        webMonitor: {
          shouldNotify: true,
          fingerprint: `fp-unverified-${RUN}`,
          evidenceGrade: "unverified",
          retrievedAt: new Date().toISOString(),
          stale: false,
        },
      } as never);
      expect(gate.ok).toBe(false);

      setWebMonitorPollImplForTests(async () =>
        cannedPoll({
          shouldNotify: true,
          grade: "unverified",
          fp: `fp-unverified-${RUN}`,
          reason: "unverified",
        }),
      );
      const beforeBad = await prisma.employeeListItem.count({
        where: { listId: tasksListId, deletedAt: null },
      });
      const firedBad = await fireDueForEval(new Date());
      const afterBad = await prisma.employeeListItem.count({
        where: { listId: tasksListId, deletedAt: null },
      });
      const afterBadRow = await prisma.reminder.findUniqueOrThrow({
        where: { id: row!.id },
      });
      const ledgerBad = parseWatchTriggerExecLedger(afterBadRow.onTriggerExec);
      const unverifiedEvent = ledgerBad.events[`fp-unverified-${RUN}`];
      logReport({
        stage: "unverified",
        firedBad,
        beforeBad,
        afterBad,
        ledger: ledgerBad,
      });
      expect(afterBad).toBe(beforeBad);
      expect(unverifiedEvent).toBeTruthy();
      const blockedStatuses = Object.values(unverifiedEvent!.actions);
      expect(blockedStatuses.length).toBeGreaterThan(0);
      expect(
        blockedStatuses.every(
          (s) =>
            s.status === "failed" &&
            String(s.lastError ?? "").startsWith("gate:"),
        ),
      ).toBe(true);

      // Observed — Apply once
      await prisma.reminder.update({
        where: { id: row!.id },
        data: {
          fireAt: new Date(Date.now() - 60_000),
          sendStatus: "pending",
          status: "active",
        },
      });
      setWebMonitorPollImplForTests(async () =>
        cannedPoll({
          shouldNotify: true,
          grade: "observed",
          fp: `fp-verified-${RUN}`,
        }),
      );
      const beforeOk = await prisma.employeeListItem.count({
        where: { listId: tasksListId, deletedAt: null },
      });
      const firedOk = await fireDueForEval(new Date());
      const afterOk = await prisma.employeeListItem.findMany({
        where: { listId: tasksListId, deletedAt: null },
        select: { data: true },
      });
      const added = afterOk.filter(
        (r) =>
          String((r.data as Record<string, unknown>)["שם משימה"] ?? "") ===
          taskTitle,
      );
      const firedRow = await prisma.reminder.findUniqueOrThrow({
        where: { id: row!.id },
      });
      const ledgerOk = parseWatchTriggerExecLedger(firedRow.onTriggerExec);
      logReport({
        stage: "observed_apply",
        firedOk,
        beforeOk,
        addedCount: added.length,
        ledger: ledgerOk,
      });
      expect(added.length).toBe(1);
      // Gate-blocked fingerprint must stay failed — not recovered into Apply.
      const stillBlocked = ledgerOk.events[`fp-unverified-${RUN}`];
      expect(
        Object.values(stillBlocked?.actions ?? {}).every(
          (s) =>
            s.status === "failed" &&
            String(s.lastError ?? "").startsWith("gate:"),
        ),
      ).toBe(true);
      const verifiedEvent = ledgerOk.events[`fp-verified-${RUN}`];
      expect(
        Object.values(verifiedEvent?.actions ?? {}).some(
          (s) => s.status === "done",
        ),
      ).toBe(true);

      // Second fire — no duplicate
      await prisma.reminder.update({
        where: { id: row!.id },
        data: {
          fireAt: new Date(Date.now() - 30_000),
          sendStatus: "pending",
          status: "active",
        },
      });
      await fireDueForEval(new Date());
      const afterDup = await prisma.employeeListItem.findMany({
        where: { listId: tasksListId, deletedAt: null },
        select: { data: true },
      });
      const addedDup = afterDup.filter(
        (r) =>
          String((r.data as Record<string, unknown>)["שם משימה"] ?? "") ===
          taskTitle,
      );
      const ledgerDup = parseWatchTriggerExecLedger(
        (
          await prisma.reminder.findUniqueOrThrow({ where: { id: row!.id } })
        ).onTriggerExec,
      );
      logReport({
        stage: "idempotent",
        addedCount: addedDup.length,
        ledger: ledgerDup,
      });
      expect(addedDup.length).toBe(1);
    },
    TIMEOUT,
  );
});
