/**
 * Phase 0 — soft-link / nested-remind CONTRACT (offline only).
 *
 * Fixtures + pure contract helpers under tests/reminder-soft-link-phase0/.
 * Does NOT import or mutate production apply paths. Runtime behavior unchanged.
 *
 * Run: npx vitest run tests/reminder-soft-link-phase0.offline.test.ts
 */
import { describe, expect, it } from "vitest";
import { JERUSALEM_TIME_ZONE } from "@workee/shared";
import {
  buildReminderClockFingerprint,
  decideCreateOrReuseClock,
  decideReuseWithoutSteal,
  isExactKeySoftLinkEnabled,
  resolveJerusalemFireFromParts,
  simulateNestedUpdatePackage,
  jerusalemFireToken,
  FINGERPRINT_TZ,
} from "./reminder-soft-link-phase0/contract.js";
import {
  FIXTURE_DUAL_NESTED_AND_TOPLEVEL,
  FIXTURE_LEGACY_ACTION,
  FIXTURE_NESTED_ADD_ACTION,
  FIXTURE_NESTED_ADD_LINK_ONLY,
  FIXTURE_NESTED_UPDATE_ACTION,
  IDS,
  NESTED_UPDATE_FAIL_STEPS,
  fixtureAllDayVet,
  fixtureEveningVet,
  fixtureLinkOrphan,
  fixtureMorningComposeWeather,
  fixtureMorningDifferentPing,
  fixtureMorningDifferentText,
  fixtureMorningVet,
  fixtureMorningVetNormalizedText,
  fixtureNestedAndTopLevelSame,
  fixtureRefuseStealJoin,
  fixtureRetryAlreadySaved,
  fixtureWeeklyMorning,
} from "./reminder-soft-link-phase0/fixtures.js";

