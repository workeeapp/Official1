/**
 * Focused tests for fail-closed `.env.live-full-eval` loading.
 * Does not open Prisma / product DB. Temp fixtures only for negative paths.
 */
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LIVE_FULL_EVAL_ENV_FILENAME,
  LiveFullEvalEnvError,
  WORKEE_EVAL_ENV_LOCKED,
  loadLiveFullEvalEnv,
  parseEnvFileContents,
  resolveLiveFullEvalEnvPath,
  validateLiveFullEvalEnvValues,
} from "../src/eval/load-live-full-eval-env.js";

const EVAL_URL =
  "postgresql://workee_eval:secret@127.0.0.1:5436/workee_test";
const PRODUCT_URL = "postgresql://workee:workee@127.0.0.1:5435/workee";

function writeEvalFile(
  dir: string,
  body: string,
  fileName = LIVE_FULL_EVAL_ENV_FILENAME,
): string {
  const path = join(dir, fileName);
  writeFileSync(path, body, "utf8");
  return path;
}

function validEvalBody(overrides?: {
  databaseUrl?: string;
  approvedUrl?: string;
  omit?: string;
}): string {
  const rows: Record<string, string> = {
    DATABASE_URL: overrides?.databaseUrl ?? EVAL_URL,
    WORKEE_APPROVED_TEST_DATABASE_URL: overrides?.approvedUrl ?? EVAL_URL,
    WORKEE_DISABLE_WHATSAPP_OUTBOUND: "1",
    WORKEE_DISABLE_REMINDER_FIRE: "1",
  };
  if (overrides?.omit) {
    delete rows[overrides.omit];
  }
  return Object.entries(rows)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

describe("loadLiveFullEvalEnv (fail-closed, no product fallback)", () => {
  const prev = {
    db: process.env.DATABASE_URL,
    approved: process.env.WORKEE_APPROVED_TEST_DATABASE_URL,
    locked: process.env[WORKEE_EVAL_ENV_LOCKED],
    wa: process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND,
    fire: process.env.WORKEE_DISABLE_REMINDER_FIRE,
  };

  afterEach(() => {
    const restore = (
      key: string,
      value: string | undefined,
    ) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    };
    restore("DATABASE_URL", prev.db);
    restore("WORKEE_APPROVED_TEST_DATABASE_URL", prev.approved);
    restore(WORKEE_EVAL_ENV_LOCKED, prev.locked);
    restore("WORKEE_DISABLE_WHATSAPP_OUTBOUND", prev.wa);
    restore("WORKEE_DISABLE_REMINDER_FIRE", prev.fire);
  });

  it("parses KEY=VALUE and strips quotes", () => {
    expect(
      parseEnvFileContents(
        `# comment\nDATABASE_URL="postgresql://x/y"\nEMPTY=\nFOO=bar\n`,
      ),
    ).toEqual({
      DATABASE_URL: "postgresql://x/y",
      EMPTY: "",
      FOO: "bar",
    });
  });

  it("loads matching URLs, applies process.env, and locks eval env", () => {
    const dir = mkdtempSync(join(tmpdir(), "workee-eval-env-"));
    const path = writeEvalFile(dir, validEvalBody());
    // Pollute with product URL — loader must overwrite from eval file only.
    process.env.DATABASE_URL = PRODUCT_URL;
    delete process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
    delete process.env[WORKEE_EVAL_ENV_LOCKED];

    const result = loadLiveFullEvalEnv({ envPath: path, apply: true });

    expect(result.path).toBe(path);
    expect(result.values.DATABASE_URL).toBe(EVAL_URL);
    expect(result.values.WORKEE_APPROVED_TEST_DATABASE_URL).toBe(EVAL_URL);
    expect(process.env.DATABASE_URL).toBe(EVAL_URL);
    expect(process.env.WORKEE_APPROVED_TEST_DATABASE_URL).toBe(EVAL_URL);
    expect(process.env.DATABASE_URL).toBe(
      process.env.WORKEE_APPROVED_TEST_DATABASE_URL,
    );
    expect(process.env[WORKEE_EVAL_ENV_LOCKED]).toBe("1");
  });

  it("refuses when DATABASE_URL !== WORKEE_APPROVED_TEST_DATABASE_URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "workee-eval-env-"));
    const path = writeEvalFile(
      dir,
      validEvalBody({
        databaseUrl: EVAL_URL,
        approvedUrl: "postgresql://workee_eval:secret@127.0.0.1:5436/other_db",
      }),
    );
    expect(() => loadLiveFullEvalEnv({ envPath: path, apply: true })).toThrow(
      LiveFullEvalEnvError,
    );
    expect(() => loadLiveFullEvalEnv({ envPath: path, apply: true })).toThrow(
      /exactly equal/i,
    );
  });

  it("refuses missing required keys (no product .env fallback)", () => {
    const dir = mkdtempSync(join(tmpdir(), "workee-eval-env-"));
    const path = writeEvalFile(
      dir,
      validEvalBody({ omit: "WORKEE_APPROVED_TEST_DATABASE_URL" }),
    );
    process.env.DATABASE_URL = PRODUCT_URL;
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = PRODUCT_URL;
    expect(() => loadLiveFullEvalEnv({ envPath: path, apply: true })).toThrow(
      /missing required WORKEE_APPROVED_TEST_DATABASE_URL/i,
    );
  });

  it("refuses missing file and does not fall back to product .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "workee-eval-env-"));
    writeEvalFile(dir, `DATABASE_URL=${PRODUCT_URL}\n`, ".env");
    expect(() => resolveLiveFullEvalEnvPath(dir)).toThrow(LiveFullEvalEnvError);
    expect(() => resolveLiveFullEvalEnvPath(dir)).toThrow(/Missing/i);
    expect(() =>
      loadLiveFullEvalEnv({
        envPath: join(dir, LIVE_FULL_EVAL_ENV_FILENAME),
        apply: true,
      }),
    ).toThrow(/Missing eval env file/i);
  });

  it("refuses product workee even when URLs match in the eval file", () => {
    const dir = mkdtempSync(join(tmpdir(), "workee-eval-env-"));
    const path = writeEvalFile(
      dir,
      validEvalBody({
        databaseUrl: PRODUCT_URL,
        approvedUrl: PRODUCT_URL,
      }),
    );
    expect(() => loadLiveFullEvalEnv({ envPath: path, apply: true })).toThrow(
      /product database/i,
    );
  });

  it("validateLiveFullEvalEnvValues requires exact URL match", () => {
    expect(() =>
      validateLiveFullEvalEnvValues(
        {
          DATABASE_URL: EVAL_URL,
          WORKEE_APPROVED_TEST_DATABASE_URL: EVAL_URL + "-x",
          WORKEE_DISABLE_WHATSAPP_OUTBOUND: "1",
          WORKEE_DISABLE_REMINDER_FIRE: "1",
        },
        "test",
      ),
    ).toThrow(/exactly equal/i);
  });

  it("env.ts keeps product dotenv from overriding a locked eval env", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "../src/config/env.ts"),
      "utf8",
    );
    expect(src).toContain("WORKEE_EVAL_ENV_LOCKED");
    expect(src).toContain("override: !evalEnvLocked");
  });
});

describe("eval-db vitest setup (real .env.live-full-eval)", () => {
  const locked = process.env[WORKEE_EVAL_ENV_LOCKED] === "1";

  it.skipIf(!locked)(
    "after setup-eval-env, DATABASE_URL exactly matches approved workee_test URL",
    () => {
      expect(process.env.DATABASE_URL).toBeTruthy();
      expect(process.env.WORKEE_APPROVED_TEST_DATABASE_URL).toBeTruthy();
      expect(process.env.DATABASE_URL).toBe(
        process.env.WORKEE_APPROVED_TEST_DATABASE_URL,
      );
      const db = new URL(process.env.DATABASE_URL!).pathname
        .replace(/^\//, "")
        .split("/")[0];
      expect(db).toBe("workee_test");
      expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
      expect(process.env.WORKEE_DISABLE_REMINDER_FIRE).toBe("1");
    },
  );
});
