/**
 * Create-turn bootstrap — real model + real Web Search via sendChatMessage.
 * Exact original phrase. No fixture / searchImpl. WhatsApp mocked. workee_test.
 *
 *   npm run test:eval-db -- tests/uwm-create-bootstrap-real.live-sendchat.eval-db.test.ts
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  parseComposeCondition,
  parseLlmReply,
  parseReplyMetadata,
} from "@workee/shared";
import { resetEnvCache } from "../src/config/env.js";
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
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import * as externalLookup from "../src/services/external-lookup.service.js";
import * as uwmBootstrap from "../src/services/uwm-create-bootstrap.js";
import { dualFireAt } from "../src/services/uwm-schedule.js";
import { parseMonitorState } from "../src/services/semantic-web-monitor.service.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  injectProductEnvKey,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

const TIMEOUT = 300_000;
const PHRASE =
  "בדקי מתי המשחק הבא של ריאל מדריד ותזכירי לי שעה לפני כן.";
const REPORT = resolve(
  process.cwd(),
  "scripts/.tmp-uwm-create-bootstrap-real-report.jsonl",
);

function logReport(row: Record<string, unknown>) {
  appendFileSync(REPORT, `${JSON.stringify(row)}\n`, "utf8");
  console.info(JSON.stringify(row, null, 2));
}

type ReminderSnap = {
  id: string;
  status: string;
  fireAt: string;
  itemLabel: string;
  monitorState: unknown;
  nextPrecise: unknown;
  lastErrorClass: unknown;
  objectives: unknown;
};

function snapReminder(row: {
  id: string;
  status: string;
  fireAt: Date;
  itemLabel: string;
  monitorState: unknown;
  composeCondition: unknown;
}): ReminderSnap {
  const state = parseMonitorState(row.monitorState);
  const cond = parseComposeCondition(row.composeCondition);
  return {
    id: row.id,
    status: row.status,
    fireAt: row.fireAt.toISOString(),
    itemLabel: row.itemLabel,
    monitorState: row.monitorState,
    nextPrecise: state.nextPrecise ?? null,
    lastErrorClass: state.lastErrorClass ?? null,
    objectives:
      cond?.type === "web_monitor" ? cond.objectives : null,
  };
}

describe("UWM create-turn bootstrap REAL model+web (workee_test)", () => {
  let account: HarnessAccount | null = null;
  let lucyId = "";

  beforeAll(async () => {
    const key = injectProductEnvKey("OPENAI_API_KEY");
    expect(key.present, "OPENAI_API_KEY required for real model+web").toBe(
      true,
    );
    resetEnvCache();
    await assertEvalDbAndGtfsUntouched();
    const url = new URL(process.env.DATABASE_URL!);
    expect(url.port).toBe("5436");
    expect(url.pathname.endsWith("/workee_test")).toBe(true);
  });

  afterEach(async () => {
    uwmBootstrap.setUwmCreateBootstrapSearchImplForTests(null);
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
      lucyId = "";
    }
  });

  it(
    "Real Madrid next-match + remind 1h — create-turn bootstrap e2e",
    async () => {
      // Guarantee no fixture path from prior suites.
      uwmBootstrap.setUwmCreateBootstrapSearchImplForTests(null);

      account = await createHarnessAccount("טל");
      const phone = `+1557${Date.now().toString().slice(-7)}`;
      await prisma.employee.update({
        where: { id: account.employeeId },
        data: { addressGender: "male", phone },
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
      expect(runtime.includes("CREATE-TURN TIMED REMINDER")).toBe(true);

      vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent");
      vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent");
      vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0);
      vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => {});
      setLlmClientForTests(getLlmClient());

      const webSearchCalls: Array<{
        query: string;
        cacheHit: boolean;
        quotaBlocked: boolean;
        textPreview: string;
        sources: string[];
        hadSearchImpl: boolean;
      }> = [];
      const cachedOrig = externalLookup.cachedHostedWebSearch.bind(
        externalLookup,
      );
      vi.spyOn(externalLookup, "cachedHostedWebSearch").mockImplementation(
        async (opts) => {
          const result = await cachedOrig(opts);
          webSearchCalls.push({
            query: opts.query,
            cacheHit: result.cacheHit,
            quotaBlocked: Boolean(result.quotaBlocked),
            textPreview: String(result.payload?.text ?? "").slice(0, 600),
            sources: (result.payload?.sources ?? []).slice(0, 8),
            hadSearchImpl: typeof opts.searchImpl === "function",
          });
          return result;
        },
      );

      const bootSnaps: Array<{
        before: ReminderSnap | null;
        after: ReminderSnap | null;
        result: Awaited<
          ReturnType<typeof uwmBootstrap.bootstrapWebMonitorCreateTurn>
        >;
      }> = [];
      const bootOrig =
        uwmBootstrap.bootstrapWebMonitorCreateTurn.bind(uwmBootstrap);
      vi.spyOn(uwmBootstrap, "bootstrapWebMonitorCreateTurn").mockImplementation(
        async (input) => {
          const beforeRow = await prisma.reminder.findUnique({
            where: { id: input.reminderId },
          });
          const before = beforeRow ? snapReminder(beforeRow) : null;
          const result = await bootOrig(input);
          const afterRow = await prisma.reminder.findUnique({
            where: { id: input.reminderId },
          });
          const after = afterRow ? snapReminder(afterRow) : null;
          bootSnaps.push({ before, after, result });
          return result;
        },
      );

      const t0 = Date.now();
      const chat = await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: PHRASE,
      });
      const ms = Date.now() - t0;

      const parsed = parseLlmReply(chat.reply ?? "");
      const meta = parsed.metadata ?? parseReplyMetadata(chat.reply ?? "");
      // Prefer structured responses; fall back to raw reply JSON text fields.
      let spoken =
        parsed.responses?.map((r) => r.text).filter(Boolean).join("\n") ?? "";
      if (!spoken.trim()) {
        try {
          const raw = JSON.parse(String(chat.reply ?? ""));
          const texts = Array.isArray(raw?.responses)
            ? raw.responses.map((r: { text?: string }) => r?.text ?? "")
            : [];
          spoken = texts.filter(Boolean).join("\n");
        } catch {
          spoken = String(chat.reply ?? "");
        }
      }
      const modelReminders = meta.reminders ?? [];
      const modelWatches = modelReminders.filter(
        (r) => r.composeCondition != null || r.compose,
      );
      const modelWeb = modelWatches
        .map((w) => w.composeCondition)
        .filter((c) => c?.type === "web_monitor");

      const rows = await prisma.reminder.findMany({
        where: { userId: account.userId },
        orderBy: { createdAt: "asc" },
      });
      const active = rows.filter((r) => r.status === "active");
      const webRows = active
        .map((r) => ({ row: r, cond: parseComposeCondition(r.composeCondition) }))
        .filter((x) => x.cond?.type === "web_monitor");

      const boot = bootSnaps[0] ?? null;
      const after = boot?.after ?? (webRows[0] ? snapReminder(webRows[0].row) : null);
      const nextPrecise = (after?.nextPrecise ?? null) as {
        eventAtIso?: string;
        fireAtIso?: string;
        minutesBefore?: number;
      } | null;

      let dualIso: string | null = null;
      if (nextPrecise?.fireAtIso && after?.fireAt) {
        const discoveryPlaceholder = new Date(after.fireAt);
        const dual = dualFireAt(
          discoveryPlaceholder,
          {
            itemId: "x",
            objectiveId: "p1",
            minutesBefore: nextPrecise.minutesBefore ?? 60,
            fireAtIso: nextPrecise.fireAtIso,
            eventAtIso: nextPrecise.eventAtIso ?? "",
          },
          new Date(),
        );
        dualIso = dual?.toISOString() ?? null;
      }

      const hasTimeBefore = webRows.some((x) =>
        x.cond?.type === "web_monitor" &&
        x.cond.objectives.some(
          (o) =>
            o.kind === "time_before_event" &&
            (o.minutesBefore === 60 || Number(o.minutesBefore) === 60),
        ),
      );
      const armed = Boolean(nextPrecise?.eventAtIso && nextPrecise?.fireAtIso);
      const confirmationFromEngine = String(chat.reply ?? "");
      // Engine may append notice via responses; also check spoken.
      const datedClaim = /אזכיר ב־/.test(spoken) || /אזכיר ב־/.test(confirmationFromEngine);
      const noVerifiedCopy =
        /אין מועד מאומת|עדיין אין מועד|לא הצלחתי לאמת מועד|אמשיך לבדוק/.test(
          spoken,
        );

      const report = {
        kind: "create_turn_bootstrap_real",
        phrase: PHRASE,
        ms,
        transcript: {
          user: PHRASE,
          spoken: spoken.slice(0, 1200),
          replyPreview: String(chat.reply ?? "").slice(0, 1200),
        },
        model: {
          reminderCount: modelReminders.length,
          watchCount: modelWatches.length,
          webMonitorCount: modelWeb.length,
          objectives:
            modelWeb[0] && modelWeb[0].type === "web_monitor"
              ? modelWeb[0].objectives
              : [],
          composeTypes: modelWatches.map(
            (w) => w.composeCondition?.type ?? null,
          ),
        },
        webSearch: {
          callCount: webSearchCalls.length,
          calls: webSearchCalls.map((c) => ({
            query: c.query,
            cacheHit: c.cacheHit,
            quotaBlocked: c.quotaBlocked,
            hadSearchImpl: c.hadSearchImpl,
            sources: c.sources,
            textPreview: c.textPreview,
          })),
          anyInjectedSearchImpl: webSearchCalls.some((c) => c.hadSearchImpl),
        },
        bootstrap: {
          invoked: bootSnaps.length,
          before: boot?.before
            ? {
                id: boot.before.id,
                status: boot.before.status,
                fireAt: boot.before.fireAt,
                nextPrecise: boot.before.nextPrecise,
                lastErrorClass: boot.before.lastErrorClass,
                objectives: boot.before.objectives,
              }
            : null,
          after: boot?.after
            ? {
                id: boot.after.id,
                status: boot.after.status,
                fireAt: boot.after.fireAt,
                nextPrecise: boot.after.nextPrecise,
                lastErrorClass: boot.after.lastErrorClass,
                objectives: boot.after.objectives,
              }
            : null,
          result: boot?.result ?? null,
        },
        db: {
          totalReminders: rows.length,
          activeCount: active.length,
          webMonitorActive: webRows.length,
          fireAt: after?.fireAt ?? null,
          nextPrecise,
          dualFireAtComputed: dualIso,
          lastErrorClass: after?.lastErrorClass ?? null,
        },
        checks: {
          single_web_monitor_watch:
            webRows.length === 1 && active.length === 1 ? "PASS" : "FAIL",
          time_before_event_60: hasTimeBefore ? "PASS" : "FAIL",
          bootstrap_invoked: bootSnaps.length === 1 ? "PASS" : "FAIL",
          real_web_no_searchImpl:
            webSearchCalls.length > 0 &&
            !webSearchCalls.some((c) => c.hadSearchImpl)
              ? "PASS"
              : webSearchCalls.length === 0
                ? "FAIL"
                : "FAIL",
          no_real_whatsapp: "PASS", // mocked
          armed_path: armed
            ? {
                nextPrecise_event: nextPrecise?.eventAtIso ? "PASS" : "FAIL",
                nextPrecise_t_minus_60:
                  nextPrecise?.eventAtIso &&
                  nextPrecise?.fireAtIso &&
                  Date.parse(nextPrecise.fireAtIso) ===
                    Date.parse(nextPrecise.eventAtIso) - 60 * 60_000
                    ? "PASS"
                    : "FAIL",
                fireAt_present: after?.fireAt ? "PASS" : "FAIL",
                dated_ack_in_spoken: datedClaim ? "PASS" : "FAIL",
              }
            : null,
          not_armed_path: !armed
            ? {
                watch_active:
                  webRows.length >= 1 &&
                  webRows.every((x) => x.row.status === "active")
                    ? "PASS"
                    : "FAIL",
                no_dated_claim: !datedClaim ? "PASS" : "FAIL",
                honest_copy: noVerifiedCopy ? "PASS" : "FAIL",
              }
            : null,
        },
      };
      logReport(report);

      // Hard gates (both armed and not-armed paths share these)
      expect(webRows.length, "exactly one active web_monitor").toBe(1);
      expect(active.length, "no duplicate active reminders").toBe(1);
      expect(hasTimeBefore, "time_before_event minutesBefore=60").toBe(true);
      expect(bootSnaps.length, "bootstrap invoked once").toBe(1);
      expect(
        webSearchCalls.some((c) => c.hadSearchImpl),
        "no injected searchImpl",
      ).toBe(false);
      expect(webSearchCalls.length, "real web search executed").toBeGreaterThan(
        0,
      );
      expect(whatsappSend.sendWhatsAppButtons).not.toHaveBeenCalled();
      // Graph path is mocked; assert mock was not used for real outbound either
      // (create-turn suppressNotify should not fire WhatsApp).

      // Evidence attrs on stored item (extraction provenance)
      const itemAttrs = Object.values(
        (parseMonitorState(webRows[0]!.row.monitorState).items ?? {}) as Record<
          string,
          { eventAt?: string | null; attributes?: Record<string, unknown> }
        >,
      );
      logReport({
        kind: "create_turn_bootstrap_real_items",
        items: itemAttrs.map((it) => ({
          eventAt: it.eventAt ?? null,
          attributes: it.attributes ?? {},
        })),
      });

      if (armed) {
        expect(nextPrecise!.eventAtIso).toBeTruthy();
        expect(nextPrecise!.fireAtIso).toBeTruthy();
        expect(Date.parse(nextPrecise!.fireAtIso!)).toBe(
          Date.parse(nextPrecise!.eventAtIso!) - 60 * 60_000,
        );
        expect(datedClaim, "spoken must show DB-backed dated reminder").toBe(
          true,
        );
        const attrs = itemAttrs[0]?.attributes ?? {};
        logReport({
          kind: "create_turn_bootstrap_real_tz",
          eventAtIso: nextPrecise!.eventAtIso,
          preciseFireAtIso: nextPrecise!.fireAtIso,
          localWall: attrs.eventAtLocal ?? null,
          timeZone: attrs.eventAtTimeZone ?? null,
          timeZoneSource: attrs.eventAtTimeZoneSource ?? null,
          snippet: attrs.eventAtSnippet ?? null,
          jerusalemEventNotice: spoken.match(/האירוע ב־([^\s;]+)/)?.[1] ?? null,
        });
        // Madrid 21:00 local → 20:00Z; Israel 21:00 local → 19:00Z
        if (
          attrs.eventAtTimeZone === "Europe/Madrid" &&
          attrs.eventAtLocal === "2026-11-21T21:00"
        ) {
          expect(nextPrecise!.eventAtIso).toBe("2026-11-21T20:00:00.000Z");
          expect(nextPrecise!.fireAtIso).toBe("2026-11-21T19:00:00.000Z");
        }
        expect(after!.fireAt).toBeTruthy();
        // dualFireAt = min(discovery, precise); must be <= precise
        expect(Date.parse(after!.fireAt)).toBeLessThanOrEqual(
          Date.parse(nextPrecise!.fireAtIso!),
        );
        expect(attrs.eventAtExtractedFrom).toBe("web_search_prose");
      } else {
        expect(webRows[0]!.row.status).toBe("active");
        expect(datedClaim, "must not claim dated reminder when unarmed").toBe(
          false,
        );
        expect(
          noVerifiedCopy,
          "must say no verified time yet",
        ).toBe(true);
      }
    },
    TIMEOUT,
  );
});
