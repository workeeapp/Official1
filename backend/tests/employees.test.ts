import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { hashPassword } from "../src/auth/password.js";

const {
  findUnique,
  findMany,
  create,
  findFirst,
  update,
  remove,
  listFindMany,
  filingFindMany,
  tipDeleteMany,
  tipFindMany,
  tipCreate,
  tipUpdate,
  attachmentLinkFindMany,
} = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listFindMany: vi.fn(),
  filingFindMany: vi.fn(),
  tipDeleteMany: vi.fn(),
  tipFindMany: vi.fn(),
  tipCreate: vi.fn(),
  tipUpdate: vi.fn(),
  attachmentLinkFindMany: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    user: {
      findUnique,
    },
    employee: {
      findMany,
      create,
      findFirst,
      update,
      delete: remove,
    },
    employeeList: {
      findMany: listFindMany,
    },
    employeeFiling: {
      findMany: filingFindMany,
    },
    tip: {
      deleteMany: tipDeleteMany,
      findMany: tipFindMany,
      create: tipCreate,
      update: tipUpdate,
    },
    attachmentLink: {
      findMany: attachmentLinkFindMany,
    },
  },
}));

import { createApp } from "../src/app.js";

const PASSWORD = "ChangeMe123!";
const userId = "11111111-1111-4111-8111-111111111111";

let passwordHash: string;
let app: ReturnType<typeof createApp>;

function cookieHeader(response: request.Response): string {
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return values.join("; ");
}

