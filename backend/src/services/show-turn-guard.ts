/**
 * metadata.show_dump turns are display-only —
 * unless the model also emitted real mutates (e.g. «תמחק את 3» + accidental show_dump).
 * Dump intent comes only from ACTION fields — never from user utterance text.
 */
import type { LlmMetadata } from "@workee/shared";

export function isReadOnlyShowTurn(showDump?: string | null): boolean {
  return Boolean(typeof showDump === "string" && showDump.trim());
}

function hasMutates(metadata: LlmMetadata): boolean {
  return (
    (metadata.lists?.length ?? 0) > 0 ||
    (metadata.listOps?.length ?? 0) > 0 ||
    (metadata.filing?.length ?? 0) > 0 ||
    (metadata.reminders?.length ?? 0) > 0 ||
    (metadata.directory?.length ?? 0) > 0
  );
}

/** Clear mutating ACTION arrays (lists / listOps / filing / reminders / directory). */
export function clearMutatingMetadata(metadata: LlmMetadata): LlmMetadata {
  return {
    ...metadata,
    lists: [],
    listOps: [],
    filing: [],
    reminders: [],
    directory: [],
  };
}

/** Clear showDump (+ section/partner) so the engine does not replace the delete reply with a dump. */
function withoutShowDump(metadata: LlmMetadata): LlmMetadata {
  const {
    showDump: _dropped,
    showDumpSection: _section,
    showDumpPartner: _partner,
    ...rest
  } = metadata;
  return { ...rest };
}

/**
 * show_dump + mutates → keep mutates, drop showDump (delete wins).
 * show_dump alone → strip mutates.
 */
export function stripShowTurnMutates(metadata: LlmMetadata): LlmMetadata {
  const showDump = metadata.showDump?.trim() ?? "";

  if (!showDump) {
    return metadata;
  }

  if (hasMutates(metadata)) {
    return withoutShowDump(metadata);
  }

  return clearMutatingMetadata(metadata);
}
