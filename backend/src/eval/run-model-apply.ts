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
import { withAttachmentRefs } from "../services/attachment.service.js";
import {
  applyEmployeeRecords,
  formatEmployeeContext,
  getEmployeeRecordSnapshot,
  type EmployeeRecordSnapshot,
} from "../services/employee-records.service.js";
import { withLinkedListRefs } from "../services/list-item-list-link.service.js";
import {
  applyDirectoryActions,
  listContactsForEmployee,
} from "../services/contact.service.js";
import { applyListOps } from "../services/list-ops.service.js";
import { applyReminders } from "../services/reminder.service.js";
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

/** Apply a model-proposed ACTION through production paths (no symbolic rewrite). */
export async function applyModelMetadataTurn(input: {
  account: HarnessAccount;
  metadata: LlmMetadata;
}): Promise<{
  metadata: LlmMetadata;
  appliedViaProduction: true;
  mutations: Awaited<ReturnType<typeof applyEmployeeRecords>>["mutations"];
}> {
  const { metadata, account } = input;

  if ((metadata.listOps?.length ?? 0) > 0) {
    await applyListOps({
      userId: account.userId,
      actor: account.actor,
      employees: [account.actor],
      ops: metadata.listOps ?? [],
    });
  }

  const applied = await applyEmployeeRecords(
    account.employeeId,
    metadata,
    {
      scope: "personal",
      addedById: account.employeeId,
      visibleTo: [account.employeeId],
    },
    account.employeeId,
  );

  // Production path (chat.service): clocks go through applyReminders, not records alone.
  if ((metadata.reminders?.length ?? 0) > 0) {
    const reminderWrites = [
      ...(metadata.reminders ?? []).filter((row) => row.action !== "remove"),
      ...(metadata.reminders ?? []).filter((row) => row.action === "remove"),
    ];
    await applyReminders({
      userId: account.userId,
      actor: account.actor,
      employees: [account.actor],
      reminders: reminderWrites,
    });
  }

  if ((metadata.directory?.length ?? 0) > 0) {
    await applyDirectoryActions({
      userId: account.userId,
      ownerEmployeeId: account.employeeId,
      actions: metadata.directory ?? [],
      employees: [account.actor],
    });
  }

  return {
    metadata,
    appliedViaProduction: true,
    mutations: applied.mutations,
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
  options?: { speaker?: string },
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

    const partners = collectPartnerNamesFromSetup(suiteCase.setup);
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

      const metadata = parseLlmMetadata(
        rewriteAliases(proposed.metadata, idMap),
      );
      const response = proposed.response ?? turn.response ?? "";
      priorMetadata.push(metadata);

      // Map authored symbolic ids in constraints → real UUIDs from seed.
      const constraints = (rewriteAliases(
        turn.constraints ?? [],
        idMap,
      ) ?? []) as ModelEvalConstraint[];
      const checked = evaluateConstraints(constraints, metadata, response);

      let appliedViaProduction = false;
      if (metadataHasMutations(metadata)) {
        await applyModelMetadataTurn({ account, metadata });
        appliedViaProduction = true;
      }

      const enriched = await enrichSnapshot(account.employeeId);
      snapshot = enriched.snapshot;
      facts = enriched.facts;
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
