import { describe, expect, it } from "vitest";
import {
  isMissionExecutor,
  MISSION_EXECUTOR_NAME,
  workspaceDigitals,
} from "./types.js";

describe("mission executor helpers", () => {
  it("detects executor by flag or name", () => {
    expect(
      isMissionExecutor({
        kind: "digital",
        name: MISSION_EXECUTOR_NAME,
        nickname: MISSION_EXECUTOR_NAME,
        isExecutor: true,
      }),
    ).toBe(true);
    expect(
      isMissionExecutor({
        kind: "digital",
        name: "לוסי",
        nickname: "לוסי",
        isExecutor: false,
      }),
    ).toBe(false);
  });

  it("hides executor from workspace digitals", () => {
    const rows = workspaceDigitals([
      {
        id: "1",
        kind: "digital" as const,
        name: "לוסי",
        surname: "",
        nickname: "לוסי",
        email: null,
        phone: null,
        protected: true,
      },
      {
        id: "2",
        kind: "digital" as const,
        name: MISSION_EXECUTOR_NAME,
        surname: "",
        nickname: MISSION_EXECUTOR_NAME,
        email: null,
        phone: null,
        isExecutor: true,
      },
    ]);
    expect(rows.map((row) => row.id)).toEqual(["1"]);
  });
});
