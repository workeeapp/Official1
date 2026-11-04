/**
 * Prompt contract — the model owns the reply. With no server-side text
 * correction, these two rules must live in the prompt (and are scored by
 * live evals — docs/qa/live-full-corpus.json and
 * tests/reply-contract.live-sendchat.eval-db.test.ts):
 *  1. responses speak only to the speaker (never a relay / report body).
 *  2. numbered lines: saved items only via show_dump; an index reply that
 *     answers the model's own numbered question never uses LAST_NUMBERED_DUMP.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const config = JSON.parse(
  readFileSync(resolve(root, "LLM.config.json"), "utf8"),
) as { systemMessage: string[] };
const prompt = config.systemMessage.join("\n");
const actionText = readFileSync(resolve(root, "LLM.action.json"), "utf8");
const corpus = JSON.parse(
  readFileSync(resolve(root, "docs/qa/live-full-corpus.json"), "utf8"),
) as { cases: Array<{ id: string }> };

describe("prompt reply contract", () => {
  it("responses are for the speaker only", () => {
    expect(prompt).toMatch(/RESPONSES ARE FOR THE SPEAKER ONLY/);
    expect(prompt).toMatch(/FORBIDDEN: a responses entry that IS the relay or report body/);
    expect(actionText).toMatch(/every entry speaks TO the speaker/);
  });

  it("numbered lines and index replies", () => {
    expect(prompt).toMatch(/NUMBERED LINES & INDEX REPLIES/);
    expect(prompt).toMatch(/not as a numbered list and not as prose/);
    expect(prompt).toMatch(/= show_dump=<kind> with lists=\[\]/);
    expect(prompt).toMatch(/ASK which of ≥2 candidate rows or lists, write them as numbered lines/);
    expect(prompt).toMatch(
      /numbered candidate question → that candidate .*FORBIDDEN dump_line \/ LAST_NUMBERED_DUMP/,
    );
    expect(actionText).toMatch(/FORBIDDEN when it answers your own numbered candidate question/);
  });

  it("both rules are covered by live evals", () => {
    const ids = corpus.cases.map((row) => row.id);
    expect(ids).toContain("full-relay-ack-to-speaker");
    const sendchat = readFileSync(
      resolve(root, "backend/tests/reply-contract.live-sendchat.eval-db.test.ts"),
      "utf8",
    );
    expect(sendchat).toMatch(/relay: responses confirm to the speaker/);
    expect(sendchat).toMatch(/removes line 2 of the engine dump/);
    expect(sendchat).toMatch(/never uses a stale dump/);
  });

});
