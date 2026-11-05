import type { AddressGender } from "@workee/shared";
import { prisma } from "../database/prisma.js";

const ADDRESS_FILING_NAMES = new Set(["לשון פנייה", "מגדר"]);

/**
 * Infer address gender from filing ACTION fields only (item_name / info / description).
 * No user-utterance parsing.
 */
export function addressGenderFromFilingAction(input: {
  itemName: string;
  itemInfo?: string;
  itemDescription?: string;
}): AddressGender | null {
  const name = input.itemName.trim();
  const blob = `${input.itemInfo ?? ""} ${input.itemDescription ?? ""}`;
  const isAddressFiling =
    ADDRESS_FILING_NAMES.has(name) || /לשון\s*פנייה|מגדר|פנייה/.test(name);
  if (!isAddressFiling) {
    return null;
  }
  if (/נקבה/.test(blob)) {
    return "female";
  }
  if (/זכר/.test(blob)) {
    return "male";
  }
  return null;
}

/** Every-turn fact block for second-person Hebrew address. */
export function formatSpeakerAddressContext(
  gender: AddressGender | null | undefined,
): string {
  if (gender === "female") {
    return [
      "SPEAKER_ADDRESS:",
      "gender: female",
      "Always address THIS speaker in feminine second-person Hebrew: את, לך (f), רוצה, צריכה, יכולה, מוכנה, אמרת, עשית.",
      "FORBIDDEN for this speaker: אתה, צריך, יכול, מוכן (masculine address).",
    ].join("\n");
  }
  if (gender === "male") {
    return [
      "SPEAKER_ADDRESS:",
      "gender: male",
      "Always address THIS speaker in masculine second-person Hebrew: אתה, לך (m), רוצה, צריך, יכול, מוכן, אמרת, עשית.",
      "FORBIDDEN for this speaker: את (f), צריכה, יכולה, מוכנה (feminine address).",
    ].join("\n");
  }
  return [
    "SPEAKER_ADDRESS:",
    "gender: unknown",
    "You do not yet know how to address this speaker.",
    "Do what this turn asks FIRST: every complete ACTION (lists / reminders / filing / messages / show_dump …) is emitted THIS turn and that reply is phrased gender-neutrally. Only then you may ask once «לפנות אליך בלשון זכר או נקבה?» as a separate LAST responses entry (skip it while another question of yours is still open).",
    "FORBIDDEN: empty actions / deferring any complete same-turn action — a durable filing or save (e.g. «תייקי שהכתובת שלי היא רחוב הרצל 1 תל אביב»), a reminder on an existing task (e.g. «תזכירי לי מחר ב־09:00 על התור לווטרינר»), anything — until gender is answered, and FORBIDDEN asking about the request itself because gender is unknown; the gender ask may follow, never block.",
    "On their gender answer → filing add item_name «לשון פנייה», item_info «זכר — לפנות בלשון זכר» or «נקבה — לפנות בלשון נקבה», item_description \"\"; then use that gender for the rest of the chat.",
  ].join("\n");
}

export async function syncSpeakerAddressGenderFromFiling(input: {
  employeeId: string;
  itemName: string;
  itemInfo?: string;
  itemDescription?: string;
}): Promise<AddressGender | null> {
  const gender = addressGenderFromFilingAction(input);
  if (!gender) {
    return null;
  }
  await prisma.employee.update({
    where: { id: input.employeeId },
    data: { addressGender: gender },
  });
  return gender;
}
