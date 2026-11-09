import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getEnv } from "../config/env.js";
import { prisma } from "../database/prisma.js";
import { recordAuditEvent } from "./audit.service.js";

const ALGO = "aes-256-gcm";

function vaultKey(): Buffer {
  const secret = getEnv().AUTH_SECRET;
  return createHash("sha256").update(`workee-vault:${secret}`).digest();
}

export function encryptSecretPayload(payload: unknown): {
  ciphertext: string;
  iv: string;
  authTag: string;
} {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, vaultKey(), iv);
  const plain = Buffer.from(JSON.stringify(payload), "utf8");
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decryptSecretPayload<T = unknown>(row: {
  ciphertext: string;
  iv: string;
  authTag: string;
}): T {
  const decipher = createDecipheriv(
    ALGO,
    vaultKey(),
    Buffer.from(row.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(row.authTag, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(dec.toString("utf8")) as T;
}

export type VaultKind = "login" | "payment";

export async function storeSecret(input: {
  userId: string;
  speakerId: string;
  kind: VaultKind;
  label: string;
  site?: string;
  payload: unknown;
  actorEmployeeId?: string | null;
}): Promise<{ secretId: string; label: string; site: string; kind: string }> {
  const sealed = encryptSecretPayload(input.payload);
  const row = await prisma.secretVault.create({
    data: {
      userId: input.userId,
      speakerId: input.speakerId,
      kind: input.kind,
      label: input.label.trim().slice(0, 120) || input.kind,
      site: (input.site ?? "").trim().slice(0, 255),
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      authTag: sealed.authTag,
    },
  });
  await recordAuditEvent({
    userId: input.userId,
    actorEmployeeId: input.actorEmployeeId ?? input.speakerId,
    action: "vault_store",
    entityType: "SecretVault",
    entityId: row.id,
    summary: `Stored ${input.kind} secret «${row.label}»`,
    detail: { kind: row.kind, site: row.site },
  });
  return {
    secretId: row.id,
    label: row.label,
    site: row.site,
    kind: row.kind,
  };
}

export async function useSecret(input: {
  userId: string;
  speakerId: string;
  secretId: string;
  actorEmployeeId?: string | null;
}): Promise<{ kind: string; label: string; site: string; payload: unknown }> {
  const row = await prisma.secretVault.findFirst({
    where: {
      id: input.secretId,
      userId: input.userId,
      speakerId: input.speakerId,
    },
  });
  if (!row) {
    throw new Error("Secret not found for this speaker");
  }
  const payload = decryptSecretPayload(row);
  await prisma.secretVault.update({
    where: { id: row.id },
    data: { lastUsedAt: new Date() },
  });
  await recordAuditEvent({
    userId: input.userId,
    actorEmployeeId: input.actorEmployeeId ?? input.speakerId,
    action: "vault_use",
    entityType: "SecretVault",
    entityId: row.id,
    summary: `Used ${row.kind} secret «${row.label}»`,
    detail: { kind: row.kind, site: row.site },
  });
  return {
    kind: row.kind,
    label: row.label,
    site: row.site,
    payload,
  };
}

/** Public vault rows for ACTIVE_MISSIONS / mission turns — never ciphertext. */
export async function listVaultMetaForSpeaker(input: {
  userId: string;
  speakerId: string;
}): Promise<Array<{ secret_id: string; kind: string; label: string; site: string }>> {
  const rows = await prisma.secretVault.findMany({
    where: { userId: input.userId, speakerId: input.speakerId },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
  return rows.map((row) => ({
    secret_id: row.id,
    kind: row.kind,
    label: row.label,
    site: row.site,
  }));
}
