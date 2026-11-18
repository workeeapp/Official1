/**
 * UWM Phase 2 Source Memory on ExternalDataCache — workee_test only.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { parseComposeCondition } from "@workee/shared";
import { prisma } from "../src/database/prisma.js";
import {
  assertEvalDbAndGtfsUntouched,
  cleanupHarnessAccount,
  createHarnessAccount,
  type HarnessAccount,
} from "./helpers/eval-live-provider-harness.js";
import {
  readSourceMemory,
  sanitizeSourceMemoryProfile,
  SOURCE_MEMORY_PROVIDER,
  writeSourceMemorySuccess,
} from "../src/services/uwm-source-memory.js";
import { selectSourcesForWatch } from "../src/services/uwm-source-selector.js";
import { resetUwmMetrics } from "../src/services/uwm-retrieval-metrics.js";
import { applyReminders } from "../src/services/reminder.service.js";

describe("UWM Phase 2 Source Memory (eval-db)", () => {
  let account: HarnessAccount | null = null;
  const domain = `uwm-mem-${randomUUID().slice(0, 8)}.example`;

  beforeAll(async () => {
    await assertEvalDbAndGtfsUntouched();
    expect(new URL(process.env.DATABASE_URL!).port).toBe("5436");
  });

  afterEach(async () => {
    resetUwmMetrics();
    await prisma.externalDataCache.deleteMany({
      where: { provider: SOURCE_MEMORY_PROVIDER, scope: "profile" },
    });
    if (account) {
      await cleanupHarnessAccount(account);
      account = null;
    }
  });

  it("rejects profiles that embed private watch fields", () => {
    expect(
      sanitizeSourceMemoryProfile({
        sourceId: "x",
        userId: "secret-user",
        successCount: 1,
      }),
    ).toBeNull();
    expect(
      sanitizeSourceMemoryProfile({
        sourceId: "x",
        intent: "תעדכני אותי",
        successCount: 1,
      }),
    ).toBeNull();
  });

  it("stores public success profile and reuses as selector hint", async () => {
    const written = await writeSourceMemorySuccess({
      sourceId: "official-events",
      domain,
      url: `https://${domain}/events`,
      infoKinds: ["eventAt", "title"],
    });
    expect(written?.domain).toBe(domain);
    expect((written as { userId?: string } | null)?.userId).toBeUndefined();

    const { profile, cacheHit } = await readSourceMemory(domain);
    expect(cacheHit).toBe(true);
    expect(profile?.successCount).toBeGreaterThanOrEqual(1);

    const plan = await selectSourcesForWatch({
      type: "web_monitor",
      intent: "תעדכני על אירועים חדשים",
      canonicalQuery: "upcoming public events",
      preferredSources: [domain],
      objectives: [{ id: "d", kind: "discover_new" }],
    });
    expect(plan.useWebDiscovery).toBe(true);
    expect(plan.secondary.some((s) => s.id === domain || s.kind === "memory")).toBe(
      true,
    );
    expect(plan.reason).toBe("memory_reuse");
  });

  it("stamps sourcePlan into Reminder.monitorState on web_monitor capture", async () => {
    account = await createHarnessAccount("טל");
    const actorRow = await prisma.employee.findUniqueOrThrow({
      where: { id: account.employeeId },
    });
    const actor = {
      id: actorRow.id,
      name: actorRow.name,
      surname: actorRow.surname,
      nickname: actorRow.nickname,
      email: null,
      phone: actorRow.phone,
      kind: actorRow.kind as "human" | "digital",
    };
    const condition = parseComposeCondition({
      type: "web_monitor",
      intent: "הופעות אמן",
      canonical_query: "artist concerts",
      objectives: [{ id: "d", kind: "discover_new" }],
    });
    await applyReminders({
      userId: account.userId,
      actor,
      employees: [actor],
      reminders: [
        {
          action: "add",
          item: "מעקב",
          listType: "tasks",
          date: "",
          time: "",
          repeat: "hourly",
          ping: [],
          about: [],
          targets: [],
          text: "",
          inSeconds: null,
          everyCount: 3,
          everyUnit: "hours",
          weekdays: null,
          confirmed: false,
          compose: true,
          composeSource: "",
          composeLookbackHours: 0,
          composePlace: "",
          composeCondition: condition,
          watchOnce: false,
          reminderId: "",
          recurrence: { freq: "interval", interval: 3, unit: "hours" },
        },
      ],
    });
    const row = await prisma.reminder.findFirst({
      where: { userId: account.userId, status: "active" },
    });
    expect(row?.watchOnce).toBe(false);
    const state = row?.monitorState as {
      sourcePlan?: { coverage?: string; useWebDiscovery?: boolean };
    } | null;
    expect(state?.sourcePlan?.useWebDiscovery).toBe(true);
    expect(state?.sourcePlan?.coverage).toBe("none");
  });
});
