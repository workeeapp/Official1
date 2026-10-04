import { describe, expect, it } from "vitest";
import { buildCiView } from "./ci-view";

describe("buildCiView", () => {
  it("explains missing token as not configured", () => {
    const view = buildCiView({
      configured: false,
      branch: "main",
      workflow: "Test",
      repo: null,
      latest: null,
      jobs: [],
      recentRuns: [],
    });
    expect(view.level).toBe("idle");
    expect(view.headline).toMatch(/not configured/i);
  });

  it("marks healthy when all package jobs passed", () => {
    const view = buildCiView({
      configured: true,
      branch: "main",
      workflow: "Test",
      repo: "workeeapp/Official1",
      latest: {
        id: 1,
        status: "completed",
        conclusion: "success",
        event: "push",
        headSha: "abc1234",
        htmlUrl: "https://example.com/run/1",
        startedAt: "2026-10-04T07:22:00.000Z",
        updatedAt: "2026-10-04T07:22:44.000Z",
      },
      jobs: [
        {
          name: "shared",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://example.com/shared",
        },
        {
          name: "backend",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://example.com/backend",
        },
        {
          name: "frontend",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://example.com/frontend",
        },
      ],
      recentRuns: [],
    });
    expect(view.level).toBe("healthy");
    expect(view.checks.every((row) => row.badge === "Pass")).toBe(true);
  });

  it("marks critical when a package job failed", () => {
    const view = buildCiView({
      configured: true,
      branch: "main",
      workflow: "Test",
      repo: "workeeapp/Official1",
      latest: {
        id: 2,
        status: "completed",
        conclusion: "failure",
        event: "push",
        headSha: "deadbeef",
        htmlUrl: "https://example.com/run/2",
        startedAt: null,
        updatedAt: "2026-10-04T08:00:00.000Z",
      },
      jobs: [
        {
          name: "shared",
          status: "completed",
          conclusion: "success",
          htmlUrl: "",
        },
        {
          name: "backend",
          status: "completed",
          conclusion: "failure",
          htmlUrl: "",
        },
        {
          name: "frontend",
          status: "completed",
          conclusion: "success",
          htmlUrl: "",
        },
      ],
      recentRuns: [],
    });
    expect(view.level).toBe("critical");
    expect(view.checks.find((row) => row.id === "backend")?.badge).toBe("Fail");
  });
});
