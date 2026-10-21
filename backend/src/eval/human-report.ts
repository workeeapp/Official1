/**
 * LIVE eval reports for humans + UI.
 *
 * Contract: buildEvalUiReport() is the source of truth (JSON). Markdown is a
 * thin English view of that object — Test Studio / frontend should consume JSON.
 */
import { writeFileSync } from "node:fs";
import type { LlmMetadata } from "@workee/shared";
import type { ModelEvalConstraint } from "./constraints.js";

export type EvalReportTrack = "LIVE_MODEL" | "LIVE_MODEL_MT" | "LIVE_FULL";

export interface EvalReportTurnInput {
  index: number;
  utterance: string;
  response: string;
  ok: boolean;
  failures?: string[];
  constraintFailures?: string[];
  stateFailures?: string[];
  metadata: LlmMetadata;
  /** LIVE_FULL: production apply ran this turn. */
  appliedViaProduction?: boolean;
  /** Optional compact state note after apply. */
  stateNote?: string;
  constraints?: ModelEvalConstraint[];
}

export interface EvalReportCaseInput {
  id: string;
  tag?: string;
  tags?: string[];
  description?: string;
  ok: boolean;
  failures: string[];
  /** Single-turn utterance or prejoined multi-turn. */
  scenarioUtterances?: string;
  turns: EvalReportTurnInput[];
}

export interface EvalReportSummaryInput {
  track: EvalReportTrack;
  suite: string;
  generatedAt?: string;
  promptSource?: string;
  productionApply: boolean;
  tagsFilter?: string[] | null;
  caseIdsFilter?: string[] | null;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  requiredPassRate: number;
  softOk: boolean;
  criticalOk: boolean;
  criticalFailed: string[];
  ok: boolean;
  cases: EvalReportCaseInput[];
}

/** UI-ready turn block (no raw metadata dump — use actionSummary + warnings). */
export interface EvalUiReportTurn {
  index: number;
  utterance: string;
  response: string;
  responsePreview: string;
  actionSummary: string;
  expectation: string;
  ok: boolean;
  failures: string[];
  warnings: string[];
  appliedViaProduction?: boolean;
  stateNote?: string;
}

export interface EvalUiReportCase {
  id: string;
  ok: boolean;
  verdict: "PASS" | "FAIL";
  tag?: string;
  tags: string[];
  description?: string;
  scenario: string;
  failures: string[];
  warningCount: number;
  turns: EvalUiReportTurn[];
}

/**
 * Stable JSON shape for UI / Test Studio.
 * version bumps when fields are renamed or semantics change.
 */
export interface EvalUiReport {
  version: 1;
  kind: "live-eval-ui-report";
  track: EvalReportTrack;
  suite: string;
  generatedAt: string;
  promptSource: string;
  productionApply: boolean;
  tagsFilter: string[] | null;
  caseIdsFilter: string[] | null;
  score: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    requiredPassRate: number;
  };
  gates: {
    softOk: boolean;
    criticalOk: boolean;
    criticalFailed: string[];
    suiteOk: boolean;
  };
  cases: EvalUiReportCase[];
}

function truncate(text: string, max = 120): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function itemLabel(item: Record<string, unknown>): string {
  for (const key of ["שם פריט", "שם מטלה", "שם", "item_id", "itemId", "id"]) {
    const raw = item[key];
    if (typeof raw === "string" && raw.trim()) {
      const s = raw.trim();
      return s.length > 24 ? `${s.slice(0, 22)}…` : s;
    }
  }
  return "?";
}

