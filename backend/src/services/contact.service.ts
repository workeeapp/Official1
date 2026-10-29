import type { LlmDirectoryAction, LlmMetadata, PublicEmployee } from "@workee/shared";
import { emptyLlmMetadata } from "@workee/shared";
import { prisma } from "../database/prisma.js";
import {
  looksLikePhone,
  normalizePhoneDigits,
  phonesMatch,
  toWhatsAppAddress,
} from "../utils/phone.js";
import { listRegisteredHumansByPhones } from "./employee.service.js";

export interface SpeakerContact {
  id: string;
  name: string;
  /** Null = phoneless (shown in אנשי קשר; not routable for WA/reminders). */
  phone: string | null;
  /** Optional free-text note (תיאור). */
  description?: string;
  kind: string;
  scope?: "personal" | "shared";
  /** Partner display names when scope=shared (includes owner). */
  sharedWith?: string[];
  /** True when this row is owned by someone else and shared with the viewer. */
  sharedFromOwner?: string;
  /**
   * Assigner display name when someone else put this row on the owner's book
   * (same ESD meaning as list/filing `assigned_by` — not the responsible party).
   */
  assignedBy?: string;
}

function normalizeContactDescription(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, 500);
}

/** Whole-book partners for this owner (includes owner when shared). */
export type ContactBookShare = {
  scope: "personal" | "shared";
  sharedWith: string[];
};

export async function listContactsForEmployee(
  ownerEmployeeId: string,
): Promise<SpeakerContact[]> {
  if (!prisma.contact?.findMany) {
    return [];
  }
  const owner = await prisma.employee.findUnique({
    where: { id: ownerEmployeeId },
    select: { userId: true, name: true, nickname: true },
  });
  if (!owner) {
    return [];
  }

  const [owned, sharedCandidates, myBook, booksSharedWithMe] =
    await Promise.all([
      prisma.contact.findMany({
        where: { ownerEmployeeId },
        orderBy: [{ name: "asc" }, { createdAt: "asc" }],
      }),
      // Same-account + cross-account rows shared with this viewer (visible_to filter below).
      prisma.contact.findMany({
        where: {
          ownerEmployeeId: { not: ownerEmployeeId },
          scope: "shared",
        },
        orderBy: [{ name: "asc" }, { createdAt: "asc" }],
      }),
      prisma.contactBook.findUnique({
        where: { ownerEmployeeId },
      }),
      prisma.contactBook.findMany({
        where: {
          ownerEmployeeId: { not: ownerEmployeeId },
          scope: "shared",
        },
      }),
    ]);

  const sharedIn = sharedCandidates.filter((row) =>
    visibleToIncludes(row.visibleTo, ownerEmployeeId),
  );
  const bookOwners = (booksSharedWithMe ?? []).filter((book) =>
    visibleToIncludes(book.visibleTo, ownerEmployeeId),
  );

  const nameIds = new Set<string>([ownerEmployeeId]);
  for (const row of [...owned, ...sharedIn]) {
    nameIds.add(row.ownerEmployeeId);
    for (const id of idList(row.visibleTo)) {
      nameIds.add(id);
    }
    if (row.addedById) {
      nameIds.add(row.addedById);
    }
  }
  for (const book of [myBook, ...bookOwners].filter(Boolean)) {
    if (!book) {
      continue;
    }
    nameIds.add(book.ownerEmployeeId);
    for (const id of idList(book.visibleTo)) {
      nameIds.add(id);
    }
  }
  const people = await prisma.employee.findMany({
    where: { id: { in: [...nameIds] } },
    select: { id: true, name: true, nickname: true },
  });
  const names = new Map(
    people.map((person) => [person.id, person.nickname?.trim() || person.name]),
  );

  const myBookPartners =
    myBook?.scope === "shared"
      ? sharedWithNames(ownerEmployeeId, myBook.visibleTo, names)
      : [];

  const seen = new Set<string>();
  const out: SpeakerContact[] = [];

  for (const row of owned) {
    seen.add(row.id);
    out.push(
      toSpeakerContact(row, ownerEmployeeId, names, myBookPartners),
    );
  }
  for (const row of sharedIn) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    out.push(toSpeakerContact(row, ownerEmployeeId, names));
  }

  for (const book of bookOwners) {
    const bookPartners = sharedWithNames(
      book.ownerEmployeeId,
      book.visibleTo,
      names,
    );
    const bookRows = await prisma.contact.findMany({
      where: { ownerEmployeeId: book.ownerEmployeeId },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }],
    });
    for (const row of bookRows) {
      if (seen.has(row.id)) {
        continue;
      }
      seen.add(row.id);
      out.push(
        toSpeakerContact(row, ownerEmployeeId, names, bookPartners),
      );
    }
  }

  return out;
}

