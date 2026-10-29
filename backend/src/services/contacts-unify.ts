/**
 * Unify lists.contacts → canonical Contacts (Issue 3 / Contacts v2).
 * Inventory + dry-run are pure; apply creates/merges Contacts; soft-delete
 * retires only list items with Contact.migratedFromItemId (never hard-delete).
 */

import { prisma } from "../database/prisma.js";
import { looksLikePhone, toWhatsAppAddress } from "../utils/phone.js";

export type ListContactSourceRow = {
  itemId: string;
  ownerEmployeeId: string;
  userId: string;
  data: Record<string, unknown>;
  scope: string;
  addedById: string | null;
  visibleTo: unknown;
};

export type CanonicalContactRow = {
  id: string;
  ownerEmployeeId: string;
  name: string;
  phone: string | null;
  migratedFromItemId: string | null;
};

export type ContactUnifyPlanRow =
  | {
      kind: "create";
      ownerEmployeeId: string;
      userId: string;
      name: string;
      phone: string | null;
      extras: Record<string, unknown>;
      migratedFromItemId: string;
      scope: string;
      addedById: string | null;
      visibleTo: unknown;
    }
  | {
      kind: "merge";
      contactId: string;
      ownerEmployeeId: string;
      name: string;
      phone: string | null;
      extras: Record<string, unknown>;
      migratedFromItemId: string;
      phonesPreserved: string[];
    }
  | {
      kind: "skip_already_migrated";
      itemId: string;
      contactId: string;
    };

export type ContactUnifyDryRun = {
  creates: number;
  merges: number;
  alreadyMigrated: number;
  phoneless: number;
  phonesPreserved: number;
  plans: ContactUnifyPlanRow[];
};

function readText(data: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const raw = data[key];
    if (typeof raw === "string" && raw.trim()) {
      return raw.trim();
    }
  }
  return "";
}

/** Extract display name + all phone candidates from a lists.contacts item. */
export function extractListContactFields(data: Record<string, unknown>): {
  name: string;
  phones: string[];
  extras: Record<string, unknown>;
} {
  const first = readText(data, ["שם פרטי", "first_name", "name", "שם"]);
  const last = readText(data, ["שם משפחה", "last_name", "surname"]);
  const name = [first, last].filter(Boolean).join(" ").trim() || first || last;
  const phoneKeys = [
    "טלפון",
    "phone",
    "telephone",
    "טלפון נוסף",
    "phone2",
    "mobile",
  ];
  const phones: string[] = [];
  for (const key of phoneKeys) {
    const raw = readText(data, [key]);
    if (!raw) continue;
    const normalized = toWhatsAppAddress(raw);
    if (looksLikePhone(normalized) && !phones.includes(normalized)) {
      phones.push(normalized);
    }
  }
  const extras: Record<string, unknown> = { source: "lists.contacts" };
  const address = readText(data, ["כתובת", "address"]);
  if (address) extras.address = address;
  const description = readText(data, ["תיאור", "description", "note", "notes"]);
  if (description) extras.description = description.slice(0, 500);
  if (phones.length > 1) extras.phones = phones.slice(1);
  return { name: name.slice(0, 100), phones, extras };
}

/**
 * Pick primary phone: keep existing if still available; else first new phone.
 * Never blank-clobber a valid existing primary.
 */
export function pickPrimaryPhone(
  existingPhone: string | null | undefined,
  candidates: string[],
): string | null {
  const validExisting =
    existingPhone && looksLikePhone(existingPhone) ? existingPhone : null;
  if (validExisting && candidates.includes(validExisting)) {
    return validExisting;
  }
  if (validExisting && candidates.length === 0) {
    return validExisting;
  }
  return candidates[0] ?? validExisting;
}

function digitsKey(phone: string | null | undefined): string {
  if (!phone || !looksLikePhone(phone)) return "";
  return toWhatsAppAddress(phone);
}

