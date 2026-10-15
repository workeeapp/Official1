/**
 * Exact «הצג …» / metadata.show_dump turns are display-only:
 * never apply list/reminder/filing/directory mutates the model may re-emit.
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

/** Clear mutating actions; keep showDump / buttons / sendAttachments / messages. */
export function stripShowTurnMutates(
  strippedMessage: string,
  metadata: LlmMetadata,
): LlmMetadata {
  if (!isReadOnlyShowTurn(strippedMessage, metadata.showDump)) {
    return metadata;
  }
  return {
    ...metadata,
    lists: [],
    listOps: [],
    filing: [],
    reminders: [],
    directory: [],
  };
}