export async function getContactBookShare(
  ownerEmployeeId: string,
): Promise<ContactBookShare | null> {
  const owner = await prisma.employee.findUnique({
    where: { id: ownerEmployeeId },
    select: { userId: true },
  });
  if (!owner) {
    return null;
  }
  const people = await prisma.employee.findMany({
    where: { userId: owner.userId },
    select: { id: true, name: true, nickname: true },
  });
  const names = new Map(
    people.map((person) => [person.id, person.nickname?.trim() || person.name]),
  );
  const book = await prisma.contactBook.findUnique({
    where: { ownerEmployeeId },
  });
  if (!book || book.scope !== "shared") {
    return { scope: "personal", sharedWith: [] };
  }
  return {
    scope: "shared",
    sharedWith: sharedWithNames(ownerEmployeeId, book.visibleTo, names),
  };
}

function toSpeakerContact(
  row: {
    id: string;
    name: string;
    phone: string | null;
    description?: string | null;
    kind: string;
    ownerEmployeeId: string;
    scope?: string | null;
    visibleTo?: unknown;
    addedById?: string | null;
  },
  viewerId: string,
  names: Map<string, string>,
  /** Whole-book partners to fold in when the row itself is personal. */
  bookPartners: string[] = [],
): SpeakerContact {
  const rowShared = row.scope === "shared";
  const rowPartners = rowShared
    ? sharedWithNames(row.ownerEmployeeId, row.visibleTo, names)
    : [];
  const sharedWith =
    rowPartners.length > 1
      ? rowPartners
      : bookPartners.length > 1
        ? bookPartners
        : [];
  const scope: "personal" | "shared" =
    sharedWith.length > 1 ? "shared" : "personal";
  const assignerId = row.addedById?.trim() ?? "";
  const assignedBy =
    assignerId &&
    assignerId !== row.ownerEmployeeId &&
    (names.get(assignerId)?.trim() ?? "");
  const description = normalizeContactDescription(row.description);
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    kind: row.kind,
    scope,
    ...(description ? { description } : {}),
    ...(sharedWith.length > 1 ? { sharedWith } : {}),
    ...(row.ownerEmployeeId !== viewerId
      ? {
          sharedFromOwner:
            names.get(row.ownerEmployeeId)?.trim() || undefined,
        }
      : {}),
    ...(assignedBy ? { assignedBy } : {}),
  };
}

function sharedWithNames(
  ownerId: string,
  visibleTo: unknown,
  names: Map<string, string>,
): string[] {
  const ordered = uniqueIds([ownerId, ...idList(visibleTo)]);
  return ordered
    .map((id) => names.get(id) ?? "")
    .filter((name) => Boolean(name));
}

function visibleToIncludes(visibleTo: unknown, employeeId: string): boolean {
  return idList(visibleTo).includes(employeeId);
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is string => typeof item === "string" && Boolean(item),
  );
}

function uniqueIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

