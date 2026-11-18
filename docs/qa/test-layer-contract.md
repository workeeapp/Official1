# Test layer contract and approval matrix

Source-of-truth corpora stay committed under `docs/qa/`. Studio drafts under `docs/qa/studio/drafts/` are **not** CI until explicit promote (`confirmPromote: true`).

## Track contract

| Track | Real model? | Executes apply? | Persistent DB write? | External side effects | What it proves | What it does not prove |
|-------|-------------|-----------------|----------------------|----------------------|----------------|------------------------|
| **ENGINE** | No (fixture ACTION) | Yes (production apply) | Yes (harness, gated) | None intended | Fixture → apply → stateAfter / facts | NL understanding; Lucy2 UI prompt |
| **MODEL_APPLY** | Stub offline; live only via FULL | Yes | Yes (harness, gated) | Clocks in DB if applied | ACTION → apply → reinject | Live model quality when stubbed; full `sendChatMessage` |
| **LIVE_MODEL** | Yes | No | No | OpenAI spend | ACTION vs authored constraints | Engine apply, DB, WA, dump REPLACE, Lucy2 DB prompt |
| **LIVE_MODEL_MT** | Yes | In-memory snapshot only | No | OpenAI spend | Multi-turn ACTION + snapshot continuity | Production chat pipeline; Prisma |
| **LIVE_FULL** default | Yes | Yes, inside `sendChatMessage` | Yes, disposable `workee_test` account | OpenAI. The suite stubs WhatsApp sends and reminder firing | Model decision, production apply, reply overrides, dump replacement, buttons, and persisted state | A message accepted by WhatsApp Graph; the process that serves the product |
| **LIVE_FULL** harness | Yes | Yes, harness apply | Yes, same gated DB | Same stubs | Model decision plus harness apply and `stateAfter`. Used when `MODEL_EVAL_LIVE_FULL_PATH=harness` or `MODEL_EVAL_LEGACY_CONTEXT=1` | `sendChatMessage`, dump replacement, and `buildLucyInstructions` |

## Identity and prompt provenance

| Track | User / account | Speaker employee | Digital worker / prompt |
|-------|----------------|------------------|-------------------------|
| LIVE_MODEL / MT | No DB user (`userId: null`) | Fixture `eval-human-1` (name from corpus, usually טל) | Fixture `eval-lucy-1`, `instructions: null` → **`LLM.config.json` systemMessage** via `loadLlmConfig`. Not Lucy2 / `Employees.instructions`. |
| LIVE_FULL default | Disposable harness account on approved `workee_test` | New harness human | `sendChatMessage` → `buildLucyInstructions` for that account's digital worker. Each turn records `instructionsSha256` of the instructions string actually sent |
| LIVE_FULL harness | Same disposable account | Same | Fixture worker through `resolveEvalPrompt` (table below). This is the comparison path, not the default |
| ENGINE / MODEL_APPLY | Disposable harness `g1_*` (when allowed) | New harness human UUID | Fixture ACTION or stub propose. No model call on ENGINE. MODEL_APPLY does not call `sendChatMessage` |

Selecting Lucy2 (or any worker) in the Chat UI **does not** change eval prompt source.

### Prompt identity fields

- **`promptHash`** (legacy): first 16 hex chars of SHA-256 of `LLM.config.json`’s `systemMessage` (via `loadLlmConfig`). Identifies the file system message only — **not** the final model instructions string. No secrets.
- **`instructionsSha256`**: SHA-256 of the **final** instructions string passed to the model (after fixture employees + envelope composition). This is the identity to compare across runs when asking “which prompt was scored?”

Studio run records keep legacy `promptHash` and, after a completed LIVE run, merge `instructionsSha256` (and related fields) from the runner’s `summary.prompt`.

### `WORKEE_EVAL_PROMPT_SOURCE` (LIVE runners via `resolveEvalPrompt`)

| Value | Behavior |
|-------|----------|
| unset / `config` | Harness / `resolveEvalPrompt` path: fixture worker + `LLM.config.json` systemMessage through the Lucy eval instruction builder. The default LIVE_FULL runner does not use this switch; it calls `buildLucyInstructions` |
| `file` | Load instructions from `WORKEE_EVAL_INSTRUCTIONS_FILE` into an in-memory worker fixture |
| `employee` | Load a digital employee row from the **approved** test DB only (`WORKEE_EVAL_DIGITAL_EMPLOYEE_ID`); fails closed before Prisma if the URL is unapproved |

**Batch A** builds thin instructions with `buildDefaultEvalFixtures(..., { includeMichal: false })` and **does not** call `resolveEvalPrompt`. Setting `file` or `employee` therefore **must not** change Batch A fingerprints or offline MODEL scoring.

## Studio Phase A approval matrix

| Action | Allowed in Studio Phase A? | Server gate |
|--------|----------------------------|-------------|
| Browse tracks / safety / cases / runs | Yes (`requireAuth`) | Read-only |
| Start LIVE_MODEL / LIVE_MODEL_MT | Only if `STUDIO_ALLOW_LIVE_MODEL=1` (+ OpenAI key) | `assertStudioTrackRunnable` |
| Start LIVE_FULL | **No** | Refused even if isolation env looks green |
| Start ENGINE / MODEL_APPLY | **No** (no routes) | N/A |
| Promote draft to corpus | Yes with `confirmPromote: true` | File write to approved corpus; refuses duplicate ids |

Write-capable tracks remain blocked until Phase D: approved isolated DB (exact URL match, name ≠ `workee`), WA outbound disabled, reminder fire disabled, and explicit FULL opt-in.

## Isolation (write tracks)

