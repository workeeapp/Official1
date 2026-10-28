# Test layer contract and approval matrix

Source-of-truth corpora stay committed under `docs/qa/`. Studio drafts under `docs/qa/studio/drafts/` are **not** CI until explicit promote (`confirmPromote: true`).

## Track contract

| Track | Real model? | Executes apply? | Persistent DB write? | External side effects | What it proves | What it does not prove |
|-------|-------------|-----------------|----------------------|----------------------|----------------|------------------------|
| **ENGINE** | No (fixture ACTION) | Yes (production apply) | Yes (harness, gated) | None intended | Fixture → apply → stateAfter / facts | NL understanding; Lucy2 UI prompt |
| **MODEL_APPLY** | Stub offline; live only via FULL | Yes | Yes (harness, gated) | Clocks in DB if applied | ACTION → apply → reinject | Live model quality when stubbed; full `sendChatMessage` |
| **LIVE_MODEL** | Yes | No | No | OpenAI spend | ACTION vs authored constraints | Engine apply, DB, WA, dump REPLACE, Lucy2 DB prompt |
| **LIVE_MODEL_MT** | Yes | In-memory snapshot only | No | OpenAI spend | Multi-turn ACTION + snapshot continuity | Production chat pipeline; Prisma |
| **LIVE_FULL** | Yes | Yes | Yes (harness, gated) | OpenAI; WA only if outbound enabled | Model + apply + stateAfter on isolated DB | Full Chat dump-replace; WA delivery when disabled |

## Identity and prompt provenance

| Track | User / account | Speaker employee | Digital worker / prompt |
|-------|----------------|------------------|-------------------------|
| LIVE_MODEL / MT | No DB user (`userId: null`) | Fixture `eval-human-1` (name from corpus, usually טל) | Fixture `eval-lucy-1`, `instructions: null` → **`LLM.config.json` systemMessage** via `loadLlmConfig`. Not Lucy2 / `Employees.instructions`. |
| LIVE_FULL / ENGINE / MODEL_APPLY | Disposable harness `g1_*` (when allowed) | New harness human UUID | LLM path same fixture for LIVE_FULL; ENGINE uses fixtures only |

Selecting Lucy2 (or any worker) in the Chat UI **does not** change eval prompt source.

### Prompt identity fields

- **`promptHash`** (legacy): first 16 hex chars of SHA-256 of `LLM.config.json`’s `systemMessage` (via `loadLlmConfig`). Identifies the file system message only — **not** the final model instructions string. No secrets.
- **`instructionsSha256`**: SHA-256 of the **final** instructions string passed to the model (after fixture employees + envelope composition). This is the identity to compare across runs when asking “which prompt was scored?”

Studio run records keep legacy `promptHash` and, after a completed LIVE run, merge `instructionsSha256` (and related fields) from the runner’s `summary.prompt`.

### `WORKEE_EVAL_PROMPT_SOURCE` (LIVE runners via `resolveEvalPrompt`)

| Value | Behavior |
|-------|----------|
| unset / `config` | Default LIVE path: fixture worker + `LLM.config.json` systemMessage through the Lucy eval instruction builder |
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

## QA Infrastructure Phase Closeout (2026-10-22)

The QA infrastructure implementation phase is **closed**. Further infrastructure work should be driven only by concrete gaps discovered during ongoing use—not by expanding the harness preemptively.

### Latest recorded LIVE results

| Track | Score | Artifact | Generated |
|-------|-------|----------|-----------|
| LIVE_MODEL | **34/34 PASS** | [`phase-4-last-report.md`](phase-4-last-report.md) / `.json` | 2026-10-22 |
| LIVE_MODEL_MT | **13/13 PASS** | [`phase-4-multi-turn-last-report.md`](phase-4-multi-turn-last-report.md) / `.json` | 2026-10-22 |
| LIVE_FULL | **22/32 FAIL** (passRate 0.69; 10 failed; 6 critical) | [`live-full-last-report.md`](live-full-last-report.md) / `.json` | 2026-10-22 |

**Authoritative on-disk LIVE_FULL** (`live-full-last-report.*` / `live-full-last-eval.json`, `generatedAt=2026-10-22T16:45:29.851Z`): **22 passed / 32 total**, **10 failed**, soft gate fail, criticalFailed=`full-filing-add-simple`, `full-share-shop-with-amit`, `full-mt-event-clarify-then-link`, `full-mt-multi-add-then-buy`, `full-mt-complex-personal-vs-shared`, `full-mt-share-ask-then-partner`. Console twin: [`live-full-baseline-32-console.txt`](live-full-baseline-32-console.txt).

**Historical (superseded on disk, not deleted from narrative):** 2026-10-20 LIVE_FULL report header **6/27** meant **6 passed / 27 total** (21 failed, passRate 0.22) — older corpus size. Report files are gitignored and were overwritten by the 2026-10-22 run; do not treat “6/27 FAIL” as six failures.

LIVE_FULL has **not** been re-run after the 2026-10-28 eval-DB `transcript_status` migration or the remove-by-id / shopping whole-list share triage fixes — re-verify only with approved `workee_test` + kill switches.

### Explicitly deferred

- Re-run LIVE_FULL only when an approved, isolated `workee_test` environment is confirmed safe (`DATABASE_URL` exact-equals `WORKEE_APPROVED_TEST_DATABASE_URL`, outbound/reminder kill switches as required).
- LIVE_ONLY coverage gaps (directory/contacts harness, `show_dump` Chat replace, WA delivery, reminder fire, Lucy2 DB prompt, jobs/handoff): see [`engine-pyramid-coverage.md`](engine-pyramid-coverage.md).
- LLM Judge and evaluation-cost tracking.
- Studio LIVE_FULL / Phase D (Studio Phase A continues to refuse LIVE_FULL).

### Status document note

[`unit-test-summary.md`](unit-test-summary.md) is a **historical snapshot** (2026-10-21). It is **not** the authoritative current QA status; use this contract and the dated `*-last-report.*` artifacts above.
