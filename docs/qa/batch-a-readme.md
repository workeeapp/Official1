# Batch A behavioral suite (thin eval)

**Labels (required):** `evalPath: "thin"` · `productionParity: false`

This suite is **not** production `sendChatMessage` parity. It uses `buildLucyModelEvalInstructions` (system + targeting + OPEN_JOBS + short filing lines). Default fixtures match LIVE_FULL shape (`includeMichal: false`) via `buildDefaultEvalFixtures` — not `resolveEvalPrompt` (see [`test-layer-contract.md`](test-layer-contract.md)).

## Tracks (keep separate)

| Track | Decision source | Apply? | Suite |
|-------|-----------------|--------|-------|
| `ENGINE` | `fixtureMetadata` | Yes (Gate 1) | `docs/qa/regression-suite.json` |
| `MODEL` | Model / stub ACTION | No | `docs/qa/batch-a-suite.json` |
| `MODEL_APPLY` | Model / stub ACTION | Yes → reinject | same Batch A suite |

## Held-out (D12)

Held-out cases are **not** authored or run in Batch A. The loader refuses any path/basename containing `held-out` / `held-out-sealed.json`, and rejects cases with `heldOut: true`.

## Offline commands (verified in repo)

From `backend/` (no OpenAI). There is **no** `test:batch-a-live` (or similar) script in `backend/package.json`.

```bash
# Fingerprints + immutable archive API (synthetic temp dirs in tests)
npx vitest run tests/batch-a-fingerprint.test.ts

# MODEL wire + fingerprint summary (offline stubs)
npx vitest run tests/batch-a-model-wire.offline.test.ts

# Thin instructions ↔ LIVE_FULL fixture parity
npx vitest run tests/batch-a-prompt-align.offline.test.ts

# MODEL_APPLY stub → production apply (requires approved test DB URL pair)
npx vitest run tests/batch-a-model-apply.offline.test.ts

# Suite loader / held-out refusals
npx vitest run tests/batch-a-suite.loader.test.ts
```

## Baseline archival workflow (code-supported only)

`writeBaselineArchive` in `backend/src/eval/archive-baseline.ts`:

- Default directory: `docs/qa/baselines/`.
- Default filename pattern: `batch-a-<iso>-<instructionsSha256-12>.json`.
- Payload must carry a fingerprint with `evalPath: "thin"` and `productionParity: false` (enforced on write).
- **Immutable:** refuses to overwrite an existing path (`BaselineArchiveExistsError`).

Offline tests exercise this API with **synthetic** payloads under temp directories (see `batch-a-fingerprint.test.ts`, `batch-a-model-wire.offline.test.ts`). Those tests are **not** an approval of a LIVE Batch A baseline.

There is no npm script that archives a LIVE Batch A run. Calling `writeBaselineArchive` (or committing a file under `docs/qa/baselines/`) is a deliberate operator action — not automatic approval.

## MODEL_APPLY database safety

Requires `DATABASE_URL` to exactly match `WORKEE_APPROVED_TEST_DATABASE_URL` before any Prisma use (`assertApprovedEvalDatabaseUrl`). Gate 1 ENGINE behavior is unchanged.
