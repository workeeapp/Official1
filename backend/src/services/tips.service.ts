import type { Tip } from "@prisma/client";
import type {
  PublicEmployee,
  PublicTip,
  TipAudience,
  TipInput,
  TipTriggerArea,
  TipTriggerKind,
  TipTriggerOp,
  TipUpdateInput,
} from "@workee/shared";
import { isGuestEmployee, isGuestLucy } from "@workee/shared";
import { prisma } from "../database/prisma.js";
import {
  ConflictError,
  isUniqueConstraintError,
  NotFoundError,
  ValidationError,
} from "../utils/errors.js";

const LUCY_NAME = "לוסי";

export interface AppliedTipOp {
  area: TipTriggerArea;
  op: TipTriggerOp;
}

export interface TipTurnResult {
  /** Catalog texts to append (contextual first, then at most one general). */
  texts: string[];
  /** Tip ids that were recorded this turn. */
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

const DEFAULT_TIP_TEXTS = {
  reminders_intro:
    "לידיעתך: התזכורות נשמרות אצלי, וכל פעם שתרצה אוכל להציג אותן.",
  filing_media:
    "אפשר גם לתייק תמונה, וידאו וקבצים — פשוט שלח/י אותם ואגיד לאן לשמור.",
  guest_terms:
    "תקנון שימוש (תמצית): השימוש באורח מוגבל לצפייה ברשימות ששותפו איתך ולהרשמה לחשבון. לאחר ההרשמה תקבל/י חשבון משלך עם לוסי. אל תשתף סיסמאות עם אחרים.",
  general_lists:
    "טיפ: אפשר לבקש ממני להציג קניות, מטלות או תיוקים בכל רגע — למשל «הציגי את רשימת הקניות».",
  general_reminders:
    "טיפ: אפשר לקבוע תזכורת בשעה מדויקת או בעוד X דקות — למשל «תזכירי לי מחר ב־9»." ,
} as const;

/** Insert default tips for Lucy / לוסי-אורח when missing (by key). */
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

  const seeds: Array<{
    key: string;
    audience: TipAudience;
    digitalEmployeeId: string | null;
    triggerKind: TipTriggerKind;
    triggerArea: TipTriggerArea | null;
    triggerOp: TipTriggerOp | null;
    maxShows: number;
    order: number;
    text: string;
  }> = [];

  if (lucy) {
    seeds.push(
      {
        key: "reminders_intro",
        audience: "member",
        digitalEmployeeId: lucy.id,
        triggerKind: "action",
        triggerArea: "reminders",
        triggerOp: "add",
        maxShows: 1,
        order: 100,
        text: DEFAULT_TIP_TEXTS.reminders_intro,
      },
      {
        key: "filing_media",
        audience: "member",
        digitalEmployeeId: lucy.id,
        triggerKind: "action",
        triggerArea: "filing",
        triggerOp: "add",
        maxShows: 1,
        order: 110,
        text: DEFAULT_TIP_TEXTS.filing_media,
      },
      {
        key: "general_lists",
        audience: "member",
        digitalEmployeeId: lucy.id,
        triggerKind: "general",
        triggerArea: null,
        triggerOp: null,
        maxShows: 3,
        order: 10,
        text: DEFAULT_TIP_TEXTS.general_lists,
      },
      {
        key: "general_reminders",
        audience: "member",
        digitalEmployeeId: lucy.id,
        triggerKind: "general",
        triggerArea: null,
        triggerOp: null,
        maxShows: 3,
        order: 20,
        text: DEFAULT_TIP_TEXTS.general_reminders,
      },
    );
  }

  if (guestLucy) {
    seeds.push({
      key: "guest_terms",
      audience: "guest",
      digitalEmployeeId: guestLucy.id,
      triggerKind: "model",
      triggerArea: null,
      triggerOp: null,
      maxShows: 1,
      order: 50,
      text: DEFAULT_TIP_TEXTS.guest_terms,
    });
  }

