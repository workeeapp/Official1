import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { hashPassword } from "../src/auth/password.js";

type ConversationRow = {
  id: string;
  userId: string;
  employeeId: string;
  digitalEmployeeId: string;
  openaiConversationId: string;
  contextInjectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type MessageRow = {
  id: string;
  conversationId: string;
  author: string;
  speaker: string;
  text: string;
  actions: unknown;
  raw: unknown;
  createdAt: Date;
};

const {
  findUnique,
  findFirst,
  findMany,
  teamFindUnique,
  teamCreate,
  conversationFindUnique,
  conversationFindUniqueOrThrow,
  conversationCreate,
  conversationUpdate,
  messageCreate,
  messageCreateMany,
  messageDeleteMany,
  messageFindFirst,
  listFindMany,
  listFindUnique,
  listFindFirst,
  listCreate,
  itemFindMany,
  itemFindUnique,
  itemFindFirst,
  itemCreate,
  itemUpdate,
  itemUpdateMany,
  itemDeleteMany,
  filingFindMany,
  filingFindFirst,
  filingCreate,
  filingUpdate,
  filingUpdateMany,
  filingUpsert,
} = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  teamFindUnique: vi.fn(),
  teamCreate: vi.fn(),
  conversationFindUnique: vi.fn(),
  conversationFindUniqueOrThrow: vi.fn(),
  conversationCreate: vi.fn(),
  conversationUpdate: vi.fn(),
  messageCreate: vi.fn(),
  messageCreateMany: vi.fn(),
  messageDeleteMany: vi.fn(),
  messageFindFirst: vi.fn(),
  listFindMany: vi.fn(),
  listFindUnique: vi.fn(),
  listFindFirst: vi.fn(),
  listCreate: vi.fn(),
  itemFindMany: vi.fn(),
  itemFindUnique: vi.fn(),
  itemFindFirst: vi.fn(),
  itemCreate: vi.fn(),
  itemUpdate: vi.fn(),
  itemUpdateMany: vi.fn(),
  itemDeleteMany: vi.fn(),
  filingFindMany: vi.fn(),
  filingFindFirst: vi.fn(),
  filingCreate: vi.fn(),
  filingUpdate: vi.fn(),
  filingUpdateMany: vi.fn(),
  filingUpsert: vi.fn(),
}));

const { createConversation, createResponse, appendAssistantMessage, usageCreate } =
  vi.hoisted(() => ({
    createConversation: vi.fn(),
    createResponse: vi.fn(),
    appendAssistantMessage: vi.fn(),
    usageCreate: vi.fn().mockResolvedValue({}),
  }));

const deliverWhatsAppRelaysMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ skips: [], sentLabels: [] }),
);

vi.mock("../src/services/whatsapp-send.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/whatsapp-send.js")>();
  return {
    ...actual,
    deliverWhatsAppRelays: (...args: unknown[]) =>
      deliverWhatsAppRelaysMock(...args),
  };
});

const conversationStore = new Map<string, ConversationRow>();
const messageStore: MessageRow[] = [];

function storeKey(userId: string, employeeId: string, digitalEmployeeId: string): string {
  return `${userId}:${employeeId}:${digitalEmployeeId}`;
}

function resetChatStore(): void {
  conversationStore.clear();
  messageStore.length = 0;
}

function ageStoredConversation(minutes: number): void {
  const when = new Date(Date.now() - minutes * 60 * 1000);
  for (const row of conversationStore.values()) {
    row.createdAt = when;
    row.updatedAt = when;
  }
  for (const message of messageStore) {
    message.createdAt = when;
  }
}

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    user: {
      findUnique,
    },
    team: {
      findUnique: teamFindUnique,
      create: teamCreate,
    },
    employee: {
      findFirst,
      findMany,
      findUnique: vi.fn().mockResolvedValue({
        userId: "11111111-1111-4111-8111-111111111111",
      }),
      update: vi.fn(),
      create: vi.fn().mockResolvedValue({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "digital",
        isProtected: true,
        name: "לוסי",
        surname: "",
        nickname: "לוסי",
      }),
    },
    chatConversation: {
      findUnique: conversationFindUnique,
      findUniqueOrThrow: conversationFindUniqueOrThrow,
      create: conversationCreate,
      update: conversationUpdate,
    },
    chatMessage: {
      findFirst: messageFindFirst,
      findMany: vi.fn().mockImplementation(
        async ({
          where,
          take,
        }: {
          where?: { conversationId?: string; author?: string };
          take?: number;
        }) => {
          const rows = messageStore.filter((message) => {
            if (where?.conversationId && message.conversationId !== where.conversationId) {
              return false;
            }
            if (where?.author && message.author !== where.author) {
              return false;
            }
            return true;
          });
          rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return typeof take === "number" ? rows.slice(0, take) : rows;
        },
      ),
      findUnique: vi.fn().mockImplementation(
        async ({ where }: { where: { id: string } }) =>
          messageStore.find((message) => message.id === where.id) ?? null,
      ),
      create: messageCreate,
      createMany: messageCreateMany,
      deleteMany: messageDeleteMany,
      update: vi.fn().mockImplementation(
        async ({ where, data }: { where: { id: string }; data: { text?: string } }) => {
          const row = messageStore.find((message) => message.id === where.id);
          if (row && data.text !== undefined) {
            row.text = data.text;
          }
          return row ?? { id: where.id, ...data };
        },
      ),
    },
    employeeList: {
      findMany: listFindMany,
      findUnique: listFindUnique,
      findFirst: listFindFirst,
      create: listCreate,
    },
    employeeListItem: {
      findMany: itemFindMany,
      findUnique: itemFindUnique,
      findFirst: itemFindFirst,
      create: itemCreate,
      update: itemUpdate,
      updateMany: itemUpdateMany,
      deleteMany: itemDeleteMany,
    },
    employeeFiling: {
      findMany: filingFindMany,
      findFirst: filingFindFirst,
      create: filingCreate,
      update: filingUpdate,
      updateMany: filingUpdateMany,
      upsert: filingUpsert,
    },
    reminder: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    llmUsage: {
      create: usageCreate,
    },
    llmModelPrice: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    tip: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    tipProgress: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    contactBook: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    contact: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    attachmentLink: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    attachment: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

import { createApp } from "../src/app.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";

const PASSWORD = "ChangeMe123!";
const userId = "11111111-1111-4111-8111-111111111111";
const teamId = "22222222-2222-4222-8222-222222222222";
const employeeId = "415ff13e-38d0-4dee-98b5-71e5dd11a38d";
const otherEmployeeId = "4cded1a2-c4c1-4edc-9d87-fe5ac740c1f4";
const lucyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const davidId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let passwordHash: string;
let app: ReturnType<typeof createApp>;

function cookieHeader(response: request.Response): string {
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return values.join("; ");
}

