# LIVE case authoring (model + full)

Authors write **product intents** (ask / remove_item / …), not engine ACTION schema.
`compileLiveAuthorDraft()` in `backend/src/eval/live-author-compile.ts` turns drafts into corpus JSON the runners already understand. Future Test Studio UI should call the same compiler.

Reports are **English**. Machine UI consumes `*-last-report.json` (`kind: "live-eval-ui-report"`).

## Intent drafts (preferred)

You fill: id, track, Hebrew utterance(s), seed items, and an **intent** per turn.

Example — “I bought milk” ([`docs/qa/studio/intent-draft-example.json`](studio/intent-draft-example.json)):

```json
{
  "id": "studio-intent-buy-milk",
  "track": "model",
  "setup": { "shoppingItems": [{ "id": "eval-item-milk", "label": "חלב" }] },
  "turns": [
    {
      "utterance": "קניתי חלב",
      "intent": { "type": "remove_item", "listType": "shopping", "itemId": "eval-item-milk" }
    }
  ]
}
```

Compiler emits `lists_remove_item_ids` + `list_ops_empty` behind the scenes.

### Multi-turn

Same shape, multiple turns ([`intent-draft-mt-example.json`](studio/intent-draft-mt-example.json)):

| Turn | Utterance | Intent |
|------|-----------|--------|
| 0 | תמחק את זה | `ask` |
| 1 | את החלב | `remove_item` (milk id) |

If `track` is `model` and there are 2+ turns, the compiler **auto-routes** to the multi-turn corpus (`mt`).

### Intent catalog (v1+)

| Intent | Meaning |
|--------|---------|
| `ask` | No mutations; response looks like a question |
| `remove_item` | Remove this item id from shopping/tasks |
| `add_shopping` / `add_task` | Add item text to shopping or tasks |
| `reminder_add` | Self-nudge (reminder + task) |
| `filing_add` / `filing_remove` | Filing mutations |
| `directory_add` / `directory_remove` | Contacts book |
| `show_dump` | Show saved dump (`value` default `full`) |
| `share_update` | Share/assign-style lists update/add |
| `custom` | Advanced escape: hand-written `constraints` only |

### Multi-turn family tags (LIVE MT)

Tag exactly one primary family (plus domain tags):

| Tag | Meaning |
|-----|---------|
| `mt-clarify` | Ambiguous / incomplete → ask → act (incl. confirm כן) |
| `mt-multi-act` | Several mutations in one conversation context |
| `mt-complex` | Cross-list / share / event host+links |

Filter: `MODEL_EVAL_TAGS=mt-clarify,share,events,full-live`

Bulk expansion script (idempotent): `npx tsx backend/scripts/expand-live-coverage.ts`

LIVE_FULL: optional `outcome` per turn (`itemIdsAbsent`, `factsInclude`, …). If omitted, the compiler synthesizes a sensible `stateAfter` from the intent (e.g. remove → item absent).

### CLI

```bash
npm run add:live-case -w backend -- --draft docs/qa/studio/intent-draft-example.json
npm run add:live-case -w backend -- --draft docs/qa/studio/intent-draft-mt-example.json --write

# Legacy templates still work (wrapped into drafts internally)
npm run add:live-case -w backend -- --track model --template ask --id my-ask --utterance "תוסיפי מטלה"
npm run add:live-case -w backend -- --bulk docs/qa/studio/bulk-example.jsonl
```

## Where compiled cases land

| Track | Corpus | Runner |
|-------|--------|--------|
| `LIVE_MODEL` single-turn | `docs/qa/phase-4-corpus.json` | `npm run test:model-eval -w backend` |
| `LIVE_MODEL` multi-turn | `docs/qa/phase-4-multi-turn-corpus.json` | `npm run test:model-eval-mt -w backend` |
| `LIVE_FULL` | `docs/qa/live-full-corpus.json` | `npm run test:model-eval-full -w backend` |

### Run one case (or a tag subset)

**LIVE layers** — filter by case id(s) and/or tags (all three runners):

```bash
# Single-turn LIVE_MODEL
MODEL_EVAL_LIVE=1 MODEL_EVAL_CASES=event-host-create-poker npm run test:model-eval -w backend

# Multi-turn LIVE_MODEL
MODEL_EVAL_LIVE=1 MODEL_EVAL_CASES=mt-share-ask-then-partner npm run test:model-eval-mt -w backend

# LIVE_FULL (needs WORKEE_APPROVED_TEST_DATABASE_URL / approved workee_test)
MODEL_EVAL_FULL_LIVE=1 MODEL_EVAL_CASES=full-directory-add-michal npm run test:model-eval-full -w backend

# Tags (comma-separated)
MODEL_EVAL_LIVE=1 MODEL_EVAL_TAGS=shopping,reminders npm run test:model-eval -w backend
MODEL_EVAL_FULL_LIVE=1 MODEL_EVAL_TAGS=full-live npm run test:model-eval-full -w backend
```

**Unit layers** (shared / backend / frontend) — Vitest file path and/or `-t` name filter:

```bash
npm run test -w shared -- src/phone.test.ts
npm run test -w backend -- tests/reminders.test.ts -t "cascade"
npm run test -w frontend -- src/App.test.tsx -t "login"
```

### Bulk add

JSON array or JSONL — each row may be an **intent draft**, a **template spec**, or a ready case:

```bash
npm run add:live-case -w backend -- --bulk docs/qa/studio/bulk-example.jsonl --write
```

## Case fields (compiled / stored)

- `id`, `tags[]` — selective runs via `MODEL_EVAL_TAGS`
- `description` — feeds the report **Scenario** section
- `setup` — seed lists / filing / reminders / contacts (`shoppingItems` shorthand allowed on drafts)
- Stored turns use `constraints` (+ `stateAfter` on FULL) — produced by the compiler, not typed by humans

