/**
 * Q1 — production instruction baseline (eval-db, NO model call).
 *
 * Drives the real `sendChatMessage` on approved workee_test with a recording
 * LLM client, captures the exact `instructions` string passed to
 * createResponse, and hashes it (SHA-256) for six scenarios:
 *   owner · non-owner · guest · guest+pendingInvite · consult · thin custom worker
 *
 * Account-specific UUIDs are replaced by stable role placeholders before
 * hashing (recorded in the manifest), so before/after runs are comparable.
 *
 *   Q1_TAG=before npm run test:eval-db -w backend -- tests/q1-instructions-baseline.eval-db.test.ts
 *   Q1_TAG=after  npm run test:eval-db -w backend -- tests/q1-instructions-baseline.eval-db.test.ts
 * With Q1_TAG=after and a recorded `before`, every hash must match (A1), and the
 * shared builder `buildLucyInstructions`, fed the same employees / flags, must
 * reproduce the captured string byte-for-byte (A2).
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "../src/config/env.js";
import { prisma } from "../src/database/prisma.js";
import {
  setLlmClientForTests,
  type LlmClient,
  type LlmResponseInput,
} from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  ensureLucy,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";

const TAG = (process.env.Q1_TAG ?? "before").trim() || "before";
const OUT_ROOT = resolve(process.cwd(), "scripts", ".tmp-q1");
const OUT = resolve(OUT_ROOT, TAG);

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function lucyConfigInstructions(): string {
  const raw = JSON.parse(
    readFileSync(resolve(process.cwd(), "..", "LLM.config.json"), "utf8"),
  ) as { systemMessage: string[] };
  return raw.systemMessage.join("\n");
}

describe("Q1 production instruction baseline (recording client, no model)", () => {
  let account: HarnessAccount | null = null;
  const calls: LlmResponseInput[] = [];
  const ids = new Map<string, string>(); // uuid → placeholder
  const manifest: Record<string, unknown> = { tag: TAG, scenarios: {} };

  const recorder: LlmClient = {
    async createConversation() {
      return `q1-conv-${randomUUID()}`;
    },
    async createResponse(input) {
      calls.push(input);
      return { reply: "בסדר", raw: {}, usage: null };
    },
    async appendAssistantMessage() {},
  };

  const normalize = (text: string) => {
    let out = text;
    for (const [uuid, label] of ids) out = out.split(uuid).join(label);
    return out;
  };

  let ctx: {
    owner: string;
    member: string;
    guest: string;
    lucy: string;
    consultWorker: string;
    thinWorker: string;
  };

  beforeAll(async () => {
    resetEnvCache();
    await assertEvalDbAndGtfsUntouched();
    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent");
    vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent");
    vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0);
    vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => {});
    setLlmClientForTests(recorder);

    account = await createHarnessAccount("טל");
    const owner = account.employeeId;
    await prisma.employee.update({
      where: { id: owner },
      data: { isOwner: true, addressGender: "male" },
    });
    const member = (
      await prisma.employee.create({
        data: { userId: account.userId, kind: "human", name: "עמית", surname: "", nickname: "עמית", isOwner: false, addressGender: "male" },
        select: { id: true },
      })
    ).id;
    const guest = (
      await prisma.employee.create({
        data: { userId: account.userId, kind: "human", name: "אורח", surname: "", nickname: "אורח", isOwner: false, isGuest: true },
        select: { id: true },
      })
    ).id;
    const config = lucyConfigInstructions();
    const lucy = await ensureLucy(account, config);
    const consultWorker = (
      await prisma.employee.create({
        data: { userId: account.userId, kind: "digital", name: "דנה", surname: "", nickname: "דנה", instructions: config },
        select: { id: true },
      })
    ).id;
    const thinWorker = (
      await prisma.employee.create({
        data: {
          userId: account.userId,
          kind: "digital",
          name: "בוט",
          surname: "",
          nickname: "בוט",
          instructions: "You are a small test worker. Answer briefly in Hebrew.",
        },
        select: { id: true },
      })
    ).id;
    ctx = { owner, member, guest, lucy, consultWorker, thinWorker };
    ids.set(account.userId, "<USER>");
    for (const [role, id] of Object.entries(ctx)) ids.set(id, `<${role.toUpperCase()}>`);
    mkdirSync(OUT, { recursive: true });
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    setLlmClientForTests(null);
    if (account) await cleanupHarnessAccount(account);
    writeFileSync(resolve(OUT, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  });

  const scenarios: Array<{
    name: string;
    input: () => Parameters<typeof sendChatMessage>[0];
    describe: string;
    /** Builder flags for A2 (speaker display name + role). */
    builder: () => {
      digital: string;
      speaker: string;
      speakerIsOwner: boolean;
      guestSpeaker: boolean;
      consultFrom: string;
    };
  }> = [
    {
      name: "owner",
      builder: () => ({ digital: ctx.lucy, speaker: "טל", speakerIsOwner: true, guestSpeaker: false, consultFrom: "" }),
      describe: "account owner → Lucy (protected digital, LLM.config instructions)",
      input: () => ({ userId: account!.userId, employeeId: ctx.owner, digitalEmployeeId: ctx.lucy, message: "היי" }),
    },
    {
      name: "non-owner",
      builder: () => ({ digital: ctx.lucy, speaker: "עמית", speakerIsOwner: false, guestSpeaker: false, consultFrom: "" }),
      describe: "non-owner human → Lucy",
      input: () => ({ userId: account!.userId, employeeId: ctx.member, digitalEmployeeId: ctx.lucy, message: "היי" }),
    },
    {
      name: "guest",
      builder: () => ({ digital: ctx.lucy, speaker: "אורח", speakerIsOwner: false, guestSpeaker: true, consultFrom: "" }),
      describe: "WhatsApp guest (isGuest) → Lucy, no pending invite",
      input: () => ({ userId: account!.userId, employeeId: ctx.guest, digitalEmployeeId: ctx.lucy, message: "היי" }),
    },
    {
      name: "guest-pending-invite",
      builder: () => ({ digital: ctx.lucy, speaker: "אורח", speakerIsOwner: false, guestSpeaker: true, consultFrom: "" }),
      describe: "guest → Lucy with PENDING_INVITE (askerName טל)",
      input: () => ({
        userId: account!.userId,
        employeeId: ctx.guest,
        digitalEmployeeId: ctx.lucy,
        message: "היי",
        pendingInvite: {
          inviteId: "q1-invite",
          token: "q1-token",
          askerName: "טל",
          askSummary: "אם קנית חלב",
          recipientLabel: "אורח",
        },
      }),
    },
    {
      name: "consult",
      builder: () => ({ digital: ctx.lucy, speaker: "טל", speakerIsOwner: true, guestSpeaker: false, consultFrom: "דנה" }),
      describe: "owner's question relayed by digital worker דנה (consult) → Lucy",
      input: () => ({
        userId: account!.userId,
        employeeId: ctx.owner,
        digitalEmployeeId: ctx.lucy,
        message: "מה יש לטל ברשימת הקניות?",
        consult: { fromWorkerId: ctx.consultWorker, fromWorkerName: "דנה" },
      }),
    },
    {
      name: "thin-custom-worker",
      builder: () => ({ digital: ctx.thinWorker, speaker: "טל", speakerIsOwner: true, guestSpeaker: false, consultFrom: "" }),
      describe: "owner → non-protected digital with its own instructions (thin envelope branch)",
      input: () => ({ userId: account!.userId, employeeId: ctx.owner, digitalEmployeeId: ctx.thinWorker, message: "היי" }),
    },
  ];

  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const captured: string[] = [];
      let rawFirst: string | undefined;
      // Two turns: proves the captured string is deterministic for the scenario.
      for (let turn = 0; turn < 2; turn += 1) {
        const before = calls.length;
        await sendChatMessage(scenario.input());
        expect(calls.length, "exactly one model call per turn").toBe(before + 1);
        const instructions = calls[calls.length - 1]!.instructions;
        expect(typeof instructions === "string" && instructions.length > 0).toBe(true);
        captured.push(normalize(instructions!));
        rawFirst ??= instructions!;
      }
      expect(captured[1], "instructions stable across turns").toBe(captured[0]);
      const text = captured[0]!;
      const hash = sha(text);
      writeFileSync(resolve(OUT, `${scenario.name}.txt`), text, "utf8");
      writeFileSync(resolve(OUT, `${scenario.name}.sha256`), `${hash}\n`, "utf8");
      (manifest.scenarios as Record<string, unknown>)[scenario.name] = {
        describe: scenario.describe,
        input: JSON.parse(normalize(JSON.stringify(scenario.input()))),
        chars: text.length,
        sha256: hash,
      };
      console.info(`Q1 ${TAG} ${scenario.name} chars=${text.length} sha256=${hash}`);

      if (TAG !== "before") {
        // A2: the shared builder reproduces exactly what sendChatMessage sent.
        const chat = await import("../src/services/chat.service.js");
        const { listEmployeesForUser } = await import("../src/services/employee.service.js");
        const employees = await listEmployeesForUser(account!.userId);
        const flags = scenario.builder();
        const digital = employees.find((row) => row.id === flags.digital)!;
        const invite = scenario.input().pendingInvite ?? null;
        const built = (chat as unknown as {
          buildLucyInstructions: (input: unknown) => string;
        }).buildLucyInstructions({
          digital,
          employees,
          speaker: flags.speaker,
          speakerIsOwner: flags.speakerIsOwner,
          guestSpeaker: flags.guestSpeaker,
          pendingInvite: invite,
          consultFrom: flags.consultFrom,
        });
        expect(built === rawFirst, `${scenario.name}: builder output must equal the sent instructions`).toBe(true);
      }

      const beforeFile = resolve(OUT_ROOT, "before", `${scenario.name}.sha256`);
      if (TAG !== "before" && existsSync(beforeFile)) {
        expect(hash, `${scenario.name} must match the pre-change baseline`).toBe(
          readFileSync(beforeFile, "utf8").trim(),
        );
      }
    }, 120_000);
  }
});
