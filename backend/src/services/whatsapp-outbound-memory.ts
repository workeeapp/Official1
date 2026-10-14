/** In-memory recent outbound WhatsApp bodies by wamid — no DB. For reply-swipe context. */

const MAX = 200;
const byId = new Map<string, string>();

export function rememberWhatsAppOutbound(messageId: string, text: string): void {
  const id = messageId.trim();
  const body = text.trim();
  if (!id || !body) {
    return;
  }
  if (byId.has(id)) {
    byId.delete(id);
  }
  byId.set(id, body.slice(0, 500));
  while (byId.size > MAX) {
    const first = byId.keys().next().value;
    if (!first) {
      break;
    }
    byId.delete(first);
  }
}

export function lookupWhatsAppOutbound(messageId: string): string | undefined {
  const id = messageId.trim();
  if (!id) {
    return undefined;
  }
  return byId.get(id);
}

export function resetWhatsAppOutboundMemory(): void {
  byId.clear();
}

export function formatWhatsAppReplyContext(
  quotedText: string,
  userText: string,
): string {
  const quote = quotedText.trim().replace(/\s+/g, " ").slice(0, 200);
  const body = userText.trim();
  if (!quote || !body) {
    return body;
  }
  return `[בתשובה להודעה: "${quote}"] ${body}`;
}
