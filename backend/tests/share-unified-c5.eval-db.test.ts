/**
 * C5: contacts / filings / custom-list co-share on approved workee_test.
 * Run: npm run test:eval-db -- tests/share-unified-c5.eval-db.test.ts
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyShowButtonsToBubbles,
  emptyLlmMetadata,
  parseLlmReply,
  type LlmMetadata,
} from "@workee/shared";
import {
  applyEmployeeRecords,
  correctShareClaimReply,
  getEmployeeRecordSnapshot,
  loadFilingOwners,
  loadListItemOwners,
  readItemId,
  type ListItemMutation,
  type ShareApplyMiss,
} from "../src/services/employee-records.service.js";
import {
  applyDirectoryActions,
  listContactsForEmployee,
} from "../src/services/contact.service.js";
import {
  ensureSpeakerShowButtons,
  filingActionIds,
  listActionItemIds,
  planTargetedActions,
} from "../src/services/employee-targets.service.js";
import { setEngineResponse } from "../src/services/whatsapp-send.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { prisma } from "../src/database/prisma.js";

const SPEAKER = "טל";
const PARTNER = "עמית";

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
});

async function applyLikeChat(account: HarnessAccount, metadata: LlmMetadata) {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  const itemOwners = await loadListItemOwners(
    account.userId,
    listActionItemIds(metadata.lists ?? []),
  );
  const filingOwners = await loadFilingOwners(
    account.userId,
    filingActionIds(metadata.filing ?? []),
  );
  const plan = planTargetedActions({
    actor: account.actor,
    employees: account.employees,
    metadata,
    itemOwners,
    filingOwners,
  });
  const mutations: ListItemMutation[] = [];
  const shareMisses: ShareApplyMiss[] = [];
  for (const application of plan.applications) {
    const applied = await applyEmployeeRecords(
      application.employeeId,
      application.metadata,
      application.visibility,
      account.actor.id,
    );
    mutations.push(...applied.mutations);
    shareMisses.push(...applied.shareMisses);
  }
  return { mutations, shareMisses, plan };
}

function finalize(input: {
  claim: string;
  metadata: LlmMetadata;
  mutations: ListItemMutation[];
  shareMisses: ShareApplyMiss[];
}) {
  let reply = JSON.stringify({
    responses: [input.claim],
    metadata: input.metadata,
  });
  reply = correctShareClaimReply({
    reply,
    spoken: parseLlmReply(reply).response,
    mutations: input.mutations,
    misses: input.shareMisses,
    setResponse: setEngineResponse,
  });
  const spoken = parseLlmReply(reply).response.trim();
  const buttons = ensureSpeakerShowButtons(input.metadata, [], {
    speakerNames: [SPEAKER, "Tal"],
  });
  const bubbles = applyShowButtonsToBubbles([{ text: spoken }], buttons);
  return { spoken, buttons, bubbles };
}

describe("unified share C5 domains (eval-db)", () => {
  let account: HarnessAccount | null = null;

  afterEach(async () => {
    if (account) {
      await destroyHarnessAccount(account);
      account = null;
    }
  });

  it("C5a: contacts list co-share — DB + reply buttons", async () => {
    account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
    const amit = account.partners[0]!;
    const metadata: LlmMetadata = {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add",
          listType: "contacts",
          listName: "",
          items: [{ "שם פרטי": "דני-C5", טלפון: "0501111001" }],
          targets: [SPEAKER, PARTNER],
        },
      ],
    };
    const { mutations, shareMisses, plan } = await applyLikeChat(
      account,
      metadata,
    );
    expect(plan.applications.map((a) => a.employeeId)).toEqual([
      account.employeeId,
    ]);
    const itemId = mutations.find((m) => m.action === "add")?.itemId;
    expect(itemId).toBeTruthy();
    const row = await prisma.employeeListItem.findFirst({
      where: { id: itemId!, deletedAt: null },
    });
    expect(row?.scope).toBe("shared");
    expect(row?.visibleTo as string[]).toEqual(
      expect.arrayContaining([account.employeeId, amit.id]),
    );
    const facing = finalize({
      claim: "שיתפתי את איש הקשר דני עם עמית.",
      metadata,
      mutations,
      shareMisses,
    });
    expect(facing.spoken).toContain("שיתפתי");
    expect(
      facing.buttons.some(
        (b) =>
          b.command.includes("אנשי קשר") || b.label.includes("אנשי קשר"),
      ),
    ).toBe(true);
    expect(facing.bubbles[0]?.buttons?.length ?? 0).toBeGreaterThan(0);
  });

  it("C5b: directory phone-book co-share — Contact row + notices", async () => {
    account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
    const amit = account.partners[0]!;
    const result = await applyDirectoryActions({
      userId: account.userId,
      ownerEmployeeId: account.employeeId,
      employees: account.employees,
      actions: [
        {
          action: "add",
          name: "נועה-C5",
          phone: "0521111002",
          contactId: "",
          targets: [SPEAKER, PARTNER],
        },
      ],
    });
    expect(result.saved.length).toBe(1);
    const contacts = await listContactsForEmployee(account.employeeId);
    const noa = contacts.find((c) => c.name.includes("נועה-C5"));
    expect(noa?.scope).toBe("shared");
    expect(noa?.sharedWith).toEqual(
      expect.arrayContaining([SPEAKER, PARTNER]),
    );
    const db = await prisma.contact.findFirst({
      where: { id: noa!.id },
    });
    expect(db?.scope).toBe("shared");
    expect(db?.visibleTo as string[]).toEqual(
      expect.arrayContaining([account.employeeId, amit.id]),
    );
    expect(result.shareNotices.some((n) => n.employeeId === amit.id)).toBe(
      true,
    );
  });

  it("C5c: filing co-share — EmployeeFiling + תיוקים button", async () => {
    account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
    const amit = account.partners[0]!;
    const metadata: LlmMetadata = {
      ...emptyLlmMetadata(),
      filing: [
        {
          action: "add_filing",
          itemName: "קוד-C5",
          itemInfo: "9999",
          itemDescription: "קוד-C5",
          filingId: "",
          targets: [SPEAKER, PARTNER],
        },
      ],
    };
    const { plan } = await applyLikeChat(account, metadata);
    expect(plan.applications.map((a) => a.employeeId)).toEqual([
      account.employeeId,
    ]);
    const filing = await prisma.employeeFiling.findFirst({
      where: {
        employeeId: account.employeeId,
        itemName: "קוד-C5",
        deletedAt: null,
      },
    });
    expect(filing?.scope).toBe("shared");
    expect(filing?.visibleTo as string[]).toEqual(
      expect.arrayContaining([account.employeeId, amit.id]),
    );
    const snap = await getEmployeeRecordSnapshot(account.employeeId);
    expect(JSON.stringify(snap.filing)).toContain("קוד-C5");
    const buttons = ensureSpeakerShowButtons(metadata, [], {
      speakerNames: [SPEAKER, "Tal"],
    });
    expect(
      buttons.some(
        (b) => b.command.includes("תיוק") || b.label.includes("תיוק"),
      ),
    ).toBe(true);
    const bubbles = applyShowButtonsToBubbles(
      [{ text: "שיתפתי את התיוק קוד עם עמית." }],
      buttons,
    );
    expect(bubbles[0]?.buttons?.length ?? 0).toBeGreaterThan(0);
  });

  it("C5d: custom list item co-share — named list + shared_with", async () => {
    account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
    const amit = account.partners[0]!;
    const listName = "באגים-C5";
    const metadata: LlmMetadata = {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add",
          listType: "custom",
          listName,
          items: [{ תיאור: "מסך שבור-C5" }],
          targets: [SPEAKER, PARTNER],
        },
      ],
    };
    const { mutations, shareMisses, plan } = await applyLikeChat(
      account,
      metadata,
    );
    expect(plan.applications[0]?.employeeId).toBe(account.employeeId);
    const itemId = mutations.find((m) => m.action === "add" && !m.listShell)
      ?.itemId;
    expect(itemId).toBeTruthy();
    const row = await prisma.employeeListItem.findFirst({
      where: { id: itemId!, deletedAt: null },
      include: { list: true },
    });
    expect(row?.list.name).toBe(listName);
    expect(row?.scope).toBe("shared");
    expect(row?.visibleTo as string[]).toEqual(
      expect.arrayContaining([account.employeeId, amit.id]),
    );
    const facing = finalize({
      claim: "שיתפתי את הבאג עם עמית.",
      metadata,
      mutations,
      shareMisses,
    });
    expect(facing.spoken).toContain("שיתפתי");
    expect(
      facing.buttons.some(
        (b) => b.command.includes(listName) || b.label.includes("רשימה"),
      ),
    ).toBe(true);
    expect(facing.bubbles[0]?.text).toBe(facing.spoken);
  });
});