  for (const seed of seeds) {
    const existing = await prisma.tip.findUnique({
      where: { userId_key: { userId, key: seed.key } },
      select: { id: true },
    });
    if (existing) {
      continue;
    }
    try {
      await prisma.tip.create({
        data: {
          userId,
          key: seed.key,
          audience: seed.audience,
          digitalEmployeeId: seed.digitalEmployeeId,
          triggerKind: seed.triggerKind,
          triggerArea: seed.triggerArea,
          triggerOp: seed.triggerOp,
          maxShows: seed.maxShows,
          order: seed.order,
          text: seed.text,
          enabled: true,
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
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
      ...(input.audience !== undefined ? { audience: input.audience } : {}),
      ...(input.digitalEmployeeId !== undefined
        ? { digitalEmployeeId: input.digitalEmployeeId }
        : {}),
      ...(input.triggerKind !== undefined
        ? { triggerKind: input.triggerKind }
        : {}),
      triggerArea: nextArea,
      triggerOp: nextOp,
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

/** Build applied ops from this turn's engine results. */
export function collectAppliedTipOps(input: {
  listMutations: Array<{ action: string }>;
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
  const listActions = new Set(
    input.listMutations.map((row) => row.action).filter(Boolean),
  );
  for (const op of ["add", "update", "remove"] as TipTriggerOp[]) {
    if (listActions.has(op)) {
      ops.push({ area: "lists", op });
    }
  }
  const filingActions = new Set(
    input.filingMutations.map((row) => row.action).filter(Boolean),
  );
  for (const op of ["add", "update", "remove"] as TipTriggerOp[]) {
    if (filingActions.has(op)) {
      ops.push({ area: "filing", op });
    }
  }
  // New clocks land in saved without an update change row.
  const reminderAdds = Math.max(
    0,
    input.reminderSavedCount - input.reminderUpdateCount,
  );
  if (reminderAdds > 0 && input.reminderRequestedAdd) {
    ops.push({ area: "reminders", op: "add" });
  }
  if (input.reminderUpdateCount > 0) {
    ops.push({ area: "reminders", op: "update" });
  }
  if (input.reminderRemovedCount > 0) {
    ops.push({ area: "reminders", op: "remove" });
  }
  if (input.directorySavedCount > 0) {
    // Directory apply uses saved for add+update; prefer add unless only update requested.
    ops.push({
      area: "directory",
      op: input.directoryRequestedUpdate ? "update" : "add",
    });
  }
  if (input.directoryRemovedCount > 0) {
    ops.push({ area: "directory", op: "remove" });
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

/**
 * Resolve which tip texts to append this turn and bump progress.
 * Contextual (action/model) tips first; general only if none contextual fired.
 */
export async function resolveAndRecordTipsForTurn(input: {
  userId: string;
  speaker: PublicEmployee;
  digitalEmployeeId: string;
  appliedOps: AppliedTipOp[];
  modelTipKeys: string[];
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

  const queued: Tip[] = [];
  const queuedIds = new Set<string>();

  const queueIfOk = (tip: Tip) => {
    if (queuedIds.has(tip.id)) {
      return;
    }
    const shown = showCountByTip.get(tip.id) ?? 0;
    if (!underQuota(shown, tip.maxShows)) {
      return;
    }
    queued.push(tip);
    queuedIds.add(tip.id);
  };

  for (const tip of eligible) {
    if (tip.triggerKind !== "action") {
      continue;
    }
    const area = tip.triggerArea as TipTriggerArea | null;
    const op = (tip.triggerOp as TipTriggerOp | null) ?? "add";
    if (!area) {
      continue;
    }
    if (
      input.appliedOps.some((applied) => applied.area === area && applied.op === op)
    ) {
      queueIfOk(tip);
    }
  }

  const modelKeys = new Set(
    input.modelTipKeys.map((key) => key.trim()).filter(Boolean),
  );
  for (const tip of eligible) {
    if (tip.triggerKind !== "model") {
      continue;
    }
    if (modelKeys.has(tip.key)) {
      queueIfOk(tip);
    }
  }

  const contextualCount = queued.length;

  if (contextualCount === 0) {
    // Round-robin among under-quota generals: lowest showCount, then catalog order.
    const generals = eligible.filter((tip) => {
      if (tip.triggerKind !== "general") {
        return false;
      }
      return underQuota(showCountByTip.get(tip.id) ?? 0, tip.maxShows);
    });
    if (generals.length > 0) {
      const minShown = Math.min(
        ...generals.map((tip) => showCountByTip.get(tip.id) ?? 0),
      );
      const next = generals.find(
        (tip) => (showCountByTip.get(tip.id) ?? 0) === minShown,
      );
      if (next) {
        queueIfOk(next);
      }
    }
  }

  const texts: string[] = [];
  const tipIds: string[] = [];
  for (const tip of queued) {
    const body = tip.text.trim();
    if (!body) {
      continue;
    }
    texts.push(body);
    tipIds.push(tip.id);
    await recordTipShown({
      tipId: tip.id,
      employeeId: input.speaker.id,
      digitalEmployeeId: input.digitalEmployeeId,
    });
    showCountByTip.set(tip.id, (showCountByTip.get(tip.id) ?? 0) + 1);
  }

  return { texts, tipIds };
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
  const remaining = eligible.filter((tip) =>
    underQuota(showCountByTip.get(tip.id) ?? 0, tip.maxShows),
  );
  if (remaining.length === 0) {
    return "";
  }
  return [
    "AVAILABLE_TIPS (match this turn's chat to each tip's catalog text; when it fits, emit that key in metadata.tips — engine appends the text; never invent keys or rewrite tip copy in responses):",
    ...remaining.map((tip) => {
      const body = tip.text.trim().replace(/\s+/g, " ");
      return `- key=${tip.key} text: ${body}`;
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
