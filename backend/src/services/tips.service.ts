import type { Tip } from "@prisma/client";
import type {
  PublicEmployee,
  PublicTip,
  TipAudience,
  TipInput,
  TipOutputMode,
  TipTier,
  TipTopic,
  TipTriggerArea,
  TipTriggerKind,
  TipTriggerOp,
  TipUpdateInput,
} from "@workee/shared";
import {
  isGuestEmployee,
  isGuestLucy,
  normalizeEmployeePhone,
  parseTipOutputMode,
  parseTipTier,
  parseTipTopic,
} from "@workee/shared";
import { prisma } from "../database/prisma.js";
import {
  ConflictError,
  isSkippableTipWriteError,
  isUniqueConstraintError,
  NotFoundError,
  ValidationError,
} from "../utils/errors.js";
import {
  LEGACY_TIP_KEYS,
  SYSTEM_TIP_SEEDS,
  TIER_RANK,
  areaFromTopic,
  topicFromListType,
} from "./tip-catalog.js";
import type { ComposeLlmBilling } from "./llm-usage.service.js";
import {
  composeCatalogTip,
  renderStaticTipText,
  type TipComposeFacts,
} from "./tip-compose.js";
import { sendWhatsAppText } from "./whatsapp-send.js";

const LUCY_NAME = "לוסי";

export interface AppliedTipOp {
  area: TipTriggerArea;
  op: TipTriggerOp;
  /** shopping | tasks | custom | filing | reminders | contacts */
  listType?: string | null;
  topic?: TipTopic | null;
}

/** One applied list mutation label for tip FACTS / static placeholders. */
export interface TipTurnFactItem {
  listType: string;
  op: string;
  itemLabel: string;
  itemKey?: string;
}

export interface TipTurnResult {
  texts: string[];
  tipIds: string[];
}

type TipWithDigital = Tip & {
  digitalEmployee: { id: string; name: string; nickname: string | null } | null;
};

