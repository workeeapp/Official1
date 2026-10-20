/** Digits only. */
export function normalizePhoneDigits(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Canonical WhatsApp / storage form: Israel local `0…` → `972…`, else digits only.
 * Empty / whitespace → null.
 */
export function normalizeEmployeePhone(
  value: string | null | undefined,
): string | null {
  if (value == null) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const digits = normalizePhoneDigits(trimmed);
  if (!digits) {
    return null;
  }
  if (digits.startsWith("0") && digits.length >= 9 && digits.length <= 10) {
    return `972${digits.slice(1)}`;
  }
  return digits;
}

export function toWhatsAppAddress(value: string): string {
  return normalizeEmployeePhone(value) ?? normalizePhoneDigits(value);
}

export function looksLikePhone(value: string): boolean {
  const digits = normalizePhoneDigits(value);
  return digits.length >= 8 && digits.length <= 15;
}

export function phonesMatch(left: string, right: string): boolean {
  const a = normalizePhoneDigits(left);
  const b = normalizePhoneDigits(right);
  if (!a || !b) {
    return false;
  }
  const size = Math.min(9, a.length, b.length);
  return size >= 8 && a.slice(-size) === b.slice(-size);
}
