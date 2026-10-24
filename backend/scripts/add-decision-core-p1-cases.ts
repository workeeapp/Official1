#!/usr/bin/env npx tsx
/**
 * Append justified P1 decision-core LIVE cases (idempotent by id).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const ST_CASES = [
  {
    id: "dm-update-existing-task",
    tag: "happy",
    tags: ["decision-core", "tasks", "single-turn", "p1-gap"],
    description:
      "P1: unique existing task → update same item_id; forbid lists.add",
    utterance:
      "תעדכני את המטלה לקנות מתנה — תשני את השם לקנות מתנה ליוסי",
    setup: {
      lists: [
        {
          list_id: "eval-list-tasks-gift",
          list_type: "tasks",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "eval-task-gift",
              "שם מטלה": "לקנות מתנה",
            },
          ],
        },
      ],
    },
    constraints: [
      {
        type: "lists_has_action",
        action: "update",
        listType: "tasks",
        itemTextIncludes: "eval-task-gift",
      },
      { type: "lists_has_action", action: "update", listType: "tasks", itemTextIncludes: "יוסי" },
      { type: "no_lists_add", listType: "tasks" },
      { type: "reminders_empty" },
      { type: "filing_empty" },
      { type: "list_ops_empty" },
    ],
  },
  {
    id: "dm-multi-shop-and-filing",
    tag: "happy",
    tags: ["decision-core", "shopping", "filing", "single-turn", "p1-gap"],
    description:
      "P1: two independent requests in one turn → shopping add + filing add",
    utterance: "תוסיפי יין לקניות ותתיקי שרק יין אדום",
    setup: {
      lists: [
        {
          list_id: "eval-list-shopping-personal",
          list_type: "shopping",
          owner: "טל",
          scope: "personal",
          items: [],
        },
      ],
    },
    constraints: [
      {
        type: "lists_has_action",
        action: "add",
        listType: "shopping",
        itemTextIncludes: "יין",
      },
      { type: "filing_has_action", action: "add_filing" },
      { type: "list_ops_empty" },
      { type: "reminders_empty" },
    ],
  },
];

const MT_CASES = [
  {
    id: "dm-intervening-reminder-draft",
    tag: "continuity",
    tags: ["decision-core", "reminders", "multi-turn", "p1-gap"],
    description:
      "P1: incomplete reminder → intervening automated Lucy → user gives time → complete clock",
    setup: {},
    turns: [
      {
        utterance: "תזכירי לי לקנות חלב",
        constraints: [
          { type: "mutations_empty_or_read_only" },
          { type: "no_invented_reminder_add" },
          { type: "response_looks_like_ask" },
        ],
        injectAssistantAfter: "בינתיים — קיבלתי עדכון מערכת. כשתהיה מוכן, המשך.",
      },
      {
        utterance: "מחר ב־09:00",
        constraints: [
          { type: "reminders_has_action", action: "add" },
          {
            type: "lists_has_action",
            action: "add",
            listType: "shopping",
            itemTextIncludes: "חלב",
            maxCount: 1,
          },
        ],
      },
    ],
  },
  {
    id: "dm-soft-offer-accept-mt",
    tag: "continuity",
    tags: ["decision-core", "reminders", "tasks", "multi-turn", "p1-gap"],
    description:
      "P1: implicit task save (no clock) → user accepts soft reminder with time → reminders only, no second speaker task add",
    setup: {},
    turns: [
      {
        utterance: "צריך לסיים את המצגת",
        constraints: [
          {
            type: "lists_has_action",
            action: "add",
            listType: "tasks",
            itemTextIncludes: "מצגת",
          },
          { type: "reminders_empty" },
          { type: "no_invented_reminder_add" },
        ],
      },
      {
        utterance: "כן, תזכירי לי מחר ב־09:00",
        constraints: [
          { type: "reminders_has_action", action: "add" },
          { type: "no_lists_add", listType: "shopping" },
          { type: "filing_empty" },
          {
            type: "response_forbids_any",
            needles: ["הוספתי שוב את המצגת", "הוספתי מטלה נוספת"],
          },
        ],
      },
    ],
  },
];

function upsert(
  pathRel: string,
  cases: Array<{ id: string }>,
): void {
  const path = resolve(repoRoot, pathRel);
  const corpus = JSON.parse(readFileSync(path, "utf8")) as {
    cases: Array<{ id: string }>;
  };
  let added = 0;
  let replaced = 0;
  for (const row of cases) {
    const idx = corpus.cases.findIndex((c) => c.id === row.id);
    if (idx >= 0) {
      corpus.cases[idx] = row;
      replaced += 1;
    } else {
      corpus.cases.push(row);
      added += 1;
    }
  }
  writeFileSync(path, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
  console.error(`${pathRel}: added=${added} replaced=${replaced}`);
}

upsert("docs/qa/phase-4-corpus.json", ST_CASES);
upsert("docs/qa/phase-4-multi-turn-corpus.json", MT_CASES);
console.error("P1 cases upserted.");
