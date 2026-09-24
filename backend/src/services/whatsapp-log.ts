import type { WhatsAppFlowEvent } from "@workee/shared";

const MAX_EVENTS = 80;
const events: WhatsAppFlowEvent[] = [];

function redact(value: string): string {
  return value.replace(/EAA[A-Za-z0-9]+/g, "[token]");
}

export function recordWhatsAppEvent(step: string, detail = ""): WhatsAppFlowEvent {
  const event: WhatsAppFlowEvent = {
    at: new Date().toISOString(),
    step,
    detail: redact(detail).slice(0, 400),
  };
  events.unshift(event);
  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }
  console.log(`WhatsApp flow ${step}${event.detail ? ` ${event.detail}` : ""}`);
  return event;
}

export function listWhatsAppEvents(): WhatsAppFlowEvent[] {
  return [...events];
}

export function lastWhatsAppInboundAt(): string | null {
  return events.find((event) => event.step === "inbound_text")?.at ?? null;
}

export function resetWhatsAppEvents(): void {
  events.length = 0;
}
