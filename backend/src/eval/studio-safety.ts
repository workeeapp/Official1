/**
 * Studio / LIVE_FULL safety — isolation from production, not mock substitution.
 *
 * LIVE_FULL must use real apply / orchestration code. Safety means:
 * - DATABASE_URL exactly equals WORKEE_APPROVED_TEST_DATABASE_URL
 * - WhatsApp Graph outbound is disabled (WORKEE_DISABLE_WHATSAPP_OUTBOUND=1)
 * - Reminder ticker is disabled (WORKEE_DISABLE_REMINDER_FIRE=1)
 * - Explicit STUDIO_ALLOW_LIVE_FULL=1 after those are verified
 *
 * Credentials may exist; side effects must be intercepted. Never opens Prisma.
 */
import {
  assertApprovedEvalDatabaseUrl,
  UnapprovedEvalDatabaseError,
} from "./studio-db-guard.js";

export type StudioTrack = "LIVE_MODEL" | "LIVE_MODEL_MT" | "LIVE_FULL";

export type StudioSafetyCheck = {
  id: string;
  ok: boolean;
  detail: string;
};

export type StudioSafetyReport = {
  track: StudioTrack;
  allowed: boolean;
  checks: StudioSafetyCheck[];
  blockers: string[];
  /** Non-blocking notes (e.g. WA creds present but outbound disabled). */
  notes: string[];
};

function dbNameHint(url: string | undefined): string {
  if (!url?.trim()) return "(absent)";
  try {
    const path = new URL(url).pathname.replace(/^\//, "");
    return path || "(empty-path)";
  } catch {
    return "(unparseable)";
  }
}

function whatsappCredsPresent(): boolean {
  return Boolean(
    process.env.WHATSAPP_ACCESS_TOKEN?.trim() ||
      process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() ||
      process.env.WHATSAPP_TOKEN?.trim() ||
      process.env.META_WHATSAPP_TOKEN?.trim(),
  );
}

/** Exact-match approved test DB (same rule as assertApprovedEvalDatabaseUrl). */
export function approvedTestDatabaseConfigured(): {
  ok: boolean;
  detail: string;
} {
  const approved = process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
  const db = process.env.DATABASE_URL;
  if (typeof approved !== "string" || !approved.trim()) {
    return {
      ok: false,
      detail: "WORKEE_APPROVED_TEST_DATABASE_URL is not set",
    };
  }
  if (typeof db !== "string" || !db.trim()) {
    return { ok: false, detail: "DATABASE_URL is missing" };
  }
  if (db !== approved) {
    return {
      ok: false,
      detail: `DATABASE_URL (${dbNameHint(db)}) does not exactly match WORKEE_APPROVED_TEST_DATABASE_URL (${dbNameHint(approved)}) — refusing any chance of production mutation`,
    };
  }
  // Mirror assertApprovedEvalDatabaseUrl: product DB identity is never approvable.
  try {
    assertApprovedEvalDatabaseUrl(db);
  } catch (err) {
    const detail =
      err instanceof UnapprovedEvalDatabaseError
        ? err.message
        : "approved URL failed eval database safety checks";
    return { ok: false, detail };
  }
  return {
    ok: true,
    detail: `Approved isolated test DB matched (${dbNameHint(db)})`,
  };
}

/**
 * Probe LIVE_FULL isolation. Read-only. Does not run tests or touch Prisma.
 */
export function probeLiveFullSafety(): StudioSafetyReport {
  const checks: StudioSafetyCheck[] = [];
  const notes: string[] = [];

  const db = approvedTestDatabaseConfigured();
  checks.push({
    id: "approved_test_database",
    ok: db.ok,
    detail: db.detail,
  });

  const waDisabled = process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND === "1";
  checks.push({
    id: "whatsapp_outbound_disabled",
    ok: waDisabled,
    detail: waDisabled
      ? "WORKEE_DISABLE_WHATSAPP_OUTBOUND=1 — Graph send is intercepted (real send code retained)"
      : "Set WORKEE_DISABLE_WHATSAPP_OUTBOUND=1 so Meta Graph is never called during Studio LIVE_FULL (credentials may remain)",
  });
  if (whatsappCredsPresent() && waDisabled) {
    notes.push(
      "WhatsApp credentials are present; outbound is disabled — isolation of side effects, not removal of product code",
    );
  }

  const remDisabled = process.env.WORKEE_DISABLE_REMINDER_FIRE === "1";
  checks.push({
    id: "reminder_fire_disabled",
    ok: remDisabled,
    detail: remDisabled
      ? "WORKEE_DISABLE_REMINDER_FIRE=1 — ticker will not schedule fires"
      : "Set WORKEE_DISABLE_REMINDER_FIRE=1 so production-style reminder ticks cannot message during Studio LIVE_FULL",
  });

  const optIn = process.env.STUDIO_ALLOW_LIVE_FULL === "1";
  checks.push({
    id: "explicit_live_full_opt_in",
    ok: optIn,
    detail: optIn
      ? "STUDIO_ALLOW_LIVE_FULL=1"
      : "Set STUDIO_ALLOW_LIVE_FULL=1 only after approved test DB + outbound/reminder isolation are verified",
  });

  const openai = Boolean(process.env.OPENAI_API_KEY?.trim());
  checks.push({
    id: "openai_key_present",
    ok: openai,
    detail: openai ? "OPENAI_API_KEY is set" : "OPENAI_API_KEY missing",
  });

  notes.push(
    "LIVE_FULL uses existing runLiveFull / MODEL_APPLY production apply on harness accounts — not a mock engine",
  );
  notes.push(
    "sendChatMessage dump-replace path is not fully wired in current LIVE_FULL runner; traces mark unavailable checkpoints honestly",
  );

  const blockers = checks
    .filter((c) => !c.ok)
    .map((c) => `${c.id}: ${c.detail}`);

  return {
    track: "LIVE_FULL",
    allowed: blockers.length === 0,
    checks,
    blockers,
    notes,
  };
}

export function assertLiveFullAllowed(): void {
  const report = probeLiveFullSafety();
  if (!report.allowed) {
    throw new UnapprovedEvalDatabaseError(
      `LIVE_FULL blocked (isolation incomplete): ${report.blockers.join("; ")}`,
    );
  }
}

/**
 * Studio run-start gate (Phase A): server-side only; UI cannot bypass.
 * - LIVE_FULL / write tracks: refused until Phase D isolation is proven.
 * - LIVE_MODEL / LIVE_MODEL_MT: disabled unless STUDIO_ALLOW_LIVE_MODEL=1.
 * Never opens Prisma. Does not treat WA/reminder flags as isolation proof.
 */
export function assertStudioTrackRunnable(track: StudioTrack): void {
  if (track === "LIVE_FULL") {
    throw new UnapprovedEvalDatabaseError(
      "LIVE_FULL is not exposed via Studio until an approved isolated test database is proven (Phase D)",
    );
  }
  if (track !== "LIVE_MODEL" && track !== "LIVE_MODEL_MT") {
    throw new UnapprovedEvalDatabaseError(
      `Unsupported or write-capable Studio track refused: ${String(track)}`,
    );
  }
  if (process.env.STUDIO_ALLOW_LIVE_MODEL !== "1") {
    throw new UnapprovedEvalDatabaseError(
      "LIVE_MODEL tracks are disabled by default; set STUDIO_ALLOW_LIVE_MODEL=1 only after explicit approval and budget/cost capture",
    );
  }
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new UnapprovedEvalDatabaseError(
      "OPENAI_API_KEY is required for LIVE_MODEL tracks",
    );
  }
}

