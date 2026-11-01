/**
 * Result-flow performance probe (eval-db, stub LLM, real workee_test).
 * Measures LLM createResponse + getEmployeeRecordSnapshot counts and latency.
 * Not a product assertion suite — prints JSON summary for Final QA.
 */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyLlmMetadata, parseLlmReply } from "@workee/shared";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import * as employeeRecords from "../src/services/employee-records.service.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

type ScenarioId =
  | "plain_no_action"
  | "mutate_add_only"
  | "mutate_show"
  | "mutate_fail_remove"
  | "show_only";

type ProbeRow = {
  scenario: ScenarioId;
  llmCreateResponse: number;
  snapshotCalls: number;
  latencyMs: number;
  responsePreview: string;
};

const REPEATS = 5;
const rows: ProbeRow[] = [];

function stubLlm(payload: unknown) {
  let createResponse = 0;
  return {
    count: () => createResponse,
    client: {
      async createConversation() {
        return `conv-${randomUUID()}`;
      },
      async createResponse() {
        createResponse += 1;
        return { reply: JSON.stringify(payload), raw: {} };
      },
    },
  };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx]!;
}

describe("Result-flow perf probe (eval-db)", () => {
  let account: HarnessAccount;
  let lucyId: string;

  beforeEach(async () => {
    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue({
      ok: true as const,
      messageId: "probe",
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
            items: [{ "שם פריט": "בסיס-perf" }],
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
    if (account?.userId) {
      await cleanupHarnessAccount(account);
    }
  });

  async function probe(scenario: ScenarioId): Promise<ProbeRow> {
    const payloads: Record<ScenarioId, unknown> = {
      plain_no_action: {
        responses: [{ text: "היי, במה אפשר לעזור?" }],
        metadata: { ...emptyLlmMetadata() },
      },
      mutate_add_only: {
        responses: [{ text: "הוספתי חלב לרשימת הקניות." }],
        metadata: {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "add",
              listType: "shopping",
              listName: "",
              targets: [],
              items: [{ "שם פריט": `חלב-perf-${randomUUID().slice(0, 8)}` }],
            },
          ],
        },
      },
      mutate_show: {
        responses: [{ text: "הוספתי לחם.\n1. ישן" }],
        metadata: {
          ...emptyLlmMetadata(),
          showDump: "קניות",
          lists: [
            {
              action: "add",
              listType: "shopping",
              listName: "",
              targets: [],
              items: [{ "שם פריט": `לחם-perf-${randomUUID().slice(0, 8)}` }],
            },
          ],
        },
      },
      mutate_fail_remove: {
        responses: [{ text: "מחקתי את הפריט." }],
        metadata: {
          ...emptyLlmMetadata(),
          lists: [
            {
              action: "remove",
              listType: "shopping",
              listName: "",
              targets: [],
              items: [
                {
                  mutate_source: "saved_data",
                  item_id: "00000000-0000-4000-8000-000000000099",
                },
              ],
            },
          ],
        },
      },
      show_only: {
        responses: [{ text: "הנה הקניות" }],
        metadata: {
          ...emptyLlmMetadata(),
          showDump: "קניות",
        },
      },
    };

    const stub = stubLlm(payloads[scenario]);
    setLlmClientForTests(stub.client);
    const realSnap = employeeRecords.getEmployeeRecordSnapshot.bind(employeeRecords);
    const countingSpy = vi
      .spyOn(employeeRecords, "getEmployeeRecordSnapshot")
      .mockImplementation((employeeId, opts) => realSnap(employeeId, opts));
    const t0 = performance.now();
    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      message: `probe-${scenario}`,
      digitalEmployeeId: lucyId,
    });
    const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
    const spoken = parseLlmReply(result.reply).response;
    const snapshotCalls = countingSpy.mock.calls.length;
    countingSpy.mockRestore();
    return {
      scenario,
      llmCreateResponse: stub.count(),
      snapshotCalls,
      latencyMs,
      responsePreview: spoken.slice(0, 180).replace(/\n/g, " | "),
    };
  }

  it(
    "measures LLM/snapshot/latency across Result-flow scenarios",
    async () => {
      const scenarios: ScenarioId[] = [
        "plain_no_action",
        "mutate_add_only",
        "mutate_show",
        "mutate_fail_remove",
        "show_only",
      ];
      for (const scenario of scenarios) {
        for (let i = 0; i < REPEATS; i += 1) {
          // Fresh account per scenario-repeat would be heavy; reuse seeded account.
          rows.push(await probe(scenario));
        }
      }

      const summary = scenarios.map((scenario) => {
        const subset = rows.filter((r) => r.scenario === scenario);
        const latencies = subset.map((r) => r.latencyMs).sort((a, b) => a - b);
        const snaps = subset.map((r) => r.snapshotCalls);
        const llms = subset.map((r) => r.llmCreateResponse);
        return {
          scenario,
          n: subset.length,
          llmCreateResponse: {
            min: Math.min(...llms),
            max: Math.max(...llms),
            median: [...llms].sort((a, b) => a - b)[Math.floor(llms.length / 2)],
          },
          snapshotCalls: {
            min: Math.min(...snaps),
            max: Math.max(...snaps),
            median: [...snaps].sort((a, b) => a - b)[
              Math.floor(snaps.length / 2)
            ],
          },
          latencyMs: {
            min: latencies[0],
            p50: pct(latencies, 50),
            p95: pct(latencies, 95),
            max: latencies[latencies.length - 1],
          },
          samplePreview: subset[subset.length - 1]?.responsePreview,
        };
      });

      // eslint-disable-next-line no-console
      console.log(
        "RESULT_FLOW_PERF_REPORT\n" + JSON.stringify({ summary, rows }, null, 2),
      );

      // Sanity: spy sees calls; LLM is exactly one createResponse per turn in these stubs.
      for (const row of rows) {
        expect(row.llmCreateResponse).toBeGreaterThanOrEqual(1);
        expect(row.snapshotCalls).toBeGreaterThanOrEqual(1);
      }
      // mutate+show must not use fewer snapshots than mutate-only (Result-C dump path).
      const addMed = summary.find((s) => s.scenario === "mutate_add_only")!
        .snapshotCalls.median!;
      const showMed = summary.find((s) => s.scenario === "mutate_show")!
        .snapshotCalls.median!;
      expect(showMed).toBeGreaterThanOrEqual(addMed);
    },
    180_000,
  );
});
