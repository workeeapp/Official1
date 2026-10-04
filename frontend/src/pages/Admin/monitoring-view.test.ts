import { describe, expect, it } from "vitest";
import { buildMonitoringView } from "./monitoring-view";

const NOW = Date.parse("2026-10-04T10:00:00.000Z");

describe("buildMonitoringView", () => {
  it("marks healthy when db is up and no failures", () => {
    const view = buildMonitoringView(
      {
        health: {
          status: "ok",
          db: true,
          openaiConfigured: true,
          whatsappConfigured: true,
          opsAlertConfigured: true,
          opsAlertMode: "off",
        },
        failuresLastHour: 0,
        statusLookbackMinutes: 60,
        recentFailures: [],
      },
      NOW,
    );
    expect(view.level).toBe("healthy");
    expect(view.headline).toMatch(/healthy/i);
  });

  it("explains OpenAI credit failures in plain language", () => {
    const view = buildMonitoringView(
      {
        health: {
          status: "ok",
          db: true,
          openaiConfigured: true,
          whatsappConfigured: true,
          opsAlertConfigured: true,
          opsAlertMode: "off",
        },
        failuresLastHour: 2,
        statusLookbackMinutes: 60,
        recentFailures: [
          {
            at: "2026-10-04T09:30:00.000Z",
            step: "chat_failed",
            detail: "429 You have no credits remaining",
            alertKey: "llm_credits",
          },
        ],
      },
      NOW,
    );
    expect(view.level).toBe("attention");
    expect(view.failures[0]?.title).toMatch(/billing|rate limit/i);
    expect(view.failures[0]?.severity).toBe("attention");
    expect(view.subline).toMatch(/OpenAI credits/i);
  });

  it("does not mark Last hour Down for allow-list noise alone", () => {
    const view = buildMonitoringView(
      {
        health: {
          status: "ok",
          db: true,
          openaiConfigured: true,
          whatsappConfigured: true,
          opsAlertConfigured: true,
          opsAlertMode: "off",
        },
        failuresLastHour: 9,
        statusLookbackMinutes: 60,
        recentFailures: [
          {
            at: "2026-10-04T09:30:00.000Z",
            step: "send_fail",
            detail:
              "status=400 code=131030 Recipient phone number not in allowed list",
            alertKey: "whatsapp_send",
          },
        ],
      },
      NOW,
    );
    const recent = view.checks.find((row) => row.id === "recent");
    expect(recent?.state).toBe("warn");
    expect(recent?.badge).toBe("Check");
    expect(recent?.badge).not.toBe("Down");
    expect(view.headline).toMatch(/minor config/i);
    expect(view.failures[0]?.severity).toBe("noise");
  });

  it("clears WhatsApp Check when allow-list noise is older than lookback", () => {
    const view = buildMonitoringView(
      {
        health: {
          status: "ok",
          db: true,
          openaiConfigured: true,
          whatsappConfigured: true,
          opsAlertConfigured: true,
          opsAlertMode: "off",
        },
        failuresLastHour: 0,
        statusLookbackMinutes: 60,
        recentFailures: [
          {
            at: "2026-10-04T08:00:00.000Z",
            step: "send_fail",
            detail:
              "status=400 code=131030 Recipient phone number not in allowed list",
            alertKey: "whatsapp_send",
          },
        ],
      },
      NOW,
    );
    const whatsapp = view.checks.find((row) => row.id === "whatsapp");
    expect(whatsapp?.state).toBe("ok");
    expect(whatsapp?.badge).toBe("OK");
    expect(view.level).toBe("healthy");
    expect(view.failures).toHaveLength(1);
  });

  it("respects a custom statusLookbackMinutes window", () => {
    const view = buildMonitoringView(
      {
        health: {
          status: "ok",
          db: true,
          openaiConfigured: true,
          whatsappConfigured: true,
          opsAlertConfigured: true,
          opsAlertMode: "off",
        },
        failuresLastHour: 1,
        statusLookbackMinutes: 180,
        recentFailures: [
          {
            at: "2026-10-04T08:00:00.000Z",
            step: "send_fail",
            detail:
              "status=400 code=131030 Recipient phone number not in allowed list",
            alertKey: "whatsapp_send",
          },
        ],
      },
      NOW,
    );
    const whatsapp = view.checks.find((row) => row.id === "whatsapp");
    expect(whatsapp?.state).toBe("warn");
    expect(view.checks.find((row) => row.id === "recent")?.label).toBe(
      "Last 180 min",
    );
  });

  it("explains generic 503 chat failures as incomplete older logs", () => {
    const view = buildMonitoringView(
      {
        health: {
          status: "ok",
          db: true,
          openaiConfigured: true,
          whatsappConfigured: true,
          opsAlertConfigured: true,
          opsAlertMode: "off",
        },
        failuresLastHour: 1,
        statusLookbackMinutes: 60,
        recentFailures: [
          {
            at: "2026-10-04T09:30:00.000Z",
            step: "chat_failed",
            detail: "Service temporarily unavailable. Please try again later.",
            alertKey: "chat_llm",
          },
        ],
      },
      NOW,
    );
    expect(view.failures[0]?.meaning).toMatch(/older event|generic 503/i);
  });
});
