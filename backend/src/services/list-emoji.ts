/**
 * Canonical list display emojis + effective resolution.
 * Stored override wins; otherwise builtin map / custom 📋.
 */
import { SHOW_ICON_MAX } from "@workee/shared";
import {
  isBuiltinListType,
  type BuiltinListType,
} from "./builtin-lists.js";

export const CUSTOM_LIST_EMOJI_DEFAULT = "📋";

/** Filings are not an EmployeeList shell — dump header uses this glyph. */
export const FILINGS_LIST_EMOJI = "📁";

const BUILTIN_LIST_EMOJI: Record<BuiltinListType, string> = {
  shopping: "🛒",
  tasks: "✅",
  contacts: "👤",
};

export function builtinListEmoji(listType: BuiltinListType): string {
  return BUILTIN_LIST_EMOJI[listType];
}

/** Trim + bound like show_icon; empty → null (clear / absent). */
export function normalizeListEmoji(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().slice(0, SHOW_ICON_MAX).trim();
  return trimmed || null;
}

/**
 * Effective display emoji for dumps / EMPLOYEE_SAVED_DATA.
 * `storedEmoji` null/empty → canonical default for the list type.
 */
export function effectiveListEmoji(input: {
  listType: string;
  storedEmoji?: string | null;
}): string {
  const stored = normalizeListEmoji(input.storedEmoji ?? null);
  if (stored) {
    return stored;
  }
  if (isBuiltinListType(input.listType)) {
    return builtinListEmoji(input.listType);
  }
  return CUSTOM_LIST_EMOJI_DEFAULT;
}

/** Persist on custom create when the model omitted emoji. */
export function emojiForNewCustomList(modelEmoji: unknown): string {
  return normalizeListEmoji(modelEmoji) ?? CUSTOM_LIST_EMOJI_DEFAULT;
}
