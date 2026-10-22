# Lucy Core E2E Eval Pack

Independent LIVE scenarios for Lucy’s core product loop (ACTION + optional FULL apply).  
Filter with `MODEL_EVAL_TAGS=core-pack` or `freeze-pack`. Each case owns its `setup` and can run alone via `MODEL_EVAL_CASES=<id>`.

## Modes (honest layers)

| Mode | What it proves | Gate |
|------|----------------|------|
| **LIVE_MODEL / MT** | Real model ACTION + forbid/ask | `MODEL_EVAL_LIVE=1` + OpenAI key |
| **LIVE_FULL** | Model + production-style apply + `stateAfter` | `MODEL_EVAL_FULL_LIVE=1` + `DATABASE_URL` **exact match** `WORKEE_APPROVED_TEST_DATABASE_URL` |
| **ENGINE / pack suites** | Deterministic apply / dump slices | Existing domain pack offline tests |

LIVE_MODEL does **not** prove DB mutation. LIVE_FULL is skipped unless the approved isolated test DB is configured. Never use production credentials, real WhatsApp, or live reminder schedulers for eval.

## Run

```bash
# Freeze-8 subset (LIVE_MODEL / MT — separate scripts)
set MODEL_EVAL_LIVE=1
set MODEL_EVAL_TAGS=freeze-pack
npm run test:model-eval -w backend
npm run test:model-eval-mt -w backend

# Full core-pack ACTION suite
set MODEL_EVAL_TAGS=core-pack
npm run test:model-eval -w backend
npm run test:model-eval-mt -w backend

# LIVE_FULL only when approved test DB is verified (never with production URL)
set MODEL_EVAL_FULL_LIVE=1
set MODEL_EVAL_TAGS=core-pack
npm run test:model-eval-full -w backend
```

`test:model-eval` runs single-turn only; MT and FULL are separate scripts so a tag filter cannot accidentally enter LIVE_FULL.

Counts snapshot: `docs/qa/core-eval-pack-counts.json` (regenerate with `npx tsx backend/scripts/count-core-eval-pack.ts`).

## Authoring new gaps

1. Draft under `docs/qa/studio/packs/` (intent language).
2. `npm run add:live-case -w backend -- --bulk path.json --write`
3. Retag reused cases: `npx tsx backend/scripts/tag-core-eval-pack.ts`

## Related packs (not folded into core)

- `shopping-pack-suite.json` / `tasks-pack-suite.json` / `reminder-pack-suite.json` — thin MODEL_APPLY contracts
- `show-pack-suite.json` — dump slices
- Unit `reminder-link.test.ts` — cascade FK helpers (LIVE_FULL 24a/24b author the product story when DB is approved)
