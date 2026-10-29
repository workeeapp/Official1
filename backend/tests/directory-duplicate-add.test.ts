/**
 * directory.add on an existing speaker phone must not silent-rename.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  contactFindUnique,
  contactCreate,
  contactUpsert,
  contactBookFindUnique,
} = vi.hoisted(() => ({
  contactFindUnique: vi.fn(),
  contactCreate: vi.fn(),
  contactUpsert: vi.fn(),
  contactBookFindUnique: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: {
    contact: {
      findUnique: contactFindUnique,
      findFirst: vi.fn(),
      create: contactCreate,
      upsert: contactUpsert,
      delete: vi.fn(),
      update: vi.fn(),
    },
    contactBook: {
      findUnique: contactBookFindUnique,
      upsert: vi.fn(),
    },
    employee: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

import { applyDirectoryActions } from "../src/services/contact.service.js";

describe("applyDirectoryActions duplicate phone on add", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contactBookFindUnique.mockResolvedValue(null);
  });

  it("returns alreadyExisting and does not create/overwrite when phone exists", async () => {
    contactFindUnique.mockResolvedValue({
      id: "c-existing",
      name: "מיכל הישנה",
      phone: "972541111111",
      description: "שכנה",
      kind: "personal",
      scope: "personal",
    });

    const result = await applyDirectoryActions({
      userId: "u1",
      ownerEmployeeId: "e1",
      actions: [
        {
          action: "add",
          name: "מיכל חדשה",
          phone: "0541111111",
          contactId: "",
          targets: [],
        },
      ],
    });

    expect(result.saved).toEqual([]);
    expect(result.alreadyExisting).toEqual([
      {
        id: "c-existing",
        name: "מיכל הישנה",
        phone: "972541111111",
        kind: "personal",
        scope: "personal",
        description: "שכנה",
      },
    ]);
    expect(contactCreate).not.toHaveBeenCalled();
    expect(contactUpsert).not.toHaveBeenCalled();
  });

  it("creates a new row when phone is free", async () => {
    contactFindUnique.mockResolvedValue(null);
    contactCreate.mockResolvedValue({
      id: "c-new",
      name: "דני",
      phone: "972502222222",
      description: null,
      kind: "personal",
      scope: "personal",
    });

    const result = await applyDirectoryActions({
      userId: "u1",
      ownerEmployeeId: "e1",
      actions: [
        {
          action: "add",
          name: "דני",
          phone: "0502222222",
          contactId: "",
          targets: [],
        },
      ],
    });

    expect(result.alreadyExisting).toEqual([]);
    expect(result.saved).toEqual([
      {
        id: "c-new",
        name: "דני",
        phone: "972502222222",
        kind: "personal",
        scope: "personal",
      },
    ]);
    expect(contactCreate).toHaveBeenCalledOnce();
  });
});
