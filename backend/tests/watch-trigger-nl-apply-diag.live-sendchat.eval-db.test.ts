/**
 * DIAGNOSTIC ONLY — NL → Watch → Apply chain on workee_test (:5436).
 * Real sendChatMessage + real model. External facts / web poll = fixtures.
 * WhatsApp mocked. No LIVE. Appends scripts/.tmp-watch-trigger-nl-apply-diag.jsonl
 *
 *   npm run test:eval-db -- tests/watch-trigger-nl-apply-diag.live-sendchat.eval-db.test.ts
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
import * as composeFacts from "../src/services/compose-facts.js";
import * as envConfig from "../src/config/env.js";
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
  "scripts/.tmp-watch-trigger-nl-apply-diag.jsonl",
);
const RUN = randomUUID().slice(0, 8);

function logReport(row: Record<string, unknown>) {
  appendFileSync(REPORT, `${JSON.stringify(row)}\n`, "utf8");
  console.info(JSON.stringify(row, null, 2));
}

/** fireDueReminders returns 0 under NODE_ENV=test — temporarily allow fire. */
async function fireDueForDiag(now = new Date()): Promise<number> {
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

describe(`NL→Watch→Apply diagnostic ${RUN} (workee_test)`, () => {
  let account: HarnessAccount | null = null;
  let lucyId = "";
  let shoppingListId = "";

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
    setWebMonitorPollImplForTests(null);
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
      lucyId = "";
      shoppingListId = "";
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
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": `seed-nl-apply-${RUN}` }],
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
        listType: "shopping",
        deletedAt: null,
      },
      select: { id: true },
    });
    shoppingListId = list.id;

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
    // Do not mock fireDueReminders — Apply proof needs the real worker.
    // New watches are not due yet during NL capture.
    setLlmClientForTests(getLlmClient());

    const say = (message: string) =>
      sendChatMessage({
        userId: account!.userId,
        employeeId: account!.employeeId,
        digitalEmployeeId: lucyId,
        message,
      });

    return { say, runtime };
  }

  function extractShape(replyText: string) {
    const parsed = parseLlmReply(replyText);
    const meta = parsed.metadata ?? parseReplyMetadata(replyText);
    const reminders = meta.reminders ?? [];
    const lists = meta.lists ?? [];
    const watches = reminders.filter(
      (r) => r.composeCondition != null || r.compose,
    );
    const withDeferred = reminders.filter(
      (r) =>
        r.onTriggerActions != null &&
        Array.isArray(r.onTriggerActions.lists) &&
        r.onTriggerActions.lists.length > 0,
    );
    return {
      spoken: parsed.responses?.map((r) => r.text).join("\n") ?? "",
      replyLen: replyText.length,
      reminders,
      lists,
      watches,
      withDeferred,
      composeTypes: watches
        .map((w) => w.composeCondition?.type ?? null)
        .filter(Boolean),
      topLevelListMutates: lists.filter(
        (l) => l.action === "add" || l.action === "update",
      ),
      rawMetaKeys: Object.keys(meta ?? {}),
    };
  }

  it(
    "1) NL market watch with deferred shopping add (prompt example shape)",
    async () => {
      const { say } = await setup();
      const message =
        "כשהמחיר של נייר טואלט בשופרסל יורד מתחת ל־20 שקל, תוסיפי לי לקניות «נייר טואלט».";
      const result = await say(message);
      const shape = extractShape(result.reply ?? "");
      const rows = await prisma.reminder.findMany({
        where: { userId: account!.userId, status: "active" },
      });

      const stage = {
        nl_understood_spoken_or_meta:
          shape.replyLen > 0 || shape.reminders.length > 0,
        model_emitted_watch: shape.watches.length > 0,
        model_emitted_on_trigger: shape.withDeferred.length > 0,
        model_no_immediate_list_mutate: shape.topLevelListMutates.length === 0,
        db_watch_persisted: rows.some((r) => r.composeCondition != null),
        db_on_trigger_persisted: rows.some((r) => r.onTriggerActions != null),
      };

      logReport({
        case: "market_deferred_shopping",
        message,
        stage,
        spokenPreview: shape.spoken.slice(0, 300),
        replyLen: shape.replyLen,
        composeTypes: shape.composeTypes,
        deferredCount: shape.withDeferred.length,
        deferredPackages: shape.withDeferred.map((w) => w.onTriggerActions),
        topLevelListMutates: shape.topLevelListMutates.length,
        dbRows: rows.map((r) => ({
          id: r.id,
          item: r.itemLabel,
          type: parseComposeCondition(r.composeCondition)?.type ?? null,
          onTrigger: r.onTriggerActions != null,
          pkg: parseWatchTriggerPackage(r.onTriggerActions),
        })),
      });

      // Soft: document; hard-fail only if reply completely empty (infra).
      expect(shape.replyLen, "sendChat returned empty reply").toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    "2) NL web_monitor baggage change → deferred task (Scenario C shape)",
    async () => {
      const { say } = await setup();
      const message =
        "אם אל על תשנה את מדיניות הכבודה שלה, תוסיפי לי משימה לבדוק אם צריך לעדכן את ההזמנה.";
      const result = await say(message);
      const shape = extractShape(result.reply ?? "");
      const rows = await prisma.reminder.findMany({
        where: { userId: account!.userId, status: "active" },
      });

      const stage = {
        nl_understood_spoken_or_meta:
          shape.replyLen > 0 || shape.reminders.length > 0,
        model_emitted_watch: shape.watches.length > 0,
        model_emitted_on_trigger: shape.withDeferred.length > 0,
        model_web_monitor: shape.composeTypes.includes("web_monitor"),
        db_watch_persisted: rows.some((r) => r.composeCondition != null),
        db_on_trigger_persisted: rows.some((r) => r.onTriggerActions != null),
        immediate_task: shape.topLevelListMutates.some(
          (l) => l.listType === "tasks" && l.action === "add",
        ),
      };

      logReport({
        case: "web_monitor_deferred_task",
        message,
        stage,
        spokenPreview: shape.spoken.slice(0, 300),
        replyPreview: (result.reply ?? "").slice(0, 800),
        replyLen: shape.replyLen,
        composeTypes: shape.composeTypes,
        remindersMeta: shape.reminders,
        listsMeta: shape.lists,
        deferredCount: shape.withDeferred.length,
        deferredPackages: shape.withDeferred.map((w) => w.onTriggerActions),
        dbRows: rows.map((r) => ({
          id: r.id,
          item: r.itemLabel,
          type: parseComposeCondition(r.composeCondition)?.type ?? null,
          onTrigger: r.onTriggerActions != null,
          pkg: parseWatchTriggerPackage(r.onTriggerActions),
          condition: r.composeCondition,
        })),
      });

      expect(shape.replyLen).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    "3) If DB has deferred package: fixture fire Apply once + no dup (+ unverified block for web_monitor)",
    async () => {
      const { say } = await setup();
      const message =
        "כשהמחיר של חלב תנובה יורד מתחת ל־5 שקל, תוסיפי לי לקניות «חלב תנובה».";
      const result = await say(message);
      const shape = extractShape(result.reply ?? "");

      const allRows = await prisma.reminder.findMany({
        where: { userId: account!.userId, status: "active" },
      });
      let row =
        allRows.find((r) => parseWatchTriggerPackage(r.onTriggerActions)) ??
        null;

      logReport({
        case: "apply_chain_precheck",
        captureSource: row
          ? "model_db_normalized_package"
          : shape.withDeferred.length > 0
            ? "model_meta_not_persisted"
            : shape.watches.length > 0
              ? "watch_without_on_trigger"
              : "none",
        modelDeferred: shape.withDeferred.length,
        modelWatches: shape.watches.length,
        composeTypes: shape.composeTypes,
        spokenPreview: shape.spoken.slice(0, 200),
        dbReminderCount: allRows.length,
      });

      if (!row) {
        logReport({
          case: "apply_chain_skipped",
          reason:
            "No DB Watch with normalized onTriggerActions from NL — failure is at model capture / persist, not Apply engine",
          stageFailed:
            shape.watches.length === 0
              ? "NL→Watch emission"
              : shape.withDeferred.length === 0
                ? "NL→on_trigger_actions emission"
                : "Watch persist / package normalize",
        });
        expect(
          row,
          "model must persist deferred Watch for Apply chain",
        ).toBeTruthy();
        return;
      }

      const pkg = parseWatchTriggerPackage(row.onTriggerActions)!;
      const productTitle = `חלב-diag-${RUN}`;
      const patched = {
        ...pkg,
        actions: pkg.actions.map((a, i) =>
          i === 0
            ? {
                ...a,
                list: {
                  ...a.list,
                  listType: "shopping" as const,
                  listId: shoppingListId,
                  items: [{ "שם פריט": productTitle }],
                  targets: [] as string[],
                },
              }
            : a,
        ),
      };

      await prisma.reminder.update({
        where: { id: row.id },
        data: {
          fireAt: new Date(Date.now() - 120_000),
          sendStatus: "pending",
          status: "active",
          lastReportSha: "market:above",
          onTriggerActions: patched as object,
        },
      });
      row = await prisma.reminder.findUniqueOrThrow({ where: { id: row.id } });
      const cond = parseComposeCondition(row.composeCondition);

      const watchCond = cond;
      logReport({
        case: "apply_watch_condition",
        condition: row.composeCondition,
        type: watchCond?.type ?? null,
      });

      if (watchCond?.type === "web_monitor") {
        // Canned poll isolates Apply after NL capture. detect_change needs a
        // baseline→delta in real poll; here we inject notify+evidence directly.
        const canned = (opts: {
          shouldNotify: boolean;
          grade: "unverified" | "observed";
          fp: string;
          reason?: "unverified" | "no_match";
        }) => ({
          notify: {
            shouldNotify: opts.shouldNotify,
            fingerprint: opts.fp,
            bodyHe: "diag-notify",
            reason: opts.reason,
            item: {
              itemId: opts.fp,
              title: "חלב תנובה",
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
        });

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
        expect(gate.ok === false && gate.reason).toBe("unverified");
        logReport({ case: "unverified_gate_unit", gate });

        setWebMonitorPollImplForTests(async () =>
          canned({
            shouldNotify: true,
            grade: "unverified",
            fp: `fp-unverified-${RUN}`,
            reason: "unverified",
          }),
        );
        const beforeBad = await prisma.employeeListItem.count({
          where: { listId: shoppingListId, deletedAt: null },
        });
        const firedBad = await fireDueForDiag(new Date());
        const afterBad = await prisma.employeeListItem.count({
          where: { listId: shoppingListId, deletedAt: null },
        });
        const afterBadRow = await prisma.reminder.findUniqueOrThrow({
          where: { id: row.id },
        });
        logReport({
          case: "unverified_blocks_apply",
          firedCount: firedBad,
          itemsBefore: beforeBad,
          itemsAfter: afterBad,
          sendStatus: afterBadRow.sendStatus,
          fireAt: afterBadRow.fireAt,
          ledger: parseWatchTriggerExecLedger(afterBadRow.onTriggerExec),
        });
        expect(afterBad).toBe(beforeBad);

        await prisma.reminder.update({
          where: { id: row.id },
          data: {
            fireAt: new Date(Date.now() - 60_000),
            sendStatus: "pending",
            status: "active",
          },
        });
        setWebMonitorPollImplForTests(async () =>
          canned({
            shouldNotify: true,
            grade: "observed",
            fp: `fp-verified-${RUN}`,
          }),
        );
      } else {
        vi.spyOn(composeFacts, "loadComposeFacts").mockResolvedValue({
          kind: "market",
          fixedBody: "DIAG.TICKER = 4",
          eval: { marketPrice: 4 },
          advanceLastReportSha: false,
          headSha: "",
        } as never);
      }

      const before = await prisma.employeeListItem.count({
        where: { listId: shoppingListId, deletedAt: null },
      });
      const firedCount = await fireDueForDiag(new Date());
      const after = await prisma.employeeListItem.findMany({
        where: { listId: shoppingListId, deletedAt: null },
        select: { data: true },
      });
      const added = after.filter(
        (r) =>
          String((r.data as Record<string, unknown>)["שם פריט"] ?? "") ===
          productTitle,
      );
      const fired = await prisma.reminder.findUniqueOrThrow({
        where: { id: row.id },
      });
      const ledger1 = parseWatchTriggerExecLedger(fired.onTriggerExec);

      logReport({
        case: "verified_apply_once",
        firedCount,
        itemsBefore: before,
        addedCount: added.length,
        allTitles: after.map(
          (r) => (r.data as Record<string, unknown>)["שם פריט"],
        ),
        ledger: ledger1,
        pkg: parseWatchTriggerPackage(fired.onTriggerActions),
        sendStatus: fired.sendStatus,
        conditionType: cond?.type ?? null,
      });
      expect(added.length).toBe(1);

      await prisma.reminder.update({
        where: { id: row.id },
        data: {
          fireAt: new Date(Date.now() - 30_000),
          sendStatus: "pending",
          status: "active",
        },
      });
      await fireDueForDiag(new Date());
      const afterDup = await prisma.employeeListItem.findMany({
        where: { listId: shoppingListId, deletedAt: null },
        select: { data: true },
      });
      const addedDup = afterDup.filter(
        (r) =>
          String((r.data as Record<string, unknown>)["שם פריט"] ?? "") ===
          productTitle,
      );
      const fired2 = await prisma.reminder.findUniqueOrThrow({
        where: { id: row.id },
      });
      logReport({
        case: "idempotent_second_fire",
        addedCount: addedDup.length,
        ledger: parseWatchTriggerExecLedger(fired2.onTriggerExec),
      });
      expect(addedDup.length).toBe(1);
    },
    TIMEOUT,
  );
});
