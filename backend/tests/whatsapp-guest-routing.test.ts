import { describe, expect, it } from "vitest";
import { GUEST_LUCY_NAME, isGuestEmployee } from "@workee/shared";
import {
  applyWhatsAppWorkerSticky,
  clearWhatsAppWorkerSticky,
  sessionDigitalFromSticky,
} from "../src/services/whatsapp-worker-sticky.js";

describe("WhatsApp guest routing helpers", () => {
  it("clears sticky so the next turn can use Lucy", () => {
    const digitals = [
      {
        id: "guest-lucy",
        kind: "digital" as const,
        name: GUEST_LUCY_NAME,
        surname: "",
        nickname: GUEST_LUCY_NAME,
        email: null,
        phone: null,
        protected: false,
      },
      {
        id: "lucy",
        kind: "digital" as const,
        name: "לוסי",
        surname: "",
        nickname: "לוסי",
        email: null,
        phone: null,
        protected: true,
      },
    ];
    applyWhatsAppWorkerSticky("972501234567", "guest-lucy");
    expect(sessionDigitalFromSticky("972501234567", digitals)?.id).toBe(
      "guest-lucy",
    );
    clearWhatsAppWorkerSticky("972501234567");
    expect(sessionDigitalFromSticky("972501234567", digitals)).toBeUndefined();
  });

  it("prefers non-guest when ranking phone matches", () => {
    const matches = [
      {
        employee: {
          kind: "human" as const,
          name: "אורח",
          nickname: "אורח …4567",
        },
      },
      {
        employee: {
          kind: "human" as const,
          name: "מיכל",
          nickname: "מיכל",
        },
      },
    ];
    const preferred =
      matches.find((row) => !isGuestEmployee(row.employee)) ?? matches[0];
    expect(preferred?.employee.name).toBe("מיכל");
  });
});