const SHARED_CONTACT_RULES = [
  "SHARED CONTACT CARD: a speaker message starting with [כרטיס איש קשר שותף בוואטסאפ] followed by {\"shared_contacts\":[{name, phones}]} is a WhatsApp contact-share card — NOT a silent save.",
  "SAVE-ALL (multi-card / multi-entry shared_contacts): SAME TURN emit directory.add for EVERY card that has a name + one usable phone AND is NOT already in SPEAKER_CONTACTS by phone. FORBIDDEN asking «לשמור את X?» for a clear new card; FORBIDDEN asking which card to process first when several cards are independently valid. One problematic card does NOT block others — process valid cards now; ask only about unresolved ones.",
  "Per-card ASK only when that card alone is incomplete/ambiguous: no phone → cannot directory-create (say so; phoneless rows exist only via migration); no name → ask what name to save under (directory [] for that card); several clearly different phones on ONE card and speaker did not pick → ask which phone(s) (directory [] for that card only).",
  "DUPLICATE PHONE already in SPEAKER_CONTACTS → do NOT directory.add. Show the existing contact (name + phone + description when present) and ASK whether to update; on כן → directory.update with that contact_id (fields they want changed). Same name with a different phone → ASK update existing phone vs add a second contact; on update → directory.update + contact_id + new phone (not silent remove+add).",
  "After any successful directory add|update|remove this turn: emit confirm-bubble show button label «הצג אנשי קשר» command «הצג רשימת אנשי קשר» (same POST-MUTATE SHOW contract as other lists). Concise Hebrew summary in responses: what was saved, what already existed (name+phone), what still needs an answer — never invent missing details.",
  "SHARE / ASSIGN ONE CONTACT: directory add/update MAY include targets. Speaker+partners → speaker-owned co-share (shared_with). Partners only (speaker omitted) → assign onto each assignee's אנשי קשר (addedById = speaker). Same as shopping/tasks.",
  "SHARE WHOLE PHONE BOOK: «שתף את אנשי הקשר עם עמית» / «שתף את ספר הטלפונים עם עמית» (alias) → directory [{ action:\"share_book\", name:\"\", phone:\"\", targets:[\"עמית\"] }]. unshare_with drops partners (whole-book share, not item assign).",
];

export function formatSpeakerContacts(
  contacts: SpeakerContact[],
  bookShare?: ContactBookShare | null,
): string {
  const bookLine =
    bookShare?.scope === "shared" && bookShare.sharedWith.length > 1
      ? `PHONE_BOOK_SHARE: scope=shared, shared_with=${JSON.stringify(bookShare.sharedWith)} (whole book co-shared).`
      : "PHONE_BOOK_SHARE: scope=personal (not co-shared as a whole book).";
  if (contacts.length === 0) {
    return [
      "SPEAKER_CONTACTS:",
      "No personal contacts saved yet.",
      bookLine,
      "Unknown names need a WhatsApp number. After the speaker gives digits, ask to save.",
      ...SHARED_CONTACT_RULES,
    ].join("\n");
  }

  return [
    "SPEAKER_CONTACTS:",
    "Phone book for this speaker (owned + rows shared with them + whole books shared with them). Resolve these names without asking for a number.",
    bookLine,
    "MUTATE BY ID: directory.remove MUST copy contact_id from this turn — never omit it, never invent it, never speak ids aloud. A partner may remove a shared contact_id they can see.",
    ...SHARED_CONTACT_RULES,
    JSON.stringify(
      contacts.map((row) => ({
        contact_id: row.id,
        name: row.name,
        phone: row.phone,
        ...(row.description ? { description: row.description } : {}),
        kind: row.kind,
        scope: row.scope ?? "personal",
        ...(row.sharedWith && row.sharedWith.length > 1
          ? { shared_with: row.sharedWith }
          : {}),
        ...(row.sharedFromOwner
          ? { owner: row.sharedFromOwner }
          : {}),
        // assigned_by = assigner (who הטיל), not the responsible owner.
        ...(row.assignedBy ? { assigned_by: row.assignedBy } : {}),
      })),
    ),
  ].join("\n");
}

