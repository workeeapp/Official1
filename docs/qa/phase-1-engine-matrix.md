# Phase 1 — engine coverage matrix

Branch: `test/qa-phase-1-engine` (worktree). Product runtime stays on `feat/multi-instance-state`.

**Rule:** each cell = frozen ACTION → apply → assert DB/side effects. No live Lucy.

| Domain | add | update | remove | Notes / gaps |
|--------|-----|--------|--------|--------------|
| shopping | covered | covered | covered | `employee-records.test.ts` — no silent type rewrite; snapshot splits personal vs shared shopping rows |
| tasks | covered | covered | covered | ACTION `list_type` wins; reply wording may still fix קניות↔מטלות |
| custom list | covered | covered | covered | shared + partner notify from **DB**; no cross-list fuzzy remove |
| filing | covered (+ refuse empty description) | covered (loose name + miss) | covered (exact + loose + miss) | rename `item_name` = intentional gap |
| reminders | covered | covered | covered | confirm bulk in `reminders.test.ts` / `pending-action.test.ts` |
| directory | covered (`directory-apply.test.ts`) | **N/A (no ACTION)** | covered | phone change = remove+add |
| jobs | N/A (lifecycle) | progress/snooze… | clear via lists | not CRUD rows |
| messages | send only | N/A | N/A | by design |
| bulk list delete | N/A | N/A | covered | ≥2 removes → `delete_lists` confirm hold |
| no-guess share targets | N/A | N/A | covered | empty list targets stay empty — no message/top-level inherit (`llm-message` / pending-action) |
| no-guess list match | covered | covered | covered | exact ACTION only; miss = no-op; personal beats same-named shared on empty targets |
| filtered multi delete (model) | N/A | Phase 4 corpus | engine confirm same as bulk | prompt: delete all matches when count/plural named; no «לאיזו» / «מצאתי מטלה אחת» |
| shared shopping notify | N/A | covered (`fallbackNotificationText`) | covered | old→new label + «המשותפת שלכם» for non-owner watcher |
| self until-done job | covered (`jobs.open`) | snooze/raise | close/answer/clear_clock | asker=subject=speaker; one-shot remind stays reminders |
| SPA from API | covered (`spa-static.test.ts`) | N/A | N/A | serves `frontend/dist` + SPA fallback; `/api` stays JSON |

## Engine cases added on this branch

1. `update_filing` with Hebrew name drift (`קוד כניסה` → `קוד לכניסה`)
2. `update_filing` with no match → no create
3. `remove_filing` with Hebrew name drift → soft-delete resolved row
4. `remove_filing` with no match → no mutation
5. `add_filing` with empty `item_description` → refuse create
6. `directory.add` / `directory.remove` via `applyDirectoryActions`

## Success criteria (Phase 1)

- [x] Every durable domain has add + update + remove where the product supports them
- [x] Intentional gaps documented (directory update; filing rename)
- [x] New engine bugs reproduce as failing vitest with a frozen ACTION
- [x] No OpenAI key required; CI stays fast
