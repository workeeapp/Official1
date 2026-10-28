/**
 * Eval-only: focused pre-parse ACTION diagnostic for LIVE_FULL.
 * Captures raw metadata.lists / metadata.filing shape before parseLlmMetadata
 * so harness artifacts can distinguish empty emission from silent parse drops.
 * Does not log spoken response text or unrelated personal fields.
 */

export type EvalRawActionDiagnostic = {
  /** Raw metadata.lists array as emitted (or null if absent/unparseable). */
  lists: unknown[] | null;
  /** Raw top-level metadata.filing if present (legacy; usually absent). */
  filing: unknown[] | null;
  listEntryCount: number;
  /** Entries that look like list_type filing / add_filing before normalization. */
  filingLikeListEntryCount: number;
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return asObject(parsed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return null;
    }
    try {
      return asObject(JSON.parse(trimmed.slice(start, end + 1)));
    } catch {
      return null;
    }
  }
}

function isFilingLikeListEntry(entry: unknown): boolean {
  const row = asObject(entry);
  if (!row) {
    return false;
  }
  const listType = String(row.list_type ?? row.listType ?? "")
    .trim()
    .toLowerCase();
  const action = String(row.action ?? "")
    .trim()
    .toLowerCase();
  return (
    listType === "filing" ||
    action === "add_filing" ||
    action === "remove_filing" ||
    action === "update_filing"
  );
}

/**
 * Extract focused raw lists/filing from a model reply string (pre-parse).
 * Eval harness only — not used in production chat logging.
 */
export function extractEvalRawActionDiagnostic(
  replyText: string,
): EvalRawActionDiagnostic {
  const empty: EvalRawActionDiagnostic = {
    lists: null,
    filing: null,
    listEntryCount: 0,
    filingLikeListEntryCount: 0,
  };
  const root = tryParseJsonObject(replyText);
  if (!root) {
    return empty;
  }
  const meta = asObject(root.metadata) ?? {};
  const listsRaw = meta.lists ?? root.lists;
  const lists = Array.isArray(listsRaw) ? listsRaw : null;
  const filingRaw = meta.filing;
  const filing = Array.isArray(filingRaw) ? filingRaw : null;
  const listEntryCount = lists?.length ?? 0;
  const filingLikeListEntryCount = lists?.filter(isFilingLikeListEntry).length ?? 0;
  return {
    lists,
    filing,
    listEntryCount,
    filingLikeListEntryCount,
  };
}