Not established by: database name containing `test`, port number, development mode, or test account alone.

Required: `DATABASE_URL` exact-equals `WORKEE_APPROVED_TEST_DATABASE_URL`, valid postgres URL, nonempty DB name ≠ `workee`, plus outbound/reminder disables for FULL.

## Historical note (out of scope for Studio Phase A)

A 2026-10-20 LIVE_FULL run performed production-style apply; product DB `workee` is inferred. Leftover harness rows are unresolved. No cleanup in Phase A.

## Recorded results

The QA infrastructure phase closed on 2026-10-22. Scores below are evidence that is actually in the tree. A gitignored `*-last-report` file that is not present is not a current result.

### Historical

| When | What is on disk | How to read it |
|------|-----------------|----------------|
| 2026-10-20 | Narrative only. The report files were overwritten | Header **6/27** meant 6 passed out of 27. It is an older corpus |
| 2026-10-21 | [`unit-test-summary.md`](unit-test-summary.md) | Snapshot of one unit run. It is not current status |
| 2026-10-22 | [`live-full-baseline-32-console.txt`](live-full-baseline-32-console.txt) | LIVE_FULL **22 passed / 32**, pass rate 0.69. Critical failures: `full-filing-add-simple`, `full-share-shop-with-amit`, `full-mt-event-clarify-then-link`, `full-mt-multi-add-then-buy`, `full-mt-complex-personal-vs-shared`, `full-mt-share-ask-then-partner`. `phase-4-last-report.*` and `live-full-last-report.*` are gitignored and are not in the tree |
| 2026-10-24 | [`decision-core-last-eval.json`](decision-core-last-eval.json) | Decision-core gate **30 passed / 30**. Real model, `productionApply: false`. [`decision-core-p0-report.md`](decision-core-p0-report.md) and [`decision-core-p1-report.md`](decision-core-p1-report.md) describe that gate. This is not a LIVE_FULL score |

### Current evidence

[`baselines/model-eval-baseline.json`](baselines/model-eval-baseline.json) holds per-case expectations taken from measured runs on 2026-11-06 and 2026-11-07. It is the regression gate. It is not a stored score of the current checkout.

Known failures, review by 2026-12-07, all from the 40-minute conversation rotation (the same-conversation controls are expected to pass):

- `c-automated-chat-message-after-rotation`
- `c-declined-offer-after-rotation` (measured on the production path, 2026-11-07, 4/4 re-offered)
- `c-open-offer-after-rotation`

Flaky: `so-household-share-offer`, at least 2 of 3 passes, review by 2026-12-07. Evidence in the baseline is 9/10 with production context and 6/10 with the legacy context on 2026-11-06.

[`live-full-stability.md`](live-full-stability.md) (2026-11-10) is a production-path stability run of two cases, three times each: `p3-standing-delete-asks-task-or-clock` and `p3-one-occurrence-or-series-asks`, **6/6**. It is not a corpus run.

No full-corpus LIVE_FULL report for the current tree is in `docs/qa/`.

### What specific suites exercise

**Directory.** ENGINE does not apply `metadata.directory`. `directory-pack-model-apply.db.test.ts` is a stub propose and real apply on `workee_test` for four cases: `D-ADD-THEN-RM`, `D-UPD-MT`, `D-CRUD-MT`, `D-DUP-MT`. The other directory-pack contracts have no apply runner and this file does not call the model. `directory-pack-suite.json` is marked `productionParity: false`.

**Reminder one-shot delivery.** `reminder-oneshot-delivery.offline.test.ts` calls production `fireDueReminders` with an in-memory Prisma and a mocked WhatsApp send. It covers a successful send that is not repeated, a failure that stays active and is retried, an already-accepted send that is not sent again, a second send when acceptance was not saved, and a clock that was already due at startup. `reminder-oneshot-delivery.eval-db.test.ts` calls `settleFiredReminder` on a real `workee_test` row and does not call WhatsApp or scan other due clocks. `reminder-fire.test.ts` covers the same settle rules with a mocked clock store, including the compose-failure path that still closes a one-shot. None of these tests deliver a WhatsApp message.

**Lucy database prompt.** `protected-lucy-db-prompt.live-sendchat.eval-db.test.ts` creates a disposable protected לוסי, writes the current `LLM.config.json` system message into `Employees.instructions`, and refuses the turn unless that row's SHA-256 is the expected file hash. Five `sendChatMessage` turns then use the real model on `workee_test`, with WhatsApp and reminder firing stubbed: a casual mention leaves the poker list unchanged, an explicit change updates one row, a spoken fact updates one filing, a new fact creates one filing, and an ambiguous filing asks and saves nothing. The pre-existing `workee_test` Lucy row is not the worker under test. This does not prove that a long-lived product row matches the file.

**Voice.** The naturalness source and tests are in the working tree and are untracked. The npm script and the model-eval include are uncommitted, so a clean checkout does not run them. The live suite is real `sendChatMessage` on `workee_test` with a stubbed WhatsApp send. See the run matrix in [`README.md`](README.md). No live voice report is in the tree.

### Still open

- Show pack and custom-lists pack have no apply runner. `show-button-dump.test.ts` checks dump formatters with fixtures and no model. Default LIVE_FULL does run production dump replacement when a turn emits `show_dump`; that is not a dedicated dump-replacement suite.
- `jobs.test.ts` mocks Prisma. Jobs and handoff have no production-path suite.
- WhatsApp Graph delivery is stubbed in the live and eval-db suites.
- LLM Judge and evaluation-cost tracking.
- Studio Phase A still refuses LIVE_FULL. Phase D is not started.