describe("Phase 0 soft-link contract (offline)", () => {
  describe("F — fingerprint Asia/Jerusalem + time=none", () => {
    it("uses Asia/Jerusalem as the only fingerprint timezone", () => {
      expect(FINGERPRINT_TZ).toBe("Asia/Jerusalem");
      expect(FINGERPRINT_TZ).toBe(JERUSALEM_TIME_ZONE);
      const f = buildReminderClockFingerprint(fixtureMorningVet());
      expect(f).toContain("tz=Asia/Jerusalem");
      expect(f).not.toContain("UTC");
    });

    it("normalizes resolved fire to Jerusalem wall HH:mm", () => {
      const resolved = resolveJerusalemFireFromParts({
        date: "2026-11-10",
        time: "09:00",
      });
      expect(resolved).not.toBeNull();
      expect(resolved!.hasExplicitTime).toBe(true);
      expect(jerusalemFireToken(resolved!.fireAt, true)).toBe(
        "2026-11-10T09:00",
      );
      const f = buildReminderClockFingerprint({
        ...fixtureMorningVet(),
        resolvedFireAt: resolved!.fireAt,
        hasExplicitTime: true,
      });
      expect(f).toContain("fire=2026-11-10T09:00");
    });

    it("encodes missing time as time=none (not mergeable with 09:00)", () => {
      const allDay = resolveJerusalemFireFromParts({
        date: "2026-11-10",
        time: "",
      });
      expect(allDay).not.toBeNull();
      expect(allDay!.hasExplicitTime).toBe(false);
      expect(jerusalemFireToken(allDay!.fireAt, false)).toBe(
        "2026-11-10Ttime=none",
      );

      const fNone = buildReminderClockFingerprint(fixtureAllDayVet());
      const fMorning = buildReminderClockFingerprint(fixtureMorningVet());
      expect(fNone).toContain("fire=2026-11-10Ttime=none");
      expect(fMorning).toContain("fire=2026-11-10T09:00");
      expect(fNone).not.toBe(fMorning);
    });

    it("normalizes message whitespace so identical clocks share F", () => {
      const a = buildReminderClockFingerprint(fixtureMorningVet());
      const b = buildReminderClockFingerprint(
        fixtureMorningVetNormalizedText(),
      );
      expect(a).toBe(b);
    });
  });

  describe("F — two intentional clocks on same item must not merge", () => {
    it("09:00 vs 18:00 → different F", () => {
      const morning = buildReminderClockFingerprint(fixtureMorningVet());
      const evening = buildReminderClockFingerprint(fixtureEveningVet());
      expect(morning).not.toBe(evening);
    });

    it("once vs weekly → different F", () => {
      const once = buildReminderClockFingerprint(fixtureMorningVet());
      const weekly = buildReminderClockFingerprint(fixtureWeeklyMorning());
      expect(once).not.toBe(weekly);
    });

    it("different ping → different F", () => {
      const a = buildReminderClockFingerprint(fixtureMorningVet());
      const b = buildReminderClockFingerprint(fixtureMorningDifferentPing());
      expect(a).not.toBe(b);
    });

    it("different text → different F", () => {
      const a = buildReminderClockFingerprint(fixtureMorningVet());
      const b = buildReminderClockFingerprint(fixtureMorningDifferentText());
      expect(a).not.toBe(b);
    });

    it("compose weather vs plain → different F", () => {
      const a = buildReminderClockFingerprint(fixtureMorningVet());
      const b = buildReminderClockFingerprint(fixtureMorningComposeWeather());
      expect(a).not.toBe(b);
    });

    it("does not include titles / itemKey in F", () => {
      const f = buildReminderClockFingerprint(fixtureMorningVet())!;
      expect(f).not.toMatch(/להזכיר/);
      expect(f).not.toMatch(/itemKey/i);
      expect(f).not.toMatch(/תור לווטרינר/);
      expect(f).toContain(`item=${IDS.ITEM_A}`);
    });
  });

  describe("same-turn nested + top-level identical → same F (dedup candidate)", () => {
    it("nested and top-level fixtures share fingerprint", () => {
      const { nested, topLevel } = fixtureNestedAndTopLevelSame();
      expect(buildReminderClockFingerprint(nested)).toBe(
        buildReminderClockFingerprint(topLevel),
      );
    });

    it("dual ACTION fixture documents both paths present", () => {
      const lists = FIXTURE_DUAL_NESTED_AND_TOPLEVEL.metadata.lists;
      expect(lists).toHaveLength(2);
      expect(lists[0]?.items?.[0]).toHaveProperty("remind");
      expect(lists[1]?.list_type).toBe("reminders");
      expect(lists[1]?.items?.[0]?.item_id).toBe(IDS.ITEM_A);
    });
  });

  describe("I — retry when clock + join already exist", () => {
    it("reuses active clock with same F; ensureJoin true; no second create", () => {
      const fingerprint = buildReminderClockFingerprint(fixtureMorningVet());
      expect(fingerprint).toBeTruthy();
      const decision = decideCreateOrReuseClock(
        fixtureRetryAlreadySaved(fingerprint!),
      );
      expect(decision).toEqual({
        action: "reuse",
        reminderId: IDS.REM_1,
        ensureJoin: true,
      });
    });

    it("creates when F differs on the same item", () => {
      const morningF = buildReminderClockFingerprint(fixtureMorningVet())!;
      const eveningF = buildReminderClockFingerprint(fixtureEveningVet())!;
      const decision = decideCreateOrReuseClock({
        itemId: IDS.ITEM_A,
        fingerprint: eveningF,
        existing: [
          {
            reminderId: IDS.REM_1,
            itemId: IDS.ITEM_A,
            status: "active",
            fingerprint: morningF,
          },
        ],
      });
      expect(decision).toEqual({ action: "create" });
    });

    it("creates again when prior clock is cancelled (not active)", () => {
      const fingerprint = buildReminderClockFingerprint(fixtureMorningVet())!;
      const decision = decideCreateOrReuseClock({
        itemId: IDS.ITEM_A,
        fingerprint,
        existing: [
          {
            reminderId: IDS.REM_1,
            itemId: IDS.ITEM_A,
            status: "cancelled",
            fingerprint,
          },
        ],
      });
      expect(decision).toEqual({ action: "create" });
    });

    it("miss when fingerprint cannot be built (unresolved fire)", () => {
      const decision = decideCreateOrReuseClock({
        itemId: IDS.ITEM_A,
        fingerprint: null,
        existing: [],
      });
      expect(decision).toEqual({
        action: "miss",
        reason: "unresolved_fire",
      });
    });
  });

  describe("reuse without stealing join from another item", () => {
    it("refuses when reminder join already owned by another item", () => {
      expect(decideReuseWithoutSteal(fixtureRefuseStealJoin())).toBe(
        "refuse_steal",
      );
    });

    it("already_joined_same when target already owns the join", () => {
      expect(
        decideReuseWithoutSteal({
          targetItemId: IDS.ITEM_A,
          reminderId: IDS.REM_1,
          joinOwnerItemId: IDS.ITEM_A,
        }),
      ).toBe("already_joined_same");
    });

    it("link_orphan when clock has no join yet", () => {
      expect(decideReuseWithoutSteal(fixtureLinkOrphan())).toBe("link_orphan");
    });
  });

  describe("U — nested update package rollback (no partial success)", () => {
    it("full success only when no step fails", () => {
      const out = simulateNestedUpdatePackage({ failAt: null });
      expect(out).toEqual({
        ok: true,
        reportedSuccess: "full",
        rolledBack: false,
        leftPartialRows: false,
        failedAt: null,
      });
    });

    it.each([...NESTED_UPDATE_FAIL_STEPS])(
      "fail at %s → miss, rolled back, no partial rows, not full success",
      (step) => {
        const out = simulateNestedUpdatePackage({ failAt: step });
        expect(out.ok).toBe(false);
        expect(out.reportedSuccess).toBe("miss");
        expect(out.rolledBack).toBe(true);
        expect(out.leftPartialRows).toBe(false);
        expect(out.failedAt).toBe(step);
        expect(out.reportedSuccess).not.toBe("full");
      },
    );

    it("documents nested update ACTION fixture shape", () => {
      const item = FIXTURE_NESTED_UPDATE_ACTION.metadata.lists[0]?.items?.[0];
      expect(item?.item_id).toBe(IDS.ITEM_A);
      expect(item).toHaveProperty("remind");
      expect(FIXTURE_NESTED_ADD_ACTION.metadata.lists[0]?.items?.[0]).toHaveProperty(
        "remind",
      );
      // Preferred NEW path has no minted item_id and no duplicate top-level reminders.
      expect(
        (FIXTURE_NESTED_ADD_ACTION.metadata.lists[0]?.items?.[0] as { item_id?: string })
          .item_id,
      ).toBeUndefined();
      expect(
        FIXTURE_NESTED_ADD_ACTION.metadata.lists.some(
          (row) => row.list_type === "reminders",
        ),
      ).toBe(false);
      // Legacy fixture is EXISTING-row reminders + ESD item_id (dedup/legacy only).
      expect(FIXTURE_LEGACY_ACTION.metadata.lists[0]?.list_type).toBe("reminders");
      expect(
        (FIXTURE_LEGACY_ACTION.metadata.lists[0]?.items?.[0] as { item_id?: string })
          .item_id,
      ).toBe(IDS.ITEM_A);
    });

    it("Stage 3a: LINK-ONLY nested add has remind and no worker task", () => {
      const lists = FIXTURE_NESTED_ADD_LINK_ONLY.metadata.lists;
      expect(lists).toHaveLength(1);
      expect(lists[0]?.items?.[0]).toHaveProperty("remind");
      expect(
        lists.some(
          (row) =>
            Array.isArray(row.targets) &&
            row.targets.some((t) => String(t).includes("לוסי")),
        ),
      ).toBe(false);
      // Self-nudge product fixture still includes worker tracking separately.
      expect(
        FIXTURE_NESTED_ADD_ACTION.metadata.lists.some(
          (row) =>
            Array.isArray(row.targets) &&
            row.targets.some((t) => String(t).includes("לוסי")),
        ),
      ).toBe(true);
    });
  });

  describe("RB — WORKEE_SOFT_LINK_EXACT_KEY flag contract", () => {
    it("absent → ON", () => {
      expect(isExactKeySoftLinkEnabled({})).toBe(true);
      expect(isExactKeySoftLinkEnabled({ WORKEE_SOFT_LINK_EXACT_KEY: "" })).toBe(
        true,
      );
    });

    it("1 / true / on → ON", () => {
      expect(isExactKeySoftLinkEnabled({ WORKEE_SOFT_LINK_EXACT_KEY: "1" })).toBe(
        true,
      );
      expect(
        isExactKeySoftLinkEnabled({ WORKEE_SOFT_LINK_EXACT_KEY: "true" }),
      ).toBe(true);
      expect(isExactKeySoftLinkEnabled({ WORKEE_SOFT_LINK_EXACT_KEY: "ON" })).toBe(
        true,
      );
    });

    it("0 / false / off → OFF", () => {
      expect(isExactKeySoftLinkEnabled({ WORKEE_SOFT_LINK_EXACT_KEY: "0" })).toBe(
        false,
      );
      expect(
        isExactKeySoftLinkEnabled({ WORKEE_SOFT_LINK_EXACT_KEY: "false" }),
      ).toBe(false);
      expect(
        isExactKeySoftLinkEnabled({ WORKEE_SOFT_LINK_EXACT_KEY: "off" }),
      ).toBe(false);
    });
  });
});