/**
 * Contacts whose phone belongs to a registered non-guest human on any account.
 * Returned as PublicEmployee rows (nickname = contact name) for target matching.
 * Same-account teammates in `excludeIds` are skipped — callers already have them.
 */
export async function resolveExternalSharePartners(
  contacts: SpeakerContact[],
  excludeIds: ReadonlySet<string> = new Set(),
): Promise<PublicEmployee[]> {
  if (contacts.length === 0) {
    return [];
  }
  const phones = contacts
    .map((row) => (row.phone ?? "").trim())
    .filter((phone) => looksLikePhone(phone));
  const registered = await listRegisteredHumansByPhones(phones);
  if (registered.length === 0) {
    return [];
  }

  const byId = new Map<string, PublicEmployee>();
  for (const contact of contacts) {
    const phone = (contact.phone ?? "").trim();
    if (!looksLikePhone(phone)) {
      continue;
    }
    const match = registered.find(
      (employee) => employee.phone && phonesMatch(employee.phone, phone),
    );
    if (!match || match.isGuest || excludeIds.has(match.id)) {
      continue;
    }
    const contactName = contact.name.trim();
    const existing = byId.get(match.id);
    if (existing) {
      // Keep an alias nickname so either contact label matches.
      if (
        contactName &&
        contactName.toLowerCase() !== (existing.nickname ?? "").toLowerCase() &&
        contactName.toLowerCase() !== existing.name.toLowerCase()
      ) {
        byId.set(match.id, {
          ...existing,
          nickname: contactName,
        });
      }
      continue;
    }
    byId.set(match.id, {
      ...match,
      // Prefer contact book label for spoken-name matching.
      nickname: contactName || match.nickname,
    });
  }
  return [...byId.values()];
}

export function matchContact(
  raw: string,
  contacts: SpeakerContact[],
): SpeakerContact | undefined {
  const needle = raw.trim().toLowerCase();
  if (!needle) {
    return undefined;
  }
  if (looksLikePhone(needle)) {
    return contacts.find((row) => phonesLooseMatch(row.phone, needle));
  }
  const ranked = [...contacts].sort(
    (left, right) => right.name.trim().length - left.name.trim().length,
  );
  return ranked.find((row) => {
    const name = row.name.trim().toLowerCase();
    return (
      name === needle ||
      name.startsWith(`${needle} `) ||
      needle.startsWith(`${name} `) ||
      name.includes(needle) ||
      needle.includes(name)
    );
  });
}

function phonesLooseMatch(
  left: string | null | undefined,
  right: string,
): boolean {
  if (!left) {
    return false;
  }
  const a = normalizePhoneDigits(left);
  const b = normalizePhoneDigits(right);
  if (!a || !b) {
    return false;
  }
  const size = Math.min(9, a.length, b.length);
  return size >= 8 && a.slice(-size) === b.slice(-size);
}

export type DirectoryShareNotice = {
  employeeId: string;
  metadata: LlmMetadata;
};

