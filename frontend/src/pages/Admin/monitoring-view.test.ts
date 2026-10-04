import { describe, expect, it } from "vitest";
import { buildMonitoringView } from "./monitoring-view";

describe("buildMonitoringView", () => {
  it("marks healthy when db is up and no failures", () => {
    const view = buildMonitoringView({
      health: {
        status: "ok",
        db: true,
        openaiConfigured: true,
        whatsappConfigured: true,
        opsAlertConfigured: true,
        opsAlertMode: "off",
      },
      failuresLastHour: 0,
      recentFailures: [],
    });
    expect(view.level).toBe("healthy");
    expect(view.headline).toMatch(/healthy/i);
  });

  it("explains OpenAI credit failures in plain language", () => {
    const view = buildMonitoringView({
      health: {
        status: "ok",
        db: true,
        openaiConfigured: true,
        whatsappConfigured: true,
        opsAlertConfigured: true,
        opsAlertMode: "off",
      },
      failuresLastHour: 2,
      recentFailures: [
        {
          at: "2026-10-04T06:00:00.000Z",
          step: "chat_failed",
          detail: "429 You have no credits remaining",
          alertKey: "llm_credits",
        },
      ],
    });
    expect(view.level).toBe("attention");
    expect(view.failures[0]?.title).toMatch(/billing|rate limit/i);
    expect(view.failures[0]?.severity).toBe("attention");
    expect(view.subline).toMatch(/OpenAI credits/i);
  });

  it("does not mark Last hour Down for allow-list noise alone", () => {
    const view = buildMonitoringView({
      health: {
        status: "ok",
        db: true,
        openaiConfigured: true,
        whatsappConfigured: true,
        opsAlertConfigured: true,
        opsAlertMode: "off",
      },
      failuresLastHour: 9,
      recentFailures: [
        {
          at: "2026-10-04T06:00:00.000Z",
          step: "send_fail",
          detail:
            "status=400 code=131030 Recipient phone number not in allowed list",
          alertKey: "whatsapp_send",
        },
      ],
    });
    const recent = view.checks.find((row) => row.id === "recent");
    expect(recent?.state).toBe("warn");
    expect(recent?.badge).toBe("Check");
    expect(recent?.badge).not.toBe("Down");
    expect(view.headline).toMatch(/minor config/i);
    expect(view.failures[0]?.severity).toBe("noise");
  });

  it("explains generic 503 chat failures as incomplete older logs", () => {
    const view = buildMonitoringView({
      health: {
        status: "ok",
        db: true,
        openaiConfigured: true,
        whatsappConfigured: true,
        opsAlertConfigured: true,
        opsAlertMode: "off",
      },
      failuresLastHour: 1,
      recentFailures: [
        {
          at: "2026-10-04T06:00:00.000Z",
          step: "chat_failed",
          detail: "Service temporarily unavailable. Please try again later.",
          alertKey: "chat_llm",
        },
      ],
    });
    expect(view.failures[0]?.meaning).toMatch(/older event|generic 503/i);
  });
});
