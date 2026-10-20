# Batch A behavioral suite (thin eval)

**Labels (required):** `evalPath: "thin"` · `productionParity: false`

This suite is **not** production `sendChatMessage` parity. It uses `buildLucyModelEvalInstructions` (system + targeting + OPEN_JOBS + short filing lines).

## Tracks (keep separate)

| Track | Decision source | Apply? | Suite |
|-------|-----------------|--------|-------|
| `ENGINE` | `fixtureMetadata` | Yes (Gate 1) | `docs/qa/regression-suite.json` |
| `MODEL` | Model / stub ACTION | No | `docs/qa/batch-a-suite.json` |
| `MODEL_APPLY` | Model / stub ACTION | Yes → reinject | same Batch A suite |

## Held-out (D12)

Held-out cases are **not** authored or run in Batch A. The loader refuses any path/basename containing `held-out` / `held-out-sealed.json`, and rejects cases with `heldOut: true`.

## Offline vs LIVE

- Offline: fingerprints, loader, stubbed MODEL_APPLY apply+reinject — no OpenAI.
- LIVE baseline: separate explicit approval (`npm run test:batch-a-live` when authorized). Archives under `docs/qa/baselines/` are immutable (never overwrite).

## MODEL_APPLY database safety

Requires `DATABASE_URL` to exactly match `WORKEE_APPROVED_TEST_DATABASE_URL` before any Prisma use. Gate 1 ENGINE behavior is unchanged.
