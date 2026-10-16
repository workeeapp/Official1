import type { LlmDirectoryAction, LlmMetadata, PublicEmployee } from "@workee/shared";
import { emptyLlmMetadata } from "@workee/shared";
import { prisma } from "../database/prisma.js";
import {
  looksLikePhone,
  normalizePhoneDigits,
  toWhatsAppAddress,
} from "../utils/phone.js";

export interface SpeakerContact {
  id: string;
  name: string;
  phone: string;
  kind: string;
  scope?: "personal" | "shared";
  /** Partner display names when scope=shared (includes owner). */
  sharedWith?: string[];
  /** True when this row is owned by someone else and shared with the viewer. */
  sharedFromOwner?: string;
}

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

  const people = await prisma.employee.findMany({
    where: { userId: owner.userId },
    select: { id: true, name: true, nickname: true },
  });
  const names = new Map(
    people.map((person) => [person.id, person.nickname?.trim() || person.name]),
  );

  const [owned, sharedCandidates] = await Promise.all([
    prisma.contact.findMany({
      where: { ownerEmployeeId },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }],
    }),
    prisma.contact.findMany({
      where: {
        userId: owner.userId,
        ownerEmployeeId: { not: ownerEmployeeId },
        scope: "shared",
      },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  const sharedIn = sharedCandidates.filter((row) =>
    visibleToIncludes(row.visibleTo, ownerEmployeeId),
  );

  return [
    ...owned.map((row) => toSpeakerContact(row, ownerEmployeeId, names)),
    ...sharedIn.map((row) => toSpeakerContact(row, ownerEmployeeId, names)),
  ];
}

function toSpeakerContact(
  row: {
    id: string;
    name: string;
    phone: string;
    kind: string;
    ownerEmployeeId: string;
    scope?: string | null;
    visibleTo?: unknown;
  },
  viewerId: string,
  names: Map<string, string>,
): SpeakerContact {
  const scope = row.scope === "shared" ? "shared" : "personal";
  const sharedWith =
    scope === "shared"
      ? sharedWithNames(row.ownerEmployeeId, row.visibleTo, names)
      : [];
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    kind: row.kind,
    scope,
    ...(sharedWith.length > 1 ? { sharedWith } : {}),
    ...(row.ownerEmployeeId !== viewerId
      ? {
          sharedFromOwner:
            names.get(row.ownerEmployeeId)?.trim() || undefined,
        }
      : {}),
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
  "SHARED CONTACT CARD: a speaker message starting with [כרטיס איש קשר שותף בוואטסאפ] followed by {\"shared_contacts\":[{name, phones}]} is a contact the speaker shared with WhatsApp's contact-share. It means: save it to their phone book.",
  "→ Same turn, without asking: metadata.directory add per card with its name and the first phone. If one card has several clearly different numbers, ask which to save (directory []).",
  "If SPEAKER_CONTACTS already has that phone, add it again — it updates the saved name. If the same name exists with a different phone, update it: directory remove with the old contact_id + add with the new phone, and say you updated it.",
  "A card without any phone cannot be saved — say so. A card without a name → ask what name to save it under (directory []).",
  "SHARE: directory add/update MAY include targets (partner names). Speaker stays owner; partners see the row via shared_with. Never assign a contact onto someone else's book.",
];

export function formatSpeakerContacts(contacts: SpeakerContact[]): string {
  if (contacts.length === 0) {
    return [
      "SPEAKER_CONTACTS:",
      "No personal contacts saved yet.",
      "Unknown names need a WhatsApp number. After the speaker gives digits, ask to save.",
      ...SHARED_CONTACT_RULES,
    ].join("\n");
  }

  return [
    "SPEAKER_CONTACTS:",
    "Phone book for this speaker (owned + rows shared with them). Resolve these names without asking for a number.",
    "MUTATE BY ID: directory.remove MUST copy contact_id from this turn — never omit it, never invent it, never speak ids aloud. A partner may remove a shared contact_id they can see.",
    ...SHARED_CONTACT_RULES,
    JSON.stringify(
      contacts.map((row) => ({
        contact_id: row.id,
        name: row.name,
        phone: row.phone,
        kind: row.kind,
        scope: row.scope ?? "personal",
        ...(row.sharedWith && row.sharedWith.length > 1
          ? { shared_with: row.sharedWith }
          : {}),
        ...(row.sharedFromOwner
          ? { owner: row.sharedFromOwner }
          : {}),
      })),
    ),
  ].join("\n");
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

function phonesLooseMatch(left: string, right: string): boolean {
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
  shareNotices: DirectoryShareNotice[];
}> {
  const saved: SpeakerContact[] = [];
  const removed: string[] = [];
  const shareNotices: DirectoryShareNotice[] = [];
  if (!prisma.contact?.upsert || input.actions.length === 0) {
    return { saved, removed, shareNotices };
  }

  const employees = input.employees ?? [];

  for (const action of input.actions) {
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
      await prisma.contact.update({
        where: { id: existing.id },
        data: {
          name: nextName,
          ...(looksLikePhone(nextPhone) ? { phone: nextPhone } : {}),
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
      });
      continue;
    }

    const name = action.name.trim().slice(0, 100);
    const phone = toWhatsAppAddress(action.phone);
    if (!name || !looksLikePhone(phone)) {
      continue;
    }

    const partnerIds = resolveDirectoryPartnerIds(
      action.targets ?? [],
      employees,
      input.ownerEmployeeId,
    );
    const shared = partnerIds.length > 0;
    const visibleTo = shared
      ? uniqueIds([input.ownerEmployeeId, ...partnerIds])
      : [input.ownerEmployeeId];

    const row = await prisma.contact.upsert({
      where: {
        ownerEmployeeId_phone: {
          ownerEmployeeId: input.ownerEmployeeId,
          phone,
        },
      },
      create: {
        userId: input.userId,
        ownerEmployeeId: input.ownerEmployeeId,
        name,
        phone,
        kind: "personal",
        addedById: input.ownerEmployeeId,
        scope: shared ? "shared" : "personal",
        visibleTo,
      },
      update: {
        name,
        kind: "personal",
        ...(shared
          ? {
              scope: "shared",
              visibleTo,
              addedById: input.ownerEmployeeId,
            }
          : {}),
      },
    });
    saved.push({
      id: row.id,
      name: row.name,
      phone: row.phone,
      kind: row.kind,
      scope: shared ? "shared" : "personal",
    });

    if (shared) {
      const directoryMeta: LlmMetadata = {
        ...emptyLlmMetadata(),
        directory: [{ ...action, targets: action.targets ?? [] }],
      };
      for (const partnerId of partnerIds) {
        shareNotices.push({
          employeeId: partnerId,
          metadata: directoryMeta,
        });
      }
    }
  }

  return { saved, removed, shareNotices };
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
}): string {
  const parts: string[] = [];
  for (const row of result.saved) {
    parts.push(`שמרתי את «${row.name}» בספר הטלפונים שלך.`);
  }
  for (const name of result.removed) {
    parts.push(`הסרתי את «${name}» מספר הטלפונים שלך.`);
  }
  return parts.join("\n");
}
