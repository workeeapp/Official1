# Decision-core P0 gate report

Generated after tagging + LIVE runs (model-only; `productionApply: false`).

## Isolation

- Path: `createConversation` + `createResponse` (+ optional `appendAssistantMessage`)
- No Prisma apply, WhatsApp, reminder fire, Lucy DB sync, production data
- Opt-in: `MODEL_EVAL_LIVE=1` + `MODEL_EVAL_TAGS=decision-core`

## Proof kinds

| Subset | Track | Proof |
|--------|-------|--------|
| 14 single-turn | LIVE_MODEL | **actual-model** ACTION (+ response ask/forbid) |
| 7 multi-turn | LIVE_MODEL_MT | **actual-model** + in-memory snapshot |
| 5 attachment | attachment-intent LIVE | **actual-model** + fixture PENDING/dump/intervening |
| Domain packs / ENGINE | offline | **stub/fixture** — not counted as model proof |

## Selection

Ids tagged `decision-core` (26). Offline verify: `tests/decision-core-selection.offline.test.ts`.

## Results

| Suite | Score | Notes |
|-------|-------|-------|
| LIVE_MODEL | **14/14** | Incl. truthful forbid past-tense on `delete-everything` |
| LIVE_MODEL_MT | **7/7** after constraint fix* | See below |
| attachment-intent | **5/5** | |

\*Initial MT failures (`mt-multi-add-then-buy`, `core-shopping-crud-mt`) were **harness false negatives**: model correctly removed by stable `item_id` from evolved snapshot; constraints required Hebrew title on the remove ACTION. Constraints updated to score remove-by-id without requiring title text. Re-run passed.

## Remaining coverage gaps (justify P1)

| Gap | P0 status | P1 action |
|-----|-----------|-----------|
| Conversational / maybe → no act | Covered (`core-intent-maybe-*`, `event-maybe-no-host`) | none |
| Implicit save, no invented reminder | Covered (`freeze-f7`, `freeze-f8`, `core-intent-need-doctor`) | none |
| Ambiguous delete ask + no false «מחקתי» | Covered (`delete-everything`) | none |
| Intervening automated Lucy (non-attach) | Only attachment corpus | **add** `dm-intervening-reminder-draft` |
| Update existing entity, no duplicate add | `core-dup-signal` is soft any(update\|ask\|add≤1) | **add** `dm-update-existing-task` |
| Soft reminder offer **accept** (not decline) | Only decline MT | **add** `dm-soft-offer-accept-mt` |
| Multiple independent actions **one turn** | MT sequential multi only | **add** `dm-multi-shop-and-filing` |
| Stale numbered ref after mutate | Not represented faithfully in P0 | **defer** (investigation) |

## Prompt / engine

No production prompt or engine changes in P0.
