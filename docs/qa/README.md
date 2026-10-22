# Lucy QA — entry point

Start here for ongoing development. Track guarantees, Studio gates, isolation rules, and verification status live in [`test-layer-contract.md`](test-layer-contract.md) — this page does not repeat that contract.

## Authoritative documents

| Doc | Use for |
|-----|---------|
| [`test-layer-contract.md`](test-layer-contract.md) | What each track proves / does not prove; Studio Phase A; DB isolation; prompt provenance; **current closeout status** |
| [`live-authoring.md`](live-authoring.md) | Author LIVE cases; report JSON/MD contract; diagnosing LIVE failures |
| [`core-eval-pack.md`](core-eval-pack.md) | `core-pack` / `freeze-pack` LIVE recipes |
| [`engine-pyramid-coverage.md`](engine-pyramid-coverage.md) | ENGINE case map + **LIVE_ONLY** coverage gaps |
| [`batch-a-readme.md`](batch-a-readme.md) | Thin Batch A labels, offline fingerprint/archive |

Evidence artifacts (not status docs): `*-last-report.md` / `.json`. [`unit-test-summary.md`](unit-test-summary.md) is a historical snapshot only.

## Run matrix

Commands run from the **repo root** with `-w backend`, or from `backend/` without the workspace flag. Vitest paths are relative to `backend/`.

| Track | Corpus / suite | Test entry | Command | Approved test DB? | OpenAI / LIVE opt-in? |
|-------|----------------|------------|---------|-------------------|------------------------|
| **ENGINE** (Gate 1) | `docs/qa/regression-suite.json` | `tests/regression-suite.offline.test.ts` | `npx vitest run tests/regression-suite.offline.test.ts` (cwd `backend`) | **Yes** — harness calls `assertApprovedEvalDatabaseUrl` | No |
| **ENGINE** (workflow) | `docs/qa/workflow-pack-suite.json` | `tests/workflow-pack.offline.test.ts` | `npx vitest run tests/workflow-pack.offline.test.ts` | **Yes** | No |
| **ENGINE** (gap pack) | `docs/qa/engine-gap-suite.json` | `tests/engine-gap-pack.offline.test.ts` | `npx vitest run tests/engine-gap-pack.offline.test.ts` | **Yes** | No |
| **MODEL_APPLY** (Batch A) | `docs/qa/batch-a-suite.json` | `tests/batch-a-model-apply.offline.test.ts` | `npx vitest run tests/batch-a-model-apply.offline.test.ts` | **Yes** | No (stub model) |
| **MODEL_APPLY** (domain packs) | Matching `docs/qa/<name>-pack-suite.json` | Apply harness files that exist today: `shopping`, `tasks`, `reminder`, `filing`, `directory`, `event`, `workflow` (`tests/<name>-pack-model-apply.offline.test.ts`). **No** apply harness for `show`, `share`, or `custom-lists` (those suites are covered by loader/MODEL stub via `domain-packs.offline.test.ts` only). | `npx vitest run tests/<name>-pack-model-apply.offline.test.ts` | **Yes** | No (stub) |
| **MODEL** wire / loaders (offline) | Batch A + domain packs | `tests/batch-a-model-wire.offline.test.ts`, `tests/domain-packs.offline.test.ts`, … | `npx vitest run tests/<file>.offline.test.ts` | No (no apply) | No |
| **LIVE_MODEL** | `docs/qa/phase-4-corpus.json` | `tests/model-eval.live.test.ts` | `MODEL_EVAL_LIVE=1 npm run test:model-eval -w backend` | No | **Yes** — `MODEL_EVAL_LIVE=1` + `OPENAI_API_KEY` |
| **LIVE_MODEL_MT** | `docs/qa/phase-4-multi-turn-corpus.json` | `tests/model-eval-multi-turn.live.test.ts` | `MODEL_EVAL_LIVE=1 npm run test:model-eval-mt -w backend` | No | **Yes** — same |
| **LIVE_FULL** | `docs/qa/live-full-corpus.json` | `tests/model-eval-full.live.test.ts` | `MODEL_EVAL_FULL_LIVE=1 MODEL_EVAL_LIVE=1 npm run test:model-eval-full -w backend` | **Yes** | **Yes** — `MODEL_EVAL_FULL_LIVE=1` (+ `OPENAI_API_KEY`) |

Optional LIVE filters (all three LIVE runners): `MODEL_EVAL_CASES=id1,id2`, `MODEL_EVAL_TAGS=tag1,tag2` — see [`live-authoring.md`](live-authoring.md) and [`core-eval-pack.md`](core-eval-pack.md).

Author LIVE intents: `npm run add:live-case -w backend -- …` (see [`live-authoring.md`](live-authoring.md)).

**Studio:** Phase A may start LIVE_MODEL / LIVE_MODEL_MT only with `STUDIO_ALLOW_LIVE_MODEL=1`. LIVE_FULL and write tracks are **refused** in Studio until Phase D — see contract.

## Safety checklist (write-capable tracks)

Applies to ENGINE, MODEL_APPLY, and LIVE_FULL (anything that opens Prisma via the eval harness).

1. Set `DATABASE_URL` and `WORKEE_APPROVED_TEST_DATABASE_URL` to the **exact same** postgres URL.
2. Database name must be non-empty and **≠ `workee`** (`assertApprovedEvalDatabaseUrl` in `backend/src/eval/studio-db-guard.ts`). Name containing `test` alone is not approval.
3. Prefer an isolated DB such as `workee_test`; confirm no product API/reminder ticker is pointed at that URL for the run.
4. For LIVE_FULL / any path that could reach WhatsApp or reminder fire: set `WORKEE_DISABLE_WHATSAPP_OUTBOUND=1` and `WORKEE_DISABLE_REMINDER_FIRE=1`. Those flags are enforced by product send/fire code and by Studio’s LIVE_FULL safety probe (`studio-safety.ts`). The CLI LIVE_FULL runner currently **requires** the approved URL match; it does **not** by itself refuse a run when the kill switches are unset — set them before running.
5. Never use production credentials for eval. Do not start LIVE_FULL from Studio in Phase A (server refuses).

## Reports and failure investigation

After a LIVE run, open the matching artifacts under `docs/qa/`:

| Track | Human / UI report |
|-------|-------------------|
| LIVE_MODEL | `phase-4-last-report.md` / `.json` (+ `phase-4-last-eval.json`) |
| LIVE_MODEL_MT | `phase-4-multi-turn-last-report.md` / `.json` |
| LIVE_FULL | `live-full-last-report.md` / `.json` |

1. Read suite header: `score`, `gates.softOk`, `gates.criticalOk`, `gates.criticalFailed`.
2. Soft pass (`passRate ≥ requiredPassRate`, often 0.7) **does not** mean every case passed.
3. For a failing case, use Scenario → Expectation → Observed → Verdict; note turn `failures` vs soft `warnings`.
4. On LIVE_FULL, also check apply / state notes (`appliedViaProduction`, state failures) — details in [`live-authoring.md`](live-authoring.md#diagnosing-live-failures).
5. Current recorded scores and deferred risks: [`test-layer-contract.md`](test-layer-contract.md#qa-infrastructure-phase-closeout-2026-10-22).
