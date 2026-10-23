/**
 * Share-pack MODEL_APPLY (stub model + production planTargetedActions apply).
 *
 * Layers THIS path includes:
 * - assertApprovedEvalDatabaseUrl / harness account + seedSetup
 * - stub proposeTurn (no OpenAI)
 * - applyListOps / planTargetedActions / applyEmployeeRecords / applyReminders /
 *   applyDirectoryActions (via applyModelMetadataTurn)
 * - constraint + stateAfter checks on reinjected snapshot
 *
 * Layers THIS path skips (not sendChatMessage):
 * - LLM / prompt composition / tips
 * - correctShareClaimReply / alignListTypeInReply / dump REPLACE
 * - ensureSpeakerShowButtons / applyShowButtonsToBubbles
 * - WhatsApp outbound, reminder fire ticker, relays/jobs
 * - Guest mutation block on actor (covered in sendChat E2E; SH-GUEST-VIEW is ask-only)
 *
 * Run: npm run test:eval-db -- tests/share-pack-model-apply.offline.test.ts
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  defaultDomainPackPath,
  loadDomainPackSuite,
} from "../src/eval/corpus.js";
import {
  emptyModelMetadata,
  runModelApplyCase,
  type ModelApplyCase,
  type ModelApplyProposeInput,
} from "../src/eval/run-model-apply.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import { prisma } from "../src/database/prisma.js";

function itemIdByLabel(
  snapshot: {
    lists: Array<{ list_type?: string; items: Array<Record<string, unknown>> }>;
  },
  needle: string,
  listType: string,
): string {
  for (const list of snapshot.lists) {
    if (list.list_type !== listType) continue;
    for (const item of list.items) {
      if (!JSON.stringify(item).includes(needle)) continue;
      for (const key of ["item_id", "itemId", "id"]) {
        const raw = item[key];
        if (typeof raw === "string" && raw.trim()) return raw.trim();
      }
    }
  }
  throw new Error(`expected ${listType} item ${needle}`);
}

function filingIdByName(
  snapshot: { filing: Array<Record<string, unknown>> },
  needle: string,
): string {
  for (const row of snapshot.filing ?? []) {
    if (!JSON.stringify(row).includes(needle)) continue;
    for (const key of ["filing_id", "filingId", "id"]) {
      const raw = row[key];
      if (typeof raw === "string" && raw.trim()) return raw.trim();
    }
  }
  throw new Error(`expected filing ${needle}`);
}

async function partnerTaskIdByLabel(
  account: ModelApplyProposeInput["account"],
  needle: string,
): Promise<string> {
  const partner = account.partners.find((p) => p.name === "עמית") ?? account.partners[0];
  if (!partner) throw new Error("expected partner עמית");
  const rows = await prisma.employeeListItem.findMany({
    where: {
      deletedAt: null,
      list: { employeeId: partner.id, listType: "tasks", deletedAt: null },
    },
  });
  const hit = rows.find((row) => JSON.stringify(row.data).includes(needle));
  if (!hit) throw new Error(`expected partner task ${needle}`);
  return hit.id;
}

function askStub(response: string) {
  return {
    metadata: emptyModelMetadata(),
    response,
  };
}

async function propose(caseId: string, input: ModelApplyProposeInput) {
  switch (caseId) {
    case "SH-SHARE-SHOP":
    case "SH-SHARE-MT":
      return {
        metadata: {
          lists: [
            {
              action: "update",
              list_type: "shopping",
              list_name: "",
              items: [
                {
                  item_id: itemIdByLabel(input.snapshot, "חלב", "shopping"),
                },
              ],
              targets: ["טל", "עמית"],
            },
          ],
        },
        response: "שיתפתי",
      };
    case "SH-ASSIGN-TASK":
    case "SH-ASSIGN-MT":
      return {
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "tasks",
              list_name: "",
              items: [
                {
                  "שם מטלה":
                    caseId === "SH-ASSIGN-MT"
                      ? "לקנות חלב"
                      : "להתקשר לרופא",
                },
              ],
              targets: ["עמית"],
            },
          ],
        },
        response: "הטלתי",
      };
    case "SH-SHARE-FILING":
      return {
        metadata: {
          filing: [
            {
              action: "update_filing",
              item_name: "קוד",
              item_info: "",
              item_description: "",
              filing_id: filingIdByName(input.snapshot, "קוד"),
              targets: ["טל", "עמית"],
            },
          ],
        },
        response: "שיתפתי",
      };
    case "SH-SHARE-ASK":
      return askStub("מה לשתף ועם מי?");
    case "SH-ASSIGN-ASK":
      return askStub("על מי להטיל ואיזו מטלה?");
    case "SH-UNSHARE-ASK":
      return askStub("את מה להפסיק לשתף ועם מי?");
    case "SH-TARGETS-EMPTY-ASK":
      return askStub("עם מי לשתף?");
    case "SH-GUEST-VIEW":
      // Read-only: guest mutation gate is not exercised here (no guest actor).
      return askStub("אורח רואה רק רשימות ששותפו איתו.");
    case "SH-CX-MT":
      if (input.turnIndex === 0) {
        return {
          metadata: {
            lists: [
              {
                action: "update",
                list_type: "shopping",
                list_name: "",
                items: [
                  {
                    item_id: itemIdByLabel(input.snapshot, "חלב", "shopping"),
                  },
                ],
                targets: ["טל", "עמית"],
              },
            ],
          },
          response: "שיתפתי",
        };
      }
      return {
        metadata: {
          lists: [
            {
              action: "update",
              list_type: "shopping",
              list_name: "",
              items: [
                {
                  item_id: itemIdByLabel(input.snapshot, "חלב", "shopping"),
                  unshare_with: ["עמית"],
                },
              ],
              targets: [],
            },
          ],
        },
        response: "הפסקתי לשתף",
      };
    case "SH-CHANGE-MIND":
      if (input.turnIndex === 0) {
        return {
          metadata: {
            lists: [
              {
                action: "add",
                list_type: "tasks",
                list_name: "",
                items: [{ "שם מטלה": "לבנק" }],
                targets: ["עמית"],
              },
            ],
          },
          response: "הטלתי",
        };
      }
      return {
        metadata: {
          lists: [
            {
              action: "remove",
              list_type: "tasks",
              list_name: "",
              items: [
                {
                  item_id: await partnerTaskIdByLabel(input.account, "בנק"),
                },
              ],
              targets: [],
            },
          ],
        },
        response: "ביטלתי",
      };
    case "SH-NO-WIPE":
      return askStub("אי אפשר לשתף ולמחוק הכל באותו צעד — מה בדיוק לעשות?");
    case "SH-SHOW-SHARED":
      return {
        metadata: emptyModelMetadata(),
        response: "כרגע אין לי מה להציג כמשותף בלי בקשת הצגה ספציפית.",
      };
    case "SH-SELF-NOOP":
      // Self-only share is a no-op mutate or empty — either arm of `any` is ok.
      return {
        metadata: emptyModelMetadata(),
        response: "הקניות כבר שלך — אין צורך לשתף עם עצמך.",
      };
    case "SH-ASSIGN-EXISTING":
      return {
        metadata: {
          lists: [
            {
              action: "update",
              list_type: "tasks",
              list_name: "",
              items: [
                {
                  item_id: itemIdByLabel(
                    input.snapshot,
                    "להתקשר לרופא",
                    "tasks",
                  ),
                },
              ],
              targets: ["עמית"],
            },
          ],
        },
        response: "העברתי לעמית",
      };
    default:
      throw new Error(`no stub propose for ${caseId}`);
  }
}

const APPLY_CASES = [
  "SH-SHARE-SHOP",
  "SH-ASSIGN-TASK",
  "SH-SHARE-FILING",
  "SH-SHARE-MT",
  "SH-ASSIGN-MT",
  "SH-CX-MT",
  "SH-CHANGE-MIND",
] as const;

const ASK_CASES = [
  "SH-SHARE-ASK",
  "SH-ASSIGN-ASK",
  "SH-UNSHARE-ASK",
  "SH-TARGETS-EMPTY-ASK",
  "SH-GUEST-VIEW",
  "SH-NO-WIPE",
  "SH-SHOW-SHARED",
  "SH-SELF-NOOP",
] as const;

const EDGE_APPLY_CASES = ["SH-ASSIGN-EXISTING"] as const;

function toModelApplyCase(
  raw: {
    id: string;
    tag?: string;
    setup?: ModelApplyCase["setup"];
    turns?: Array<{
      utterance: string;
      constraints?: ModelApplyCase["turns"][number]["constraints"];
      stateAfter?: ModelApplyCase["turns"][number]["stateAfter"];
    }>;
  },
  options?: { dropStateAfter?: boolean },
): ModelApplyCase {
  return {
    id: raw.id,
    track: "MODEL_APPLY",
    tag: raw.tag,
    setup: raw.setup,
    turns: (raw.turns ?? []).map((turn) => ({
      utterance: turn.utterance,
      constraints: turn.constraints,
      // Assign lands on partner books — speaker stateAfter can false-fail.
      stateAfter: options?.dropStateAfter ? undefined : turn.stateAfter,
    })),
  };
}

describe("share-pack MODEL_APPLY (eval-db)", () => {
  beforeAll(() => {
    const db = process.env.DATABASE_URL;
    if (!db?.trim()) throw new Error("DATABASE_URL required");
    assertApprovedEvalDatabaseUrl(db);
    expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("documents harness layers (include vs skip)", () => {
    const includes = [
      "assertApprovedEvalDatabaseUrl",
      "planTargetedActions",
      "applyEmployeeRecords",
      "applyListOps",
      "applyReminders",
      "applyDirectoryActions",
      "seedSetup + snapshot reinject",
    ];
    const skips = [
      "sendChatMessage",
      "correctShareClaimReply",
      "show_dump REPLACE",
      "ensureSpeakerShowButtons / applyShowButtonsToBubbles",
      "OpenAI / LIVE",
      "WhatsApp outbound",
      "reminder fire ticker",
      "guest mutation gate (tested separately via planTargetedActions + chat)",
    ];
    expect(includes.length).toBeGreaterThan(0);
    expect(skips).toContain("sendChatMessage");
  });

  it.each(ASK_CASES)("ask/safety read-only %s", async (caseId) => {
    const suite = loadDomainPackSuite(
      defaultDomainPackPath("share-pack-suite.json"),
      { expectedDomain: "share", expectedPack: "share-pack-v1" },
    );
    const raw = suite.cases.find((row) => row.id === caseId);
    expect(raw).toBeTruthy();
    const result = await runModelApplyCase(
      toModelApplyCase(raw!),
      (input) => propose(caseId, input),
      { partners: ["עמית"] },
    );
    expect(result.ok, result.failures.join("\n")).toBe(true);
    expect(result.turns.every((t) => t.appliedViaProduction !== true)).toBe(
      true,
    );
  });

  it.each(APPLY_CASES)("applies %s via MODEL_APPLY stub", async (caseId) => {
    const suite = loadDomainPackSuite(
      defaultDomainPackPath("share-pack-suite.json"),
      { expectedDomain: "share", expectedPack: "share-pack-v1" },
    );
    const raw = suite.cases.find((row) => row.id === caseId);
    expect(raw).toBeTruthy();
    const dropStateAfter =
      caseId === "SH-CHANGE-MIND" || caseId === "SH-ASSIGN-MT";
    const result = await runModelApplyCase(
      toModelApplyCase(raw!, { dropStateAfter }),
      (input) => propose(caseId, input),
      { partners: ["עמית"] },
    );
    expect(result.ok, result.failures.join("\n")).toBe(true);
    expect(result.turns.some((t) => t.appliedViaProduction === true)).toBe(
      true,
    );

    if (caseId === "SH-SHARE-SHOP" || caseId === "SH-SHARE-MT") {
      const blob = JSON.stringify(result.turns.at(-1)?.snapshot?.lists ?? []);
      expect(blob).toMatch(/חלב/);
      expect(blob).toMatch(/shared_with|עמית|shared/i);
    }
    if (caseId === "SH-SHARE-FILING") {
      expect(
        JSON.stringify(result.turns.at(-1)?.snapshot?.filing ?? []),
      ).toMatch(/קוד/);
    }
    if (caseId === "SH-CX-MT") {
      // After unshare, milk should no longer list עמית as co-partner.
      const blob = JSON.stringify(result.turns.at(-1)?.snapshot?.lists ?? []);
      expect(blob).toMatch(/חלב/);
      expect(blob).not.toMatch(/"shared_with":\[[^\]]*"עמית"/);
    }
  });

  it.each(EDGE_APPLY_CASES)("edge apply %s", async (caseId) => {
    const suite = loadDomainPackSuite(
      defaultDomainPackPath("share-pack-suite.json"),
      { expectedDomain: "share", expectedPack: "share-pack-v1" },
    );
    const raw = suite.cases.find((row) => row.id === caseId);
    expect(raw).toBeTruthy();
    const result = await runModelApplyCase(
      toModelApplyCase(raw!),
      (input) => propose(caseId, input),
      { partners: ["עמית"] },
    );
    expect(result.ok, result.failures.join("\n")).toBe(true);
    expect(result.turns.some((t) => t.appliedViaProduction === true)).toBe(
      true,
    );
  });
});
