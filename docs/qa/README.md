# Lucy QA — entry point

Start here for ongoing development. Track guarantees, Studio gates, isolation rules, and verification status live in [`test-layer-contract.md`](test-layer-contract.md) — this page does not repeat that contract.

## Authoritative documents

| Doc | Use for |
|-----|---------|
| [`test-layer-contract.md`](test-layer-contract.md) | What each track proves / does not prove; Studio Phase A; DB isolation; prompt provenance; **current closeout status** |
| [`live-authoring.md`](live-authoring.md) | Author LIVE cases; report JSON/MD contract; diagnosing LIVE failures |
| [`core-eval-pack.md`](core-eval-pack.md) | `core-pack` / `freeze-pack` LIVE recipes |
| [`engine-pyramid-coverage.md`](engine-pyramid-coverage.md) | ENGINE case map, and behaviors that sit outside that pack |
| [`batch-a-readme.md`](batch-a-readme.md) | Thin Batch A labels, offline fingerprint/archive |

Evidence artifacts (not status docs): `*-last-report.md` / `.json`. [`unit-test-summary.md`](unit-test-summary.md) is a historical snapshot only.

## Test tracks (Q3)

Every backend test file belongs to exactly one track, by file suffix:

| Track | Files | Config / command | Needs | Scope reported |
|-------|-------|------------------|-------|----------------|
| offline | `*.test.ts`, `*.offline.test.ts` | `npm test -w backend` (default config) | nothing — runs with an unreachable `DATABASE_URL`, so a hidden DB dependency fails | unit / offline |
| db | `*.db.test.ts` | `npm run test:db -w backend` | `.env.live-full-eval` → approved `workee_test` only (run fails, never skips, without it) | DB harness (stub model, production apply) |
| eval-db | `*.eval-db.test.ts` | `npm run test:eval-db -w backend` | locked `.env.live-full-eval` | eval-db harness; `*.live-sendchat.eval-db.test.ts` = production path (real `sendChatMessage`, real model) |
| live | `*.live.test.ts` | `test:model-eval*` / `test:attachment-intent-model` / `test:decision-core-gate` | OpenAI; LIVE_FULL also needs approved `workee_test` | Real model. LIVE_MODEL, LIVE_MODEL_MT, attachment-intent, and decision-core score ACTION constraints and do not apply to Prisma. LIVE_FULL default is `sendChatMessage` on `workee_test`. `MODEL_EVAL_LIVE_FULL_PATH=harness` keeps the older harness apply path. |

`scripts/run-regression.ps1` runs the requested tracks and prints one verdict per suite via `backend/src/scripts/regression-summary.ts`: PASS / FAIL / NOT_RUN (a requested suite that produced no fresh results fails the run). Skips/todos are tolerated only when listed in [`baselines/test-skip-allowlist.json`](baselines/test-skip-allowlist.json). Model-eval suites gate per case against [`baselines/model-eval-baseline.json`](baselines/model-eval-baseline.json) (known-fail / flaky exceptions need reason, measured evidence and a review date). `-Tsc` fails only on TypeScript diagnostics not in [`baselines/tsc-diagnostics.txt`](baselines/tsc-diagnostics.txt) (written only by an explicit `-WriteTscBaseline`).

## Run matrix

Commands run from the **repo root** with `-w backend`, or from `backend/` without the workspace flag. Vitest paths are relative to `backend/`.