/** Compact ACTION line — only non-empty domains. */
export function summarizeAction(meta: LlmMetadata): string {
  const parts: string[] = [];
  for (const row of meta.lists ?? []) {
    const labels = (row.items ?? [])
      .map((item) => itemLabel(item as Record<string, unknown>))
      .join(",");
    const lt = row.listType ? `:${row.listType}` : "";
    parts.push(`lists.${row.action}${lt}[${labels || "—"}]`);
  }
  for (const row of meta.listOps ?? []) {
    parts.push(`list_ops.${row.action}${row.listId ? `(${row.listId})` : ""}`);
  }
  for (const row of meta.filing ?? []) {
    parts.push(
      `filing.${row.action}${row.filingId ? `(${row.filingId})` : ""}${row.itemName ? `[${row.itemName}]` : ""}`,
    );
  }
  for (const row of meta.reminders ?? []) {
    parts.push(
      `reminders.${row.action}${row.reminderId ? `(${row.reminderId})` : ""}${row.item ? `[${row.item}]` : ""}`,
    );
  }
  for (const row of meta.directory ?? []) {
    parts.push(
      `directory.${row.action}${row.contactId ? `(${row.contactId})` : ""}${row.name ? `[${row.name}]` : ""}`,
    );
  }
  for (const row of meta.messages ?? []) {
    const targets = (row.targets ?? []).join(",") || "—";
    const book = row.book ? "+book" : "";
    parts.push(`messages→${targets}${book}`);
  }
  if (meta.showDump) parts.push(`show_dump=${meta.showDump}`);
  if (meta.confirm) parts.push("confirm");
  if (meta.hold) parts.push("hold");
  return parts.length ? parts.join("; ") : "(no mutations)";
}

/** One-line English constraint summary for expectations. */
export function summarizeConstraints(
  constraints: ModelEvalConstraint[] | undefined,
): string {
  if (!constraints?.length) return "(no constraints)";
  const bits: string[] = [];
  for (const c of constraints) {
    switch (c.type) {
      case "mutations_empty_or_read_only":
        bits.push("no mutations");
        break;
      case "response_looks_like_ask":
        bits.push("ask");
        break;
      case "lists_remove_item_ids":
        bits.push(
          `remove ${c.listType ?? "list"} ids=[${c.itemIds.join(",")}]`,
        );
        break;
      case "lists_has_action":
        bits.push(
          `lists.${c.action}${c.listType ? `:${c.listType}` : ""}${c.itemTextIncludes ? `[~${c.itemTextIncludes}]` : ""}`,
        );
        break;
      case "list_ops_empty":
        bits.push("no list_ops");
        break;
      case "list_ops_delete_list_ids":
        bits.push(`delete_list[${c.listIds.join(",")}]`);
        break;
      case "filing_has_action":
        bits.push(`filing.${c.action}${c.filingId ? `(${c.filingId})` : ""}`);
        break;
      case "filing_empty":
        bits.push("no filing");
        break;
      case "directory_remove_contact_ids":
        bits.push(`directory.remove[${c.contactIds.join(",")}]`);
        break;
      case "directory_empty":
        bits.push("no directory");
        break;
      case "reminders_has_action":
        bits.push(
          `reminders.${c.action}${c.recurring ? "(recurring)" : ""}`,
        );
        break;
      case "reminders_remove_ids":
        bits.push(`reminders.remove[${c.reminderIds.join(",")}]`);
        break;
      case "no_invented_reminder_add":
        bits.push("no reminder add");
        break;
      case "show_dump":
        bits.push(`show_dump=${c.value}`);
        break;
      case "response_mentions_any":
        bits.push(`response~${c.needles.slice(0, 3).join("|")}`);
        break;
      case "response_forbids_any":
        bits.push(`forbid~${c.needles.slice(0, 3).join("|")}`);
        break;
      case "messages_has": {
        const bitsMsg = ["messages"];
        if (c.targetIncludes) bitsMsg.push(`→${c.targetIncludes}`);
        if (c.requireBook) bitsMsg.push("+book");
        if (c.textIncludes) bitsMsg.push(`~${c.textIncludes}`);
        bits.push(bitsMsg.join(""));
        break;
      }
      case "any":
        bits.push(`any(${summarizeConstraints(c.constraints)})`);
        break;
      case "lists_empty":
        bits.push("lists empty");
        break;
      default:
        bits.push(c.type);
    }
  }
  return bits.join(" + ");
}

/**
 * Soft ACTION-quality warnings (do not fail the case by themselves).
 * E.g. constraint expects shopping remove but model emitted listType=custom.
 */
