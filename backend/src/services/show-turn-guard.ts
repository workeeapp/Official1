/**
 * Exact «הצג …» / metadata.show_dump turns are display-only —
 * unless the model also emitted real mutates (e.g. «תמחק את 3» + accidental show_dump).
 * Exact button commands always strip mutates (stale removes after הצג).
 */
import type { LlmMetadata } from "@workee/shared";
import { isExactShowButtonCommand } from "./show-button-dump.js";

export function isReadOnlyShowTurn(
  strippedMessage: string,
  showDump?: string | null,
): boolean {
  return (
    isExactShowButtonCommand(strippedMessage) ||
    Boolean(typeof showDump === "string" && showDump.trim())
  );
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

function withoutMutates(metadata: LlmMetadata): LlmMetadata {
  return {
    ...metadata,
    lists: [],
    listOps: [],
    filing: [],
    reminders: [],
    directory: [],
  };
}

/** Clear showDump so the engine does not replace the delete reply with a dump. */
function withoutShowDump(metadata: LlmMetadata): LlmMetadata {
  const { showDump: _dropped, ...rest } = metadata;
  return { ...rest };
}

/**
 * Exact «הצג …» → always strip mutates (stale re-emits).
 * show_dump + mutates → keep mutates, drop showDump (delete wins).
 * show_dump alone → strip mutates.
 */
export function stripShowTurnMutates(
  strippedMessage: string,
  metadata: LlmMetadata,
): LlmMetadata {
  const exactShow = isExactShowButtonCommand(strippedMessage);
  const showDump = metadata.showDump?.trim() ?? "";

  if (exactShow) {
    return withoutMutates(metadata);
  }

  if (!showDump) {
    return metadata;
  }

  if (hasMutates(metadata)) {
    return withoutShowDump(metadata);
  }

  return withoutMutates(metadata);
}
