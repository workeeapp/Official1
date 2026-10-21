# Test run summary — 2026-10-21

## Unit / integration layers

| Layer | Result | Detail |
|-------|--------|--------|
| shared | **PASS** | 9 files, 157 tests |
| frontend | **PASS** | 8 files, 63 tests |
| backend (default vitest) | **PARTIAL** | 75/77 files; **904 passed / 4 failed** |

Live model-eval is excluded from default `npm test` (`backend/vitest.config.ts`).

### Backend unit failures (4)

1. `chat.test.ts` — saves list/task/filing (spy mismatch)
2. `chat.test.ts` — targeted action notification (spy mismatch)
3. `chat.test.ts` — notify on shared-item delete (spy mismatch)
4. `phase-4-multi-turn.offline.test.ts` — stub constraints: `כיבוד` / `יוגורט` / `חשמל`

Logs: `docs/qa/unit-test-last-report.txt`, `docs/qa/frontend-test-last-report.txt`

## LIVE eval reports (this run)

| Track | Report | Score | Suite |
|-------|--------|-------|-------|
| LIVE_MODEL | [phase-4-last-report.md](phase-4-last-report.md) / `.json` | **47/50** (0.94) | FAIL (critical: share-shop-with-amit, event-host-create-poker) |
| LIVE_MODEL_MT | [phase-4-multi-turn-last-report.md](phase-4-multi-turn-last-report.md) / `.json` | **17/26** (0.65 &lt; 0.7) | FAIL |
| LIVE_FULL | *not refreshed* | — | Skipped: `WORKEE_APPROVED_TEST_DATABASE_URL` not set (old report from 2026-10-20 remains) |

Live run log: `docs/qa/live-model-eval-run-log.txt`

### LIVE_MODEL critical fails

- `share-shop-with-amit` — expected lists.update/shopping
- `event-host-create-poker` — response missing ערב פוקר
- also soft: `task-meet-create` — expected lists.add/tasks

### LIVE_FULL

To regenerate:

```bash
# requires approved workee_test URL in env
MODEL_EVAL_FULL_LIVE=1 MODEL_EVAL_LIVE=1 npm run test:model-eval-full -w backend
```