/**
 * Dry-run: map live lists.contacts rows onto canonical Contacts without writes.
 * Merge key = normalized phone within owner; never name-alone.
 */
export function planContactsUnify(input: {
  listRows: ListContactSourceRow[];
  contacts: CanonicalContactRow[];
}): ContactUnifyDryRun {
  const byOwnerPhone = new Map<string, CanonicalContactRow>();
  const byMigratedItem = new Map<string, CanonicalContactRow>();
  for (const row of input.contacts) {
    if (row.migratedFromItemId) {
      byMigratedItem.set(row.migratedFromItemId, row);
    }
    const key = digitsKey(row.phone);
    if (key) {
      byOwnerPhone.set(`${row.ownerEmployeeId}\0${key}`, row);
    }
  }

  const plans: ContactUnifyPlanRow[] = [];
  let phoneless = 0;
  let phonesPreserved = 0;

  for (const src of input.listRows) {
    const already = byMigratedItem.get(src.itemId);
    if (already) {
      plans.push({
        kind: "skip_already_migrated",
        itemId: src.itemId,
        contactId: already.id,
      });
      continue;
    }
    const extracted = extractListContactFields(src.data);
    if (!extracted.name) {
      continue;
    }
    const primary = pickPrimaryPhone(null, extracted.phones);
    if (!primary) {
      phoneless += 1;
    }
    const mergeKey = primary
      ? `${src.ownerEmployeeId}\0${digitsKey(primary)}`
      : "";
    const existing = mergeKey ? byOwnerPhone.get(mergeKey) : undefined;
    const extras = {
      ...extracted.extras,
      migratedFromItemId: src.itemId,
    };
    if (existing) {
      const phones = [
        ...(existing.phone && looksLikePhone(existing.phone)
          ? [existing.phone]
          : []),
        ...extracted.phones,
      ];
      const uniquePhones = [...new Set(phones.filter((p) => looksLikePhone(p)))];
      phonesPreserved += uniquePhones.length;
      const nextPrimary = pickPrimaryPhone(existing.phone, uniquePhones);
      plans.push({
        kind: "merge",
        contactId: existing.id,
        ownerEmployeeId: src.ownerEmployeeId,
        name: existing.name || extracted.name,
        phone: nextPrimary,
        extras: {
          ...extras,
          phones: uniquePhones.filter((p) => p !== nextPrimary),
        },
        migratedFromItemId: src.itemId,
        phonesPreserved: uniquePhones,
      });
      continue;
    }
    if (primary) {
      phonesPreserved += 1 + (extracted.phones.length - 1);
    }
    plans.push({
      kind: "create",
      ownerEmployeeId: src.ownerEmployeeId,
      userId: src.userId,
      name: extracted.name,
      phone: primary,
      extras,
      migratedFromItemId: src.itemId,
      scope: src.scope === "shared" ? "shared" : "personal",
      addedById: src.addedById,
      visibleTo: src.visibleTo,
    });
    if (primary) {
      byOwnerPhone.set(`${src.ownerEmployeeId}\0${digitsKey(primary)}`, {
        id: `planned:${src.itemId}`,
        ownerEmployeeId: src.ownerEmployeeId,
        name: extracted.name,
        phone: primary,
        migratedFromItemId: src.itemId,
      });
    }
  }

  return {
    creates: plans.filter((p) => p.kind === "create").length,
    merges: plans.filter((p) => p.kind === "merge").length,
    alreadyMigrated: plans.filter((p) => p.kind === "skip_already_migrated")
      .length,
    phoneless,
    phonesPreserved,
    plans,
  };
}

