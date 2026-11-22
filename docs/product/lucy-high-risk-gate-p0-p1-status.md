# HighRisk Gate — P0 / P2a / P1 status (architecture lock)

**Date:** 2026-11-23
**Scope:** Documentation closure after P2a (EIS channel) + P1 clarifyBind infrastructure.
**Constraint:** No behavior change in this document. Class V / P0 baseline lock unchanged here.

Related code (read-only pointers):

- Gate: `backend/src/services/high-risk-action-gate.ts`
- EIS channel (P2a): `backend/src/services/high-risk-instruction-channel.ts`
- ClarifyBind (P1): `backend/src/services/clarify-bind.service.ts`
- Wiring: `backend/src/services/chat.service.ts`, `whatsapp.service.ts`
- Corpus: `backend/tests/fixtures/pi-fp-corpus.p0.ts`
- Tests: `backend/tests/pi-fp-corpus.p0.offline.test.ts`, `clarify-bind.p1.offline.test.ts`, `p2a-*.offline.test.ts`

---

## 1. What shipped

| Phase | What | Production effect |
|-------|------|-------------------|
| **P0** | PI/FP corpus + locked Gate mismatches | Measurement only |
| **P2a** | `gateInstructionText` / batch EIS: strip Forward + Contact/Location cards from Gate instruction channel; model still sees full message | Active |
| **P1 infra** | `ClarifyBind` type, raw persist/load, Gate allow hooks for `remind_when` / `delete_scope` within bound scope | **Infrastructure only** |
| **P1 authority** | `bindAuthority: "none" \| "trusted_control"`; create path requires `trusted_control` | **All user channels stay `none` → no bind created** |

---

## 2. clarifyBind is not active on current user channels

- WhatsApp free-text and Web/UI free-text call `tryCreateClarifyBind` with **`bindAuthority: "none"`**.
- Without exact server-set `"trusted_control"`, **no bind is created** and none is persisted for the next turn.
- Existing Gate + **Class V** (`PendingHighRiskConfirm`) behavior for stripped high-risk follow-ups is unchanged from pre-P1.
- The model **cannot** emit or alter `bindAuthority` (never read from ACTION/metadata).

**Do not describe clarifyBind as a live product feature on WA or Web chat today.**

---

## 3. `gateInstructionText` = channel-cleaned EIS, not provenance

`gateInstructionText` (and `batchGateInstructionText` / `gateInstructionTextFromUtterance`) is the **Explicit Instruction Signal (EIS)** channel for HighRiskActionGate:

- Removes Meta-marked **forwarded** / **frequently_forwarded** bodies from EIS (empty contribution).
- Strips shared **Contact/Location** card blocks from EIS.
- Full utterance (including forwards/cards) may still go to the **model** as `message`.

It is **not**:

- Proof the speaker authored the text (paste without Forward metadata is indistinguishable).
- Proof of user intent beyond “text remained after channel cleanup”.
- Sufficient authority to create a `clarifyBind`.

EIS / `awaiting` / `sourceInstructionHash` / dry-Gate are **scope and shape helpers**, never provenance for bind creation.

---

## 4. `trusted_control` = future authority (not issued today)

| Rule | Status |
|------|--------|
| `resolveClarifyBindAuthority` accepts only the exact string `trusted_control` | Implemented |
| Any omit / `none` / forged object / model field → `none` → no bind | Implemented |
| Server issues `trusted_control` on a user path | **Not implemented** |
| Future requirement | Server-minted interactive control (e.g. WA button / UI widget), scope hard-bound to that control; verified server-side |

Until that control exists, production creation stays disabled by design.

---

## 5. FP-2 / FP-3 — known UX limitations (not solved)

| Case | Desired bar | Production today | Corpus Gate-unit |
|------|-------------|------------------|------------------|
| **FP-2** | Follow-up time after remind-other → allow | **No bind** → Gate strip → **Class V** | Synthetic `trusted_control` bind proves Gate *allow path* only |
| **FP-3** | `כן` after multi-delete clarify → allow | **No bind** → Gate strip → **Class V** | Same |

These are **documented UX false-positive friction** against the ideal bar, **not** closed product bugs. Closing them requires a real `trusted_control` channel (or accepting Class V as the permanent UX), not documenting EIS as provenance.

---

## 6. Open findings (locked / deferred)

| Id | Status | Notes |
|----|--------|-------|
| **PI-2** | **Open** (P0 locked mismatch) | Summary/paste envelope with send verb + known target in full utterance; desired strip; Gate may still allow when EIS retains the pasted instruction. P2a does not close unmarked paste. |
| **PI-7** | **Open** (`code_infer`) | Directory phone update not inspected by Gate; desired strip/high-risk; deferred (P3-class), not proven by Gate unit alone. |
| **PI-8** | Closed by P2a | Name-only allow removed. |

Do not treat FP-2/FP-3 corpus “PASS” under synthetic bind as “production UX fixed”.

---

## 7. Test separation (production vs synthetic)

| Suite | What it proves | What it does **not** claim |
|-------|----------------|------------------------------|
| `clarify-bind.p1` → **provenance gate** | WA body / paste / Forward / UI free-text / missing/`none`/forged authority → **no bind** | — |
| `clarify-bind.p1` → **Gate allow with synthetic trusted_control** | If a bind exists, scope is enforced; expansion blocked; unrelated PI still strips | That production creates binds |
| `pi-fp-corpus.p0` | Locked mismatches (`PI-2`); most PI/FP/CONTROL vs Gate | FP-2/FP-3 rows inject **synthetic** `trusted_control` bind for Gate-unit desired-allow only |
| `p2a-*` | EIS assembly / WA→Gate instruction channel | Bind creation |
| `high-risk-action-gate.offline` | Class V / signal Gate without clarifyBind | P1 product UX |

**Rule for readers:** green FP-2/FP-3 in the P0 runner = Gate plumbing with a **test-only** bind, not WA/UI free-text creating bindAuthority.

---

## 8. Explicit non-goals (current lock)

- No O2 / ACP / P2b / P3 in this status.
- No clarification buttons / live `trusted_control` for users yet.
- No Class V protocol change.
- No P0 baseline lock change in this documentation step.
