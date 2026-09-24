export function planOutboundSends<TRelay, TPhone>(input: {
  relays: TRelay[];
  phones: TPhone[];
}): { relays: TRelay[]; phones: TPhone[]; held: boolean } {
  return { relays: input.relays, phones: input.phones, held: false };
}

export function resetOutboundHolds(): void {}
