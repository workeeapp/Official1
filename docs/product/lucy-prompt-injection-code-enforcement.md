# Prompt Injection — code-level enforcement (diagnosis)

**Status:** Diagnosis + recommendation only — **no code / prompt / schema / test changes**  
**Date:** 2026-11-18  
**Parents:** `lucy-prompt-injection-security-review.md`, `lucy-prompt-injection-remediation-plan.md`  
**Product constraint:** Keep existing CORE; thin mediation before apply; do not expand Wave 1 product scope.

---

## 0. Agreement with your reservation

**R1/R2 (prompt + formatting) are risk-reduction only.**  
They do **not** stop a model that emits a malicious ACTION. Enforcement must live in **code on the server**, after ACTION parse and **before** CORE apply — and must not assume the model “obeyed” untrusted-data rules.

Two layers (normative):

| Layer | Role |
|-------|------|
| Prompt / formatting | Shrink how often the model emits bad ACTIONs |
| **Server mediation + ACL** | Decide what actually runs — **source of truth** |

---

## 1. Hard limit: provenance is not reliably knowable

**There is no reliable way, in general, to prove that an ACTION “came from” external content vs the user’s request** using simple text matching on the utterance.

Reasons grounded in this codebase’s UX:

- Hebrew paraphrase, pronouns, «כן», line indices («תמחק את 3»), buttons/commands.  
- Multi-turn: user answers Lucy’s clarify; the authorize signal is not in the poisoned title.  
- Facts and the user message share one user-role blob (`turnInputText`); the server never receives a model-attested “intent source” field.  
- A poisoned title can coincide with a real user delete of that same row.

**Therefore:** Do **not** design “detect instruction origin in content” as the enforcement mechanism.  
Design **risk-tiered, deterministic gates** on (ACTION shape × actor rights × cheap signals from *this turn’s speaker channel*), knowing some PI will still look like a legitimate request.

What we *can* know with certainty in code:

- Whether the **actor is allowed** to touch a resource (existing ACL).  
- What **ACTION classes** were emitted (remove, update, messages, share targets, …).  
- What appeared in the **speaker message / button command** this turn (raw string, strip prefix).  
- What ids were **in this turn’s injected snapshot** (visible refs) — already used by dump guards.

What stays model-dependent:

- Whether the model emits an ACTION at all.  
- Whether a single-item mutate that *looks* user-authorized was “really” intended.  
- Full semantic understanding of the utterance.

---

## 2. Where a thin gate fits (no new conversation engine)

Existing precedent: `stripShowTurnMutates`, dump grounding / intent gates in `sendChatMessage` — mutate stripping **after** parse, **before** `planTargetedActions` / `applyEmployeeRecords`.

```text
parseReplyMetadata / validate shape
  → existing strips / dump guards
  → ★ HighRiskActionGate (new thin mediation — proposed) ★
  → planTargetedActions → apply* (unchanged CORE semantics)
```

- Same ACTION schema.  
- Same apply functions.  
- Gate **strips or refuses** selected planned ops; may append a short engine notice (“לא ביצעתי …”).  
- Does **not** reimplement lists/filing/reminders.

Same placement family as future ProspectWriteGate: **authorization before CORE**, not a parallel Lucy.

---

## 3. Risk tiers — what needs stronger protection

| Tier | Examples | PI impact if model complies | Natural UX constraint |
|------|----------|-----------------------------|------------------------|
| **T0 — already enforced** | Mutate private foreign row; attach other user’s file; wrong-phone collab | Blocked by ACL / tenancy | No change |
| **T1 — high cross-user / blast** | `messages` / phone relays to others; new share/assign targets; deferred collab invite create; whole-list `delete_list`; multi-id mass `remove` | Outbound spam, data shared out, mass delete | Must stay easy when user **clearly** asked |
| **T2 — shared co-mutate** | `update`/`remove` on rows where actor ≠ owner but in `visibleTo` | Partner edits via poisoned shared text | “תמחק את 3” / named item must still work |
| **T3 — own-book single mutate** | Personal add/update/remove one row | Self-harm to own data | Highest volume of normal Lucy use — **do not** add confirm-every-action |
| **T4 — read-only** | `show_dump`, Q&A | Disclosure only of already-visible facts | Leave open |

**Stronger code protection should focus on T1 and (carefully) T2.**  
T3 cannot be fully “proven user-intent” without hurting natural use; accept residual risk + prompt reduction + tests.

---

## 4. What code can enforce with certainty

### 4.1 Keep (already solid)

- `humanItemAccessAllowed` / `workerTaskAccess` / `ShareApplyMiss`  
- Attachment `userId` scope  
- Invite phone bind  
- Id-required remove/update  

**ACL ≠ anti-PI**, but it caps blast radius to “what this actor could do anyway.”

### 4.2 Deterministic HighRiskActionGate policies (proposed — enforceable)

These do **not** claim to detect “instruction origin.” They require a **speaker-channel allow signal** for dangerous shapes, or they strip the op.

| Policy | Trigger (ACTION) | Allow only if (examples of cheap signals) | Else |
|--------|------------------|-------------------------------------------|------|
| **P-Out** | Any `messages` / scheduled send / phone relay to **others** | Recipient label/phone appears in speaker message **or** is an explicit button command target; or clear send/check verb family in message (conservative lexicon / existing helpers if any) | Strip messages; no WhatsApp fan-out |
| **P-Share** | Lists/filing updates that **add** partners / `visibleTo` expansion / deferred collab create | Partner name/phone in speaker message **or** explicit share wording + resolvable target | Strip share/collab fan-out |
| **P-Mass** | `delete_list`, or remove with **≥2** item ids in one turn, or “clear all” shaped ops | Delete/clear lexicon in speaker message **or** numbered multi-select the user typed | Strip mass delete |
| **P-SharedSingle** (optional, milder) | Single remove/update on **shared** row (actor ≠ owner) | Item referenced via dump line / id from LAST_NUMBERED_DUMP / title token overlap with speaker message / explicit delete|edit verb | Strip that mutate; ask or no-op |

