# M1–M3 implementation plan (locked)

**Later (P0 / P2a / P1):** `lucy-high-risk-gate-p0-p1-status.md` — clarifyBind not active on WA/UI; `gateInstructionText` is channel-cleaned EIS not provenance; FP-2/FP-3 are known UX limits; PI-2 and PI-7 remain open.

**Status:** Implementation in progress — **stages 1–5 landed**  
**Spec:** `lucy-prompt-injection-m1m3-closure.md` (2026-11-18 final+)  
**S8 decision:** **Option A** (2026-11-18)

---

## S8 — Option A (locked)

1. Build and test a **minimal** pending-invite path:
   - Present pending invite to the user (restore real presentation; today’s `loadPresentedCollabInvites` returns `[]`).
   - Server-issued opaque Accept / Decline commands (PendingConfirm or sibling V binding — **not** model `collab_invite` / invite id alone).
   - Accept V → existing `confirmCollabInvite`.
   - Decline V → existing `cancelCollabInvite`.
2. **Only after** that path is green in side-effect tests: **atomically** disable `applyPendingCollabInvites` auto-apply.
3. No window where invites are neither auto-applied nor presentable/confirmable.
4. **Not** Wave 1: no ConsentStage, no product-scope expansion.

**Cutover (5b):** `applyPendingCollabInvites` is a no-op; `collabInviteAckRequired()` defaults on. Eval pack: `collab-invite-ack.eval-db.test.ts`.

---

## Stage order (revised)

| Stage | Work | Done when |
|-------|------|-----------|
| **1** | Schema `PendingHighRiskConfirm` + `DeliveryAttempt`; Gate / PendingConfirm / DeliveryAttempt modules | ✅ |
| **2** | Gate strip before CORE + honest reply (no false success); bypass documented | ✅ eval-db side effects + reply asserts |
| **3** | PendingConfirm offer + Class V ingest + CORE execute (authorized snapshot) | ✅ V share apply + replay consumed |
| **4** | DeliveryAttempt ledger on confirm relays/phones | ✅ helpers + wired on confirm path (O11 ledger still later) |
| **5a** | S8 minimal present + opaque Accept/Decline → confirm/cancel | ✅ `collab-invite-ack.eval-db` 6/6 |
| **5b** | **Atomic cutover:** disable `applyPendingCollabInvites` with 5a | ✅ no-op + ack default on |
| **6** | Legacy foreign clock suppress + create auth marker; reminder failed≠unknown | Fire tests |
| **7** | Full O/S/M regression pack | Poison + controls |

**Out of scope:** Wave 1 ConsentStage/Usage/Billing, CORE/ACTION semantic change, wide refactor.

---

## Stage 1–2 constraints (active)

- CORE/ACTION semantics unchanged.
- PendingConfirm is approval of a staged plan, not an alternate executor (execute path deferred to stage 3; stage 1 only scaffolds).
- Gate strip-only will false-deny free-form high-risk until stage 3 — accepted interim.
- Do not disable auto-apply in stages 1–2.

---

*Plan updated for Option A before coding stages 1–2.*
