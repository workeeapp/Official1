import { prisma } from "../database/prisma.js";

export type AuditAction =
  | "list_add"
  | "list_update"
  | "list_remove"
  | "list_alter"
  | "list_delete"
  | "filing_add"
  | "filing_update"
  | "filing_remove"
  | "reminder_save"
  | "reminder_cancel"
  | "reminder_fire"
  | "job_open"
  | "job_answer"
  | "job_decline"
  | "job_counter"
  | "job_close";

export type MutationHistoryRow = {
  action: AuditAction | string;
  summary: string;
  at: string;
  entity_type: string;
  /** Display name of who performed the mutation, when known. */
  actor: string | null;
};

/** Mutations surfaced in report section "history" (14 days). */
const HISTORY_ACTIONS: AuditAction[] = [
  "list_add",
  "list_update",
  "list_remove",
  "list_alter",
  "list_delete",
  "filing_add",
  "filing_update",
  "filing_remove",
  "reminder_save",
  "reminder_cancel",
  "reminder_fire",
];

function formatAuditAt(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(value);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export async function recordAuditEvent(input: {
  userId: string;
  actorEmployeeId?: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  summary: string;
  detail?: unknown;
}): Promise<void> {
  if (!prisma.auditEvent?.create) {
    return;
  }
  try {
    await prisma.auditEvent.create({
      data: {
        userId: input.userId,
        actorEmployeeId: input.actorEmployeeId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        summary: input.summary.slice(0, 500),
        detail:
          input.detail === undefined
            ? undefined
            : (input.detail as object),
      },
    });
  } catch (error) {
    console.error(
      "Audit log write failed",
      error instanceof Error ? error.message : "unknown",
    );
  }
}

/** Recent mutations for report section "history" (14 days), with actor names. */
export async function listRecentMutationHistory(
  userId: string,
): Promise<MutationHistoryRow[]> {
  if (!prisma.auditEvent?.findMany) {
    return [];
  }
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  try {
    const rows = await prisma.auditEvent.findMany({
      where: {
        userId,
        createdAt: { gte: since },
        action: { in: HISTORY_ACTIONS },
      },
      orderBy: { createdAt: "desc" },
      take: 60,
    });
    const actorIds = [
      ...new Set(
        rows
          .map((row) => row.actorEmployeeId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const actors =
      actorIds.length > 0 && prisma.employee?.findMany
        ? await prisma.employee.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, name: true, nickname: true },
          })
        : [];
    const actorNames = new Map(
      actors.map((person) => [
        person.id,
        person.nickname?.trim() || person.name,
      ]),
    );
    return rows.map((row) => ({
      action: row.action,
      summary: row.summary,
      at: formatAuditAt(row.createdAt),
      entity_type: row.entityType,
      actor: row.actorEmployeeId
        ? (actorNames.get(row.actorEmployeeId) ?? null)
        : null,
    }));
  } catch (error) {
    console.error(
      "Audit history read failed",
      error instanceof Error ? error.message : "unknown",
    );
    return [];
  }
}
