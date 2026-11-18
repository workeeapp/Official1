# Wave 1 — Distilled implementation plan

**Status:** Working baseline for review — **no coding until you approve this plan for implementation**  
**Updated:** 2026-11-18  
**Locks:** `lucy-wave0-decisions.md` (Approved) · D0: existing CORE unchanged  
**Detail archive (not the working plan):** `lucy-wave1-implementation-plan.md`, `lucy-wave1-spikes-s0-s1-s1b.md`

---

## Goal (only this)

A new person gets a real Lucy invite:

1. Sees the **original invite value**  
2. Can **talk freely** with Lucy  
3. **Joins explicitly** to get full capabilities and save personal data  

Same Lucy system for everyone. Prospect vs Member = **authorization**, not a second product.

---

## Non‑negotiables (from Wave 0)

| Keep | Meaning |
|------|---------|
| One CORE | Conversation, ACTION, validate, apply, Tasks/Lists/Filing/Reminders, Jobs, Share/Assign — **reuse**, don’t rebuild |
| R1 | Early account OK; **Prospect** until **Explicit Join** |
| Name / chat / view ≠ join | D1b copy still Open |
| Share | Prospect: scoped **read** of invited content. Member: existing **co-mutate** CORE |
| Assign | Explicit accept/decline |
| Send | Show content; personal save after Member |
| Invite store | Evolve `WhatsAppInvite` (payload v2) — no parallel invite system |
| TTL / cancel | 14 days lazy expiry; asker can cancel pending |
| Out of Wave 1.0 | Cold Check-with, shell deferred invite, ReferralCampaign, Templates, Household, product view-only Share, soft-try growth |

---

## Must ship vs defer

### A. Must ship (safe basic flow)

| # | Work | Why it’s required |
|---|------|-------------------|
| 1 | Stop auto-applying Share/Assign the same way for everyone | Today `applyPendingCollabInvites` grants full Share/Assign too early |
| 2 | **Prospect:** present invite value (live scoped read); **no** `confirmCollabInvite` / no `visibleTo` yet | Value without Member Share rights |
| 3 | **Member / after join:** Share via existing `confirmCollabInvite` → CORE | Same Share as today |
| 4 | Assign: present → accept/decline → existing confirm/cancel | Responsibility ≠ Share |
| 5 | Send: show in chat; keep history if invite marked consumed; save to Workspace only as Member | No gap between “delivered” and later save |
| 6 | **ProspectWriteGate:** after ACTION validate, before writes — block personal durable saves (lists/filing/reminders/directory/jobs/…) while Prospect | Chat stays open; personal Workspace stays closed |
| 7 | Explicit Join hook (internal signal OK until D1b copy) | Only path Prospect → Member |
| 8 | Honest asker **ממתין** + Lucy-branded drafts by intent | Pending ≠ done |
| 9 | Lazy 14-day expiry + asker cancel of pending invite | Basic lifecycle safety |
| 10 | Deterministic Prospect cost circuit breaker (pre-LLM hard cap on total Prospect messages/LLM spend + disable expensive secondary LLM/live calls while `consentPending = true` + cap concurrent `pending` outbound invites per asker) | Prevents deliberate budget drain without building a full Quota/Billing product (U1) |

### B. Defer (not needed to start)

