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
import { applyReminders } from "../services/reminder.service.js";
import { evaluateConstraints } from "./constraints.js";
import {
  type ModelEvalCorpusCase,
  type RegressionSuiteCase,
  type RegressionStateAssert,
  type RegressionTurn,
} from "./corpus.js";
import { assertApprovedEvalDatabaseUrl } from "./studio-db-guard.js";

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
  /** Optional human partners on the same account (share / targets resolution). */
  partners: PublicEmployee[];
  /** actor + partners — passed to applyListOps / applyReminders. */
  employees: PublicEmployee[];
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
    contactNamesInclude: expect.contactNamesInclude,
    contactNamesExclude: expect.contactNamesExclude,
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
  options?: { contactNames?: string[] },
): string[] {
  if (!expect) {
    return [];
  }
  const failures: string[] = [];
  const liveIds = new Set(allLiveItemIds(snapshot));
  const contactNames = options?.contactNames ?? [];

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
  for (const needle of expect.contactNamesInclude ?? []) {
    const hit = contactNames.some((name) =>
      name.toLowerCase().includes(needle.toLowerCase()),
    );
    if (!hit) {
      failures.push(
        `contacts: expected to include ${JSON.stringify(needle)}`,
      );
    }
  }
  for (const needle of expect.contactNamesExclude ?? []) {
    const hit = contactNames.some((name) =>
      name.toLowerCase().includes(needle.toLowerCase()),
    );
    if (hit) {
      failures.push(
        `contacts: expected to exclude ${JSON.stringify(needle)}`,
      );
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
  options?: { partners?: string[] },
): Promise<HarnessAccount> {
  // Central choke point for harness DB writes (ENGINE + MODEL_APPLY + LIVE_FULL).
  // Fail closed before any Prisma mutation — never self-approve DATABASE_URL.
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);

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
  const partners: PublicEmployee[] = [];
  const seen = new Set([speaker.trim()]);
  for (const raw of options?.partners ?? []) {
    const name = raw.trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const partnerRow = await prisma.employee.create({
      data: {
        userId: user.id,
        kind: "human",
        name,
        surname: "",
        nickname: name,
        isOwner: false,
      },
    });
    partners.push({
      id: partnerRow.id,
      kind: "human",
      name,
      surname: "",
      nickname: name,
      email: null,
      phone: null,
      isOwner: false,
    });
  }
  return {
    userId: user.id,
    employeeId: employee.id,
    speaker,
    actor,
    partners,
    employees: [actor, ...partners],
  };
}

export async function destroyHarnessAccount(account: HarnessAccount): Promise<void> {
  // Cleanup must not bypass the central DB gate (defense in depth).
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);

  // EmployeeLists / items cascade from Employee; User is Restrict until employees go.
  await prisma.reminder.deleteMany({ where: { userId: account.userId } }).catch(() => undefined);
  await prisma.contact.deleteMany({ where: { userId: account.userId } }).catch(() => undefined);
  await prisma.contactBook.deleteMany({ where: { userId: account.userId } }).catch(() => undefined);
  await prisma.employeeFiling.deleteMany({
    where: { employeeId: account.employeeId },
  });
  await prisma.employeeList.deleteMany({
    where: { employeeId: account.employeeId },
  });
  await prisma.employee.deleteMany({ where: { userId: account.userId } });
  await prisma.user.delete({ where: { id: account.userId } }).catch(() => undefined);
}

/** Partner nicknames referenced in setup shared_with (for harness account creation). */
export function collectPartnerNamesFromSetup(
  setup: ModelEvalCorpusCase["setup"] | undefined,
): string[] {
  const names = new Set<string>();
  for (const list of setup?.lists ?? []) {
    const listShared = (list as { shared_with?: unknown }).shared_with;
    if (Array.isArray(listShared)) {
      for (const raw of listShared) {
        if (typeof raw === "string" && raw.trim()) names.add(raw.trim());
      }
    }
    for (const raw of list.items ?? []) {
      const item = raw as { shared_with?: unknown };
      if (Array.isArray(item.shared_with)) {
        for (const name of item.shared_with) {
          if (typeof name === "string" && name.trim()) names.add(name.trim());
        }
      }
    }
  }
  return [...names];
}

/** DB unique key for EmployeeLists: (list_type, name). Pure — no I/O. */
export function setupListSeedKey(list: {
  list_type?: string;
  list_name?: string;
  name?: string;
}): string {
  const listType = String(list.list_type ?? "").trim();
  const listName = String(list.list_name ?? list.name ?? "");
  return `${listType}\0${listName}`;
}

