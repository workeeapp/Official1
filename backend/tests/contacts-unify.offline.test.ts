import { describe, expect, it, vi } from "vitest";
import {
  applyContactsUnifyPlan,
  extractListContactFields,
  pickPrimaryPhone,
  planContactsUnify,
  softDeleteMigratedListContactSources,
} from "../src/services/contacts-unify.js";

describe("contacts-unify dry-run", () => {
  it("extracts name + phones from lists.contacts fields", () => {
    expect(
      extractListContactFields({
        "שם פרטי": "מיכל",
        "שם משפחה": "כהן",
        טלפון: "0501111111",
        "טלפון נוסף": "0502222222",
        כתובת: "הרצל 1",
        תיאור: "שכנה מהבניין",
      }),
    ).toMatchObject({
      name: "מיכל כהן",
      phones: expect.arrayContaining(["972501111111", "972502222222"]),
      extras: expect.objectContaining({
        source: "lists.contacts",
        address: "הרצל 1",
        description: "שכנה מהבניין",
      }),
    });
  });

  it("pickPrimaryPhone keeps existing when still available", () => {
    expect(
      pickPrimaryPhone("972501111111", ["972502222222", "972501111111"]),
    ).toBe("972501111111");
    expect(pickPrimaryPhone(null, ["972501111111"])).toBe("972501111111");
    expect(pickPrimaryPhone("972501111111", [])).toBe("972501111111");
    expect(pickPrimaryPhone(null, [])).toBeNull();
  });

  it("plans create for phoneless + merge by phone + skip already migrated", () => {
    const dry = planContactsUnify({
      listRows: [
        {
          itemId: "item-phoneless",
          ownerEmployeeId: "owner-1",
          userId: "user-1",
          data: { "שם פרטי": "דני" },
          scope: "personal",
          addedById: null,
          visibleTo: [],
        },
        {
          itemId: "item-new",
          ownerEmployeeId: "owner-1",
          userId: "user-1",
          data: { "שם פרטי": "נועה", טלפון: "0503333333" },
          scope: "personal",
          addedById: null,
          visibleTo: [],
        },
        {
          itemId: "item-merge",
          ownerEmployeeId: "owner-1",
          userId: "user-1",
          data: {
            "שם פרטי": "מיכל",
            טלפון: "0501111111",
            "טלפון נוסף": "0509999999",
          },
          scope: "personal",
          addedById: null,
          visibleTo: [],
        },
        {
          itemId: "item-done",
          ownerEmployeeId: "owner-1",
          userId: "user-1",
          data: { "שם פרטי": "ישן", טלפון: "0504444444" },
          scope: "personal",
          addedById: null,
          visibleTo: [],
        },
      ],
      contacts: [
        {
          id: "c-michal",
          ownerEmployeeId: "owner-1",
          name: "מיכל",
          phone: "972501111111",
          migratedFromItemId: null,
        },
        {
          id: "c-done",
          ownerEmployeeId: "owner-1",
          name: "ישן",
          phone: "972504444444",
          migratedFromItemId: "item-done",
        },
      ],
    });

    expect(dry.phoneless).toBe(1);
    expect(dry.creates).toBe(2); // phoneless + נועה
    expect(dry.merges).toBe(1);
    expect(dry.alreadyMigrated).toBe(1);
    expect(dry.plans.find((p) => p.kind === "create" && p.name === "דני")).toMatchObject({
      phone: null,
      migratedFromItemId: "item-phoneless",
    });
    const merge = dry.plans.find((p) => p.kind === "merge");
    expect(merge).toMatchObject({
      kind: "merge",
      contactId: "c-michal",
      phone: "972501111111",
    });
    if (merge?.kind === "merge") {
      expect(merge.phonesPreserved).toEqual(
        expect.arrayContaining(["972501111111", "972509999999"]),
      );
    }
  });

  it("never merges by name alone", () => {
    const dry = planContactsUnify({
      listRows: [
        {
          itemId: "item-a",
          ownerEmployeeId: "owner-1",
          userId: "user-1",
          data: { "שם פרטי": "מיכל", טלפון: "0505555555" },
          scope: "personal",
          addedById: null,
          visibleTo: [],
        },
      ],
      contacts: [
        {
          id: "c-other",
          ownerEmployeeId: "owner-1",
          name: "מיכל",
          phone: "972506666666",
          migratedFromItemId: null,
        },
      ],
    });
    expect(dry.creates).toBe(1);
    expect(dry.merges).toBe(0);
  });

  it("apply is additive on Contacts (does not soft-delete sources)", async () => {
    const create = vi.fn(async () => ({ id: "new-1" }));
    const update = vi.fn(async () => ({}));
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const dry = planContactsUnify({
      listRows: [
        {
          itemId: "item-p",
          ownerEmployeeId: "owner-1",
          userId: "user-1",
          data: { "שם פרטי": "דני", תיאור: "שכן" },
          scope: "personal",
          addedById: null,
          visibleTo: [],
        },
        {
          itemId: "item-m",
          ownerEmployeeId: "owner-1",
          userId: "user-1",
          data: {
            "שם פרטי": "מיכל",
            טלפון: "0501111111",
            תיאור: "שכנה מהבניין",
          },
          scope: "personal",
          addedById: null,
          visibleTo: [],
        },
      ],
      contacts: [
        {
          id: "c-michal",
          ownerEmployeeId: "owner-1",
          name: "מיכל",
          phone: "972501111111",
          migratedFromItemId: null,
        },
      ],
    });
    const result = await applyContactsUnifyPlan(
      { contact: { create, update }, employeeListItem: { updateMany } },
      dry.plans,
    );
    expect(result).toEqual({ created: 1, merged: 1, skipped: 0 });
    expect(updateMany).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "דני",
          phone: null,
          description: "שכן",
          migratedFromItemId: "item-p",
        }),
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "c-michal" },
        data: expect.objectContaining({
          description: "שכנה מהבניין",
          migratedFromItemId: "item-m",
        }),
      }),
    );
  });

  it("soft-deletes only migrated sources; leaves unmigrated; idempotent", async () => {
    const findMany = vi.fn(async () => [
      { migratedFromItemId: "item-migrated" },
      { migratedFromItemId: "item-migrated" },
      { migratedFromItemId: null },
    ]);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const first = await softDeleteMigratedListContactSources({
      contact: {
        create: vi.fn(),
        update: vi.fn(),
        findMany,
      },
      employeeListItem: { updateMany },
    });
    expect(first.softDeleted).toBe(1);
    expect(first.itemIds).toEqual(["item-migrated"]);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["item-migrated"] }, deletedAt: null },
      }),
    );

    updateMany.mockResolvedValueOnce({ count: 0 });
    const second = await softDeleteMigratedListContactSources({
      contact: {
        create: vi.fn(),
        update: vi.fn(),
        findMany,
      },
      employeeListItem: { updateMany },
    });
    expect(second.softDeleted).toBe(0);
  });
});
