# ENGINE pack + test pyramid coverage map

Planning document only — tags are **not** runtime schema fields.

**ENGINE apply+stateAfter total: 28** = Gate 1 (6) + Workflow ENGINE (4) + Gap pack (18).

Loader/meta tests (suite discovery, fixture-required, spies) are **not** counted as product cases.

---

## Retained ENGINE cases (10)

| ID | Source | Tag | Higher-layer note |
|----|--------|-----|-------------------|
| `g1-c1-shop-add-remove` | regression-suite | **CROSS_LAYER_CANONICAL** | LIVE_MODEL / LIVE_FULL: NL «קניתי חלב» → remove; ENGINE already proves apply+UUID reinject |
| `g1-c2-ask-then-add` | regression-suite | **CROSS_LAYER_CANONICAL** | LIVE_MODEL_MT: clarify then add; ENGINE proves empty ask does not mutate |
| `g1-c3-clarify-then-delete` | regression-suite | **CROSS_LAYER_CANONICAL** | LIVE_MODEL_MT / LIVE_FULL (`full-mt-clarify-then-delete`) |
| `g1-p1-when-clear-delete` | regression-suite | ENGINE_CORE | Thin vs g1-c1 remove; keep as clear-target product beat |
| `g1-p2-event-host-link` | regression-suite | **CROSS_LAYER_CANONICAL** | MODEL_APPLY Event `E-CLARIFY-THEN-LINK`; LIVE_FULL `full-mt-event-clarify-then-link` — do **not** count Event Pack as ENGINE |
| `g1-p3-host-rename` | regression-suite | **CROSS_LAYER_CANONICAL** | MODEL_APPLY `E-RENAME-SAME-HOST`; LIVE_FULL `full-event-rename-host` |
| `W1-SHOP-THEN-FILING` | workflow-pack | **CROSS_LAYER_CANONICAL** | MODEL_APPLY twin `W1-SHOP-THEN-FILING-MA` (stub ACTION); LIVE_MODEL filing+shop continuity |
| `W2-LIST-SHARE-REMIND` | workflow-pack | **CROSS_LAYER_CANONICAL** | LIVE_FULL share+clock; ENGINE proves alter_list + reminder apply |
| `W3-MULTI-ACTION-ONE-TURN` | workflow-pack | ENGINE_CORE | Twin `W3-*-MA` is MODEL_APPLY, not extra ENGINE |
| `W4-CLARIFY-THEN-MULTI` | workflow-pack | **CROSS_LAYER_CANONICAL** | Twin `W4-*-MA`; LIVE_MODEL_MT multi-domain clarify |

---

## New gap ENGINE cases (18)

