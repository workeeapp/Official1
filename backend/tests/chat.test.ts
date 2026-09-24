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
  listCreate,
  itemFindUnique,
  itemCreate,
  itemUpdate,
  itemDeleteMany,
  filingFindMany,
  filingUpsert,
} = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
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
  listCreate: vi.fn(),
  itemFindUnique: vi.fn(),
  itemCreate: vi.fn(),
  itemUpdate: vi.fn(),
  itemDeleteMany: vi.fn(),
  filingFindMany: vi.fn(),
  filingUpsert: vi.fn(),
}));

const { createConversation, createResponse } = vi.hoisted(() => ({
  createConversation: vi.fn(),
  createResponse: vi.fn(),
}));

const conversationStore = new Map<string, ConversationRow>();
const messageStore: MessageRow[] = [];

function storeKey(userId: string, employeeId: string, digitalEmployeeId: string): string {
  return `${userId}:${employeeId}:${digitalEmployeeId}`;
}

function resetChatStore(): void {
  conversationStore.clear();
  messageStore.length = 0;
}

function ageStoredConversation(hours: number): void {
  const when = new Date(Date.now() - hours * 60 * 60 * 1000);
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
      create: messageCreate,
      createMany: messageCreateMany,
      deleteMany: messageDeleteMany,
    },
    employeeList: {
      findMany: listFindMany,
      findUnique: listFindUnique,
      create: listCreate,
    },
    employeeListItem: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: itemFindUnique,
      create: itemCreate,
      update: itemUpdate,
      deleteMany: itemDeleteMany,
    },
    employeeFiling: {
      findMany: filingFindMany,
      upsert: filingUpsert,
    },
    reminder: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

import { createApp } from "../src/app.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";

const PASSWORD = "ChangeMe123!";
const userId = "11111111-1111-4111-8111-111111111111";
const employeeId = "415ff13e-38d0-4dee-98b5-71e5dd11a38d";
const otherEmployeeId = "4cded1a2-c4c1-4edc-9d87-fe5ac740c1f4";
const lucyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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

function mockOwnedEmployee() {
  findMany.mockResolvedValue(tableEmployees());
  findFirst.mockImplementation(async ({ where }: { where: { id?: string; isProtected?: boolean } }) => {
    if (where.isProtected || where.id === lucyId) {
      return {
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
      };
    }

    if (where.id === employeeId) {
      return {
        id: employeeId,
        userId,
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
        name: "טל",
        surname: "דור",
        nickname: "טל",
        email: null,
        phone: null,
        createdAt: new Date(),
      };
    }

    return null;
  });
}