export async function applyDirectoryActions(input: {
  userId: string;
  ownerEmployeeId: string;
  actions: LlmDirectoryAction[];
  /** Humans on the account — resolve directory.targets for co-share. */
  employees?: PublicEmployee[];
}): Promise<{
  saved: SpeakerContact[];
  removed: string[];
  /** Speaker-owned add hit an existing phone — no silent rename. */
  alreadyExisting: SpeakerContact[];
  shareNotices: DirectoryShareNotice[];
  bookShared?: boolean;
}> {
  const saved: SpeakerContact[] = [];
  const removed: string[] = [];
  const alreadyExisting: SpeakerContact[] = [];
  const shareNotices: DirectoryShareNotice[] = [];
  let bookShared = false;
  if (!prisma.contact?.upsert || input.actions.length === 0) {
    return { saved, removed, alreadyExisting, shareNotices, bookShared };
  }

  const employees = input.employees ?? [];
  const bookPartnerIds = await loadBookPartnerIds(input.ownerEmployeeId);

  for (const action of input.actions) {
    if (action.action === "share_book") {
      const partnerIds = resolveDirectoryPartnerIds(
        action.targets ?? [],
        employees,
        input.ownerEmployeeId,
      );
      const unshareIds = resolveDirectoryPartnerIds(
        action.unshareWith ?? [],
        employees,
        input.ownerEmployeeId,
      );
      const existing = await prisma.contactBook.findUnique({
        where: { ownerEmployeeId: input.ownerEmployeeId },
      });
      const drop = new Set(unshareIds);
      let nextVisible = uniqueIds([
        input.ownerEmployeeId,
        ...idList(existing?.visibleTo),
        ...partnerIds,
      ]).filter((id) => id === input.ownerEmployeeId || !drop.has(id));
      const shared = nextVisible.length > 1;
      await prisma.contactBook.upsert({
        where: { ownerEmployeeId: input.ownerEmployeeId },
        create: {
          userId: input.userId,
          ownerEmployeeId: input.ownerEmployeeId,
          scope: shared ? "shared" : "personal",
          visibleTo: shared ? nextVisible : [input.ownerEmployeeId],
        },
        update: {
          scope: shared ? "shared" : "personal",
          visibleTo: shared ? nextVisible : [input.ownerEmployeeId],
        },
      });
      bookShared = shared;
      if (shared) {
        const directoryMeta: LlmMetadata = {
          ...emptyLlmMetadata(),
          directory: [{ ...action, targets: action.targets ?? [] }],
        };
        for (const partnerId of nextVisible) {
          if (partnerId === input.ownerEmployeeId) {
            continue;
          }
          shareNotices.push({
            employeeId: partnerId,
            metadata: directoryMeta,
          });
        }
      }
      continue;
    }

    if (action.action === "remove") {
      const contactId = action.contactId.trim();
      if (!contactId) {
        continue;
      }
      const existing = await prisma.contact.findFirst({
        where: {
          id: contactId,
          userId: input.userId,
          OR: [
            { ownerEmployeeId: input.ownerEmployeeId },
            {
              scope: "shared",
              // Partner may delete a shared row they can see.
            },
          ],
        },
      });
      if (!existing) {
        continue;
      }
      const canRemove =
        existing.ownerEmployeeId === input.ownerEmployeeId ||
        (existing.scope === "shared" &&
          visibleToIncludes(existing.visibleTo, input.ownerEmployeeId));
      if (!canRemove) {
        continue;
      }
      await prisma.contact.delete({ where: { id: existing.id } });
      removed.push(existing.name);
      continue;
    }

    if (action.action === "update") {
      const contactId = action.contactId.trim();
      if (!contactId) {
        continue;
      }
      const existing = await prisma.contact.findFirst({
        where: {
          id: contactId,
          userId: input.userId,
        },
      });
      if (!existing) {
        continue;
      }
      const canUpdate =
        existing.ownerEmployeeId === input.ownerEmployeeId ||
        (existing.scope === "shared" &&
          visibleToIncludes(existing.visibleTo, input.ownerEmployeeId));
      if (!canUpdate) {
        continue;
      }
      const ownerId = existing.ownerEmployeeId;
      const partnerIds = resolveDirectoryPartnerIds(
        action.targets ?? [],
        employees,
        ownerId,
      );
      const unshareIds = resolveDirectoryPartnerIds(
        action.unshareWith ?? [],
        employees,
        ownerId,
      );
      const drop = new Set(unshareIds);
      let nextVisible = uniqueIds([
        ownerId,
        ...idList(existing.visibleTo),
        ...partnerIds,
      ]).filter((id) => id === ownerId || !drop.has(id));
      const shared = nextVisible.length > 1;
      const nextName = action.name.trim()
        ? action.name.trim().slice(0, 100)
        : existing.name;
      const nextPhone = action.phone.trim()
        ? toWhatsAppAddress(action.phone)
        : existing.phone;
      const descriptionProvided = typeof action.description === "string";
      const nextDescription = descriptionProvided
        ? normalizeContactDescription(action.description)
        : normalizeContactDescription(existing.description);
      await prisma.contact.update({
        where: { id: existing.id },
        data: {
          name: nextName,
          ...(looksLikePhone(nextPhone) ? { phone: nextPhone } : {}),
          ...(descriptionProvided
            ? { description: nextDescription || null }
            : {}),
          scope: shared ? "shared" : "personal",
          visibleTo: shared ? nextVisible : [ownerId],
        },
      });
      saved.push({
        id: existing.id,
        name: nextName,
        phone: looksLikePhone(nextPhone) ? nextPhone : existing.phone,
        kind: existing.kind,
        scope: shared ? "shared" : "personal",
        ...(nextDescription ? { description: nextDescription } : {}),
      });
      continue;
    }

    const name = action.name.trim().slice(0, 100);
    const phone = toWhatsAppAddress(action.phone);
    const description = normalizeContactDescription(action.description);
    if (!name || !looksLikePhone(phone)) {
      continue;
    }

    const rawTargets = action.targets ?? [];
    const partnerIds = resolveDirectoryPartnerIds(
      rawTargets,
      employees,
      input.ownerEmployeeId,
    );
    const actorInTargets = directoryTargetsIncludeActor(
      rawTargets,
      employees,
      input.ownerEmployeeId,
    );
    // Assign: partners only → row on each assignee's book (same as shopping/tasks).
    if (!actorInTargets && partnerIds.length > 0) {
      const directoryMeta: LlmMetadata = {
        ...emptyLlmMetadata(),
        directory: [{ ...action, targets: rawTargets }],
      };
      const partnerAccounts = await prisma.employee.findMany({
        where: { id: { in: partnerIds }, kind: "human", isGuest: false },
        select: { id: true, userId: true },
      });
      const partnerUserId = new Map(
        partnerAccounts.map((row) => [row.id, row.userId]),
      );
      for (const partnerId of partnerIds) {
        const assigneeUserId = partnerUserId.get(partnerId);
        if (!assigneeUserId) {
          continue;
        }
        const visibleTo = uniqueIds([input.ownerEmployeeId, partnerId]);
        const row = await prisma.contact.upsert({
          where: {
            ownerEmployeeId_phone: {
              ownerEmployeeId: partnerId,
              phone,
            },
          },
          create: {
            userId: assigneeUserId,
            ownerEmployeeId: partnerId,
            name,
            phone,
            ...(description ? { description } : {}),
            kind: "personal",
            addedById: input.ownerEmployeeId,
            scope: "shared",
            visibleTo,
          },
          update: {
            name,
            ...(description ? { description } : {}),
            kind: "personal",
            scope: "shared",
            visibleTo,
            addedById: input.ownerEmployeeId,
          },
        });
        saved.push({
          id: row.id,
          name: row.name,
          phone: row.phone,
          kind: row.kind,
          scope: "shared",
          ...(normalizeContactDescription(row.description)
            ? { description: normalizeContactDescription(row.description) }
            : {}),
        });
        shareNotices.push({
          employeeId: partnerId,
          metadata: directoryMeta,
        });
      }
      continue;
    }

    const inherited = bookPartnerIds.filter(
      (id) => id !== input.ownerEmployeeId,
    );
    const allPartners = uniqueIds([...partnerIds, ...inherited]);
    const shared = allPartners.length > 0;
    const visibleTo = shared
      ? uniqueIds([input.ownerEmployeeId, ...allPartners])
      : [input.ownerEmployeeId];

    // Duplicate phone on speaker book: never silent-rename via add.
    // Model must directory.update with contact_id after asking the speaker.
    const prior = await prisma.contact.findUnique({
      where: {
        ownerEmployeeId_phone: {
          ownerEmployeeId: input.ownerEmployeeId,
          phone,
        },
      },
    });
    if (prior) {
      const priorDescription = normalizeContactDescription(prior.description);
      alreadyExisting.push({
        id: prior.id,
        name: prior.name,
        phone: prior.phone,
        kind: prior.kind,
        scope: prior.scope === "shared" ? "shared" : "personal",
        ...(priorDescription ? { description: priorDescription } : {}),
      });
      continue;
    }

    const row = await prisma.contact.create({
      data: {
        userId: input.userId,
        ownerEmployeeId: input.ownerEmployeeId,
        name,
        phone,
        ...(description ? { description } : {}),
        kind: "personal",
        addedById: input.ownerEmployeeId,
        scope: shared ? "shared" : "personal",
        visibleTo,
      },
    });
    saved.push({
      id: row.id,
      name: row.name,
      phone: row.phone,
      kind: row.kind,
      scope: shared ? "shared" : "personal",
      ...(normalizeContactDescription(row.description)
        ? { description: normalizeContactDescription(row.description) }
        : {}),
    });

    if (partnerIds.length > 0) {
      const directoryMeta: LlmMetadata = {
        ...emptyLlmMetadata(),
        directory: [{ ...action, targets: rawTargets }],
      };
      for (const partnerId of partnerIds) {
        shareNotices.push({
          employeeId: partnerId,
          metadata: directoryMeta,
        });
      }
    }
  }

  return { saved, removed, alreadyExisting, shareNotices, bookShared };
}

