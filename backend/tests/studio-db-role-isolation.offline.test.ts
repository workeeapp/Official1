/**
 * LIVE_FULL DB role isolation — pure interpretation + injectable querier.
 * No Prisma connect, OpenAI, WhatsApp, reminder fire, or LIVE runners.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UnapprovedEvalDatabaseError } from "../src/eval/studio-db-guard.js";
import {
  assertLiveFullDbRoleIsolation,
  interpretLiveFullDbRoleIsolation,
} from "../src/eval/studio-db-role-isolation.js";

describe("interpretLiveFullDbRoleIsolation (pure, no I/O)", () => {
  it("PROVEN when product DB exists and CONNECT is false", () => {
    const v = interpretLiveFullDbRoleIsolation({
      currentDatabase: "workee_test",
      productDatabaseExists: true,
      canConnectProduct: false,
    });
    expect(v.ok).toBe(true);
    expect(v.detail).toMatch(/cannot CONNECT/i);
  });

  it("NOT PROVEN / blocked when role can CONNECT to product workee", () => {
    const v = interpretLiveFullDbRoleIsolation({
      currentDatabase: "workee_test",
      productDatabaseExists: true,
      canConnectProduct: true,
    });
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/NOT PROVEN/i);
    expect(v.detail).toMatch(/dedicated test role/i);
  });

  it("allows when product DB is absent on the cluster", () => {
    const v = interpretLiveFullDbRoleIsolation({
      currentDatabase: "workee_test",
      productDatabaseExists: false,
      canConnectProduct: false,
    });
    expect(v.ok).toBe(true);
    expect(v.detail).toMatch(/absent/i);
  });

  it("refuses when connected database is product workee", () => {
    const v = interpretLiveFullDbRoleIsolation({
      currentDatabase: "workee",
      productDatabaseExists: true,
      canConnectProduct: true,
    });
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/product identity/i);
  });

  it("refuses when connected database is not workee_test", () => {
    const v = interpretLiveFullDbRoleIsolation({
      currentDatabase: "other_test",
      productDatabaseExists: false,
      canConnectProduct: false,
    });
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/workee_test/i);
  });
});

describe("assertLiveFullDbRoleIsolation (injectable querier, no Prisma)", () => {
  it("throws UnapprovedEvalDatabaseError when CONNECT to product is true", async () => {
    await expect(
      assertLiveFullDbRoleIsolation(async () => ({
        currentDatabase: "workee_test",
        productDatabaseExists: true,
        canConnectProduct: true,
      })),
    ).rejects.toBeInstanceOf(UnapprovedEvalDatabaseError);

    await expect(
      assertLiveFullDbRoleIsolation(async () => ({
        currentDatabase: "workee_test",
        productDatabaseExists: true,
        canConnectProduct: true,
      })),
    ).rejects.toThrow(/NOT PROVEN/i);
  });

  it("passes when CONNECT to product is false", async () => {
    await expect(
      assertLiveFullDbRoleIsolation(async () => ({
        currentDatabase: "workee_test",
        productDatabaseExists: true,
        canConnectProduct: false,
      })),
    ).resolves.toBeUndefined();
  });

  it("does not call Prisma when querier is injected", async () => {
    const query = vi.fn(async () => ({
      currentDatabase: "workee_test",
      productDatabaseExists: true,
      canConnectProduct: false,
    }));
    await assertLiveFullDbRoleIsolation(query);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("LIVE_FULL runner wires role isolation after CLI env gates", () => {
  it("run-live-full awaits assertLiveFullDbRoleIsolation", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "../src/eval/run-live-full.ts"),
      "utf8",
    );
    expect(src).toMatch(/assertLiveFullCliAllowed\(\)/);
    expect(src).toMatch(/await assertLiveFullDbRoleIsolation\(\)/);
  });
});
