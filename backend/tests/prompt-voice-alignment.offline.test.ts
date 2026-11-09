/**
 * Prompt alignment P2+P5+P6 guard (offline, no model / DB).
 *
 * P2 — conflicting conversational rules resolved in one place (VOICE): one
 *      warm touch per reply (empathy line, light cheer OR one emoji); list name
 *      in a save confirmation only when it adds clarity.
 * P5 — Hebrew examples show content / perspective / structure, not wording to
 *      copy; exact outbound quotes and button commands stay verbatim.
 * P6 — duplicates removed without losing a functional constraint: Stage G
 *      points to VOICE; per-viewer job phrasing lives only in the OPEN_JOBS header.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDefaultEvalFixtures } from "../src/eval/eval-prompt-source.js";
import { buildLucyInstructions } from "../src/services/chat.service.js";

const root = resolve(import.meta.dirname, "../..");
const speaker = "טל";
const { employees, worker } = buildDefaultEvalFixtures(speaker, { includeMichal: false });
const instructions = buildLucyInstructions({
  digital: worker,
  employees,
  speaker,
  speakerIsOwner: true,
  guestSpeaker: false,
  pendingInvite: null,
  consultFrom: "",
});
const jobsSource = readFileSync(resolve(root, "backend/src/services/jobs.service.ts"), "utf8");
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("P2: one rule for warmth, emoji and list names", () => {
  it("the old Stage G personality / emoji allowance is gone (it allowed a sentence AND an emoji)", () => {
    expect(instructions).not.toContain("at most one personality sentence");
    expect(instructions).not.toContain("0–1 contextual emoji");
  });

  it("VOICE keeps the single limit: at most one warm touch, none is fine", () => {
    expect(count(instructions, "At most one warm touch per reply")).toBe(1);
    expect(instructions).toContain("plain Hebrew with none is always fine");
    expect(instructions).toContain("tone, warmth and emoji follow VOICE");
  });

  it("a save confirmation names the item; the list only when it adds clarity", () => {
    expect(instructions).not.toContain("name the item + list");
    expect(instructions).toContain("name the item, and its list when that adds clarity (VOICE)");
  });

  it("functional display rules are kept: structured dump lines get no extra emoji; show_icon is a separate channel", () => {
    expect(instructions).toContain("do not decorate those structured lines with extra emoji");
    expect(instructions).toContain("Personality never replaces a needed question or false-claims success");
    expect(instructions).toContain("neither replaces nor forbids the one optional emoji VOICE allows");
  });
});

describe("P5: examples show content, not wording — exact parts stay exact", () => {
  it("VOICE states the general rule once and names what must stay verbatim", () => {
    expect(count(instructions, "Hebrew examples in these rules show content, perspective and structure")).toBe(1);
    expect(instructions).toContain("outbound quotes inside את ההודעה «…», button labels/commands");
  });

  it("the exact-outbound-quote requirement itself is unchanged", () => {
    expect(instructions).toContain("character-for-character inside את ההודעה «…»");
    expect(instructions).toContain("REQUIRED: include that exact text inside את ההודעה «…»");
  });

  it("OPEN_JOBS per-viewer examples are framed as perspective, not wording", () => {
    expect(jobsSource).toContain("the quoted examples show the perspective, not wording to copy");
  });
});

describe("P6: duplicates removed, constraints kept in one place", () => {
  it("per-viewer job phrasing is no longer duplicated in the static rules", () => {
    expect(instructions).not.toContain("viewer_is=subject (you are talking TO the person being asked)");
    expect(instructions).toContain("its header says how THIS speaker hears each job");
  });

  it("the OPEN_JOBS header still carries every per-viewer constraint", () => {
    expect(jobsSource).toContain("viewer_is=subject → this speaker owes the answer. Speak to them in second person and name the asker");
    expect(jobsSource).toContain("Self-job (asker===subject) → their own check in second person");
    expect(jobsSource).toContain("never «עמית ביקש ממני…», «<name> מחכה לתשובה», or first-person ask copy");
    expect(jobsSource).toContain("viewer_is=asker → this speaker is waiting for it. Third person about the subject");
    expect(jobsSource).toContain("Never say «לבדוק עם ערן» to ערן himself.");
  });
});