async function loadBookPartnerIds(ownerEmployeeId: string): Promise<string[]> {
  const book = await prisma.contactBook.findUnique({
    where: { ownerEmployeeId },
  });
  if (!book || book.scope !== "shared") {
    return [];
  }
  return idList(book.visibleTo);
}

function resolveDirectoryPartnerIds(
  rawTargets: string[],
  employees: PublicEmployee[],
  actorId: string,
): string[] {
  if (rawTargets.length === 0 || employees.length === 0) {
    return [];
  }
  const ids = new Set<string>();
  for (const raw of rawTargets) {
    if (/^(all|everyone|\*|כולם|כל אחד|כל העובדים)$/i.test(raw.trim())) {
      for (const employee of employees) {
        if (employee.id !== actorId) {
          ids.add(employee.id);
        }
      }
      continue;
    }
    const matched = matchDirectoryTarget(raw, employees);
    if (matched && matched.id !== actorId) {
      ids.add(matched.id);
    }
  }
  return [...ids];
}

/** Empty / «all» / actor named in targets → speaker keeps ownership (co-share or personal). */
function directoryTargetsIncludeActor(
  rawTargets: string[],
  employees: PublicEmployee[],
  actorId: string,
): boolean {
  if (rawTargets.length === 0) {
    return true;
  }
  for (const raw of rawTargets) {
    if (/^(all|everyone|\*|כולם|כל אחד|כל העובדים)$/i.test(raw.trim())) {
      return true;
    }
    const matched = matchDirectoryTarget(raw, employees);
    if (matched?.id === actorId) {
      return true;
    }
  }
  return false;
}

function matchDirectoryTarget(
  raw: string,
  employees: PublicEmployee[],
): PublicEmployee | undefined {
  const needle = raw.trim().toLowerCase();
  if (!needle) {
    return undefined;
  }
  return employees.find((employee) => {
    const aliases = [
      employee.nickname,
      employee.name,
      employee.surname,
      `${employee.name} ${employee.surname ?? ""}`.trim(),
    ]
      .filter((value): value is string => Boolean(value && value.trim()))
      .map((value) => value.trim().toLowerCase());
    return aliases.includes(needle);
  });
}

export function formatDirectoryApplyNotice(result: {
  saved: SpeakerContact[];
  removed: string[];
  bookShared?: boolean;
}): string {
  const parts: string[] = [];
  if (result.bookShared) {
    parts.push("שיתפתי את אנשי הקשר.");
  }
  for (const row of result.saved) {
    parts.push(`שמרתי את «${row.name}» באנשי הקשר שלך.`);
  }
  for (const name of result.removed) {
    parts.push(`הסרתי את «${name}» מאנשי הקשר שלך.`);
  }
  return parts.join("\n");
}
