export function formatChatDate(value: string, now = new Date()): string {
  const date = parseDate(value);
  if (!date) {
    return "";
  }

  const day = startOfDay(date);
  const today = startOfDay(now);
  const yesterday = today - 86_400_000;

  if (day === today) {
    return "היום";
  }

  if (day === yesterday) {
    return "אתמול";
  }

  return date.toLocaleDateString("he-IL");
}

export function formatChatTime(value: string): string {
  const date = parseDate(value);
  if (!date) {
    return "";
  }

  return date.toLocaleTimeString("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function chatDayKey(value?: string): string | null {
  const date = value ? parseDate(value) : null;
  if (!date) {
    return null;
  }

  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
