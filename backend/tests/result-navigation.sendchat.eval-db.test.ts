/**
 * N1 end-to-end on the production path (sendChatMessage, scripted model,
 * approved workee_test): a saved row gets a direct id-addressed tap; tapping
 * it renders exactly that row (engine ITEM DUMP), whatever the model says;
 * another account's id renders nothing. No WhatsApp / reminder delivery.
 *
 * Run: npm run test:eval-db -- tests/result-navigation.sendchat.eval-db.test.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import {
  itemOpenTapCommand,
  parseItemNavRef,
} from "../src/services/builtin-lists.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import { jerusalemYmd } from "../src/utils/relative-date.js";
import {
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  stubLlmReply,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

function replyButtons(reply: string): Array<{ label: string; command: string }> {
  return parseLlmReply(reply).responseBubbles.flatMap((b) => b.buttons ?? []);
}

function inDays(days: number): string {
  const [y, m, d] = jerusalemYmd(new Date()).split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** The model's reply to a tap is irrelevant: the engine owns item-open taps. */
const unrelatedModelReply = {
  responses: [{ text: "בטח.", buttons: [] }],
  metadata: { show_dump: "full" },
};

describe("N1 result navigation via sendChatMessage", () => {
  const accounts: HarnessAccount[] = [];
  const marker = `n1-${Date.now().toString(36)}`;

  afterEach(async () => {
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    while (accounts.length > 0) {
      await cleanupHarnessAccount(accounts.pop()!);
    }
  });

  async function setup(name = "טל"): Promise<{ account: HarnessAccount; lucyId: string }> {
    const account = await createHarnessAccount(name);
    accounts.push(account);
    const lucyId = await ensureLucy(account);
    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent" as never);
    vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent" as never);
    vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0 as never);
    vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => undefined);
    return { account, lucyId };
  }

  async function turn(
    ctx: { account: HarnessAccount; lucyId: string },
    message: string,
    modelReply: unknown,
  ): Promise<string> {
    setLlmClientForTests(stubLlmReply(modelReply));
    const result = await sendChatMessage({
      userId: ctx.account.userId,
      employeeId: ctx.account.employeeId,
      digitalEmployeeId: ctx.lucyId,
      message,
    });
    return result.reply;
  }

  it("dated task: item tap (its id) + day tap; tapping shows exactly that task", async () => {
    const ctx = await setup();
    const date = inDays(9);
    const target = `תור-${marker}`;
    const other = `אחר-${marker}`;
    const addReply = await turn(ctx, `תוסיפי ${target} ו־${other}`, {
      responses: [{ text: "הוספתי.", buttons: [] }],
      metadata: {
        lists: [
          {
            action: "add",
            list_type: "tasks",
            list_name: "",
            items: [{ "שם משימה": target, "תאריך לביצוע": date }],
            targets: [],
          },
        ],
      },
    });
    const buttons = replyButtons(addReply);
    const itemTap = buttons.find((b) => parseItemNavRef(b.command)?.[0]?.kind === "t");
    expect(itemTap, JSON.stringify(buttons)).toBeTruthy();
    expect(buttons.some((b) => b.command === `מה יש לי ב־${date} ברשימת משימות`)).toBe(true);
    const row = await prisma.employeeListItem.findUnique({
      where: { id: parseItemNavRef(itemTap!.command)![0]!.id },
    });
    expect(JSON.stringify(row?.data)).toContain(target);

    // A second, unrelated task so the tap must pick by id.
    await turn(ctx, `תוסיפי ${other}`, {
      responses: [{ text: "הוספתי.", buttons: [] }],
      metadata: {
        lists: [
          { action: "add", list_type: "tasks", list_name: "", items: [{ "שם משימה": other }], targets: [] },
        ],
      },
    });
    const tapped = parseLlmReply(await turn(ctx, itemTap!.command, unrelatedModelReply)).response;
    expect(tapped).toContain(target);
    expect(tapped).not.toContain(other);
  }, 120_000);

  it("shopping with a description and filings get direct taps; a plain shopping row keeps «הצג קניות»", async () => {
    const ctx = await setup();
    const milk = `חלב-${marker}`;
    const bread = `לחם-${marker}`;
    const code = `קוד-${marker}`;
    const reply = await turn(ctx, "תוסיפי חלב ולחם ותתייקי קוד", {
      responses: [{ text: "שמרתי.", buttons: [] }],
      metadata: {
        lists: [
          {
            action: "add",
            list_type: "shopping",
            list_name: "",
            items: [
              { "שם פריט": milk, description: "של תנובה 3%" },
              { "שם פריט": bread },
            ],
            targets: [],
          },
        ],
        filing: [
          { action: "add_filing", item_name: code, item_info: "4321", item_description: "", filing_id: "", targets: [] },
        ],
      },
    });
    const buttons = replyButtons(reply);
    const shopTaps = buttons.filter((b) => parseItemNavRef(b.command)?.[0]?.kind === "s");
    expect(shopTaps, JSON.stringify(buttons)).toHaveLength(1);
    const milkRow = await prisma.employeeListItem.findUnique({
      where: { id: parseItemNavRef(shopTaps[0]!.command)![0]!.id },
    });
    expect(JSON.stringify(milkRow?.data)).toContain(milk);
    expect(buttons.some((b) => b.command === "הצג רשימת קניות")).toBe(true);

    const shownMilk = parseLlmReply(await turn(ctx, shopTaps[0]!.command, unrelatedModelReply)).response;
    expect(shownMilk).toContain(milk);
    expect(shownMilk).toContain("של תנובה 3%");

    const fileTap = buttons.find((b) => parseItemNavRef(b.command)?.[0]?.kind === "f");
    expect(fileTap, JSON.stringify(buttons)).toBeTruthy();
    const shownCode = parseLlmReply(await turn(ctx, fileTap!.command, unrelatedModelReply)).response;
    expect(shownCode).toContain(code);
  }, 120_000);

  it("another account's id renders nothing (existing no-match)", async () => {
    const owner = await setup("דנה");
    const secret = `פרטי-${marker}`;
    const reply = await turn(owner, `תוסיפי ${secret}`, {
      responses: [{ text: "הוספתי.", buttons: [] }],
      metadata: {
        lists: [
          { action: "add", list_type: "tasks", list_name: "", items: [{ "שם משימה": secret }], targets: [] },
        ],
      },
    });
    const foreignId = replyButtons(reply)
      .map((b) => parseItemNavRef(b.command)?.[0])
      .find((ref) => ref?.kind === "t")!.id;

    const intruder = await setup("טל");
    const shown = parseLlmReply(
      await turn(intruder, itemOpenTapCommand({ kind: "t", id: foreignId }, secret), unrelatedModelReply),
    ).response;
    expect(shown).not.toContain(secret);
    expect(shown).toContain("לא מצאתי את הפריט");
  }, 120_000);

  it("a failed save gets no item tap", async () => {
    const ctx = await setup();
    // update of a row id that does not exist → nothing applied
    const reply = await turn(ctx, "תעדכני", {
      responses: [{ text: "עדכנתי.", buttons: [] }],
      metadata: {
        lists: [
          {
            action: "update",
            list_type: "tasks",
            list_name: "",
            items: [{ item_id: "00000000-0000-4000-8000-000000000000", "שם משימה": "לא קיים" }],
            targets: [],
          },
        ],
      },
    });
    expect(replyButtons(reply).some((b) => parseItemNavRef(b.command))).toBe(false);
  }, 120_000);
});
