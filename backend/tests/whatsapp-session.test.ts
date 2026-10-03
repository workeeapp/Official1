import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const processedCreate = vi.fn();
const inboundUpsert = vi.fn();
const inboundFindUnique = vi.fn();

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    whatsAppProcessedMessage: {
      create: (...args: unknown[]) => processedCreate(...args),
    },
    whatsAppInbound: {
      upsert: (...args: unknown[]) => inboundUpsert(...args),
      findUnique: (...args: unknown[]) => inboundFindUnique(...args),
    },
  },
}));

import {
  claimWhatsAppMessageId,
  getWhatsAppActiveDigitalId,
  setWhatsAppActiveDigital,
} from "../src/services/whatsapp-session.js";

describe("whatsapp multi-instance session", () => {
  beforeEach(() => {
    processedCreate.mockReset();
    inboundUpsert.mockReset();
    inboundFindUnique.mockReset();
  });

  it("claims a new inbound message id", async () => {
    processedCreate.mockResolvedValue({ messageId: "wamid.1" });
    expect(await claimWhatsAppMessageId("wamid.1")).toBe(true);
    expect(processedCreate).toHaveBeenCalledWith({
      data: { messageId: "wamid.1" },
    });
  });

  it("skips a duplicate inbound message id", async () => {
    processedCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    expect(await claimWhatsAppMessageId("wamid.1")).toBe(false);
  });

  it("persists the active digital worker for a phone", async () => {
    inboundUpsert.mockResolvedValue({});
    await setWhatsAppActiveDigital("050-0000001", "digital-uuid");
    expect(inboundUpsert).toHaveBeenCalledWith({
      where: { phone: "972500000001" },
      create: {
        phone: "972500000001",
        lastInboundAt: expect.any(Date),
        activeDigitalEmployeeId: "digital-uuid",
      },
      update: { activeDigitalEmployeeId: "digital-uuid" },
    });
  });

  it("loads the active digital worker id for a phone", async () => {
    inboundFindUnique.mockResolvedValue({
      activeDigitalEmployeeId: "digital-uuid",
    });
    expect(await getWhatsAppActiveDigitalId("972500000001")).toBe(
      "digital-uuid",
    );
  });
});
