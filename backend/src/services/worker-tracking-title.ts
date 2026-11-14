/**
 * Lucy's own follow-up / nudge row title. It is not the speaker's chore.
 * Kept on the worker book; never shown on bare speaker «הצג משימות».
 */
export function isWorkerTrackingTitle(title: string): boolean {
  const text = title.trim();
  return (
    text.startsWith("להזכיר ל") ||
    text.startsWith("לשלוח הודעה") ||
    text.startsWith("לשלוח נדנוד") ||
    text.startsWith("לעזור ל")
  );
}

/**
 * Human-facing chore for a WhatsApp ping / clock label.
 * «להזכיר לטל לשתות חלב» → «לשתות חלב». Non-tracking titles pass through.
 * Message/nudge tracking without an extractable chore → "" (never send as-is).
 */
export function humanFacingChoreFromTitle(title: string): string {
  const text = title.trim().replace(/^(תזכורת:\s*)+/u, "").trim();
  if (!text) {
    return "";
  }
  if (!isWorkerTrackingTitle(text)) {
    return text;
  }

  if (text.startsWith("להזכיר ל")) {
    let rest = text.slice("להזכיר ל".length);
    if (rest.startsWith("ך ")) {
      rest = rest.slice(2);
    } else if (rest.startsWith("י ")) {
      rest = rest.slice(2);
    } else {
      // Strip the addressee name(s): טל / עמית / טל ועמית / ולטל…
      rest = rest.replace(
        /^[\u0590-\u05FF]+(?:\s+ו(?:ל)?[\u0590-\u05FF]+)*\s+/u,
        "",
      );
    }
    const chore = rest.trim();
    return chore && !isWorkerTrackingTitle(chore) ? chore : "";
  }

  // לשלוח הודעה / נדנוד / לעזור — ping body must be the dictated message, not the title.
  return "";
}

/** Sanitize clock item/text so tracking titles never become the WhatsApp body. */
export function sanitizeReminderPingFields(input: {
  item: string;
  text: string;
}): { item: string; text: string } {
  const itemRaw = input.item.trim();
  const textRaw = input.text.trim();
  const itemBare = itemRaw.replace(/^(תזכורת:\s*)+/u, "").trim();
  const textBare = textRaw.replace(/^(תזכורת:\s*)+/u, "").trim();
  const item = isWorkerTrackingTitle(itemBare)
    ? humanFacingChoreFromTitle(itemRaw)
    : itemRaw;
  const text = isWorkerTrackingTitle(textBare)
    ? humanFacingChoreFromTitle(textRaw)
    : textRaw;
  return { item, text };
}
