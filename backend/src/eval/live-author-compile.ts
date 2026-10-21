/**
 * Intent → LIVE corpus compiler.
 *
 * Authors describe product intents (ask / remove_item / …); this module emits
 * the constraint-based case shape runners already understand. Future Test Studio
 * UI should call compileLiveAuthorDraft — humans never hand-write ACTION schema.
 */
import type { ModelEvalConstraint, ModelEvalTag } from "./constraints.js";
import type {
  LiveFullCorpusCase,
  ModelEvalCorpusCase,
  ModelEvalMultiTurnCase,
} from "./corpus.js";
import type { RegressionStateAssert } from "./corpus.js";

export type LiveAuthorTrack = "model" | "mt" | "full";

export type LiveAuthorIntent =
  | { type: "ask" }
  | {
      type: "remove_item";
      listType: "shopping" | "tasks";
      itemId: string;
    }
  | { type: "add_shopping"; itemText: string }
  | { type: "add_task"; itemText: string }
  | { type: "reminder_add" }
  | { type: "filing_add"; infoIncludes?: string }
  | { type: "filing_remove"; filingId?: string }
  | { type: "directory_add"; nameIncludes?: string }
  | { type: "directory_remove"; contactIds: string[] }
  | { type: "show_dump"; value?: string }
  | {
      type: "share_update";
      listType: "shopping" | "tasks" | "custom";
      action?: "update" | "add";
    }
  | { type: "custom"; constraints: ModelEvalConstraint[] };

export type LiveAuthorOutcome = {
  itemIdsAbsent?: string[];
  itemIdsPresent?: string[];
  factsInclude?: string[];
  factsExclude?: string[];
  contactNamesInclude?: string[];
  contactNamesExclude?: string[];
};

export type LiveAuthorTurn = {
  utterance: string;
  intent: LiveAuthorIntent;
  /** LIVE_FULL only; if omitted, synthesized from intent when possible. */
  outcome?: LiveAuthorOutcome;
};

export type LiveAuthorShoppingItem = {
  id: string;
  label: string;
};

export type LiveAuthorDraft = {
  id: string;
  track: LiveAuthorTrack;
  description?: string;
  tag?: ModelEvalTag | string;
  tags?: string[];
  /**
   * Full setup (same as corpora), or shoppingItems shorthand which expands to
   * a personal shopping list seed.
   */
  setup?: ModelEvalCorpusCase["setup"] & {
    shoppingItems?: LiveAuthorShoppingItem[];
  };
  turns: LiveAuthorTurn[];
};

export type CompiledLiveCase =
  | {
      track: "model";
      case: ModelEvalCorpusCase;
    }
  | {
      track: "mt";
      case: ModelEvalMultiTurnCase;
    }
  | {
      track: "full";
      case: LiveFullCorpusCase;
    };

export class LiveAuthorCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveAuthorCompileError";
  }
}

function shoppingSetupFromItems(
  items: LiveAuthorShoppingItem[],
): NonNullable<ModelEvalCorpusCase["setup"]> {
  return {
    lists: [
      {
        list_id: "eval-list-shopping-personal",
        list_type: "shopping",
        owner: "טל",
        scope: "personal",
        items: items.map((row) => ({
          item_id: row.id,
          "שם פריט": row.label,
        })),
      },
    ],
  };
}

function emptyShoppingSetup(): NonNullable<ModelEvalCorpusCase["setup"]> {
  return {
    lists: [
      {
        list_id: "eval-list-shopping-personal",
        list_type: "shopping",
        owner: "טל",
        scope: "personal",
        items: [],
      },
    ],
  };
}

function resolveSetup(
  draft: LiveAuthorDraft,
): ModelEvalCorpusCase["setup"] | undefined {
  const raw = draft.setup;
  if (!raw) return undefined;
  const { shoppingItems, ...rest } = raw;
  if (shoppingItems?.length) {
    const fromItems = shoppingSetupFromItems(shoppingItems);
    const lists = [
      ...(fromItems.lists ?? []),
      ...((rest.lists as typeof fromItems.lists) ?? []),
    ];
    return { ...rest, lists };
  }
  return rest;
}

