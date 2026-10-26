import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { hashPassword } from "../src/auth/password.js";

const {
  userFindUnique,
  teamFindUnique,
  teamCreate,
  employeeCreate,
  employeeFindFirst,
} = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  teamFindUnique: vi.fn(),
  teamCreate: vi.fn(),
  employeeCreate: vi.fn(),
  employeeFindFirst: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    user: {
      findUnique: userFindUnique,
    },
    team: {
      findUnique: teamFindUnique,
      create: teamCreate,
    },
    employee: {
      create: employeeCreate,
      findFirst: employeeFindFirst,
    },
  },
}));

import { createApp } from "../src/app.js";
import { createEmployeeForUser } from "../src/services/employee.service.js";

const PASSWORD = "ChangeMe123!";
const userId = "11111111-1111-4111-8111-111111111111";
const teamId = "22222222-2222-4222-8222-222222222222";

let passwordHash: string;
let app: ReturnType<typeof createApp>;

function cookieHeader(response: request.Response): string {
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return values.join("; ");
}

describe("team API and membership", () => {
  beforeEach(async () => {
    passwordHash ??= await hashPassword(PASSWORD);
    userFindUnique.mockReset();
    teamFindUnique.mockReset();
    teamCreate.mockReset();
    employeeCreate.mockReset();
    employeeFindFirst.mockReset().mockResolvedValue(null);
    app = createApp();
  });

  it("rejects unauthenticated GET /api/team", async () => {
    const response = await request(app).get("/api/team");
    expect(response.status).toBe(401);
  });

  it("returns the account team, creating it when missing", async () => {
    userFindUnique.mockResolvedValue({
      id: userId,
      username: "Amit",
      passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    teamFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: teamId,
        userId,
        name: "Amit",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    teamCreate.mockResolvedValue({
      id: teamId,
      userId,
      name: "Amit",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const loginResponse = await request(app)
      .post("/api/auth/login")
      .send({ username: "Amit", password: PASSWORD });

    const response = await request(app)
      .get("/api/team")
      .set("Cookie", cookieHeader(loginResponse));

    expect(response.status).toBe(200);
    expect(response.body.team).toEqual({
      id: teamId,
      userId,
      name: "Amit",
    });
    expect(teamCreate).toHaveBeenCalledWith({
      data: { userId, name: "Amit" },
    });
  });

  it("assigns non-guest creates to the team", async () => {
    teamFindUnique.mockResolvedValue({
      id: teamId,
      userId,
      name: "Amit",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    employeeCreate.mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      userId,
      teamId,
      kind: "human",
      name: "Dana",
      surname: "Levi",
      nickname: "Dana",
      email: null,
      phone: null,
      model: null,
      temperature: null,
      reasoningEffort: null,
      instructions: null,
      isProtected: false,
      isOwner: false,
      isGuest: false,
      addressGender: null,
      shareMirrorEmployeeId: null,
      createdAt: new Date(),
    });

    const employee = await createEmployeeForUser(userId, {
      kind: "human",
      name: "Dana",
      surname: "Levi",
    });

    expect(employee.isGuest).toBe(false);
    expect(employee.teamId).toBe(teamId);
    expect(employeeCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        teamId,
        isGuest: false,
      }),
    });
  });

  it("creates WhatsApp guests with isGuest and no team", async () => {
    employeeCreate.mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      userId,
      teamId: null,
      kind: "human",
      name: "אורח",
      surname: "",
      nickname: "אורח …1495",
      email: null,
      phone: "972501234567",
      model: null,
      temperature: null,
      reasoningEffort: null,
      instructions: null,
      isProtected: false,
      isOwner: false,
      isGuest: true,
      addressGender: null,
      shareMirrorEmployeeId: null,
      createdAt: new Date(),
    });

    const employee = await createEmployeeForUser(
      userId,
      {
        kind: "human",
        name: "אורח",
        surname: "",
        nickname: "אורח …1495",
        phone: "972501234567",
      },
      { isGuest: true },
    );

    expect(employee.isGuest).toBe(true);
    expect(employee.teamId).toBeNull();
    expect(teamFindUnique).not.toHaveBeenCalled();
    expect(employeeCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        teamId: null,
        isGuest: true,
      }),
    });
  });
});
