export function normalizePhoneDigits(value: string): string {
  return value.replace(/\D/g, "");
}

export function toWhatsAppAddress(value: string): string {
  const digits = normalizePhoneDigits(value);
  if (digits.startsWith("0") && digits.length >= 9 && digits.length <= 10) {
    return `972${digits.slice(1)}`;
  }
  return digits;
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
