import type { PublicEmployee } from "@workee/shared";

/** Sticky digital worker per WhatsApp phone (handoff). */
const whatsappWorkerByPhone = new Map<string, string>();

export function applyWhatsAppWorkerSticky(
  from: string,
  workerId: string,
): void {
  whatsappWorkerByPhone.set(from, workerId);
}

export function clearWhatsAppWorkerSticky(from: string): void {
  whatsappWorkerByPhone.delete(from);
}

export function sessionDigitalFromSticky(
  from: string,
  digitals: PublicEmployee[],
): PublicEmployee | undefined {
  const id = whatsappWorkerByPhone.get(from);
  return id ? digitals.find((employee) => employee.id === id) : undefined;
}
