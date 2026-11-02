/**
 * Phase 0 contract — re-exports production helpers so fixtures stay aligned.
 * simulateNestedUpdatePackage remains test-only (documents package outcomes).
 */
export {
  FINGERPRINT_VERSION,
  FINGERPRINT_TZ,
  buildReminderClockFingerprint,
  decideCreateOrReuseClock,
  decideReuseWithoutSteal,
  isExactKeySoftLinkEnabled,
  jerusalemFireToken,
  resolveJerusalemFireFromParts,
  stableRecurrenceToken,
  ymdHm,
  type ClockFingerprintInput,
  type CreateOrReuseDecision,
  type ExistingLinkedClock,
  type FingerprintRecurrence,
} from "../../src/services/reminder-soft-link.js";

export type NestedUpdatePackageStep =
  | "update_fields"
  | "create_reminder"
  | "insert_join";

export type NestedUpdatePackageOutcome = {
  ok: boolean;
  reportedSuccess: "full" | "miss";
  rolledBack: boolean;
  leftPartialRows: boolean;
  failedAt: NestedUpdatePackageStep | null;
};

/** Documents Phase 1 package reporting contract (engine must match). */
export function simulateNestedUpdatePackage(input: {
  failAt: NestedUpdatePackageStep | null;
}): NestedUpdatePackageOutcome {
  if (input.failAt === null) {
    return {
      ok: true,
      reportedSuccess: "full",
      rolledBack: false,
      leftPartialRows: false,
      failedAt: null,
    };
  }
  return {
    ok: false,
    reportedSuccess: "miss",
    rolledBack: true,
    leftPartialRows: false,
    failedAt: input.failAt,
  };
}
