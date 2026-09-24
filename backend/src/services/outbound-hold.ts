export function spokenReplyLooksLikeQuestion(response: string): boolean {
  return /[?؟]/.test(response.trim());
}

const pendingOutbound = new Map<
  string,
  { relays: unknown[]; phones: unknown[] }
>();

export function planOutboundSends<TRelay, TPhone>(input: {
  conversationId: string;
  relays: TRelay[];
  phones: TPhone[];
  spokenAsk: boolean;
  confirm: boolean | null;
  reminderAsk: boolean;
  reminderRemoved: boolean;
  reminderCancelled: boolean;
}): { relays: TRelay[]; phones: TPhone[]; held: boolean } {
  const hasNew = input.relays.length > 0 || input.phones.length > 0;

  if (input.spokenAsk && hasNew) {
    pendingOutbound.set(input.conversationId, {
      relays: input.relays,
      phones: input.phones,
    });
    return { relays: [], phones: [], held: true };
  }

  if (input.confirm === false) {
    pendingOutbound.delete(input.conversationId);
    return { relays: input.relays, phones: input.phones, held: false };
  }

  const mayRelease =
    input.confirm === true &&
    !hasNew &&
    !input.reminderAsk &&
    !input.reminderRemoved &&
    !input.reminderCancelled;
  if (mayRelease) {
    const held = pendingOutbound.get(input.conversationId) as
      | { relays: TRelay[]; phones: TPhone[] }
      | undefined;
    pendingOutbound.delete(input.conversationId);
    if (held) {
      return { relays: held.relays, phones: held.phones, held: false };
    }
  }

  if (hasNew) {
    pendingOutbound.delete(input.conversationId);
  }

  return { relays: input.relays, phones: input.phones, held: false };
}

export function resetOutboundHolds(): void {
  pendingOutbound.clear();
}
