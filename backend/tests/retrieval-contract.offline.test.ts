/**
 * Offline prompt contract: intent→ACTION + same-kind semantic retrieval (path 2).
 * Model selects ids; engine renders via show_dump + show_dump_ids.
 * No engine NLP / multi-domain dump / next-occurrence computation implied.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "..");
const config = readFileSync(resolve(root, "LLM.config.json"), "utf8");
const chat = readFileSync(
  resolve(process.cwd(), "src/services/chat.service.ts"),
  "utf8",
);

describe("RETRIEVAL CONTRACT semantic path 2 (prompt-only)", () => {
  it("LLM.config.json defines generic same-kind semantic outcomes", () => {
    expect(config).toContain("RETRIEVAL CONTRACT (four paths");
    expect(config).toMatch(
      /\(2\) SAME-KIND SEMANTIC \/ focused[\s\S]*?ONE supported dump domain/,
    );
    expect(config).toMatch(
      /\(2\) SAME-KIND SEMANTIC[\s\S]*?show_dump=<kind> \+ show_dump_ids=\[all matching ids\]/,
    );
    expect(config).toMatch(
      /\(2\) SAME-KIND SEMANTIC[\s\S]*?FORBIDDEN parallel prose inventory/,
    );
    expect(config).toMatch(/Multiple clear matches are NOT ambiguity/);
    expect(config).toMatch(
      /\(2\) SAME-KIND SEMANTIC[\s\S]*?No matches: no dump/,
    );
    expect(config).toMatch(
      /Material ambiguity \(unclear meaning\/selection criteria/,
    );
    expect(config).toMatch(/Never invent or cross-kind ids/);
    expect(config).not.toMatch(
      /show_dump_ids \(required\) OR answer in responses naming only those existing rows/,
    );
  });

  it("general INTENT→ACTION forbids prose substitute for structured retrieve/display", () => {
    expect(config).toMatch(
      /INTENT→ACTION:[\s\S]*?FORBIDDEN substituting factual conversational prose/,
    );
    expect(config).toMatch(
      /focused single-record lookup/,
    );
    expect(config).toMatch(
      /Wanting «next\/nearest» among same-kind rows is still dump\+ids/,
    );
    expect(config).toMatch(
      /FORBIDDEN inventing a next fire time in responses when the dump path exists/,
    );
    expect(config).toMatch(
      /B-DISPLAY:[\s\S]*?focused single-record \/ temporal-among-visible/,
    );
    expect(config).toMatch(
      /Do NOT route explanation \/ analysis \/ general-knowledge asks into show_dump/,
    );
  });

  it("path 2 covers broad, focused single-record, temporal/person by intent", () => {
    expect(config).toMatch(
      /\(2\) SAME-KIND SEMANTIC \/ focused — by intent \(broad list, focused single-record lookup/,
    );
    expect(config).toMatch(
      /that id pick IS this path \(not a reason for prose\)/,
    );
    expect(config).toMatch(
      /does NOT rewrite the dump with a computed next fire/,
    );
    expect(config).toMatch(
      /inventing a concrete next occurrence in responses/,
    );
    expect(config).toMatch(
      /even when you could name the answer in one sentence/,
    );
    expect(config).toMatch(
      /never claim[\s\S]*?engine resolved recurrence-next if the dump does not show it/,
    );
  });

  it("LLM.config.json keeps cross-kind on prose path without multi-domain dump", () => {
    expect(config).toMatch(
      /\(3\) CROSS-KIND SEMANTIC[\s\S]*?There is NO multi-domain dump/,
    );
    expect(config).toMatch(
      /Cross-kind topic → path \(3\) prose — there is NO multi-domain dump/,
    );
  });

  it("create/update paths remain distinct from retrieval", () => {
    expect(config).toContain("B-IMPLICIT-SAVE:");
    expect(config).toMatch(
      /Practical intention without explicit save request[\s\S]*?lists\.add now/,
    );
    expect(config).toContain("B-CORRECT:");
  });

  it("unsupported / honesty markers remain", () => {
    expect(config).toContain("B-UNSUPPORTED →");
    expect(config).toMatch(/Never invent unsupported capabilities/);
  });

  it("meetings example requires tasks dump + show_dump_ids", () => {
    expect(config).toMatch(
      /show_dump=tasks \+ show_dump_ids/,
    );
  });

  it("chat.service Lucy runtime carries the same contract", () => {
    expect(chat).toContain("RETRIEVAL CONTRACT (runtime):");
    expect(chat).toContain("INTENT->ACTION:");
    expect(chat).toContain(
      "FORBIDDEN easy factual prose when dump+ids exists (incl. focused single-record / next-nearest among visible)",
    );
    expect(chat).toContain("FORBIDDEN inventing next fire in responses");
    expect(chat).toContain(
      "prose OK for explanation/analysis/general knowledge/clarify",
    );
    expect(chat).toContain(
      "SAME-KIND SEMANTIC / focused by intent (broad, single-record, semantic, person, temporal among visible rows)",
    );
    expect(chat).toContain(
      "engine does NOT infer categories or rewrite dump with computed next fire",
    );
    expect(chat).toContain(
      "that pick IS dump path, not prose",
    );
    expect(chat).toContain("FORBIDDEN parallel prose inventory");
    expect(chat).toContain("multiple clear matches are NOT ambiguity");
    expect(chat).toContain(
      "single focused/temporal hit -> dump that one id even if one-sentence prose seems enough",
    );
    expect(chat).toContain("no matches -> no dump + short no-match");
    expect(chat).toContain("NO multi-domain dump");
    expect(chat).toContain(
      "meetings/appointments example -> show_dump=tasks + show_dump_ids",
    );
    expect(chat).not.toContain(
      "ids required or responses without bare dump",
    );
    expect(chat).not.toContain(
      "show_dump_ids required or responses with show_dump=null",
    );
  });
});
