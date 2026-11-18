/**
 * O11 — invite-continuation WhatsApp via DeliveryAttempt ledger.
 * Deterministic sourceKey `invite:${inviteId}`; never auto-resend accepted|unknown|sending.
 */
import {
  claimDeliverySend,
  completeDeliveryAttempt,
} from "./delivery-attempt.service.js";
import { sendWhatsAppText } from "./whatsapp-send.js";

export async function deliverO11WhatsApp(input: {
  userId: string;
  inviteId: string;
  destination: string;
  purpose: "o11_guest" | "o11_asker";
  text: string;
}): Promise<void> {
  let attemptId: string | null = null;
  try {
    const claim = await claimDeliverySend({
      userId: input.userId,
      sourceKey: `invite:${input.inviteId}`,
      destination: input.destination,
      purpose: input.purpose,
    });
    attemptId = claim.attemptId;
    if (!claim.maySend) {
      return;
    }
  } catch {
    // Ledger unavailable — fall through to direct send.
  }
  try {
    const result = await sendWhatsAppText(input.destination, input.text, {
      ignoreSession: true,
    });
    if (attemptId) {
      await completeDeliveryAttempt({
        attemptId,
        status: result === "sent" ? "accepted" : "failed",
        lastError: result === "sent" ? null : String(result),
      });
    }
  } catch (error) {
    if (attemptId) {
      await completeDeliveryAttempt({
        attemptId,
        status: "unknown",
        lastError: error instanceof Error ? error.message : "unknown",
      });
    }
  }
}
