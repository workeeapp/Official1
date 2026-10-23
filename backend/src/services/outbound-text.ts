function reminderLine(item: string | undefined, text: string): string {
  const dictated = text.trim();
  const label = (item ?? "").trim();
  const raw = dictated && label && dictated === label ? label : dictated || label;
  const content = asInfinitive(raw.replace(/^(תזכורת:\s*)+/u, "").trim());
  return content ? `תזכורת: ${content}` : "";
}

/** Hitpael imperative התאמן → להתאמן. Nouns like חלב stay as-is. */
function asInfinitive(value: string): string {
  if (!value || /^ל/.test(value)) {
    return value;
  }
  if (/^הת[\u0590-\u05FF]+$/u.test(value)) {
    return `ל${value}`;
  }
  return value;
}

export const REMINDER_SNOOZE_MINUTES = 10;

/** Shared gate + chore label for plain-ping fire buttons (נדנד / סמן כבוצע). */
function plainPingContent(input: {
  item: string;
  text: string;
  composeAtFire: boolean;
}): string {
  if (input.composeAtFire) {
    return "";
  }
  const dictated = input.text.trim();
  const label = input.item.trim();
  if (dictated && dictated !== label) {
    return "";
  }
  return reminderLine(label, input.text).replace(/^תזכורת:\s*/u, "");
}

/**
 * Text a «נדנד» tap sends back as the recipient's next message. Only for a plain
 * ping clock — not a dictated send to someone or a compose-at-fire message.
 */
export function reminderSnoozeCommand(input: {
  item: string;
  text: string;
  composeAtFire: boolean;
}): string {
  const content = plainPingContent(input);
  return content ? `נדנדי לי ${content} בעוד ${REMINDER_SNOOZE_MINUTES} דקות` : "";
}

/**
 * Text a «סמן כבוצע» tap sends — same eligibility as snooze. Model treats it like
 * spoken «סיימתי / הלכתי…» (lists.remove or occurrence_done); no new engine path.
 */
export function reminderMarkDoneCommand(input: {
  item: string;
  text: string;
  composeAtFire: boolean;
}): string {
  const content = plainPingContent(input);
  return content ? `סמן כבוצע: ${content}` : "";
}

/** Plain-ping fire reply buttons: נדנד + סמן כבוצע (same gate; ≤ REPLY_BUTTON_MAX). */
export function reminderFireButtons(input: {
  item: string;
  text: string;
  composeAtFire: boolean;
}): Array<{ label: string; command: string }> {
  const buttons: Array<{ label: string; command: string }> = [];
  const snooze = reminderSnoozeCommand(input);
  if (snooze) {
    buttons.push({ label: "נדנד", command: snooze });
  }
  const markDone = reminderMarkDoneCommand(input);
  if (markDone) {
    buttons.push({ label: "סמן כבוצע", command: markDone });
  }
  return buttons;
}

/**
 * Buttons after engine ITEM DUMP of exactly one tasks row (same commands as
 * former model SINGLE-TASK SHOW).
 */
export function singleTaskShowButtons(input: {
  title: string;
  hasLinkedReminder: boolean;
}): Array<{ label: string; command: string }> {
  const title = input.title.trim();
  if (!title) {
    return [];
  }
  return [
    { label: "סמן כבוצע", command: `סמן כבוצע: ${title}` },
    input.hasLinkedReminder
      ? { label: "עדכן תזכורת", command: `עדכן תזכורת: ${title}` }
      : { label: "הוסף תזכורת", command: `הוסף תזכורת: ${title}` },
  ];
}

export function formatAttributedOutbound(input: {
  actorName: string;
  destIsActor: boolean;
  item?: string;
  text: string;
}): string {
  const dictated = input.text.trim();
  const label = (input.item ?? "").trim();
  const isDictatedSend = Boolean(dictated && dictated !== label);
  const ping = reminderLine(input.item, input.text);
  if (!ping && !dictated) {
    return "";
  }
  if (input.destIsActor) {
    return isDictatedSend ? dictated : ping;
  }
  if (input.actorName && (dictated.includes(input.actorName) || ping.includes(input.actorName))) {
    return isDictatedSend ? dictated : ping;
  }
  if (isDictatedSend) {
    return `מאת ${input.actorName}: ${dictated}`;
  }
  return `${input.actorName} ביקש לתזכר אותך\n${ping}`;
}
