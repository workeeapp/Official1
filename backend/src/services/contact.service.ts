import type { LlmDirectoryAction } from "@workee/shared";
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
}

export async function listContactsForEmployee(
  ownerEmployeeId: string,
): Promise<SpeakerContact[]> {
  if (!prisma.contact?.findMany) {
    return [];
  }
  const rows = await prisma.contact.findMany({
    where: { ownerEmployeeId },
    orderBy: [{ name: "asc" }, { createdAt: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone,
    kind: row.kind,
  }));
}

export function formatSpeakerContacts(contacts: SpeakerContact[]): string {
  if (contacts.length === 0) {
    return [
      "SPEAKER_CONTACTS:",
      "No personal contacts saved yet.",
      "Unknown names need a WhatsApp number. After the speaker gives digits, ask to save.",
    ].join("\n");
  }

  return [
    "SPEAKER_CONTACTS:",
    "Personal phone book for this speaker only. Resolve these names without asking for a number.",
    "MUTATE BY ID: directory.remove MUST copy contact_id from this turn — never omit it, never invent it, never speak ids aloud.",
    JSON.stringify(
      contacts.map((row) => ({
        contact_id: row.id,
        name: row.name,
        phone: row.phone,
        kind: row.kind,
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

export async function applyDirectoryActions(input: {
  userId: string;
  ownerEmployeeId: string;
  actions: LlmDirectoryAction[];
}): Promise<{ saved: SpeakerContact[]; removed: string[] }> {
  const saved: SpeakerContact[] = [];
  const removed: string[] = [];
  if (!prisma.contact?.upsert || input.actions.length === 0) {
    return { saved, removed };
  }

  for (const action of input.actions) {
    if (action.action === "remove") {
      const contactId = action.contactId.trim();
      if (!contactId) {
        continue;
      }
      const existing = await prisma.contact.findFirst({
        where: {
          id: contactId,
          ownerEmployeeId: input.ownerEmployeeId,
        },
      });
      if (!existing) {
        continue;
      }
      await prisma.contact.delete({ where: { id: existing.id } });
      removed.push(existing.name);
      continue;
    }

    const name = action.name.trim().slice(0, 100);
    const phone = toWhatsAppAddress(action.phone);
    if (!name || !looksLikePhone(phone)) {
      continue;
    }

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
      },
      update: {
        name,
        kind: "personal",
      },
    });
    saved.push({
      id: row.id,
      name: row.name,
      phone: row.phone,
      kind: row.kind,
    });
  }

  return { saved, removed };
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
