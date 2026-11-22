/**
 * P0 — Run PI/FP corpus against current HighRiskActionGate.
 *
 * Proves Gate strip/allow only. Side-effect apply is NOT executed here.
 * Locks known desired↔observed mismatches (baseline empty after W2 F1/F2).
 *
 * PRODUCTION vs SYNTHETIC (see docs/product/lucy-high-risk-gate-p0-p1-status.md):
 * - Production WA/UI: bindAuthority=none → no clarifyBind; FP-2/FP-3 → Class V.
 * - This runner may inject a synthetic trusted_control bind for FP-2/FP-3 Gate-unit
 *   rows only. That is not production behavior and does not close those UX limits.
 * - PI-2 / PI-7 closed in W2 (envelope EIS + directory phone Gate).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PublicEmployee } from "@workee/shared";
import { applyHighRiskActionGate } from "../src/services/high-risk-action-gate.js";
import { tryCreateClarifyBind } from "../src/services/clarify-bind.service.js";
import {
  PI_FP_CORPUS_P0,
  type CorpusCase,
  type DesiredGate,
} from "./fixtures/pi-fp-corpus.p0.js";

const speaker: PublicEmployee = {
  id: "speaker-1",
  name: "טל",
  surname: "",
  nickname: "טל",
  email: null,
  phone: "972501111111",
  kind: "human",
  isGuest: false,
  isOwner: true,
};

type ObservedGate = DesiredGate | "n/a";

type CorpusRow = {
  id: string;
  family: CorpusCase["family"];
  title: string;
  evidenceKind: CorpusCase["evidenceKind"];
  sideEffectClass: CorpusCase["sideEffectClass"];
  desiredGate: DesiredGate;
  observedGate: ObservedGate;
  /** true when Gate unit ran and matched desired. */
  matchesDesired: boolean | null;
  strippedKinds: string[];
  verdict:
    | "PASS"
    | "FAIL_BYPASS"
    | "FAIL_FALSE_POSITIVE"
    | "CODE_INFER"
    | "CONTROL_REGRESSION";
  notes?: string;
};

/**
 * P0 baseline mismatches minus gaps closed by later phases.
 * P2a closed PI-8. W2 closed PI-2 (F1) and PI-7 (F2).
 * FP-2 / FP-3 Gate-unit rows use synthetic trusted_control bind
 * (not production free-text).
 */
const EXPECTED_MISMATCH_IDS = [] as const;

function observedFromDidStrip(didStrip: boolean): DesiredGate {
  return didStrip ? "strip" : "allow";
}

function verdictFor(row: {
  family: CorpusCase["family"];
  evidenceKind: CorpusCase["evidenceKind"];
  desiredGate: DesiredGate;
  observedGate: ObservedGate;
  matchesDesired: boolean | null;
}): CorpusRow["verdict"] {
  if (row.evidenceKind === "code_infer") {
    return "CODE_INFER";
  }
  if (row.matchesDesired) {
    return "PASS";
  }
  if (row.family === "CONTROL") {
    return "CONTROL_REGRESSION";
  }
  if (row.desiredGate === "strip" && row.observedGate === "allow") {
    return "FAIL_BYPASS";
  }
  if (row.desiredGate === "allow" && row.observedGate === "strip") {
    return "FAIL_FALSE_POSITIVE";
  }
  return "FAIL_BYPASS";
}

