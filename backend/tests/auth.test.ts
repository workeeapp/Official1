import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { hashPassword } from "../src/auth/password.js";

const { findUnique } = vi.hoisted(() => ({
  findUnique: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    user: {
      findUnique,
    },
  },
}));

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "../src/auth/session.js";

const PASSWORD = "ChangeMe123!";
const userId = "11111111-1111-4111-8111-111111111111";

let passwordHash: string;
let app: ReturnType<typeof createApp>;

function cookieHeader(response: request.Response): string {
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return values.join("; ");
}

describe("authentication API", () => {
  beforeEach(async () => {
    passwordHash ??= await hashPassword(PASSWORD);
    findUnique.mockReset();
    app = createApp();
  });

  it("logs in with valid credentials and sets an httpOnly session cookie", async () => {
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

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      user: { id: userId, username: "Amit" },
    });
    const setCookie = cookieHeader(response);
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie.toLowerCase()).toContain("httponly");
  });

  it("rejects an invalid username with a generic error", async () => {
    findUnique.mockResolvedValue(null);

    const response = await request(app)
      .post("/api/auth/login")
      .send({ username: "Unknown", password: PASSWORD });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe("Invalid username or password");
  });

  it("rejects an invalid password with a generic error", async () => {
    findUnique.mockResolvedValue({
      id: userId,
      username: "Amit",
      passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await request(app)
      .post("/api/auth/login")
      .send({ username: "Amit", password: "WrongPass1" });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe("Invalid username or password");
  });

  it("rejects a missing username", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .send({ password: PASSWORD });

    expect(response.status).toBe(400);
    expect(response.body.error.fields.username).toBe("Username is required");
    expect(response.body.error.fields.password).toBeUndefined();
  });

  it("rejects a missing password", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .send({ username: "Amit" });

    expect(response.status).toBe(400);
    expect(response.body.error.fields.password).toBe("Password is required");
    expect(response.body.error.fields.username).toBeUndefined();
  });

  it("rejects unauthenticated access to the current-user endpoint", async () => {
    const response = await request(app).get("/api/auth/me");
    expect(response.status).toBe(401);
  });

  it("returns the current user for an authenticated session", async () => {
    findUnique.mockResolvedValue({
      id: userId,
      username: "Amit",
      passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const loginResponse = await request(app)
      .post("/api/auth/login")
      .send({ username: "Amit", password: PASSWORD });

    const meResponse = await request(app)
      .get("/api/auth/me")
      .set("Cookie", cookieHeader(loginResponse));

    expect(meResponse.status).toBe(200);
    expect(meResponse.body).toEqual({
      user: { id: userId, username: "Amit" },
    });
  });

  it("invalidates the session on logout", async () => {
    findUnique.mockResolvedValue({
      id: userId,
      username: "Amit",
      passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const loginResponse = await request(app)
      .post("/api/auth/login")
      .send({ username: "Amit", password: PASSWORD });

    const logoutResponse = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", cookieHeader(loginResponse));

    expect(logoutResponse.status).toBe(200);

    const meResponse = await request(app)
      .get("/api/auth/me")
      .set("Cookie", cookieHeader(logoutResponse));

    expect(meResponse.status).toBe(401);
  });
});
