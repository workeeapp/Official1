# Decision-core P1 report

Follow-on to [`decision-core-p0-report.md`](decision-core-p0-report.md). No production prompt or engine changes.

## P0 recap

| Suite | Result |
|-------|--------|
| LIVE_MODEL decision-core | 14/14 |
| LIVE_MODEL_MT decision-core | 7/7 (after harness constraint fix for id-only remove) |
| attachment-intent decision-core | 5/5 |

Gate size after P1 tags: **30** cases (`decision-core` tag). Offline: `tests/decision-core-selection.offline.test.ts`.

## Remaining gaps after P0 → P1 cases added

| Gap | New case | Result |
|-----|----------|--------|
| Update existing entity, no duplicate | `dm-update-existing-task` | **PASS** |
| Multi independent actions one turn | `dm-multi-shop-and-filing` | **PASS** |
| Intervening automated Lucy (non-attach) | `dm-intervening-reminder-draft` | **PASS** |
| Soft reminder offer accept | `dm-soft-offer-accept-mt` | **PASS** |
| Stale numbered ref after mutate | deferred | not authored (investigation) |

## P1 LIVE outputs (summary)

- **dm-update-existing-task:** `lists.update` tasks with `item_id=eval-task-gift` + title change; no add.
- **dm-multi-shop-and-filing:** shopping add יין + `add_filing` in same turn.
- **dm-intervening-reminder-draft:** turn0 ask/empty; `injectAssistantAfter` system interrupt; turn1 completes reminder (+ shopping self-nudge as expected).
- **dm-soft-offer-accept-mt:** turn0 tasks add מצגת, no clock; turn1 reminders add without re-adding speaker task as duplicate product claim.

## Harness notes

- MT runner gained optional `injectAssistantAfter` (same pattern as attachment-intent).
- Remove-after-add constraints score stable `item_id` removes (not title text on remove ACTION).

## Not done (by design)

- Prompt / engine changes — none; propose only if future reproducible decision-core failures remain after harness honesty.
- LIVE_FULL — not run (isolation prerequisites not re-verified this phase).
- Stale dump-line-after-mutate LIVE case — deferred.
- Commit / push / Lucy DB sync — none.
