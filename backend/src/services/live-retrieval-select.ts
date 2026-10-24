/**
 * Generic post-retrieval live board selection (Phase A envelope).
 * Model picks opaque ids from a retrieved set; engine validates ⊆ set.
 * Required-selection failure never silently becomes keep-all.
 */
import {
  parseLiveSelectField,
  parseReplyMetadata,
  type LiveSelectParseStatus,
  type LlmLiveSelectDomain,
} from "@workee/shared";
import { loadLlmConfig } from "../config/llm.js";
import { getLlmClient, type LlmClient, type LlmTurn } from "./llm-client.js";
import {
  recordLlmUsage,
  type ComposeLlmBilling,
} from "./llm-usage.service.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";

export type LiveRetrievalRecord = {
  id: string;
  label: string;
  fields?: Record<string, unknown>;
};

export type LiveSelectApplyKind =
  | "structured_only"
  | "keep_all"
  | "subset"
  | "no_match"
  | "failure";

export type LiveSelectApplyResult = {
  kind: LiveSelectApplyKind;
  /** Ids to keep, in retrieval order. */
  keptIds: string[];
  /** Fixed Hebrew when kind is failure or no_match (engine may use as reply body). */
  messageHe?: string;
  /**
   * When kind=failure, caller may append the unfiltered board only if clearly
   * labeled — never imply the semantic filter succeeded.
   */
  mayShowUnfilteredLabeled: boolean;
};

/** Selection required but could not complete. */
export const LIVE_SELECT_FAILURE_HE =
  "לא הצלחתי לסנן את התוצאות לפי הבקשה. נסה שוב.";

/** Valid empty selection / zero ids after ⊆ validate. */
export const LIVE_SELECT_NO_MATCH_HE = "לא מצאתי התאמה בלוח שנטען.";

/** Label before optional raw board on failure (caller appends board text). */
export const LIVE_SELECT_UNFILTERED_LABEL_HE = "לוח מלא ללא סינון סמנטי:";

export type LiveSelectLlmDeps = {
  createConversation: () => Promise<string>;
  createResponse: LlmClient["createResponse"];
  model?: string;
  temperature?: number;
  recordUsage?: typeof recordLlmUsage;
};

/**
 * Keep retrieval order among requested ids; drop unknowns / cross-stash ids.
 */
export function filterIdsByLiveSelect(
  retrievalOrderIds: string[],
  requestedIds: string[],
): { kept: string[]; unknown: string[] } {
  const allowed = new Set(retrievalOrderIds);
  const requested = [...new Set(requestedIds.map((id) => id.trim()).filter(Boolean))];
  const unknown = requested.filter((id) => !allowed.has(id));
  const want = new Set(requested.filter((id) => allowed.has(id)));
  const kept = retrievalOrderIds.filter((id) => want.has(id));
  return { kept, unknown };
}

export function filterRecordsByIds<T extends { id: string }>(
  records: T[],
  keptIds: string[],
): T[] {
  const want = new Set(keptIds);
  return records.filter((row) => want.has(row.id));
}

/**
 * Resolve selection outcome from a parse status + retrieval id list.
 * When requireLiveSelect is false → structured_only (no M2 semantics).
 * When requireLiveSelect is true:
 *   - absent / malformed / null(keep_all) → failure (required filter not completed)
 *   - ids covering the full set → subset (legitimate “all match”; never via null)
 *   - empty / all-unknown ids → no_match
 */
export function resolveLiveSelectOutcome(input: {
  requireLiveSelect: boolean;
  parse: LiveSelectParseStatus;
  retrievalIds: string[];
  /** When parse.status=ids, domain must match expectedDomain if provided. */
  expectedDomain?: LlmLiveSelectDomain | string | null;
}): LiveSelectApplyResult {
  const retrievalIds = input.retrievalIds.map((id) => id.trim()).filter(Boolean);

  if (!input.requireLiveSelect) {
    return {
      kind: "structured_only",
      keptIds: retrievalIds,
      mayShowUnfilteredLabeled: false,
    };
  }

  const parse = input.parse;
  // Required residual filter: null/"keep_all" is a decline, not a successful filter.
  // Legitimate all-match must list every id explicitly (becomes subset).
  if (
    parse.status === "absent" ||
    parse.status === "malformed" ||
    parse.status === "keep_all"
  ) {
    return failureResult(retrievalIds);
  }

  if (
    input.expectedDomain &&
    parse.domain !== input.expectedDomain
  ) {
    return failureResult(retrievalIds);
  }

  if (parse.ids.length === 0) {
    return {
      kind: "no_match",
      keptIds: [],
      messageHe: LIVE_SELECT_NO_MATCH_HE,
      mayShowUnfilteredLabeled: false,
    };
  }

  const { kept } = filterIdsByLiveSelect(retrievalIds, parse.ids);
  if (kept.length === 0) {
    return {
      kind: "no_match",
      keptIds: [],
      messageHe: LIVE_SELECT_NO_MATCH_HE,
      mayShowUnfilteredLabeled: false,
    };
  }

  return {
    kind: "subset",
    keptIds: kept,
    mayShowUnfilteredLabeled: false,
  };
}

function failureResult(_retrievalIds: string[]): LiveSelectApplyResult {
  return {
    kind: "failure",
    keptIds: [],
    messageHe: LIVE_SELECT_FAILURE_HE,
    mayShowUnfilteredLabeled: true,
  };
}

