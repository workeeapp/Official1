/**
 * Q3 track contract: every backend test file belongs to exactly one track by
 * suffix, and offline-track files never reach the DB harness (which would make
 * `npm test` depend on an approved database).
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dir = import.meta.dirname;
const files = readdirSync(dir).filter((f) => f.endsWith(".test.ts"));
const track = (f: string) =>
  f.endsWith(".eval-db.test.ts") ? "eval-db" : f.endsWith(".db.test.ts") ? "db" : f.endsWith(".live.test.ts") ? "live" : "offline";

// Harness entry points that write to the database (createHarnessAccount inside).
const DB_HARNESS = /\b(runModelApplyCase|runMultiTurnOffline|applyModelMetadataTurn|createHarnessAccount|seedSetup)\(/;

describe("test tracks", () => {
  it("each file is in exactly one track", () => {
    const counts: Record<string, number> = {};
    for (const f of files) counts[track(f)] = (counts[track(f)] ?? 0) + 1;
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(files.length);
    expect(counts.db).toBeGreaterThan(0);
  });

  it("offline track has no database: setup sets an unreachable URL and drops the approval", () => {
    expect(process.env.DATABASE_URL).toContain("offline_track_has_no_database");
    expect(process.env.WORKEE_APPROVED_TEST_DATABASE_URL).toBeUndefined();
  });

  it("offline-track files do not call the DB harness unmocked", () => {
    const offenders = files
      .filter((f) => track(f) === "offline")
      .filter((f) => {
        const src = readFileSync(resolve(dir, f), "utf8");
        return DB_HARNESS.test(src) && !src.includes('vi.mock("../src/database/prisma.js"');
      });
    expect(offenders).toEqual([]);
  });

  it("vitest configs select tracks by suffix only", () => {
    const read = (n: string) => readFileSync(resolve(dir, "..", n), "utf8");
    const offline = read("vitest.config.ts");
    for (const ex of ["**/*.db.test.ts", "**/*.eval-db.test.ts", "**/*.live.test.ts"]) expect(offline).toContain(ex);
    // offline track runs with an invalid DATABASE_URL and no approval.
    expect(offline).toMatch(/setupFiles: \["\.\/tests\/setup-offline-track\.ts", "\.\/tests\/setup\.ts"\]/);
    expect(read("vitest.db.config.ts")).toContain('include: ["tests/**/*.db.test.ts"]');
    expect(read("vitest.db.config.ts")).toContain('"./tests/setup-eval-env.ts", "./tests/setup-db-track.ts"');
    expect(read("vitest.eval-db.config.ts")).toContain('include: ["tests/**/*.eval-db.test.ts"]');
  });
});
