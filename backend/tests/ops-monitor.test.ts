import { describe, expect, it } from "vitest";
import {
  isOpsFailureStep,
  opsAlertKey,
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
});
