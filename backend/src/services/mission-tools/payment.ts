import { randomBytes } from "node:crypto";
import { recordAuditEvent } from "../audit.service.js";
import { useSecret } from "../mission-vault.js";
import type { MissionToolContext, MissionToolResult } from "./types.js";

type PreparedPayment = {
  prepareId: string;
  amount: number;
  currency: string;
  merchant: string;
  secretId: string;
  createdAt: number;
};

const prepared = new Map<string, PreparedPayment>();

export async function paymentPrepare(
  args: Record<string, unknown>,
  ctx: MissionToolContext,
): Promise<MissionToolResult> {
  const amount = Number(args.amount);
  const currency =
    typeof args.currency === "string" && args.currency.trim()
      ? args.currency.trim().toUpperCase()
      : "ILS";
  const merchant =
    typeof args.merchant === "string" ? args.merchant.trim() : "";
  const secretId =
    typeof args.secret_id === "string"
      ? args.secret_id.trim()
      : typeof args.secretId === "string"
        ? args.secretId.trim()
        : "";
  if (!Number.isFinite(amount) || amount <= 0 || !merchant || !secretId) {
    return {
      ok: false,
      summary: "payment.prepare requires amount, merchant, secret_id",
    };
  }
  // Validate vault ownership without exposing PAN to the model.
  await useSecret({
    userId: ctx.userId,
    speakerId: ctx.speakerId,
    secretId,
    actorEmployeeId: ctx.executorId,
  });
  const prepareId = randomBytes(8).toString("hex");
  prepared.set(prepareId, {
    prepareId,
    amount,
    currency,
    merchant,
    secretId,
    createdAt: Date.now(),
  });
  await recordAuditEvent({
    userId: ctx.userId,
    actorEmployeeId: ctx.executorId,
    action: "payment_prepare",
    entityType: "Mission",
    entityId: ctx.missionId,
    summary: `Prepared charge ${amount} ${currency} at ${merchant}`,
    detail: { prepareId, amount, currency, merchant },
  });
  return {
    ok: true,
    summary: `Prepared ${amount} ${currency} to ${merchant} (awaiting approval to charge)`,
    data: { prepare_id: prepareId, amount, currency, merchant },
  };
}

export async function paymentCharge(
  args: Record<string, unknown>,
  ctx: MissionToolContext,
): Promise<MissionToolResult> {
  const prepareId =
    typeof args.prepare_id === "string"
      ? args.prepare_id.trim()
      : typeof args.prepareId === "string"
        ? args.prepareId.trim()
        : "";
  const row = prepareId ? prepared.get(prepareId) : undefined;
  if (!row) {
    return {
      ok: false,
      summary: "payment.charge requires a valid prepare_id from payment.prepare",
    };
  }
  // Cart expiry (~30 min)
  if (Date.now() - row.createdAt > 30 * 60 * 1000) {
    prepared.delete(prepareId);
    return {
      ok: false,
      summary: "Prepared payment expired — run payment.prepare again",
    };
  }
  await useSecret({
    userId: ctx.userId,
    speakerId: ctx.speakerId,
    secretId: row.secretId,
    actorEmployeeId: ctx.executorId,
  });
  const orderId = `POC-${randomBytes(4).toString("hex").toUpperCase()}`;
  prepared.delete(prepareId);
  await recordAuditEvent({
    userId: ctx.userId,
    actorEmployeeId: ctx.executorId,
    action: "payment_charge",
    entityType: "Mission",
    entityId: ctx.missionId,
    summary: `Charged ${row.amount} ${row.currency} at ${row.merchant} (${orderId})`,
    detail: {
      prepareId,
      amount: row.amount,
      currency: row.currency,
      merchant: row.merchant,
      orderId,
      simulated: true,
    },
  });
  return {
    ok: true,
    summary: `Charged ${row.amount} ${row.currency} at ${row.merchant}. Order ${orderId}`,
    data: {
      order_id: orderId,
      amount: row.amount,
      currency: row.currency,
      merchant: row.merchant,
    },
    evidenceAttachmentIds: [],
  };
}

export function invalidatePreparedPayments(): void {
  prepared.clear();
}
