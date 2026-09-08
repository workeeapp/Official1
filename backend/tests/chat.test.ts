import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { hashPassword } from "../src/auth/password.js";

const { findUnique, findFirst } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
}));

const { createConversation, createResponse } = vi.hoisted(() => ({
  createConversation: vi.fn(),
  createResponse: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    user: {
      findUnique,
    },
    employee: {
      findFirst,
    },
  },
}));

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "../src/auth/session.js";
import { setLlmClientForTests } from "../src/services/llm-client.js";
import { resetConversationsForTests } from "../src/services/chat.service.js";

const PASSWORD = "ChangeMe123!";
const userId = "11111111-1111-4111-8111-111111111111";
const employeeId = "415ff13e-38d0-4dee-98b5-71e5dd11a38d";
const otherEmployeeId = "4cded1a2-c4c1-4edc-9d87-fe5ac740c1f4";

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

describe("chat API", () => {
  beforeEach(async () => {
    passwordHash ??= await hashPassword(PASSWORD);
    findUnique.mockReset();
    findFirst.mockReset();
    createConversation.mockReset().mockResolvedValue("conv_test_1");
    createResponse.mockReset().mockResolvedValue({
      reply: "Hello from the model",
      raw: { output_text: "Hello from the model" },
    });
    resetConversationsForTests();
    setLlmClientForTests({
      createConversation,
      createResponse,
    });
    app = createApp();
  });

  afterEach(() => {
    setLlmClientForTests(null);
    resetConversationsForTests();
  });

  it("rejects unauthenticated chat", async () => {
    const response = await request(app)
      .post("/api/chat/messages")
      .send({ message: "hi" });

    expect(response.status).toBe(401);
    expect(createConversation).not.toHaveBeenCalled();
  });

  it("sends a message to the LLM and returns the reply", async () => {
    const cookie = await login();
    findFirst.mockResolvedValue({
      id: employeeId,
      userId,
      name: "עמית",
      surname: "חתן",
      nickname: "עמית",
      email: null,
      phone: null,
      createdAt: new Date(),
    });

    const response = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "hi", employeeId });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      reply: "Hello from the model",
      raw: { output_text: "Hello from the model" },
    });
    expect(createConversation).toHaveBeenCalledOnce();
    expect(createResponse).toHaveBeenCalledOnce();
    expect(createResponse.mock.calls[0][0].conversationId).toBe("conv_test_1");
    expect(createResponse.mock.calls[0][0].message).toContain("hi");
  });

  it("reuses the same conversation for the same session and employee", async () => {
    const cookie = await login();
    findFirst.mockResolvedValue({
      id: employeeId,
      userId,
      name: "עמית",
      surname: "חתן",
      nickname: "עמית",
      email: null,
      phone: null,
      createdAt: new Date(),
    });

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
    });
    expect(createConversation).toHaveBeenCalledOnce();
    expect(createResponse).toHaveBeenCalledTimes(2);
    expect(createResponse.mock.calls[1][0].conversationId).toBe("conv_test_1");
  });

  it("starts a new conversation after logout and login", async () => {
    const firstCookie = await login();
    findFirst.mockResolvedValue({
      id: employeeId,
      userId,
      name: "עמית",
      surname: "חתן",
      nickname: "עמית",
      email: null,
      phone: null,
      createdAt: new Date(),
    });

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

    expect(createConversation).toHaveBeenCalledTimes(2);
    expect(createResponse.mock.calls[1][0].conversationId).toBe("conv_test_2");
  });

  it("starts a separate conversation for each employee", async () => {
    const cookie = await login();
    findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => {
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
    });

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
    });
    expect(createConversation).toHaveBeenCalledTimes(2);
    expect(createResponse.mock.calls[0][0].conversationId).toBe("conv_test_1");
    expect(createResponse.mock.calls[1][0].conversationId).toBe("conv_test_other");
  });
});
