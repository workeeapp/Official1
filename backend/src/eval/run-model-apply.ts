/**
 * Batch A MODEL_APPLY multi-turn harness.
 *
 * Decision source = model-proposed ACTION (via proposeTurn), never fixtureMetadata.
 * After each mutating turn: production applyListOps + applyEmployeeRecords →
 * snapshot → formatEmployeeContext reinjected into the next turn.
 *
 * Offline tests inject a stub proposeTurn — this module must not import an LLM client.
 */
import {
  emptyLlmMetadata,
  parseLlmMetadata,
  type LlmMetadata,
} from "@workee/shared";
import {
  emptyAttachmentOutcome,
  mergeAttachmentOutcomes,
  withAttachmentRefs,
  type AttachmentApplyOutcome,
} from "../services/attachment.service.js";
import {
  applyEmployeeRecords,
  correctAttachmentClaimReply,
  correctDurableSaveClaimReply,
  correctListMutationClaimReply,
  correctShareClaimReply,
  correctUnshareClaimReply,
  formatAppliedMutationFallback,
  formatEmployeeContext,
  getEmployeeRecordSnapshot,
  loadFilingOwners,
  loadListItemOwners,
  summarizeUnshareApply,
  type EmployeeRecordSnapshot,
  type FilingMutation,
  type ListItemMutation,
  type ShareApplyMiss,
} from "../services/employee-records.service.js";
import {
  fillBlankCustomListNameFromSameTurnLinks,
  withLinkedListRefs,
} from "../services/list-item-list-link.service.js";
import type { EvalRawActionDiagnostic } from "./raw-action-diagnostic.js";
import {
  applyDirectoryActions,
  listContactsForEmployee,
} from "../services/contact.service.js";
import {
  applyListOps,
  type ListOpResult,
} from "../services/list-ops.service.js";
import { applyReminders } from "../services/reminder.service.js";
import {
  filingActionIds,
  listActionItemIds,
  planTargetedActions,
} from "../services/employee-targets.service.js";
import { evaluateConstraints } from "./constraints.js";
import type { ModelEvalConstraint } from "./constraints.js";
import type { StudioTurn } from "./corpus.js";
import { assertApprovedEvalDatabaseUrl } from "./studio-db-guard.js";
import {
  assertRegressionState,
  collectPartnerNamesFromSetup,
  createHarnessAccount,
  destroyHarnessAccount,
  mapStateAssert,
  rewriteAliases,
  seedSetup,
  type HarnessAccount,
  type MultiTurnTurnResult,
} from "./run-multi-turn.js";

export type ModelApplyTrack = "MODEL_APPLY";

export interface ModelApplyCase {
  id: string;
  track: ModelApplyTrack;
  tag?: string;
  description?: string;
  setup?: StudioTurn["setup"];
  turns: Array<{
    utterance: string;
    /** Forbidden on MODEL_APPLY — must be absent/null. */
    fixtureMetadata?: unknown | null;
    constraints?: ModelEvalConstraint[];
    stateAfter?: StudioTurn["stateAfter"];
    response?: string;
  }>;
}

export interface ModelApplyProposeInput {
  turnIndex: number;
  utterance: string;
  facts: string;
  snapshot: EmployeeRecordSnapshot;
  account: HarnessAccount;
  /** Prior turns' model metadata (for multi-turn stubs). */
  priorMetadata: LlmMetadata[];
}

export interface ModelApplyProposeResult {
  /** Model-proposed ACTION (decision source). */
  metadata: LlmMetadata | unknown;
  response?: string;
  /**
   * Eval-only: raw lists/filing before parse/normalize (LIVE_FULL diagnostics).
   * Distinguishes empty model emission from silent parse drops.
   */
  rawActionDiagnostic?: EvalRawActionDiagnostic;
}

/**
 * Harness-only bridge for raw propose shapes that already use camelCase
 * `listType` without snake `list_type`. Prefer skipping re-parse via
 * {@link metadataFromModelApplyPropose} when the value is already normalized.
 *
 * Copies `listType` → `list_type` on lists[] when snake is absent. Does not
 * invent shopping/tasks from Hebrew or change apply semantics.
 */
