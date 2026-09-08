import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { hashPassword } from "../src/auth/password.js";

const { findUnique, findMany, create, findFirst, update, remove } = vi.hoisted(
  () => ({
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }),
);

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
    create.mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      userId,
      name: "Dana",
      surname: "Levi",
      nickname: "Dana",
      email: "dana@example.com",
      phone: "050-1111111",
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
    expect(response.body.employee.phone).toBe("050-1111111");
  });
});
