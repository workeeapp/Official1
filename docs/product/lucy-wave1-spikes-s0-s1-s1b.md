# Wave 1 — Spike findings (S0 / S1 / S1b)

**Status:** Analysis + read-only audit + documentation only  
**Date:** 2026-11-18  
**Parent plan:** `lucy-wave1-implementation-plan.md`  
**Constraint honored:** No code, Schema, Prompts, Tests, or Config changes. No Stage A. Wave 0 unchanged. D1b/D2b remain Open. C1/C2 not approved.

**Send clarification (accepted into plan before spikes):** If a Send invite is marked `consumed` after present to a Prospect, the original content remains in **chat history**; after Explicit Join, Member may save it into Workspace via normal CORE save ACTIONs. Invite lifecycle ≠ content availability.

---

## 1. S0 — Freeze map

### 1.1 Inbound → chat spine (unchanged)

```text
whatsapp.service
  resolveWhatsAppSpeaker / createIndependentWhatsAppAccount
  bindInboundToInvite                          [whatsapp-invite.service]
sendChatMessage                                [chat.service]
  ★ applyPendingCollabInvites (TODAY: auto share+assign BEFORE facts)
  facts / LLM / parse+validate ACTION
  readCollabInviteDecision → confirmCollabInvite | cancelCollabInvite
  partitionDeferredCollabTargets → createDeferredCollabInvites
  applyListOps
  planTargetedActions → applyEmployeeRecords (loop)
  registerGuestMember (legacy guest only)
  applyReminders / nested reminder packages
  applyDirectoryActions
  applyJobActions / createJobsFromRelays / createScheduledJobsFromRelays
  applyMissionActions
  deliverWhatsAppRelays / Phones / pushTargetNotification
  buildColdInvitesForNoSession → createWhatsAppInvite
```

### 1.2 Write / side-effect entrypoints ProspectWriteGate must cover (pre-apply)

| # | Entrypoint | File / symbol | Notes for gate |
|---|------------|--------------|----------------|
| W1 | Auto deferred collab apply | `applyPendingCollabInvites` → `confirmCollabInvite` | Today runs **before** facts; must be replaced by IntentPolicy; confirm itself is a write |
| W2 | Explicit collab accept | `confirmCollabInvite` from `readCollabInviteDecision` | Assign ack path; Share Member path |
| W3 | List shell ops | `applyListOps` | Durable |
| W4 | List/filing item writes | `applyEmployeeRecords` (per `plan.applications`) | Includes share `visibleTo` / assign rows |
| W5 | Custom remove recovery | `removeVisibleCustomItems` | Extra write path after plan |
| W6 | Reminders | `applyReminders`, `applyNestedReminderPackages`, soft-link helpers | Durable clocks |
| W7 | Directory | `applyDirectoryActions` | Contact book writes + share notices |
| W8 | Jobs | `applyJobActions`, `createJobsFromRelays`, `createScheduledJobsFromRelays` | Obligation rows |
| W9 | Missions | `applyMissionActions` (+ tracking helpers) | Durable |
| W10 | Guest promote | `registerGuestMember` | Legacy host path — not R1 independent join |
| W11 | Invite row mutations | create / cancel / consume / fail / guestEmployeeId bind | Lifecycle; not domain CORE, but side effects |
| W12 | Outbound WA | `deliverWhatsAppRelays`, `deliverWhatsAppPhones`, `pushTargetNotification` | Side effects; Prospect policy TBD for “notify others” — default: block Prospect-initiated outbound that implies member agency |

**Normative placement (already in plan §2.2):** after ACTION parse/validate, **before** W1–W10 durable applies and before W12 when those relays are consequences of blocked ACTIONs. W1 today is **mis-ordered** (pre-facts auto-apply) — mediation must move Share/Assign writes to the gated window (or an equivalent pre-write IntentPolicy that does not bypass the gate).

### 1.3 Present / read entrypoints (InviteValuePresenter)

| # | Entrypoint | Today | Wave 1 role |
|---|------------|-------|-------------|
| P1 | `formatInviteOpeningContext` | askSummary only; “not a limit” | Base for Send / orientation; tighten so Prospect is not told “handle any normal request” without WriteGate |
| P2 | `formatPendingInviteContext` | Legacy guest register gate | Do **not** reuse as independent Prospect model |
| P3 | `formatCollabInviteContext` / `loadPresentedCollabInvites` | Present stub returns `[]` | Assign presentation |
| P4 | `getEmployeeRecordSnapshot` + `visibleTo` injection | Live shared rows for partners | **Not** Prospect Share path (no early visibleTo / C2 out) |
| P5 | Chat history (`ChatMessage`) | Durable transcript | Send content retention after invite `consumed` |

### 1.4 Asker-side invite creators