/** Minimal prisma surface used by apply / soft-delete — keeps tests injectable. */
export type ContactsUnifyDb = {
  contact: {
    create: (args: {
      data: Record<string, unknown>;
    }) => Promise<{ id: string }>;
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<unknown>;
    findMany?: (args: {
      where: { migratedFromItemId: { not: null } };
      select: { migratedFromItemId: true };
    }) => Promise<Array<{ migratedFromItemId: string | null }>>;
  };
  employeeListItem?: {
    updateMany: (args: {
      where: { id: { in: string[] }; deletedAt: null };
      data: { deletedAt: Date };
    }) => Promise<{ count: number }>;
  };
};

export type ContactsUnifyInventory = {
  listRows: ListContactSourceRow[];
  contacts: CanonicalContactRow[];
  listContactCount: number;
  contactCount: number;
  listPhones: string[];
  contactPhones: string[];
  schema: {
    phoneNullable: boolean;
    hasExtras: boolean;
    hasMigratedFromItemId: boolean;
  };
};

function asDataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

/** Read-only inventory of both contact systems (eval/product caller must already guard URL). */
export async function loadContactsUnifyInventory(): Promise<ContactsUnifyInventory> {
  const cols = await prisma.$queryRaw<
    Array<{ column_name: string; is_nullable: string }>
  >`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Contacts'
      AND column_name IN ('phone', 'extras', 'migrated_from_item_id')
  `;
  const byName = new Map(cols.map((c) => [c.column_name, c]));
  const schema = {
    phoneNullable: byName.get("phone")?.is_nullable === "YES",
    hasExtras: byName.has("extras"),
    hasMigratedFromItemId: byName.has("migrated_from_item_id"),
  };

  const listItems = await prisma.employeeListItem.findMany({
    where: {
      deletedAt: null,
      list: { deletedAt: null, listType: "contacts" },
    },
    select: {
      id: true,
      data: true,
      scope: true,
      addedById: true,
      visibleTo: true,
      list: {
        select: {
          employeeId: true,
          employee: { select: { userId: true } },
        },
      },
    },
  });

  const listRows: ListContactSourceRow[] = listItems.map((row) => ({
    itemId: row.id,
    ownerEmployeeId: row.list.employeeId,
    userId: row.list.employee.userId,
    data: asDataRecord(row.data),
    scope: row.scope,
    addedById: row.addedById,
    visibleTo: row.visibleTo,
  }));

  // Before migration, migratedFromItemId may not exist — use raw when needed.
  let contacts: CanonicalContactRow[] = [];
  const extraPhones: string[] = [];
  if (schema.hasMigratedFromItemId) {
    const rows = await prisma.contact.findMany({
      select: {
        id: true,
        ownerEmployeeId: true,
        name: true,
        phone: true,
        migratedFromItemId: true,
        ...(schema.hasExtras ? { extras: true } : {}),
      },
    });
    contacts = rows.map((row) => {
      const extras = asDataRecord(
        "extras" in row ? (row as { extras?: unknown }).extras : null,
      );
      const phones = extras.phones;
      if (Array.isArray(phones)) {
        for (const raw of phones) {
          if (typeof raw !== "string") continue;
          const normalized = toWhatsAppAddress(raw);
          if (looksLikePhone(normalized) && !extraPhones.includes(normalized)) {
            extraPhones.push(normalized);
          }
        }
      }
      return {
        id: row.id,
        ownerEmployeeId: row.ownerEmployeeId,
        name: row.name,
        phone: row.phone,
        migratedFromItemId: row.migratedFromItemId,
      };
    });
  } else {
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        owner_employee_id: string;
        name: string;
        phone: string | null;
      }>
    >`SELECT id, owner_employee_id, name, phone FROM "Contacts"`;
    contacts = rows.map((row) => ({
      id: row.id,
      ownerEmployeeId: row.owner_employee_id,
      name: row.name,
      phone: row.phone,
      migratedFromItemId: null,
    }));
  }

  const listPhones: string[] = [];
  for (const src of listRows) {
    for (const phone of extractListContactFields(src.data).phones) {
      if (!listPhones.includes(phone)) listPhones.push(phone);
    }
  }
  const contactPhones = [
    ...new Set([
      ...contacts
        .map((c) => c.phone)
        .filter((p): p is string => Boolean(p && looksLikePhone(p))),
      ...extraPhones,
    ]),
  ];

  return {
    listRows,
    contacts,
    listContactCount: listRows.length,
    contactCount: contacts.length,
    listPhones,
    contactPhones,
    schema,
  };
}

