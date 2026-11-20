/**
 * Create-turn bootstrap for web_monitor watches that include time_before_event.
 * Runs after the Watch row is committed — never inside an open write transaction.
 * Arms nextPrecise via pollWebMonitor(suppressNotify); CAS-safe monitorState write.
 */
import type { LlmWebMonitorCondition } from "@workee/shared";
import { parseComposeCondition } from "@workee/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import type { CachedWebSearchOptions } from "./external-lookup.service.js";
import {
  parseMonitorState,
  pollWebMonitor,
} from "./semantic-web-monitor.service.js";
import {
  dualFireAt,
  isPastPreciseGrace,
  isWithinPreciseCatchUp,
} from "./uwm-schedule.js";
import type { UwmMonitorState, UwmNextPrecise } from "./uwm-types.js";
import { resolveNextFireAt, scheduleSoon } from "./reminder-fire.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";

export type UwmBootstrapArmStatus =
  | "armed"
  | "not_armed"
  | "catch_up"
  | "too_late"
  | "poll_failed";

export type UwmCreateBootstrapResult = {
  armed: boolean;
  armStatus: UwmBootstrapArmStatus;
  eventAtIso: string | null;
  preciseFireAtIso: string | null;
  fireAtIso: string | null;
  itemTitle: string | null;
  skippedConcurrentWrite: boolean;
};

type SearchImpl = CachedWebSearchOptions["searchImpl"];

let bootstrapSearchImplForTests: SearchImpl | undefined;

export function setUwmCreateBootstrapSearchImplForTests(
  impl: SearchImpl | null,
): void {
  bootstrapSearchImplForTests = impl ?? undefined;
}

export function webMonitorHasTimeBeforeEvent(
  composeCondition: unknown,
): boolean {
  const parsed = parseComposeCondition(composeCondition);
  if (!parsed || parsed.type !== "web_monitor") return false;
  return parsed.objectives.some((o) => o.kind === "time_before_event");
}

function armStatusForPrecise(
  precise: UwmNextPrecise | null,
  now: Date,
): UwmBootstrapArmStatus {
  if (!precise) return "not_armed";
  const fireAt = new Date(precise.fireAtIso);
  if (!Number.isFinite(fireAt.getTime())) return "not_armed";
  if (isPastPreciseGrace({ now, eventAtIso: precise.eventAtIso })) {
    return "too_late";
  }
  if (
    fireAt.getTime() <= now.getTime() &&
    isWithinPreciseCatchUp({
      now,
      preciseFireAt: fireAt,
      eventAtIso: precise.eventAtIso,
    })
  ) {
    return "catch_up";
  }
  if (fireAt.getTime() <= now.getTime()) {
    return "too_late";
  }
  return "armed";
}

function itemTitleForPrecise(
  state: UwmMonitorState,
  precise: UwmNextPrecise | null,
): string | null {
  if (!precise) return null;
  const st = state.items[precise.itemId];
  const core = String(st?.identityCore ?? "").trim();
  return core ? core.slice(0, 80) : null;
}

/**
 * After Watch persist: one suppressNotify poll, CAS write, dualFireAt.
 * On search/provider failure: keep Watch, stamp lastErrorClass, leave discovery cadence.
 */