| Track | Corpus / suite | Test entry | Command | Approved test DB? | OpenAI / LIVE opt-in? |
|-------|----------------|------------|---------|-------------------|------------------------|
| **ENGINE** (Gate 1) | `docs/qa/regression-suite.json` | `tests/regression-suite.db.test.ts` | `npm run test:db -w backend -- tests/regression-suite.db.test.ts` | **Yes** — harness calls `assertApprovedEvalDatabaseUrl` | No |
| **ENGINE** (workflow) | `docs/qa/workflow-pack-suite.json` | `tests/workflow-pack.db.test.ts` | `npm run test:db -w backend -- tests/workflow-pack.db.test.ts` | **Yes** | No |
| **ENGINE** (gap pack) | `docs/qa/engine-gap-suite.json` | `tests/engine-gap-pack.db.test.ts` | `npm run test:db -w backend -- tests/engine-gap-pack.db.test.ts` | **Yes** | No |
| **MODEL_APPLY** (Batch A) | `docs/qa/batch-a-suite.json` | `tests/batch-a-model-apply.db.test.ts` | `npm run test:db -w backend -- tests/batch-a-model-apply.db.test.ts` | **Yes** | No (stub model) |
| **MODEL_APPLY** (domain packs) | Matching `docs/qa/<name>-pack-suite.json` | `shopping`, `tasks`, `reminder`, `filing`, `event`, `workflow`: `tests/<name>-pack-model-apply.db.test.ts`. Directory file runs only `D-ADD-THEN-RM`, `D-UPD-MT`, `D-CRUD-MT`, `D-DUP-MT`. Show and custom-lists packs have no apply runner (`domain-packs.offline.test.ts` loads them). `custom-list-name-model-apply.db.test.ts` is a separate stub apply for an empty custom name and a named create; it does not run `custom-lists-pack-suite.json`. | `npm run test:db -w backend -- tests/<name>-pack-model-apply.db.test.ts` | **Yes** | No (stub propose, real apply) |
| **MODEL_APPLY** (share) | `docs/qa/share-pack-suite.json` | `tests/share-pack-model-apply.eval-db.test.ts`. Stub propose, real `planTargetedActions` apply, `workee_test`. Skips `sendChatMessage`, dump replacement, WhatsApp, reminder fire, and jobs. | `npm run test:eval-db -w backend -- tests/share-pack-model-apply.eval-db.test.ts` | **Yes** | No (stub) |
| **MODEL** wire / loaders (offline) | Batch A + domain packs | `tests/batch-a-model-wire.offline.test.ts`, `tests/domain-packs.offline.test.ts`, … | `npx vitest run tests/<file>.offline.test.ts` | No (no apply) | No |
| **LIVE_MODEL** | `docs/qa/phase-4-corpus.json` | `tests/model-eval.live.test.ts` | `MODEL_EVAL_LIVE=1 npm run test:model-eval -w backend` | No | **Yes** — `MODEL_EVAL_LIVE=1` + `OPENAI_API_KEY` |
| **LIVE_MODEL_MT** | `docs/qa/phase-4-multi-turn-corpus.json` | `tests/model-eval-multi-turn.live.test.ts` | `MODEL_EVAL_LIVE=1 npm run test:model-eval-mt -w backend` | No | **Yes** — same |
| **LIVE_FULL** | `docs/qa/live-full-corpus.json` | `tests/model-eval-full.live.test.ts` | `MODEL_EVAL_FULL_LIVE=1 MODEL_EVAL_LIVE=1 npm run test:model-eval-full -w backend` | **Yes** | **Yes**. Default path: real model, `sendChatMessage`, production apply and dump replacement, disposable `workee_test` account. The test stubs WhatsApp sends and reminder firing. `MODEL_EVAL_LIVE_FULL_PATH=harness` (or `MODEL_EVAL_LEGACY_CONTEXT=1`) uses harness apply instead. |
| **DECISION_CORE** | Cases tagged `decision-core` in the phase-4 corpora plus attachment-intent | `tests/decision-core-gate.live.test.ts` | `MODEL_EVAL_LIVE=1 npm run test:decision-core-gate -w backend` | No | **Yes**. Real model, no Prisma apply. A full unfiltered run writes `decision-core-last-eval.json`. `MODEL_EVAL_CASES` does not overwrite that artifact. |
| **VOICE** naturalness | Four scenarios in `backend/src/eval/voice-naturalness.ts` | `tests/voice-naturalness.live.test.ts` (working tree, untracked) and `tests/voice-naturalness-normalize.offline.test.ts` (working tree, untracked) | Live, when the working-tree script is present: `VOICE_NATURALNESS_LIVE=1 npm run test:voice-naturalness -w backend`. A/B: `VOICE_NATURALNESS_AB=1`. | **Yes** for the live file | **Yes** for the live file. Real `sendChatMessage`, real model, harness account on `workee_test`, WhatsApp and reminder fire stubbed. Hard gates are an empty reply, a help-closer, and an unexpected save on the personal-update scenario. Repeated wording is reported and does not fail the suite. The offline file checks near-duplicate normalization and two committed prompt texts; it does not call the model. No `voice-naturalness-last-report` is in the tree. The live file does not run unless `VOICE_NATURALNESS_LIVE=1`. On a clean checkout the npm script and the model-eval include for this file are absent; both exist only as uncommitted working-tree edits. |

Optional filters for LIVE_MODEL, LIVE_MODEL_MT, and LIVE_FULL: `MODEL_EVAL_CASES=id1,id2`, `MODEL_EVAL_TAGS=tag1,tag2`. Decision-core accepts `MODEL_EVAL_CASES` and does not rewrite its full-gate artifact when that filter is set. See [`live-authoring.md`](live-authoring.md) and [`core-eval-pack.md`](core-eval-pack.md).

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
5. Historical scores, current evidence, and known failures: [`test-layer-contract.md`](test-layer-contract.md#recorded-results).
