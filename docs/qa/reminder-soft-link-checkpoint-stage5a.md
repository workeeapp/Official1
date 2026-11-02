# Reminder soft-link / nested-remind — checkpoint after Stage 5a

**Date:** 2026-11-02  
**Repo:** Official1  
**HEAD (uncommitted WIP on top):** `9dd38ff` — *Cancel join-linked reminder clocks when a list item is deleted.*  
**Status:** Stages **0 → 1 → 2 → 3a → 4 → 5a** closed. **Stage 5b NOT approved.**  
**Stop:** Reminder-path work paused until explicit new instruction.  
**Forbidden until instructed:** Commit / Push / Merge / LIVE / delete legacy / exact-key OFF in prod / Schema-DB changes.

## Desired runtime state (frozen)

| Concern | State |
|---|---|
| NEW | `lists.add` + `items[].remind` → atomic item+clock+join only |
| EXISTING | ESD `item_id` → `linkRemindersByItemId` only |
| Legacy | `linkRemindersToItems` (exact `itemKey`) kept for backward compat |
| Exact-key flag | `WORKEE_SOFT_LINK_EXACT_KEY` default **ON** (absent/`1`) |
| Worker linking | Unchanged (`linkRemindersToWorkerTasks` / FKs) |
| Stage 5a filter | `clocksEligibleForExactKeySoftLink` excludes NEW nested + EXISTING `requestedItemId` from exact-key path |

## WIP inventory (do not discard)

### Modified (tracked)

- `LLM.action.json`
- `LLM.config.json`
- `backend/src/services/apply-result.ts`
- `backend/src/services/chat.service.ts`
- `backend/src/services/employee-records.service.ts`
- `backend/src/services/reminder.service.ts`
- `backend/tests/self-nudge-after-shopping-dump.eval-db.test.ts`
- `docs/qa/phase-4-corpus.json`
- `shared/src/index.ts`
- `shared/src/llm-message.ts`

### Untracked (new for this program)

- `backend/src/services/reminder-soft-link.ts`
- `backend/tests/nested-remind-atomic.eval-db.test.ts`
- `backend/tests/nested-remind-atomic.offline.test.ts`
- `backend/tests/prompt-reminder-link-contract.offline.test.ts`
- `backend/tests/reminder-soft-link-phase0.offline.test.ts`
- `backend/tests/reminder-soft-link-phase0/` (if present)
- `backend/tests/reminder-soft-link-phase1.offline.test.ts`
- `backend/tests/reminder-soft-link-phase1b-bc.eval-db.test.ts`
- `backend/tests/reminder-soft-link-stage4-gate.eval-db.test.ts`
- `backend/tests/reminder-worker-soft-link.eval-db.test.ts`

## Call map at checkpoint

| Path | Join mechanism | Enters `linkRemindersToItems`? |
|---|---|---|
| NEW nested | `createItemWithNestedRemindersAtomic` / nested package txn | **No** (filtered) |
| EXISTING ESD `item_id` | `linkRemindersByItemId` | **No** (filtered via `requestedItemId`) |
| Legacy title/`itemKey` clock | `linkRemindersToItems` when flag ON | **Yes** |
| Worker | `linkRemindersToWorkerTasks` | N/A |

Prod call site for exact-key: `chat.service.ts` post-apply only, via `clocksEligibleForExactKeySoftLink` → `linkRemindersToItems(..., { exactKeyEnabled })`.

## Test results at checkpoint (workee_test / isolated process)

### Exact-key OFF (`WORKEE_SOFT_LINK_EXACT_KEY=0`)

| Suite | Result |
|---|---|
| `reminder-soft-link-stage4-gate.eval-db` | 8/8 PASS — logged `enabled=false`, DB=`workee_test` |
| `nested-remind-atomic.eval-db` | 5/5 PASS |
| Offline phase0 + phase1 + nested + prompt contract | 57/57 PASS (includes Stage 5a unit tests) |
| `item-reminder-multi-link` → `soft-link append` | FAIL **by design** (no itemKey join when OFF) |

### Exact-key ON (default / env unset)

| Suite | Result |
|---|---|
| `reminder-soft-link-phase1b-bc.eval-db` | PASS (suite forces/expects ON) |
| `reminder-worker-soft-link.eval-db` | 6/6 PASS |
| `item-reminder-multi-link.eval-db` (full, ON) | PASS (+ todos unchanged) |
| `reminder-link.test.ts` | 28/28 PASS |

Combined ON eval-db run noted: **28 passed | 2 todo**.

## Known gaps (do not claim verified)

- **`self-nudge-after-shopping-dump.eval-db`:** not verified at this checkpoint. Blocker = Prisma client expects `Employees.profile_attachment_id` missing on `workee_test`. Out of scope to fix Schema/DB here. Do not treat self-nudge as proven under OFF/ON.

## Explicit non-goals until new instruction

- No Stage **5b** (do not delete `linkRemindersToItems` / exact-key / fingerprint legacy).
- No prod exact-key OFF.
- No Prompt/Schema/Worker auto-create changes beyond current WIP.
- No Commit / Push / Merge / LIVE.