/** Read-only probe for LIVE_MODEL / MT Studio opt-in (not DB isolation). */
export function probeLiveModelStudioAllow(): StudioSafetyReport {
  const checks: StudioSafetyCheck[] = [];
  const optIn = process.env.STUDIO_ALLOW_LIVE_MODEL === "1";
  checks.push({
    id: "explicit_live_model_opt_in",
    ok: optIn,
    detail: optIn
      ? "STUDIO_ALLOW_LIVE_MODEL=1"
      : "LIVE_MODEL / LIVE_MODEL_MT disabled by default (STUDIO_ALLOW_LIVE_MODEL not set)",
  });
  const openai = Boolean(process.env.OPENAI_API_KEY?.trim());
  checks.push({
    id: "openai_key_present",
    ok: openai,
    detail: openai ? "OPENAI_API_KEY is set" : "OPENAI_API_KEY missing",
  });
  const blockers = checks
    .filter((c) => !c.ok)
    .map((c) => `${c.id}: ${c.detail}`);
  return {
    track: "LIVE_MODEL",
    allowed: blockers.length === 0,
    checks,
    blockers,
    notes: [
      "LIVE_MODEL / MT do not apply to Prisma; they still call OpenAI when allowed",
      "This opt-in is not database isolation — write tracks remain separately blocked",
    ],
  };
}

export function trackCapabilities(track: StudioTrack): {
  track: StudioTrack;
  label: string;
  captures: string[];
  doesNotProve: string[];
  executable: boolean;
  safety?: StudioSafetyReport;
} {
  const liveModelAllowed =
    process.env.STUDIO_ALLOW_LIVE_MODEL === "1" &&
    Boolean(process.env.OPENAI_API_KEY?.trim());

  if (track === "LIVE_MODEL") {
    return {
      track,
      label: "Single-turn model ACTION / constraints",
      captures: [
        "user_message",
        "model_response",
        "parsed_metadata_action",
        "constraint_results",
        "llm_ms",
      ],
      doesNotProve: [
        "engine_apply",
        "database_state",
        "server_replaced_response",
        "whatsapp_delivery",
        "lucy2_db_prompt_unless_wired",
      ],
      executable: liveModelAllowed,
      safety: probeLiveModelStudioAllow(),
    };
  }
  if (track === "LIVE_MODEL_MT") {
    return {
      track,
      label: "Multi-turn model ACTION / constraints (in-memory snapshot)",
      captures: [
        "user_message",
        "model_response",
        "parsed_metadata_action",
        "constraint_results",
        "in_memory_snapshot_context",
        "llm_ms",
      ],
      doesNotProve: [
        "production_chat_pipeline",
        "database_state",
        "engine_apply",
        "server_replaced_response",
        "lucy2_db_prompt_unless_wired",
      ],
      executable: liveModelAllowed,
      safety: probeLiveModelStudioAllow(),
    };
  }
  const safety = probeLiveFullSafety();
  return {
    track,
    label:
      "LIVE_FULL — real apply on isolated test DB (not exposed via Studio until Phase D)",
    captures: [
      "user_message",
      "model_response",
      "parsed_metadata_action",
      "constraint_results",
      "production_apply",
      "state_after",
      "llm_ms",
      "harness_cleanup",
    ],
    doesNotProve: [
      "full_sendChatMessage_dump_replace_until_wired",
      "whatsapp_delivery_when_outbound_disabled",
    ],
    // Phase A: never executable via Studio even if isolation env looks green.
    executable: false,
    safety,
  };
}