export function bridgeListTypeAliasesForParse(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const root = { ...(value as Record<string, unknown>) };
  if (!Array.isArray(root.lists)) {
    return root;
  }
  root.lists = root.lists.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }
    const row = { ...(entry as Record<string, unknown>) };
    const snake = row.list_type;
    const camel = row.listType;
    if (
      (snake == null || snake === "") &&
      typeof camel === "string" &&
      camel.trim()
    ) {
      row.list_type = camel.trim();
    }
    return row;
  });
  return root;
}

/**
 * True when `value` is already parseLlmMetadata / parseReplyMetadata output
 * (camelCase listType / itemName), so a second parse would only risk drops.
 * Raw snake stubs (`list_type` / `item_name` only) return false.
 */
export function isNormalizedLlmMetadata(value: unknown): value is LlmMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const meta = value as Record<string, unknown>;

  if (Array.isArray(meta.lists)) {
    for (const entry of meta.lists) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const row = entry as Record<string, unknown>;
      if (typeof row.listType === "string") {
        return true;
      }
      if (typeof row.list_type === "string" && row.listType === undefined) {
        return false;
      }
    }
  }

  if (Array.isArray(meta.filing)) {
    for (const entry of meta.filing) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const row = entry as Record<string, unknown>;
      if (typeof row.itemName === "string") {
        return true;
      }
      if (typeof row.item_name === "string" && row.itemName === undefined) {
        return false;
      }
      if (
        (row.action === "add_filing" ||
          row.action === "remove_filing" ||
          row.action === "update_filing") &&
        ("filingId" in row || "itemName" in row)
      ) {
        return true;
      }
    }
  }

  // Empty already-parsed envelope (LIVE ask-only / emptyLlmMetadata).
  if (
    Array.isArray(meta.lists) &&
    Array.isArray(meta.filing) &&
    Array.isArray(meta.reminders) &&
    Array.isArray(meta.messages) &&
    meta.lists.length === 0 &&
    meta.filing.length === 0
  ) {
    return true;
  }

  return false;
}

/**
 * Prepare propose metadata for constraints + apply: rewrite symbolic ids, then
 * parse only when still raw. LIVE_FULL propose already returns parseReplyMetadata
 * output — re-parsing that object used to drop camelCase filing/list fields.
 */
export function metadataFromModelApplyPropose(
  proposedMetadata: unknown,
  idMap: Map<string, string> = new Map(),
): LlmMetadata {
  const rewritten = rewriteAliases(proposedMetadata, idMap);
  if (isNormalizedLlmMetadata(rewritten)) {
    return rewritten;
  }
  return parseLlmMetadata(bridgeListTypeAliasesForParse(rewritten));
}

/**
 * Fail closed before any Prisma use. Never logs URL/credentials.
 */
export function assertModelApplyDatabaseApproved(): void {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
}

function metadataHasMutations(metadata: LlmMetadata): boolean {
  const lists = metadata.lists?.length ?? 0;
  const listOps = metadata.listOps?.length ?? 0;
  const filing = metadata.filing?.length ?? 0;
  const directory = metadata.directory?.length ?? 0;
  const reminders = metadata.reminders?.length ?? 0;
  return lists + listOps + filing + directory + reminders > 0;
}

export type ModelApplyTurnApplyResult = {
  mutations: ListItemMutation[];
  filingMutations: FilingMutation[];
  shareMisses: ShareApplyMiss[];
  attachmentOutcome: AttachmentApplyOutcome;
  listOpResults: ListOpResult[];
};

/**
 * Align spoken reply with apply evidence (same correctors / order as chat.service).
 * Pure: used after apply, and when apply is skipped (empty outcomes).
 * Does not invent success from requested ACTION or appliedViaProduction alone.
 */