After a run (gitignored):

- `docs/qa/*-last-eval.json` — raw runner dump
- `docs/qa/*-last-report.json` — **UI contract** (`EvalUiReport`)
- `docs/qa/*-last-report.md` — English human view

## UI / Test Studio contract

`buildEvalUiReport()` in `backend/src/eval/human-report.ts` produces:

```ts
{
  version: 1,
  kind: "live-eval-ui-report",
  track, suite, generatedAt, promptSource, productionApply,
  tagsFilter, caseIdsFilter,
  score: { total, passed, failed, passRate, requiredPassRate },
  gates: { softOk, criticalOk, criticalFailed, suiteOk },
  cases: [{
    id, ok, verdict, tags, description, scenario, failures, warningCount,
    turns: [{
      index, utterance, response, responsePreview,
      expectation, actionSummary, ok, failures, warnings,
      appliedViaProduction?, stateNote?
    }]
  }]
}
```

**Frontend / Test Studio should:**

1. Render suite header from `score` + `gates` + `track` + `productionApply`.
2. Per case: Scenario → Expectation → Observed → Verdict (same order as markdown).
3. Show `warnings` as soft flags (do not treat as FAIL unless you add a strict mode later).
4. Author new cases via **intent drafts** + `compileLiveAuthorDraft` (or `--draft` / Studio API); do not ask humans for constraint JSON.
5. Prefer `LIVE_FULL` for user-visible confidence; `LIVE_MODEL` for cheap prompt iteration.

Existing Studio validation (`studio-validate.ts`) covers ENGINE/MODEL regression drafts; LIVE intent drafts are the parallel authoring path until Studio UI unifies them.

## Templates (copy-paste)

### 1. Ask (clarify, no mutations)

```json
{
  "id": "task-empty-ask-example",
  "tag": "action-confusion",
  "tags": ["tasks", "single-turn"],
  "description": "Incomplete task add → ask",
  "utterance": "תוסיפי מטלה",
  "setup": {},
  "constraints": [
    { "type": "mutations_empty_or_read_only" },
    { "type": "response_looks_like_ask" }
  ]
}
```

### 2. Remove by id (shopping)

```json
{
  "id": "list-buy-eggs",
  "tag": "happy",
  "tags": ["shopping", "single-turn"],
  "description": "Bought eggs → remove by item_id",
  "utterance": "קניתי ביצים",
  "setup": {
    "lists": [
      {
        "list_id": "eval-list-shopping-personal",
        "list_type": "shopping",
        "owner": "טל",
        "scope": "personal",
        "items": [{ "item_id": "eval-item-eggs", "שם פריט": "ביצים" }]
      }
    ]
  },
  "constraints": [
    {
      "type": "lists_remove_item_ids",
      "listType": "shopping",
      "itemIds": ["eval-item-eggs"]
    },
    { "type": "list_ops_empty" }
  ]
}
```

LIVE_FULL variant: use `turns: [{ utterance, constraints, stateAfter: { itemIdsAbsent: ["eval-item-eggs"] } }]` and include tag `full-live`. Keep `listType` so wrong ACTION quality fails (or surfaces as a report warning).

### 3. Add shopping

```json
{
  "id": "shopping-add-bread",
  "tag": "happy",
  "tags": ["shopping", "single-turn"],
  "description": "Add bread to shopping",
  "utterance": "תוסיפי לחם לקניות",
  "setup": {},
  "constraints": [
    {
      "type": "lists_has_action",
      "action": "add",
      "listType": "shopping",
      "itemTextIncludes": "לחם"
    }
  ]
}
```

### 4. Reminder add (self-nudge)

```json
{
  "id": "reminder-create-water",
  "tag": "happy",
  "tags": ["reminders", "single-turn"],
  "description": "Relative self-nudge",
  "utterance": "תזכירי לי בעוד שעה לשתות מים",
  "setup": {},
  "constraints": [
    { "type": "reminders_has_action", "action": "add" },
    { "type": "lists_has_action", "action": "add", "listType": "tasks" }
  ]
}
```

### 5. Multi-turn clarify → act

```json
{
  "id": "mt-clarify-then-remove-bread",
  "tag": "continuity",
  "tags": ["shopping", "multi-turn"],
  "description": "Ambiguous delete → pick bread",
  "setup": {
    "lists": [
      {
        "list_id": "eval-list-shopping-personal",
        "list_type": "shopping",
        "owner": "טל",
        "scope": "personal",
        "items": [
          { "item_id": "eval-item-milk", "שם פריט": "חלב" },
          { "item_id": "eval-item-bread", "שם פריט": "לחם" }
        ]
      }
    ]
  },
  "turns": [
    {
      "utterance": "תמחק את זה",
      "constraints": [
        { "type": "mutations_empty_or_read_only" },
        { "type": "response_looks_like_ask" }
      ]
    },
    {
      "utterance": "את הלחם",
      "constraints": [
        {
          "type": "lists_remove_item_ids",
          "listType": "shopping",
          "itemIds": ["eval-item-bread"]
        },
        { "type": "list_ops_empty" }
      ]
    }
  ]
}
```

## Evidence strength (short)

- Soft suite gate (`passRate ≥ 0.7`) can pass while individual cases fail.
- `LIVE_MODEL` never applies — green means metadata looked right.
- Prefer `LIVE_FULL` for user-visible confidence; use `LIVE_MODEL` for cheap prompt iteration.
- Report **warnings** (e.g. wrong `listType`) separately from FAIL in `*-last-report.*`.