**Important:** Lexicons and “name appears in message” are **incomplete** (false deny / false allow). They are **risk reducers with tests**, not mathematical intent proofs. Document false-deny UX: Lucy may ask “רצית שאמחק/אשלח?” instead of silent apply — **only** for gated tiers, not for every T3 add.

### 4.3 What we explicitly cannot enforce today

| Claim | Reality |
|-------|---------|
| “Block ACTION because it was caused by a poisoned title” | **Not reliably detectable** |
| “Allow only if model is honest about intent” | Model-dependent |
| “Confirm every mutate” | Violates natural Lucy (your constraint) |

---

## 5. Preserving natural behavior

| Keep frictionless | Gate / ask |
|-------------------|------------|
| Show dumps, inventory, Q&A | — |
| Normal personal add (“תוסיפי חלב”) | No extra confirm |
| Single personal delete/edit with clear ask | No extra confirm |
| “תמחק את 3” after numbered dump | Allow via dump-line / LAST_NUMBERED_DUMP bind (existing grounding) |
| Explicit “שלחי למיכל ש…” | Allow if target+send signal present |
| Explicit “שתפי עם דני” | Allow if partner+share signal present |

| Add friction only when | Mechanism |
|------------------------|-----------|
| Model emits outbound/share/mass-delete **without** speaker-channel signal | Strip + short clarify (not a second permission system) |
| Shared-row mutate with **no** reference signal (optional P-SharedSingle) | Strip + one ask |

This mirrors existing product patterns (DELETE CLARIFY, soft offers) rather than a new engine.

---

## 6. Minimal fix that still matters (recommended package)

Ordered by security value / CORE safety:

| Step | What | Enforced in code? | CORE change? |
|------|------|-------------------|--------------|
| **M1** | Keep ACL + add regression tests (foreign id, attachment tenancy) | Yes | **No** |
| **M2** | **HighRiskActionGate** before apply: **P-Out + P-Share + P-Mass** | Yes (strip) | **No** — chat mediation only |
| **M3** | Tests: poisoned shared title + inventory ask → **no** messages/share/mass-delete applied; explicit user send/share/delete still applies | Yes | **No** |
| **M4** | Optional later: **P-SharedSingle** if M2 insufficient in eval | Yes | **No** |
| **M5** | Prompt/formatting untrusted banners | Reduction only | **No** |

**Do not ship M5 as the “fix.”** Ship **M1–M3** as the meaningful security improvement.

**R4 (global id resolve):** Still **out** — no ACL bypass proven; not required for this package.

---

## 7. CORE changes required?

| Change | Needed? | Why |
|--------|---------|-----|
| New list/filing/reminder engines | **No** | Gate strips metadata before existing apply |
| Change Share co-mutate semantics (D9) | **No** | PI defense ≠ view-only Share |
| Change ACTION JSON schema | **No** | Same actions; fewer reach apply |
| Touch `planTargetedActions` internals | **Prefer no** | Strip upstream in `sendChatMessage` |
| Prompt-only “fix” | **Insufficient** | Per your reservation |

If a future test proves ACL bypass via id resolve, escalate R4 separately under D0 — not part of this minimal package.

---

## 8. Answers to your four questions

1. **Detect actions caused by external instructions?**  
   **Not reliably.** Enforce **risk-tiered allow-signals** on high-impact ACTIONs instead of provenance detection.

2. **Thin mediation before CORE?**  
   **Yes** — same seam as `stripShowTurnMutates` / dump guards / planned ProspectWriteGate. No new conversation or ACTION engine.

3. **Which actions need stronger protection?**  
   **Outbound messages, new sharing/assign fan-out, mass/whole-list delete** first; then optionally **shared-row single mutates**. Personal single-item flows stay natural.

4. **Keep natural Lucy?**  
   **Yes**, by gating only high-risk shapes lacking speaker-channel signals — not confirming every normal action.

---

## 9. Certainty summary

| Enforceable with certainty in code | Remains model-dependent |
|------------------------------------|-------------------------|
| Actor must pass ACL for the resource | Whether PI successfully elicits an ACTION |
| High-risk ACTION absent speaker allow-signal → do not apply | Perfect intent attribution |
| No cross-tenant attachment use | Single personal mutate that “looks” requested |
| Tests can lock “inventory ask + poison → no outbound/share/mass-delete” | Zero false denies on creative Hebrew |

---

## 10. Relation to Wave 1

- This package is a **security slice**, not a Wave 1 feature expansion.  
- Invite presenters should eventually feed the same HighRiskActionGate (outbound/share still gated).  
- ProspectWriteGate (permissions) and HighRiskActionGate (PI blast on allowed actors) are **different concerns** — both pre-CORE, both thin.

---

## 11. Approval ask (still no coding)

Approve **M1–M3** (ACL tests + HighRiskActionGate for Out/Share/Mass + apply-level PI tests) as the minimal meaningful code enforcement path.  
Treat prompt/formatting as optional accompaniment only.

---

*End of diagnosis. No implementation performed.*