export function correctModelApplyTurnResponse(input: {
  response: string;
  metadata: LlmMetadata;
  mutations?: ListItemMutation[];
  filingMutations?: FilingMutation[];
  shareMisses?: ShareApplyMiss[];
  attachmentOutcome?: AttachmentApplyOutcome;
  listOpResults?: ListOpResult[];
  /** Post-apply live snapshot — used to detect incomplete shopping/tasks unshare. */
  snapshotAfter?: EmployeeRecordSnapshot | null;
}): string {
  const mutations = input.mutations ?? [];
  const filingMutations = input.filingMutations ?? [];
  const shareMisses = input.shareMisses ?? [];
  const attachmentOutcome =
    input.attachmentOutcome ?? emptyAttachmentOutcome();
  const listOpResults = input.listOpResults ?? [];
  const metadata = input.metadata;

  const setResponse = (_reply: string, next: string) => next;
  let working = input.response;
  const spoken = () => working;

  const requestedListRemove = (metadata.lists ?? []).some(
    (row) => row.action === "remove",
  );
  const requestedListUpdate = (metadata.lists ?? []).some(
    (row) => row.action === "update",
  );
  const requestedListAdd = (metadata.lists ?? []).some(
    (row) => row.action === "add",
  );
  const requestedFilingAdd = (metadata.filing ?? []).some(
    (row) => row.action === "add_filing",
  );
  const requestedFilingUpdate = (metadata.filing ?? []).some(
    (row) => row.action === "update_filing",
  );
  const appliedListRemove = mutations.some(
    (row) => row.action === "remove" && !row.listShell,
  );
  const appliedListUpdate = mutations.some(
    (row) => row.action === "update" && !row.listShell,
  );
  const appliedListAdd = mutations.some(
    (row) => row.action === "add" && !row.listShell,
  );
  const appliedListOps = listOpResults.some((row) => row.applied);
  const appliedFilingRemove = filingMutations.some(
    (row) => row.action === "remove",
  );
  const appliedFilingUpdate = filingMutations.some(
    (row) => row.action === "update",
  );
  const appliedFilingAdd = filingMutations.some(
    (row) => row.action === "add",
  );
  const appliedFallback = formatAppliedMutationFallback(
    mutations,
    filingMutations,
  );

  working = correctListMutationClaimReply({
    reply: working,
    requestedRemove: requestedListRemove,
    requestedUpdate: requestedListUpdate,
    requestedAdd: requestedListAdd,
    appliedRemove: appliedListRemove,
    appliedUpdate: appliedListUpdate,
    appliedAdd: appliedListAdd,
    appliedFallback,
    setResponse,
    spoken: spoken(),
    appliedListOps,
    appliedFilingRemove,
    appliedFilingUpdate,
  });
  working = correctShareClaimReply({
    reply: working,
    spoken: spoken(),
    mutations,
    misses: shareMisses,
    setResponse,
  });
  working = correctUnshareClaimReply({
    reply: working,
    spoken: spoken(),
    summary: summarizeUnshareApply({
      metadata,
      mutations,
      snapshotAfter: input.snapshotAfter ?? null,
    }),
    setResponse,
  });
  working = correctAttachmentClaimReply({
    reply: working,
    spoken: spoken(),
    outcome: attachmentOutcome,
    setResponse,
  });
  working = correctDurableSaveClaimReply({
    reply: working,
    spoken: spoken(),
    requestedListAdd,
    requestedListUpdate,
    requestedFilingAdd,
    requestedFilingUpdate,
    appliedListAdd,
    appliedListUpdate,
    appliedFilingAdd,
    appliedFilingUpdate,
    setResponse,
  });
  return working;
}

/**
 * Apply a model-proposed ACTION through production paths (no symbolic rewrite).
 *
 * Mirrors chat.service list/filing targeting: planTargetedActions →
 * applyEmployeeRecords per application (co-share vs assign visibility).
 * Still skips full sendChatMessage (dumps, tips, WA); reply correction is
 * applied by the caller via correctModelApplyTurnResponse.
 */
export async function applyModelMetadataTurn(input: {
  account: HarnessAccount;
  metadata: LlmMetadata;
}): Promise<
  ModelApplyTurnApplyResult & {
    metadata: LlmMetadata;
    appliedViaProduction: true;
  }