function constraintsForIntent(intent: LiveAuthorIntent): ModelEvalConstraint[] {
  switch (intent.type) {
    case "ask":
      return [
        { type: "mutations_empty_or_read_only" },
        { type: "response_looks_like_ask" },
      ];
    case "remove_item":
      return [
        {
          type: "lists_remove_item_ids",
          listType: intent.listType,
          itemIds: [intent.itemId],
        },
        { type: "list_ops_empty" },
      ];
    case "add_shopping":
      return [
        {
          type: "lists_has_action",
          action: "add",
          listType: "shopping",
          itemTextIncludes: intent.itemText,
        },
      ];
    case "add_task":
      return [
        {
          type: "lists_has_action",
          action: "add",
          listType: "tasks",
          itemTextIncludes: intent.itemText,
        },
      ];
    case "reminder_add":
      return [
        { type: "reminders_has_action", action: "add" },
        { type: "lists_has_action", action: "add", listType: "tasks" },
      ];
    case "filing_add":
      return [
        {
          type: "filing_has_action",
          action: "add_filing",
          ...(intent.infoIncludes
            ? { infoIncludes: intent.infoIncludes }
            : {}),
        },
      ];
    case "filing_remove":
      return [
        {
          type: "filing_has_action",
          action: "remove_filing",
          ...(intent.filingId ? { filingId: intent.filingId } : {}),
        },
        { type: "lists_empty" },
      ];
    case "directory_add":
      return [
        {
          type: "directory_has_action",
          action: "add",
          ...(intent.nameIncludes
            ? { nameIncludes: intent.nameIncludes }
            : {}),
        },
      ];
    case "directory_remove":
      return [
        {
          type: "directory_remove_contact_ids",
          contactIds: intent.contactIds,
        },
      ];
    case "show_dump":
      return [
        { type: "show_dump", value: intent.value ?? "full" },
        { type: "mutations_empty_or_read_only" },
      ];
    case "share_update":
      return [
        {
          type: "lists_has_action",
          action: intent.action ?? "update",
          listType: intent.listType,
        },
      ];
    case "custom":
      if (!intent.constraints?.length) {
        throw new LiveAuthorCompileError(
          "custom intent requires non-empty constraints",
        );
      }
      return intent.constraints;
    default: {
      const _exhaustive: never = intent;
      throw new LiveAuthorCompileError(
        `unknown intent: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

function synthesizeOutcome(
  intent: LiveAuthorIntent,
): LiveAuthorOutcome | undefined {
  switch (intent.type) {
    case "remove_item":
      return { itemIdsAbsent: [intent.itemId] };
    case "add_shopping":
      return { factsInclude: [intent.itemText] };
    case "add_task":
      return { factsInclude: [intent.itemText] };
    case "reminder_add":
      return { factsInclude: ["מים"] };
    case "filing_add":
      return intent.infoIncludes
        ? { factsInclude: [intent.infoIncludes] }
        : undefined;
    case "directory_add":
      return intent.nameIncludes
        ? { contactNamesInclude: [intent.nameIncludes] }
        : undefined;
    default:
      return undefined;
  }
}

function toStateAfter(
  outcome: LiveAuthorOutcome | undefined,
): RegressionStateAssert | undefined {
  if (!outcome) return undefined;
  const state: RegressionStateAssert = {};
  if (outcome.itemIdsAbsent?.length) state.itemIdsAbsent = outcome.itemIdsAbsent;
  if (outcome.itemIdsPresent?.length) {
    state.itemIdsPresent = outcome.itemIdsPresent;
  }
  if (outcome.factsInclude?.length) state.factsInclude = outcome.factsInclude;
  if (outcome.factsExclude?.length) state.factsExclude = outcome.factsExclude;
  if (outcome.contactNamesInclude?.length) {
    state.contactNamesInclude = outcome.contactNamesInclude;
  }
  if (outcome.contactNamesExclude?.length) {
    state.contactNamesExclude = outcome.contactNamesExclude;
  }
  return Object.keys(state).length ? state : undefined;
}

function defaultTags(
  track: LiveAuthorTrack,
  turns: LiveAuthorTurn[],
): string[] {
  const tags = new Set<string>();
  if (track === "full") tags.add("full-live");
  if (turns.length >= 2 || track === "mt") tags.add("multi-turn");
  else tags.add("single-turn");

  for (const turn of turns) {
    switch (turn.intent.type) {
      case "ask":
        // Alone → task-empty-ask style; with other intents, those own the tags.
        if (turns.length === 1) tags.add("tasks");
        break;
      case "remove_item":
        tags.add(turn.intent.listType === "tasks" ? "tasks" : "shopping");
        break;
      case "add_shopping":
        tags.add("shopping");
        break;
      case "add_task":
        tags.add("tasks");
        break;
      case "reminder_add":
        tags.add("reminders");
        break;
      case "filing_add":
      case "filing_remove":
        tags.add("filing");
        break;
      case "directory_add":
      case "directory_remove":
        tags.add("directory");
        break;
      case "show_dump":
        tags.add("show");
        break;
      case "share_update":
        tags.add("share");
        tags.add(
          turn.intent.listType === "tasks" ? "tasks" : "shopping",
        );
        break;
      default:
        break;
    }
  }
  return [...tags];
}

function defaultTag(turns: LiveAuthorTurn[]): ModelEvalTag | string {
  if (turns.length >= 2) return "continuity";
  if (turns.some((t) => t.intent.type === "ask")) return "action-confusion";
  return "happy";
}

function defaultDescription(turns: LiveAuthorTurn[]): string {
  if (turns.length === 0) return "LIVE author draft";
  if (turns.length === 1) {
    const intent = turns[0]!.intent;
    switch (intent.type) {
      case "ask":
        return "Incomplete request → ask (no mutations)";
      case "remove_item":
        return `Remove ${intent.listType} item ${intent.itemId}`;
      case "add_shopping":
        return `Add ${intent.itemText} to shopping`;
      case "add_task":
        return `Add task ${intent.itemText}`;
      case "reminder_add":
        return "Relative self-nudge";
      case "filing_add":
        return "Add filing";
      case "filing_remove":
        return "Remove filing";
      case "directory_add":
        return "Add directory contact";
      case "directory_remove":
        return "Remove directory contact";
      case "show_dump":
        return "Show saved dump";
      case "share_update":
        return `Share/update ${intent.listType}`;
      case "custom":
        return "Custom intent turn";
    }
  }
  return `Multi-turn (${turns.length} turns)`;
}

/**
 * Build a product-language draft from legacy CLI template names.
 * Keeps add-live-case UX while routing through the compiler.
 */
export function draftFromTemplate(opts: {
  track: LiveAuthorTrack;
  template: string;
  id: string;
  utterance?: string;
  utterance2?: string;
  itemId?: string;
  itemLabel?: string;
  tags?: string[];
  description?: string;
}): LiveAuthorDraft {
  const itemId = opts.itemId ?? "eval-item-milk";
  const itemLabel = opts.itemLabel ?? "חלב";
  const track = opts.track;

  switch (opts.template) {
    case "ask":
      return {
        id: opts.id,
        track,
        description: opts.description,
        tags: opts.tags,
        setup: {},
        turns: [
          {
            utterance: opts.utterance || "תוסיפי מטלה",
            intent: { type: "ask" },
          },
        ],
      };
    case "remove-id":
      return {
        id: opts.id,
        track,
        description: opts.description,
        tags: opts.tags,
        setup: { shoppingItems: [{ id: itemId, label: itemLabel }] },
        turns: [
          {
            utterance: opts.utterance || `קניתי ${itemLabel}`,
            intent: {
              type: "remove_item",
              listType: "shopping",
              itemId,
            },
          },
        ],
      };
    case "add-shopping":
      return {
        id: opts.id,
        track,
        description: opts.description,
        tags: opts.tags,
        setup: track === "full" ? emptyShoppingSetup() : {},
        turns: [
          {
            utterance: opts.utterance || `תוסיפי ${itemLabel} לקניות`,
            intent: { type: "add_shopping", itemText: itemLabel },
          },
        ],
      };
    case "reminder-add":
      return {
        id: opts.id,
        track,
        description: opts.description,
        tags: opts.tags,
        setup: {},
        turns: [
          {
            utterance: opts.utterance || "תזכירי לי בעוד שעה לשתות מים",
            intent: { type: "reminder_add" },
          },
        ],
      };
    case "clarify-act":
      return {
        id: opts.id,
        track: track === "model" ? "mt" : track,
        description: opts.description,
        tags: opts.tags,
        setup: { shoppingItems: [{ id: itemId, label: itemLabel }] },
        turns: [
          {
            utterance: opts.utterance || "תמחק את זה",
            intent: { type: "ask" },
            outcome:
              track === "full" ? { factsInclude: [itemLabel] } : undefined,
          },
          {
            utterance: opts.utterance2 || `את ה${itemLabel}`,
            intent: {
              type: "remove_item",
              listType: "shopping",
              itemId,
            },
          },
        ],
      };
    default:
      throw new LiveAuthorCompileError(
        `Unknown template "${opts.template}". Use: ask, remove-id, add-shopping, reminder-add, clarify-act`,
      );
  }
}

/** Compile a product-language draft into a corpus case + resolved track. */
export function compileLiveAuthorDraft(draft: LiveAuthorDraft): CompiledLiveCase {
  if (!draft?.id?.trim()) {
    throw new LiveAuthorCompileError("draft.id is required");
  }
  if (!Array.isArray(draft.turns) || draft.turns.length === 0) {
    throw new LiveAuthorCompileError(`draft ${draft.id}: turns required`);
  }
  for (let i = 0; i < draft.turns.length; i++) {
    const turn = draft.turns[i]!;
    if (typeof turn.utterance !== "string") {
      throw new LiveAuthorCompileError(
        `draft ${draft.id} turn ${i}: utterance required`,
      );
    }
    if (!turn.intent || typeof turn.intent !== "object" || !("type" in turn.intent)) {
      throw new LiveAuthorCompileError(
        `draft ${draft.id} turn ${i}: intent required`,
      );
    }
  }

  let track: LiveAuthorTrack = draft.track;
  if (!["model", "mt", "full"].includes(track)) {
    throw new LiveAuthorCompileError(`unsupported track: ${String(track)}`);
  }
  // Auto-route multi-turn drafts off the single-turn model corpus.
  if (track === "model" && draft.turns.length >= 2) {
    track = "mt";
  }

  const setup = resolveSetup(draft) ?? {};
  const tags = [
    ...new Set([
      ...(draft.tags ?? []),
      ...defaultTags(track, draft.turns),
    ]),
  ];
  const tag = draft.tag ?? defaultTag(draft.turns);
  const description = draft.description ?? defaultDescription(draft.turns);

  const compiledTurns = draft.turns.map((turn) => {
    const constraints = constraintsForIntent(turn.intent);
    const outcome =
      track === "full"
        ? (turn.outcome ?? synthesizeOutcome(turn.intent))
        : turn.outcome;
    const stateAfter =
      track === "full" ? toStateAfter(outcome) : undefined;
    return {
      utterance: turn.utterance,
      constraints,
      ...(stateAfter ? { stateAfter } : {}),
    };
  });

  if (track === "full") {
    return {
      track: "full",
      case: {
        id: draft.id,
        tag,
        tags,
        description,
        setup,
        turns: compiledTurns,
      },
    };
  }

  if (track === "mt") {
    return {
      track: "mt",
      case: {
        id: draft.id,
        tag: tag as ModelEvalTag,
        tags,
        description,
        setup,
        turns: compiledTurns.map((t) => ({
          utterance: t.utterance,
          constraints: t.constraints,
        })),
      },
    };
  }

  // Single-turn LIVE_MODEL: flatten to utterance + constraints (no description field on corpus type).
  const only = compiledTurns[0]!;
  return {
    track: "model",
    case: {
      id: draft.id,
      tag: tag as ModelEvalTag,
      tags,
      utterance: only.utterance,
      setup,
      constraints: only.constraints,
    },
  };
}

/** Corpus paths relative to repo root (CLI / Test Studio). */
export const LIVE_AUTHOR_CORPUS_RELATIVE: Record<LiveAuthorTrack, string> = {
  model: "docs/qa/phase-4-corpus.json",
  mt: "docs/qa/phase-4-multi-turn-corpus.json",
  full: "docs/qa/live-full-corpus.json",
};
