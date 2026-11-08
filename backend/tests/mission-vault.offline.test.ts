import { describe, expect, it } from "vitest";
import {
  decryptSecretPayload,
  encryptSecretPayload,
} from "../src/services/mission-vault.js";
import { toolRequiresApproval } from "../src/services/mission-tools/index.js";
import { formatPlanApprovalText } from "../src/services/mission.service.js";

describe("mission vault crypto", () => {
  it("round-trips JSON payload", () => {
    const sealed = encryptSecretPayload({
      username: "user@example.com",
      password: "s3cret",
    });
    expect(sealed.ciphertext).toBeTruthy();
    expect(sealed.iv).toBeTruthy();
    expect(sealed.authTag).toBeTruthy();
    const plain = decryptSecretPayload<{ username: string; password: string }>(
      sealed,
    );
    expect(plain.username).toBe("user@example.com");
    expect(plain.password).toBe("s3cret");
  });
});

describe("mission tool approval policy", () => {
  it("marks critical tools", () => {
    expect(toolRequiresApproval("payment.charge")).toBe(true);
    expect(toolRequiresApproval("vault.use")).toBe(true);
    expect(toolRequiresApproval("browser.navigate")).toBe(false);
    expect(toolRequiresApproval("browser.navigate", true)).toBe(true);
  });
});

describe("plan approval copy", () => {
  it("lists steps in Hebrew", () => {
    const text = formatPlanApprovalText("לבטל הוט", [
      "כניסה לאתר",
      "ביטול מינוי",
      "צילום אישור",
    ]);
    expect(text).toContain("לבטל הוט");
    expect(text).toContain("1. כניסה לאתר");
    expect(text).toContain("לאשר את התכנית?");
  });
});
