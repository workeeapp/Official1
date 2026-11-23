/**
 * FI discovery quality — production-path live model.
 * Asserts short everyday discovery vs feature catalog.
 *
 * Run:
 *   npm run test:eval-db -- tests/fi-discovery.live-sendchat.eval-db.test.ts
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
const REPORT = resolve(process.cwd(), "scripts/.tmp-fi-discovery-live.json");

/** Live-tool brochure markers — discovery replies must not pile these on. */
const CATALOG_NEEDLES =
  /מניות|קריפטו|שערי מטבע|סמארט\s*סקול|משוב|Waze|ווייז|טיסות|תחבורה ציבורית|Aviation|handoff|מעקב אחרי תנאים|סיכומים מתוזמנים/i;

const FIXED_FI = /משימה ראשונה|להתקשר לרופא\?|נתחיל בקניות|אוסיף חלב\?/;

type Row = {
  id: string;
  utterance: string;
  spoken: string;
  chars: number;
  catalogHits: number;
  hasQuestion: boolean;
  everydayHint: boolean;
  fixedFi: boolean;
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

function catalogHitCount(text: string): number {
  return (text.match(new RegExp(CATALOG_NEEDLES.source, "gi")) ?? []).length;
}

function score(id: string, utterance: string, spoken: string): Row {
  return {
    id,
    utterance,
    spoken,
    chars: spoken.length,
    catalogHits: catalogHitCount(spoken),
    hasQuestion: /\?|？|מה |איזה |תרצ|רוצה /.test(spoken),
    everydayHint:
      /תזכור|לזכור|משימ|קוד|לשמור|למצוא|תייק|קניות|רשימ|שוכח|תור/.test(spoken),
    fixedFi: FIXED_FI.test(spoken),
  };
}

async function turn(
  account: HarnessAccount,
  lucyId: string,
  id: string,
  utterance: string,
): Promise<Row> {
  resetPieArbitrationStateForTests();
  const result = await sendChatMessage({
    userId: account.userId,
    employeeId: account.employeeId,
    digitalEmployeeId: lucyId,
    message: utterance,
  });
  const spoken = spokenAll(result.reply);
  const row = score(id, utterance, spoken);
  rows.push(row);
  // Discovery turns stay non-mutating unless the user asked to save.
  if (!/תייקי|תוסיפי|תזכירי/.test(utterance)) {
    expect(parseReplyMetadata(result.reply).lists ?? []).toEqual([]);
  }
  return row;
}

function expectDiscovery(row: Row) {
  expect(row.fixedFi, row.spoken).toBe(false);
  expect(row.catalogHits, row.spoken).toBeLessThanOrEqual(1);
  expect(row.chars, `too long:\n${row.spoken}`).toBeLessThan(700);
  expect(row.everydayHint, row.spoken).toBe(true);
  expect(row.hasQuestion, row.spoken).toBe(true);
}

describe("FI discovery quality (live model)", () => {
  let fresh: HarnessAccount;
  let freshLucy: string;
  let filer: HarnessAccount;
  let filerLucy: string;

  beforeAll(async () => {
    expect(injectProductEnvKey("OPENAI_API_KEY").present).toBe(true);
    assertEvalDbAndGtfsUntouched();
    const config = loadLucyConfig();
    expect(config.instructions).toMatch(/VALUE DISCOVERY REPLY|VALUE DISCOVERY/);
    expect(config.instructions).toMatch(/FORBIDDEN on these discovery asks/);

    fresh = await createHarnessAccount("טל", { partners: [] });
    freshLucy = await ensureLucy(fresh, config.instructions);
    await prisma.employee.update({
      where: { id: freshLucy },
      data: {
        instructions: config.instructions,
        model: config.model,
        temperature: config.temperature,
        reasoningEffort: config.reasoningEffort,
      },
    });
    await prisma.user.update({
      where: { id: fresh.userId },
      data: { consentPending: false },
    });

    filer = await createHarnessAccount("מיכל", { partners: [] });
    filerLucy = await ensureLucy(filer, config.instructions);
    await prisma.employee.update({
      where: { id: filerLucy },
      data: {
        instructions: config.instructions,
        model: config.model,
        temperature: config.temperature,
        reasoningEffort: config.reasoningEffort,
      },
    });
    await prisma.user.update({
      where: { id: filer.userId },
      data: { consentPending: false },
    });
    await prisma.employeeFiling.create({
      data: {
        employeeId: filer.employeeId,
        itemName: "קוד כניסה",
        itemInfo: "4488",
        itemDescription: "בניין",
        scope: "personal",
        visibleTo: [filer.employeeId],
      },
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
    if (fresh) await cleanupHarnessAccount(fresh);
    if (filer) await cleanupHarnessAccount(filer);
  });

  it(
    "D1 «היי, מה אפשר לעשות איתך?»",
    async () => {
      expectDiscovery(
        await turn(fresh, freshLucy, "D1", "היי, מה אפשר לעשות איתך?"),
      );
    },
    TIMEOUT,
  );

  it(
    "D2 «אני לא ממש יודע איך להשתמש בך»",
    async () => {
      expectDiscovery(
        await turn(
          fresh,
          freshLucy,
          "D2",
          "אני לא ממש יודע איך להשתמש בך",
        ),
      );
    },
    TIMEOUT,
  );

  it(
    "D3 forgetful — lean remember, still short",
    async () => {
      const row = await turn(
        fresh,
        freshLucy,
        "D3",
        "הכול אצלי בראש ואני שוכח דברים",
      );
      expectDiscovery(row);
      expect(row.spoken).toMatch(/תזכור|לזכור|שוכח|משימ|תור/);
    },
    TIMEOUT,
  );

  it(
    "D1b alternate phrasing «מה את יודעת לעשות?»",
    async () => {
      // New account slice via same fresh (already chatted) — still must stay short.
      expectDiscovery(
        await turn(fresh, freshLucy, "D1b", "רגע, מה את יודעת לעשות בעצם?"),
      );
    },
    TIMEOUT,
  );

  it(
    "D4 filer asks «מה עוד» — extend from filing, no brochure",
    async () => {
      const row = await turn(
        filer,
        filerLucy,
        "D4",
        "מה עוד את יכולה לעשות בשבילי?",
      );
      expectDiscovery(row);
      // Should not restart as if they have no context — mention save/find or adjacent help.
      expect(row.spoken).toMatch(/שמר|תייק|קוד|למצוא|תזכור|רשימ|קניות|משימ/);
    },
    TIMEOUT,
  );

  it(
    "D5 bare היי — short, not pillar dump",
    async () => {
      const account = await createHarnessAccount("עמית", { partners: [] });
      try {
        const config = loadLucyConfig();
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
        await prisma.user.update({
          where: { id: account.userId },
          data: { consentPending: false },
        });
        const row = await turn(account, lucyId, "D5", "היי");
        expect(row.fixedFi).toBe(false);
        expect(row.catalogHits).toBe(0);
        expect(row.chars).toBeLessThan(220);
        // Must not recite remember/save/manage as an opening brochure.
        const pillarDump =
          /לזכור/.test(row.spoken) &&
          /לשמור|למצוא|תייק/.test(row.spoken) &&
          /קניות|לנהל/.test(row.spoken);
        expect(pillarDump).toBe(false);
      } finally {
        await cleanupHarnessAccount(account);
      }
    },
    TIMEOUT,
  );
});
