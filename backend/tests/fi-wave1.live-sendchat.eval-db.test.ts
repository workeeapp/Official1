/**
 * FI Wave 1/1b — production-path live model evidence.
 * Fixed soft FI disabled; model-led acquaintance + value discovery.
 *
 * Run:
 *   npm run test:eval-db -- tests/fi-wave1.live-sendchat.eval-db.test.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLlmReply, parseReplyMetadata } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import {
  getLlmClient,
  setLlmClientForTests,
} from "../src/services/llm-client.js";
import { resetPieArbitrationStateForTests } from "../src/services/pie-arbitration.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  injectProductEnvKey,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

const TIMEOUT = 300_000;
const REPORT = resolve(process.cwd(), "scripts/.tmp-fi-wave1-live.json");

type Row = {
  id: string;
  utterance: string;
  spoken: string;
  listsActions: string[];
  filingActions: string[];
  hasFixedDoctorFi: boolean;
  hasFixedMilkFi: boolean;
  quizLike: boolean;
};

const rows: Row[] = [];

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

function spokenAll(reply: string): string {
  const parsed = parseLlmReply(reply);
  return [parsed.response, ...(parsed.responseBubbles ?? []).map((b) => b.text)]
    .filter(Boolean)
    .join("\n");
}

function listActions(reply: string): string[] {
  return ((parseReplyMetadata(reply).lists ?? []) as Array<{ action?: string }>)
    .map((l) => String(l.action ?? ""))
    .filter(Boolean);
}

function filingActions(reply: string): string[] {
  const meta = parseReplyMetadata(reply);
  const filing = (meta.filing ?? []) as Array<{ action?: string }>;
  const lists = (meta.lists ?? []) as Array<{
    action?: string;
    listType?: string;
  }>;
  return [
    ...filing.map((f) => String(f.action ?? "")),
    ...lists
      .filter((l) => l.listType === "filing")
      .map((l) => String(l.action ?? "")),
  ].filter(Boolean);
}

async function turn(
  account: HarnessAccount,
  lucyId: string,
  id: string,
  utterance: string,
): Promise<{ spoken: string; reply: string }> {
  resetPieArbitrationStateForTests();
  const result = await sendChatMessage({
    userId: account.userId,
    employeeId: account.employeeId,
    digitalEmployeeId: lucyId,
    message: utterance,
  });
  const spoken = spokenAll(result.reply);
  rows.push({
    id,
    utterance,
    spoken,
    listsActions: listActions(result.reply),
    filingActions: filingActions(result.reply),
    hasFixedDoctorFi: /משימה ראשונה|להתקשר לרופא\?/.test(spoken),
    hasFixedMilkFi: /נתחיל בקניות|אוסיף חלב\?/.test(spoken),
    quizLike: /(בן כמה|סטטוס משפחתי|אתה נשוי|יש לך ילדים\?)/.test(spoken),
  });
  return { spoken, reply: result.reply };
}

async function wireLucy(account: HarnessAccount, config: ReturnType<typeof loadLucyConfig>) {
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
  return lucyId;
}

describe("FI Wave 1/1b (live model)", () => {
  let member: HarnessAccount;
  let memberLucy: string;
  let prospect: HarnessAccount;
  let prospectLucy: string;

  beforeAll(async () => {
    expect(injectProductEnvKey("OPENAI_API_KEY").present).toBe(true);
    assertEvalDbAndGtfsUntouched();
    const config = loadLucyConfig();
    expect(config.instructions).toMatch(/FIRST ACQUAINTANCE \/ VALUE DISCOVERY/);

    member = await createHarnessAccount("טל", { partners: ["מיכל"] });
    memberLucy = await wireLucy(member, config);
    await prisma.user.update({
      where: { id: member.userId },
      data: { consentPending: false },
    });

    prospect = await createHarnessAccount("נועם", { partners: [] });
    prospectLucy = await wireLucy(prospect, config);
    await prisma.user.update({
      where: { id: prospect.userId },
      data: { consentPending: true },
    });

    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent" as never);
    vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent" as never);
    vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0 as never);
    vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => undefined);
    setLlmClientForTests(null);
    setLlmClientForTests(getLlmClient());
  }, TIMEOUT);

  afterAll(async () => {
    try {
      writeFileSync(REPORT, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
    } catch {
      /* ignore */
    }
    setLlmClientForTests(null);
    vi.restoreAllMocks();
    if (member) await cleanupHarnessAccount(member);
    if (prospect) await cleanupHarnessAccount(prospect);
  });

  it(
    "FI-M1 member greeting — no fixed doctor FI",
    async () => {
      const { spoken } = await turn(member, memberLucy, "FI-M1", "היי, נעים להכיר");
      expect(spoken.length).toBeGreaterThan(0);
      expect(rows[rows.length - 1]!.hasFixedDoctorFi).toBe(false);
      expect(rows[rows.length - 1]!.quizLike).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "FI-M4 venting — no fixed FI push",
    async () => {
      const { spoken, reply } = await turn(
        member,
        memberLucy,
        "FI-M4",
        "וואי יום מתיש, רק רציתי לשתף",
      );
      expect(spoken.length).toBeGreaterThan(0);
      expect(rows[rows.length - 1]!.hasFixedDoctorFi).toBe(false);
      expect(listActions(reply)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "V-D1 lost user — discovery without canned FI / long brochure",
    async () => {
      const { spoken } = await turn(
        member,
        memberLucy,
        "V-D1",
        "לא יודע מה אפשר לעשות איתך",
      );
      expect(rows[rows.length - 1]!.hasFixedDoctorFi).toBe(false);
      expect(rows[rows.length - 1]!.hasFixedMilkFi).toBe(false);
      // Should mention everyday help somehow (remember/save/manage or concrete examples).
      expect(spoken).toMatch(/לזכור|לשמור|למצוא|קניות|משימ|תזכור|תייק|רשימ/);
      // Must not dump the capability brochure (same bar as fi-discovery).
      const catalogHits = (
        spoken.match(
          /מניות|קריפטו|שערי מטבע|סמארט\s*סקול|משוב|Waze|ווייז|טיסות|תחבורה ציבורית|handoff|סיכומים מתוזמנים/gi,
        ) ?? []
      ).length;
      expect(catalogHits, spoken).toBeLessThanOrEqual(1);
      expect(spoken.length, `too long:\n${spoken}`).toBeLessThan(700);
      expect(spoken).toMatch(/\?|？|מה |איזה |תרצ|רוצה /);
    },
    TIMEOUT,
  );

  it(
    "V-F1/F2 filing save then natural retrieve (engine truth)",
    async () => {
      const save = await turn(
        member,
        memberLucy,
        "V-F1",
        "תייקי שקוד הכניסה לבניין הוא 4488",
      );
      const filed =
        save.spoken.match(/תייק|שמר/) &&
        (filingActions(save.reply).length > 0 ||
          listActions(save.reply).includes("add") ||
          (
            await prisma.employeeFiling.findFirst({
              where: {
                employeeId: member.employeeId,
                deletedAt: null,
                OR: [
                  { itemInfo: { contains: "4488" } },
                  { itemName: { contains: "קוד" } },
                ],
              },
            })
          ) != null);
      expect(filed).toBe(true);

      const row = await prisma.employeeFiling.findFirst({
        where: {
          employeeId: member.employeeId,
          deletedAt: null,
          itemInfo: { contains: "4488" },
        },
      });
      expect(row).toBeTruthy();

      const { spoken } = await turn(
        member,
        memberLucy,
        "V-F2",
        "מה קוד הכניסה לבניין?",
      );
      expect(spoken).toMatch(/4488/);
    },
    TIMEOUT,
  );

  it(
    "FI-M3 practical shopping save",
    async () => {
      const { spoken, reply } = await turn(
        member,
        memberLucy,
        "FI-M3",
        "צריך לקנות לחם",
      );
      expect(listActions(reply)).toContain("add");
      expect(spoken).toMatch(/לחם/);
      const item = await prisma.employeeListItem.findFirst({
        where: {
          list: { employeeId: member.employeeId, listType: "shopping" },
          deletedAt: null,
        },
      });
      expect(item).toBeTruthy();
    },
    TIMEOUT,
  );

  it(
    "FI-P1 prospect greeting — no fixed milk FI",
    async () => {
      const { spoken } = await turn(prospect, prospectLucy, "FI-P1", "היי");
      expect(spoken.length).toBeGreaterThan(0);
      expect(rows[rows.length - 1]!.hasFixedMilkFi).toBe(false);
      expect(rows[rows.length - 1]!.hasFixedDoctorFi).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "V-D3 no opportunity — no forced act after soft chat",
    async () => {
      const { reply } = await turn(
        prospect,
        prospectLucy,
        "V-D3",
        "סתם רציתי להגיד שלום בלי לבקש כלום",
      );
      expect(listActions(reply)).toEqual([]);
      expect(rows[rows.length - 1]!.hasFixedMilkFi).toBe(false);
    },
    TIMEOUT,
  );
});
