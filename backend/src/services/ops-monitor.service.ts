import type { WhatsAppFlowEvent } from "@workee/shared";
import { getEnv } from "../config/env.js";
import { prisma } from "../database/prisma.js";
import { normalizePhoneDigits } from "../utils/phone.js";

const FAILURE_STEP_RE =
  /(fail|error|unavailable|mismatch|denied|timeout)/i;

/** Steps we emit while alerting — never re-alert on these. */
const OPS_STEP_PREFIX = "ops_";

export function isOpsFailureStep(step: string): boolean {
  const trimmed = step.trim();
  if (!trimmed || trimmed.startsWith(OPS_STEP_PREFIX)) {
    return false;
  }
  return FAILURE_STEP_RE.test(trimmed);
}

export function opsAlertKey(step: string, detail = ""): string {
  const blob = `${step} ${detail}`.trim().toLowerCase();
  if (blob.includes("credit") || blob.includes("429")) {
    return "llm_credits";
  }
  // One chat outage often logs chat_failed + reply_failed — same alert.
  if (
    blob.includes("chat_") ||
    blob.includes("llm") ||
    step.trim().toLowerCase() === "reply_failed"
  ) {
    return "chat_llm";
  }
  if (blob.includes("send")) {
    return "whatsapp_send";
  }
  return step.trim().toLowerCase().slice(0, 64) || "unknown";
}

/** Meta sandbox / allow-list — real for that number, not an app outage. */
export function isNonAlertableOpsDetail(detail: string): boolean {
  const blob = detail.toLowerCase();
  return (
    blob.includes("131030") ||
    blob.includes("not in allowed list") ||
    blob.includes("recipient phone number not in")
  );
}

function alertPhones(): string[] {
  const raw = getEnv().OPS_ALERT_PHONES?.trim() ?? "";
  if (!raw) {
    return [];
  }
  return [
    ...new Set(
      raw
        .split(/[,;\s]+/)
        .map((row) => normalizePhoneDigits(row))
        .filter((row) => row.length >= 8),
    ),
  ];
}

function cooldownMs(): number {
  const minutes = getEnv().OPS_ALERT_COOLDOWN_MINUTES ?? 30;
  return Math.max(1, minutes) * 60_000;
}

/** Same-process guard — concurrent failures must not each claim+send. */
const alertingKeys = new Set<string>();

export async function listRecentOpsFailures(limit = 20): Promise<
  Array<{
    at: string;
    step: string;
    detail: string;
    alertKey: string;
  }>
> {
  if (!prisma.opsEvent?.findMany) {
    return [];
  }
  const rows = await prisma.opsEvent.findMany({
    where: { kind: "failure" },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(limit, 50)),
  });
  return rows.map((row) => ({
    at: row.createdAt.toISOString(),
    step: row.step,
    detail: row.detail,
    alertKey: row.alertKey,
  }));
}

export async function countRecentOpsFailures(withinMs: number): Promise<number> {
  if (!prisma.opsEvent?.count) {
    return 0;
  }
  const since = new Date(Date.now() - withinMs);
  return prisma.opsEvent.count({
    where: { kind: "failure", createdAt: { gte: since } },
  });
}

/**
 * Persist a failure and maybe WhatsApp-alert ops phones (rate-limited per alertKey).
 * Fire-and-forget from the flow logger — never throw to callers.
 */
export async function noteOpsFailure(event: WhatsAppFlowEvent): Promise<void> {
  if (!isOpsFailureStep(event.step)) {
    return;
  }
  const detail = event.detail.slice(0, 500);
  const alertKey = opsAlertKey(event.step, detail);

  if (prisma.opsEvent?.create) {
    try {
      await prisma.opsEvent.create({
        data: {
          kind: "failure",
          alertKey,
          step: event.step.slice(0, 64),
          detail,
        },
      });
    } catch {
      /* DB optional for logging path */
    }
  }

  if (isNonAlertableOpsDetail(detail)) {
    return;
  }

  await maybeSendOpsAlert({
    alertKey,
    step: event.step,
    detail,
    at: event.at,
  });
}

async function maybeSendOpsAlert(input: {
  alertKey: string;
  step: string;
  detail: string;
  at: string;
}): Promise<void> {
  const phones = alertPhones();
  if (phones.length === 0 || !prisma.opsEvent?.findFirst || !prisma.opsEvent?.create) {
    return;
  }

  if (alertingKeys.has(input.alertKey)) {
    return;
  }
  alertingKeys.add(input.alertKey);

  try {
  const since = new Date(Date.now() - cooldownMs());
  const recentAlert = await prisma.opsEvent.findFirst({
    where: {
      kind: "alert_sent",
      alertKey: input.alertKey,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
  });
  if (recentAlert) {
    return;
  }

  // Claim the cooldown slot BEFORE sending so concurrent failures cannot spam.
  try {
    await prisma.opsEvent.create({
      data: {
        kind: "alert_sent",
        alertKey: input.alertKey,
        step: "ops_alert_claim",
        detail: `claim key=${input.alertKey}`.slice(0, 500),
      },
    });
  } catch {
    return;
  }

  const hourCount = await countRecentOpsFailures(60 * 60 * 1000);
  const body = [
    "Workee ops alert",
    `step: ${input.step}`,
    input.detail ? `detail: ${input.detail}` : "",
    `failures last hour: ${hourCount}`,
    `at: ${input.at}`,
    "(App-level alert via Meta; does not cover full API downtime.)",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 900);

  // Dynamic import avoids whatsapp-send ↔ logger cycles.
  const { sendWhatsAppText } = await import("./whatsapp-send.js");
  const { recordWhatsAppEvent } = await import("./whatsapp-log.js");

  let sent = 0;
  for (const phone of phones) {
    try {
      const result = await sendWhatsAppText(phone, body, {
        ignoreSession: true,
        maxAttempts: 2,
        muteOps: true,
      });
      if (result === "sent") {
        sent += 1;
      }
    } catch {
      /* keep trying other phones */
    }
  }

  if (sent === 0) {
    recordWhatsAppEvent("ops_alert_failed", `key=${input.alertKey}`);
    return;
  }

  try {
    await prisma.opsEvent.create({
      data: {
        kind: "alert_sent",
        alertKey: input.alertKey,
        step: "ops_alert_sent",
        detail: `phones=${sent} key=${input.alertKey}`.slice(0, 500),
      },
    });
  } catch {
    /* ignore */
  }
  recordWhatsAppEvent("ops_alert_sent", `key=${input.alertKey} phones=${sent}`);
  } finally {
    alertingKeys.delete(input.alertKey);
  }
}
