import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/password.js";

describe("password hashing", () => {
  it("hashes passwords and verifies the original value", async () => {
    const hash = await hashPassword("ChangeMe123!");

    expect(hash).not.toContain("ChangeMe123!");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "ChangeMe123!")).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("ChangeMe123!");
    expect(await verifyPassword(hash, "wrong-password")).toBe(false);
  });
});
