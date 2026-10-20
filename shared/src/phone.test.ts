import { describe, expect, it } from "vitest";
import {
  normalizeEmployeePhone,
  phonesMatch,
  toWhatsAppAddress,
} from "./phone.js";

describe("normalizeEmployeePhone", () => {
  it("maps Israel local numbers to 972…", () => {
    expect(normalizeEmployeePhone("0549999999")).toBe("972549999999");
    expect(normalizeEmployeePhone("050-0000001")).toBe("972500000001");
    expect(normalizeEmployeePhone(" 054-999-9999 ")).toBe("972549999999");
  });

  it("keeps already-international digits", () => {
    expect(normalizeEmployeePhone("972549999999")).toBe("972549999999");
  });

  it("treats empty as null", () => {
    expect(normalizeEmployeePhone("")).toBeNull();
    expect(normalizeEmployeePhone("   ")).toBeNull();
    expect(normalizeEmployeePhone(null)).toBeNull();
  });
});

describe("phonesMatch after normalize", () => {
  it("matches local and international forms", () => {
    expect(phonesMatch("0549999999", "972549999999")).toBe(true);
    expect(toWhatsAppAddress("0549999999")).toBe("972549999999");
  });
});