describe("employees API", () => {
  beforeEach(async () => {
    passwordHash ??= await hashPassword(PASSWORD);
    findUnique.mockReset();
    findMany.mockReset();
    create.mockReset();
    findFirst.mockReset();
    update.mockReset();
    remove.mockReset();
    listFindMany.mockReset().mockResolvedValue([]);
    filingFindMany.mockReset().mockResolvedValue([]);
    tipDeleteMany.mockReset().mockResolvedValue({ count: 0 });
    tipFindMany.mockReset().mockResolvedValue([]);
    tipCreate.mockReset().mockResolvedValue({});
    tipUpdate.mockReset().mockResolvedValue({});
    attachmentLinkFindMany.mockReset().mockResolvedValue([]);
    app = createApp();
  });

  it("rejects unauthenticated access", async () => {
    const response = await request(app).get("/api/employees");
    expect(response.status).toBe(401);
  });

  it("returns the authenticated user's employees", async () => {
    findUnique.mockResolvedValue({
      id: userId,
      username: "Amit",
      passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    findMany.mockResolvedValue([
      {
        id: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
        userId,
        name: "עמית",
        surname: "חתן",
        nickname: "עמית",
        email: "amit@example.com",
        phone: "050-0000001",
        createdAt: new Date(),
      },
    ]);

    const loginResponse = await request(app)
      .post("/api/auth/login")
      .send({ username: "Amit", password: PASSWORD });

    const response = await request(app)
      .get("/api/employees")
      .set("Cookie", cookieHeader(loginResponse));

    expect(response.status).toBe(200);
    expect(response.body.count).toBe(1);
    expect(response.body.employees[0].nickname).toBe("עמית");
  });

  it("creates an employee for the authenticated user", async () => {
    findUnique.mockResolvedValue({
      id: userId,
      username: "Amit",
      passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      userId,
      kind: "human",
      name: "Dana",
      surname: "Levi",
      nickname: "Dana",
      email: "dana@example.com",
      phone: "972501111111",
      isProtected: false,
      isOwner: false,
      createdAt: new Date(),
    });

    const loginResponse = await request(app)
      .post("/api/auth/login")
      .send({ username: "Amit", password: PASSWORD });

    const response = await request(app)
      .post("/api/employees")
      .set("Cookie", cookieHeader(loginResponse))
      .send({
        name: "Dana",
        surname: "Levi",
        nickname: "Dana",
        email: "dana@example.com",
        phone: "050-1111111",
      });

    expect(response.status).toBe(201);
    expect(response.body.employee.nickname).toBe("Dana");
    expect(response.body.employee.email).toBe("dana@example.com");
    expect(response.body.employee.phone).toBe("972501111111");
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        phone: "972501111111",
      }),
    });
  });

  it("rejects a duplicate phone number", async () => {
    findUnique.mockResolvedValue({
      id: userId,
      username: "Amit",
      passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    findFirst.mockResolvedValue({ id: "existing-phone-owner" });

    const loginResponse = await request(app)
      .post("/api/auth/login")
      .send({ username: "Amit", password: PASSWORD });

    const response = await request(app)
      .post("/api/employees")
      .set("Cookie", cookieHeader(loginResponse))
      .send({
        name: "Dana",
        surname: "Levi",
        phone: "0549999999",
      });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toBe("Phone number is already in use");
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a digital employee with the submitted prompt and model", async () => {
    findUnique.mockResolvedValue({
      id: userId,
      username: "Amit",
      passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "66666666-6666-4666-8666-666666666666",
      userId,
      isProtected: false,
      createdAt: new Date(),
      ...data,
    }));

    const loginResponse = await request(app)
      .post("/api/auth/login")
      .send({ username: "Amit", password: PASSWORD });

    const response = await request(app)
      .post("/api/employees")
      .set("Cookie", cookieHeader(loginResponse))
      .send({
        kind: "digital",
        name: "דיאנה",
        model: "gpt-4.1",
        temperature: 0.4,
        reasoningEffort: "medium",
        instructions: "Diana custom system prompt",
      });

    expect(response.status).toBe(201);
    expect(response.body.employee).toMatchObject({
      kind: "digital",
      name: "דיאנה",
      model: "gpt-4.1",
      temperature: 0.4,
      reasoningEffort: "medium",
      instructions: "Diana custom system prompt",
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "digital",
        name: "דיאנה",
        model: "gpt-4.1",
        temperature: 0.4,
        reasoningEffort: "medium",
        instructions: "Diana custom system prompt",
      }),
    });
  });

  it("rejects deleting the protected Lucy employee", async () => {
    const lucyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    findUnique.mockResolvedValue({
      id: userId,
      username: "Amit",
      passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    findFirst.mockResolvedValue({
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
    });

    const loginResponse = await request(app)
      .post("/api/auth/login")
      .send({ username: "Amit", password: PASSWORD });

    const response = await request(app)
      .delete(`/api/employees/${lucyId}`)
      .set("Cookie", cookieHeader(loginResponse));

    expect(response.status).toBe(409);
    expect(response.body.error.message).toBe("Lucy cannot be deleted");
    expect(remove).not.toHaveBeenCalled();
  });

  it("returns digital defaults from Lucy's saved prompt when present", async () => {
    findUnique.mockResolvedValue({
      id: userId,
      username: "Amit",
      passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    findFirst.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      userId,
      kind: "digital",
      isProtected: true,
      name: "לוסי",
      surname: "",
      nickname: "לוסי",
      email: null,
      phone: null,
      model: "gpt-4.1",
      temperature: 0.2,
      instructions: "Lucy DB prompt for inherit",
      createdAt: new Date(),
    });

    const loginResponse = await request(app)
      .post("/api/auth/login")
      .send({ username: "Amit", password: PASSWORD });

    const response = await request(app)
      .get("/api/employees/digital-defaults")
      .set("Cookie", cookieHeader(loginResponse));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      model: "gpt-4.1",
      temperature: 0.2,
      instructions: "Lucy DB prompt for inherit",
    });
  });

  it("returns saved records for an owned employee", async () => {
    const employeeId = "415ff13e-38d0-4dee-98b5-71e5dd11a38d";
    const createdAt = new Date("2026-09-13T07:00:00.000Z");
    findUnique.mockResolvedValue({
      id: userId,
      username: "Amit",
      passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
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
    listFindMany.mockResolvedValue([
      {
        listType: "tasks",
        name: "",
        employee: { name: "עמית", nickname: "עמית" },
        items: [
          {
            id: "task-1",
            itemKey: "לקרוא ספר",
            data: { "שם מטלה": "לקרוא ספר" },
            addedById: employeeId,
            createdAt,
          },
        ],
      },
    ]);
    findMany.mockResolvedValue([
      { id: employeeId, name: "עמית", nickname: "עמית" },
    ]);

    const loginResponse = await request(app)
      .post("/api/auth/login")
      .send({ username: "Amit", password: PASSWORD });

    const response = await request(app)
      .get(`/api/employees/${employeeId}/records`)
      .set("Cookie", cookieHeader(loginResponse));

    expect(response.status).toBe(200);
    expect(response.body.groups[0].title).toBe("Tasks");
    expect(response.body.groups[0].items[0]).toMatchObject({
      title: "לקרוא ספר",
      createdBy: "עמית",
    });
  });
});
