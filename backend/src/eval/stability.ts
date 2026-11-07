/**
 * G7 — LIVE_FULL stability: the same cases run N times; per-case pass counts,
 * rates and a classification, so a one-off failure is never read as a
 * regression and a consistent failure is never dismissed as noise.
 */

export type StabilityClass = "stable-pass" | "intermittent" | "consistent-fail";

/** Minimal slice of a LIVE_FULL case result the aggregation needs. */
export interface StabilityRunCase {
  id: string;
  ok: boolean;
  failures: string[];
  turns: Array<{
    turnIndex: number;
    utterance: string;
    response?: string;
    ok: boolean;
    metadata?: unknown;
  }>;
}

export interface StabilitySample {
  run: number;
  ok: boolean;
  failures: string[];
  turns: Array<{
    turn: number;
    utterance: string;
    response: string;
    buttons: string[];
    bubbles: number | null;
  }>;
}

export interface StabilityCaseRow {
  id: string;
  runs: number;
  passed: number;
  failed: number;
  passRate: number;
  classification: StabilityClass;
  /** Failure text → how many runs hit it (a run may hit several). */
  failureReasons: Record<string, number>;
  /** Every run's transcript for non-stable cases (pass AND fail, to compare). */
  samples: StabilitySample[];
}

export interface StabilitySummary {
  runs: number;
  cases: number;
  totalExecutions: number;
  totalPassed: number;
  overallPassRate: number;
  counts: Record<StabilityClass, number>;
  rows: StabilityCaseRow[];
}

export function classifyStability(passed: number, runs: number): StabilityClass {
  if (runs > 0 && passed === runs) {
    return "stable-pass";
  }
  if (passed === 0) {
    return "consistent-fail";
  }
  return "intermittent";
}

function readButtons(metadata: unknown): string[] {
  const raw = (metadata as { evalButtons?: unknown } | null)?.evalButtons;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((b) => {
    const row = b as { label?: unknown; command?: unknown };
    return `${String(row.label ?? "")} → ${String(row.command ?? "")}`;
  });
}

function readBubbles(metadata: unknown): number | null {
  const n = (metadata as { evalBubbleCount?: unknown } | null)?.evalBubbleCount;
  return typeof n === "number" ? n : null;
}

/** Turn-prefix of a failure («turn 1 constraints: …») kept; dynamic values stay. */
export function normalizeFailureReason(failure: string): string {
  return failure.replace(/\s+/g, " ").trim();
}

export function aggregateStability(
  runs: StabilityRunCase[][],
): StabilitySummary {
  const order: string[] = [];
  const byId = new Map<string, StabilityRunCase[]>();
  runs.forEach((results) => {
    for (const row of results) {
      if (!byId.has(row.id)) {
        byId.set(row.id, []);
        order.push(row.id);
      }
      byId.get(row.id)!.push(row);
    }
  });

  const rows: StabilityCaseRow[] = order.map((id) => {
    const all = byId.get(id)!;
    const passed = all.filter((r) => r.ok).length;
    const classification = classifyStability(passed, all.length);
    const failureReasons: Record<string, number> = {};
    for (const r of all) {
      for (const reason of new Set(r.failures.map(normalizeFailureReason))) {
        failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
      }
    }
    const samples: StabilitySample[] =
      classification === "stable-pass"
        ? []
        : all.map((r, index) => ({
            run: index + 1,
            ok: r.ok,
            failures: r.failures,
            turns: r.turns.map((t) => ({
              turn: t.turnIndex,
              utterance: t.utterance,
              response: t.response ?? "",
              buttons: readButtons(t.metadata),
              bubbles: readBubbles(t.metadata),
            })),
          }));
    return {
      id,
      runs: all.length,
      passed,
      failed: all.length - passed,
      passRate: all.length === 0 ? 0 : passed / all.length,
      classification,
      failureReasons,
      samples,
    };
  });

  const counts: Record<StabilityClass, number> = {
    "stable-pass": 0,
    intermittent: 0,
    "consistent-fail": 0,
  };
  for (const row of rows) {
    counts[row.classification] += 1;
  }
  const totalExecutions = rows.reduce((sum, r) => sum + r.runs, 0);
  const totalPassed = rows.reduce((sum, r) => sum + r.passed, 0);
  return {
    runs: runs.length,
    cases: rows.length,
    totalExecutions,
    totalPassed,
    overallPassRate: totalExecutions === 0 ? 0 : totalPassed / totalExecutions,
    counts,
    rows,
  };
}

const CLASS_ORDER: StabilityClass[] = [
  "consistent-fail",
  "intermittent",
  "stable-pass",
];

export function formatStabilityMarkdown(
  summary: StabilitySummary,
  header: { generatedAt: string; filter: string; contextMode: string; executionScope?: string },
): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines: string[] = [
    "# LIVE_FULL stability report",
    "",
    `- **Generated:** ${header.generatedAt}`,
    `- **Filter:** ${header.filter}`,
    `- **Context mode:** ${header.contextMode}`,
    ...(header.executionScope ? [`- **Execution scope:** ${header.executionScope}`] : []),
    `- **Runs:** ${summary.runs} × ${summary.cases} cases = ${summary.totalExecutions} executions`,
    `- **Overall:** ${summary.totalPassed}/${summary.totalExecutions} (${pct(summary.overallPassRate)})`,
    `- **Classes:** consistent-fail ${summary.counts["consistent-fail"]} · intermittent ${summary.counts.intermittent} · stable-pass ${summary.counts["stable-pass"]}`,
    "",
    "| case | passed | rate | class |",
    "|---|---|---|---|",
  ];
  const sorted = [...summary.rows].sort(
    (a, b) =>
      CLASS_ORDER.indexOf(a.classification) -
        CLASS_ORDER.indexOf(b.classification) || a.passRate - b.passRate,
  );
  for (const row of sorted) {
    lines.push(
      `| \`${row.id}\` | ${row.passed}/${row.runs} | ${pct(row.passRate)} | ${row.classification} |`,
    );
  }
  for (const row of sorted.filter((r) => r.classification !== "stable-pass")) {
    lines.push("", `## ${row.id} — ${row.passed}/${row.runs} (${row.classification})`, "");
    for (const [reason, n] of Object.entries(row.failureReasons)) {
      lines.push(`- ${n}× ${reason}`);
    }
    for (const sample of row.samples) {
      lines.push("", `### run ${sample.run}: ${sample.ok ? "PASS" : "FAIL"}`);
      for (const t of sample.turns) {
        lines.push(`- turn ${t.turn} \`${t.utterance}\``);
        lines.push(`  - response: ${t.response.replace(/\n/g, " ⏎ ")}`);
        lines.push(
          `  - bubbles: ${t.bubbles ?? "?"} · buttons: ${t.buttons.length ? t.buttons.join(" | ") : "(none)"}`,
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
