import type { AdminMonitoringResponse } from "@workee/shared";

export type StatusLevel = "healthy" | "attention" | "critical";

export interface StatusCheck {
  id: string;
  label: string;
  state: "ok" | "warn" | "bad";
  /** Short badge — avoid calling minor noise "Down". */
  badge: string;
  meaning: string;
}

export interface ExplainedFailure {
  at: string;
  step: string;
  detail: string;
  alertKey?: string;
  title: string;
  meaning: string;
  /** noise = config/allow-list; attention = product path; critical = system down. */
  severity: "noise" | "attention" | "critical";
}

export interface MonitoringView {
  level: StatusLevel;
  headline: string;
  subline: string;
  checks: StatusCheck[];
  failures: ExplainedFailure[];
}

function isAllowListDetail(detail: string): boolean {
  const blob = detail.toLowerCase();
  return (
    blob.includes("131030") ||
    blob.includes("not in allowed list") ||
    blob.includes("recipient phone number not in")
  );
}

/** Status-board signals only — history list can still show older rows. */
function isFreshFailure(
  at: string,
  lookbackMs: number,
  nowMs = Date.now(),
): boolean {
  const t = new Date(at).getTime();
  if (Number.isNaN(t) || lookbackMs <= 0) {
    return false;
  }
  return nowMs - t <= lookbackMs;
}

function explainFailure(row: {
  at: string;
  step: string;
  detail: string;
  alertKey?: string;
}): ExplainedFailure {
  const step = row.step.toLowerCase();
  const detail = row.detail.toLowerCase();
  const key = (row.alertKey ?? "").toLowerCase();

  if (key === "llm_credits" || detail.includes("429") || detail.includes("credit")) {
    return {
      ...row,
      severity: "attention",
      title: "Lucy / OpenAI — billing or rate limit",
      meaning:
        "Chat may fail until the OpenAI account has credit / spend limit raised, or the rate limit cools down.",
    };
  }
  if (isAllowListDetail(row.detail)) {
    return {
      ...row,
      severity: "noise",
      title: "WhatsApp — one number not on Meta allow-list",
      meaning:
        "Not a full outage. Meta rejected one recipient (often an OPS_ALERT phone or test number). Product can still work for allowed numbers.",
    };
  }
  if (detail.includes("another process is currently operating")) {
    return {
      ...row,
      severity: "noise",
      title: "Chat — temporary conversation lock",
      meaning:
        "Two requests hit the same OpenAI conversation at once (often during a restart). Usually self-heals on retry.",
    };
  }
  if (
    step.includes("system_db") ||
    step.includes("system_down") ||
    key === "system_critical"
  ) {
    return {
      ...row,
      severity: "critical",
      title: "System — database / core down",
      meaning: "Login and chat cannot work until Postgres is reachable again.",
    };
  }
  if (step.includes("typing")) {
    return {
      ...row,
      severity: "noise",
      title: "WhatsApp — typing indicator failed",
      meaning: "Usually harmless; the reply can still send.",
    };
  }
  if (step.includes("send") || key === "whatsapp_send") {
    return {
      ...row,
      severity: "attention",
      title: "WhatsApp — message send failed",
      meaning:
        "A user-facing or channel send failed (not just allow-list). Check token, session, and Meta detail.",
    };
  }
  if (step.includes("chat") || step.includes("reply") || key === "chat_llm") {
    const generic =
      !row.detail ||
      /service temporarily unavailable|service_unavailable/i.test(row.detail);
    return {
      ...row,
      severity: "attention",
      title: "Chat — Lucy turn failed",
      meaning: generic
        ? "A chat/WhatsApp reply path failed, but this older event only stored the generic 503 text. Newer failures keep the real OpenAI/Meta root cause in Cause (log)."
        : "A chat/WhatsApp reply path failed. Cause (log) is the root error that was recorded.",
    };
  }
  return {
    ...row,
    severity: "attention",
    title: `Issue — ${row.step}`,
    meaning: row.detail || "See technical detail below.",
  };
}

function badgeFor(id: string, state: "ok" | "warn" | "bad"): string {
  if (state === "ok") {
    return "OK";
  }
  if (state === "warn") {
    return "Check";
  }
  if (id === "db") {
    return "Down";
  }
  return "Fail";
}

