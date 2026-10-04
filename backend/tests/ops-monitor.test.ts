import { describe, expect, it } from "vitest";
import {
  isCriticalSystemFailure,
  isNonAlertableOpsDetail,
  isOpsFailureStep,
  opsAlertKey,
  shouldWhatsAppAlertFailure,
} from "../src/services/ops-monitor.service.js";

describe("ops monitor helpers", () => {
  it("treats chat_failed and send_fail as failures", () => {
    expect(isOpsFailureStep("chat_failed")).toBe(true);
    expect(isOpsFailureStep("send_fail")).toBe(true);
    expect(isOpsFailureStep("reply_failed")).toBe(true);
  });

  it("ignores normal flow steps and ops_* recursion", () => {
    expect(isOpsFailureStep("webhook_post")).toBe(false);
    expect(isOpsFailureStep("inbound_text")).toBe(false);
    expect(isOpsFailureStep("ops_alert_sent")).toBe(false);
    expect(isOpsFailureStep("ops_alert_failed")).toBe(false);
  });

  it("groups OpenAI credit errors under llm_credits", () => {
    expect(
      opsAlertKey(
        "chat_failed",
        "429 You have no credits remaining. Add credits…",
      ),
    ).toBe("llm_credits");
  });

  it("collapses reply_failed with chat failures under chat_llm", () => {
    expect(opsAlertKey("reply_failed", "Service temporarily unavailable")).toBe(
      "chat_llm",
    );
  });

  it("does not WhatsApp-alert Meta allow-list errors", () => {
    expect(
      isNonAlertableOpsDetail(
        "status=400 code=131030 Recipient phone number not in allowed list",
      ),
    ).toBe(true);
    expect(isNonAlertableOpsDetail("status=500 upstream")).toBe(false);
  });

  it("classifies DB outages as critical system failures", () => {
    expect(isCriticalSystemFailure("system_db_down", "P1001")).toBe(true);
    expect(isCriticalSystemFailure("chat_failed", "429 credits")).toBe(false);
  });

  it("gates WhatsApp alerts by OPS_ALERT_MODE", () => {
    expect(
      shouldWhatsAppAlertFailure("chat_failed", "boom", "off"),
    ).toBe(false);
    expect(
      shouldWhatsAppAlertFailure("chat_failed", "boom", "critical"),
    ).toBe(false);
    expect(
      shouldWhatsAppAlertFailure("system_db_down", "P1001", "critical"),
    ).toBe(true);
    expect(
      shouldWhatsAppAlertFailure("chat_failed", "boom", "all"),
    ).toBe(true);
    expect(
      shouldWhatsAppAlertFailure(
        "send_fail",
        "131030 not in allowed list",
        "all",
      ),
    ).toBe(false);
  });
});
