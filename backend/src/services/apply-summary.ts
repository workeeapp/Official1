import type { FilingMutation, ListItemMutation } from "./employee-records.service.js";
import { formatReminderApplyNotice } from "./reminder.service.js";
import { formatDirectoryApplyNotice, type SpeakerContact } from "./contact.service.js";

const LIST_TYPE_HE: Record<string, string> = {
  shopping: "רשימת הקניות",
  tasks: "רשימת המטלות",
  contacts: "רשימת אנשי הקשר",
  custom: "הרשימה",
};

function listBucketHe(listType: string, listName?: string): string {
  if (listType === "custom" && listName?.trim()) {
    return `הרשימה «${listName.trim()}»`;
  }
  return LIST_TYPE_HE[listType] ?? "הרשימה";
}

function formatListMutationLine(
  row: ListItemMutation,
  opts: { speakerId: string; workerId: string; workerName: string },
): string {
  const label = (row.itemLabel || row.itemKey).trim() || row.itemKey;
  if (row.listShell) {
    return row.action === "update"
      ? `עדכנתי את הרשימה «${label}».`
      : `פתחתי את הרשימה «${label}».`;
  }
  const bucket = listBucketHe(row.listType, row.listName);
  const onWorker = row.employeeId === opts.workerId;

  if (row.action === "add") {
    return onWorker
      ? `הוספתי לעצמי מטלה «${label}».`
      : `הוספתי «${label}» ל${bucket}.`;
  }
  if (row.action === "update") {
    return onWorker
      ? `עדכנתי את המטלה שלי «${label}».`
      : `עדכנתי «${label}» ב${bucket}.`;
  }
  return onWorker
    ? `הסרתי מעצמי את המטלה «${label}».`
    : `הסרתי «${label}» מ${bucket}.`;
}

function formatFilingMutationLine(row: FilingMutation): string {
  if (row.action === "remove") {
    return `מחקתי תיוק «${row.itemName}».`;
  }
  if (row.action === "update") {
    return row.itemInfo.trim()
      ? `עדכנתי תיוק «${row.itemName}»: ${row.itemInfo.trim()}.`
      : `עדכנתי תיוק «${row.itemName}».`;
  }
  return row.itemInfo.trim()
    ? `שמרתי תיוק «${row.itemName}»: ${row.itemInfo.trim()}.`
    : `שמרתי תיוק «${row.itemName}».`;
}

/**
 * Product-Hebrew summary of everything the server actually applied this turn.
 * Appended to the assistant reply so the speaker always sees the real mutations.
 */
export function formatTurnApplySummary(input: {
  listMutations?: ListItemMutation[];
  filingMutations?: FilingMutation[];
  reminders?: Parameters<typeof formatReminderApplyNotice>[0];
  directory?: { saved: SpeakerContact[]; removed: string[] };
  messagesSent?: string[];
  speakerId: string;
  workerId: string;
  workerName: string;
}): string {
  const lines: string[] = [];

  for (const row of input.listMutations ?? []) {
    lines.push(
      formatListMutationLine(row, {
        speakerId: input.speakerId,
        workerId: input.workerId,
        workerName: input.workerName,
      }),
    );
  }

  for (const row of input.filingMutations ?? []) {
    lines.push(formatFilingMutationLine(row));
  }

  const reminderNotice = input.reminders
    ? formatReminderApplyNotice(input.reminders)
    : "";
  if (reminderNotice.trim()) {
    lines.push(reminderNotice.trim());
  }

  const directoryNotice = input.directory
    ? formatDirectoryApplyNotice(input.directory)
    : "";
  if (directoryNotice.trim()) {
    lines.push(directoryNotice.trim());
  }

  for (const label of input.messagesSent ?? []) {
    const name = label.trim();
    if (name) {
      lines.push(`שלחתי הודעה ל«${name}».`);
    }
  }

  return lines.filter(Boolean).join("\n");
}
