/**
 * Wave 1 Stage 2 — deterministic Prospect cost circuit breaker (pre-LLM).
 */
import { prisma } from "../database/prisma.js";
import { getEnv } from "../config/env.js";

/** Count inbound user messages for this account (trial hard cap). */
export async function countProspectInboundMessages(
  userId: string,
): Promise<number> {
  return prisma.chatMessage.count({
    where: {
      author: "user",
      conversation: { userId },
    },
  });
}

export async function prospectCircuitBreakerExceeded(
  userId: string,
): Promise<boolean> {
  const max = getEnv().PROSPECT_MAX_INBOUND_MESSAGES;
  const count = await countProspectInboundMessages(userId);
  return count >= max;
}