export function collectActionWarnings(
  meta: LlmMetadata,
  constraints: ModelEvalConstraint[] | undefined,
  response?: string,
): string[] {
  const warnings: string[] = [];

  for (const c of constraints ?? []) {
    if (c.type === "lists_remove_item_ids" && c.listType) {
      const removes = (meta.lists ?? []).filter((r) => r.action === "remove");
      for (const row of removes) {
        if (row.listType && row.listType !== c.listType) {
          warnings.push(
            `listType=${row.listType} (expected ${c.listType} on lists.remove)`,
          );
        }
      }
    }
    if (c.type === "lists_has_action" && c.listType) {
      const rows = (meta.lists ?? []).filter((r) => r.action === c.action);
      for (const row of rows) {
        if (row.listType && row.listType !== c.listType) {
          warnings.push(
            `listType=${row.listType} (expected ${c.listType} on lists.${c.action})`,
          );
        }
      }
    }
  }

  if (typeof response === "string" && !response.trim()) {
    warnings.push("empty response");
  }
  if ((meta.lists?.length ?? 0) > 0) {
    const emptyItems = (meta.lists ?? []).filter(
      (r) => (r.items?.length ?? 0) === 0,
    );
    if (emptyItems.length > 0) {
      warnings.push("lists action with empty items[]");
    }
  }
  return [...new Set(warnings)];
}

function turnFailures(turn: EvalReportTurnInput): string[] {
  return [
    ...(turn.failures ?? []),
    ...(turn.constraintFailures ?? []),
    ...(turn.stateFailures ?? []),
  ];
}

/** Build the structured report UI / Test Studio should render. */
export function buildEvalUiReport(input: EvalReportSummaryInput): EvalUiReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const cases: EvalUiReportCase[] = input.cases.map((row) => {
    const scenario =
      row.scenarioUtterances ??
      row.turns.map((t) => t.utterance).join(" → ");
    const turns: EvalUiReportTurn[] = row.turns.map((turn) => {
      const warnings = collectActionWarnings(
        turn.metadata,
        turn.constraints,
        turn.response,
      );
      const failures = turnFailures(turn);
      return {
        index: turn.index,
        utterance: turn.utterance,
        response: turn.response,
        responsePreview: truncate(turn.response || "(empty)"),
        actionSummary: summarizeAction(turn.metadata),
        expectation: summarizeConstraints(turn.constraints),
        ok: turn.ok,
        failures,
        warnings,
        ...(input.productionApply
          ? {
              appliedViaProduction: Boolean(turn.appliedViaProduction),
              stateNote: turn.stateNote,
            }
          : {}),
      };
    });
    const warningCount = turns.reduce((n, t) => n + t.warnings.length, 0);
    return {
      id: row.id,
      ok: row.ok,
      verdict: row.ok ? "PASS" : "FAIL",
      tag: row.tag,
      tags: row.tags ?? [],
      description: row.description,
      scenario,
      failures: row.failures,
      warningCount,
      turns,
    };
  });

  return {
    version: 1,
    kind: "live-eval-ui-report",
    track: input.track,
    suite: input.suite,
    generatedAt,
    promptSource: input.promptSource ?? "(default)",
    productionApply: input.productionApply,
    tagsFilter: input.tagsFilter?.length ? input.tagsFilter : null,
    caseIdsFilter: input.caseIdsFilter?.length ? input.caseIdsFilter : null,
    score: {
      total: input.total,
      passed: input.passed,
      failed: input.failed,
      passRate: input.passRate,
      requiredPassRate: input.requiredPassRate,
    },
    gates: {
      softOk: input.softOk,
      criticalOk: input.criticalOk,
      criticalFailed: input.criticalFailed,
      suiteOk: input.ok,
    },
    cases,
  };
}

