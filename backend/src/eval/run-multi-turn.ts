/**
 * Gate 1 ENGINE multi-turn harness (offline).
 *
 * Sequence per turn:
 *   fixture metadata → rewrite symbolic ids → evaluateConstraints →
 *   applyListOps + applyEmployeeRecords (production, Prisma) →
 *   getEmployeeRecordSnapshot → formatEmployeeContext → next turn
 *
 * Fixture ACTIONs are the decisions (not a live model). No OpenAI.
 */
import { randomUUID } from "node:crypto";
import {
  emptyLlmMetadata,
  parseLlmMetadata,
  type LlmListAction,
  type LlmMetadata,
  type PublicEmployee,
} from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { withAttachmentRefs } from "../services/attachment.service.js";
import {
  applyEmployeeRecords,
  formatEmployeeContext,
  getEmployeeRecordSnapshot,
  type EmployeeRecordSnapshot,
} from "../services/employee-records.service.js";
import { withLinkedListRefs } from "../services/list-item-list-link.service.js";
import { applyListOps } from "../services/list-ops.service.js";
import { evaluateConstraints } from "./constraints.js";
import {
  type ModelEvalCorpusCase,
  type RegressionSuiteCase,
  type RegressionStateAssert,
  type RegressionTurn,
} from "./corpus.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class EngineFixtureRequiredError extends Error {
  constructor(caseId: string, turnIndex: number) {
    super(
      `ENGINE multi-turn requires fixtureMetadata (case=${caseId} turn=${turnIndex}). Refusing LLM fallback.`,
    );
    this.name = "EngineFixtureRequiredError";
  }
}

export interface MultiTurnTurnResult {
  turnIndex: number;
  utterance: string;
  metadata: LlmMetadata;
  response: string;
  constraintOk: boolean;
  constraintFailures: string[];
  stateFailures: string[];
  facts: string;
  snapshot: EmployeeRecordSnapshot;
  /** True when production applyEmployeeRecords ran this turn. */
  appliedViaProduction: boolean;
  ok: boolean;
}

export interface MultiTurnCaseResult {
  id: string;
  track: "ENGINE";
  ok: boolean;
  failures: string[];
  turns: MultiTurnTurnResult[];
}

export interface HarnessAccount {
  userId: string;
  employeeId: string;
  speaker: string;
  actor: PublicEmployee;
}

function readItemId(item: Record<string, unknown>): string {
  for (const key of ["item_id", "itemId", "id"]) {
    const raw = item[key];
    if (typeof raw === "string" && raw.trim()) {
      return raw.trim();
    }
  }
  return "";
}

function allLiveItemIds(snapshot: EmployeeRecordSnapshot): string[] {
  const ids: string[] = [];
  for (const list of snapshot.lists) {
    for (const item of list.items) {
      const id = readItemId(item);
      if (id) {
        ids.push(id);
      }
    }
  }
  return ids;
}

/** Rewrite symbolic eval ids → real UUIDs (ENGINE fixtures + MODEL_APPLY constraint expects). */
export function rewriteAliases(value: unknown, idMap: Map<string, string>): unknown {
  if (typeof value === "string") {
    return idMap.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((row) => rewriteAliases(row, idMap));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = rewriteAliases(nested, idMap);
    }
    return out;
  }
  return value;
}

export function mapStateAssert(
  expect: RegressionStateAssert | undefined,
  idMap: Map<string, string>,
): RegressionStateAssert | undefined {
  if (!expect) {
    return undefined;
  }
  const mapId = (id: string) => idMap.get(id) ?? id;
  return {
    ...expect,
    itemIdsPresent: expect.itemIdsPresent?.map(mapId),
    itemIdsAbsent: expect.itemIdsAbsent?.map(mapId),
    factsInclude: expect.factsInclude?.map(mapId),
    factsExclude: expect.factsExclude?.map(mapId),
    linkedListNamesOnItem: expect.linkedListNamesOnItem
      ? {
          itemId: mapId(expect.linkedListNamesOnItem.itemId),
          listNames: expect.linkedListNamesOnItem.listNames,
        }
      : undefined,
  };
}

