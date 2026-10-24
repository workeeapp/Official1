/**
 * Shared helpers for non-destructive real-provider eval-db suites.
 * Never logs secrets. Does not wipe GTFS.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, vi } from "vitest";
import { prisma } from "../../src/database/prisma.js";
import { resetEnvCache } from "../../src/config/env.js";
import {
  assertApprovedEvalDatabaseUrl,
  evalDatabaseNameFromUrl,
} from "../../src/eval/studio-db-guard.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../../src/eval/run-multi-turn.js";
import { getActiveGenerationId } from "../../src/services/gtfs-query.js";

/** Validated MOT day-slice — real-provider suites must leave this alone. */
export const EXPECTED_GTFS_GENERATION_ID =
  "a629a522-f283-4fe3-9420-b438366a4b46";

export function stubLlmReply(payload: unknown) {
  return {
    async createConversation() {
      return `conv-${randomUUID()}`;
    },
    async createResponse() {
      return { reply: JSON.stringify(payload), raw: {} };
    },
  };
}

export function readProductEnvValue(key: string): string {
  for (const candidate of [
    resolve(process.cwd(), "../.env"),
    resolve(process.cwd(), ".env"),
  ]) {
    if (!existsSync(candidate)) continue;
    const match = readFileSync(candidate, "utf8").match(
      new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"),
    );
    if (!match?.[1]) continue;
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) return value;
  }
  return "";
}

/** Inject a product .env key into process + clear getEnv cache (eval lock). */
export function injectProductEnvKey(key: string): { present: boolean; len: number } {
  const value = readProductEnvValue(key);
  if (value) {
    process.env[key] = value;
    resetEnvCache();
  }
  return { present: value.length > 0, len: value.length };
}

export async function ensureLucy(
  account: HarnessAccount,
  instructions = "You answer in Hebrew.",
): Promise<string> {
  const existing = await prisma.employee.findFirst({
    where: { userId: account.userId, kind: "digital" },
  });
  if (existing) return existing.id;
  const lucy = await prisma.employee.create({
    data: {
      userId: account.userId,
      kind: "digital",
      isProtected: true,
      name: "לוסי",
      surname: "",
      nickname: "לוסי",
      model: "gpt-4.1-mini",
      temperature: 0,
      instructions,
    },
  });
  return lucy.id;
}

export async function cleanupHarnessAccount(account: HarnessAccount) {
  await prisma.tipProgress
    .deleteMany({ where: { tip: { userId: account.userId } } })
    .catch(() => undefined);
  await prisma.tip
    .deleteMany({ where: { userId: account.userId } })
    .catch(() => undefined);
  await prisma.chatMessage
    .deleteMany({ where: { conversation: { userId: account.userId } } })
    .catch(() => undefined);
  await prisma.chatConversation
    .deleteMany({ where: { userId: account.userId } })
    .catch(() => undefined);
  await destroyHarnessAccount(account);
}

export { createHarnessAccount, type HarnessAccount };

export async function assertEvalDbAndGtfsUntouched(): Promise<string> {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
  expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
  expect(process.env.WORKEE_DISABLE_REMINDER_FIRE).toBe("1");
  const dbUrl = process.env.DATABASE_URL!;
  const u = new URL(dbUrl);
  expect(u.hostname).toBe("127.0.0.1");
  expect(u.port).toBe("5436");
  expect(evalDatabaseNameFromUrl(dbUrl)).toBe("workee_test");
  const activeId = await getActiveGenerationId(prisma);
  expect(activeId).toBe(EXPECTED_GTFS_GENERATION_ID);
  return activeId!;
}

export type HostProbe = { host: string; path: string; method: string };

/** Spy real fetch; record host/path only (never headers). */
export function installRealFetchHostProbe(allowedHosts?: string[]): {
  probes: HostProbe[];
  restore: () => void;
} {
  const probes: HostProbe[] = [];
  const realFetch = globalThis.fetch.bind(globalThis);
  const allow = allowedHosts ? new Set(allowedHosts) : null;
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let host = "";
    let path = "";
    try {
      const u = new URL(url);
      host = u.host;
      path = u.pathname;
    } catch {
      host = "(unparseable)";
    }
    if (!allow || allow.has(host)) {
      probes.push({
        host,
        path,
        method: String(init?.method ?? "GET").toUpperCase(),
      });
    }
    return realFetch(input, init);
  });
  vi.stubGlobal("fetch", spy);
  return {
    probes,
    restore() {
      vi.unstubAllGlobals();
    },
  };
}