describe("chat API", () => {
  beforeEach(async () => {
    passwordHash ??= await hashPassword(PASSWORD);
    findUnique.mockReset();
    findFirst.mockReset();
    findMany.mockReset().mockResolvedValue([]);
    createConversation.mockReset().mockResolvedValue("conv_test_1");
    createResponse.mockReset().mockResolvedValue({
      reply: "Hello from the model",
      raw: { output_text: "Hello from the model" },
    });
    resetChatStore();
    conversationFindUnique.mockReset().mockImplementation(
      async ({
        where,
        include,
      }: {
        where: {
          userId_employeeId_digitalEmployeeId: {
            userId: string;
            employeeId: string;
            digitalEmployeeId: string;
          };
        };
        include?: { messages?: unknown };
      }) => {
        const pair = where.userId_employeeId_digitalEmployeeId;
        const found = conversationStore.get(
          storeKey(pair.userId, pair.employeeId, pair.digitalEmployeeId),
        );
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
        data: { contextInjectedAt?: Date | null; openaiConversationId?: string };
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
    listCreate.mockReset().mockResolvedValue({
      id: "list-1",
      employeeId,
      listType: "shopping",
      name: "",
    });
    itemFindUnique.mockReset().mockResolvedValue(null);
    itemCreate.mockReset().mockResolvedValue({ id: "item-1" });
    itemUpdate.mockReset().mockResolvedValue({ id: "item-1" });
    itemDeleteMany.mockReset().mockResolvedValue({ count: 1 });
    filingFindMany.mockReset().mockResolvedValue([]);
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
    setLlmClientForTests({
      createConversation,
      createResponse,
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
    expect(response.body).toEqual({
      reply: "Hello from the model",
      raw: { output_text: "Hello from the model" },
      notifications: [],
    });
    expect(createConversation).toHaveBeenCalledOnce();
    expect(createResponse).toHaveBeenCalledOnce();
    expect(createResponse.mock.calls[0][0].conversationId).toBe("conv_test_1");
    expect(createResponse.mock.calls[0][0].message).toContain("hi");
    expect(messageCreateMany).toHaveBeenCalledOnce();
    const saved = messageCreateMany.mock.calls[0][0].data as Array<{
      author: string;
      createdAt: Date;
    }>;
    expect(saved[0].author).toBe("you");
    expect(saved[1].author).toBe("assistant");
    expect(saved[1].createdAt.getTime()).toBeGreaterThan(saved[0].createdAt.getTime());
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
    expect(second.body).toEqual({
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

    ageStoredConversation(2);
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
      isNew: true,
    });
    expect(createConversation).toHaveBeenCalledTimes(2);
  });

  it("starts a new OpenAI conversation after an hour of idle chat", async () => {
    const cookie = await login();
    mockOwnedEmployee();

    await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "hi", employeeId });

    ageStoredConversation(2);
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
    expect(other.body).toEqual({
      reply: "Reply for Tal",
      raw: { output_text: "Reply for Tal" },
      notifications: [],
    });
    expect(createConversation).toHaveBeenCalledTimes(2);
    expect(createResponse.mock.calls[0][0].conversationId).toBe("conv_test_1");
    expect(createResponse.mock.calls[1][0].conversationId).toBe("conv_test_other");
  });

  it("starts a separate conversation and uses each digital employee's LLM settings", async () => {
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
    expect(createResponse.mock.calls[0][0].model).toBe("gpt-4.1-mini");
    expect(createResponse.mock.calls[0][0].temperature).toBe(0);
    expect(createResponse.mock.calls[0][0].instructions).toContain(
      "You manage lists and filings.",
    );
    expect(createResponse.mock.calls[0][0].textFormat).toMatchObject({
      type: "json_schema",
      name: "lucy_metadata_response",
    });
    expect(createResponse.mock.calls[1][0].conversationId).toBe("conv_diana");
    expect(createResponse.mock.calls[1][0].model).toBe("gpt-4.1");
    expect(createResponse.mock.calls[1][0].temperature).toBe(0.4);
    expect(createResponse.mock.calls[1][0].instructions).toContain("Diana system prompt");
    expect(createResponse.mock.calls[1][0].textFormat).toBeUndefined();
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
    expect(firstInstructions).toContain("EMPLOYEE_SAVED_DATA");
    expect(firstInstructions).toContain("חלב");
    expect(firstInstructions).toContain("לקנות מתנה");
    expect(firstInstructions).toContain("מספר רכב");
    expect(createResponse.mock.calls[0][0].message).toContain("עמית: hi");

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
      },
    });
    expect(filingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          employeeId,
          itemName: "מספר רכב",
          itemInfo: "3434343",
          addedById: employeeId,
        },
      }),
    );
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
      },
    });
    expect(itemCreate).toHaveBeenCalledWith({
      data: {
        listId: "list-1",
        itemKey: "טל צריך לקנות חלב",
        data: { "שם מטלה": "טל צריך לקנות חלב" },
        scope: "personal",
        addedById: employeeId,
        visibleTo: [employeeId],
      },
    });
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
      },
    });
    expect(response.body.notifications).toHaveLength(1);
    expect(response.body.notifications[0].employeeId).toBe(otherEmployeeId);
    expect(response.body.notifications[0].message.text).toBe(
      "עמית הוסיף לך מטלה: לקחת מחר בבוקר את הילדים לגינה",
    );
  });

  it("notifies the person who added a shared item when the owner buys it", async () => {
    createResponse.mockResolvedValue({
      reply: JSON.stringify({
        response: "הסרתי את הטונה מרשימת הקניות",
        metadata: {
          lists: [
            {
              action: "remove",
              list_type: "shopping",
              items: [{ "שם פריט": "קופסת טונה" }],
            },
          ],
          filing: [],
        },
      }),
      raw: { output_text: "removed" },
    });
    listFindUnique.mockResolvedValue({
      id: "tal-shop",
      employeeId: otherEmployeeId,
      listType: "shopping",
      name: "",
    });
    itemFindUnique.mockResolvedValue({
      id: "tuna-1",
      listId: "tal-shop",
      itemKey: "קופסת טונה",
      scope: "shared",
      addedById: employeeId,
      visibleTo: [employeeId, otherEmployeeId],
      data: { "שם פריט": "קופסת טונה", כמות: 1 },
    });

    const cookie = await login();
    mockOwnedEmployee();

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "קניתי טונה", employeeId: otherEmployeeId });

    expect(response.status).toBe(200);
    expect(itemDeleteMany).toHaveBeenCalledWith({
      where: { listId: "tal-shop", itemKey: "קופסת טונה" },
    });
    expect(itemDeleteMany).toHaveBeenCalledWith({
      where: {
        itemKey: { contains: "קופסת טונה" },
        list: {
          listType: "tasks",
          employeeId: { in: [otherEmployeeId, employeeId] },
        },
      },
    });
    expect(response.body.notifications).toHaveLength(1);
    expect(response.body.notifications[0].employeeId).toBe(employeeId);
    expect(response.body.notifications[0].message.text).toBe("טל קנה קופסת טונה");
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
              items: [{ "שם פריט": "קופסת טונה", כמות: 2 }],
            },
          ],
          filing: [],
        },
      }),
      raw: { output_text: "updated" },
    });
    listFindUnique.mockResolvedValue({
      id: "tal-shop",
      employeeId: otherEmployeeId,
      listType: "shopping",
      name: "",
    });
    itemFindUnique.mockResolvedValue({
      id: "tuna-1",
      listId: "tal-shop",
      itemKey: "קופסת טונה",
      scope: "shared",
      addedById: employeeId,
      visibleTo: [employeeId, otherEmployeeId],
      data: { "שם פריט": "קופסת טונה", כמות: 1 },
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

  it("delivers a relayed message to a digital employee on the speaker thread", async () => {
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
              text: "עמית שואל מה מחיר הטיסה ?",
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
        message: "תשלחי הודעה לדיאנה - מה מחיר הטיסה ?",
        employeeId,
      });

    expect(response.status).toBe(200);
    expect(response.body.notifications).toHaveLength(1);
    expect(response.body.notifications[0].employeeId).toBe(employeeId);
    expect(response.body.notifications[0].digitalEmployeeId).toBe(dianaId);
    expect(response.body.notifications[0].message.text).toBe(
      "עמית שואל מה מחיר הטיסה ?",
    );
  });
});
