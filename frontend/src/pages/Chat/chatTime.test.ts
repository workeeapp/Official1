import { describe, expect, it } from "vitest";
import { formatDurationMs } from "./chatTime";

describe("formatDurationMs", () => {
  it("shows milliseconds under one second", () => {
    expect(formatDurationMs(80)).toBe("80ms");
  });

  it("shows one decimal second from 1000ms", () => {
    expect(formatDurationMs(1240)).toBe("1.2s");
  });
});