> {
  // Fail closed before any production apply / Prisma side effect.
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);

  const account = input.account;
  const metadata = fillBlankCustomListNameFromSameTurnLinks(input.metadata);
  const humans = account.employees.filter((row) => row.kind !== "digital");

  let listOpResults: ListOpResult[] = [];
  let attachmentOutcome = emptyAttachmentOutcome();
  if ((metadata.listOps?.length ?? 0) > 0) {
    listOpResults = await applyListOps({
      userId: account.userId,
      actor: account.actor,
      employees: humans,
      ops: metadata.listOps ?? [],
    });
    for (const row of listOpResults) {
      if (row.attachmentOutcome) {
        attachmentOutcome = mergeAttachmentOutcomes(
          attachmentOutcome,
          row.attachmentOutcome,
        );
      }
    }
  }

  const metadataForApply = {
    ...metadata,
    lists: [
      ...(metadata.lists ?? []).filter((row) => row.action !== "remove"),
      ...(metadata.lists ?? []).filter((row) => row.action === "remove"),
    ],
  };
  const itemOwners = await loadListItemOwners(
    account.userId,
    listActionItemIds(metadataForApply.lists ?? []),
  );
  const filingOwners = await loadFilingOwners(
    account.userId,
    filingActionIds(metadataForApply.filing ?? []),
  );
  const plan = planTargetedActions({
    actor: account.actor,
    employees: humans,
    metadata: metadataForApply,
    itemOwners,
    filingOwners,
  });

  const mutations: ListItemMutation[] = [];
  const filingMutations: FilingMutation[] = [];
  const shareMisses: ShareApplyMiss[] = [];
  for (const application of plan.applications) {
    const applied = await applyEmployeeRecords(
      application.employeeId,
      application.metadata,
      application.visibility,
      account.actor.id,
    );
    mutations.push(...applied.mutations);
    filingMutations.push(...applied.filingMutations);
    shareMisses.push(...applied.shareMisses);
    attachmentOutcome = mergeAttachmentOutcomes(
      attachmentOutcome,
      applied.attachmentOutcome,
    );
  }

  // Production path (chat.service): clocks go through applyReminders, not records alone.
  if ((metadata.reminders?.length ?? 0) > 0) {
    const reminderWrites = [
      ...(metadata.reminders ?? []).filter((row) => row.action !== "remove"),
      ...(metadata.reminders ?? []).filter((row) => row.action === "remove"),
    ];
    await applyReminders({
      userId: account.userId,
      actor: account.actor,
      employees: humans,
      reminders: reminderWrites,
    });
  }

  if ((metadata.directory?.length ?? 0) > 0) {
    await applyDirectoryActions({
      userId: account.userId,
      ownerEmployeeId: account.employeeId,
      actions: metadata.directory ?? [],
      employees: humans,
    });
  }

  return {
    metadata,
    appliedViaProduction: true,
    mutations,
    filingMutations,
    shareMisses,
    attachmentOutcome,
    listOpResults,
  };
}

async function enrichSnapshot(
  employeeId: string,
): Promise<{ snapshot: EmployeeRecordSnapshot; facts: string }> {
  const rawSnapshot = await getEmployeeRecordSnapshot(employeeId);
  const snapshot = await withLinkedListRefs(
    await withAttachmentRefs(rawSnapshot),
  );
  return { snapshot, facts: formatEmployeeContext(snapshot) };
}

export interface ModelApplyCaseResult {
  id: string;
  track: ModelApplyTrack;
  ok: boolean;
  failures: string[];
  turns: MultiTurnTurnResult[];
}

/**
 * Run one MODEL_APPLY case. `proposeTurn` supplies model ACTIONs (stub or live).
 * Refuses fixtureMetadata on any turn.
 */
