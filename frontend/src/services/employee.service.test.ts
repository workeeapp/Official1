import { describe, expect, it } from "vitest";
import { formatUsd } from "./employee.service";

describe("formatUsd", () => {
  it("uses 6 decimals for sub-$0.0001 amounts so weather tips are visible", () => {
    expect(formatUsd(0.0000388)).toBe("$0.000039");
  });

  it("keeps 4 decimals for amounts under $1 at or above $0.0001", () => {
    expect(formatUsd(0.0008)).toBe("$0.0008");
    expect(formatUsd(0.04)).toBe("$0.04");
  });

  it("uses 2 decimals for amounts of $1 or more", () => {
    expect(formatUsd(1.23)).toBe("$1.23");
    expect(formatUsd(0)).toBe("$0.00");
  });
});