export async function bootstrapWebMonitorCreateTurn(input: {
  reminderId: string;
  userId: string;
  composeCondition: unknown;
  watchOnce: boolean;
  now?: Date;
}): Promise<UwmCreateBootstrapResult> {
  const now = input.now ?? new Date();
  const empty: UwmCreateBootstrapResult = {
    armed: false,
    armStatus: "not_armed",
    eventAtIso: null,
    preciseFireAtIso: null,
    fireAtIso: null,
    itemTitle: null,
    skippedConcurrentWrite: false,
  };

  const row = await prisma.reminder.findUnique({
    where: { id: input.reminderId },
    select: {
      id: true,
      fireAt: true,
      monitorState: true,
      composeCondition: true,
      watchOnce: true,
      repeat: true,
      recurrence: true,
      scheduleAnchor: true,
      scheduleOffsetMinutes: true,
      composePlace: true,
      occurrencesFired: true,
      status: true,
    },
  });
  if (!row || row.status !== "active") {
    return empty;
  }
  if (!webMonitorHasTimeBeforeEvent(row.composeCondition ?? input.composeCondition)) {
    return empty;
  }

  const priorState = parseMonitorState(row.monitorState);
  const priorLastPollAt = priorState.lastPollAt ?? null;
  const bootstrapStartedAt = now.toISOString();

  let pollResult: Awaited<ReturnType<typeof pollWebMonitor>>;
  try {
    const pollPromise = pollWebMonitor({
      reminderId: row.id,
      userId: input.userId,
      composeCondition: row.composeCondition ?? input.composeCondition,
      monitorState: row.monitorState,
      watchOnce: Boolean(row.watchOnce ?? input.watchOnce),
      now,
      suppressNotify: true,
      ...(bootstrapSearchImplForTests
        ? {
            searchImpl: bootstrapSearchImplForTests,
            // Test fixture path: never reuse cached search from other cases.
            skipExternalCache: true,
          }
        : {}),
    });
    // Create-turn must not hang the apply path on slow/unresponsive search.
    const BOOTSTRAP_POLL_MS = 8_000;
    pollResult = await Promise.race([
      pollPromise,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("uwm_bootstrap_poll_timeout")),
          BOOTSTRAP_POLL_MS,
        );
      }),
    ]);
  } catch (error) {
    const failedState: UwmMonitorState = {
      ...priorState,
      lastPollAt: bootstrapStartedAt,
      lastErrorClass: "api_fail",
    };
    recordWhatsAppEvent(
      "uwm_bootstrap_poll_failed",
      `id=${row.id.slice(0, 8)} ${
        error instanceof Error ? error.message.slice(0, 80) : "unknown"
      }`,
    );
    await prisma.reminder.update({
      where: { id: row.id },
      data: {
        monitorState: failedState as unknown as Prisma.InputJsonValue,
      },
    }).catch(() => null);
    return {
      ...empty,
      armStatus: "poll_failed",
      fireAtIso: row.fireAt.toISOString(),
    };
  }

  // Re-read for CAS: do not clobber a newer poll that landed while we searched.
  const fresh = await prisma.reminder.findUnique({
    where: { id: row.id },
    select: { monitorState: true, fireAt: true, occurrencesFired: true },
  });
  if (!fresh) return empty;
  const freshState = parseMonitorState(fresh.monitorState);
  const freshLast = freshState.lastPollAt ?? null;
  if (
    freshLast &&
    freshLast !== priorLastPollAt &&
    freshLast > bootstrapStartedAt
  ) {
    const status = armStatusForPrecise(freshState.nextPrecise ?? null, now);
    return {
      armed: status === "armed",
      armStatus: status,
      eventAtIso: freshState.nextPrecise?.eventAtIso ?? null,
      preciseFireAtIso: freshState.nextPrecise?.fireAtIso ?? null,
      fireAtIso: fresh.fireAt.toISOString(),
      itemTitle: itemTitleForPrecise(freshState, freshState.nextPrecise ?? null),
      skippedConcurrentWrite: true,
    };
  }

  const nextState = pollResult.monitorState;
  const precise = pollResult.nextPrecise ?? nextState.nextPrecise ?? null;
  let status = armStatusForPrecise(precise, now);
  let observedEventAt: string | null = precise?.eventAtIso ?? null;
  let observedTitle: string | null = itemTitleForPrecise(nextState, precise);
  // Transient provider/search failures are swallowed inside pollWebMonitor —
  // surface them as poll_failed so create-turn never claims a dated reminder.
  if (
    !precise &&
    (nextState.lastErrorClass === "api_fail" ||
      nextState.lastErrorClass === "quota" ||
      nextState.lastErrorClass === "page_fail")
  ) {
    status = "poll_failed";
  } else if (!precise) {
    // Event found but past T−N grace → too_late (do not claim a future dated fire).
    for (const st of Object.values(nextState.items ?? {})) {
      if (!st.eventAt) continue;
      if (isPastPreciseGrace({ now, eventAtIso: st.eventAt })) {
        status = "too_late";
        observedEventAt = st.eventAt;
        const core = String(st.identityCore ?? "").trim();
        observedTitle = core ? core.slice(0, 80) : observedTitle;
        break;
      }
    }
  }

  const discoveryNext = await resolveNextFireAt(
    {
      fireAt: row.fireAt,
      repeat: row.repeat,
      recurrence: row.recurrence,
      scheduleAnchor: row.scheduleAnchor,
      scheduleOffsetMinutes: row.scheduleOffsetMinutes,
      composePlace: row.composePlace,
    },
    now,
    (row.occurrencesFired ?? 0) + 1,
  );

  // Only dual-schedule when we have a future (or catch-up) precise arm.
  // too_late / not_armed / poll_failed → keep discovery cadence.
  let nextFireAt = row.fireAt;
  if (status === "armed" || status === "catch_up") {
    const dual = dualFireAt(discoveryNext, precise, now);
    if (dual) nextFireAt = dual;
  } else if (discoveryNext && discoveryNext.getTime() > now.getTime()) {
    nextFireAt = discoveryNext;
  }

  await prisma.reminder.update({
    where: { id: row.id },
    data: {
      monitorState: nextState as unknown as Prisma.InputJsonValue,
      fireAt: nextFireAt,
      sendStatus: "pending",
    },
  });
  scheduleSoon(nextFireAt);

  return {
    armed: status === "armed",
    armStatus: status,
    eventAtIso: observedEventAt,
    preciseFireAtIso: precise?.fireAtIso ?? null,
    fireAtIso: nextFireAt.toISOString(),
    itemTitle: observedTitle,
    skippedConcurrentWrite: false,
  };
}

/** Type guard helper for callers that already parsed the condition. */
export function conditionHasTimeBeforeEvent(
  condition: LlmWebMonitorCondition | null | undefined,
): boolean {
  if (!condition || condition.type !== "web_monitor") return false;
  return condition.objectives.some((o) => o.kind === "time_before_event");
}
