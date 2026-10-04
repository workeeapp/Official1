import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

describe("public SPA from API", () => {
  let distDir: string;
  let previousDist: string | undefined;

  beforeEach(() => {
    distDir = mkdtempSync(path.join(tmpdir(), "workee-spa-"));
    writeFileSync(
      path.join(distDir, "index.html"),
      "<!doctype html><title>Workee</title><div id=\"root\"></div>",
      "utf8",
    );
    writeFileSync(path.join(distDir, "asset.txt"), "static-ok", "utf8");
    previousDist = process.env.FRONTEND_DIST;
    process.env.FRONTEND_DIST = distDir;
  });

  afterEach(() => {
    if (previousDist === undefined) {
      delete process.env.FRONTEND_DIST;
    } else {
      process.env.FRONTEND_DIST = previousDist;
    }
    rmSync(distDir, { recursive: true, force: true });
  });

  it("serves static assets and SPA fallback for client routes", async () => {
    const app = createApp();

    const asset = await request(app).get("/asset.txt");
    expect(asset.status).toBe(200);
    expect(asset.text).toBe("static-ok");

    const spa = await request(app).get("/chat");
    expect(spa.status).toBe(200);
    expect(spa.text).toContain("Workee");
    expect(spa.text).toContain('id="root"');

    const home = await request(app).get("/");
    expect(home.status).toBe(200);
    expect(home.text).toContain("Workee");
  });

  it("keeps /api 404 JSON when the route is missing", async () => {
    const app = createApp();
    const response = await request(app).get("/api/no-such-route");
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
