/**
 * P0 final model validation — real Lucy via sendChatMessage on workee_test (:5436).
 *
 * Distinguishes model structure vs engine persist vs real monitoring providers.
 * Does NOT sync Employee.instructions (WATCH DEFERRED ACTIONS is runtime overlay).
 *
 * Run (cwd backend):
 *   npm run test:eval-db -- tests/watch-trigger-p0-model.live-sendchat.eval-db.test.ts
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLlmReply, parseReplyMetadata } from "@workee/shared";
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
import { fetchSportsSchedule } from "../src/services/sports-schedule.service.js";
import { getExternalLookupProviderConfig } from "../src/services/external-lookup.config.js";
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
const REPORT = resolve(
  process.cwd(),
  "scripts/.tmp-watch-trigger-p0-model-report.jsonl",
);

function logReport(row: Record<string, unknown>) {
  appendFileSync(REPORT, `${JSON.stringify(row)}\n`, "utf8");
  console.info(JSON.stringify(row, null, 2));
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

describe("P0 Watch→Action real-model validation (workee_test)", () => {
  let account: HarnessAccount | null = null;
  let lucyId = "";

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
      lucyId = "";
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
        // Base file prompt; WATCH DEFERRED is attached via runtime overlay.
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
    expect(
      runtime.includes("WATCH DEFERRED ACTIONS (P0)"),
      "runtime overlay must include WATCH DEFERRED ACTIONS without DB sync",
    ).toBe(true);
    expect(
      seeded.systemMessage.includes("WATCH DEFERRED ACTIONS"),
      "base LLM.config does not carry the overlay (expected)",
    ).toBe(false);

    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent");
    vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent");
    vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0);
    vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => {});
    setLlmClientForTests(getLlmClient());

    const say = (message: string) =>
      sendChatMessage({
        userId: account!.userId,
        employeeId: account!.employeeId,
        digitalEmployeeId: lucyId,
        message,
      });

    return { say, runtimeSha: sha256(runtime) };
  }

  function extractWatchShape(replyText: string) {
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
    const topLevelListMutates = lists.filter(
      (l) => l.action === "add" || l.action === "update",
    );
    return {
      spoken: parsed.responses?.map((r) => r.text).join("\n") ?? "",
      reminders,
      lists,
      watches,
      withDeferred,
      topLevelListMutates,
      composeTypes: watches
        .map((w) => w.composeCondition?.type ?? null)
        .filter(Boolean),
      watchOnce: watches.map((w) => w.watchOnce),
      missions: meta.missions ?? [],
      webLookup: meta.web_lookup ?? meta.webLookup ?? null,
    };
  }

  it(
    "prompt: WATCH DEFERRED is runtime-only; sports provider empty without injector",
    async () => {
      const { runtimeSha } = await setup();
      const sportsCfg = getExternalLookupProviderConfig("sports");
      const schedule = await fetchSportsSchedule({
        team: "Real Madrid",
        competition: "La Liga",
        userId: account!.userId,
      });
      logReport({
        kind: "provider_probe",
        runtimeSha,
        syncPerformed: false,
        syncReason:
          "WATCH DEFERRED ACTIONS lives in buildLucyInstructions overlay for protected Lucy; sync-lucy-prompt only writes LLM.config.json and would not add this line. Skipping DB sync to avoid mass Employee.instructions writes.",
        sports: {
          enabled: sportsCfg.enabled,
          liveRefresh: sportsCfg.liveRefresh,
          matchCount: schedule.matches.length,
          source: schedule.source,
        },
      });
      expect(sportsCfg.liveRefresh).toBe(false);
      expect(schedule.matches).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "Scenario A — Real Madrid La Liga recurring watch (notify-only)",
    async () => {
      const { say } = await setup();
      const message =
        "תעדכני אותי שעה לפני כל משחק ליגה של ריאל מדריד בכדורגל.";
      const result = await say(message);
      const shape = extractWatchShape(result.reply ?? "");
      const rows = await prisma.reminder.findMany({
        where: { userId: account!.userId, status: "active" },
      });

      const verdicts = {
        model_ongoing_watch:
          shape.watches.length > 0 ||
          shape.composeTypes.includes("sports_match")
            ? "PASS_OR_PARTIAL"
            : "FAIL",
        model_sports_match_type: shape.composeTypes.includes("sports_match")
          ? "PASS"
          : "FAIL",
        model_notify_only_no_on_trigger:
          shape.withDeferred.length === 0 ? "PASS" : "FAIL",
        model_not_one_shot_external_event_only: rows.some(
          (r) => r.scheduleAnchor === "external_event" && !r.composeCondition,
        )
          ? "FAIL_LIKELY_ONE_SHOT"
          : "PASS_OR_N_A",
        engine_persist_watch: rows.some((r) => r.composeCondition != null)
          ? "PASS"
          : rows.length > 0
            ? "PARTIAL"
            : "FAIL",
        real_schedule_provider: "NOT_TESTED_EMPTY_PROVIDER",
        multi_match_discovery: "NOT_TESTED",
        duplicate_match_dedupe: "NOT_TESTED",
      };

      logReport({
        scenario: "A",
        message,
        spoken: shape.spoken.slice(0, 500),
        composeTypes: shape.composeTypes,
        watchOnce: shape.watchOnce,
        deferredCount: shape.withDeferred.length,
        reminderCount: rows.length,
        reminderAnchors: rows.map((r) => ({
          id: r.id,
          anchor: r.scheduleAnchor,
          hasCondition: r.composeCondition != null,
          watchOnce: r.watchOnce,
          onTrigger: r.onTriggerActions != null,
        })),
        rawReminders: shape.reminders,
        verdicts,
      });

      // Soft expectations — document failures rather than block the suite blindly.
      expect(shape.withDeferred.length).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "Scenario B — official registration notice → deferred reminder",
    async () => {
      const { say } = await setup();
      const message =
        "אם תתפרסם הודעה רשמית על מועד ההרשמה לאירוע X, תוסיפי לי תזכורת יומיים לפני סגירת ההרשמה.";
      const result = await say(message);
      const shape = extractWatchShape(result.reply ?? "");
      const rows = await prisma.reminder.findMany({
        where: { userId: account!.userId, status: "active" },
      });

      const nestedRemindersInDeferred = shape.withDeferred.some((w) =>
        JSON.stringify(w.onTriggerActions).includes("reminder"),
      );
      const topLevelImmediateReminderForDeadline = shape.reminders.some(
        (r) =>
          !r.composeCondition &&
          /הרשמה|סגיר|יומיים|אירוע/i.test(`${r.item} ${r.text}`),
      );

      logReport({
        scenario: "B",
        message,
        spoken: shape.spoken.slice(0, 500),
        composeTypes: shape.composeTypes,
        deferredCount: shape.withDeferred.length,
        deferred: shape.withDeferred,
        topLevelListMutates: shape.topLevelListMutates.length,
        reminderRows: rows.map((r) => ({
          hasCondition: r.composeCondition != null,
          onTrigger: r.onTriggerActions != null,
          package: r.onTriggerActions,
        })),
        verdicts: {
          model_creates_watch:
            shape.watches.length > 0 ||
            rows.some((r) => r.composeCondition != null)
              ? "PASS_OR_PARTIAL"
              : "FAIL",
          model_nests_deferred_action:
            shape.withDeferred.length > 0 ? "PASS" : "FAIL",
          model_not_top_level_immediate_deadline_clock:
            topLevelImmediateReminderForDeadline ? "FAIL" : "PASS_OR_N_A",
          p0_allowlist_deferred_reminders:
            nestedRemindersInDeferred
              ? "FAIL_OR_UNSUPPORTED_P0"
              : shape.withDeferred.length > 0
                ? "CHECK_PACKAGE"
                : "N_A",
          engine_execute_deferred_reminder: "NOT_TESTED_P0_LISTS_ONLY",
          real_registration_notice_monitor: "NOT_TESTED_NO_PROVIDER",
        },
      });
    },
    TIMEOUT,
  );

  it(
    "Scenario C — airline baggage policy change → deferred task",
    async () => {
      const { say } = await setup();
      const message =
        "אם חברת התעופה תשנה את מדיניות הכבודה שלה, תוסיפי לי משימה לבדוק אם צריך לעדכן את ההזמנה.";
      const result = await say(message);
      const shape = extractWatchShape(result.reply ?? "");
      const rows = await prisma.reminder.findMany({
        where: { userId: account!.userId, status: "active" },
      });
      const tasksBefore = await prisma.employeeListItem.count({
        where: {
          list: { employeeId: account!.employeeId, listType: "tasks" },
          deletedAt: null,
        },
      });

      const deferredListsAdd = shape.withDeferred.flatMap(
        (w) => w.onTriggerActions?.lists ?? [],
      );
      const hasDeferredTaskAdd = deferredListsAdd.some(
        (l) => l.action === "add" && l.listType === "tasks",
      );
      const immediateTaskAdd = shape.topLevelListMutates.some(
        (l) => l.action === "add" && l.listType === "tasks",
      );

      logReport({
        scenario: "C",
        message,
        spoken: shape.spoken.slice(0, 500),
        composeTypes: shape.composeTypes,
        deferred: shape.withDeferred,
        immediateTaskAdd,
        hasDeferredTaskAdd,
        tasksBefore,
        webLookup: shape.webLookup,
        missions: shape.missions,
        reminderRows: rows.map((r) => ({
          hasCondition: r.composeCondition != null,
          onTrigger: r.onTriggerActions != null,
        })),
        verdicts: {
          model_creates_watch:
            shape.watches.length > 0 ||
            rows.some((r) => r.composeCondition != null)
              ? "PASS_OR_PARTIAL"
              : "FAIL",
          model_nests_lists_add_task: hasDeferredTaskAdd ? "PASS" : "FAIL",
          model_no_immediate_task_on_create: immediateTaskAdd
            ? "FAIL"
            : "PASS",
          engine_apply_deferred_task: "NOT_TESTED_NO_VERIFIED_CHANGE_EVENT",
          real_airline_policy_monitor: "NOT_TESTED_NO_PROVIDER",
          fail_closed_on_uncertain_search: "NOT_TESTED",
        },
      });
    },
    TIMEOUT,
  );

  it(
    "Scenario D — Shlomo Artzi concerts (region + venue)",
    async () => {
      const { say } = await setup();
      const regional =
        "תעדכני אותי כשיש הופעה של שלמה ארצי במרכז הארץ.";
      const venue =
        "תעדכני אותי כשיש הופעה של שלמה ארצי בהיכל מנורה בתל אביב.";

      const r1 = await say(regional);
      const s1 = extractWatchShape(r1.reply ?? "");
      const rows1 = await prisma.reminder.findMany({
        where: { userId: account!.userId, status: "active" },
      });

      // Fresh account already; second ask in same conversation is intentional.
      const r2 = await say(venue);
      const s2 = extractWatchShape(r2.reply ?? "");
      const rows2 = await prisma.reminder.findMany({
        where: { userId: account!.userId, status: "active" },
      });

      logReport({
        scenario: "D",
        regional: {
          message: regional,
          spoken: s1.spoken.slice(0, 500),
          composeTypes: s1.composeTypes,
          deferredCount: s1.withDeferred.length,
          webLookup: s1.webLookup,
          missions: s1.missions,
          watches: s1.watches.length,
        },
        venue: {
          message: venue,
          spoken: s2.spoken.slice(0, 500),
          composeTypes: s2.composeTypes,
          deferredCount: s2.withDeferred.length,
          webLookup: s2.webLookup,
          missions: s2.missions,
          watches: s2.watches.length,
        },
        reminderCountAfter: rows2.length,
        verdicts: {
          model_ongoing_not_one_shot_lookup:
            s1.watches.length > 0 || s2.watches.length > 0
              ? "PASS_OR_PARTIAL"
              : s1.webLookup || s2.webLookup
                ? "FAIL_ONE_TIME_LOOKUP"
                : "FAIL",
          model_notify_only:
            s1.withDeferred.length === 0 && s2.withDeferred.length === 0
              ? "PASS"
              : "FAIL",
          model_artist_scope_in_condition_or_place:
            /ארצי|artzi/i.test(JSON.stringify(s1.watches)) ||
            /ארצי|artzi/i.test(s1.spoken)
              ? "PASS_OR_PARTIAL"
              : "FAIL",
          real_event_discovery_provider: "NOT_TESTED_NO_COMPOSE_CONDITION",
          multi_event_dedupe: "NOT_TESTED",
          region_vs_venue_filter: "NOT_TESTED",
        },
        rows: rows2.map((r) => ({
          label: r.itemLabel,
          hasCondition: r.composeCondition != null,
          place: r.composePlace,
          onTrigger: r.onTriggerActions != null,
        })),
      });

      expect(s1.withDeferred.length).toBe(0);
      expect(s2.withDeferred.length).toBe(0);
    },
    TIMEOUT,
  );
});