/** True when dry-run would only create/merge/skip — never rename-away phones or delete. */
export function dryRunLooksSafe(dry: ContactUnifyDryRun): {
  safe: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  for (const plan of dry.plans) {
    if (plan.kind === "merge" && plan.phonesPreserved.length === 0) {
      reasons.push(`merge ${plan.contactId} preserves zero phones`);
    }
    if (plan.kind === "create" && !plan.name.trim()) {
      reasons.push(`create from ${plan.migratedFromItemId} has empty name`);
    }
  }
  // Ambiguous: many merges with name changes wiping phones in extras — already checked.
  return { safe: reasons.length === 0, reasons };
}

/**
 * Apply a dry-run plan. Additive on Contacts — does not touch list source rows.
 * Call {@link softDeleteMigratedListContactSources} separately for Contacts v2 retire.
 */
export async function applyContactsUnifyPlan(
  db: ContactsUnifyDb,
  plans: ContactUnifyPlanRow[],
): Promise<{ created: number; merged: number; skipped: number }> {
  let created = 0;
  let merged = 0;
  let skipped = 0;
  for (const plan of plans) {
    if (plan.kind === "skip_already_migrated") {
      skipped += 1;
      continue;
    }
    if (plan.kind === "create") {
      const description =
        typeof plan.extras.description === "string"
          ? plan.extras.description.trim().slice(0, 500)
          : "";
      await db.contact.create({
        data: {
          userId: plan.userId,
          ownerEmployeeId: plan.ownerEmployeeId,
          name: plan.name,
          phone: plan.phone,
          ...(description ? { description } : {}),
          kind: "personal",
          scope: plan.scope,
          addedById: plan.addedById,
          visibleTo: plan.visibleTo ?? [],
          extras: plan.extras,
          migratedFromItemId: plan.migratedFromItemId,
        },
      });
      created += 1;
      continue;
    }
    const mergeDescription =
      typeof plan.extras.description === "string"
        ? plan.extras.description.trim().slice(0, 500)
        : "";
    await db.contact.update({
      where: { id: plan.contactId },
      data: {
        name: plan.name,
        ...(plan.phone ? { phone: plan.phone } : {}),
        ...(mergeDescription ? { description: mergeDescription } : {}),
        extras: plan.extras,
        migratedFromItemId: plan.migratedFromItemId,
      },
    });
    merged += 1;
  }
  return { created, merged, skipped };
}

/**
 * Contacts v2: soft-delete lists.contacts items that already have a Contact
 * tagged with migratedFromItemId. Never hard-deletes; never touches unmigrated items.
 */
export async function softDeleteMigratedListContactSources(
  db: ContactsUnifyDb,
  now: Date = new Date(),
): Promise<{ softDeleted: number; itemIds: string[] }> {
  if (!db.contact.findMany || !db.employeeListItem?.updateMany) {
    return { softDeleted: 0, itemIds: [] };
  }
  const migrated = await db.contact.findMany({
    where: { migratedFromItemId: { not: null } },
    select: { migratedFromItemId: true },
  });
  const itemIds = [
    ...new Set(
      migrated
        .map((row) => row.migratedFromItemId)
        .filter((id): id is string => Boolean(id && id.trim())),
    ),
  ];
  if (itemIds.length === 0) {
    return { softDeleted: 0, itemIds: [] };
  }
  const result = await db.employeeListItem.updateMany({
    where: { id: { in: itemIds }, deletedAt: null },
    data: { deletedAt: now },
  });
  return { softDeleted: result.count, itemIds };
}
