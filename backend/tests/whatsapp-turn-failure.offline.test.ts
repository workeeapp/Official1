/**
 * Regression (Tal, 2026-11-04): WhatsApp «שעה לפני» reached the server, the
 * turn failed before the model replied, and the speaker got silence. Contract:
 * on a proven failure before any reply, the engine sends a short notice.
 * Also: OpenAI context-window overflow must trigger conversation rotation.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WHATSAPP_TURN_FAILED_NOTICE,
  handleWhatsAppTurnFailure,
} from "../src/services/whatsapp.service.js";
import { isContextTooLargeError } from "../src/utils/errors.js";

describe("handleWhatsAppTurnFailure", () => {
  it("failure before any reply → sends the notice (no silence)", async () => {
    const send = vi.fn().mockResolvedValue("sent");
    const out = await handleWhatsAppTurnFailure({
      from: "972544365812",
      error: new Error("boom"),
      turnAnswered: false,
      send,
    });
    expect(out).toBe("sent_notice");
    expect(send).toHaveBeenCalledWith("972544365812", WHATSAPP_TURN_FAILED_NOTICE, {
      ignoreSession: true,
    });
  });

  it("failure after the model replied → no second message", async () => {
    const send = vi.fn().mockResolvedValue("sent");
    const out = await handleWhatsAppTurnFailure({
      from: "972544365812",
      error: new Error("attachment delivery failed"),
      turnAnswered: true,
      send,
    });
    expect(out).toBe("skipped");
    expect(send).not.toHaveBeenCalled();
  });

  it("a failing notice send never throws", async () => {
    const send = vi.fn().mockRejectedValue(new Error("network"));
    await expect(
      handleWhatsAppTurnFailure({
        from: "972544365812",
        error: new Error("boom"),
        turnAnswered: false,
        send,
      }),
    ).resolves.toBe("sent_notice");
  });
});

describe("isContextTooLargeError", () => {
  it("detects OpenAI context_length_exceeded by error code", () => {
    const top = Object.assign(new Error("400 Your input exceeds the context window"), {
      code: "context_length_exceeded",
    });
    const nested = Object.assign(new Error("400"), {
      error: { code: "context_length_exceeded" },
    });
    expect(isContextTooLargeError(top)).toBe(true);
    expect(isContextTooLargeError(nested)).toBe(true);
  });

  it("keeps the legacy request-too-large / TPM detection", () => {
    expect(isContextTooLargeError(new Error("Request too large for gpt"))).toBe(true);
    expect(isContextTooLargeError(new Error("Limit tokens per min (TPM): 30000"))).toBe(true);
  });

  it("does not treat other errors as overflow", () => {
    expect(isContextTooLargeError(new Error("ECONNRESET"))).toBe(false);
    expect(
      isContextTooLargeError(Object.assign(new Error("400"), { code: "invalid_request_error" })),
    ).toBe(false);
  });
});
