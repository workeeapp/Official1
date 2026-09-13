import { describe, expect, it } from "vitest";
import {
  hasFieldErrors,
  validateChatInput,
  validateEmployeeInput,
  validateLoginInput,
  validatePassword,
  validateUsername,
} from "./validation.js";

describe("validateUsername", () => {
  it("requires a username", () => {
    expect(validateUsername("")).toBe("Username is required");
    expect(validateUsername("   ")).toBe("Username is required");
    expect(validateUsername(undefined)).toBe("Username is required");
  });

  it("enforces length bounds", () => {
    expect(validateUsername("ab")).toMatch(/at least 3/);
    expect(validateUsername("a".repeat(33))).toMatch(/at most 32/);
  });

  it("rejects unsupported characters", () => {
    expect(validateUsername("bad user")).toMatch(/letters, numbers/);
    expect(validateUsername("bad@user")).toMatch(/letters, numbers/);
  });

  it("accepts a valid username", () => {
    expect(validateUsername("Amit")).toBeUndefined();
    expect(validateUsername("user_name-1")).toBeUndefined();
  });
});

describe("validatePassword", () => {
  it("requires a password", () => {
    expect(validatePassword("")).toBe("Password is required");
    expect(validatePassword(undefined)).toBe("Password is required");
  });

  it("enforces length bounds", () => {
    expect(validatePassword("short")).toMatch(/at least 8/);
    expect(validatePassword("x".repeat(129))).toMatch(/at most 128/);
  });

  it("accepts a valid password", () => {
    expect(validatePassword("ChangeMe123!")).toBeUndefined();
  });
});

describe("validateLoginInput", () => {
  it("collects field errors", () => {
    const errors = validateLoginInput({ username: "", password: "" });
    expect(errors.username).toBe("Username is required");
    expect(errors.password).toBe("Password is required");
    expect(hasFieldErrors(errors)).toBe(true);
  });

  it("returns no errors for valid input", () => {
    const errors = validateLoginInput({
      username: "Amit",
      password: "ChangeMe123!",
    });
    expect(errors).toEqual({});
    expect(hasFieldErrors(errors)).toBe(false);
  });
});

describe("validateEmployeeInput", () => {
  it("accepts optional email and phone", () => {
    expect(
      validateEmployeeInput({
        name: "Dana",
        surname: "Levi",
        email: "dana@example.com",
        phone: "050-1111111",
      }),
    ).toEqual({});
  });

  it("rejects an invalid email or phone", () => {
    const errors = validateEmployeeInput({
      name: "Dana",
      surname: "Levi",
      email: "not-an-email",
      phone: "abc",
    });
    expect(errors.email).toBe("Email is invalid");
    expect(errors.phone).toBe("Phone is invalid");
  });

  it("requires model, temperature, and instructions for a digital employee", () => {
    const errors = validateEmployeeInput({
      kind: "digital",
      name: "לוסי",
    });
    expect(errors.model).toBe("Model is required");
    expect(errors.temperature).toBe("Temperature is required");
    expect(errors.instructions).toBe("Instructions are required");
    expect(errors.surname).toBeUndefined();
  });

  it("accepts a valid digital employee", () => {
    expect(
      validateEmployeeInput({
        kind: "digital",
        name: "לוסי",
        model: "gpt-4.1-mini",
        temperature: 0,
        instructions: "You manage lists and filings.",
      }),
    ).toEqual({});
  });
});

describe("validateChatInput", () => {
  it("requires a message", () => {
    expect(validateChatInput({ message: "" }).message).toBe("Message is required");
  });

  it("requires an employee", () => {
    expect(validateChatInput({ message: "hi" }).employeeId).toBe(
      "Employee is required",
    );
  });

  it("rejects an invalid employee id", () => {
    expect(
      validateChatInput({ message: "hi", employeeId: "not-a-uuid" }).employeeId,
    ).toBe("Employee is invalid");
  });

  it("accepts a valid message for an employee", () => {
    expect(
      validateChatInput({
        message: "hi",
        employeeId: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
      }),
    ).toEqual({});
  });
});
