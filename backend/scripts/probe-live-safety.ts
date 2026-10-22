#!/usr/bin/env npx tsx
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
config({ path: resolve(repoRoot, ".env") });

const db = process.env.DATABASE_URL ?? "";
const approved = process.env.WORKEE_APPROVED_TEST_DATABASE_URL ?? "";
const wa = !!(
  process.env.WHATSAPP_TOKEN ||
  process.env.WHATSAPP_ACCESS_TOKEN ||
  process.env.META_WHATSAPP_TOKEN
);

function dbName(u: string): string {
  try {
    return new URL(u).pathname.replace(/^\//, "") || "(empty-path)";
  } catch {
    return u ? "(unparseable)" : "(absent)";
  }
}

const match = approved.length > 0 && db === approved;
const openai = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.length > 8);
const report = {
  databaseName: dbName(db),
  approvedPresent: approved.length > 0,
  approvedExactMatch: match,
  whatsappCredsPresent: wa,
  openaiPresent: openai,
  liveFullSafe: match && !wa,
  liveModelSideEffectNote:
    "run-case.ts / LIVE_MODEL path uses LLM only; no prisma apply, WA send, or reminder fire",
};
writeFileSync(
  resolve(repoRoot, "docs/qa/core-eval-live-safety-probe.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stderr.write(`${JSON.stringify(report)}\n`);
