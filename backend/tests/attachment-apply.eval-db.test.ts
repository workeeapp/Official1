/**
 * PRODUCTION APPLY (eval-db) — real applyAttachmentLinks / list-ops / records
 * on approved workee_test. No OpenAI, WhatsApp, or reminder ticker.
 *
 * These tests prove engine persistence and honesty — NOT live model prompt compliance.
 *
 * Run: npm run test:eval-db -- tests/attachment-apply.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/database/prisma.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { emptyLlmMetadata } from "@workee/shared";
import {
  applyAttachmentLinks,
  emptyAttachmentOutcome,
  withAttachmentRefs,
} from "../src/services/attachment.service.js";
import { applyListOps } from "../src/services/list-ops.service.js";
import {
  applyEmployeeRecords,
  getEmployeeRecordSnapshot,
} from "../src/services/employee-records.service.js";
import { formatShowDumpFromKind } from "../src/services/show-button-dump.js";

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
  expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
});

async function seedAttachment(account: HarnessAccount) {
  return prisma.attachment.create({
    data: {
      id: randomUUID(),
      userId: account.userId,
      uploaderId: account.employeeId,
      kind: "image",
      mimeType: "image/jpeg",
      fileName: "eval.jpg",
      storageKey: `eval/${randomUUID()}.jpg`,
      sizeBytes: 12,
    },
  });
}

async function ensureShoppingList(account: HarnessAccount) {
  return (
    (await prisma.employeeList.findFirst({
      where: {
        employeeId: account.employeeId,
        listType: "shopping",
        name: "",
        deletedAt: null,
      },
    })) ??
    (await prisma.employeeList.create({
      data: {
        employeeId: account.employeeId,
        listType: "shopping",
        name: "",
        scope: "personal",
        visibleTo: [account.employeeId],
      },
    }))
  );
}

describe("attachment production apply (eval-db)", () => {
  let account: HarnessAccount | null = null;

  afterEach(async () => {
    if (!account) return;
    await prisma.attachmentLink
      .deleteMany({ where: { attachment: { userId: account.userId } } })
      .catch(() => undefined);
    await prisma.attachment
      .deleteMany({ where: { userId: account.userId } })
      .catch(() => undefined);
    await destroyHarnessAccount(account);
    account = null;
  });

  it("list-level attach via alter_list add_attachments → AttachmentLink.listId", async () => {
    account = await createHarnessAccount("טל");
    const list = await ensureShoppingList(account);
    const att = await seedAttachment(account);
    const [result] = await applyListOps({
      userId: account.userId,
      actor: account.actor,
      employees: account.employees,
      ops: [
        {
          action: "alter_list",
          listId: list.id,
          newName: "",
          addColumns: [],
          removeColumns: [],
          renameColumns: [],
          addParticipants: [],
          removeParticipants: [],
          addAttachments: [att.id],
          removeAttachments: [],
        },
      ],
    });
    expect(result.applied).toBe(true);
    expect(result.attachmentOutcome?.linked).toBe(1);
    const link = await prisma.attachmentLink.findFirst({
      where: { attachmentId: att.id, listId: list.id },
    });
    expect(link).toBeTruthy();
  });

  it("item-level attach via lists add → AttachmentLink.listItemId", async () => {
    account = await createHarnessAccount("טל");
    const att = await seedAttachment(account);
    const applied = await applyEmployeeRecords(
      account.employeeId,
      {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "חלב-att", attachment_ids: [att.id] }],
            targets: [],
          },
        ],
      },
      undefined,
      account.employeeId,
    );
    expect(applied.attachmentOutcome.linked).toBe(1);
    const item = await prisma.employeeListItem.findFirst({
      where: {
        deletedAt: null,
        list: { employeeId: account.employeeId, listType: "shopping" },
        itemKey: { contains: "חלב" },
      },
    });
    expect(item).toBeTruthy();
    const link = await prisma.attachmentLink.findFirst({
      where: { attachmentId: att.id, listItemId: item!.id },
    });
    expect(link).toBeTruthy();
  });

  it("explicit filing add + attachment_ids → AttachmentLink.filingId", async () => {
    account = await createHarnessAccount("טל");
    const att = await seedAttachment(account);
    const applied = await applyEmployeeRecords(
      account.employeeId,
      {
        ...emptyLlmMetadata(),
        filing: [
          {
            action: "add_filing",
            itemName: "רישיון-att",
            itemInfo: "",
            itemDescription: "",
            filingId: "",
            targets: [],
            attachmentIds: [att.id],
          },
        ],
      },
      undefined,
      account.employeeId,
    );
    expect(applied.attachmentOutcome.linked).toBe(1);
    const filing = await prisma.employeeFiling.findFirst({
      where: {
        employeeId: account.employeeId,
        itemName: "רישיון-att",
        deletedAt: null,
      },
    });
    expect(filing).toBeTruthy();
    const link = await prisma.attachmentLink.findFirst({
      where: { attachmentId: att.id, filingId: filing!.id },
    });
    expect(link).toBeTruthy();
  });

  it("bad attachment id → no link; alreadyLinked on second attach", async () => {
    account = await createHarnessAccount("טל");
    const list = await ensureShoppingList(account);
    const att = await seedAttachment(account);
    const junk = await applyAttachmentLinks({
      actorId: account.employeeId,
      target: { listId: list.id },
      attachmentIds: ["not-a-uuid"],
    });
    expect(junk).toMatchObject({
      linked: 0,
      alreadyLinked: 0,
      attachRequested: true,
    });
    expect(
      await prisma.attachmentLink.count({
        where: { listId: list.id },
      }),
    ).toBe(0);

    const first = await applyAttachmentLinks({
      actorId: account.employeeId,
      target: { listId: list.id },
      attachmentIds: [att.id],
    });
    expect(first.linked).toBe(1);
    const second = await applyAttachmentLinks({
      actorId: account.employeeId,
      target: { listId: list.id },
      attachmentIds: [att.id],
    });
    expect(second).toMatchObject({
      linked: 0,
      alreadyLinked: 1,
      attachRequested: true,
    });
    expect(
      await prisma.attachmentLink.count({
        where: { attachmentId: att.id, listId: list.id },
      }),
    ).toBe(1);
  });

  it("emptyAttachmentOutcome helper defaults", () => {
    expect(emptyAttachmentOutcome()).toEqual({
      linked: 0,
      alreadyLinked: 0,
      detached: 0,
      attachRequested: false,
    });
  });
});

/**
 * Dump acceptance (eval-db): attach → withAttachmentRefs → formatShowDumpFromKind.
 * Proves what a WhatsApp/chat show_dump REPLACE would show for 📎 — not model prompt compliance.
 *
 * Note: shopping dump only emits a header when there is ≥1 item row (empty lists use
 * «אין קניות שמורות.» without list-level 📎). List-level case therefore seeds one
 * item without an item-link so the header can carry has_attachments.
 */
