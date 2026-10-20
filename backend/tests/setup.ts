import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Gate 1 production-apply harness needs a real Prisma URL. Prefer DATABASE_URL
 * from the repo .env only — do not load the rest of .env (AUTH_SECRET etc.)
 * or mocked suites like chat.test.ts break.
 */
function databaseUrlFromDotenv(): string | undefined {
  for (const candidate of [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../.env"),
  ]) {
    if (!existsSync(candidate)) {
      continue;
    }
    const match = readFileSync(candidate, "utf8").match(
      /^DATABASE_URL\s*=\s*(.+)$/m,
    );
    if (!match?.[1]) {
      continue;
    }
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || undefined;
  }
  return undefined;
}

process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  databaseUrlFromDotenv() ||
  "postgresql://workee:workee@localhost:5432/workee_test";
process.env.AUTH_SECRET ??= "test-auth-secret-that-is-at-least-32-chars";
process.env.CLIENT_ORIGIN ??= "http://localhost:5173";
process.env.PORT ??= "3001";
