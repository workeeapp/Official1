/**
 * Product Contract v2 — Phase 1 golden regression (prompts only).
 * Pins FOUR INTENTIONS, remind-other = clock-only, thin vs thick Jobs,
 * delivery-failure notice rules. No engine rewrites; no Prisma / OpenAI.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDefaultEvalFixtures } from "../src/eval/eval-prompt-source.js";
import { buildLucyInstructions } from "../src/services/chat.service.js";

const root = resolve(import.meta.dirname, "../..");
const configText = readFileSync(resolve(root, "LLM.config.json"), "utf8");
const chatSource = readFileSync(
  resolve(root, "backend/src/services/chat.service.ts"),
  "utf8",
);

const { employees, worker } = buildDefaultEvalFixtures("טל", {
  includeMichal: false,
});
const instructions = buildLucyInstructions({
  digital: worker,
  employees,
  speaker: "טל",
  speakerIsOwner: true,
  guestSpeaker: false,
  pendingInvite: null,
  consultFrom: "",
});

describe("Product Contract Phase 1 — four intentions", () => {
  it("LLM.config names Message / Assign / Reminder / Nudge as distinct intentions", () => {
    expect(configText).toMatch(/FOUR INTENTIONS \(Product Contract/);
    expect(configText).toMatch(/Message — deliver words/);
    expect(configText).toMatch(/Assign — put work on someone’s book/);
    expect(configText).toMatch(/Reminder — timed notify/);
    expect(configText).toMatch(/Nudge \/ check-with — wait for a human outcome/);
  });

  it("Assign does not auto Message / Reminder / Job / להזכיר", () => {
    expect(configText).toMatch(
      /FORBIDDEN auto Message \/ auto Reminder \/ Job \/ להזכיר/,
    );
  });
});

describe("Product Contract Phase 1 — remind someone else = clock only", () => {
  it("LLM.config: remind-other is Reminder clock ONLY; no default assign / Job / להזכיר", () => {
    expect(configText).toMatch(/REMIND SOMEONE ELSE/);
    expect(configText).toMatch(/Reminder clock ONLY \(Product Contract\)/);
    expect(configText).toMatch(/FORBIDDEN by default: lists\.add tasks targets:\[X\]/);
    expect(configText).toMatch(
      /FORBIDDEN YOUR להזכיר ל־X worker tracking for this path/,
    );
    expect(configText).toMatch(
      /FORBIDDEN messages expects_reply \/ OPEN_JOB/,
    );
    expect(configText).toMatch(
      /FORBIDDEN inventing a Job instead/,
    );
    expect(configText).toMatch(
      /FORBIDDEN recurring asker status updates on a recurring clock/,
    );
  });

  it("runtime instructions match clock-only remind-other (not assign+nudge)", () => {
    expect(instructions).toMatch(/Remind someone ELSE/);
    expect(instructions).toMatch(/Reminder clock ONLY \(Product Contract\)/);
    expect(instructions).toMatch(
      /FORBIDDEN by default: lists\.add tasks targets:\[X\]/,
    );
    expect(instructions).toMatch(
      /FORBIDDEN YOUR להזכיר ל־X worker tracking for this path/,
    );
    expect(instructions).not.toMatch(
      /Remind someone ELSE in Known employees \(תזכירי\/י למישהו\): LINK only = NEW lists\.add tasks targets:\[name\] with items\[\]\.remind/,
    );
  });

  it("assign+remind remains allowed only when they also asked to put a task on X", () => {
    expect(configText).toMatch(
      /Assign\+remind ONLY when they ALSO asked to put a task on X/,
    );
    expect(instructions).toMatch(
      /Assign\+remind ONLY when they ALSO asked to put a task on X/,
    );
  });
});

describe("Product Contract Phase 1 — thin vs thick Jobs", () => {
  it("LLM.config: THIN stays open without chase / expiry; THICK may promise ואזכיר", () => {
    expect(configText).toMatch(/UNTIL-DONE \/ CHECK-WITH \/ REPLY-RELAY/);
    expect(configText).toMatch(/THIN reply-relay/);
    expect(configText).toMatch(/THICK managed follow-up/);
    expect(configText).toMatch(
      /Job stays open until answer, close, or explicit cancel/,
    );
    expect(configText).toMatch(
      /FORBIDDEN promising «ואזכיר לו שוב» \/ periodic asker updates \/ inventing expiry/,
    );
    expect(configText).toMatch(
      /Asker confirm may say «ואזכיר לו שוב אם לא יענה» ONLY for urgent\|very_urgent/,
    );
    expect(configText).toMatch(
      /Timed «תזכירי ל־X ב־T» = REMIND SOMEONE ELSE \(clock\), NOT this Job path/,
    );
  });

  it("OPEN_JOBS URGENCY_RULE: normal has no auto follow-ups; chase promise only for urgent", () => {
    expect(instructions).toMatch(
      /normal \(THIN Job\) → none — Job stays open until answer, close, or explicit cancel/,
    );
    expect(instructions).toMatch(
      /For urgent\|very_urgent ONLY you MAY add «ואזכיר לו שוב אם לא יענה»/,
    );
    expect(instructions).toMatch(
      /For normal\/THIN: confirm send\/quote only — FORBIDDEN that chase promise/,
    );
    expect(instructions).toMatch(
      /THIN \(reply-relay, urgency normal, no chase verbs\) vs THICK/,
    );
  });
});

describe("Product Contract Phase 1 — delivery failure", () => {
  it("failure notice only on reliable failure; no double-send retry", () => {
    expect(configText).toMatch(/REMINDER DELIVERY FAILURE \(Product Contract\)/);
    expect(configText).toMatch(/reliable delivery failure/);
    expect(configText).toMatch(/If delivery status is unknown, stay silent/);
    expect(configText).toMatch(
      /FORBIDDEN emitting a second Reminder\/Message retry that could double-send/,
    );
  });
});

describe("Product Contract Phase 1 — preserved paths (self / assign / thick)", () => {
  it("Self-nudge LINK CONTRACT and worker tracking remain in runtime", () => {
    expect(instructions).toMatch(/Self-nudge \(תזכירי\/י לי/);
    expect(instructions).toMatch(/LINK CONTRACT only/);
    expect(instructions).toMatch(
      /PRODUCT WORKER TRACKING \(optional for join; still emit when they asked YOU to remind\)/,
    );
    expect(configText).toMatch(/LINK CONTRACT \(user shopping\/tasks ↔ clock\)/);
    expect(configText).toMatch(/not required for the join/);
  });

  it("Assign example and meeting book path remain intact", () => {
    expect(instructions).toContain(
      'Example: "מיכל צריכה לעשות טסט לרכב" → tasks add, targets: ["מיכל"]',
    );
    expect(instructions).toContain("BOOK A MEETING when the job's ask");
    expect(instructions).toContain(
      "RAISING (mandatory when raisable=true and viewer_is=subject)",
    );
  });

  it("chat.service source still carries Self-nudge and thick urgency policy hooks", () => {
    expect(chatSource).toMatch(/Self-nudge \(תזכירי\/י לי/);
    expect(chatSource).toMatch(/JOB_URGENCY_POLICY/);
    expect(chatSource).toMatch(/autoNudges/);
  });
});
