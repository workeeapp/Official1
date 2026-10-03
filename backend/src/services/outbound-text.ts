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
