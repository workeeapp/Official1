import type { AdminCiStatusResponse } from "@workee/shared";

export type CiLevel = "healthy" | "attention" | "critical" | "idle";

export interface CiCheck {
  id: string;
  label: string;
  state: "ok" | "warn" | "bad" | "idle";
  badge: string;
  meaning: string;
  htmlUrl?: string;
}

export interface CiView {
  level: CiLevel;
  headline: string;
  subline: string;
  checks: CiCheck[];
}

function conclusionState(
  status: string,
  conclusion: string | null,
): "ok" | "warn" | "bad" | "idle" {
  const s = status.toLowerCase();
  const c = (conclusion ?? "").toLowerCase();
  if (s === "in_progress" || s === "queued" || s === "waiting" || s === "requested") {
    return "warn";
  }
  if (c === "success") {
    return "ok";
  }
  if (c === "failure" || c === "timed_out" || c === "startup_failure") {
    return "bad";
  }
  if (c === "cancelled" || c === "skipped" || c === "neutral" || c === "action_required") {
    return "warn";
  }
  if (s === "unknown" || (!conclusion && s === "completed")) {
    return "idle";
  }
  return "idle";
}

function badgeFor(state: "ok" | "warn" | "bad" | "idle"): string {
  if (state === "ok") {
    return "Pass";
  }
  if (state === "bad") {
    return "Fail";
  }
  if (state === "warn") {
    return "Running";
  }
  return "—";
}

export function buildCiView(ci: AdminCiStatusResponse): CiView {
  if (!ci.configured) {
    return {
      level: "idle",
      headline: "CI status not configured",
      subline:
        "Set GITHUB_TOKEN (actions:read) in .env to show the latest Test workflow on main.",
      checks: [],
    };
  }

  if (ci.error && !ci.latest) {
    return {
      level: "attention",
      headline: "Could not load CI status",
      subline: ci.error,
      checks: [],
    };
  }

  const checks: CiCheck[] = ci.jobs.map((job) => {
    const state = conclusionState(job.status, job.conclusion);
    return {
      id: job.name,
      label: job.name,
      state,
      badge: badgeFor(state),
      meaning:
        state === "ok"
          ? "Latest job passed."
          : state === "bad"
            ? "Latest job failed — open the Actions run for logs."
            : state === "warn"
              ? "Job still running or was cancelled."
              : "No job result yet.",
      htmlUrl: job.htmlUrl || undefined,
    };
  });

  const bad = checks.filter((row) => row.state === "bad");
  const warn = checks.filter((row) => row.state === "warn");
  const runState = ci.latest
    ? conclusionState(ci.latest.status, ci.latest.conclusion)
    : "idle";

  let level: CiLevel = "healthy";
  let headline = "CI tests healthy";
  let subline = ci.latest
    ? `Latest Test on ${ci.branch} passed (${ci.latest.headSha.slice(0, 7)}).`
    : `No Test runs found on ${ci.branch} yet.`;

  if (!ci.latest) {
    level = "idle";
    headline = "No recent CI runs";
  } else if (runState === "bad" || bad.length > 0) {
    level = "critical";
    headline = "CI tests failing";
    subline =
      bad.length > 0
        ? `${bad.map((row) => row.label).join(", ")} failed on the latest run.`
        : `Latest Test on ${ci.branch} concluded ${ci.latest.conclusion ?? ci.latest.status}.`;
  } else if (runState === "warn" || warn.length > 0) {
    level = "attention";
    headline = "CI tests in progress";
    subline = `Test workflow on ${ci.branch} is still running or incomplete.`;
  }

  if (ci.error && ci.latest) {
    subline = `${subline} (${ci.error})`;
  }

  return { level, headline, subline, checks };
}
