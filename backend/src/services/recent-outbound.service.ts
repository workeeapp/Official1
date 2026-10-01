import { isMissingTableError } from "../utils/errors.js";
import { prisma } from "../database/prisma.js";
import { formatJerusalemDateTime } from "./reminder.service.js";

export const RECENT_OUTBOUND_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const RECENT_OUTBOUND_LIMIT = 1;

export interface RecentOutboundRow {
  sent_at: string;
  item: string;
  text: string;
}

function pingIncludes(pingIds: unknown, employeeId: string): boolean {
  if (!Array.isArray(pingIds)) {
    return false;
  }
  return pingIds.map(String).includes(employeeId);
}

/**
 * Reminder/scheduled WhatsApp bodies already delivered to this human.
 * Used so the model can answer «לגבי מה ששלחת» without re-sending.
 */
export async function listRecentReminderOutbounds(input: {
  userId: string;
  employeeId: string;
  now?: Date;
  windowMs?: number;
  limit?: number;
}): Promise<RecentOutboundRow[]> {
  if (!prisma.reminder) {
    return [];
  }
  const now = input.now ?? new Date();
  const windowMs = input.windowMs ?? RECENT_OUTBOUND_WINDOW_MS;
  const limit = Math.min(Math.max(input.limit ?? RECENT_OUTBOUND_LIMIT, 1), 10);
  const since = new Date(now.getTime() - windowMs);

  let rows;
  try {
    rows = await prisma.reminder.findMany({
      where: {
        userId: input.userId,
        sendStatus: "sent",
        sentAt: { gte: since },
      },
      orderBy: { sentAt: "desc" },
      take: 40,
      select: {
        itemLabel: true,
        messageText: true,
        lastComposedText: true,
        pingIds: true,
        sentAt: true,
      },
    });
  } catch (error) {
    if (isMissingTableError(error)) {
      return [];
    }
    throw error;
  }

  const out: RecentOutboundRow[] = [];
  for (const row of rows) {
    if (!pingIncludes(row.pingIds, input.employeeId) || !row.sentAt) {
      continue;
    }
    const text = (row.lastComposedText || row.messageText || "").trim();
    if (!text) {
      continue;
    }
    out.push({
      sent_at: formatJerusalemDateTime(row.sentAt),
      item: row.itemLabel,
      text: text.slice(0, 4000),
    });
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

export function formatRecentOutboundContext(
  rows: RecentOutboundRow[],
): string {
  if (rows.length === 0) {
    return "";
  }
  return [
    "RECENT_OUTBOUND:",
    "Messages YOU already sent to this speaker via scheduled reminders (WhatsApp / clock fire). Only the latest delivery is listed. When they refer to מה ששלחת / הסיכום / ההודעה האחרונה, answer from this text. Do NOT resend unless they explicitly ask to send again.",
    JSON.stringify(rows),
  ].join("\n");
}
