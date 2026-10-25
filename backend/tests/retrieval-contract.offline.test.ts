/**
 * Offline prompt contract: same-kind semantic retrieval (path 2).
 * Model selects ids; engine renders via show_dump + show_dump_ids.
 * No engine NLP / multi-domain dump implied.
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
    expect(config).toMatch(
      /Multiple clear matches are NOT ambiguity/,
    );
    expect(config).toMatch(
      /\(2\) SAME-KIND SEMANTIC[\s\S]*?No matches: no dump/,
    );
    expect(config).toMatch(
      /Material ambiguity \(unclear meaning\/selection criteria/,
    );
    expect(config).toMatch(/Never invent or cross-kind ids/);
    // Closed the old OR that allowed free inventory prose for clear matches.
    expect(config).not.toMatch(
      /show_dump_ids \(required\) OR answer in responses naming only those existing rows/,
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

  it("meetings example requires tasks dump + show_dump_ids", () => {
    expect(config).toMatch(
      /אילו פגישות יש לי[\s\S]*?show_dump=tasks \+ show_dump_ids/,
    );
  });

  it("chat.service Lucy runtime carries the same contract", () => {
    expect(chat).toContain("RETRIEVAL CONTRACT (runtime):");
    expect(chat).toContain(
      "SAME-KIND SEMANTIC / focused - meaning filter inside ONE supported dump domain",
    );
    expect(chat).toContain("FORBIDDEN parallel prose inventory");
    expect(chat).toContain("multiple clear matches are NOT ambiguity");
    expect(chat).toContain("no matches -> no dump + short no-match");
    expect(chat).toContain("NO multi-domain dump");
    expect(chat).toContain(
      "example meetings/appointments -> show_dump=tasks + show_dump_ids",
    );
    expect(chat).toContain(
      "RETRIEVAL CONTRACT path 2 (same-kind semantic: show_dump+show_dump_ids for all clear matches; no parallel prose inventory; no dump on no-match/ASK)",
    );
    expect(chat).not.toContain(
      "ids required or responses without bare dump",
    );
    expect(chat).not.toContain(
      "show_dump_ids required or responses with show_dump=null",
    );
  });
});
