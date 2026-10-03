import { beforeEach, describe, expect, it, vi } from "vitest";

const contactUpsert = vi.fn();
const contactDeleteMany = vi.fn();

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    contact: {
      findMany: vi.fn(),
      upsert: (...args: unknown[]) => contactUpsert(...args),
      deleteMany: (...args: unknown[]) => contactDeleteMany(...args),
    },
  },
}));

import { applyDirectoryActions } from "../src/services/contact.service.js";

describe("applyDirectoryActions", () => {
  beforeEach(() => {
    contactUpsert.mockReset();
    contactDeleteMany.mockReset();
  });

  it("adds a contact via upsert on phone", async () => {
    contactUpsert.mockResolvedValue({
      id: "c1",
      name: "מיכל",
      phone: "972541111111",
      kind: "personal",
    });

    const result = await applyDirectoryActions({
      userId: "user-1",
      ownerEmployeeId: "emp-1",
      actions: [{ action: "add", name: "מיכל", phone: "054-1111111" }],
    });

    expect(contactUpsert).toHaveBeenCalled();
    expect(result.saved).toEqual([
      {
        id: "c1",
        name: "מיכל",
        phone: "972541111111",
        kind: "personal",
      },
    ]);
    expect(result.removed).toEqual([]);
  });

  it("removes a contact by phone or name", async () => {
    contactDeleteMany.mockResolvedValue({ count: 1 });

    const result = await applyDirectoryActions({
      userId: "user-1",
      ownerEmployeeId: "emp-1",
      actions: [{ action: "remove", name: "מיכל", phone: "0541111111" }],
    });

    expect(contactDeleteMany).toHaveBeenCalledWith({
      where: {
        ownerEmployeeId: "emp-1",
        OR: [
          { phone: "972541111111" },
          { name: { equals: "מיכל", mode: "insensitive" } },
        ],
      },
    });
    expect(result.removed).toEqual(["מיכל"]);
    expect(result.saved).toEqual([]);
  });

  it("skips remove when no row matched", async () => {
    contactDeleteMany.mockResolvedValue({ count: 0 });

    const result = await applyDirectoryActions({
      userId: "user-1",
      ownerEmployeeId: "emp-1",
      actions: [{ action: "remove", name: "אין", phone: "0500000000" }],
    });

    expect(result.removed).toEqual([]);
  });
});