export async function runModelApplyCase(
  suiteCase: ModelApplyCase,
  proposeTurn: (
    input: ModelApplyProposeInput,
  ) => Promise<ModelApplyProposeResult> | ModelApplyProposeResult,
  options?: { speaker?: string; partners?: string[] },
): Promise<ModelApplyCaseResult> {
  const speaker = options?.speaker ?? "טל";
  const failures: string[] = [];
  const turnResults: MultiTurnTurnResult[] = [];

  if (suiteCase.track !== "MODEL_APPLY") {
    return {
      id: suiteCase.id,
      track: "MODEL_APPLY",
      ok: false,
      failures: [`unsupported track: ${String(suiteCase.track)}`],
      turns: [],
    };
  }

  for (let i = 0; i < suiteCase.turns.length; i += 1) {
    const turn = suiteCase.turns[i]!;
    if (turn.fixtureMetadata !== undefined && turn.fixtureMetadata !== null) {
      return {
        id: suiteCase.id,
        track: "MODEL_APPLY",
        ok: false,
        failures: [
          `MODEL_APPLY forbids fixtureMetadata (case=${suiteCase.id} turn=${i})`,
        ],
        turns: [],
      };
    }
  }

  let account: HarnessAccount | null = null;
  const idMap = new Map<string, string>();
  const priorMetadata: LlmMetadata[] = [];

  try {
    // DB safety before any Prisma connection/mutation. Never log URLs.
    assertModelApplyDatabaseApproved();

    const partners = [
      ...new Set([
        ...collectPartnerNamesFromSetup(suiteCase.setup),
        ...(options?.partners ?? []),
      ]),
    ];
    account = await createHarnessAccount(speaker, { partners });
    const nameToEmployeeId = new Map<string, string>([
      [speaker.trim(), account.employeeId],
      ...account.partners.map(
        (p) => [p.nickname?.trim() || p.name, p.id] as const,
      ),
    ]);
    await seedSetup(account.employeeId, speaker, suiteCase.setup, idMap, {
      userId: account.userId,
      nameToEmployeeId,
    });
    let { snapshot, facts } = await enrichSnapshot(account.employeeId);

    for (let i = 0; i < suiteCase.turns.length; i += 1) {
      const turn = suiteCase.turns[i]!;
      const proposed = await proposeTurn({
        turnIndex: i,
        utterance: turn.utterance,
        facts,
        snapshot,
        account,
        priorMetadata: [...priorMetadata],
      });

      const metadata = fillBlankCustomListNameFromSameTurnLinks(
        metadataFromModelApplyPropose(proposed.metadata, idMap),
      );
      const rawResponse = proposed.response ?? turn.response ?? "";
      priorMetadata.push(metadata);

      // Map authored symbolic ids in constraints → real UUIDs from seed.
      const constraints = (rewriteAliases(
        turn.constraints ?? [],
        idMap,
      ) ?? []) as ModelEvalConstraint[];
      // Score ACTION against the model's raw spoken text (constraints stay score-only).
      const checked = evaluateConstraints(constraints, metadata, rawResponse);

      let appliedViaProduction = false;
      let applyResult: ModelApplyTurnApplyResult = {
        mutations: [],
        filingMutations: [],
        shareMisses: [],
        attachmentOutcome: emptyAttachmentOutcome(),
        listOpResults: [],
      };
      if (metadataHasMutations(metadata)) {
        const applied = await applyModelMetadataTurn({ account, metadata });
        appliedViaProduction = true;
        applyResult = {
          mutations: applied.mutations,
          filingMutations: applied.filingMutations,
          shareMisses: applied.shareMisses,
          attachmentOutcome: applied.attachmentOutcome,
          listOpResults: applied.listOpResults,
        };
      }
      // Snapshot after apply first — unshare remainder uses live shared_with.
      const enriched = await enrichSnapshot(account.employeeId);
      snapshot = enriched.snapshot;
      facts = enriched.facts;
      // Align spoken reply with apply evidence even when apply was skipped.
      const response = correctModelApplyTurnResponse({
        response: rawResponse,
        metadata,
        ...applyResult,
        snapshotAfter: snapshot,
      });
      const contactNames = (
        await listContactsForEmployee(account.employeeId)
      ).map((row) => row.name);

      const stateFailures = assertRegressionState(
        snapshot,
        facts,
        mapStateAssert(turn.stateAfter, idMap),
        { contactNames },
      );

      const turnOk = checked.ok && stateFailures.length === 0;
      if (!checked.ok) {
        failures.push(
          `turn ${i} constraints: ${checked.failures.join("; ") || "failed"}`,
        );
      }
      for (const row of stateFailures) {
        failures.push(`turn ${i} ${row}`);
      }

      turnResults.push({
        turnIndex: i,
        utterance: turn.utterance,
        metadata,
        response,
        constraintOk: checked.ok,
        constraintFailures: checked.failures,
        stateFailures,
        facts,
        snapshot,
        appliedViaProduction,
        ok: turnOk,
        ...(proposed.rawActionDiagnostic
          ? { rawActionDiagnostic: proposed.rawActionDiagnostic }
          : {}),
      });
    }
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (account) {
      await destroyHarnessAccount(account);
    }
  }

  return {
    id: suiteCase.id,
    track: "MODEL_APPLY",
    ok: failures.length === 0,
    failures,
    turns: turnResults,
  };
}

/** Empty ACTION helper for ask-only model turns in stubs/tests. */
export function emptyModelMetadata(): LlmMetadata {
  return emptyLlmMetadata();
}
