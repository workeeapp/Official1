/**
 * Eval-only raw pre-parse ACTION diagnostic (no DB / no LIVE).
 */
import { describe, expect, it } from "vitest";
import { parseReplyMetadata } from "@workee/shared";
import { extractEvalRawActionDiagnostic } from "../src/eval/raw-action-diagnostic.js";
import type { ModelApplyProposeResult } from "../src/eval/run-model-apply.js";

describe("extractEvalRawActionDiagnostic", () => {
  it("retains raw filing-like lists even when parse yields empty ACTION", () => {
    // Model used Hebrew «שם» — toFilingAction only accepts item_name|שם הפריט|name.
    const reply = JSON.stringify({
      responses: [{ text: "תייקתי את הכתובת" }],
      metadata: {
        lists: [
          {
            action: "add",
            list_type: "filing",
            list_name: "",
            targets: [],
            items: [{ שם: "כתובת", תיאור: "רחוב הרצל 1 תל אביב" }],
          },
        ],
      },
    });

    const raw = extractEvalRawActionDiagnostic(reply);
    expect(raw.listEntryCount).toBe(1);
    expect(raw.filingLikeListEntryCount).toBe(1);
    expect(Array.isArray(raw.lists)).toBe(true);
    expect(raw.lists).toHaveLength(1);

    const parsed = parseReplyMetadata(reply);
    expect(parsed.filing ?? []).toEqual([]);
    expect(parsed.lists ?? []).toEqual([]);

    // Harness propose shape: post-parse metadata empty, raw diagnostic retained.
    const proposed: ModelApplyProposeResult = {
      metadata: parsed,
      response: "תייקתי את הכתובת",
      rawActionDiagnostic: raw,
    };
    expect(proposed.rawActionDiagnostic?.filingLikeListEntryCount).toBe(1);
    expect(proposed.rawActionDiagnostic?.lists?.[0]).toMatchObject({
      list_type: "filing",
      action: "add",
    });
    expect(parseReplyMetadata(JSON.stringify({ metadata: proposed.metadata })).filing).toEqual(
      [],
    );
  });

  it("reports zero filing-like when model truly emitted no filing row", () => {
    const reply = JSON.stringify({
      responses: [{ text: "מה הכתובת?" }],
      metadata: { lists: [] },
    });
    const raw = extractEvalRawActionDiagnostic(reply);
    expect(raw.listEntryCount).toBe(0);
    expect(raw.filingLikeListEntryCount).toBe(0);
    expect(raw.lists).toEqual([]);
  });
});