export function assertRegressionState(
  snapshot: EmployeeRecordSnapshot,
  facts: string,
  expect: RegressionStateAssert | undefined,
): string[] {
  if (!expect) {
    return [];
  }
  const failures: string[] = [];
  const liveIds = new Set(allLiveItemIds(snapshot));

  for (const id of expect.itemIdsPresent ?? []) {
    if (!liveIds.has(id)) {
      failures.push(`state: expected item_id present: ${id}`);
    }
  }
  for (const id of expect.itemIdsAbsent ?? []) {
    if (liveIds.has(id)) {
      failures.push(`state: expected item_id absent: ${id}`);
    }
  }
  for (const needle of expect.factsInclude ?? []) {
    if (!facts.includes(needle)) {
      failures.push(`facts: expected to include ${JSON.stringify(needle)}`);
    }
  }
  for (const needle of expect.factsExclude ?? []) {
    if (facts.includes(needle)) {
      failures.push(`facts: expected to exclude ${JSON.stringify(needle)}`);
    }
  }
  if (expect.listTypeCounts) {
    for (const [listType, count] of Object.entries(expect.listTypeCounts)) {
      const actual = snapshot.lists.filter((list) => list.list_type === listType)
        .length;
      if (actual !== count) {
        failures.push(
          `state: list_type ${listType} count ${actual} != expected ${count}`,
        );
      }
    }
  }
  if (expect.linkedListNamesOnItem) {
    const { itemId, listNames } = expect.linkedListNamesOnItem;
    let found: Record<string, unknown> | null = null;
    for (const list of snapshot.lists) {
      for (const item of list.items) {
        if (readItemId(item) === itemId) {
          found = item;
          break;
        }
      }
      if (found) {
        break;
      }
    }
    if (!found) {
      failures.push(`state: linked check — missing item ${itemId}`);
    } else {
      const linked = found.linked_lists;
      const names = Array.isArray(linked)
        ? linked
            .map((row) => {
              if (!row || typeof row !== "object") {
                return "";
              }
              const rec = row as Record<string, unknown>;
              return String(rec.list_name ?? rec.listName ?? "").trim();
            })
            .filter(Boolean)
        : [];
      for (const want of listNames) {
        if (!names.includes(want)) {
          failures.push(
            `state: item ${itemId} missing linked list name ${want} (have [${names.join(",")}])`,
          );
        }
      }
    }
  }
  return failures;
}

function requireFixtureMetadata(
  caseId: string,
  turnIndex: number,
  turn: RegressionTurn,
): unknown {
  if (turn.fixtureMetadata === undefined || turn.fixtureMetadata === null) {
    throw new EngineFixtureRequiredError(caseId, turnIndex);
  }
  return turn.fixtureMetadata;
}