export function buildMonitoringView(
  monitoring: AdminMonitoringResponse,
  nowMs = Date.now(),
): MonitoringView {
  const failures = monitoring.recentFailures.map(explainFailure);
  const lookbackMinutes = Math.max(
    1,
    monitoring.statusLookbackMinutes ?? 60,
  );
  const lookbackMs = lookbackMinutes * 60 * 1000;
  const hour = monitoring.failuresLastHour;
  const { health } = monitoring;

  const freshFailures = failures.filter((row) =>
    isFreshFailure(row.at, lookbackMs, nowMs),
  );
  const criticalFailures = freshFailures.filter(
    (row) => row.severity === "critical",
  );
  const attentionFailures = freshFailures.filter(
    (row) => row.severity === "attention",
  );
  const noiseFailures = freshFailures.filter((row) => row.severity === "noise");
  const materialInList = criticalFailures.length + attentionFailures.length;
  const noiseOnly =
    freshFailures.length > 0 &&
    materialInList === 0 &&
    noiseFailures.length > 0;

  const creditIssue = attentionFailures.some(
    (row) =>
      row.alertKey === "llm_credits" || /429|credit/i.test(row.detail),
  );
  const allowListIssue = noiseFailures.some((row) =>
    isAllowListDetail(row.detail),
  );

  // Recent window: never "Down" for allow-list / typing noise alone.
  let recentState: "ok" | "warn" | "bad" = "ok";
  let recentMeaning = `No recorded failures in the last ${lookbackMinutes} min.`;
  if (hour > 0) {
    if (noiseOnly || (materialInList === 0 && allowListIssue)) {
      recentState = "warn";
      recentMeaning = `${hour} logged event${hour === 1 ? "" : "s"} — mostly allow-list / minor noise, not a system outage.`;
    } else if (criticalFailures.length > 0) {
      recentState = "bad";
      recentMeaning = `${hour} failure${hour === 1 ? "" : "s"} including system-down — see below.`;
    } else if (attentionFailures.length >= 3 || hour >= 8) {
      recentState = "bad";
      recentMeaning = `${hour} failure${hour === 1 ? "" : "s"} with real chat/WhatsApp path issues — see below.`;
    } else {
      recentState = "warn";
      recentMeaning = `${hour} failure${hour === 1 ? "" : "s"} logged — categorized below (not necessarily an outage).`;
    }
  }

  const checks: StatusCheck[] = [
    {
      id: "db",
      label: "API + database",
      state: health.db ? "ok" : "bad",
      badge: badgeFor("db", health.db ? "ok" : "bad"),
      meaning: health.db
        ? "Postgres answers — core API can run."
        : "Database unreachable — login/chat will fail.",
    },
    {
      id: "openai",
      label: "Lucy / OpenAI key",
      state: !health.openaiConfigured
        ? "bad"
        : creditIssue
          ? "warn"
          : "ok",
      badge: badgeFor(
        "openai",
        !health.openaiConfigured ? "bad" : creditIssue ? "warn" : "ok",
      ),
      meaning: !health.openaiConfigured
        ? "OPENAI_API_KEY missing in .env — chat cannot run."
        : creditIssue
          ? "Key is set, but recent failures look like credits / rate limits."
          : "Key is configured (not a live OpenAI ping).",
    },
    {
      id: "whatsapp",
      label: "WhatsApp channel",
      state: !health.whatsappConfigured
        ? "warn"
        : allowListIssue
          ? "warn"
          : "ok",
      badge: badgeFor(
        "whatsapp",
        !health.whatsappConfigured || allowListIssue ? "warn" : "ok",
      ),
      meaning: !health.whatsappConfigured
        ? "WhatsApp token missing — channel inactive."
        : allowListIssue
          ? "Token set. Some numbers hit Meta allow-list (config noise — not full channel down)."
          : "Token configured (channel can send when Meta allows).",
    },
    {
      id: "ops_alerts",
      label: "Ops WhatsApp alerts",
      state:
        monitoring.health.opsAlertMode === "off" ||
        !monitoring.health.opsAlertMode
          ? "ok"
          : monitoring.health.opsAlertConfigured
            ? "ok"
            : "warn",
      badge: badgeFor(
        "ops_alerts",
        monitoring.health.opsAlertMode === "off" ||
          !monitoring.health.opsAlertMode ||
          monitoring.health.opsAlertConfigured
          ? "ok"
          : "warn",
      ),
      meaning:
        monitoring.health.opsAlertMode === "off" ||
        !monitoring.health.opsAlertMode
          ? "OPS_ALERT_MODE=off — intentional; failures are logged only."
          : !monitoring.health.opsAlertConfigured
            ? "Mode is on but OPS_ALERT_PHONES is empty."
            : monitoring.health.opsAlertMode === "critical"
              ? "Phones set — WhatsApp only for system-down (e.g. DB)."
              : "Phones set — WhatsApp for alertable app failures.",
    },
    {
      id: "recent",
      label: `Last ${lookbackMinutes} min`,
      state: recentState,
      badge: badgeFor("recent", recentState),
      meaning: recentMeaning,
    },
  ];

  let level: StatusLevel = "healthy";
  if (!health.db || criticalFailures.length > 0) {
    level = "critical";
  } else if (
    !health.openaiConfigured ||
    creditIssue ||
    attentionFailures.length > 0
  ) {
    level = "attention";
  } else if (noiseOnly || allowListIssue) {
    // Config noise — soft attention, not "system down".
    level = "attention";
  } else if (!health.whatsappConfigured) {
    level = "attention";
  }

  const headline =
    level === "healthy"
      ? "System looks healthy"
      : level === "critical"
        ? "System is down or blocked"
        : noiseOnly || (allowListIssue && attentionFailures.length === 0)
          ? "Minor config issues only"
          : "System needs attention";

  const subline =
    level === "healthy"
      ? "Core pieces are up and nothing material failed recently."
      : !health.db || criticalFailures.length > 0
        ? "Fix the database / system-down first — everything else depends on it."
        : creditIssue
          ? "Priority: OpenAI credits / spend limit — Lucy chat will keep failing until fixed."
          : noiseOnly || (allowListIssue && attentionFailures.length === 0)
            ? "Allow-list / minor WhatsApp rejects — not a full outage. Fix the number in Meta or remove it from alert phones."
            : attentionFailures.length > 0
              ? "There were real chat/WhatsApp path failures — see categorized list below."
              : "Something is misconfigured — check the status board.";

  return { level, headline, subline, checks, failures };
}