describe("attachment dump acceptance (eval-db)", () => {
  let account: HarnessAccount | null = null;

  afterEach(async () => {
    if (!account) return;
    await prisma.attachmentLink
      .deleteMany({ where: { attachment: { userId: account.userId } } })
      .catch(() => undefined);
    await prisma.attachment
      .deleteMany({ where: { userId: account.userId } })
      .catch(() => undefined);
    await destroyHarnessAccount(account);
    account = null;
  });

  it("list-level link → shopping dump header includes קניות 📎:", async () => {
    account = await createHarnessAccount("טל");
    const list = await ensureShoppingList(account);
    await prisma.employeeListItem.create({
      data: {
        listId: list.id,
        itemKey: "לחם-dump",
        data: { "שם פריט": "לחם-dump", כמות: 1 },
        scope: "personal",
        addedById: account.employeeId,
        visibleTo: [account.employeeId],
      },
    });
    const att = await seedAttachment(account);
    const linked = await applyAttachmentLinks({
      actorId: account.employeeId,
      target: { listId: list.id },
      attachmentIds: [att.id],
    });
    expect(linked.linked).toBe(1);

    const raw = await getEmployeeRecordSnapshot(account.employeeId);
    const snapshot = await withAttachmentRefs(raw);
    const shoppingList = snapshot.lists.find((row) => row.list_type === "shopping");
    expect(shoppingList?.has_attachments).toBe(true);

    const dump = formatShowDumpFromKind("shopping", snapshot, {
      viewerName: "טל",
    });
    expect(dump).toContain("קניות 📎:");
    expect(dump).toMatch(/לחם-dump/);
    // Item has no listItemId link — line must not get a paperclip from list-level alone.
    expect(dump).not.toMatch(/לחם-dump[^\n]*📎/);
  });

  it("item-only link → shopping dump: no header 📎, item line has 📎", async () => {
    account = await createHarnessAccount("טל");
    const att = await seedAttachment(account);
    await applyEmployeeRecords(
      account.employeeId,
      {
        ...emptyLlmMetadata(),
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "יוגורט-dump", attachment_ids: [att.id] }],
            targets: [],
          },
        ],
      },
      undefined,
      account.employeeId,
    );

    const raw = await getEmployeeRecordSnapshot(account.employeeId);
    const snapshot = await withAttachmentRefs(raw);
    const shoppingList = snapshot.lists.find((row) => row.list_type === "shopping");
    expect(shoppingList?.has_attachments).not.toBe(true);

    const dump = formatShowDumpFromKind("shopping", snapshot, {
      viewerName: "טל",
    });
    expect(dump).toContain("קניות:");
    expect(dump).not.toContain("קניות 📎:");
    expect(dump).toMatch(/יוגורט-dump[^\n]*📎/);
  });
});