| Creator | When |
|---------|------|
| `createDeferredCollabInvites` | Unregistered phone targets on share/assign adds |
| `buildColdInvitesForNoSession` → `createWhatsAppInvite` | Send / check text when no WA session |
| Registered + session | Immediate `planTargetedActions` apply (no invite row) |

### 1.5 S0 conclusion

Map is complete enough to implement mediation hooks without discovering a second write spine. **No CORE change required for S0 itself** — only hook placement. The existing early `applyPendingCollabInvites` is the primary behavioral conflict with Wave 0 IntentPolicy.

---

## 2. S1 — Prospect read path security design

### 2.1 Recommended design (mediation-only; C2 not used)

**Live `contentRef` / v1 (`domain`+`rowId`) resolve + per-turn authorize**, injected as scoped `INVITE_VALUE` / opening context.

Confirm path today (`confirmCollabInvite`) proves the source-of-truth pattern: asker employee loaded, `replayCollabMetadata`, `planTargetedActions` as asker with recipient as external partner, write via `applyEmployeeRecords`. Presenter should **reuse ownership checks** (asker owns row) **without** calling confirm / without writing `visibleTo`.

### 2.2 Security checklist (normative for implementation later)

| ID | Rule | Enforcement idea |
|----|------|------------------|
| S1 | `contentRef` bound to **this invite** | Store ref on invite; ignore model-supplied ids |
| S2 | Live source **owned by asker** | Load row; verify `list.employeeId` / filing.employeeId / askerUserId |
| S3 | Payload fields are hints only | Compare title/domain; on mismatch refuse present |
| S4 | Re-check every turn: phone, bind, status, TTL | Lazy expire first; status must allow present |
| S5 | Cancel/expiry mid-chat stops present | No snapshot grant; chat may continue without value |
| S6 | No `visibleTo` / CORE view-only | C2 out of baseline |
| S7 | Scope = invited **item or filing only** | Not sibling list items; not whole list |
| S8 | Send content after consume | Remains in `ChatMessage` history; Member save ≠ invite pending |

### 2.3 Send vs Share present

| | Send | Share (Prospect) |
|--|------|------------------|
| Source | Invite `askSummary` / draft body + messages written into chat on present | Live asker-owned item/filing via contentRef |
| After `consumed` | History retains text; invite row terminal | Share stays `pending` until join→confirm, cancel, or expiry |
| Member save | CORE personal save from history / user ask | CORE co-mutate via `confirmCollabInvite` once |

### 2.4 Residual risks (not CORE changes yet)

| Risk | Mitigation without CORE |
|------|-------------------------|
| Item deleted by asker while Prospect viewing | Present fails gracefully (“content no longer available”) |
| Custom list context needed for sense-making | Show list **name** as label only if needed — not other items |
| Opening context currently says “not a limit” | Mediation/prompt framing later (prompt change needs separate approval when coding) |

### 2.5 CORE change needed for S1?

| Need | Verdict |
|------|---------|
| Present invite value without `visibleTo` | **No CORE change** — inject context block |
| Revoke on cancel/expiry | **No** — status gate |
| Member co-mutate after join | **No** — existing `confirmCollabInvite` |
| Dump shared row in EMPLOYEE_SAVED_DATA like a partner | Would push toward **C2** — **not recommended**; out of baseline |

**S1 recommendation:** Proceed with live presenter. **Do not open C2.**

---

## 3. S1b — C1 account audit + C1-A registration path

### 3.1 Registration / consent paths in code (C1-A)

| Path | What exists | Includes Explicit Join / terms? |
|------|-------------|----------------------------------|
| `createUser(username, password)` | `user.service` + CLI `scripts/create-user.ts` | **No** — credentials only |
| Web frontend | **Login only** (`LoginPage` / `auth.controller.login`) — **no self-signup UI** | N/A for new consent |
| WhatsApp independent | `createWhatsAppOnlyUser` + owner human | **No** consent |
| Legacy guest | `registerGuestMember` (name+gender on **host**) | Not independent R1 join; tip `guest_terms` is guest-Lucy oriented |

**C1-A finding:** Today’s `createUser` does **not** embed product Explicit Join / terms acceptance. Therefore **cannot** honestly treat “username present ⇒ consented Member” as proven R1 compliance without adding consent to that flow (or treating credentialed users under a separate grandfather/policy decision).

### 3.2 Local DB read-only counts (this machine)

**Environment:** `localhost:5435` / DB `workee` (dev/pilot local). Schema client may be ahead of some migrated columns; invite `payload` filter was fragile — status groupBy worked.

| Metric | Count |
|--------|------:|
| Users total | 3 |
| Users with username (credentialed) | 2 |
| Users WhatsApp-only (`username` null) | 1 |
| Human employees non-guest | 8 |
| Human employees guest | 1 |
| WhatsAppInvites by status | pending: 1 |

**Per-user durable evidence (primary non-guest human; `isOwner` was false on all rows in this DB — primary = first non-guest):**