async function login(): Promise<string> {
  findUnique.mockResolvedValue({
    id: userId,
    username: "Amit",
    passwordHash,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const response = await request(app)
    .post("/api/auth/login")
    .send({ username: "Amit", password: PASSWORD });

  return cookieHeader(response);
}

function tableEmployees() {
  return [
    {
      id: employeeId,
      userId,
      name: "עמית",
      surname: "חתן",
      nickname: "עמית",
      email: null,
      phone: null,
      createdAt: new Date(),
    },
    {
      id: otherEmployeeId,
      userId,
      name: "טל",
      surname: "דור",
      nickname: "טל",
      email: null,
      phone: null,
      createdAt: new Date(),
    },
    {
      id: lucyId,
      userId,
      kind: "digital",
      isProtected: true,
      name: "לוסי",
      surname: "",
      nickname: "לוסי",
      email: null,
      phone: null,
      model: "gpt-4.1-mini",
      temperature: 0,
      instructions: "You manage lists and filings.",
      createdAt: new Date(),
    },
  ];
}

const guestLucyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function mockOwnedEmployee() {
  findMany.mockResolvedValue(tableEmployees());
  findFirst.mockImplementation(
    async ({
      where,
    }: {
      where: {
        id?: string;
        isProtected?: boolean;
        OR?: Array<{ name?: string; nickname?: string }>;
      };
    }) => {
      const orNames = (where.OR ?? [])
        .flatMap((row) => [row.name, row.nickname])
        .filter(Boolean);
      if (orNames.includes("לוסי-אורח")) {
        return {
          id: guestLucyId,
          userId,
          teamId,
          kind: "digital",
          isProtected: false,
          isGuest: false,
          name: "לוסי-אורח",
          surname: "",
          nickname: "לוסי-אורח",
          email: null,
          phone: null,
          model: "gpt-4.1-mini",
          temperature: 0,
          instructions: "guest lucy",
          createdAt: new Date(),
        };
      }

      if (where.isProtected || where.id === lucyId) {
        return {
          id: lucyId,
          userId,
          teamId,
          kind: "digital",
          isProtected: true,
          isGuest: false,
          name: "לוסי",
          surname: "",
          nickname: "לוסי",
          email: null,
          phone: null,
          model: "gpt-4.1-mini",
          temperature: 0,
          instructions: "You manage lists and filings.",
          createdAt: new Date(),
        };
      }

      if (where.id === employeeId) {
        return {
          id: employeeId,
          userId,
          teamId,
          isGuest: false,
          name: "עמית",
          surname: "חתן",
          nickname: "עמית",
          email: null,
          phone: null,
          createdAt: new Date(),
        };
      }

      if (where.id === otherEmployeeId) {
        return {
          id: otherEmployeeId,
          userId,
          teamId,
          isGuest: false,
          name: "טל",
          surname: "דור",
          nickname: "טל",
          email: null,
          phone: null,
          createdAt: new Date(),
        };
      }

      return null;
    },
  );
}

describe("chat API", () => {
  beforeEach(async () => {
    passwordHash ??= await hashPassword(PASSWORD);
    findUnique.mockReset();
    findFirst.mockReset();
    findMany.mockReset().mockResolvedValue([]);
    teamFindUnique.mockReset().mockResolvedValue({
      id: teamId,
      userId,
      name: "Amit",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    teamCreate.mockReset();
    createConversation.mockReset().mockResolvedValue("conv_test_1");
    createResponse.mockReset().mockResolvedValue({
      reply: "Hello from the model",
      raw: { output_text: "Hello from the model" },
    });
    deliverWhatsAppRelaysMock.mockReset().mockResolvedValue({
      skips: [],
      sentLabels: [],
    });
    resetChatStore();
    conversationFindUnique.mockReset().mockImplementation(
      async ({
        where,
        include,
      }: {
        where: {
          id?: string;
          userId_employeeId_digitalEmployeeId?: {
            userId: string;
            employeeId: string;
            digitalEmployeeId: string;
          };
        };
        include?: { messages?: unknown };
      }) => {
        let found: ConversationRow | undefined;
        if (where.id) {
          for (const row of conversationStore.values()) {
            if (row.id === where.id) {
              found = row;
              break;
            }
          }
        } else if (where.userId_employeeId_digitalEmployeeId) {
          const pair = where.userId_employeeId_digitalEmployeeId;
          found = conversationStore.get(
            storeKey(pair.userId, pair.employeeId, pair.digitalEmployeeId),
          );
        }
        if (!found) {
          return null;
        }
        if (include?.messages) {
          return {
            ...found,
            messages: messageStore
              .filter((message) => message.conversationId === found.id)
              .sort((a, b) => {
                const byTime = a.createdAt.getTime() - b.createdAt.getTime();
                if (byTime !== 0) {
                  return byTime;
                }
                return b.author.localeCompare(a.author);
              }),
          };
        }
        return found;
      },
    );
    conversationFindUniqueOrThrow.mockReset().mockImplementation(
      async (args: {
        where: {
          userId_employeeId_digitalEmployeeId: {
            userId: string;
            employeeId: string;
            digitalEmployeeId: string;
          };
        };
      }) => {
        const found = await conversationFindUnique(args);
        if (!found) {
          throw new Error("Conversation not found");
        }
        return found;
      },
    );
    conversationCreate.mockReset().mockImplementation(
      async ({
        data,
      }: {
        data: {
          userId: string;
          employeeId: string;
          digitalEmployeeId: string;
          openaiConversationId: string;
        };
      }) => {
        const row: ConversationRow = {
          id: crypto.randomUUID(),
          userId: data.userId,
          employeeId: data.employeeId,
          digitalEmployeeId: data.digitalEmployeeId,
          openaiConversationId: data.openaiConversationId,
          contextInjectedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        conversationStore.set(
          storeKey(row.userId, row.employeeId, row.digitalEmployeeId),
          row,
        );
        return row;
      },
    );
    conversationUpdate.mockReset().mockImplementation(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: {
          contextInjectedAt?: Date | null;
          openaiConversationId?: string;
        };
      }) => {
        for (const row of conversationStore.values()) {
          if (row.id === where.id) {
            if (data.contextInjectedAt !== undefined) {
              row.contextInjectedAt = data.contextInjectedAt;
            }
            if (data.openaiConversationId) {
              row.openaiConversationId = data.openaiConversationId;
            }
            row.updatedAt = new Date();
            return row;
          }
        }
        return null;
      },
    );
    listFindMany.mockReset().mockResolvedValue([]);
    listFindUnique.mockReset().mockResolvedValue(null);
    listFindFirst.mockReset().mockResolvedValue(null);
    itemFindMany.mockReset().mockResolvedValue([]);
    listCreate.mockReset().mockResolvedValue({
      id: "list-1",
      employeeId,
      listType: "shopping",
      name: "",
    });
    itemFindUnique.mockReset().mockResolvedValue(null);
    itemFindFirst.mockReset().mockResolvedValue(null);
    itemCreate.mockReset().mockResolvedValue({ id: "item-1" });
    itemUpdate.mockReset().mockResolvedValue({ id: "item-1" });
    itemUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    itemDeleteMany.mockReset().mockResolvedValue({ count: 1 });
    filingFindMany.mockReset().mockResolvedValue([]);
    filingFindFirst.mockReset().mockResolvedValue(null);
    filingCreate.mockReset().mockResolvedValue({ id: "filing-1" });
    filingUpdate.mockReset();
    filingUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    filingUpsert.mockReset().mockResolvedValue({ id: "filing-1" });
    messageCreate.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: crypto.randomUUID(),
        conversationId: String(data.conversationId),
        author: String(data.author),
        speaker: String(data.speaker),
        text: String(data.text),
        actions: data.actions ?? null,
        raw: data.raw ?? null,
        createdAt: new Date(),
      };
      messageStore.push(row);
      return row;
    });
    messageFindFirst.mockReset().mockImplementation(
      async ({
        where,
        orderBy,
      }: {
        where: { conversationId: string };
        orderBy?: { createdAt: "asc" | "desc" };
      }) => {
        const matches = messageStore.filter(
          (message) => message.conversationId === where.conversationId,
        );
        if (matches.length === 0) {
          return null;
        }
        matches.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
        return orderBy?.createdAt === "desc" ? matches[matches.length - 1] : matches[0];
      },
    );
    messageDeleteMany.mockReset().mockImplementation(
      async ({ where }: { where: { conversationId: string } }) => {
        const before = messageStore.length;
        for (let index = messageStore.length - 1; index >= 0; index -= 1) {
          if (messageStore[index].conversationId === where.conversationId) {
            messageStore.splice(index, 1);
          }
        }
        return { count: before - messageStore.length };
      },
    );
    messageCreateMany.mockReset().mockImplementation(
      async ({ data }: { data: Array<Record<string, unknown>> }) => {
        for (const item of data) {
          messageStore.push({
            id: crypto.randomUUID(),
            conversationId: String(item.conversationId),
            author: String(item.author),
            speaker: String(item.speaker),
            text: String(item.text),
            actions: item.actions ?? null,
            raw: item.raw ?? null,
            createdAt: item.createdAt instanceof Date ? item.createdAt : new Date(),
          });
        }
        return { count: data.length };
      },
    );
    appendAssistantMessage.mockReset().mockResolvedValue(undefined);
    setLlmClientForTests({
      createConversation,
      createResponse,
      appendAssistantMessage,
    });
    app = createApp();
  });

  afterEach(() => {
    setLlmClientForTests(null);
    resetChatStore();
  });

  it("rejects unauthenticated chat", async () => {
    const response = await request(app)
      .post("/api/chat/messages")
      .send({ message: "hi" });

    expect(response.status).toBe(401);
    expect(createConversation).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated history", async () => {
    const response = await request(app).get(
      `/api/chat/messages?employeeId=${employeeId}`,
    );

    expect(response.status).toBe(401);
  });

  it("sends a message to the LLM and returns the reply", async () => {
    const cookie = await login();
    mockOwnedEmployee();

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "hi", employeeId });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      reply: "Hello from the model",
      raw: { output_text: "Hello from the model" },
      notifications: [],
    });
    expect(response.body.request).toMatchObject({
      model: expect.any(String),
      conversation: "conv_test_1",
      input: expect.stringContaining("hi"),
      instructions: expect.any(String),
    });
    expect(response.body.timing).toEqual({
      llmMs: expect.any(Number),
      afterLlmMs: expect.any(Number),
    });
    expect(createConversation).toHaveBeenCalledOnce();
    expect(createResponse).toHaveBeenCalledOnce();
    expect(createResponse.mock.calls[0][0].conversationId).toBe("conv_test_1");
    expect(createResponse.mock.calls[0][0].message).toContain("hi");
    expect(messageCreateMany).toHaveBeenCalledOnce();
    const saved = messageCreateMany.mock.calls[0][0].data as Array<{
      id: string;
      author: string;
      createdAt: Date;
    }>;
    expect(saved[0].author).toBe("you");
    expect(saved[1].author).toBe("assistant");
    expect(saved[1].createdAt.getTime()).toBeGreaterThan(saved[0].createdAt.getTime());
    expect(response.body.messageIds).toEqual({
      user: saved[0].id,
      assistant: saved[1].id,
      assistants: [saved[1].id],
    });
    expect(saved[0].id).not.toBe(saved[1].id);
  });

  it("saves each spoken response as its own assistant message in order", async () => {
    const cookie = await login();
    mockOwnedEmployee();
    createResponse.mockResolvedValue({
      reply: JSON.stringify({
        responses: ["הי, איך אפשר לעזור?", "אגב, ביקשת שאבדוק אם קנית חלב?"],
        metadata: { lists: [], filing: [], messages: [] },
      }),
      raw: { output_text: "two" },
    });

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "הי", employeeId });

    expect(response.status).toBe(200);
    const [turnRows, extraRows] = messageCreateMany.mock.calls.map(
      (call) =>
        call[0].data as Array<{ id: string; author: string; text: string; createdAt: Date }>,
    );
    expect(turnRows[1].text).toBe("הי, איך אפשר לעזור?");
    expect(extraRows).toHaveLength(1);
    expect(extraRows[0]).toMatchObject({
      author: "assistant",
      text: "אגב, ביקשת שאבדוק אם קנית חלב?",
    });
    expect(extraRows[0].createdAt.getTime()).toBeGreaterThan(
      turnRows[1].createdAt.getTime(),
    );
    expect(response.body.messageIds.assistants).toEqual([
      turnRows[1].id,
      extraRows[0].id,
    ]);
  });

  it("routes «מה יש לך» to the worker's own inventory in the instructions", async () => {
    const cookie = await login();
    mockOwnedEmployee();

    await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "מה יש לך", employeeId });

    const instructions = createResponse.mock.calls[0][0].instructions as string;
    expect(instructions).toMatch(/INVENTORY \([^)]*מה יש לך/);
    expect(instructions).toContain("WHO A STATUS QUESTION IS ABOUT");
    expect(instructions).toContain("show_dump=tasks");
    expect(instructions).toContain("show_dump_about=YOUR display name");
    expect(instructions).toContain("BOTH REQUIRED");
    expect(instructions).toContain("אין לי מטלות");
    expect(instructions).toMatch(/show_dump=tasks WITHOUT about|SPEAKER's tasks/);
  });

  it("wires SEND BY MEANING and SEND-ME FREE TEXT into Lucy runtime instructions", async () => {
    const cookie = await login();
    mockOwnedEmployee();

    await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "היי", employeeId });

    const instructions = createResponse.mock.calls[0][0].instructions as string;
    expect(instructions).toContain("SEND BY MEANING");
    expect(instructions).toContain("SEND-ME FREE TEXT");
    expect(instructions).toContain("מתי תרצה שאשלח?");
    expect(instructions).toContain("את ההודעה «…»");
    expect(instructions).toContain("תמסרי למיכל שאני אוהב אותה");
  });

  // Product rules that live in chat.service Lucy extras (not LLM.config.json).
  // Former mega «attaches the schema» asserts — live wording, same requirements.
  it("wires LIVE DATA / SHAREABLE STATUS / FULL DUMP extras into Lucy runtime instructions", async () => {
    const cookie = await login();
    mockOwnedEmployee();

    await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "היי", employeeId });

    const instructions = createResponse.mock.calls[0][0].instructions as string;

    expect(instructions).toContain(
      "FORBIDDEN: listing titles from earlier assistant/user messages",
    );
    expect(instructions).toContain("SHAREABLE STATUS ASK");
    expect(instructions).toContain("SHAREABLE STATUS ASK ABOUT X");
    expect(instructions).toContain("one flat dump header + row marks");
    expect(instructions).toContain("באחריות X · מאת Y");
    expect(instructions).toContain("FULL DUMP / מה יש לי / הציגי הכל");
    expect(instructions).toContain("FULL DUMP DETAIL RULE");
    expect(instructions).toContain("COUNTS ONLY");
    expect(instructions).toContain("ONLY מטלות enumerate");
    expect(instructions).toContain("SHOW MY LISTS / הציגי את הרשימות שלי");
    expect(instructions).toContain('show_dump="full"');
    expect(instructions).toContain("לפירוט רשימה: הצג רשימת");
    expect(instructions).toContain("OR WITHIN FIELD");
    expect(instructions).toContain("SHOW DUMP SECTION");
    expect(instructions).toContain("show_dump_section=shared");
    expect(instructions).toContain("show_dump_partner=X");
    expect(instructions).toContain("מה יש לי משותף עם X");
    expect(instructions).toContain("FORBIDDEN model-written with-X overview");
    expect(instructions).toContain('show_dump="phone_book"');
    expect(instructions).toContain("USER-FACING LANGUAGE");
    expect(instructions).toContain("FOLLOW-UP TO YOUR QUESTION");
    expect(instructions).toContain("MULTI-INTENT CONFIRM");
    expect(instructions).toContain("re-emit EVERY offered ACTION this turn");
    expect(instructions).toContain("משימות לעבודה");
    expect(instructions).toContain("WHEN / TODAY / SOON — FULL agenda only");
    expect(instructions).toContain("RETRIEVAL CONTRACT path 2");
    expect(instructions).toContain("TIME-OF-DAY (בוקר) is NOT an engine dump filter");
    expect(instructions).toContain("INVENTORY");
    expect(instructions).toContain("show_dump=tasks WITHOUT about");
    expect(instructions).toContain("YEARLY OFFER");
    expect(instructions).toContain("FORBIDDEN reminders-only yearly birthday");
    expect(instructions).toContain("PLATFORM INTERNAL");
    expect(instructions).toContain("SCHEDULED SAVED-DATA STATUS");
    expect(instructions).toContain("REUSE EXISTING WRAPPER");
    expect(instructions).toContain("REMINDER-ON-ITEM");
    expect(instructions).toContain("LIST NAME MATCH");
    expect(instructions).toContain("TOPIC-ONLY / NO LIST NAMED");
    expect(instructions).toContain("NUMBERED which-list ask");
    expect(instructions).toContain("PERSONAL TASK DEFAULT");
    expect(instructions).toContain("APPOINTMENT VS PING");
  });

  it("stores LLM usage for the speaker, worker, and conversation", async () => {
    const cookie = await login();
    mockOwnedEmployee();
    usageCreate.mockClear();
    createResponse.mockResolvedValue({
      reply: "Hello from the model",
      raw: {
        id: "resp_usage",
        model: "gpt-4.1-mini-2025-04-14",
        usage: {
          input_tokens: 1500,
          input_tokens_details: { cached_tokens: 1280 },
          output_tokens: 60,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 1560,
        },
      },
    });

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "hi", employeeId });

    expect(response.status).toBe(200);
    expect(usageCreate).toHaveBeenCalledOnce();
    expect(usageCreate.mock.calls[0][0].data).toMatchObject({
      conversationId: expect.any(String),
      employeeId,
      digitalEmployeeId: expect.any(String),
      openaiConversationId: "conv_test_1",
      responseId: "resp_usage",
      inputTokens: 1500,
      outputTokens: 60,
      cachedTokens: 1280,
      totalTokens: 1560,
    });
  });

  it("lets Lucy save a reminder without handing off to David", async () => {
    const cookie = await login();
    mockOwnedEmployee();
    createResponse.mockResolvedValue({
      reply: JSON.stringify({
        response: "שמרתי תזכורת לחלב",
        metadata: {
          lists: [],
          filing: [],
          messages: [],
          reminders: [{ action: "add", item: "לקנות חלב", in: 20, time: "" }],
        },
      }),
      raw: {},
    });

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "תזכירי לי לקנות חלב בעוד 20 שניות", employeeId });

    expect(response.status).toBe(200);
    expect(createResponse).toHaveBeenCalledOnce();
    expect(createResponse.mock.calls[0][0].instructions).toContain(
      "Do not handoff for a reminder",
    );
  });

  it("refuses a repeat every 2 minutes and saves none of its actions", async () => {
    const cookie = await login();
    mockOwnedEmployee();
    createResponse.mockResolvedValue({
      reply: JSON.stringify({
        response: "אשלח לך בוקר טוב כל 10 דקות",
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "tasks",
              targets: ["לוסי"],
              items: [{ "שם מטלה": "לשלוח לעמית בוקר טוב" }],
            },
          ],
          filing: [],
          messages: [],
          reminders: [
            {
              action: "add",
              item: "בוקר טוב",
              time: "",
              recurrence: { freq: "interval", interval: 2, unit: "minutes" },
            },
          ],
        },
      }),
      raw: {},
    });

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "תשלחי לי בוקר טוב כל 2 דקות", employeeId });

    expect(response.status).toBe(200);
    expect(response.body.reply).toContain("הכי תכוף שאפשר הוא כל 5 דקות");
    expect(response.body.reply).not.toContain("אשלח לך בוקר טוב");
    expect(itemCreate).not.toHaveBeenCalled();
  });

  it("follows a handoff when the speaker asks to talk to David", async () => {
    const cookie = await login();
    mockOwnedEmployee();
    findMany.mockResolvedValue([
      ...tableEmployees(),
      {
        id: davidId,
        userId,
        kind: "digital",
        isProtected: false,
        name: "דוד",
        surname: "",
        nickname: "דוד",
        email: null,
        phone: null,
        model: "gpt-4.1-mini",
        temperature: 0,
        instructions: "Reminders",
        createdAt: new Date(),
      },
    ]);
    const previousFindFirst = findFirst.getMockImplementation();
    findFirst.mockImplementation(async (args: { where: { id?: string; isProtected?: boolean } }) => {
      if (args.where.id === davidId) {
        return {
          id: davidId,
          userId,
          kind: "digital",
          isProtected: false,
          name: "דוד",
          surname: "",
          nickname: "דוד",
          email: null,
          phone: null,
          model: "gpt-4.1-mini",
          temperature: 0,
          instructions: "Reminders",
          createdAt: new Date(),
        };
      }
      return previousFindFirst?.(args);
    });
    createConversation
      .mockResolvedValueOnce("conv_lucy")
      .mockResolvedValueOnce("conv_david");
    createResponse
      .mockResolvedValueOnce({
        reply: JSON.stringify({
          response: "מעבירה אותך לדוד",
          metadata: {
            lists: [],
            filing: [],
            messages: [],
            handoff: { worker: "דוד" },
          },
        }),
        raw: {},
      })
      .mockResolvedValueOnce({
        reply: JSON.stringify({
          response: "שמרתי",
          metadata: {
            reminders: [{ action: "add", item: "חלב", in: 20 }],
          },
        }),
        raw: {},
      });

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "אני רוצה לדבר עם דוד", employeeId });

    expect(response.status).toBe(200);
    expect(createResponse).toHaveBeenCalledTimes(2);
    expect(createResponse.mock.calls[1][0].conversationId).toBe("conv_david");
  });

  it("asks a digital co-worker now and adds her answer to Lucy's reply", async () => {
    const cookie = await login();
    mockOwnedEmployee();
    const diana = {
      id: davidId,
      userId,
      kind: "digital",
      isProtected: false,
      name: "דיאנה",
      surname: "",
      nickname: "דיאנה",
      email: null,
      phone: null,
      model: "gpt-4.1-mini",
      temperature: 0,
      instructions: "Travel agent",
      createdAt: new Date(),
    };
    findMany.mockResolvedValue([...tableEmployees(), diana]);
    const previousFindFirst = findFirst.getMockImplementation();
    findFirst.mockImplementation(async (args: { where: { id?: string } }) =>
      args.where.id === davidId ? diana : previousFindFirst?.(args),
    );
    listFindFirst.mockResolvedValue({ id: "lucy-tasks" });
    const jobRows: Array<{ id: string; data: unknown }> = [];
    itemCreate.mockImplementation(async ({ data }: { data: { data: unknown } }) => {
      const row = { id: "job-1", data: data.data };
      jobRows.push(row);
      return row;
    });
    itemFindMany.mockImplementation(async (args: { where?: { listId?: string } }) =>
      args?.where?.listId === "lucy-tasks" ? jobRows : [],
    );
    createConversation
      .mockResolvedValueOnce("conv_lucy")
      .mockResolvedValueOnce("conv_diana");
    createResponse
      .mockResolvedValueOnce({
        reply: JSON.stringify({
          response: "שאלתי את דיאנה:",
          metadata: {
            lists: [],
            filing: [],
            messages: [
              {
                targets: ["דיאנה"],
                text: "עמית שואל אם יש טיסות ביום ראשון?",
                expects_reply: true,
                ask_summary: "אם יש טיסות ביום ראשון?",
              },
            ],
          },
        }),
        raw: {},
      })
      .mockResolvedValueOnce({
        reply: JSON.stringify({
          response: "כן, יש טיסה ב-08:00 וב-14:30.",
          metadata: { lists: [], filing: [], messages: [] },
        }),
        raw: {},
        usage: {
          responseId: "resp_diana",
          model: "gpt-4.1-mini",
          inputTokens: 100,
          outputTokens: 10,
          cachedTokens: 0,
          reasoningTokens: 0,
          totalTokens: 110,
          raw: {},
        },
      });

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "תשאלי את דיאנה אם יש טיסות ביום ראשון?", employeeId });

    expect(response.status).toBe(200);
    expect(createResponse).toHaveBeenCalledTimes(2);
    const consult = createResponse.mock.calls[1][0];
    expect(consult.conversationId).toBe("conv_diana");
    expect(conversationStore.has(storeKey(userId, lucyId, davidId))).toBe(true);
    expect(conversationStore.has(storeKey(userId, employeeId, davidId))).toBe(false);
    expect(usageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          responseId: "resp_diana",
          employeeId: lucyId,
          digitalEmployeeId: davidId,
        }),
      }),
    );
    expect(consult.instructions).toContain("CONSULT: לוסי");
    expect(consult.message).toContain("לוסי (בשם");
    expect(response.body.reply).toContain("שאלתי את דיאנה:");
    expect(response.body.reply).toContain("דיאנה עונה: כן, יש טיסה ב-08:00 וב-14:30.");
    expect(appendAssistantMessage).toHaveBeenCalledWith(
      "conv_lucy",
      "דיאנה עונה: כן, יש טיסה ב-08:00 וב-14:30.",
    );
    expect(itemCreate).toHaveBeenCalledOnce();
    expect(JSON.stringify(itemCreate.mock.calls[0][0].data.data)).toContain(
      "לבדוק עם דיאנה: אם יש טיסות ביום ראשון?",
    );
    expect(itemUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-1", deletedAt: null },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });

  it("rotates the OpenAI conversation when the request is too large", async () => {
    const cookie = await login();
    mockOwnedEmployee();
    createConversation
      .mockResolvedValueOnce("conv_test_1")
      .mockResolvedValueOnce("conv_after_429");
    createResponse
      .mockRejectedValueOnce(
        new Error(
          "429 Request too large for gpt-4.1 on tokens per min (TPM): Limit 30000, Requested 30046.",
        ),
      )
      .mockResolvedValueOnce({
        reply: "After rotate",
        raw: { output_text: "After rotate" },
      });

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "hi", employeeId });

    expect(response.status).toBe(200);
    expect(response.body.reply).toBe("After rotate");
    expect(createResponse).toHaveBeenCalledTimes(2);
    expect(createResponse.mock.calls[1][0].conversationId).toBe("conv_after_429");
  });

  it("reuses the same conversation for the same user and employee", async () => {
    const cookie = await login();
    mockOwnedEmployee();

    await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "hi", employeeId });

    createResponse.mockResolvedValue({
      reply: "Second reply",
      raw: { output_text: "Second reply" },
    });

    const second = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "how are you", employeeId });

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      reply: "Second reply",
      raw: { output_text: "Second reply" },
      notifications: [],
    });
    expect(createConversation).toHaveBeenCalledOnce();
    expect(createResponse).toHaveBeenCalledTimes(2);
    expect(createResponse.mock.calls[1][0].conversationId).toBe("conv_test_1");
  });

  it("reuses the saved conversation after logout and login", async () => {
    const firstCookie = await login();
    mockOwnedEmployee();

    await request(app)
      .post("/api/chat/messages")
      .set("Cookie", firstCookie)
      .send({ message: "hi", employeeId });

    await request(app).post("/api/auth/logout").set("Cookie", firstCookie);

    createConversation.mockResolvedValue("conv_test_2");
    const secondCookie = await login();

    await request(app)
      .post("/api/chat/messages")
      .set("Cookie", secondCookie)
      .send({ message: "hi again", employeeId });

    expect(createConversation).toHaveBeenCalledOnce();
    expect(createResponse.mock.calls[1][0].conversationId).toBe("conv_test_1");
  });

  it("returns saved history for an employee", async () => {
    const cookie = await login();
    mockOwnedEmployee();

    await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "hi", employeeId });

    const history = await request(app)
      .get(`/api/chat/messages?employeeId=${employeeId}`)
      .set("Cookie", cookie);

    expect(history.status).toBe(200);
    expect(history.body.employeeId).toBe(employeeId);
    expect(history.body.conversationId).toBe("conv_test_1");
    expect(history.body.startedAt).toEqual(expect.any(String));
    expect(history.body.isNew).toBe(false);
    expect(history.body.messages).toHaveLength(2);
    expect(history.body.messages[0]).toMatchObject({
      author: "you",
      speaker: "עמית",
      text: "hi",
      createdAt: expect.any(String),
    });
    expect(history.body.messages[1]).toMatchObject({
      author: "assistant",
      speaker: "לוסי",
      text: "Hello from the model",
      createdAt: expect.any(String),
    });
    expect(history.body.raw).toEqual({ output_text: "Hello from the model" });
    expect(history.body.request).toMatchObject({
      conversation: "conv_test_1",
      input: expect.stringContaining("hi"),
    });
  });

  it("returns empty history when the employee has no conversation", async () => {
    const cookie = await login();
    mockOwnedEmployee();

    const history = await request(app)
      .get(`/api/chat/messages?employeeId=${employeeId}`)
      .set("Cookie", cookie);

    expect(history.status).toBe(200);
    expect(history.body).toEqual({
      employeeId,
      digitalEmployeeId: lucyId,
      conversationId: null,
      startedAt: null,
      messages: [],
      raw: null,
      request: null,
      isNew: true,
    });
  });

  it("rejects unauthenticated reset", async () => {
    const response = await request(app)
      .post("/api/chat/reset")
      .send({ employeeId });

    expect(response.status).toBe(401);
    expect(createConversation).not.toHaveBeenCalled();
  });

  it("resets the conversation id and stored history", async () => {
    const cookie = await login();
    mockOwnedEmployee();

    await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "hi", employeeId });

    createConversation.mockResolvedValue("conv_reset_2");
    const reset = await request(app)
      .post("/api/chat/reset")
      .set("Cookie", cookie)
      .send({ employeeId });

    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({
      employeeId,
      digitalEmployeeId: lucyId,
      conversationId: "conv_reset_2",
      startedAt: expect.any(String),
      messages: [],
      raw: null,
      request: null,
      isNew: true,
    });

    const history = await request(app)
      .get(`/api/chat/messages?employeeId=${employeeId}`)
      .set("Cookie", cookie);

    expect(history.body).toEqual({
      employeeId,
      digitalEmployeeId: lucyId,
      conversationId: "conv_reset_2",
      startedAt: expect.any(String),
      messages: [],
      raw: null,
      request: null,
      isNew: true,
    });

    createResponse.mockResolvedValue({
      reply: "Fresh reply",
      raw: { output_text: "Fresh reply" },
    });
    const next = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "what do I need?", employeeId });

    expect(next.status).toBe(200);
    expect(createConversation).toHaveBeenCalledTimes(2);
    expect(createResponse.mock.calls[1][0].conversationId).toBe("conv_reset_2");
    expect(createResponse.mock.calls[1][0].instructions).toContain(
      "EMPLOYEE_SAVED_DATA",
    );
    expect(createResponse.mock.calls[1][0].message).toContain("EMPLOYEE_SAVED_DATA");
  });

  it("resets an idle conversation when history is loaded", async () => {
    const cookie = await login();
    mockOwnedEmployee();

    await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "hi", employeeId });

    ageStoredConversation(41);
    createConversation.mockResolvedValue("conv_idle");

    const history = await request(app)
      .get(`/api/chat/messages?employeeId=${employeeId}`)
      .set("Cookie", cookie);

    expect(history.status).toBe(200);
    expect(history.body).toEqual({
      employeeId,
      digitalEmployeeId: lucyId,
      conversationId: "conv_idle",
      startedAt: expect.any(String),
      messages: [],
      raw: null,
      request: null,
      isNew: true,
    });
    expect(createConversation).toHaveBeenCalledTimes(2);
  });

  it("starts a new OpenAI conversation after 40 minutes of idle chat", async () => {
    const cookie = await login();
    mockOwnedEmployee();

    await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "hi", employeeId });

    ageStoredConversation(41);
    createConversation.mockResolvedValue("conv_idle_send");
    createResponse.mockResolvedValue({
      reply: "After idle",
      raw: { output_text: "After idle" },
    });

    const next = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "hello again", employeeId });

    expect(next.status).toBe(200);
    expect(createConversation).toHaveBeenCalledTimes(2);
    expect(createResponse.mock.calls[1][0].conversationId).toBe("conv_idle_send");
    expect(createResponse.mock.calls[1][0].instructions).toContain(
      "EMPLOYEE_SAVED_DATA",
    );
  });

  it("starts a separate conversation for each employee", async () => {
    const cookie = await login();
    mockOwnedEmployee();

    await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "hi", employeeId });

    createConversation.mockResolvedValue("conv_test_other");
    createResponse.mockResolvedValue({
      reply: "Reply for Tal",
      raw: { output_text: "Reply for Tal" },
    });

    const other = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "hello", employeeId: otherEmployeeId });

    expect(other.status).toBe(200);
    expect(other.body).toMatchObject({
      reply: "Reply for Tal",
      raw: { output_text: "Reply for Tal" },
      notifications: [],
    });
    expect(createConversation).toHaveBeenCalledTimes(2);
    expect(createResponse.mock.calls[0][0].conversationId).toBe("conv_test_1");
    expect(createResponse.mock.calls[1][0].conversationId).toBe("conv_test_other");
  });

  it("starts a separate conversation per digital employee using that worker's DB prompt", async () => {
    const dianaId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const cookie = await login();
    mockOwnedEmployee();
    findMany.mockResolvedValue([
      ...tableEmployees(),
      {
        id: dianaId,
        userId,
        kind: "digital",
        isProtected: false,
        name: "דיאנה",
        surname: "",
        nickname: "דיאנה",
        email: null,
        phone: null,
        model: "gpt-4.1",
        temperature: 0.4,
        instructions: "Diana system prompt",
        createdAt: new Date(),
      },
    ]);
    const previousFindFirst = findFirst.getMockImplementation();
    findFirst.mockImplementation(async (args: { where: { id?: string; isProtected?: boolean } }) => {
      if (args.where.id === dianaId) {
        return {
          id: dianaId,
          userId,
          kind: "digital",
          isProtected: false,
          name: "דיאנה",
          surname: "",
          nickname: "דיאנה",
          email: null,
          phone: null,
          model: "gpt-4.1",
          temperature: 0.4,
          instructions: "Diana system prompt",
          createdAt: new Date(),
        };
      }
      return previousFindFirst?.(args);
    });

    await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "hi lucy", employeeId, digitalEmployeeId: lucyId });

    createConversation.mockResolvedValue("conv_diana");
    createResponse.mockResolvedValue({
      reply: "Diana reply",
      raw: { output_text: "Diana reply" },
    });

    const diana = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "hi diana", employeeId, digitalEmployeeId: dianaId });

    expect(diana.status).toBe(200);
    expect(createConversation).toHaveBeenCalledTimes(2);
    expect(createResponse.mock.calls[0][0].conversationId).toBe("conv_test_1");
    expect(createResponse.mock.calls[1][0].conversationId).toBe("conv_diana");
    expect(createResponse.mock.calls[0][0].textFormat).toMatchObject({
      type: "json_schema",
      name: "lucy_metadata_response",
    });
    expect(createResponse.mock.calls[1][0].textFormat).toMatchObject({
      type: "json_schema",
      name: "lucy_metadata_response",
    });
    expect(createResponse.mock.calls[1][0].instructions).toContain("You are דיאנה");
    expect(createResponse.mock.calls[1][0].instructions).toContain(
      "Diana system prompt",
    );
    expect(createResponse.mock.calls[1][0].instructions).toContain(
      "Follow ONLY your system instructions above",
    );
    expect(createResponse.mock.calls[1][0].instructions).not.toContain(
      "list every capability",
    );
    expect(createResponse.mock.calls[1][0].instructions).not.toContain(
      "You support every action",
    );
    expect(createResponse.mock.calls[1][0].model).toBe("gpt-4.1");
    expect(createResponse.mock.calls[1][0].temperature).toBe(0.4);
  });

  it("includes current employee records in every LLM turn", async () => {
    listFindMany.mockResolvedValue([
      {
        listType: "shopping",
        name: "",
        employee: { name: "עמית", nickname: "עמית" },
        items: [
          { data: { "שם פריט": "חלב" }, scope: "personal", createdAt: new Date() },
        ],
      },
      {
        listType: "tasks",
        name: "",
        employee: { name: "עמית", nickname: "עמית" },
        items: [
          {
            data: { "שם מטלה": "לקנות מתנה" },
            scope: "personal",
            createdAt: new Date(),
          },
        ],
      },
    ]);
    filingFindMany.mockResolvedValue([
      {
        itemName: "מספר רכב",
        itemInfo: "3434343",
        itemDescription: "רכב",
        employee: { name: "עמית", nickname: "עמית" },
      },
    ]);

    const cookie = await login();
    mockOwnedEmployee();

    await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "hi", employeeId });

    const firstInstructions = createResponse.mock.calls[0][0].instructions as string;
    const firstMessage = createResponse.mock.calls[0][0].message as string;
    expect(firstInstructions).toContain("EMPLOYEE_SAVED_DATA");
    expect(firstMessage).toContain("חלב");
    expect(firstMessage).toContain("לקנות מתנה");
    expect(firstMessage).toContain("מספר רכב");
    expect(firstMessage).toContain("עמית: hi");

    createResponse.mockResolvedValue({
      reply: "Second reply",
      raw: { output_text: "Second reply" },
    });

    await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "and another thing", employeeId });

    expect(createResponse.mock.calls[1][0].instructions).toContain(
      "EMPLOYEE_SAVED_DATA",
    );
    expect(createResponse.mock.calls[1][0].message).toContain(
      "עמית: and another thing",
    );
  });

  it("saves list, task, and filing actions from the LLM onto the employee", async () => {
    createResponse.mockResolvedValue({
      reply: JSON.stringify({
        response: "Done.",
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "shopping",
              items: [{ "שם פריט": "חלב" }],
            },
            {
              action: "add",
              list_type: "tasks",
              items: [{ "שם מטלה": "לקנות מתנה" }],
            },
          ],
          filing: [
            {
              action: "add_filing",
              item_name: "מספר רכב",
              item_info: "3434343",
              item_description: "מספר רכב",
            },
          ],
        },
      }),
      raw: { output_text: "Done." },
    });

    const cookie = await login();
    mockOwnedEmployee();

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "add milk", employeeId });

    expect(response.status).toBe(200);
    expect(itemCreate).toHaveBeenCalledWith({
      data: {
        listId: "list-1",
        itemKey: "חלב",
        data: { "שם פריט": "חלב" },
        scope: "personal",
        addedById: employeeId,
        visibleTo: [employeeId],
        urgency: "normal",
      },
    });
    expect(itemCreate).toHaveBeenCalledWith({
      data: {
        listId: "list-1",
        itemKey: "לקנות מתנה",
        data: { "שם מטלה": "לקנות מתנה" },
        scope: "personal",
        addedById: employeeId,
        visibleTo: [employeeId],
        urgency: "normal",
      },
    });
    expect(filingCreate).toHaveBeenCalledWith({
      data: {
        employeeId,
        itemName: "מספר רכב",
        itemInfo: "3434343",
        itemDescription: "מספר רכב",
        addedById: employeeId,
      },
    });
    expect(response.body.reply).toContain("Done.");
    expect(response.body.reply).not.toContain("הוספתי «חלב»");
  });

  it("saves a targeted action on the other employee and pushes an assistant notification", async () => {
    createResponse.mockResolvedValue({
      reply: JSON.stringify({
        response: "רשמתי לטל לקנות חלב",
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "shopping",
              targets: ["טל"],
              items: [{ "שם פריט": "חלב" }],
            },
          ],
          filing: [],
        },
      }),
      raw: { output_text: "assigned" },
    });

    const cookie = await login();
    mockOwnedEmployee();

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "טל צריך לקנות חלב", employeeId });

    expect(response.status).toBe(200);
    expect(createResponse).toHaveBeenCalledOnce();
    expect(itemCreate).toHaveBeenCalledWith({
      data: {
        listId: "list-1",
        itemKey: "חלב",
        data: { "שם פריט": "חלב" },
        scope: "shared",
        addedById: employeeId,
        visibleTo: [employeeId, otherEmployeeId],
        urgency: "normal",
      },
    });
    expect(itemCreate).toHaveBeenCalledTimes(1);
    expect(response.body.notifications).toHaveLength(1);
    expect(response.body.notifications[0].employeeId).toBe(otherEmployeeId);
    expect(response.body.notifications[0].message.text).toBe(
      "עמית הוסיף חלב לרשימת הקניות שלך",
    );
  });

  it("saves a task for Tal only when the LLM set targets", async () => {
    createResponse.mockResolvedValue({
      reply: JSON.stringify({
        response: "הוספתי מטלה: טל צריך לקחת מחר בבוקר את הילדים לגינה.",
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "tasks",
              items: [
                {
                  "שם מטלה": "לקחת מחר בבוקר את הילדים לגינה",
                },
              ],
              targets: ["טל"],
            filingId: "",
            },
          ],
          filing: [],
        },
      }),
      raw: { output_text: "task" },
    });

    const cookie = await login();
    mockOwnedEmployee();

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({
        message: "טל צריך לקחת מחר בבוקר את הילדים לגינה",
        employeeId,
      });

    expect(response.status).toBe(200);
    expect(itemCreate).toHaveBeenCalledWith({
      data: {
        listId: "list-1",
        itemKey: "לקחת מחר בבוקר את הילדים לגינה",
        data: { "שם מטלה": "לקחת מחר בבוקר את הילדים לגינה" },
        scope: "shared",
        addedById: employeeId,
        visibleTo: [employeeId, otherEmployeeId],
        urgency: "normal",
      },
    });
    expect(response.body.notifications).toHaveLength(1);
    expect(response.body.notifications[0].employeeId).toBe(otherEmployeeId);
    expect(response.body.notifications[0].message.text).toBe(
      "עמית הוסיף לך מטלה: לקחת מחר בבוקר את הילדים לגינה",
    );
    expect(deliverWhatsAppRelaysMock).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          target: expect.objectContaining({ id: otherEmployeeId }),
          text: "עמית הוסיף לך מטלה: לקחת מחר בבוקר את הילדים לגינה",
        }),
      ],
      employeeId,
    );
  });

  it("notifies the person who added a shared item when the owner deletes it", async () => {
    createResponse.mockResolvedValue({
      reply: JSON.stringify({
        response: "הסרתי את הטונה מרשימת הקניות",
        metadata: {
          lists: [
            {
              action: "remove",
              list_type: "shopping",
              items: [{ item_id: "tuna-1", "שם פריט": "קופסת טונה" }],
            },
          ],
          filing: [],
        },
      }),
      raw: { output_text: "removed" },
    });
    listFindFirst.mockResolvedValue({
      id: "tal-shop",
      employeeId: otherEmployeeId,
      listType: "shopping",
      name: "",
    });
    itemFindFirst.mockResolvedValue({
      id: "tuna-1",
      listId: "tal-shop",
      itemKey: "קופסת טונה",
      scope: "shared",
      addedById: employeeId,
      visibleTo: [employeeId, otherEmployeeId],
      data: { "שם פריט": "קופסת טונה", כמות: 1 },
      list: {
        id: "tal-shop",
        employeeId: otherEmployeeId,
        listType: "shopping",
        name: "",
        titleField: "",
      },
    });

    const cookie = await login();
    mockOwnedEmployee();

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "קניתי טונה", employeeId: otherEmployeeId });

    expect(response.status).toBe(200);
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "tuna-1" },
      data: { deletedAt: expect.any(Date), reminderId: null },
    });
    expect(itemUpdateMany).toHaveBeenCalledWith({
      where: {
        itemKey: { contains: "קופסת טונה" },
        deletedAt: null,
        list: {
          listType: "tasks",
          employeeId: { in: [otherEmployeeId, employeeId] },
        },
      },
      data: { deletedAt: expect.any(Date), reminderId: null },
    });
    expect(response.body.notifications).toHaveLength(1);
    expect(response.body.notifications[0].employeeId).toBe(employeeId);
    expect(response.body.notifications[0].message.text).toBe(
      "טל מחק «קופסת טונה» מרשימת «קניות»",
    );
  });

  it("notifies the other employee when a shared item is updated", async () => {
    createResponse.mockResolvedValue({
      reply: JSON.stringify({
        response: "עדכנתי לטל שתי קופסאות טונה",
        metadata: {
          lists: [
            {
              action: "update",
              list_type: "shopping",
              targets: ["טל"],
              items: [{ item_id: "tuna-1", "שם פריט": "קופסת טונה", כמות: 2 }],
            },
          ],
          filing: [],
        },
      }),
      raw: { output_text: "updated" },
    });
    listFindFirst.mockResolvedValue({
      id: "tal-shop",
      employeeId: otherEmployeeId,
      listType: "shopping",
      name: "",
    });
    itemFindFirst.mockResolvedValue({
      id: "tuna-1",
      listId: "tal-shop",
      itemKey: "קופסת טונה",
      scope: "shared",
      addedById: employeeId,
      visibleTo: [employeeId, otherEmployeeId],
      data: { "שם פריט": "קופסת טונה", כמות: 1 },
      list: {
        id: "tal-shop",
        employeeId: otherEmployeeId,
        listType: "shopping",
        name: "",
        titleField: "",
      },
    });

    const cookie = await login();
    mockOwnedEmployee();

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "לטל צריך שתי קופסאות טונה", employeeId });

    expect(response.status).toBe(200);
    expect(response.body.notifications).toHaveLength(1);
    expect(response.body.notifications[0].employeeId).toBe(otherEmployeeId);
    expect(response.body.notifications[0].message.text).toBe(
      "עמית עדכן קופסת טונה ברשימת הקניות שלך",
    );
  });

  it("relays an LLM-phrased message to Tal's Lucy thread", async () => {
    createResponse.mockResolvedValue({
      reply: JSON.stringify({
        response: "שלחתי לטל",
        metadata: {
          lists: [],
          filing: [],
          messages: [
            {
              targets: ["טל"],
              text: "עמית שואל מה שלומך?\nמה לענות לו ?",
            },
          ],
        },
      }),
      raw: { output_text: "sent" },
    });

    const cookie = await login();
    mockOwnedEmployee();

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({
        message: "תשלחי הודעה לטל - מה שלומך ?",
        employeeId,
      });

    expect(response.status).toBe(200);
    expect(response.body.notifications).toHaveLength(1);
    expect(response.body.notifications[0].employeeId).toBe(otherEmployeeId);
    expect(response.body.notifications[0].digitalEmployeeId).toBe(lucyId);
    expect(response.body.notifications[0].message.speaker).toBe("לוסי");
    expect(response.body.notifications[0].message.text).toBe(
      "עמית שואל מה שלומך?\nמה לענות לו ?",
    );
    expect(appendAssistantMessage).toHaveBeenCalledWith(
      expect.any(String),
      "עמית שואל מה שלומך?\nמה לענות לו ?",
    );
  });

  it("does not relay when the LLM omitted messages", async () => {
    createResponse.mockResolvedValue({
      reply: JSON.stringify({
        response: "בדקתי עם טל",
        metadata: { lists: [], filing: [], messages: [] },
      }),
      raw: { output_text: "check" },
    });

    const cookie = await login();
    mockOwnedEmployee();

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({
        message: "תבדקי עם טל אם הוא קנה שמן",
        employeeId,
      });

    expect(response.status).toBe(200);
    expect(response.body.notifications).toHaveLength(0);
  });

  it("delivers a pure-info message to a digital employee on the speaker thread", async () => {
    const dianaId = "8bbbe1a2-c4c1-4edc-9d87-fe5ac740c1f4";
    createResponse.mockResolvedValue({
      reply: JSON.stringify({
        response: "שלחתי לדיאנה",
        metadata: {
          lists: [],
          filing: [],
          messages: [
            {
              targets: ["דיאנה"],
              text: "עמית מודה לך על הטיסה",
              expects_reply: false,
              ask_summary: "",
            },
          ],
        },
      }),
      raw: { output_text: "diana" },
    });

    const cookie = await login();
    mockOwnedEmployee();
    findMany.mockResolvedValue([
      ...tableEmployees(),
      {
        id: dianaId,
        userId,
        kind: "digital",
        isProtected: false,
        name: "דיאנה",
        surname: "",
        nickname: "דיאנה",
        email: null,
        phone: null,
        model: "gpt-4.1-mini",
        temperature: 0,
        instructions: "Travel agent",
        createdAt: new Date(),
      },
    ]);

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({
        message: "תגידי לדיאנה תודה על הטיסה",
        employeeId,
      });

    expect(response.status).toBe(200);
    expect(createResponse).toHaveBeenCalledOnce();
    expect(response.body.notifications).toHaveLength(1);
    expect(response.body.notifications[0].employeeId).toBe(employeeId);
    expect(response.body.notifications[0].digitalEmployeeId).toBe(dianaId);
    expect(response.body.notifications[0].message.text).toBe(
      "עמית מודה לך על הטיסה",
    );
  });

  // T4: invalid / cross-kind ids → no-match (never expands to full list).
  it("ITEM DUMP: unknown show_dump_ids → no-match, not the full tasks list", async () => {
    const taskTitle = "לשיננית מחר";
    listFindMany.mockImplementation(
      async ({ where }: { where?: { employeeId?: unknown } }) => {
        if (
          where?.employeeId &&
          typeof where.employeeId === "object" &&
          where.employeeId !== null &&
          "not" in (where.employeeId as object)
        ) {
          return [];
        }
        return [
          {
            id: "list-tasks-dump",
            listType: "tasks",
            name: "",
            employeeId,
            scope: "personal",
            employee: { id: employeeId, name: "עמית", nickname: "עמית" },
            items: [
              {
                id: "task-real-1",
                data: { "שם מטלה": taskTitle },
                scope: "personal",
                createdAt: new Date(),
              },
              {
                id: "task-real-2",
                data: { "שם מטלה": "לקנות חלב" },
                scope: "personal",
                createdAt: new Date(),
              },
            ],
          },
        ];
      },
    );
    createResponse.mockResolvedValue({
      reply: JSON.stringify({
        responses: [{ text: "הנה המטלה שביקשת" }],
        metadata: {
          lists: [],
          show_dump: "tasks",
          show_dump_ids: "missing-item-id-xyz",
        },
      }),
      raw: { output_text: "dump miss" },
    });

    const cookie = await login();
    mockOwnedEmployee();

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "הציגי את המטלה החסרה", employeeId });

    expect(response.status).toBe(200);
    expect(response.body.reply).toContain("לא מצאתי את הפריט.");
    expect(response.body.reply).not.toContain(taskTitle);
    expect(response.body.reply).not.toContain("לקנות חלב");
    expect(response.body.reply).not.toContain("מטלות:");
    expect(response.body.reply).not.toContain("הנה המטלה שביקשת");
  });

  // T4 (cross-kind).
  it("ITEM DUMP: id from another list kind → no-match, no cross-kind or full dump", async () => {
    const taskTitle = "ללכת לרופא";
    const filingName = "קוד שער";
    const filingId = "filing-only-id-99";
    listFindMany.mockImplementation(
      async ({ where }: { where?: { employeeId?: unknown } }) => {
        if (
          where?.employeeId &&
          typeof where.employeeId === "object" &&
          where.employeeId !== null &&
          "not" in (where.employeeId as object)
        ) {
          return [];
        }
        return [
          {
            id: "list-tasks-cross",
            listType: "tasks",
            name: "",
            employeeId,
            scope: "personal",
            employee: { id: employeeId, name: "עמית", nickname: "עמית" },
            items: [
              {
                id: "task-doctor",
                data: { "שם מטלה": taskTitle },
                scope: "personal",
                createdAt: new Date(),
              },
            ],
          },
        ];
      },
    );
    filingFindMany.mockImplementation(
      async ({ where }: { where?: { employeeId?: unknown } }) => {
        if (
          where?.employeeId &&
          typeof where.employeeId === "object" &&
          where.employeeId !== null &&
          "not" in (where.employeeId as object)
        ) {
          return [];
        }
        return [
          {
            id: filingId,
            itemName: filingName,
            itemInfo: "1234",
            itemDescription: "",
            employeeId,
            scope: "personal",
            employee: { name: "עמית", nickname: "עמית" },
          },
        ];
      },
    );
    createResponse.mockResolvedValue({
      reply: JSON.stringify({
        responses: [{ text: "מציגה את הפריט" }],
        metadata: {
          lists: [],
          show_dump: "tasks",
          // Exists only as a filing_id — must not open that filing or dump all tasks.
          show_dump_ids: filingId,
        },
      }),
      raw: { output_text: "cross-kind" },
    });

    const cookie = await login();
    mockOwnedEmployee();

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "הציגי את המטלה לפי מזהה תיוק", employeeId });

    expect(response.status).toBe(200);
    expect(response.body.reply).toContain("לא מצאתי את הפריט.");
    expect(response.body.reply).not.toContain(taskTitle);
    expect(response.body.reply).not.toContain(filingName);
    expect(response.body.reply).not.toContain("1234");
    expect(response.body.reply).not.toContain("מטלות:");
    expect(response.body.reply).not.toContain("תיוקים:");
  });

  // T2 (chat path): show_dump + ids → REPLACE only those rows.
  it("T2: show_dump tasks + show_dump_ids replaces with selected row only", async () => {
    listFindMany.mockImplementation(
      async ({ where }: { where?: { employeeId?: unknown } }) => {
        if (
          where?.employeeId &&
          typeof where.employeeId === "object" &&
          where.employeeId !== null &&
          "not" in (where.employeeId as object)
        ) {
          return [];
        }
        return [
          {
            id: "list-tasks-t2",
            listType: "tasks",
            name: "",
            employeeId,
            scope: "personal",
            employee: { id: employeeId, name: "עמית", nickname: "עמית" },
            items: [
              {
                id: "task-meet",
                data: {
                  "שם מטלה": "פגישה עם רואה חשבון",
                  "תאריך לביצוע": "2026-10-12",
                },
                scope: "personal",
                createdAt: new Date(),
              },
              {
                id: "task-pkg",
                data: {
                  "שם מטלה": "לאסוף חבילה",
                  "תאריך לביצוע": "2026-10-14",
                },
                scope: "personal",
                createdAt: new Date(),
              },
            ],
          },
        ];
      },
    );
    createResponse.mockResolvedValue({
      reply: JSON.stringify({
        responses: [{ text: "הנה הפגישות שבחרתי" }],
        metadata: {
          lists: [],
          show_dump: "tasks",
          show_dump_ids: "task-meet",
        },
      }),
      raw: { output_text: "t2 ids" },
    });

    const cookie = await login();
    mockOwnedEmployee();

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "הציגי את הפגישה", employeeId });

    expect(response.status).toBe(200);
    expect(response.body.reply).toContain("פגישה עם רואה חשבון");
    expect(response.body.reply).not.toContain("לאסוף חבילה");
    expect(response.body.reply).not.toContain("הנה הפגישות שבחרתי");
    const { prisma: prismaMock } = await import("../src/database/prisma.js");
    const updateCalls = (prismaMock.chatMessage.update as ReturnType<typeof vi.fn>)
      .mock.calls;
    const updatedButtons = updateCalls.flatMap((call) => {
      const data = (call[0] as { data?: { buttons?: unknown } } | undefined)?.data;
      return data?.buttons ? [data.buttons] : [];
    });
    expect(JSON.stringify(updatedButtons)).toMatch(/סמן כבוצע/);
  });

  it("ITEM DUMP about-path single task attaches סמן כבוצע + reminder twin", async () => {
    listFindMany.mockImplementation(
      async ({ where }: { where?: { employeeId?: unknown } }) => {
        if (
          where?.employeeId &&
          typeof where.employeeId === "object" &&
          where.employeeId !== null &&
          "not" in (where.employeeId as object)
        ) {
          return [];
        }
        return [
          {
            id: "list-tasks-about",
            listType: "tasks",
            name: "",
            employeeId,
            scope: "personal",
            employee: { id: employeeId, name: "עמית", nickname: "עמית" },
            items: [
              {
                id: "task-about-1",
                data: { "שם מטלה": "ללכת לספר" },
                reminderId: "r-about-1",
                linkedReminderId: "r-about-1",
                scope: "personal",
                createdAt: new Date(),
              },
            ],
          },
        ];
      },
    );
    createResponse.mockResolvedValue({
      reply: JSON.stringify({
        responses: [{ text: "הנה המטלה" }],
        metadata: {
          lists: [],
          show_dump: "tasks",
          show_dump_about: "עמית",
          show_dump_ids: "task-about-1",
        },
      }),
      raw: { output_text: "about item dump" },
    });

    const cookie = await login();
    mockOwnedEmployee();

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "הציגי את המטלה של עמית", employeeId });

    expect(response.status).toBe(200);
    expect(response.body.reply).toContain("ללכת לספר");
    const { prisma: prismaMock } = await import("../src/database/prisma.js");
    const updateCalls = (prismaMock.chatMessage.update as ReturnType<typeof vi.fn>)
      .mock.calls;
    const buttonsJson = JSON.stringify(
      updateCalls.flatMap((call) => {
        const data = (call[0] as { data?: { buttons?: unknown } } | undefined)?.data;
        return data?.buttons ? [data.buttons] : [];
      }),
    );
    expect(buttonsJson).toMatch(/סמן כבוצע:\s*ללכת לספר/);
    // Linked reminder id on the row → עדכן תזכורת twin (same as speaker ITEM DUMP).
    expect(buttonsJson).toMatch(/עדכן תזכורת:\s*ללכת לספר|הוסף תזכורת:\s*ללכת לספר/);
  });

  it("TOPIC DUMP: show_dump=full + mixed show_dump_ids keeps only matching rows", async () => {
    listFindMany.mockImplementation(
      async ({ where }: { where?: { employeeId?: unknown } }) => {
        if (
          where?.employeeId &&
          typeof where.employeeId === "object" &&
          where.employeeId !== null &&
          "not" in (where.employeeId as object)
        ) {
          return [];
        }
        return [
          {
            id: "list-shop-topic",
            listType: "shopping",
            name: "",
            employeeId,
            scope: "personal",
            employee: { id: employeeId, name: "עמית", nickname: "עמית" },
            items: [
              {
                id: "shop-floss",
                data: { "שם פריט": "חוט דנטלי", כמות: 1 },
                scope: "personal",
                createdAt: new Date(),
              },
              {
                id: "shop-milk",
                data: { "שם פריט": "חלב", כמות: 1 },
                scope: "personal",
                createdAt: new Date(),
              },
            ],
          },
          {
            id: "list-tasks-topic",
            listType: "tasks",
            name: "",
            employeeId,
            scope: "personal",
            employee: { id: employeeId, name: "עמית", nickname: "עמית" },
            items: [
              {
                id: "task-dentist",
                data: { "שם מטלה": "לשיננית" },
                scope: "personal",
                createdAt: new Date(),
              },
              {
                id: "task-pkg",
                data: { "שם מטלה": "לאסוף חבילה" },
                scope: "personal",
                createdAt: new Date(),
              },
            ],
          },
        ];
      },
    );
    filingFindMany.mockImplementation(
      async ({ where }: { where?: { employeeId?: unknown } }) => {
        if (
          where?.employeeId &&
          typeof where.employeeId === "object" &&
          where.employeeId !== null &&
          "not" in (where.employeeId as object)
        ) {
          return [];
        }
        return [
          {
            id: "fil-clinic",
            itemName: "מרפאת שיניים",
            itemInfo: "רחוב 1",
            itemDescription: "",
            employeeId,
            scope: "personal",
            employee: { name: "עמית", nickname: "עמית" },
          },
          {
            id: "fil-gate",
            itemName: "קוד שער",
            itemInfo: "9999",
            itemDescription: "",
            employeeId,
            scope: "personal",
            employee: { name: "עמית", nickname: "עמית" },
          },
        ];
      },
    );
    createResponse.mockResolvedValue({
      reply: JSON.stringify({
        responses: [{ text: "הנה מה שמצאתי על שיניים" }],
        metadata: {
          lists: [],
          show_dump: "full",
          show_dump_ids: ["task-dentist", "shop-floss", "fil-clinic", "ghost-id"],
        },
      }),
      raw: { output_text: "topic dump" },
    });

    const cookie = await login();
    mockOwnedEmployee();

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "מה יש לי שקשור לשיניים?", employeeId });

    expect(response.status).toBe(200);
    expect(response.body.reply).toContain("לשיננית");
    expect(response.body.reply).toContain("חוט דנטלי");
    expect(response.body.reply).toContain("מרפאת שיניים");
    expect(response.body.reply).not.toContain("לאסוף חבילה");
    expect(response.body.reply).not.toContain("חלב");
    expect(response.body.reply).not.toContain("קוד שער");
    expect(response.body.reply).not.toContain("הנה מה שמצאתי על שיניים");
    expect(response.body.reply).not.toMatch(/אישיות — \d+ פריט/);
    expect(response.body.reply).not.toContain("לפירוט רשימה");
  });

  it("TOPIC DUMP: full + unknown/empty show_dump_ids → no-match, not unfiltered full", async () => {
    listFindMany.mockImplementation(
      async ({ where }: { where?: { employeeId?: unknown } }) => {
        if (
          where?.employeeId &&
          typeof where.employeeId === "object" &&
          where.employeeId !== null &&
          "not" in (where.employeeId as object)
        ) {
          return [];
        }
        return [
          {
            id: "list-tasks-full-miss",
            listType: "tasks",
            name: "",
            employeeId,
            scope: "personal",
            employee: { id: employeeId, name: "עמית", nickname: "עמית" },
            items: [
              {
                id: "task-keep",
                data: { "שם מטלה": "משימה קיימת" },
                scope: "personal",
                createdAt: new Date(),
              },
            ],
          },
        ];
      },
    );
    createResponse.mockResolvedValue({
      reply: JSON.stringify({
        responses: [{ text: "אמור להיות no-match" }],
        metadata: {
          lists: [],
          show_dump: "full",
          show_dump_ids: ["missing-topic-id"],
        },
      }),
      raw: { output_text: "topic miss" },
    });

    const cookie = await login();
    mockOwnedEmployee();

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "הציגי לפי מזהה חסר", employeeId });

    expect(response.status).toBe(200);
    expect(response.body.reply).toContain("לא מצאתי את הפריט.");
    expect(response.body.reply).not.toContain("משימה קיימת");
    expect(response.body.reply).not.toContain("לפירוט רשימה");
    expect(response.body.reply).not.toContain("אמור להיות no-match");
  });

  // T5: no show_dump → model responses kept (no dump REPLACE).
  it("T5: without show_dump the spoken reply is not replaced by a dump", async () => {
    createResponse.mockResolvedValue({
      reply: JSON.stringify({
        responses: [
          {
            text: "לפי המידע הזמין עכשיו: יש תור לשיננית; אם יש עוד פריטים שלא הופיעו בהקשר — תגיד.",
          },
        ],
        metadata: { lists: [], show_dump: null },
      }),
      raw: { output_text: "t5 no dump" },
    });

    const cookie = await login();
    mockOwnedEmployee();

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "מה יש לי שקשור לשיניים?", employeeId });

    expect(response.status).toBe(200);
    expect(response.body.reply).toContain("לפי המידע הזמין עכשיו");
    expect(response.body.reply).toContain("תור לשיננית");
    expect(response.body.reply).not.toContain("מטלות:");
  });
});
