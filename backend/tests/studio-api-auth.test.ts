/**
 * Studio API auth — requireAuth only. Mocks Prisma so createApp does not
 * touch a real database. Does not start eval runners.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
  },
}));

import { createApp } from "../src/app.js";

describe("Studio API auth (no eval runs)", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  it("GET /api/studio/safety returns 401 without session", async () => {
    const response = await request(app).get("/api/studio/safety");
    expect(response.status).toBe(401);
  });

  it("POST /api/studio/runs returns 401 without session", async () => {
    const response = await request(app)
      .post("/api/studio/runs")
      .send({ track: "LIVE_FULL" });
    expect(response.status).toBe(401);
  });

  it("GET /api/studio/tracks returns 401 without session", async () => {
    const response = await request(app).get("/api/studio/tracks");
    expect(response.status).toBe(401);
  });
});