| User | Class label | Durable items | Filings | Reminders | Chat msgs | Notes |
|------|-------------|--------------:|--------:|----------:|----------:|-------|
| Amit (username) | M1_candidate_credentialed | 42 | 6 | 120 | 52 | Heavy established workspace |
| Tal (username) | M1_candidate_credentialed | 0 | 0 | 0 | 0 | Credentialed; little/no durable use |
| (3rd user, WA-only) | WA_only_candidate | — | — | — | — | Present in Users count; **no human rows** in summary join (orphan / digital-only / incomplete) |

**Interpretation limits:** This is a **small local** dataset, not production census. Counts **inform risk sizing**; they **must not** decide C1-M2.

### 3.3 Cohort mapping for product discussion

| Class | Local signal | Open decision |
|-------|--------------|---------------|
| M1 | username set (2) | Still gated by **C1-A** (consent in create flow?) |
| M2 | WA-only with durable evidence | **0 clear WA-only owners** in this DB; production may differ |
| P1 | WA-only without durable evidence | Possible orphan WA user |
| L1 | guest humans | 1 |
| P2 | future WA creates | N/A (post-ship) |

---

## 4. CORE changes required? (escalation table)

| Item | Required now? | Why | Alternative in mediation |
|------|---------------|-----|--------------------------|
| C1 Schema `User.consentPending` (or equiv.) | **Only if Stage B** — needs **your approval** | Durable Prospect/Member | Cannot fake durability without storage |
| C2 early `visibleTo` | **No** | S1 live present sufficient for plan | InviteValuePresenter |
| Change `planTargetedActions` / records ACL | **No** | Gate before invoke | ProspectWriteGate |
| Move `applyPendingCollabInvites` timing | Mediation/chat hook — not a domain engine rewrite | Policy conflict | IntentPolicy + gate |
| Prompt wording for opening context / consent | Later coding stage; **not in this spike** | Framing | — |
| Chat history for Send save after join | **No new store** | Already `ChatMessage` | Documented Send clarification |

**No unapproved CORE edit is recommended from these spikes.**

---

## 5. Recommendations (not decisions)

### C1-A — Does `createUser` create Member?

**Recommendation:** Treat current `createUser` as **credentials-only, not R1 Explicit Join**.  
- Prefer: either (a) add real consent into any future self-serve registration before minting Member, or (b) keep CLI/admin-created users as an explicit **admin-provisioned Member** policy exception documented separately from WhatsApp R1.  
- Do **not** silently equate “has username” with “accepted Lucy join terms” until product defines that.

### C1-M2 — Grandfather vs Explicit Join for established WhatsApp-only users

**Recommendation lean (advisory):** Prefer **Explicit Join (re-join)** for strict R1 consistency, **unless** pilot continuity risk is judged unacceptable.  
- Local DB shows **almost no WA-only owner cohort** — grandfather pressure looks **low here**, which weakens the case for a broad M2 exception *on this environment*.  
- Production may differ — re-run the same read-only audit there before locking.  
- If Grandfather is chosen, document it as a **time-bounded cohort exception**, not “activity ⇒ Member” as an ongoing rule.

**I am not deciding C1-M2 or C1-A for you.**

### Field location (C1 shape)

Still recommend **`User`-level** stage flag when C1 is approved (account-level R1). Unchanged from plan.

---

## 6. Decisions still requiring product approval

| ID | Topic | Why it blocks |
|----|-------|---------------|
| **Plan → implementation** | Approve Stage A coding start | Spikes done; coding still gated |
| **C1** | Schema + ConsentStage persistence | Needed for Stage B |
| **C1-A** | `createUser` / credential path vs real consent | Affects M1 migration rule |
| **C1-M2** | Grandfather vs Explicit Join for established WA-only | Affects migration; audit ≠ decision |
| **D1b** | Hebrew join copy / UX | Explicit Join handler labels |
| **D2b** | Decline Share after grant | Post-consume Share lifecycle |
| **C2** | Early visibleTo | Remains **out of baseline**; only if S1 later fails in build |
| Production S1b re-audit | Same queries on prod/staging | Local counts are not production |

---

## 7. Contradictions / gaps found

| Item | Finding |
|------|---------|
| Gate vs early `applyPendingCollabInvites` | Today writes **before** validate/apply gate window — must be relocated by mediation (documented; not fixed in code) |
| `formatInviteOpeningContext` “not a limit” | Conflicts with ProspectWriteGate product intent — fix at coding/prompt approval time |
| `isOwner` unused in local humans | Migration must not rely solely on `isOwner`; use username + durable heuristics carefully |
| Local vs prod | Audit numbers are **local only** |
| Wave 0 | No new contradictions with locks |
| Send consume vs save | Clarified — no remaining intentional gap |

---

*End of spike report. No implementation started.*
