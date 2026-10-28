import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultLiveFullCorpusPath,
  filterCasesByTags,
  loadLiveFullCorpus,
} from "../src/eval/corpus.js";
import type { ModelEvalConstraint } from "../src/eval/constraints.js";

function collectConstraintTypes(rows: ModelEvalConstraint[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    out.push(row.type);
    if (row.type === "any") {
      out.push(...collectConstraintTypes(row.constraints));
    }
  }
  return out;
}

describe("live-full corpus loader", () => {
  it("loads tagged cases with turns and critical ids", () => {
    const path = defaultLiveFullCorpusPath();
    expect(existsSync(path), path).toBe(true);
    const corpus = loadLiveFullCorpus(path);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(3);
    expect(corpus.cases.every((c) => (c.tags ?? []).includes("full-live"))).toBe(
      true,
    );
    for (const id of corpus.criticalCaseIds ?? []) {
      expect(corpus.cases.some((c) => c.id === id), id).toBe(true);
    }
    const shop = filterCasesByTags(corpus.cases, ["shopping"]);
    expect(shop.length).toBeGreaterThan(0);
  });

  it("remove-after-add FULL cases score remove without requiring item title text", () => {
    const corpus = loadLiveFullCorpus(defaultLiveFullCorpusPath());
    const cases = [
      {
        id: "full-mt-multi-add-then-buy",
        turnIndex: 1,
      },
      {
        id: "full-core-shopping-crud-mt",
        turnIndex: 2,
      },
    ] as const;
    for (const { id, turnIndex } of cases) {
      const row = corpus.cases.find((c) => c.id === id);
      expect(row, id).toBeTruthy();
      const constraints = row!.turns[turnIndex]!.constraints;
      const types = collectConstraintTypes(constraints);
      expect(types, id).toContain("lists_has_action");
      expect(types, id).toContain("list_ops_empty");
      const removeText = constraints.filter(
        (c) =>
          c.type === "lists_has_action" &&
          c.action === "remove" &&
          typeof c.itemTextIncludes === "string",
      );
      expect(removeText, id).toEqual([]);
      const removeMin = constraints.find(
        (c) =>
          c.type === "lists_has_action" &&
          c.action === "remove" &&
          c.listType === "shopping" &&
          c.minCount === 1,
      );
      expect(removeMin, id).toBeTruthy();
    }
  });

  it("share shopping FULL cases still require lists.update/shopping (policy: whole list allowed)", () => {
    const corpus = loadLiveFullCorpus(defaultLiveFullCorpusPath());
    for (const id of [
      "full-share-shop-with-amit",
      "full-mt-share-ask-then-partner",
    ] as const) {
      const row = corpus.cases.find((c) => c.id === id);
      expect(row, id).toBeTruthy();
      const turn =
        id === "full-mt-share-ask-then-partner"
          ? row!.turns[1]!
          : row!.turns[0]!;
      const update = turn.constraints.find(
        (c) =>
          c.type === "lists_has_action" &&
          c.action === "update" &&
          c.listType === "shopping",
      );
      expect(update, id).toBeTruthy();
    }
  });

  it("LLM.config teaches whole shopping-list share via item co-share fan-out", () => {
    const configPath = resolve(process.cwd(), "..", "LLM.config.json");
    const raw = readFileSync(configPath, "utf8");
    expect(raw).toMatch(/sharing the entire list IS allowed/i);
    expect(raw).toMatch(/item co-share fan-out/i);
    expect(raw).not.toMatch(
      /Built-in קניות\/מטלות: no whole-list participants/,
    );
  });

  it("full-mt-event-clarify-then-link turn1 uses structural create-and-link", () => {
    const corpus = loadLiveFullCorpus(defaultLiveFullCorpusPath());
    const row = corpus.cases.find((c) => c.id === "full-mt-event-clarify-then-link");
    expect(row).toBeTruthy();
    const types = collectConstraintTypes(row!.turns[1]!.constraints);
    expect(types).toContain("lists_custom_create_and_link");
    const legacyLinkText = row!.turns[1]!.constraints.filter(
      (c) =>
        c.type === "lists_has_action" &&
        c.action === "update" &&
        c.listType === "tasks" &&
        typeof c.itemTextIncludes === "string",
    );
    expect(legacyLinkText).toEqual([]);
  });

  it("full-mt-event-clarify-then-link turn1 stateAfter requires both items + host link", () => {
    const corpus = loadLiveFullCorpus(defaultLiveFullCorpusPath());
    const row = corpus.cases.find((c) => c.id === "full-mt-event-clarify-then-link");
    expect(row).toBeTruthy();
    const state = row!.turns[1]!.stateAfter;
    expect(state?.itemIdsPresent).toEqual(["eval-item-host-bday"]);
    expect(state?.factsInclude).toEqual([
      "כיבוד · ערב יום הולדת",
      "עוגה",
      "שתייה",
      "ערב יום הולדת",
    ]);
    expect(state?.linkedListNamesOnItem).toEqual({
      itemId: "eval-item-host-bday",
      listNames: ["כיבוד · ערב יום הולדת"],
    });
  });

  it("LLM.config teaches explicit address filing same-turn ACTION", () => {
    const configPath = resolve(process.cwd(), "..", "LLM.config.json");
    const raw = readFileSync(configPath, "utf8");
    expect(raw).toMatch(/תייקי שהכתובת שלי היא רחוב הרצל 1 תל אביב/);
    expect(raw).toMatch(/lists\.add list_type filing SAME TURN/);
  });

  it("LLM.config DESTINATION LADDER routes durable-fact תייקי (no file) to filing", () => {
    const configPath = resolve(process.cwd(), "..", "LLM.config.json");
    const raw = readFileSync(configPath, "utf8");
    expect(raw).toMatch(
      /durable spoken fact \(address \/ family \/ job[\s\S]*?NO file → lists\.add list_type filing SAME TURN/,
    );
    expect(raw).toMatch(
      /FORBIDDEN: filing only because תייקי when a file has no destination/,
    );
  });

  it("LLM.config SAME-TURN CREATE+LINK wire example uses matching list_name", () => {
    const configPath = resolve(process.cwd(), "..", "LLM.config.json");
    const raw = readFileSync(configPath, "utf8");
    expect(raw).toContain(
      'list_name:\\"כיבוד · ערב יום הולדת\\"',
    );
    expect(raw).toContain(
      'linked_lists:[{list_type:\\"custom\\", list_name:\\"כיבוד · ערב יום הולדת\\"}]',
    );
  });

  it("LLM.action list_name schema requires non-empty on same-turn create+link", () => {
    const actionPath = resolve(process.cwd(), "..", "LLM.action.json");
    const raw = readFileSync(actionPath, "utf8");
    // Schema teaches matching names on create+link (wording: emit same string on
    // lists.add.list_name AND linked_lists[].list_name — not the older "MUST equal").
    expect(raw).toMatch(
      /same-turn create\+link[\s\S]{0,120}lists\.add\.list_name AND linked_lists\[\]\.list_name/i,
    );
  });
});