function toPublicTip(row: TipWithDigital): PublicTip {
  const digital = row.digitalEmployee;
  const digitalName = digital
    ? digital.nickname?.trim() || digital.name.trim() || null
    : null;
  return {
    id: row.id,
    key: row.key,
    audience: row.audience as TipAudience,
    digitalEmployeeId: row.digitalEmployeeId,
    digitalName,
    triggerKind: row.triggerKind as TipTriggerKind,
    triggerArea: (row.triggerArea as TipTriggerArea | null) ?? null,
    triggerOp: (row.triggerOp as TipTriggerOp | null) ?? null,
    tier: (parseTipTier(row.tier) ?? "basic") as TipTier,
    topic: parseTipTopic(row.topic) ?? null,
    listType: row.listType ?? null,
    unlockAfterKey: row.unlockAfterKey ?? null,
    systemSeed: row.systemSeed === true,
    outputMode: (parseTipOutputMode(row.outputMode) ?? "static") as TipOutputMode,
    minIntervalMinutes: row.minIntervalMinutes ?? 0,
    maxShows: row.maxShows,
    order: row.order,
    text: row.text,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function assertDigitalOnAccount(
  userId: string,
  digitalEmployeeId: string | null | undefined,
): Promise<void> {
  if (!digitalEmployeeId) {
    return;
  }
  const digital = await prisma.employee.findFirst({
    where: { id: digitalEmployeeId, userId, kind: "digital" },
    select: { id: true },
  });
  if (!digital) {
    throw new ValidationError("Please correct the highlighted fields", {
      digitalEmployeeId: "Digital employee not found on this account",
    });
  }
}

function assertActionFields(input: {
  triggerKind: TipTriggerKind;
  triggerArea?: TipTriggerArea | null;
  triggerOp?: TipTriggerOp | null;
}): void {
  if (input.triggerKind !== "action") {
    return;
  }
  if (!input.triggerArea) {
    throw new ValidationError("Please correct the highlighted fields", {
      triggerArea: "Action tips need an area",
    });
  }
}

/**
 * Wipe system / legacy seeds and insert the ladder catalog.
 * UI-created tips (systemSeed=false, not legacy keys) are kept.
 */
/**
 * Sync catalog seeds into the account without rotating tip ids.
 * Wipe+recreate broke Tips UI saves ("Tip not found") and TipProgress.
 * User-edited rows (systemSeed=false) are left alone even if the key matches a seed.
 */
export async function ensureDefaultTips(userId: string): Promise<void> {
  const digitals = await prisma.employee.findMany({
    where: { userId, kind: "digital" },
    select: { id: true, name: true, nickname: true, isProtected: true },
  });
  const lucy =
    digitals.find((row) => row.isProtected) ??
    digitals.find(
      (row) =>
        row.name.trim() === LUCY_NAME || row.nickname?.trim() === LUCY_NAME,
    );
  const guestLucy = digitals.find((row) =>
    isGuestLucy({
      kind: "digital",
      name: row.name,
      nickname: row.nickname,
    }),
  );

  const catalogKeys = SYSTEM_TIP_SEEDS.map((s) => s.key);

  await prisma.tip.deleteMany({
    where: {
      userId,
      OR: [
        { key: { in: [...LEGACY_TIP_KEYS] } },
        {
          systemSeed: true,
          key: { notIn: catalogKeys },
        },
      ],
    },
  });

  const existing = await prisma.tip.findMany({
    where: {
      userId,
      key: { in: catalogKeys },
    },
    select: { id: true, key: true, systemSeed: true },
  });
  const byKey = new Map(existing.map((row) => [row.key, row]));

  for (const seed of SYSTEM_TIP_SEEDS) {
    const digitalEmployeeId =
      seed.for === "guestLucy" ? guestLucy?.id ?? null : lucy?.id ?? null;
    if (!digitalEmployeeId) {
      continue;
    }
    const seedData = {
      audience: seed.audience,
      digitalEmployeeId,
      triggerKind: seed.triggerKind,
      triggerArea: seed.triggerArea,
      triggerOp: seed.triggerOp,
      tier: seed.tier,
      topic: seed.topic,
      listType: seed.listType,
      unlockAfterKey: seed.unlockAfterKey,
      systemSeed: true,
      outputMode: "static",
      minIntervalMinutes: 0,
      maxShows: seed.maxShows,
      order: seed.order,
      text: seed.text,
      enabled: true,
    };
    const row = byKey.get(seed.key);
    if (row) {
      if (!row.systemSeed) {
        continue;
      }
      try {
        await prisma.tip.update({
          where: { id: row.id },
          data: seedData,
        });
      } catch (error) {
        if (!isSkippableTipWriteError(error)) {
          throw error;
        }
      }
      continue;
    }
    try {
      await prisma.tip.create({
        data: {
          userId,
          key: seed.key,
          ...seedData,
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error) && !isSkippableTipWriteError(error)) {
        throw error;
      }
    }
  }
}

export async function listTipsForUser(userId: string): Promise<PublicTip[]> {
  await ensureDefaultTips(userId);
  const rows = await prisma.tip.findMany({
    where: { userId },
    include: {
      digitalEmployee: {
        select: { id: true, name: true, nickname: true },
      },
    },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toPublicTip);
}

export async function createTipForUser(
  userId: string,
  input: TipInput,
): Promise<PublicTip> {
  assertActionFields(input);
  await assertDigitalOnAccount(userId, input.digitalEmployeeId);
  try {
    const row = await prisma.tip.create({
      data: {
        userId,
        key: input.key,
        audience: input.audience,
        digitalEmployeeId: input.digitalEmployeeId ?? null,
        triggerKind: input.triggerKind,
        triggerArea:
          input.triggerKind === "action" ? (input.triggerArea ?? null) : null,
        triggerOp:
          input.triggerKind === "action" ? (input.triggerOp ?? "add") : null,
        tier: input.tier ?? "basic",
        topic: input.topic ?? null,
        listType: input.listType ?? null,
        unlockAfterKey: input.unlockAfterKey ?? null,
        systemSeed: false,
        outputMode: input.outputMode ?? "static",
        minIntervalMinutes: input.minIntervalMinutes ?? 0,
        maxShows: input.maxShows,
        order: input.order,
        text: input.text,
        enabled: input.enabled !== false,
      },
      include: {
        digitalEmployee: {
          select: { id: true, name: true, nickname: true },
        },
      },
    });
    return toPublicTip(row);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ConflictError("A tip with this key already exists");
    }
    throw error;
  }
}

export async function updateTipForUser(
  userId: string,
  tipId: string,
  input: TipUpdateInput,
): Promise<PublicTip> {
  const existing = await prisma.tip.findFirst({
    where: { id: tipId, userId },
  });
  if (!existing) {
    throw new NotFoundError("Tip not found");
  }

  const nextKind = (input.triggerKind ??
    existing.triggerKind) as TipTriggerKind;
  const nextArea =
    nextKind === "action"
      ? ((input.triggerArea !== undefined
          ? input.triggerArea
          : existing.triggerArea) as TipTriggerArea | null)
      : null;
  const nextOp =
    nextKind === "action"
      ? ((input.triggerOp !== undefined
          ? input.triggerOp
          : existing.triggerOp) as TipTriggerOp | null) ?? "add"
      : null;

  assertActionFields({
    triggerKind: nextKind,
    triggerArea: nextArea,
    triggerOp: nextOp,
  });

  if (input.digitalEmployeeId !== undefined) {
    await assertDigitalOnAccount(userId, input.digitalEmployeeId);
  }

  const row = await prisma.tip.update({
    where: { id: tipId },
    data: {
      // UI edits leave the catalog; keep id stable and stop reseeds from overwriting.
      systemSeed: false,
      ...(input.audience !== undefined ? { audience: input.audience } : {}),
      ...(input.digitalEmployeeId !== undefined
        ? { digitalEmployeeId: input.digitalEmployeeId }
        : {}),
      ...(input.triggerKind !== undefined
        ? { triggerKind: input.triggerKind }
        : {}),
      triggerArea: nextArea,
      triggerOp: nextOp,
      ...(input.tier !== undefined ? { tier: input.tier } : {}),
      ...(input.topic !== undefined ? { topic: input.topic } : {}),
      ...(input.listType !== undefined ? { listType: input.listType } : {}),
      ...(input.unlockAfterKey !== undefined
        ? { unlockAfterKey: input.unlockAfterKey }
        : {}),
      ...(input.outputMode !== undefined
        ? { outputMode: input.outputMode }
        : {}),
      ...(input.minIntervalMinutes !== undefined
        ? { minIntervalMinutes: input.minIntervalMinutes }
        : {}),
      ...(input.maxShows !== undefined ? { maxShows: input.maxShows } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    },
    include: {
      digitalEmployee: {
        select: { id: true, name: true, nickname: true },
      },
    },
  });
  return toPublicTip(row);
}

export async function deleteTipForUser(
  userId: string,
  tipId: string,
): Promise<void> {
  const existing = await prisma.tip.findFirst({
    where: { id: tipId, userId },
    select: { id: true },
  });
  if (!existing) {
    throw new NotFoundError("Tip not found");
  }
  await prisma.tip.delete({ where: { id: tipId } });
}

/** Sample FACTS for admin preview (static substitute / dynamic compose). */
const PREVIEW_TIP_FACTS: TipComposeFacts = {
  list_type: "shopping",
  op: "add",
  item_label: "חלב",
  item_key: "חלב",
  items: ["חלב"],
};

/** Send tip text to TIPS_PREVIEW_PHONE (Tips admin preview). No LlmUsages. */
export async function sendTipForUser(
  userId: string,
  tipId: string,
): Promise<void> {
  const tip = await prisma.tip.findFirst({
    where: { id: tipId, userId },
    select: { id: true, text: true, outputMode: true },
  });
  if (!tip) {
    throw new NotFoundError("Tip not found");
  }
  const phone = normalizeEmployeePhone(process.env.TIPS_PREVIEW_PHONE);
  if (!phone) {
    throw new ValidationError("Tips preview phone is not configured");
  }
  const instructions = tip.text.trim();
  if (!instructions) {
    throw new ValidationError("Tip text is empty");
  }
  let text: string | null = instructions;
  const mode = parseTipOutputMode(tip.outputMode) ?? "static";
  if (mode === "dynamic") {
    text = await composeCatalogTip({
      instructions,
      facts: PREVIEW_TIP_FACTS,
    });
  } else {
    text = renderStaticTipText(instructions, PREVIEW_TIP_FACTS);
    // No placeholders → verbatim template.
    if (text === null && !/\{[a-z_]+\}/.test(instructions)) {
      text = instructions;
    }
  }
  if (!text?.trim()) {
    throw new ValidationError(
      mode === "dynamic"
        ? "Dynamic tip preview compose failed or returned empty"
        : "Static tip preview could not substitute placeholders (need sample FACTS)",
    );
  }
  await sendWhatsAppText(phone, text, { ignoreSession: true });
}

function audienceMatches(
  tipAudience: string,
  speakerIsGuest: boolean,
): boolean {
  if (tipAudience === "any") {
    return true;
  }
  if (tipAudience === "guest") {
    return speakerIsGuest;
  }
  return !speakerIsGuest;
}

function digitalMatches(
  tipDigitalId: string | null,
  digitalEmployeeId: string,
): boolean {
  return tipDigitalId === null || tipDigitalId === digitalEmployeeId;
}

function underQuota(showCount: number, maxShows: number): boolean {
  return showCount < maxShows;
}

/** True when minIntervalMinutes is 0 or enough time passed since lastShownAt. */
export function tipCooldownOk(
  lastShownAt: Date | null | undefined,
  minIntervalMinutes: number,
  now: Date = new Date(),
): boolean {
  if (!minIntervalMinutes || minIntervalMinutes <= 0) {
    return true;
  }
  if (!lastShownAt) {
    return true;
  }
  return (
    now.getTime() - lastShownAt.getTime() >= minIntervalMinutes * 60_000
  );
}

function tipTopic(tip: Tip): TipTopic | null {
  return parseTipTopic(tip.topic) ?? topicFromListType(tip.listType);
}

function tipTier(tip: Tip): TipTier {
  return parseTipTier(tip.tier) ?? "basic";
}

function tipOutputMode(tip: Tip): TipOutputMode {
  return parseTipOutputMode(tip.outputMode) ?? "static";
}

function buildComposeFactsFromTurn(
  factItems: TipTurnFactItem[] | undefined,
): TipComposeFacts {
  const items = (factItems ?? [])
    .map((row) => row.itemLabel.trim())
    .filter(Boolean);
  const primary = factItems?.[0];
  const label = items[0] ?? null;
  const key = primary?.itemKey?.trim() || label;
  return {
    list_type: primary?.listType?.trim() || null,
    op: primary?.op?.trim() || null,
    item_label: label,
    item_key: key,
    items,
  };
}

/** Build applied ops from this turn's engine results. */
export function collectAppliedTipOps(input: {
  listMutations: Array<{ action: string; listType?: string }>;
  filingMutations: Array<{ action: string }>;
  reminderSavedCount: number;
  reminderUpdateCount: number;
  reminderRemovedCount: number;
  reminderRequestedAdd: boolean;
  directorySavedCount: number;
  directoryRemovedCount: number;
  directoryRequestedUpdate: boolean;
}): AppliedTipOp[] {
  const ops: AppliedTipOp[] = [];
  const seen = new Set<string>();
  const push = (op: AppliedTipOp) => {
    const key = `${op.topic ?? op.area}:${op.op}:${op.listType ?? ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    ops.push(op);
  };

  for (const row of input.listMutations) {
    const action = row.action;
    if (action !== "add" && action !== "update" && action !== "remove") {
      continue;
    }
    const listType = row.listType?.trim() || null;
    const topic = topicFromListType(listType);
    push({
      area: topic ? areaFromTopic(topic) : "lists",
      op: action,
      listType,
      topic,
    });
    // Meetings live on tasks rows — also advance the meetings tip ladder.
    if (listType === "tasks") {
      push({
        area: "lists",
        op: action,
        listType: "tasks",
        topic: "meetings",
      });
    }
  }

  const filingActions = new Set(
    input.filingMutations.map((row) => {
      const a = row.action;
      if (a === "add_filing" || a === "add") return "add";
      if (a === "remove_filing" || a === "remove") return "remove";
      if (a === "update_filing" || a === "update") return "update";
      return "";
    }).filter(Boolean),
  );
  for (const op of ["add", "update", "remove"] as TipTriggerOp[]) {
    if (filingActions.has(op)) {
      push({
        area: "filing",
        op,
        listType: "filing",
        topic: "filing",
      });
    }
  }

  const reminderAdds = Math.max(
    0,
    input.reminderSavedCount - input.reminderUpdateCount,
  );
  if (reminderAdds > 0 && input.reminderRequestedAdd) {
    push({
      area: "reminders",
      op: "add",
      listType: "reminders",
      topic: "reminders",
    });
  }
  if (input.reminderUpdateCount > 0) {
    push({
      area: "reminders",
      op: "update",
      listType: "reminders",
      topic: "reminders",
    });
  }
  if (input.reminderRemovedCount > 0) {
    push({
      area: "reminders",
      op: "remove",
      listType: "reminders",
      topic: "reminders",
    });
  }

  if (input.directorySavedCount > 0) {
    push({
      area: "directory",
      op: input.directoryRequestedUpdate ? "update" : "add",
      listType: null,
      topic: "directory",
    });
  }
  if (input.directoryRemovedCount > 0) {
    push({
      area: "directory",
      op: "remove",
      listType: null,
      topic: "directory",
    });
  }

  return ops;
}

async function recordTipShown(input: {
  tipId: string;
  employeeId: string;
  digitalEmployeeId: string;
}): Promise<void> {
  const existing = await prisma.tipProgress.findUnique({
    where: {
      tipId_employeeId_digitalEmployeeId: {
        tipId: input.tipId,
        employeeId: input.employeeId,
        digitalEmployeeId: input.digitalEmployeeId,
      },
    },
  });
  if (existing) {
    await prisma.tipProgress.update({
      where: { id: existing.id },
      data: {
        showCount: existing.showCount + 1,
        lastShownAt: new Date(),
      },
    });
    return;
  }
  await prisma.tipProgress.create({
    data: {
      tipId: input.tipId,
      employeeId: input.employeeId,
      digitalEmployeeId: input.digitalEmployeeId,
      showCount: 1,
      lastShownAt: new Date(),
    },
  });
}

function actionTipMatches(tip: Tip, applied: AppliedTipOp): boolean {
  if (tip.triggerKind !== "action") {
    return false;
  }
  const op = (tip.triggerOp as TipTriggerOp | null) ?? "add";
  if (op !== applied.op) {
    return false;
  }
  const topic = tipTopic(tip);
  if (topic && applied.topic) {
    return topic === applied.topic;
  }
  if (tip.listType && applied.listType) {
    return tip.listType === applied.listType;
  }
  // Legacy: area-only match when tip has no topic/listType
  if (!topic && !tip.listType) {
    return tip.triggerArea === applied.area;
  }
  if (topic === "directory" && applied.area === "directory") {
    return true;
  }
  return tip.triggerArea === applied.area && !applied.listType;
}

function isUnlocked(
  tip: Tip,
  tips: Tip[],
  showCountByTip: Map<string, number>,
  keyToTipId: Map<string, string>,
): boolean {
  const tier = tipTier(tip);
  if (tier === "basic" || tier === "personal") {
    if (tip.unlockAfterKey) {
      const reqId = keyToTipId.get(tip.unlockAfterKey);
      if (!reqId) {
        return true;
      }
      return (showCountByTip.get(reqId) ?? 0) >= 1;
    }
    return true;
  }

  if (tip.unlockAfterKey) {
    const reqId = keyToTipId.get(tip.unlockAfterKey);
    if (!reqId) {
      return false;
    }
    return (showCountByTip.get(reqId) ?? 0) >= 1;
  }

  const topic = tipTopic(tip);
  if (!topic) {
    return true;
  }
  const needTier: TipTier =
    tier === "intermediate" ? "basic" : "intermediate";
  return tips.some((other) => {
    if (tipTopic(other) !== topic) {
      return false;
    }
    if (tipTier(other) !== needTier) {
      return false;
    }
    return (showCountByTip.get(other.id) ?? 0) >= 1;
  });
}

function tipEligibleByQuotaAndCooldown(
  tip: Tip,
  showCountByTip: Map<string, number>,
  lastShownByTip: Map<string, Date>,
): boolean {
  if (!underQuota(showCountByTip.get(tip.id) ?? 0, tip.maxShows)) {
    return false;
  }
  return tipCooldownOk(
    lastShownByTip.get(tip.id),
    tip.minIntervalMinutes ?? 0,
  );
}

/**
 * Resolve which tip texts to append this turn and bump progress.
 * Action/model first (one tip); general only if none contextual.
 * Dynamic tips: compose from tip.text + turn FACTS; fail/empty → skip (no progress).
 */
export async function resolveAndRecordTipsForTurn(input: {
  userId: string;
  speaker: PublicEmployee;
  digitalEmployeeId: string;
  appliedOps: AppliedTipOp[];
  modelTipKeys: string[];
  /** Applied list item labels for tip FACTS / static placeholders. */
  turnFactItems?: TipTurnFactItem[];
  addressGender?: "male" | "female" | null;
  /** Chat conversation for catalog_tip LlmUsages (required for dynamic). */
  billing?: ComposeLlmBilling | null;
}): Promise<TipTurnResult> {
  await ensureDefaultTips(input.userId);
  const speakerIsGuest = isGuestEmployee(input.speaker);
  const tips = await prisma.tip.findMany({
    where: { userId: input.userId, enabled: true },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
  const eligible = tips.filter(
    (tip) =>
      audienceMatches(tip.audience, speakerIsGuest) &&
      digitalMatches(tip.digitalEmployeeId, input.digitalEmployeeId),
  );
  if (eligible.length === 0) {
    return { texts: [], tipIds: [] };
  }

  const progressRows = await prisma.tipProgress.findMany({
    where: {
      employeeId: input.speaker.id,
      digitalEmployeeId: input.digitalEmployeeId,
      tipId: { in: eligible.map((tip) => tip.id) },
    },
  });
  const showCountByTip = new Map(
    progressRows.map((row) => [row.tipId, row.showCount] as const),
  );
  const lastShownByTip = new Map(
    progressRows.map((row) => [row.tipId, row.lastShownAt] as const),
  );
  const keyToTipId = new Map(eligible.map((tip) => [tip.key, tip.id] as const));

  const candidates: Tip[] = [];
  for (const tip of eligible) {
    if (tip.triggerKind !== "action") {
      continue;
    }
    if (!tipEligibleByQuotaAndCooldown(tip, showCountByTip, lastShownByTip)) {
      continue;
    }
    if (!isUnlocked(tip, eligible, showCountByTip, keyToTipId)) {
      continue;
    }
    if (!input.appliedOps.some((applied) => actionTipMatches(tip, applied))) {
      continue;
    }
    candidates.push(tip);
  }

  const modelKeys = new Set(
    input.modelTipKeys.map((key) => key.trim()).filter(Boolean),
  );
  for (const tip of eligible) {
    if (tip.triggerKind !== "model") {
      continue;
    }
    if (!modelKeys.has(tip.key)) {
      continue;
    }
    if (!tipEligibleByQuotaAndCooldown(tip, showCountByTip, lastShownByTip)) {
      continue;
    }
    if (!isUnlocked(tip, eligible, showCountByTip, keyToTipId)) {
      continue;
    }
    candidates.push(tip);
  }

  let chosen: Tip | null = null;
  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      const tr = TIER_RANK[tipTier(a)] - TIER_RANK[tipTier(b)];
      if (tr !== 0) {
        return tr;
      }
      return a.order - b.order || a.createdAt.getTime() - b.createdAt.getTime();
    });
    chosen = candidates[0] ?? null;
  } else {
    const generals = eligible.filter((tip) => {
      if (tip.triggerKind !== "general") {
        return false;
      }
      return tipEligibleByQuotaAndCooldown(tip, showCountByTip, lastShownByTip);
    });
    if (generals.length > 0) {
      const minShown = Math.min(
        ...generals.map((tip) => showCountByTip.get(tip.id) ?? 0),
      );
      chosen =
        generals.find((tip) => (showCountByTip.get(tip.id) ?? 0) === minShown) ??
        null;
    }
  }

  if (!chosen) {
    return { texts: [], tipIds: [] };
  }

  const instructions = chosen.text.trim();
  if (!instructions) {
    return { texts: [], tipIds: [] };
  }

  const facts = buildComposeFactsFromTurn(input.turnFactItems);
  let body: string | null;
  if (tipOutputMode(chosen) === "dynamic") {
    body = await composeCatalogTip({
      instructions,
      facts,
      addressGender: input.addressGender,
      billing: input.billing,
    });
  } else if (/\{[a-z_]+\}/.test(instructions)) {
    body = renderStaticTipText(instructions, facts);
  } else {
    body = instructions;
  }
  if (!body?.trim()) {
    return { texts: [], tipIds: [] };
  }

  await recordTipShown({
    tipId: chosen.id,
    employeeId: input.speaker.id,
    digitalEmployeeId: input.digitalEmployeeId,
  });
  return { texts: [body], tipIds: [chosen.id] };
}

/** Remaining model-kind tips the speaker may still receive (for AVAILABLE_TIPS). */
export async function formatAvailableTipsContext(input: {
  userId: string;
  speaker: PublicEmployee;
  digitalEmployeeId: string;
}): Promise<string> {
  await ensureDefaultTips(input.userId);
  const speakerIsGuest = isGuestEmployee(input.speaker);
  const tips = await prisma.tip.findMany({
    where: {
      userId: input.userId,
      enabled: true,
      triggerKind: "model",
    },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
  const eligible = tips.filter(
    (tip) =>
      audienceMatches(tip.audience, speakerIsGuest) &&
      digitalMatches(tip.digitalEmployeeId, input.digitalEmployeeId),
  );
  if (eligible.length === 0) {
    return "";
  }
  const progressRows = await prisma.tipProgress.findMany({
    where: {
      employeeId: input.speaker.id,
      digitalEmployeeId: input.digitalEmployeeId,
      tipId: { in: eligible.map((tip) => tip.id) },
    },
  });
  const showCountByTip = new Map(
    progressRows.map((row) => [row.tipId, row.showCount] as const),
  );
  const lastShownByTip = new Map(
    progressRows.map((row) => [row.tipId, row.lastShownAt] as const),
  );
  const remaining = eligible.filter((tip) =>
    tipEligibleByQuotaAndCooldown(tip, showCountByTip, lastShownByTip),
  );
  if (remaining.length === 0) {
    return "";
  }
  return [
    "AVAILABLE_TIPS (match this turn's chat to each tip's catalog text; when it fits, emit that key in metadata.tips — engine appends catalog tip text, static or FACTS-grounded; never invent keys or rewrite tip copy in responses):",
    ...remaining.map((tip) => {
      const body = tip.text.trim().replace(/\s+/g, " ");
      const mode = tipOutputMode(tip);
      return `- key=${tip.key} output=${mode} text: ${body}`;
    }),
  ].join("\n");
}

/** @internal test helper */
export function tipAudienceMatchesForTest(
  tipAudience: string,
  speakerIsGuest: boolean,
): boolean {
  return audienceMatches(tipAudience, speakerIsGuest);
}