| ID | Tag | Expected persisted asserts (summary) | Higher layers |
|----|-----|--------------------------------------|---------------|
| `g1-filing-remove` | **CROSS_LAYER_CANONICAL** | filing info excluded; shopping item kept | LIVE_MODEL / LIVE_FULL filing-remove |
| `g1-filing-update` | ENGINE_CORE | new info in facts; old excluded | optional MODEL_APPLY filing pack |
| `g1-reminder-cancel` | **CROSS_LAYER_CANONICAL** | reminder text gone from facts | LIVE_FULL `full-reminder-cancel-named` |
| `g1-cascade-delete-task` | **CROSS_LAYER_CANONICAL** | worker task + clock facts gone | LIVE_FULL `full-cascade-delete-task-24a` |
| `g1-cascade-delete-reminder` | **CROSS_LAYER_CANONICAL** | clock cancel → task absent | LIVE_FULL `full-cascade-delete-reminder-24b` |
| `g1-list-ops-delete-list` | ENGINE_CORE | custom list count 0; items absent | — |
| `g1-shop-update-qty` | ENGINE_CORE | same item_id; qty in facts | optional LIVE_MODEL update |
| `g1-task-meet-datetime` | **CROSS_LAYER_CANONICAL** | task + `2099-06-20` in facts; no clock | LIVE_MODEL / LIVE_FULL dated task (`full-core-task-mom-tomorrow`) |
| `g1-multi-shop-add` | ENGINE_CORE | three item_ids present | — |
| `g1-share-then-unshare` | **CROSS_LAYER_CANONICAL** | share then partner excluded | LIVE_MODEL_MT share flows |
| `g1-reminder-update-time` | ENGINE_CORE | `14:00` + item in facts | optional LIVE_MODEL |
| `g1-no-invented-clock` | ENGINE_CORE | task present; reminders empty | LIVE_MODEL constraint twin |
| `g1-mt-multi-add-then-buy` | **CROSS_LAYER_CANONICAL** | milk gone, bread kept | LIVE_FULL `full-mt-multi-add-then-buy` |
| `g1-custom-rename-list` | ENGINE_CORE | new list name; same item_id | — |
| `g1-clear-personal-shopping` | ENGINE_CORE | both items absent; shell remains | LIVE_FULL clear shopping |
| `g1-empty-mutate-ask` | ENGINE_CORE | seeded item unchanged on empty ACTION | LIVE_MODEL_MT ask turns |
| `g1-remove-wrong-list-type` | ENGINE_CORE | shopping id removed despite authored tasks type | — (engine resolve-by-id) |
| `g1-task-plain-add` | ENGINE_CORE | plain task id + facts | optional LIVE_MODEL |

---

## Behavioral overlaps (do not double-count as ENGINE)

| Artifact | Track | Overlaps |
|----------|-------|----------|
| Event Pack `E-HOST-CREATE` | MODEL (stub) | Host naming intent ≈ g1-p2 turn 1 / `g1-task-plain-add` domain |
| Event Pack `E-CLARIFY-THEN-LINK` | MODEL_APPLY | ≈ `g1-p2` |
| Event Pack `E-RENAME-SAME-HOST` | MODEL_APPLY | ≈ `g1-p3` |
| Workflow `W*-MA` | MODEL_APPLY | Twins of W1/W3/W4 ENGINE |
| Inline `g1-list-ops-smoke` in regression test | ENGINE (ad-hoc) | Now packed as `g1-list-ops-delete-list` |

---

## Proposed pyramid roles

| Layer | Role | Deliberate overlap set (canonical) |
|-------|------|-------------------------------------|
| Unit / contract | Schema, guards, constraint helpers, list-type resolve | — |
| **ENGINE** | Broad apply + `stateAfter` (this pack, 28) | All rows above |
| **MODEL_APPLY** | Stub/model ACTION → same apply path | Prefer Event E-* + W*-MA + filing/reminder packs; **not** clone all 28 |
| **LIVE_MODEL / MT** | Real NL → ACTION constraints | Canonical: shop add/remove, clarify, filing remove, dated task, share |
| **LIVE_FULL** | Model + apply + DB on `workee_test` | Small critical set: cascade 24a/24b, clarify-delete, event link, reminder cancel, multi-add-then-buy |

**LIVE_ONLY** (not authored as ENGINE): directory/contacts (harness has no directory apply), `show_dump` Chat replace, WA delivery, reminder fire, Lucy2 DB prompt, jobs/handoff.

---

## Omitted from this authoring (harness / scope)

| Proposed | Reason |
|----------|--------|
| Directory add/remove | `applyFixtureTurn` does not apply `metadata.directory`; `contactNames*` not passed in ENGINE runner |
| Assign-to-partner (`targets`) | No clear ENGINE fixture contract in apply path (targets stripped from item data); needs harness/product confirmation before authoring |
| Incomplete filing that throws ValidationError | Would fail the harness catch path; empty-ACTION ask covered by `g1-empty-mutate-ask` |
| Personal-vs-shared dual-owner visibility | Needs richer multi-account snapshot asserts than current `stateAfter` helpers |
