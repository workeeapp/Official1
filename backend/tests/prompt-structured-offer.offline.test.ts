/**
 * STRUCTURED LIST OFFER — prompt contract + eval corpus coverage.
 * Behavior itself is scored by live evals (docs/qa/live-full-corpus.json,
 * tag "structured-offer"); this file locks the prompt invariants and keeps
 * the corpus well-formed offline.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyLlmMetadata } from "@workee/shared";
import {
  evaluateConstraints,
  type ModelEvalConstraint,
} from "../src/eval/constraints.js";
import { loadLiveFullCorpus } from "../src/eval/corpus.js";

const root = resolve(import.meta.dirname, "../..");
const config = JSON.parse(
  readFileSync(resolve(root, "LLM.config.json"), "utf8"),
) as { systemMessage: string[] };
const prompt = config.systemMessage.join("\n");

describe("STRUCTURED LIST OFFER prompt contract", () => {
  it("defines the section once with the authorization ladder", () => {
    expect(prompt.match(/^STRUCTURED LIST OFFER \(/gm)?.length).toBe(1);
    expect(prompt).toMatch(/mentioning information NEVER authorizes saving it/);
    expect(prompt).toMatch(/including news that changes a row of an existing list .* one short offer to update that row; lists=\[\] list_ops=\[\]; FORBIDDEN lists.update on that turn; the קניתי\/סיימתי Done rule is for shopping\/tasks only/);
    expect(prompt).toMatch(/A mention or aside that a row already changed .* is NOT that request — one short offer to update, lists=\[\] and list_ops=\[\]/);
    expect(prompt).toMatch(/authorizes ONE suggestion only — lists=\[\]/);
    expect(prompt).toMatch(/explicit approval .* authorizes creating it/);
    expect(prompt).toMatch(/explicit create \/ organize request skips the offer/);
  });

  it("covers one-time plans, flexible columns, sharing consent, sensitive data", () => {
    expect(prompt).toMatch(/one-time plan that involves several people/);
    expect(prompt).toMatch(/Emotion WITH a concrete, substantial, multi-step practical situation .* briefly acknowledge the feeling, then the optional offer/);
    expect(prompt).toMatch(/emotion alone, with no concrete practical need → empathy only, no offer/);
    expect(prompt).toMatch(/Not on emotion \/ venting \/ small talk \(B-CONVERSE\)/);
    expect(prompt).toMatch(/COLUMNS \(flexible — no fixed template\)/);
    expect(prompt).toMatch(/responsibility on a row is row DATA — not targets/);
    expect(prompt).toMatch(/consent to create ≠ consent to share/);
    expect(prompt).toMatch(/Names on a list do NOT by themselves imply sharing/);
    expect(prompt).toMatch(/offer sharing once, only in the confirmation of the turn that creates the list \(never before the list exists\)/);
    expect(prompt).toMatch(/Never bundle sharing consent with list-creation consent; never share without the speaker's explicit approval/);
    expect(prompt).toMatch(/SENSITIVE \(personal health.*mentioning it, even repeatedly, never earns an offer/);
    expect(prompt).toMatch(/Offer ONLY when the speaker raised the subject themselves AND expressed interest in organizing or tracking it/);
    expect(prompt).toMatch(/only on explicit consent .* FORBIDDEN saving any of it before that/);
    expect(prompt).toMatch(/Scope: ANY record of personal health information .* medication records \(drug names, prescribed dosages, schedules, dosage history\)/);
    expect(prompt).toMatch(/Not covered \(existing behavior unchanged\): a concrete practical action \(buy a medicine/);
    expect(prompt).not.toMatch(/health LOGS \/ trackers only/);
    expect(prompt).toMatch(/automated message, a later topic change or the speaker returning to the same subject does not reset a decline/);
    expect(prompt).toMatch(/FORBIDDEN saving illustration rows/);
    expect(prompt).toMatch(/never a markdown table/);
  });

  it("routes gatherings to COMPLEX EVENTS — no parallel mechanism", () => {
    expect(prompt).toMatch(/GATHERINGS → COMPLEX EVENTS only/);
    expect(prompt).toMatch(/FORBIDDEN a parallel standalone event list/);
    expect(prompt).toMatch(/link it on that row with linked_lists/);
  });

  it("keeps existing protections intact (clarified, not weakened)", () => {
    expect(prompt).toMatch(/SAVE IMMEDIATELY this turn \(B-IMPLICIT-SAVE\)/);
    // Emotional-conversation protection: Stage A (no save / suggestion) + BAR (emotion alone → no offer).
    expect(prompt).toMatch(/emotion without a concrete need for help → B-CONVERSE only; FORBIDDEN save or reminder suggestion this turn\./);
    expect(prompt).toMatch(/emotion alone, with no concrete practical need → empathy only, no offer/);
    expect(prompt).toMatch(/Implicit save never creates a NEW custom list or new columns/);
    expect(prompt).toMatch(/Scope: this ladder governs creating or updating structured lists; it does not override the existing FILING rule/);
    expect(prompt).toMatch(/health information stays under SENSITIVE below/);
    // Durable facts still file the same turn; an existing home is updated rather than always added.
    expect(prompt).toMatch(/Durable facts \(family, address form, address, job, …; health incl\. allergies \/ diet → SENSITIVE\) → file them the same turn when clearly stated \(update the one existing home, otherwise add\)/);
    expect(prompt).toMatch(/Do NOT open a custom list named as the event/);
    expect(prompt).toMatch(/Describing an existing or standing arrangement .* no implicit save and no assign; at most a STRUCTURED LIST OFFER/);
    expect(prompt).toMatch(/A concrete new need for a specific person .* is unchanged — ASSIGN as today/);
    // ASSIGN rule itself untouched.
    expect(prompt).toMatch(/• ASSIGN \(every item domain — shopping, tasks, custom items, filings, contacts\): «טל צריך לקנות חלב»/);
    expect(prompt).toMatch(/Do not treat consent to one action as consent to another/);
    expect(prompt).toMatch(/Never invent list_name from topic alone/);
  });
});

describe("mechanism choice + health (consolidated into existing rules)", () => {
  it("LIST TYPES defines each mechanism once and how to combine them", () => {
    expect(prompt).toMatch(/custom = information to keep, consult and update/);
    expect(prompt).toMatch(/Choose by intent; when a need spans several, keep each in its own mechanism/);
    expect(prompt).toMatch(/a task may link to a whole list — TASK LINKED LISTS, not only events/);
    expect(prompt).not.toMatch(/^CHOOSING THE MECHANISM/m);
  });

  it("row-level reminder is an example under the existing B-UNSUPPORTED", () => {
    expect(prompt).toMatch(/B-UNSUPPORTED → say so in Hebrew; offer a supported alternative if any; no fake success \(e\.g\. a reminder \/ recurrence \/ task link on a custom-list row/);
  });

  it("one health rule covers storage consent and advice", () => {
    expect(prompt.match(/^• SENSITIVE \(personal health/gm)?.length).toBe(1);
    expect(prompt).toMatch(/never decide or recommend starting, stopping or changing a prescribed treatment or dose/);
    expect(prompt).not.toMatch(/^HEALTH ADVICE:/m);
  });

  it("mention never updates an existing list — offer to add there", () => {
    expect(prompt).toMatch(/fitting list already exists in THIS turn's facts — then offer to add it THERE \(one short confirm; an explicit add request runs now\), never a new list/);
  });

  it("Stage 1 duplicates removed", () => {
    expect(prompt).not.toMatch(/^B-STRUCTURE-OFFER:/m);
    expect(prompt).not.toMatch(/every other rule stay unchanged/);
    expect(prompt).not.toMatch(/incl\. STRUCTURED LIST OFFER — emotion/);
    expect(prompt).toMatch(/Implicit save never creates a NEW custom list or new columns/);
  });
});

describe("mechanism eval corpus", () => {
  const corpus = loadLiveFullCorpus();
  const cases = corpus.cases.filter((c) =>
    (c as { tags?: string[] }).tags?.includes("mechanism"),
  );

  it("covers combine, link, unsupported, family, choice and medical advice", () => {
    const tags = new Set(cases.flatMap((c) => (c as { tags?: string[] }).tags ?? []));
    for (const t of ["combine", "link", "unsupported", "family", "choice", "medical-advice", "consent"]) {
      expect(tags.has(t), t).toBe(true);
    }
  });

  it("uses only known constraint types and seeded ids", () => {
    for (const c of cases) {
      const seeded = new Set<string>();
      for (const list of c.setup?.lists ?? []) {
        for (const item of list.items ?? []) {
          const id = (item as { item_id?: string }).item_id;
          if (id) seeded.add(id);
        }
      }
      for (const turn of c.turns) {
        const checked = evaluateConstraints(
          (turn.constraints ?? []) as ModelEvalConstraint[],
          emptyLlmMetadata(),
          "",
        );
        expect(checked.failures.filter((f) => f.startsWith("unknown constraint")), c.id).toEqual([]);
        for (const row of (turn.constraints ?? []) as Array<{ ids?: string[] }>) {
          for (const id of row.ids ?? []) expect(seeded.has(id), `${c.id}:${id}`).toBe(true);
        }
      }
    }
  });
});

describe("structured-crud corpus (G3) + persisted creation checks (G2)", () => {
  const all = loadLiveFullCorpus().cases;
  const crud = all.filter((c) => (c as { tags?: string[] }).tags?.includes("structured-crud"));

  it("covers update, mention≠update, remove, aggregate retrieval, add with responsible, column rename", () => {
    const tags = new Set(crud.flatMap((c) => (c as { tags?: string[] }).tags ?? []));
    for (const t of ["update", "negative", "remove", "retrieval", "add", "columns"]) {
      expect(tags.has(t), t).toBe(true);
    }
    for (const c of crud) {
      expect(c.turns.every((t) => t.stateAfter || (t.constraints ?? []).some((k) => k.type.startsWith("show_dump"))), c.id).toBe(true);
    }
  });

  it("uses only known constraints and seeded ids", () => {
    for (const c of crud) {
      const seeded = new Set<string>();
      for (const list of c.setup?.lists ?? []) {
        for (const item of list.items ?? []) {
          const id = (item as { item_id?: string }).item_id;
          if (id) seeded.add(id);
        }
      }
      for (const turn of c.turns) {
        const checked = evaluateConstraints((turn.constraints ?? []) as ModelEvalConstraint[], emptyLlmMetadata(), "");
        expect(checked.failures.filter((f) => f.startsWith("unknown constraint")), c.id).toEqual([]);
        const ids = [
          ...((turn.constraints ?? []) as Array<{ ids?: string[]; itemIds?: string[] }>).flatMap((k) => [...(k.ids ?? []), ...(k.itemIds ?? [])]),
          ...(turn.stateAfter?.itemIdsPresent ?? []),
          ...(turn.stateAfter?.itemIdsAbsent ?? []),
        ];
        for (const id of ids) expect(seeded.has(id), `${c.id}:${id}`).toBe(true);
      }
    }
  });

  it("creation scenarios verify persisted rows, not only the action", () => {
    for (const [id, turn] of [
      ["so-timetable-offer-then-create", 1],
      ["so-expenses-offer-then-create", 1],
      ["so-household-share-offer", 1],
      ["so-names-no-share", 0],
      ["so-explicit-create-direct", 0],
    ] as const) {
      const row = all.find((c) => c.id === id)!;
      expect(row.turns[turn]!.stateAfter?.factsInclude, id).toContain('"list_type":"custom"');
    }
  });
});

describe("continuity measurement corpus", () => {
  const cases = loadLiveFullCorpus().cases.filter((c) =>
    (c as { tags?: string[] }).tags?.includes("continuity"),
  );

  it("covers declined offer, open offer, not-saved info, automated messages — each with rotation", () => {
    const tags = new Set(cases.flatMap((c) => (c as { tags?: string[] }).tags ?? []));
    for (const t of ["declined", "open-offer", "not-saved", "automated", "reminder", "control"]) {
      expect(tags.has(t), t).toBe(true);
    }
    const rotated = cases.filter((c) => c.turns.some((t) => t.newConversationBefore));
    expect(rotated.length).toBeGreaterThanOrEqual(5);
    // rotation is meaningless on turn 0
    for (const c of cases) expect(c.turns[0]!.newConversationBefore, c.id).toBeFalsy();
  });

  it("is kept out of the default regression tags", () => {
    const script = readFileSync(
      resolve(import.meta.dirname, "../../scripts/run-regression.ps1"),
      "utf8",
    );
    expect(script).toMatch(/\[string\]\$Tags = "structured-offer,mechanism,filing-policy,structured-crud",/);
    expect(script).not.toMatch(/\$Tags = "[^"]*continuity/);
  });

  it("uses only known constraint types", () => {
    for (const c of cases) {
      for (const turn of c.turns) {
        const checked = evaluateConstraints(
          (turn.constraints ?? []) as ModelEvalConstraint[],
          emptyLlmMetadata(),
          "",
        );
        expect(checked.failures.filter((f) => f.startsWith("unknown constraint")), c.id).toEqual([]);
      }
    }
  });
});

describe("structured-offer eval corpus", () => {
  const corpus = loadLiveFullCorpus();
  const cases = corpus.cases.filter((c) =>
    (c as { tags?: string[] }).tags?.includes("structured-offer"),
  );

  it("generalizes across the required domains", () => {
    const tags = new Set(
      cases.flatMap((c) => (c as { tags?: string[] }).tags ?? []),
    );
    for (const domain of [
      "timetable",
      "exams",
      "health",
      "expenses",
      "travel",
      "household",
      "share",
      "event",
      "retrieval",
      "negative",
      "continuity",
      "multi-list",
      "quality",
      "sensitive",
      "medication",
      "standing-arrangement",
      "assign",
    ]) {
      expect(tags.has(domain), domain).toBe(true);
    }
  });

  it("uses only known constraint types", () => {
    for (const c of cases) {
      for (const turn of c.turns) {
        const checked = evaluateConstraints(
          (turn.constraints ?? []) as ModelEvalConstraint[],
          emptyLlmMetadata(),
          "",
        );
        const unknown = checked.failures.filter((f) =>
          f.startsWith("unknown constraint"),
        );
        expect(unknown, c.id).toEqual([]);
      }
    }
  });

  it("covers decline → automated message → return", () => {
    const withInject = cases.filter((c) =>
      c.turns.some((t) => Boolean(t.injectAssistantAfter?.trim())),
    );
    expect(withInject.length).toBeGreaterThanOrEqual(2);
  });

  it("balances positive and negative offer-quality cases", () => {
    const tagged = (tag: string) =>
      cases.filter((c) => (c as { tags?: string[] }).tags?.includes(tag));
    const quality = tagged("quality");
    const negative = quality.filter((c) =>
      (c as { tags?: string[] }).tags?.includes("negative"),
    );
    expect(negative.length).toBeGreaterThanOrEqual(3);
    expect(quality.length - negative.length).toBeGreaterThanOrEqual(2);
  });

  it("live-full runner honors injectAssistantAfter", () => {
    const runner = readFileSync(
      resolve(import.meta.dirname, "../src/eval/run-live-full.ts"),
      "utf8",
    );
    expect(runner).toMatch(/injectAssistantAfter/);
    expect(runner).toMatch(/appendAssistantMessage\?\.\(conversationId, inject\)/);
  });

  it("live-full runner reproduces idle rotation (new conversation, DB facts + RECENT_OUTBOUND kept)", () => {
    const runner = readFileSync(
      resolve(import.meta.dirname, "../src/eval/run-live-full.ts"),
      "utf8",
    );
    expect(runner).toMatch(/newConversationBefore\s*\)\s*\{\s*conversationId = await client\.createConversation\(\);/);
    expect(runner).toMatch(/formatRecentOutboundContext\(\s*await listRecentReminderOutbounds\(/);
    expect(runner).toMatch(/\.\.\.\(recentOutbound \? \[recentOutbound\] : \[\]\)/);
  });

  it("no-save conversational turns assert filing_empty", () => {
    const expected: Array<[string, number]> = [
      ["so-multi-list-meaning-not-recency", 0],
      ["so-multi-list-by-content", 0],
      ["so-chat-no-offer", 0],
      ["so-q-neg-one-off-fact", 0],
      ["so-q-neg-anecdote", 0],
    ];
    for (const [id, turn] of expected) {
      const row = cases.find((c) => c.id === id);
      expect(row, id).toBeTruthy();
      const types = (row!.turns[turn]!.constraints ?? []).map((c) => c.type);
      expect(types, id).toContain("filing_empty");
      expect(types, id).toContain("lists_empty");
    }
  });

  it("filing_empty fails on a silent filing (shape from the 2026-11-06 run)", () => {
    const silentFiling = {
      ...emptyLlmMetadata(),
      filing: [
        {
          action: "add_filing",
          itemName: "איתי — כיתה ג׳",
          itemInfo: "נהנה השנה",
          itemDescription: "",
          targets: [],
          filingId: "",
        },
      ],
    } as unknown as ReturnType<typeof emptyLlmMetadata>;
    const c = [{ type: "filing_empty" }] as ModelEvalConstraint[];
    expect(evaluateConstraints(c, silentFiling, "").ok).toBe(false);
    expect(evaluateConstraints(c, emptyLlmMetadata(), "").ok).toBe(true);
  });

  it("QA-1: assignment is verified on the action and in persisted facts", () => {
    const assign = cases.find((c) => c.id === "so-explicit-assign-still-works")!;
    const a = assign.turns[0]!;
    expect(a.constraints).toContainEqual({
      type: "lists_targets_include",
      action: "add",
      listType: "tasks",
      targetIncludes: "מיכל",
    });
    expect(a.stateAfter?.factsInclude).toEqual(
      expect.arrayContaining(['"owner":"מיכל"', '"assigned_by":"טל"']),
    );
    const standing = cases.find((c) => c.id === "so-standing-arrangement-no-tasks")!;
    const st = standing.turns[0]!;
    expect((st.constraints ?? []).map((c) => c.type)).toContain("lists_empty");
    expect(st.stateAfter?.factsExclude).toEqual(
      expect.arrayContaining(['"assigned_by"', '"owner":"מיכל"', '"owner":"עמית"']),
    );
  });

  it("references only seeded symbolic ids", () => {
    for (const c of cases) {
      const seeded = new Set<string>();
      for (const list of c.setup?.lists ?? []) {
        for (const item of list.items ?? []) {
          const id = (item as { item_id?: string }).item_id;
          if (id) seeded.add(id);
        }
      }
      for (const turn of c.turns) {
        for (const row of (turn.constraints ?? []) as Array<{ ids?: string[] }>) {
          for (const id of row.ids ?? []) expect(seeded.has(id), `${c.id}:${id}`).toBe(true);
        }
      }
    }
  });
});