/** English markdown view of an EvalUiReport (for git review / chat paste). */
export function formatEvalUiReportMarkdown(report: EvalUiReport): string {
  const lines: string[] = [];
  lines.push(`# LIVE eval report — ${report.suite}`);
  lines.push("");
  lines.push(`- **Track:** ${report.track}`);
  lines.push(`- **Generated:** ${report.generatedAt}`);
  lines.push(`- **Prompt:** ${report.promptSource}`);
  lines.push(
    `- **Production apply:** ${report.productionApply ? "yes" : "no"}`,
  );
  if (report.tagsFilter?.length) {
    lines.push(`- **Tags filter:** ${report.tagsFilter.join(", ")}`);
  }
  if (report.caseIdsFilter?.length) {
    lines.push(`- **Case filter:** ${report.caseIdsFilter.join(", ")}`);
  }
  lines.push(
    `- **Score:** ${report.score.passed}/${report.score.total} passed (passRate=${report.score.passRate.toFixed(2)}, required=${report.score.requiredPassRate})`,
  );
  lines.push(
    `- **Gates:** softOk=${report.gates.softOk} criticalOk=${report.gates.criticalOk}${report.gates.criticalFailed.length ? ` failed=[${report.gates.criticalFailed.join(", ")}]` : ""}`,
  );
  lines.push(`- **Suite:** ${report.gates.suiteOk ? "PASS" : "FAIL"}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  report.cases.forEach((row, index) => {
    lines.push(`## ${index + 1}. ${row.verdict} \`${row.id}\``);
    if (row.tag) lines.push(`*tag:* ${row.tag}`);
    if (row.tags.length) lines.push(`*tags:* ${row.tags.join(", ")}`);
    lines.push("");
    lines.push("### Scenario");
    if (row.description) lines.push(row.description);
    lines.push(`\`${row.scenario}\``);
    lines.push("");
    lines.push("### Expectation");
    for (const turn of row.turns) {
      lines.push(`- **turn ${turn.index}:** ${turn.expectation}`);
    }
    lines.push("");
    lines.push("### Observed");
    for (const turn of row.turns) {
      lines.push(
        `- **turn ${turn.index}** \`${truncate(turn.utterance, 60)}\``,
      );
      lines.push(`  - response: ${turn.responsePreview}`);
      lines.push(`  - ACTION: ${turn.actionSummary}`);
      if (report.productionApply) {
        lines.push(
          `  - apply: ${turn.appliedViaProduction ? "yes" : "no"}${turn.stateNote ? ` — ${turn.stateNote}` : ""}`,
        );
      }
      if (turn.warnings.length) {
        lines.push(`  - warnings: ${turn.warnings.join("; ")}`);
      }
      if (turn.failures.length) {
        lines.push(`  - failures: ${turn.failures.join("; ")}`);
      }
    }
    lines.push("");
    lines.push("### Verdict");
    lines.push(
      row.ok
        ? "**PASS**"
        : `**FAIL** — ${row.failures.join("; ") || "see turn failures"}`,
    );
    if (row.warningCount > 0 && row.ok) {
      lines.push(`*Flags:* ${row.warningCount} warning(s) (soft; case still PASS)`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  });

  return lines.join("\n");
}

/** @deprecated Prefer buildEvalUiReport + formatEvalUiReportMarkdown. */
export function formatEvalHumanReport(input: EvalReportSummaryInput): string {
  return formatEvalUiReportMarkdown(buildEvalUiReport(input));
}

/**
 * Write UI JSON + English markdown next to a LIVE run.
 * `reportBasePath` is without extension, e.g. `docs/qa/phase-4-last-report`.
 */
export function writeEvalReportArtifacts(
  reportBasePath: string,
  input: EvalReportSummaryInput,
): EvalUiReport {
  const ui = buildEvalUiReport(input);
  writeFileSync(
    `${reportBasePath}.json`,
    `${JSON.stringify(ui, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(`${reportBasePath}.md`, formatEvalUiReportMarkdown(ui), "utf8");
  return ui;
}

/** Build per-case report inputs from LIVE_MODEL single-turn summary + corpus. */
export function casesFromModelEvalResults(
  results: Array<{
    id: string;
    tag: string;
    ok: boolean;
    failures: string[];
    utterance: string;
    response: string;
    metadata: LlmMetadata;
  }>,
  corpusById: Map<
    string,
    {
      description?: string;
      tags?: string[];
      constraints?: ModelEvalConstraint[];
    }
  >,
): EvalReportCaseInput[] {
  return results.map((row) => {
    const corpus = corpusById.get(row.id);
    return {
      id: row.id,
      tag: row.tag,
      tags: corpus?.tags,
      description: corpus?.description,
      ok: row.ok,
      failures: row.failures,
      scenarioUtterances: row.utterance,
      turns: [
        {
          index: 0,
          utterance: row.utterance,
          response: row.response,
          ok: row.ok,
          failures: row.failures,
          metadata: row.metadata,
          constraints: corpus?.constraints,
        },
      ],
    };
  });
}

/** Multi-turn LIVE_MODEL report cases. */
export function casesFromMultiTurnResults(
  results: Array<{
    id: string;
    tag: string;
    ok: boolean;
    failures: string[];
    turns: Array<{
      index: number;
      utterance: string;
      response: string;
      ok: boolean;
      failures: string[];
      metadata: LlmMetadata;
    }>;
  }>,
  corpusById: Map<
    string,
    {
      description?: string;
      tags?: string[];
      turns?: Array<{ utterance: string; constraints?: ModelEvalConstraint[] }>;
    }
  >,
): EvalReportCaseInput[] {
  return results.map((row) => {
    const corpus = corpusById.get(row.id);
    const turnsSpec = corpus?.turns ?? [];
    return {
      id: row.id,
      tag: row.tag,
      tags: corpus?.tags,
      description: corpus?.description,
      ok: row.ok,
      failures: row.failures,
      scenarioUtterances: row.turns.map((t) => t.utterance).join(" → "),
      turns: row.turns.map((t) => ({
        index: t.index,
        utterance: t.utterance,
        response: t.response,
        ok: t.ok,
        failures: t.failures,
        metadata: t.metadata,
        constraints: turnsSpec[t.index]?.constraints,
      })),
    };
  });
}

/** LIVE_FULL report cases (apply + optional state note). */
export function casesFromLiveFullResults(
  results: Array<{
    id: string;
    ok: boolean;
    failures: string[];
    turns: Array<{
      turnIndex: number;
      utterance: string;
      response: string;
      ok: boolean;
      constraintFailures: string[];
      stateFailures: string[];
      appliedViaProduction: boolean;
      metadata: LlmMetadata;
    }>;
  }>,
  corpusById: Map<
    string,
    {
      description?: string;
      tags?: string[];
      tag?: string;
      turns?: Array<{
        utterance: string;
        constraints?: ModelEvalConstraint[];
        stateAfter?: {
          factsInclude?: string[];
          itemIdsAbsent?: string[];
          contactNamesInclude?: string[];
          contactNamesExclude?: string[];
        };
      }>;
    }
  >,
): EvalReportCaseInput[] {
  return results.map((row) => {
    const corpus = corpusById.get(row.id);
    const turnsSpec = corpus?.turns ?? [];
    return {
      id: row.id,
      tag: typeof corpus?.tag === "string" ? corpus.tag : undefined,
      tags: corpus?.tags,
      description: corpus?.description,
      ok: row.ok,
      failures: row.failures,
      scenarioUtterances: row.turns.map((t) => t.utterance).join(" → "),
      turns: row.turns.map((t) => {
        const spec = turnsSpec[t.turnIndex];
        const state = spec?.stateAfter;
        const stateBits: string[] = [];
        if (state?.itemIdsAbsent?.length) {
          stateBits.push(`absent=[${state.itemIdsAbsent.join(",")}]`);
        }
        if (state?.factsInclude?.length) {
          stateBits.push(`facts~${state.factsInclude.join("|")}`);
        }
        if (state?.contactNamesInclude?.length) {
          stateBits.push(
            `contacts~${state.contactNamesInclude.join("|")}`,
          );
        }
        if (state?.contactNamesExclude?.length) {
          stateBits.push(
            `contacts!~${state.contactNamesExclude.join("|")}`,
          );
        }
        return {
          index: t.turnIndex,
          utterance: t.utterance,
          response: t.response,
          ok: t.ok,
          constraintFailures: t.constraintFailures,
          stateFailures: t.stateFailures,
          metadata: t.metadata,
          appliedViaProduction: t.appliedViaProduction,
          stateNote: stateBits.length
            ? `${t.stateFailures.length ? "state FAIL" : "state ok"} (${stateBits.join("; ")})`
            : t.stateFailures.length
              ? `state FAIL: ${t.stateFailures.join("; ")}`
              : undefined,
          constraints: spec?.constraints,
        };
      }),
    };
  });
}