/**
 * Fail closed when setup authors two lists that share (list_type, name).
 * That collides with EmployeeLists unique (employee_id, list_type, name) and
 * would silently merge under seedSetup findFirst reuse.
 */
export function assertSetupListKeysIsolated(
  lists: Array<{
    list_type?: string;
    list_name?: string;
    name?: string;
    list_id?: string;
  }>,
): void {
  const seen = new Map<string, string>();
  for (const list of lists) {
    const key = setupListSeedKey(list);
    const label =
      String(list.list_id ?? "").trim() ||
      `${list.list_type ?? "?"}:${list.list_name ?? list.name ?? ""}`;
    const prior = seen.get(key);
    if (prior) {
      throw new Error(
        `seed setup duplicate list identity (${JSON.stringify(key.split("\0")[0])}, name=${JSON.stringify(key.split("\0")[1] ?? "")}): ${prior} and ${label} — give distinct list_name`,
      );
    }
    seen.set(key, label);
  }
}

/** Seed corpus setup rows into Prisma; map symbolic ids → real UUIDs. */
export async function seedSetup(
  employeeId: string,
  speaker: string,
  setup: ModelEvalCorpusCase["setup"] | undefined,
  idMap: Map<string, string>,
  options?: {
    userId?: string;
    /** Name → employee id for shared_with resolution (speaker + partners). */
    nameToEmployeeId?: Map<string, string>;
  },
): Promise<void> {
  // Fail closed before any Prisma read/write (defense in depth).
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);

  const userId = options?.userId?.trim();
  const nameToId = options?.nameToEmployeeId ?? new Map<string, string>();
  if (!nameToId.has(speaker.trim())) {
    nameToId.set(speaker.trim(), employeeId);
  }

  const resolvePartnerIds = (sharedWith: unknown): string[] => {
    if (!Array.isArray(sharedWith)) return [];
    const ids: string[] = [];
    for (const raw of sharedWith) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      const id = nameToId.get(raw.trim());
      if (id && id !== employeeId) ids.push(id);
    }
    return ids;
  };

  /** Track (list_type, name) claimed in this seed so two empty-name shopping lists stay isolated. */
  const claimedListKeys = new Set<string>();

  for (const list of setup?.lists ?? []) {
    const symbolicListId = String(list.list_id ?? "").trim();
    let listName = String(
      (list as { list_name?: string; name?: string }).list_name ??
        (list as { name?: string }).name ??
        "",
    );
    let seedKey = setupListSeedKey({
      list_type: list.list_type,
      list_name: listName,
    });
    if (claimedListKeys.has(seedKey)) {
      // Distinct EmployeeLists row required — suffix with symbolic id (or short uuid).
      const suffix =
        symbolicListId && !UUID_RE.test(symbolicListId)
          ? symbolicListId
          : randomUUID().slice(0, 8);
      listName = listName ? `${listName}·${suffix}` : suffix;
      seedKey = setupListSeedKey({
        list_type: list.list_type,
        list_name: listName,
      });
    }
    claimedListKeys.add(seedKey);

    const listPartners = resolvePartnerIds(
      (list as { shared_with?: unknown }).shared_with,
    );
    const listShared =
      list.scope === "shared" || listPartners.length > 0;
    const listVisibleTo = listShared
      ? [employeeId, ...listPartners]
      : [employeeId];

    // One shopping/tasks shell per (employee, list_type, name) — reuse to avoid unique crashes.
    let createdList = await prisma.employeeList.findFirst({
      where: {
        employeeId,
        listType: list.list_type,
        name: listName,
        deletedAt: null,
      },
    });
    if (!createdList) {
      createdList = await prisma.employeeList.create({
        data: {
          employeeId,
          listType: list.list_type,
          name: listName,
          scope: listShared ? "shared" : "personal",
          visibleTo: listVisibleTo,
        },
      });
    } else if (listShared && createdList.scope !== "shared") {
      createdList = await prisma.employeeList.update({
        where: { id: createdList.id },
        data: {
          scope: "shared",
          visibleTo: listVisibleTo,
        },
      });
    }
    if (symbolicListId && !UUID_RE.test(symbolicListId)) {
      idMap.set(symbolicListId, createdList.id);
    }
    idMap.set(`list:${list.list_type}:${listName}`, createdList.id);

    for (const raw of list.items ?? []) {
      const item = { ...raw } as Record<string, unknown>;
      const symbolicId = readItemId(item);
      delete item.item_id;
      delete item.itemId;
      delete item.id;
      const itemScopeRaw = item.scope;
      delete item.scope;
      const itemSharedWith = item.shared_with;
      const itemPartners = resolvePartnerIds(itemSharedWith);
      const itemShared =
        itemScopeRaw === "shared" || itemPartners.length > 0;
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
          data: JSON.parse(JSON.stringify(item)) as object,
          scope: itemShared ? "shared" : "personal",
          addedById: employeeId,
          visibleTo: itemShared
            ? [employeeId, ...itemPartners]
            : [employeeId],
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

  if (userId && (setup?.contacts?.length ?? 0) > 0) {
    for (const [index, row] of setup!.contacts!.entries()) {
      const name = String(row.name ?? "").trim();
      const phone = String(row.phone ?? "").trim();
      if (!name || !phone) continue;
      const symbolic =
        typeof (row as { contact_id?: string }).contact_id === "string"
          ? String((row as { contact_id?: string }).contact_id).trim()
          : "";
      // Optional authored UUID — production Contacts.id is Uuid; keep seed aligned.
      const fixedId =
        symbolic && UUID_RE.test(symbolic) ? symbolic : undefined;
      const created = await prisma.contact.upsert({
        where: {
          ownerEmployeeId_phone: {
            ownerEmployeeId: employeeId,
            phone,
          },
        },
        create: {
          ...(fixedId ? { id: fixedId } : {}),
          userId,
          ownerEmployeeId: employeeId,
          name,
          phone,
          kind: "personal",
          addedById: employeeId,
          scope: "personal",
          visibleTo: [employeeId],
        },
        update: { name },
      });
      idMap.set(`contact-${index}`, created.id);
      if (symbolic && !UUID_RE.test(symbolic)) {
        idMap.set(symbolic, created.id);
      } else if (fixedId) {
        idMap.set(fixedId, created.id);
      }
    }
  }

  if (userId && (setup?.reminders?.length ?? 0) > 0) {
    for (const row of setup!.reminders!) {
      const symbolicId = String(row.reminder_id ?? "").trim();
      const itemLabel = String(row.item ?? row.text ?? "תזכורת").trim() || "תזכורת";
      const fireAt = row.fire_at
        ? new Date(String(row.fire_at))
        : new Date(Date.now() + 3600_000);
      // Optional cascade seed: worker_item_id → already-seeded list item symbolic id.
      const workerSymbolic = String(
        (row as { worker_item_id?: string }).worker_item_id ?? "",
      ).trim();
      const workerUuid =
        workerSymbolic && !UUID_RE.test(workerSymbolic)
          ? idMap.get(workerSymbolic)
          : workerSymbolic && UUID_RE.test(workerSymbolic)
            ? workerSymbolic
            : undefined;
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
          ...(workerUuid ? { workerItemId: workerUuid } : {}),
        },
      });
      if (workerUuid) {
        await prisma.employeeListItem
          .update({
            where: { id: workerUuid },
            data: { reminderId: created.id },
          })
          .catch(() => undefined);
      }
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
  // Fail closed before any production apply / Prisma side effect.
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);

  const plannedAdds = collectSymbolicAddIds(input.fixtureRaw);
  const rewritten = rewriteAliases(input.fixtureRaw, input.idMap);
  const metadata = parseLlmMetadata(rewritten);

  if ((metadata.listOps?.length ?? 0) > 0) {
    await applyListOps({
      userId: input.account.userId,
      actor: input.account.actor,
      employees: input.account.employees,
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

  // Production chat path: clocks go through applyReminders (same as run-model-apply).
  if ((metadata.reminders?.length ?? 0) > 0) {
    const reminderWrites = [
      ...(metadata.reminders ?? []).filter((row) => row.action !== "remove"),
      ...(metadata.reminders ?? []).filter((row) => row.action === "remove"),
    ];
    await applyReminders({
      userId: input.account.userId,
      actor: input.account.actor,
      employees: input.account.employees,
      reminders: reminderWrites,
    });
  }

  syncIdMapFromMutations(input.idMap, plannedAdds, applied.mutations);
  return {
    metadata,
    appliedViaProduction: true,
    mutations: applied.mutations,
  };
}

export async function runMultiTurnOffline(
  suiteCase: RegressionSuiteCase,
  options?: { speaker?: string; partners?: string[] },
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

  const partnersFromSetup = collectPartnerNamesFromSetup(suiteCase.setup);
  const account = await createHarnessAccount(speaker, {
    partners: options?.partners?.length
      ? options.partners
      : partnersFromSetup,
  });
  const idMap = new Map<string, string>();
  const turnResults: MultiTurnTurnResult[] = [];
  const failures: string[] = [];

  try {
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