export async function createHarnessAccount(
  speaker: string,
): Promise<HarnessAccount> {
  const username = `g1_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const user = await prisma.user.create({
    data: {
      username,
      passwordHash: "gate1-offline-not-a-login",
    },
  });
  const employee = await prisma.employee.create({
    data: {
      userId: user.id,
      kind: "human",
      name: speaker,
      surname: "",
      nickname: speaker,
      isOwner: true,
    },
  });
  const actor: PublicEmployee = {
    id: employee.id,
    kind: "human",
    name: speaker,
    surname: "",
    nickname: speaker,
    email: null,
    phone: null,
    isOwner: true,
  };
  return {
    userId: user.id,
    employeeId: employee.id,
    speaker,
    actor,
  };
}

export async function destroyHarnessAccount(account: HarnessAccount): Promise<void> {
  // EmployeeLists / items cascade from Employee; User is Restrict until employees go.
  await prisma.reminder.deleteMany({ where: { userId: account.userId } }).catch(() => undefined);
  await prisma.employeeFiling.deleteMany({
    where: { employeeId: account.employeeId },
  });
  await prisma.employeeList.deleteMany({
    where: { employeeId: account.employeeId },
  });
  await prisma.employee.deleteMany({ where: { userId: account.userId } });
  await prisma.user.delete({ where: { id: account.userId } }).catch(() => undefined);
}

/** Seed corpus setup rows into Prisma; map symbolic ids → real UUIDs. */
export async function seedSetup(
  employeeId: string,
  speaker: string,
  setup: ModelEvalCorpusCase["setup"] | undefined,
  idMap: Map<string, string>,
  options?: { userId?: string },
): Promise<void> {
  for (const list of setup?.lists ?? []) {
    const symbolicListId = String(list.list_id ?? "").trim();
    const createdList = await prisma.employeeList.create({
      data: {
        employeeId,
        listType: list.list_type,
        name: list.list_name ?? "",
        scope: list.scope === "shared" ? "shared" : "personal",
        visibleTo: [employeeId],
      },
    });
    if (symbolicListId && !UUID_RE.test(symbolicListId)) {
      idMap.set(symbolicListId, createdList.id);
    }
    idMap.set(`list:${list.list_type}:${list.list_name ?? ""}`, createdList.id);

    for (const raw of list.items ?? []) {
      const item = { ...raw } as Record<string, unknown>;
      const symbolicId = readItemId(item);
      delete item.item_id;
      delete item.itemId;
      delete item.id;
      const titleKeys =
        list.list_type === "shopping"
          ? ["שם פריט", "name"]
          : list.list_type === "tasks"
            ? ["שם מטלה", "name"]
            : ["שם", "name", "title"];
      let itemKey = "";
      for (const key of titleKeys) {
        const val = item[key];
        if (typeof val === "string" && val.trim()) {
          itemKey = val.trim();
          break;
        }
      }
      if (!itemKey) {
        itemKey = symbolicId || randomUUID();
      }
      const created = await prisma.employeeListItem.create({
        data: {
          listId: createdList.id,
          itemKey,
          data: item,
          scope: "personal",
          addedById: employeeId,
          visibleTo: [employeeId],
        },
      });
      if (symbolicId && !UUID_RE.test(symbolicId)) {
        idMap.set(symbolicId, created.id);
      }
    }
  }

  for (const filing of setup?.filing ?? []) {
    const symbolicId = String(filing.filing_id ?? "").trim();
    const created = await prisma.employeeFiling.create({
      data: {
        employeeId,
        itemName: filing.item_name,
        itemInfo: filing.item_info,
        itemDescription: filing.item_description || filing.item_name,
        scope: filing.scope === "shared" ? "shared" : "personal",
        visibleTo: [employeeId],
      },
    });
    if (symbolicId && !UUID_RE.test(symbolicId)) {
      idMap.set(symbolicId, created.id);
    }
  }

  const userId = options?.userId?.trim();
  if (userId && (setup?.reminders?.length ?? 0) > 0) {
    for (const row of setup!.reminders!) {
      const symbolicId = String(row.reminder_id ?? "").trim();
      const itemLabel = String(row.item ?? row.text ?? "תזכורת").trim() || "תזכורת";
      const fireAt = row.fire_at
        ? new Date(String(row.fire_at))
        : new Date(Date.now() + 3600_000);
      const created = await prisma.reminder.create({
        data: {
          userId,
          ownerId: employeeId,
          actorId: employeeId,
          itemKey: itemLabel,
          itemLabel,
          listType: String(row.list_type ?? "tasks"),
          fireAt: Number.isFinite(fireAt.getTime())
            ? fireAt
            : new Date(Date.now() + 3600_000),
          repeat: String(row.repeat ?? "once"),
          pingIds: [employeeId],
          messageText: String(row.text ?? itemLabel),
          status: String(row.status ?? "active"),
          sendStatus: String(row.send_status ?? "pending"),
          // Independent clocks for D3 tests: never set workerItemId here.
        },
      });
      if (symbolicId && !UUID_RE.test(symbolicId)) {
        idMap.set(symbolicId, created.id);
      }
    }
  }

  void speaker;
}

function collectSymbolicAddIds(fixtureRaw: unknown): Array<{
  symbolicId: string;
  listType: string;
  labelHint: string;
}> {
  const meta = parseLlmMetadata(fixtureRaw);
  const out: Array<{ symbolicId: string; listType: string; labelHint: string }> =
    [];
  for (const action of meta.lists) {
    if (action.action !== "add") {
      continue;
    }
    for (const raw of action.items) {
      const item = raw as Record<string, unknown>;
      const symbolicId = readItemId(item);
      if (!symbolicId || UUID_RE.test(symbolicId)) {
        continue;
      }
      const labelHint = String(
        item["שם פריט"] ??
          item["שם מטלה"] ??
          item["שם"] ??
          item.name ??
          "",
      ).trim();
      out.push({
        symbolicId,
        listType: action.listType,
        labelHint,
      });
    }
  }
  return out;
}

function syncIdMapFromMutations(
  idMap: Map<string, string>,
  planned: Array<{ symbolicId: string; listType: string; labelHint: string }>,
  mutations: Array<{
    action: string;
    itemId: string;
    listType: string;
    itemKey: string;
    itemLabel: string;
  }>,
): void {
  const adds = mutations.filter((row) => row.action === "add");
  for (const plan of planned) {
    const match =
      adds.find(
        (row) =>
          row.listType === plan.listType &&
          (row.itemLabel === plan.labelHint ||
            row.itemKey === plan.labelHint ||
            row.itemLabel.includes(plan.labelHint) ||
            plan.labelHint.includes(row.itemLabel)),
      ) ?? adds.find((row) => row.listType === plan.listType);
    if (match) {
      idMap.set(plan.symbolicId, match.itemId);
    }
  }
}

async function syncListIdMapFromSnapshot(
  idMap: Map<string, string>,
  snapshot: EmployeeRecordSnapshot,
): Promise<void> {
  for (const list of snapshot.lists) {
    const key = `list:${list.list_type}:${list.list_name ?? ""}`;
    if (list.list_id) {
      idMap.set(key, list.list_id);
      if (list.list_name) {
        idMap.set(`listname:${list.list_name}`, list.list_id);
      }
    }
  }
}

/** Apply one turn through production list_ops + employee records. */
export async function applyFixtureTurn(input: {
  account: HarnessAccount;
  fixtureRaw: unknown;
  idMap: Map<string, string>;
}): Promise<{
  metadata: LlmMetadata;
  appliedViaProduction: true;
  mutations: Awaited<ReturnType<typeof applyEmployeeRecords>>["mutations"];
}> {
  const plannedAdds = collectSymbolicAddIds(input.fixtureRaw);
  const rewritten = rewriteAliases(input.fixtureRaw, input.idMap);
  const metadata = parseLlmMetadata(rewritten);

  if ((metadata.listOps?.length ?? 0) > 0) {
    await applyListOps({
      userId: input.account.userId,
      actor: input.account.actor,
      employees: [input.account.actor],
      ops: metadata.listOps ?? [],
    });
  }

  const applied = await applyEmployeeRecords(
    input.account.employeeId,
    metadata,
    {
      scope: "personal",
      addedById: input.account.employeeId,
      visibleTo: [input.account.employeeId],
    },
    input.account.employeeId,
  );

  syncIdMapFromMutations(input.idMap, plannedAdds, applied.mutations);
  return {
    metadata,
    appliedViaProduction: true,
    mutations: applied.mutations,
  };
}

export async function runMultiTurnOffline(
  suiteCase: RegressionSuiteCase,
  options?: { speaker?: string },
): Promise<MultiTurnCaseResult> {
  const speaker = options?.speaker ?? "טל";
  if (suiteCase.track !== "ENGINE") {
    return {
      id: suiteCase.id,
      track: "ENGINE",
      ok: false,
      failures: [`unsupported track: ${String(suiteCase.track)}`],
      turns: [],
    };
  }

  const account = await createHarnessAccount(speaker);
  const idMap = new Map<string, string>();
  const turnResults: MultiTurnTurnResult[] = [];
  const failures: string[] = [];

  try {
    await seedSetup(account.employeeId, speaker, suiteCase.setup, idMap, {
      userId: account.userId,
    });

    for (let i = 0; i < suiteCase.turns.length; i += 1) {
      const turn = suiteCase.turns[i]!;
      let fixtureRaw: unknown;
      try {
        fixtureRaw = requireFixtureMetadata(suiteCase.id, i, turn);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(message);
        break;
      }

      const response = turn.response ?? "";
      // Constraints assert the fixture ACTION as authored (symbolic eval ids).
      // Production apply rewrites those ids to real UUIDs separately.
      const checked = evaluateConstraints(
        turn.constraints ?? [],
        parseLlmMetadata(fixtureRaw),
        response,
      );

      const applied = await applyFixtureTurn({
        account,
        fixtureRaw,
        idMap,
      });

      // Same enrichment chat uses before formatEmployeeContext (attachments +
      // linked_lists join refs). Apply already ran via applyListItemListLinks.
      const rawSnapshot = await getEmployeeRecordSnapshot(account.employeeId);
      const snapshot = await withLinkedListRefs(
        await withAttachmentRefs(rawSnapshot),
      );
      await syncListIdMapFromSnapshot(idMap, snapshot);
      const facts = formatEmployeeContext(snapshot);
      const stateFailures = assertRegressionState(
        snapshot,
        facts,
        mapStateAssert(turn.stateAfter, idMap),
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
        metadata: applied.metadata,
        response,
        constraintOk: checked.ok,
        constraintFailures: checked.failures,
        stateFailures,
        facts,
        snapshot,
        appliedViaProduction: applied.appliedViaProduction,
        ok: turnOk,
      });
    }
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  } finally {
    await destroyHarnessAccount(account);
  }

  return {
    id: suiteCase.id,
    track: "ENGINE",
    ok: failures.length === 0,
    failures,
    turns: turnResults,
  };
}

/** Empty metadata helper for ask-only turns in seeds/tests. */
export function emptyFixtureMetadata(): LlmMetadata {
  return emptyLlmMetadata();
}

/** @deprecated Gate 1 no longer projects snapshots — production apply only. */
export function projectFixtureOntoSnapshot(): never {
  throw new Error(
    "projectFixtureOntoSnapshot removed: Gate 1 must use production applyEmployeeRecords",
  );
}