| Item | Why defer |
|------|-----------|
| Usage Quotas (full dynamic policies, soft warnings) / “Usage plane” product | **U1** — keep deferred; Stage 2 ships only the basic hard circuit breaker (#10), not soft warnings or dynamic quota policies |
| Billing / Quota product | Out of scope (U1); Stage 2 hard circuit breaker is not a Billing product |
| C2 (`visibleTo` for Prospect read) | Prefer live present into context; escalate only if that fails |
| Production-grade cost dashboards | Optional after ConsentStage exists |
| C1-A / C1-M2 edge policy polish | Need a simple choice (below); deep migration design can wait for audit on the real DB |
| Registered closed-session draft polish, shell share, check-with cold, referral, tips growth | Wave 1.1 / 2 / later |
| Long architecture essays / extra named gates | Don’t invent layers beyond invite mediation + write gate |

---

## How it fits in the existing pipeline (no new engines)

```text
Inbound → resolve user (existing)
  → bind invite / expiry (WhatsAppInvite)
  → if Prospect: check deterministic trial circuit breaker (max turns/cost + skip secondary live/tips calls); if exceeded → deterministic join-prompt reply without calling LLM
  → if Prospect Share/Send: inject invite value into same prompt/chat
  → if Assign: present for ack (existing collab metadata)
  → same LLM → same ACTION → same validate
  → if Prospect: block personal durable writes (gate)
  → else: existing CORE apply
  → Explicit Join → Member → then one confirmCollabInvite for pending Share if any
```

| Intent | Prospect | Member |
|--------|----------|--------|
| **Send** | See content in chat; no personal save | May save via normal CORE |
| **Share** | Read invited item/filing only | Existing co-mutate CORE |
| **Assign** | See ask; no row until accept (+ Member rules) | Accept → existing assign CORE |

**Member behavior must not regress.**

---

## Staged build (short)

| Stage | What | Depends on |
|-------|------|------------|
| **0** | Your go-ahead on this distilled plan + C1 decision | — |
| **1** | Invite lifecycle: drafts ממתין, TTL, asker cancel, stop blind auto-apply; Assign present/ack; Share present-only for Prospect | Plan approval |
| **2** | ConsentStage persistence + Explicit Join hook + ProspectWriteGate + Prospect cost circuit breaker (pre-LLM cap + secondary call skip + asker pending-invite cap) | **C1 approved** |
| **3** | After join: one Share `confirmCollabInvite`; Send save via normal CORE; regression packs | Stage 2 |
| **4** | Harden: wrong phone, double-apply, cancel mid-chat, Member Share unchanged | — |

No Stage A coding until Stage 0.

---

## Real blockers (few)

| Blocker | Need from you |
|---------|----------------|
| **This plan** | Approve as the Wave 1 working baseline to code against |
| **C1** | Approve storing ConsentStage (recommendation: on `User`) so Prospect/Member survives across turns |
| **D1b** | Not required to start coding if we use a temporary internal join signal; **required** before user-facing join copy |
| **C1-M2** (existing WhatsApp-only users) | One product choice: grandfather established users as Member **or** require Explicit Join — don’t auto-decide from activity alone |

**Not blockers for starting:** U1 quotas, C2, D2b, full cost framework, Wave 1.1 items.

---

## Decisions you must make before work starts

1. **Approve this distilled plan** for implementation (docs → code).  
2. **C1:** Persist `consentPending` (or equivalent) on **`User`** — yes/no (+ simple migration: new WhatsApp accounts = Prospect; credentialed admin users = your call under C1-A).  
3. **C1-M2:** Grandfather vs re-join for existing heavy WhatsApp users (can be “decide at Stage 2” if Stage 1 is invite-only with no ConsentStage yet — but Stage 2 cannot ship without it).  

Optional later (not for kickoff): D1b copy, D2b, U1 quotas.

---

## Explicitly not in this plan

- Second Prompt / Action / CORE stack  
- Inferior “Prospect Lucy”  
- Changing Share semantics for Members  
- Full U1 numeric trial budgets / soft warnings / Billing (Stage 2 hard circuit breaker only)  
- New product decisions beyond the table above  

---

## Done when

- Invitee can see invite value and chat.  
- Prospect cannot save personal Workspace data.  
- Explicit Join → full Member path; Share uses existing CORE once.  
- Assign needs ack.  
- Asker sees ממתין until real delivery/apply.  
- Member Share/Assign regression tests stay green.

---

*End of distilled Wave 1 plan. No implementation until approval.*
