/**
 * UWM Phase 1 — real-model Model→Watch via sendChatMessage on workee_test.
 *
 * WATCH WEB MONITOR guidance is runtime overlay (no Employee.instructions sync).
 *
 * Run (cwd backend):
 *   npm run test:eval-db -- tests/web-monitor-p1-model.live-sendchat.eval-db.test.ts
 */
import { createHash } from "node:crypto";
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
  "scripts/.tmp-web-monitor-p1-model-report.jsonl",
);

function logReport(row: Record<string, unknown>) {
  appendFileSync(REPORT, `${JSON.stringify(row)}\n`, "utf8");
  console.info(JSON.stringify(row, null, 2));
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

describe("UWM Phase 1 real-model web_monitor capture (workee_test)", () => {
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
    expect(runtime.includes("WEB MONITOR (open-domain")).toBe(true);
    expect(seeded.systemMessage.includes("WEB MONITOR")).toBe(false);

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

  function extractShape(replyText: string) {
    const parsed = parseLlmReply(replyText);
    const meta = parsed.metadata ?? parseReplyMetadata(replyText);
    const reminders = meta.reminders ?? [];
    const watches = reminders.filter(
      (r) => r.composeCondition != null || r.compose,
    );
    return {
      spoken: parsed.responses?.map((r) => r.text).join("\n") ?? "",
      reminders,
      watches,
      composeTypes: watches
        .map((w) => w.composeCondition?.type ?? null)
        .filter(Boolean),
      webMonitors: watches
        .map((w) => w.composeCondition)
        .filter((c) => c?.type === "web_monitor"),
      deferred: watches.filter((w) => w.onTriggerActions != null),
      missions: meta.missions ?? [],
      webLookup: meta.web_lookup ?? meta.webLookup ?? null,
    };
  }

  it(
    "prompt overlay present; Real Madrid open monitor → web_monitor",
    async () => {
      const { say, runtimeSha } = await setup();
      logReport({ kind: "prompt_probe", runtimeSha, syncPerformed: false });

      const result = await say(
        "תעדכני אותי שעה לפני כל משחק ליגה של ריאל מדריד בכדורגל.",
      );
      const shape = extractShape(result.reply ?? "");
      const rows = await prisma.reminder.findMany({
        where: { userId: account!.userId, status: "active" },
      });
      const persisted = rows
        .map((r) => parseComposeCondition(r.composeCondition))
        .filter((c) => c?.type === "web_monitor");

      const modelOk = shape.webMonitors.length > 0;
      const engineOk = persisted.length > 0;
      logReport({
        scenario: "real_madrid",
        spoken: shape.spoken.slice(0, 400),
        composeTypes: shape.composeTypes,
        deferredCount: shape.deferred.length,
        webLookup: shape.webLookup,
        missions: shape.missions,
        reminderCount: rows.length,
        persistedWebMonitor: persisted.length,
        objectives:
          persisted[0] && persisted[0].type === "web_monitor"
            ? persisted[0].objectives
            : [],
        verdicts: {
          model_web_monitor: modelOk ? "PASS" : "FAIL",
          engine_persist: engineOk ? "PASS" : "FAIL",
          notify_only_no_on_trigger:
            shape.deferred.length === 0 &&
            rows.every((r) => r.onTriggerActions == null)
              ? "PASS"
              : "FAIL",
          not_sports_match_only:
            !shape.composeTypes.every((t) => t === "sports_match") || modelOk
              ? "PASS_OR_SOFT"
              : "FAIL",
        },
      });

      expect(modelOk, "model must emit web_monitor (not empty)").toBe(true);
      expect(engineOk, "engine must persist web_monitor").toBe(true);
      expect(shape.deferred.length).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "Shlomo Artzi open monitor → web_monitor (different domain)",
    async () => {
      const { say } = await setup();
      const result = await say(
        "תעדכני אותי כשיש הופעה של שלמה ארצי במרכז הארץ.",
      );
      const shape = extractShape(result.reply ?? "");
      const rows = await prisma.reminder.findMany({
        where: { userId: account!.userId, status: "active" },
      });
      const persisted = rows
        .map((r) => parseComposeCondition(r.composeCondition))
        .filter((c) => c?.type === "web_monitor");

      logReport({
        scenario: "artzi",
        spoken: shape.spoken.slice(0, 400),
        composeTypes: shape.composeTypes,
        deferredCount: shape.deferred.length,
        webLookup: shape.webLookup,
        persistedWebMonitor: persisted.length,
        objectives:
          persisted[0]?.type === "web_monitor"
            ? persisted[0].objectives
            : [],
        verdicts: {
          model_web_monitor: shape.webMonitors.length > 0 ? "PASS" : "FAIL",
          engine_persist: persisted.length > 0 ? "PASS" : "FAIL",
          notify_only:
            shape.deferred.length === 0 &&
            rows.every((r) => r.onTriggerActions == null)
              ? "PASS"
              : "FAIL",
        },
      });

      expect(shape.webMonitors.length > 0).toBe(true);
      expect(persisted.length > 0).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "multi-objective discover+change request → objectives preserved",
    async () => {
      const { say } = await setup();
      const result = await say(
        "תעקבי אחרי פרסומים חדשים על מדיניות הכבודה של אל על, ותעדכני אותי גם אם המדיניות הקיימת משתנה.",
      );
      const shape = extractShape(result.reply ?? "");
      const rows = await prisma.reminder.findMany({
        where: { userId: account!.userId, status: "active" },
      });
      const persisted = rows
        .map((r) => parseComposeCondition(r.composeCondition))
        .find((c) => c?.type === "web_monitor");

      const kinds =
        persisted?.type === "web_monitor"
          ? persisted.objectives.map((o) => o.kind)
          : [];
      const multi =
        kinds.includes("discover_new") && kinds.includes("detect_change");

      logReport({
        scenario: "multi_objective",
        spoken: shape.spoken.slice(0, 400),
        composeTypes: shape.composeTypes,
        kinds,
        deferredCount: shape.deferred.length,
        verdicts: {
          model_web_monitor: shape.webMonitors.length > 0 ? "PASS" : "FAIL",
          multi_objective_persist: multi ? "PASS" : "FAIL",
        },
      });

      expect(shape.webMonitors.length > 0).toBe(true);
      expect(multi, "must persist discover_new + detect_change").toBe(true);
    },
    TIMEOUT,
  );
});
