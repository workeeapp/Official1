/**
 * sendChatMessage E2E with LLM stub on approved workee_test.
 *
 * M1–M3 stage 2: HighRiskActionGate strip-only blocks ungated Share/Assign
 * side effects through sendChatMessage. CORE share apply remains covered by
 * share-unified-c1c4 / plan+apply helpers. Stage 3 PendingConfirm V restores
 * completion UX.
 *
 * Run: npm run test:eval-db -- tests/share-unified-sendchat-e2e.eval-db.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseLlmReply } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { sendChatMessage } from "../src/services/chat.service.js";
import { getEmployeeRecordSnapshot } from "../src/services/employee-records.service.js";
import { planTargetedActions } from "../src/services/employee-targets.service.js";
import { listContactsForEmployee } from "../src/services/contact.service.js";
import { emptyModelMetadata } from "../src/eval/run-model-apply.js";
import type { PublicEmployee } from "@workee/shared";

const SPEAKER = "טל";
const PARTNER = "עמית";

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
  expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
});

async function ensureList(
  account: HarnessAccount,
  listType: "shopping" | "tasks" | "custom",
  name = "",
) {
  return (
    (await prisma.employeeList.findFirst({
      where: {
        employeeId: account.employeeId,
        listType,
        name,
        deletedAt: null,
      },
    })) ??
    (await prisma.employeeList.create({
      data: {
        employeeId: account.employeeId,
        listType,
        name,
        scope: "personal",
        visibleTo: [account.employeeId],
      },
    }))
  );
}

async function seedShopping(account: HarnessAccount, label: string) {
  const list = await ensureList(account, "shopping");
  const item = await prisma.employeeListItem.create({
    data: {
      listId: list.id,
      itemKey: label,
      data: { "שם פריט": label },
      scope: "personal",
      addedById: account.employeeId,
      visibleTo: [account.employeeId],
    },
  });
  return item.id;
}

function stubReply(payload: unknown) {
  return {
    async createConversation() {
      return `conv-${randomUUID()}`;
    },
    async createResponse() {
      return { reply: JSON.stringify(payload), raw: {} };
    },
  };
}

async function cleanupAccount(account: HarnessAccount) {
  await prisma.tipProgress
    .deleteMany({ where: { tip: { userId: account.userId } } })
    .catch(() => undefined);
  await prisma.tip
    .deleteMany({ where: { userId: account.userId } })
    .catch(() => undefined);
  await prisma.chatMessage
    .deleteMany({ where: { conversation: { userId: account.userId } } })
    .catch(() => undefined);
  await prisma.chatConversation
    .deleteMany({ where: { userId: account.userId } })
    .catch(() => undefined);
  await destroyHarnessAccount(account);
}

async function ensureLucy(account: HarnessAccount): Promise<string> {
  const existing = await prisma.employee.findFirst({
    where: { userId: account.userId, kind: "digital" },
  });
  if (existing) return existing.id;
  const lucy = await prisma.employee.create({
    data: {
      userId: account.userId,
      kind: "digital",
      isProtected: true,
      name: "לוסי",
      surname: "",
      nickname: "לוסי",
      model: "gpt-4.1-mini",
      temperature: 0,
      instructions: "You manage lists. Reply in Hebrew.",
    },
  });
  return lucy.id;
}

describe("sendChatMessage share E2E (eval-db, LLM stub)", () => {
  let account: HarnessAccount | null = null;

  afterEach(async () => {
    setLlmClientForTests(null);
    if (account) {
      await cleanupAccount(account);
      account = null;
    }
  });

  it(
    "Gate strip: co-share ACTION does not mutate visibleTo (stage 2)",
    async () => {
      account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
      const lucyId = await ensureLucy(account);
      const itemId = await seedShopping(account, "חלב-E2E");
      const before = await prisma.employeeListItem.findFirst({
        where: { id: itemId, deletedAt: null },
      });
      expect(before?.scope).toBe("personal");

      setLlmClientForTests(
        stubReply({
          responses: [{ text: "שיתפתי את החלב עם עמית.", buttons: [] }],
          metadata: {
            lists: [
              {
                action: "update",
                list_type: "shopping",
                list_name: "",
                items: [{ item_id: itemId }],
                targets: [SPEAKER, PARTNER],
              },
            ],
          },
        }),
      );
      await sendChatMessage({
        userId: account.userId,
        employeeId: account.employeeId,
        digitalEmployeeId: lucyId,
        message: "תשתפי את החלב עם עמית",
      });
      const after = await prisma.employeeListItem.findFirst({
        where: { id: itemId, deletedAt: null },
      });
      expect(after?.scope).toBe("personal");
      expect(after?.visibleTo as string[]).toEqual(before?.visibleTo as string[]);
    },
    60_000,
  );

  it("Gate strip: assign fan-out via sendChatMessage creates no partner row", async () => {
    account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
    const lucyId = await ensureLucy(account);
    const amit = account.partners[0]!;
    setLlmClientForTests(
      stubReply({
        responses: [
          {
            text: "הטלתי על עמית לקנות יוגורט.",
            buttons: [],
          },
        ],
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "shopping",
              list_name: "",
              items: [{ "שם פריט": "יוגורט-E2E-assign" }],
              targets: [PARTNER],
            },
          ],
        },
      }),
    );
    await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תשימי על עמית יוגורט",
    });
    const snap = await getEmployeeRecordSnapshot(amit.id);
    const shopping = snap.lists.find((l) => l.list_type === "shopping");
    const blob = JSON.stringify(shopping?.items ?? []);
    expect(blob).not.toContain("יוגורט-E2E-assign");
  }, 60_000);

  it("Gate strip: filing co-share via sendChatMessage does not create shared filing", async () => {
    account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
    const lucyId = await ensureLucy(account);
    setLlmClientForTests(
      stubReply({
        responses: [
          {
            text: "שיתפתי את התיוק קוד עם עמית.",
            buttons: [],
          },
        ],
        metadata: {
          filing: [
            {
              action: "add_filing",
              item_name: "קוד-E2E",
              item_info: "4321",
              item_description: "קוד-E2E",
              filing_id: "",
              targets: [SPEAKER, PARTNER],
            },
          ],
        },
      }),
    );
    await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: "תשתפי תיוק קוד עם עמית",
    });
    const filing = await prisma.employeeFiling.findFirst({
      where: {
        employeeId: account.employeeId,
        itemName: "קוד-E2E",
        deletedAt: null,
      },
    });
    expect(filing).toBeNull();
  }, 60_000);

  it("Gate strip: custom list co-share creates no shared row", async () => {
    account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
    const lucyId = await ensureLucy(account);
    const listName = "באגים-E2E";
    setLlmClientForTests(
      stubReply({
        responses: [
          {
            text: "שיתפתי את הבאג עם עמית.",
            buttons: [],
          },
        ],
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "custom",
              list_name: listName,
              items: [{ תיאור: "מסך-E2E" }],
              targets: [SPEAKER, PARTNER],
            },
          ],
        },
      }),
    );
    await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: `תשתפי באג ברשימת ${listName} עם עמית`,
    });
    const row = await prisma.employeeListItem.findFirst({
      where: {
        deletedAt: null,
        list: { employeeId: account.employeeId, listType: "custom", name: listName },
      },
    });
    expect(row).toBeNull();
  }, 60_000);

  it("a guest speaker's own shopping add is saved on that speaker", async () => {
    account = await createHarnessAccount(SPEAKER, { partners: [PARTNER] });
    const lucyId = await ensureLucy(account);
    const guestRow = await prisma.employee.create({
      data: {
        userId: account.userId,
        kind: "human",
        name: "אורח",
        surname: "",
        nickname: "אורח",
        isOwner: false,
        isGuest: true,
        teamId: null,
      },
    });
    const guest: PublicEmployee = {
      id: guestRow.id,
      kind: "human",
      name: "אורח",
      surname: "",
      nickname: "אורח",
      email: null,
      phone: null,
      isOwner: false,
      isGuest: true,
    };
    const mutateMeta = {
      ...emptyModelMetadata(),
      lists: [
        {
          action: "add" as const,
          listType: "shopping" as const,
          listName: "",
          items: [{ "שם פריט": "אורח-לא-לשמור" }],
          targets: [],
        },
      ],
    };
    const plan = planTargetedActions({
      actor: guest,
      employees: [...account.employees, guest],
      workers: [],
      metadata: mutateMeta,
      sharedLists: [],
    });
    expect(plan.guestMutationBlocked).toBe(false);
    expect(plan.applications.map((row) => row.employeeId)).toEqual([guest.id]);

    const before = await prisma.employeeListItem.count({
      where: {
        deletedAt: null,
        list: { employeeId: { in: [account.employeeId, guest.id] } },
      },
    });
    setLlmClientForTests(
      stubReply({
        responses: [{ text: "הוספתי חלב.", buttons: [] }],
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "shopping",
              list_name: "",
              items: [{ "שם פריט": "אורח-לא-לשמור" }],
              targets: [],
            },
          ],
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: guest.id,
      digitalEmployeeId: lucyId,
      message: "תוסיפי חלב",
    });
    const after = await prisma.employeeListItem.count({
      where: {
        deletedAt: null,
        list: { employeeId: { in: [account.employeeId, guest.id] } },
      },
    });
    expect(after).toBe(before + 1);
    expect(parseLlmReply(result.reply).response).not.toMatch(
      /רק לצפות|אורחים יכולים/,
    );
  }, 60_000);

  it("directory add via sendChatMessage — contact persisted on speaker book", async () => {
    account = await createHarnessAccount(SPEAKER);
    const lucyId = await ensureLucy(account);
    const contactName = "נועה-DIR-E2E";
    const phone = "0521111222";
    setLlmClientForTests(
      stubReply({
        responses: [{ text: "שמרתי את נועה בספר.", buttons: [] }],
        metadata: {
          directory: [
            {
              action: "add",
              name: contactName,
              phone,
              contact_id: "",
              targets: [],
            },
          ],
        },
      }),
    );
    const result = await sendChatMessage({
      userId: account.userId,
      employeeId: account.employeeId,
      digitalEmployeeId: lucyId,
      message: `שמרי את ${contactName} ${phone}`,
    });
    const contacts = await listContactsForEmployee(account.employeeId);
    const hit = contacts.find((row) => row.name.includes(contactName));
    expect(hit?.phone).toMatch(/521111222|0521111222/);
    expect(parseLlmReply(result.reply).response).toMatch(/שמרתי|נועה/);
  }, 60_000);
});
