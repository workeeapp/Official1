# Family invite & share experience — gap findings

**Status:** Findings only — **no code, prompt, schema, or test changes**  
**Updated:** 2026-11-17  
**Context:** Household development is **deferred**. Collaboration for now = independent accounts + Share / Assign (+ message invites where they exist).  
**Household plan:** `lucy-household-implementation-plan.md` kept as future reference only.  
**Evidence base:** working-tree paths below; `lucy-existing-capabilities-gap-audit.md`; Phase 1–2 invite docs; `collab-invite.eval-db.test.ts`.

## How to read

| Label | Meaning |
|-------|---------|
| **Works** | Verified path supports the journey |
| **Implementation gap** | Code/wiring contradicts intended continuity or is incomplete/broken |
| **UX gap** | Mechanism works; user may not understand what happened or what to do |
| **Product decision** | Behavior is ambiguous or policy not locked |
| **Out of scope** | Household / Team rewrite / billing — not this track |

---

## 0. Decision recorded

- Do **not** implement Household now.  
- Do **not** change Team or schema for household.  
- Keep household plan as reference.  
- Focus: end-to-end family **invite + share/assign** on existing engines.

---

## 1. Journey map (verified now)

### 1.1 New user invites someone not yet on Lucy (item share / assign)

```text
Asker (has contact + phone)
  → Lucy emits share/assign with targets
  → partitionDeferredCollabTargets  (employee-targets.service.ts)
  → createDeferredCollabInvites     (collab-invite.service.ts)
  → WhatsAppInvite + payload (share|assign)
  → Asker gets wa.me draft to forward   (whatsapp-invite.service.ts)

Invitee first WhatsApp to business
  → createIndependentWhatsAppAccount  (whatsapp.service.ts)  // own User + Lucy
  → bindInboundToInvite               // no userId move
  → sendChatMessage
  → applyPendingCollabInvites         // AUTO-applies on first turn
  → share: row on asker, invitee in visibleTo
    assign: row on invitee, addedById = asker
```

