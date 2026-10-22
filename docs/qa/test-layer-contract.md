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

Selecting Lucy2 (or any worker) in the Chat UI **does not** change eval prompt source. Studio run records store `promptSource` + `promptHash` (hash of systemMessage only; no secrets).

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
