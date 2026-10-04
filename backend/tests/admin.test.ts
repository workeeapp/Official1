import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { hashPassword } from "../src/auth/password.js";

const {
  findUnique,
  findMany,
  count,
  update,
  queryRaw,
  opsFindMany,
  opsCount,
} = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
  queryRaw: vi.fn(),
  opsFindMany: vi.fn(),
  opsCount: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    user: { findUnique, findMany, count, update },
    $queryRaw: queryRaw,
    opsEvent: {
      findMany: opsFindMany,
      count: opsCount,
    },
  },
}));

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "../src/auth/session.js";
import {
  getAdminCodeChanges,
  getAdminMonitoring,
  listAdminUsers,
  setAdminUserFlag,
} from "../src/services/admin.service.js";
import { toPublicUser } from "../src/services/user.service.js";
import { ValidationError } from "../src/utils/errors.js";

const PASSWORD = "ChangeMe123!";
const userId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";

let passwordHash: string;
let app: ReturnType<typeof createApp>;

function cookieHeader(response: request.Response): string {
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return values.join("; ");
}

function userRow(isAdmin: boolean, id = userId, username = "Amit") {
  return {
    id,
    username,
    passwordHash,
    isAdmin,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("toPublicUser isAdmin", () => {
  it("exposes isAdmin and never the password hash", () => {
    expect(
      toPublicUser({
        id: userId,
        username: "Amit",
        passwordHash: "x",
        isAdmin: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).toEqual({ id: userId, username: "Amit", isAdmin: true });
  });
});

describe("admin monitoring service", () => {
  beforeEach(() => {
    queryRaw.mockReset().mockResolvedValue([{ "?column?": 1 }]);
    opsFindMany.mockReset().mockResolvedValue([
      {
        createdAt: new Date("2026-10-04T06:00:00.000Z"),
        step: "chat_failed",
        detail: "status=429 code=insufficient_quota no credits",
        alertKey: "llm_credits",
      },
    ]);
    opsCount.mockReset().mockResolvedValue(2);
  });

  it("returns health flags and recent durable failures", async () => {
    const result = await getAdminMonitoring();
    expect(result.health.db).toBe(true);
    expect(result.health.opsAlertMode).toMatch(/^(off|critical|all)$/);
    expect(result.failuresLastHour).toBe(2);
    expect(result.recentFailures[0]).toMatchObject({
      step: "chat_failed",
      alertKey: "llm_credits",
    });
    expect(result.recentFailures[0]?.detail).toContain("insufficient_quota");
  });
});

describe("admin code changes", () => {
  it("returns commits for a lookback window", async () => {
    const result = await getAdminCodeChanges(168);
    expect(result.lookbackHours).toBe(168);
    expect(result.headSha.length).toBeGreaterThan(7);
    expect(Array.isArray(result.commits)).toBe(true);
  });

  it("clamps lookback hours", async () => {
    const low = await getAdminCodeChanges(0);
    const high = await getAdminCodeChanges(10_000);
    expect(low.lookbackHours).toBe(1);
    expect(high.lookbackHours).toBe(720);
  });
});

describe("admin users service", () => {
  beforeEach(() => {
    findMany.mockReset();
    findUnique.mockReset();
    count.mockReset();
    update.mockReset();
  });

  it("lists login users with isAdmin", async () => {
    findMany.mockResolvedValue([
      { id: userId, username: "Amit", isAdmin: true },
      { id: otherId, username: "Tal", isAdmin: false },
    ]);
    await expect(listAdminUsers()).resolves.toEqual({
      users: [
        { id: userId, username: "Amit", isAdmin: true },
        { id: otherId, username: "Tal", isAdmin: false },
      ],
    });
  });

  it("grants admin", async () => {
    findUnique.mockResolvedValue({
      id: otherId,
      username: "Tal",
      isAdmin: false,
    });
    update.mockResolvedValue({
      id: otherId,
      username: "Tal",
      isAdmin: true,
    });
    await expect(setAdminUserFlag(otherId, true)).resolves.toEqual({
      user: { id: otherId, username: "Tal", isAdmin: true },
    });
  });

  it("refuses to revoke the last admin", async () => {
    findUnique.mockResolvedValue({
      id: userId,
      username: "Amit",
      isAdmin: true,
    });
    count.mockResolvedValue(1);
    await expect(setAdminUserFlag(userId, false)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(update).not.toHaveBeenCalled();
  });
});

describe("admin API auth gate", () => {
  beforeEach(async () => {
    passwordHash ??= await hashPassword(PASSWORD);
    findUnique.mockReset();
    findMany.mockReset().mockResolvedValue([]);
    count.mockReset().mockResolvedValue(0);
    update.mockReset();
    queryRaw.mockReset().mockResolvedValue([{ "?column?": 1 }]);
    opsFindMany.mockReset().mockResolvedValue([]);
    opsCount.mockReset().mockResolvedValue(0);
    app = createApp();
  });

  it("rejects unauthenticated monitoring", async () => {
    const response = await request(app).get("/api/admin/monitoring");
    expect(response.status).toBe(401);
  });

  it("rejects non-admin sessions with 403", async () => {
    findUnique.mockResolvedValue(userRow(false));
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "Amit", password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user.isAdmin).toBe(false);

    const response = await request(app)
      .get("/api/admin/monitoring")
      .set("Cookie", cookieHeader(login));
    expect(response.status).toBe(403);
  });

  it("allows admin monitoring, users, and code-changes", async () => {
    findUnique.mockResolvedValue(userRow(true));
    findMany.mockResolvedValue([
      { id: userId, username: "Amit", isAdmin: true },
    ]);
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "Amit", password: PASSWORD });
    expect(login.body.user.isAdmin).toBe(true);
    const cookie = cookieHeader(login);
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);

    const monitoring = await request(app)
      .get("/api/admin/monitoring")
      .set("Cookie", cookie);
    expect(monitoring.status).toBe(200);
    expect(monitoring.body.health).toMatchObject({ db: true });

    const users = await request(app)
      .get("/api/admin/users")
      .set("Cookie", cookie);
    expect(users.status).toBe(200);
    expect(users.body.users).toEqual([
      { id: userId, username: "Amit", isAdmin: true },
    ]);

    const code = await request(app)
      .get("/api/admin/code-changes?hours=24")
      .set("Cookie", cookie);
    expect(code.status).toBe(200);
    expect(code.body.lookbackHours).toBe(24);
  });

  it("patches another user to admin", async () => {
    findUnique.mockImplementation(async (args: { where: { id?: string; username?: string } }) => {
      if (args.where.username === "Amit" || args.where.id === userId) {
        return userRow(true);
      }
      if (args.where.id === otherId) {
        return { id: otherId, username: "Tal", isAdmin: false };
      }
      return null;
    });
    update.mockResolvedValue({
      id: otherId,
      username: "Tal",
      isAdmin: true,
    });

    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "Amit", password: PASSWORD });
    const response = await request(app)
      .patch(`/api/admin/users/${otherId}/admin`)
      .set("Cookie", cookieHeader(login))
      .send({ isAdmin: true });
    expect(response.status).toBe(200);
    expect(response.body.user).toEqual({
      id: otherId,
      username: "Tal",
      isAdmin: true,
    });
  });
});