/** Build optional failure reply: failure line + labeled unfiltered board. */
export function formatLiveSelectFailureReply(
  unfilteredBoardHe: string,
  options?: { includeUnfiltered?: boolean },
): string {
  const include = options?.includeUnfiltered !== false;
  const board = unfilteredBoardHe.trim();
  if (!include || !board) {
    return LIVE_SELECT_FAILURE_HE;
  }
  return `${LIVE_SELECT_FAILURE_HE}\n\n${LIVE_SELECT_UNFILTERED_LABEL_HE}\n${board}`;
}

function parseSelectTurnReply(reply: string): LiveSelectParseStatus {
  const text = reply.trim();
  if (!text) {
    return { status: "malformed" };
  }
  // Prefer full Lucy-shaped JSON via parseReplyMetadata.
  try {
    const meta = parseReplyMetadata(text);
    if (meta.liveSelectMalformed) {
      return { status: "malformed" };
    }
    if (meta.liveSelect === null) {
      return { status: "keep_all" };
    }
    if (meta.liveSelect) {
      return {
        status: "ids",
        domain: meta.liveSelect.domain,
        ids: meta.liveSelect.liveRecordIds,
      };
    }
  } catch {
    // fall through
  }
  // Bare { live_select: ... } object.
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const row = parsed as Record<string, unknown>;
      if ("live_select" in row || "liveSelect" in row) {
        return parseLiveSelectField(row.live_select ?? row.liveSelect);
      }
      // Object that is itself the live_select payload.
      if ("domain" in row && ("live_record_ids" in row || "liveRecordIds" in row)) {
        return parseLiveSelectField(row);
      }
    }
  } catch {
    return { status: "malformed" };
  }
  return { status: "malformed" };
}

/**
 * Same-turn select LLM pass. Always treats selection as required.
 * On transport/parse failure → kind=failure (never silent keep-all).
 */
export async function runLivePostSelect(input: {
  domain: LlmLiveSelectDomain;
  records: LiveRetrievalRecord[];
  speakerAsk: string;
  billing?: ComposeLlmBilling | null;
  deps?: LiveSelectLlmDeps | null;
}): Promise<LiveSelectApplyResult> {
  const retrievalIds = input.records.map((row) => row.id).filter(Boolean);
  const fail = () => failureResult(retrievalIds);

  if (retrievalIds.length === 0) {
    return {
      kind: "no_match",
      keptIds: [],
      messageHe: LIVE_SELECT_NO_MATCH_HE,
      mayShowUnfilteredLabeled: false,
    };
  }

  const deps = input.deps ?? defaultDeps();
  const model = deps.model ?? loadLlmConfig().model;
  const temperature = deps.temperature ?? 0;

  let turn: LlmTurn;
  let openaiConversationId: string;
  try {
    openaiConversationId = await deps.createConversation();
    turn = await deps.createResponse({
      conversationId: openaiConversationId,
      model,
      temperature,
      instructions: LIVE_SELECT_INSTRUCTIONS,
      message: [
        `Speaker ask:\n${input.speakerAsk.trim() || "(empty)"}`,
        `Domain: ${input.domain}`,
        "LIVE_RETRIEVAL_SET (JSON — select ONLY from these ids):",
        JSON.stringify(
          input.records.map((row) => ({
            id: row.id,
            label: row.label,
            ...(row.fields ? { fields: row.fields } : {}),
          })),
        ),
        "Return JSON with metadata.live_select = { domain, live_record_ids } — list every matching id from LIVE_RETRIEVAL_SET (all ids if all match; [] if none). Do not return null.",
      ].join("\n\n"),
    });
  } catch (error) {
    recordWhatsAppEvent(
      "live_select_failed",
      error instanceof Error ? error.message : "unknown",
    );
    return fail();
  }

  if (input.billing) {
    const recordUsage = deps.recordUsage ?? recordLlmUsage;
    await recordUsage({
      conversationId: input.billing.conversationId,
      employeeId: input.billing.employeeId,
      digitalEmployeeId: input.billing.digitalEmployeeId,
      openaiConversationId,
      model,
      turn,
      purpose: "live_select",
    });
  }

  const parse = parseSelectTurnReply(turn.reply ?? "");
  return resolveLiveSelectOutcome({
    requireLiveSelect: true,
    parse,
    retrievalIds,
    expectedDomain: input.domain,
  });
}

function defaultDeps(): LiveSelectLlmDeps {
  const client = getLlmClient();
  return {
    createConversation: () => client.createConversation(),
    createResponse: (req) => client.createResponse(req),
  };
}

const LIVE_SELECT_INSTRUCTIONS = [
  "You select rows from a live retrieval set for Workee (same-turn select pass).",
  "Output JSON only: {\"responses\":[],\"metadata\":{\"live_select\": ...}}.",
  "Selection is REQUIRED this turn: never return live_select null.",
  "live_select object = {\"domain\":\"<same domain>\",\"live_record_ids\":[...]} — ids ONLY from LIVE_RETRIEVAL_SET.",
  "If every row matches, list EVERY id from LIVE_RETRIEVAL_SET (do not use null).",
  "Empty live_record_ids = no matching rows (criteria checked against returned fields and none matched).",
  "Keep a row only when returned fields give enough evidence for the residual criteria in the speaker ask.",
  "If a criterion cannot be verified from the fields (null/missing/insufficient), do NOT treat that criterion as satisfied — exclude the row for that criterion.",
  "Never invent evidence, ids, airlines, places, times, or rows absent from LIVE_RETRIEVAL_SET.",
  "Never claim a criterion was verified when fields lack supporting facts.",
  "Do not claim the set is exhaustive beyond what was retrieved.",
  "No other metadata actions.",
].join("\n");
