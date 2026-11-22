/**
 * P2a — instruction channel for HighRiskActionGate EIS.
 * Shared WhatsApp contact/location cards are never instruction text.
 * Forwarded message bodies are excluded by the caller (see WhatsApp ingest).
 *
 * gateInstructionText is channel-cleaned EIS only — not provenance / authorship.
 * It must not be treated as sufficient authority to create clarifyBind.
 * See docs/product/lucy-high-risk-gate-p0-p1-status.md.
 */
export const SHARED_LOCATION_MARKER = "[מיקום שותף בוואטסאפ]";
export const SHARED_CONTACTS_MARKER = "[כרטיס איש קשר שותף בוואטסאפ]";

/** Marker line + following JSON object (usually one line from JSON.stringify). */
const CARD_BLOCK_RE = new RegExp(
  String.raw`(?:^|\n)(?:${escapeRegExp(SHARED_LOCATION_MARKER)}|${escapeRegExp(SHARED_CONTACTS_MARKER)})\n\{[\s\S]*?\}(?=\n|$)`,
  "g",
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove shared contact/location card blocks from text used for EIS.
 * Model-facing message may still contain the full blocks.
 */
export function stripSharedCardBlocksForEis(text: string): string {
  if (!text.trim()) {
    return "";
  }
  return text
    .replace(CARD_BLOCK_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Build Gate instruction text for one inbound utterance.
 * - forwarded → empty (body is UNTRUSTED_DATA; no invented substitute)
 * - otherwise strip shared card blocks
 */
export function gateInstructionTextFromUtterance(input: {
  utterance: string;
  forwarded?: boolean;
}): string {
  if (input.forwarded) {
    return "";
  }
  return stripSharedCardBlocksForEis(input.utterance);
}

/**
 * F21: text allowed for engine NL shortcuts (block sender / invite cancel).
 * Consult and explicit empty gateInstructionText → no free-text shortcuts.
 * Opaque button commands are handled separately on the raw inbound command.
 */
export function trustedNlInstructionForShortcuts(input: {
  consultFrom?: boolean;
  gateInstructionText?: string;
  inboundCommand: string;
}): string {
  if (input.consultFrom) {
    return "";
  }
  if (input.gateInstructionText !== undefined) {
    return input.gateInstructionText.trim();
  }
  return stripSharedCardBlocksForEis(input.inboundCommand);
}

/**
 * WhatsApp batch: only non-forwarded parts contribute to EIS; cards stripped.
 */
export function batchGateInstructionText(
  batch: Array<{ text: string; forwarded?: boolean }>,
): string {
  return batch
    .map((row) =>
      gateInstructionTextFromUtterance({
        utterance: row.text,
        forwarded: row.forwarded === true,
      }),
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}