**Works:** independent account; deferred item share/assign; apply without host-seat; no Household needed.  
**Tests:** `backend/tests/collab-invite.eval-db.test.ts` (“applies a deferred share/assign on the recipient's first chat turn”).

### 1.2 “Registration” after invite

| Expectation (product language) | Actual |
|--------------------------------|--------|
| Invitee registers, then continues | New phone already gets a full independent account on first message (`isGuest: false`, name often `אורח…`). Share/assign apply **without** name/gender. |
| Guest → host promote | Still exists (`guest-register.service.ts`) for leftover shells only — **not** the happy path for new phones. |

**Classification:**  
- Continuity of **share/assign** after first message → **Works**.  
- “Register” as profile (name/gender) before participate → **Product decision** (not enforced).  
- Calling host-promotion “registration” in docs/UI → **UX / doc drift**.

### 1.3 Original invite continues after they arrive

| Invite kind | Continues? | Notes |
|-------------|------------|-------|
| Deferred **share** (item/filing) | **Yes** (auto on first chat turn) | `applyPendingCollabInvites` |
| Deferred **assign** | **Yes** (same) | Row lands on invitee |
| Whole-list **shell** share to unknown name | **No** | `list-ops` → `unknown_participant`; no invite (`list-ops.service.ts`) |
| Share/assign when contact has **no phone** / unresolved name | **No** | Often becomes **personal row on asker** (`resolveActionTargets` fallback) — silent |
| Cold **message / check-with** (null payload) | **Partial / broken for independent users** | `continueInviteAfterRegister` only after **guest** register; opens job on **inviter** account. Independent invitee gets `formatInviteOpeningContext` only — **no job opened on their Lucy** |
| Explicit accept/decline UX for collab | **Not presented** | Design mentioned `metadata.collab_invite`; `loadPresentedCollabInvites` **always returns `[]`**; runtime **auto-applies** |

### 1.4 Both users share lists / items / tasks (already registered)

```text
Asker has partner phone in SPEAKER_CONTACTS
  → resolveExternalSharePartners → registered Employee on other User
  → planTargetedActions applies immediately
  → pushTargetNotification on partner’s User + Lucy
  → WhatsApp if 24h session open; else skip notice to asker (NO cold invite link for share)
```

**Works:** cross-account item co-share, assign, shell share to **known** registered partner, dumps with marks, partner mutates via `visibleTo` / owner routing.  
**Tests:** `share-unified-*.eval-db.test.ts`, `shell-share-verify.eval-db.test.ts`, `cross-account-share.test.ts`.

### 1.5 Clarity: who shared what; what can I see/edit

| Signal | Where | Quality |
|--------|-------|---------|
| Dump marks co-share `(A, B)` / assign `(באחריות X · מאת Y)` | Engine dumps + ESD rules (`employee-records.service.ts`, `show-button-dump.ts`) | **Strong when user asks להציג** |
| List header «משותפת עם …» | Dump / SHARED LISTS rules | **Works** for shell share |
| Partner notify «X שיתף איתך …» | `fallbackNotificationText` (`employee-targets.service.ts`) | **Works when delivered** |
| WhatsApp delivery outside 24h | Skip only; thread notice in DB | **UX gap** — partner may not know until they open Lucy |
| Deferred-invite draft copy | Reuses message draft: «ביקש שאעביר לך: {item}» (`expectsReply: false`) | **UX gap** — does not say “שיתף איתך ברשימת קניות” / assign |
| First Lucy turn after deferred apply | Auto-apply; may only say «היי» while facts already contain the row | **UX gap** — easy to miss why the item appeared |
| Edit rights | Co-share: any in `visibleTo` can update/remove that row; Assign: on assignee book; private rows stay private | **Works in engine**; user education is model/prompt |

### 1.6 Invitee already a Lucy user

| Path | Behavior |
|------|----------|
| Share/assign to registered contact | Applied **immediately** on asker’s turn; no payload invite |
| Notify | Lucy thread + WhatsApp if session open |
| No 24h session | Data shared; WhatsApp may not fire; **no** wa.me cold invite for share/assign |
| Message/check-with, no session | Cold `WhatsAppInvite` (null payload) + draft; opening context on bind; **job resume still guest-centric** |
| Identity | `bindInboundToInvite` does **not** rewrite `userId` (Phase 1) |

---

## 2. Gap inventory (classified)

### A. Implementation gaps

| ID | Gap | Evidence | Impact on family journey |
|----|-----|----------|---------------------------|
| I1 | Message/check-with does not resume as a job on the **invitee’s** independent Lucy | `continueInviteAfterRegister` in `chat.service.ts`; only guest path | “תבדקי עם אמא…” via cold invite fails the modern identity model |
| I2 | Collab accept/decline presentation is stubbed; auto-apply is the real behavior | `loadPresentedCollabInvites` → `[]`; `applyPendingCollabInvites`; design doc vs tests disagree | Cannot decline a deferred share; no explicit consent step |
| I3 | Whole-list share to unregistered contact does not defer an invite | `list-ops.service.ts` `unknown_participant` | “שתפי את רשימת הקניות עם דני” fails if דני not registered |
| I4 | Unresolved share target can silently become asker’s personal item | `resolveActionTargets` / discovery §2.4 | Asker thinks they shared; invitee never gets anything |
| I5 | Share/assign to **registered** user outside 24h: no cold-invite fallback | `pushTargetNotification` skips ≠ `buildColdInvitesForNoSession` | Partner only learns via later Lucy open / web |
| I6 | Invite `expired` never written | Schema comment vs no ticker | Stale pending invites accumulate |
| I7 | Doc/feature text still describes guest view-only / host promote as primary | `docs/features.md` §17–18; parts of product discovery | Operators/PMs mis-plan the journey |

### B. UX gaps (engine mostly OK)

| ID | Gap | Notes |
|----|-----|-------|
| U1 | Deferred invite draft language is “העברה/בירור”, not share/assign | `buildFatherInviteDraft` + `expectsReply: false` + item name as `askSummary` |
| U2 | After auto-apply, first reply may not narrate “טל שיתף איתך חלב” | Opening context + model; facts contain row but speech may not |
| U3 | New users stay named `אורח…` until something sets name | Confusing in dumps (`shared_with`), notifications, two people named אורח (`matchEmployee` first-match risk — noted in Phase 2 design) |
| U4 | Asker must already have phone in contacts for deferral | No phone → no deferred invite |
| U5 | Partner may not understand co-share vs assign vs “only view” | Marks exist; no short first-time explainer |
| U6 | Asker skip notice (“אי אפשר לשלוח…”) for registered partner outside session does not offer the same forwardable draft as cold message invite | Asymmetry vs unregistered deferred path |

### C. Product decisions (do not invent)

| ID | Question |
|----|----------|
| P1 | Must invitee set **name + gender** before share/assign apply, or is first WhatsApp enough? |
| P2 | Deferred share/assign: **auto-apply** (current) vs **explicit accept/decline**? |
| P3 | Should whole-list shell share to unknown phone create a deferred invite like items? |
| P4 | Registered partner, closed WhatsApp session: cold forwardable draft for share, or thread-only is enough? |
| P5 | Is check-with / “תבדקי עם…” in the same pilot family journey as share/assign, or later? |
| P6 | Minimum explainer when someone first receives shared data? |

### D. Explicitly not gaps for this track

- Missing Household / Team-as-family.  
- Auto-see-all family data.  
- Billing / pilot entitlement.  
- Rebuilding share/assign executors (`planTargetedActions`, `visibleTo`).

---

## 3. Journey scorecard

| Scenario | Continuity | Clarity | Blocking? |
|----------|------------|---------|-----------|
| 1. Invite unregistered → item share/assign | Strong if contact+phone | Draft/first reply weak | No for items |
| 2. Invitee gets own account | Strong | Name still `אורח` | Soft |
| 3. Invite continues after arrive | Strong for deferred item share/assign; weak for message/job; none for shell-to-unknown | Medium | Depends on invite kind |
| 4. Ongoing share lists/items/tasks | Strong between registered contacts | Dump marks good | Contact book dependency |
| 5. Who shared / what can edit | Good in dumps + notify when delivered | WhatsApp/session gaps | Soft |
| 6. Already registered invitee | Immediate share works; WA session gap | Same | Soft unless they never open Lucy |

---

## 4. Staged recommendations (no implementation now)

Ordered by family-pilot impact and reuse of existing code.

### Stage F0 — Product lock (short)

Answer **P1, P2, P3, P5** at least.  
Household remains deferred.

### Stage F1 — Make the happy path honest (docs + copy) — low risk

- Align operator docs with Phase 1–2 (independent account; guest = legacy).  
- Improve deferred-invite **draft/askSummary** wording for share vs assign (still `WhatsAppInvite`, no new table).  
- Ensure first recipient turn **acknowledges** applied share/assign (prompt/orchestration or engine notice).  

**Class:** mostly UX / prompt; small targeted if engine notice preferred.

### Stage F2 — Stop silent failures — medium

- When share/assign cannot resolve a partner: **refuse clearly** instead of personal stand-in (or always require contact phone).  
- Optionally: deferred invite for **shell** `add_participants` to contact phone (mirror `partitionDeferredCollabTargets`).  

**Class:** small targeted on `employee-targets` / `list-ops`.

### Stage F3 — Registered partner reachability — medium

- On WhatsApp `no_session` for share/assign notify: offer asker the same **forwardable draft** pattern used for cold message invites (without turning it into Household).  

**Class:** small targeted; reuse `createWhatsAppInvite` / compose URL carefully (payload already applied — draft is “open Lucy / see shared item”, not second apply).

### Stage F4 — Message/check-with resume on invitee Lucy — medium–high

- Point job continuation at independent recipient (fix host-only `continueInviteAfterRegister`).  
- Only if P5 says check-with is in scope.  

**Class:** implementation gap I1.

### Stage F5 — Consent model — only if P2 = explicit accept

- Wire `loadPresentedCollabInvites` (stop returning `[]`) **or** delete dead accept path and document auto-apply as product.  
- Do not leave design/docs contradicting runtime.  

**Class:** implementation consistency.

### Stage F6 — Profile naming — soft

- Prompt new independent users for name (and gender) early so dumps/notifications are human-readable.  
- Does not require host Team.  

**Class:** UX + light orchestration; related to P1.

### Deferred with Household

- Family membership graph, invite-to-household, shared household ACL.  
- File: `lucy-household-implementation-plan.md`.

---

## 5. What to preserve

- `createIndependentWhatsAppAccount` / phone uniqueness.  
- `partitionDeferredCollabTargets` + `confirmCollabInvite` row semantics (share vs assign).  
- Cross-account `resolveExternalSharePartners`.  
- Dump marks and `fallbackNotificationText`.  
- `bindInboundToInvite` without moving `userId`.  
- Eval coverage in `collab-invite.eval-db.test.ts` and share-unified packs.

---

## 6. Bottom line

Independent accounts + Share/Assign **already cover most family collaboration** for item-level work, without Household. The real holes are: **silent non-shares**, **shell-share to unknowns**, **WhatsApp reachability for already-registered partners**, **check-with resume on modern accounts**, **unclear invite copy / first-turn narration**, and an **unresolved accept vs auto-apply** story. Fix those on the existing rails before revisiting Household.

---

*End of findings. No implementation. Awaiting prioritization / answers to P1–P5.*
