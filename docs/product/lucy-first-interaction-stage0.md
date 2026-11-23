# First Interaction — Stage 0 (truth alignment)

Status: documented for Stage 1 implementation. No code behavior change in this file.

## Production: `prospectOnboarding.enabled` is false

In the live chat path (`chat.service` → `resolveAndRecordTipsForTurn`), prospect onboarding auto-pick is hardcoded off:

```ts
prospectOnboarding: { enabled: false, inboundTurnCount: 1 }
```

Consequences:

- `prospect_onboard_*` tip keys are **not** auto-selected on inbound turns 1/3 in production.
- Capability tips still run through PIE arbitration with `requireNextStep: true`.
- Enabling the old onboard catalog is **out of scope** for First Interaction Stage 1.

## E2E ≠ production path

`backend/tests/wave1-guest-onboarding-tips-e2e.eval-db.test.ts` (and its header comments) still describe a PLG flow where onboard tips fire on turns **1 and 3**. That suite exercises tip-catalog / TipProgress behavior when onboarding pick is effectively in play for the test’s expectations.

That is **not** a faithful mirror of the current production wire, where `prospectOnboarding.enabled === false`. Treat that E2E as historical / catalog regression coverage, not as the SoT for First Interaction or live Prospect first turns.

## Stage B WIP (do not stage / do not revert)

Uncommitted Stage B tip/PIE work (tip copy «רוצה ש…?», `tipTextHasNextStep` gates, tip-catalog / tips.service edits, related tests) stays in the working tree **untouched** by Stage 1. First Interaction must not rewrite the tip catalog or prompts.

## Stage 1 boundary (reminder)

- FI skeleton inside existing PIE (`InteractionOpportunity` + arbitration).
- Kinds: `fi_invite_act` | `fi_first_try` | `fi_member_first_save`.
- No LLM.action schema change, no P2 migration, no Stage 2/3, no security-commit edits, no commit/push/deploy.