function runCase(c: CorpusCase): CorpusRow {
  if (c.evidenceKind === "code_infer") {
    return {
      id: c.id,
      family: c.family,
      title: c.title,
      evidenceKind: c.evidenceKind,
      sideEffectClass: c.sideEffectClass,
      desiredGate: c.desiredGate,
      observedGate: "n/a",
      matchesDesired: null,
      strippedKinds: [],
      verdict: "CODE_INFER",
      notes: c.notes,
    };
  }

  // FP-2 / FP-3: Gate allow path with synthetic trusted_control bind only.
  // Production WA/UI free-text stay bindAuthority=none (no bind created).
  // Does not claim EIS/awaiting are provenance.
  let clarifyBind = null as ReturnType<typeof tryCreateClarifyBind>;
  if (c.id === "FP-2") {
    clarifyBind = tryCreateClarifyBind({
      instructionText: "תזכירי למאיה להתקשר לרופא",
      proposal: { kind: "remind_when", targets: ["מאיה"], itemIds: [] },
      visibleItemIds: [],
      knownTargetNames: c.knownTargetNames,
      speaker,
      bindAuthority: "trusted_control",
    });
  } else if (c.id === "FP-3") {
    clarifyBind = tryCreateClarifyBind({
      instructionText: "תמחקי את שני הפריטים מהקניות",
      proposal: { kind: "delete_scope", targets: [], itemIds: ["a", "b"] },
      visibleItemIds: ["a", "b"],
      knownTargetNames: c.knownTargetNames,
      speaker,
      bindAuthority: "trusted_control",
    });
  }

  const result = applyHighRiskActionGate(c.metadata, {
    speaker,
    pOutMode: "signal",
    speakerText: c.speakerText,
    instructionText: c.speakerText,
    knownTargetNames: c.knownTargetNames,
    ...(clarifyBind ? { clarifyBind } : {}),
  });
  const observedGate = observedFromDidStrip(result.didStrip);
  const matchesDesired = observedGate === c.desiredGate;
  return {
    id: c.id,
    family: c.family,
    title: c.title,
    evidenceKind: c.evidenceKind,
    sideEffectClass: c.sideEffectClass,
    desiredGate: c.desiredGate,
    observedGate,
    matchesDesired,
    strippedKinds: result.stripped.map((s) => `${s.policy}:${s.kind}`),
    verdict: verdictFor({
      family: c.family,
      evidenceKind: c.evidenceKind,
      desiredGate: c.desiredGate,
      observedGate,
      matchesDesired,
    }),
    notes: c.notes,
  };
}

describe("P0 PI/FP corpus vs current Gate (signal)", () => {
  it("runs all cases, writes results, and locks known mismatches", () => {
    const rows = PI_FP_CORPUS_P0.map(runCase);

    const outDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "output",
    );
    mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "pi-fp-corpus.p0.results.json");
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          mode: "HIGH_RISK_P_OUT_MODE=signal (explicit in runner)",
          scope:
            "Gate strip/allow only — does not execute CORE apply or WhatsApp",
          rows,
        },
        null,
        2,
      ),
      "utf8",
    );

    const gateRows = rows.filter((r) => r.evidenceKind === "gate_unit");
    const mismatches = gateRows
      .filter((r) => r.matchesDesired === false)
      .map((r) => r.id)
      .sort();
    const passes = gateRows.filter((r) => r.matchesDesired === true).map((r) => r.id);
    const bypasses = gateRows
      .filter((r) => r.verdict === "FAIL_BYPASS")
      .map((r) => r.id);
    const falsePositives = gateRows
      .filter((r) => r.verdict === "FAIL_FALSE_POSITIVE")
      .map((r) => r.id);
    const regressions = gateRows
      .filter((r) => r.verdict === "CONTROL_REGRESSION")
      .map((r) => r.id);

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          resultsFile: outPath,
          pass: passes,
          failBypass: bypasses,
          failFalsePositive: falsePositives,
          codeInfer: rows
            .filter((r) => r.verdict === "CODE_INFER")
            .map((r) => r.id),
          lockedMismatches: EXPECTED_MISMATCH_IDS,
        },
        null,
        2,
      ),
    );

    expect(regressions, "control cases must keep matching desired").toEqual([]);
    expect(mismatches).toEqual([...EXPECTED_MISMATCH_IDS].sort());

    // Sanity: corpus still covers both families.
    expect(rows.some((r) => r.family === "PI")).toBe(true);
    expect(rows.some((r) => r.family === "FP")).toBe(true);
  });

  it("each gate_unit case is individually classified", () => {
    for (const c of PI_FP_CORPUS_P0.filter((x) => x.evidenceKind === "gate_unit")) {
      const row = runCase(c);
      expect(row.observedGate === "allow" || row.observedGate === "strip").toBe(
        true,
      );
      if (EXPECTED_MISMATCH_IDS.includes(c.id as (typeof EXPECTED_MISMATCH_IDS)[number])) {
        expect(row.matchesDesired).toBe(false);
      } else {
        expect(row.matchesDesired, `${c.id} ${c.title}`).toBe(true);
      }
    }
  });
});
