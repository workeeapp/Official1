# Wave 1 — Implementation plan (Cross-user mediation)

**Status:** Detail / archive reference — **working baseline is `lucy-wave1-plan-distilled.md`**  
**Updated:** 2026-11-18 (superseded as execution plan by distilled doc; kept for spike/history detail)  
**Parent lock:** `lucy-wave0-decisions.md` (**Approved**)  
**Working plan:** `lucy-wave1-plan-distilled.md`  
**Prior audits:** `lucy-cross-user-communication-audit.md`, Phase 1/2 invite design docs, spike report `lucy-wave1-spikes-s0-s1-s1b.md`  

**Open product decisions (do not close by assumption):** **D1b**, **D2b**, **C1-M2**, **C1-A**, **U1** (Prospect usage quota policy — numeric limits TBD).  
**Schema / CORE change items:** **C1** and **C2** are **not approved**. C2 is **out of the approved planning baseline** until a proven need + explicit approval.  
**Deferred (out of Wave 1.0):** D3/D3b Check-with cold, D5b/D7 shell deferred invite, D12 ReferralCampaign, D6 Templates, product view-only Share, Household, soft-try growth (Wave 2), **Billing / paid Quota product**, numeric Prospect caps (until U1).

**This revision:** planning docs only. No code, Schema, Prompts, Tests, Config. Do not start Stage A or any implementation stage. Do not amend Wave 0 locks. Do not close D1b, D2b, or U1.

---

## 0. Goal & non-goals

### Architectural principle — one system, one CORE, stage-based policy

**We do not want two separate operating systems for Member and Prospect.**

| Layer | Rule |
|-------|------|
| Intent understanding | **Same** conversation / model path |
| ACTION shape + validation | **Same** contract and validators |
| Domain execution | **Same** CORE only (`planTargetedActions`, `applyEmployeeRecords`, list-ops, reminders, directory, jobs, `confirmCollabInvite`, …) |
| What differs by ConsentStage | **Prompt context** (facts / framing) + **mediation authorization** before CORE is invoked |

```text
Same pipeline for everyone
  → same LLM / ACTION / validate
  → mediation policy (ConsentStage × intent × invite state)
  → either: invoke existing CORE   OR   refuse / present-only
Member today stays on the existing CORE semantics (D9 co-mutate Share, etc.).
Prospect does not get a parallel engine — only stricter authorization + scoped invite context.
```

**Forbidden:**

- Separate Prompt Engine for Prospect  
- Separate Action Engine for Prospect  
- Duplicate execution paths that reimplement Tasks / Lists / Filing / Reminders / Share  
- Changing CORE Share/Assign semantics just to support Prospect (no product view-only Share — D9)

**Allowed:**

- Inject ConsentStage-aware **context** into the existing prompt assembly  
- **Pending Invite Mediation** (invite lifecycle + present/apply routing)  
- **ProspectWriteGate** (pre-apply authorization on the same ACTION)  
- After Explicit Join, continue through the **same** CORE Member path

### Goal

Add a **Cross-user Communication / Authorization mediation layer** on top of that single system that:

1. Identifies asker and recipient  
2. Manages contextual invitations and pending deliveries  
3. Checks eligibility, consent stage (`Prospect` vs `Member`), and intent authorization  
4. **Routes** into existing CORE executors when policy allows — never forks them

…without rebuilding Lucy’s Conversation, ACTION/validate/apply, Tasks/Lists/Filing/Reminders, Jobs, or existing permission/send machinery (**D0**).

### Non-goals (Wave 1.0)

| Out | Why |
|-----|-----|
| Dual Member/Prospect runtimes | Forbidden — one system (§0 principle) |
| Cold Check-with on independent invitee | Deferred Wave **1.1** (D3) |
| Shell-list deferred invite | Deferred Wave **1.1** (D7) |
| Generic ReferralCampaign | Wave **2** / 1.5 (D12) |
| Soft capability try-ons / growth ladder | Wave **2** (D4) |
| WhatsApp Templates | Separate workstream (D6) |
| Product-wide view-only Share | Deferred (D9) |
| Household / Team-as-family-graph | Deferred / out of track |
| Parallel Tasks/Lists/Filing/Reminders/Jobs engines | Forbidden (D0) |
| Closing D1b or D2b by assumption | Explicitly open |
| Approving C1 / C2 / C1-M2 / U1 | Separate explicit approvals required |
| Starting Stage A+ coding | Blocked until this plan is approved for implementation |
| Implementing Billing / numeric Prospect quotas in Wave 1.0 | Out until U1 + later workstream; measurement design only (§2.9) |
| Inferior “Prospect Lucy” (crippled chat/experience) | Forbidden — meaningful trial via same system; cost control is a separate plane |

---

## 1. Existing map (integration points before changes)

### 1.1 Happy-path call graph today

```text
WhatsApp inbound
  → resolveWhatsAppSpeaker / createIndependentWhatsAppAccount   [whatsapp.service]
  → bindInboundToInvite                                         [whatsapp-invite.service]
  → sendChatMessage                                             [chat.service]
       ├─ applyPendingCollabInvites  (auto share+assign)        [collab-invite.service]
       ├─ facts / prompt / LLM
       ├─ readCollabInviteDecision → confirm/cancel (stubbed present=[])
       ├─ partitionDeferredCollabTargets → createDeferredCollabInvites
       ├─ planTargetedActions → applyEmployeeRecords / list-ops / reminders / jobs
       └─ buildColdInvitesForNoSession → createWhatsAppInvite (null payload)
```

### 1.2 Account-creation paths (for C1 — verified)

| Path | Entry | What is created | Consent today | Wave 1 relevance |
|------|-------|-----------------|---------------|------------------|
| **A. Regular / web-capable user** | `createUser(username, password)` (`user.service`, `create-user` script, controllers that use it) | `User` with username + passwordHash; employees added separately | Credential create ≠ proven product join/terms | **Member only if** registration flow **actually includes** required consent (**C1-A Open**) |
| **B. Independent WhatsApp auto-create** | Unknown phone → `createIndependentWhatsAppAccount` → `createWhatsAppOnlyUser` + owner human (`isGuest: false`) | `User` with **null** username/password; personal Lucy | **None** — first message creates a full-looking account | Historical + future cold inbound; may be invite-driven or organic |
| **C. Invite arrival (today)** | Same as **B** after token bind on first inbound | Same as B | Same as B | Must become **Prospect** for *new* post-ship accounts until explicit join |
| **D. Legacy guest on host** | Guest shell `isGuest: true` on host `User`; `registerGuestMember` promotes in place onto host “New Registered 30 days” | **No** new independent `User` | Name+gender register on host | **Out of R1 independent-account track**; do not conflate with Prospect/Member on a personal Lucy User |
| **E. Existing non-guest humans** | Mixed of A + B over time | Durable workspace already in use | No stored consent flag | Classification for audit only; **M2 not auto-Member** (see §5 C1 / **C1-M2 Open**) |

**Important:** `guestSpeaker` capability stripping in `chat.service` is currently forced **off** (`guestSpeaker = false`). Independent WhatsApp users already run the **full** apply pipeline. Prospect limits must be introduced by mediation — not by reviving host-guest mode as the product model.

### 1.3 Reuse inventory (CORE — keep)

| Area | Module | Role in Wave 1 |
|------|--------|----------------|
| Identity / phone | `whatsapp.service` `findExistingWhatsAppSpeaker`, `createIndependentWhatsAppAccount` | Early User continuity (R1); mediation adds consent stage around it |
| Invite token + draft + bind | `whatsapp-invite.service` | Evolve; **no second invite store** (D5) |
| Deferred collab payload apply | `collab-invite.service` `confirmCollabInvite` → `planTargetedActions` → `applyEmployeeRecords` | Member Share co-mutate + Assign after ack |
| Target planning | `employee-targets.service` `planTargetedActions`, `partitionDeferredCollabTargets` | Unchanged semantics for Member Share/Assign |
| Domain writes | `employee-records.service`, `list-ops.service`, `reminder.service` | Only via existing apply paths |
| Jobs | `jobs.service` | Registered + open session only in 1.0; cold path → 1.1 |
| Session window | `whatsapp-window.ts` | Preserve; no Templates |
| Outbound / notify | relays, `employee-targets` notifications, compose URL | Honest ממתין + user-forward |
| Conversation apply loop | `chat.service` `sendChatMessage` | Mediation hooks **inside** the loop at pre-apply; does not fork CORE writers |

### 1.4 Gaps Wave 1 must close (vs Wave 0 lock)

| Gap | Today | Wave 0 target |
|-----|-------|---------------|
| Consent | Independent User with no consent gate | R1: `consentPending` Prospect until **explicit** join (D1; copy = D1b Open) |
| Share apply | Auto `confirmCollabInvite` → full co-mutate on first inbound | Prospect: **scoped read-only**; Member: co-mutate (D2 + D9) |
| Assign apply | Same auto-apply as Share | Present obligation; **explicit accept/decline** (D2) |
| Presentation | `loadPresentedCollabInvites` → `[]` | Assign (and Prospect Share value) must be presentable |
| Invite copy | Generic «העברה/בירור» draft | Intent-specific, brand **Lucy** (D11) |
| TTL / expiry | `expired` never written | 14-day **lazy** expiry (D4b) |
| Asker cancel | Recipient cancel only (`cancelCollabInvite`) | Asker cancel of **pending** contextual invite (D8) |
| Asker UX | Model may claim done | Pending ≠ completed (ממתין) |
| Registered + closed session Share notify | Often skip-only | Forwardable contextual draft continuity (Wave 1 continuity) |

### 1.5 Intent × stage matrix (locked — implement against this)

| Intent | Prospect | Member |
|--------|----------|--------|
| Send / Forward | Show transferred content in chat | May save into **their** workspace |
| Share | Scoped **read-only** of invited content; no mutate of sharer data | Existing CORE **co-mutate** |
| Assign | See ask + context | Explicit accept / decline → then CORE assign write |
| Check-with / Coordinate | Not Wave 1.0 | Existing registered+session only |
| Generic Referral | Not Wave 1 | — |

Name, address gender, continued chat, viewing invite value ≠ join consent (**D1b Open** for copy only).

---

## 2. Proposed architecture

### 2.1 Mediation on one CORE (not a second runtime)

Logical concerns (packaging flexible) — **authorization & invite orchestration only**:

```text
cross-user mediation  (policy layer — not a parallel Lucy)
  ├─ ConsentStage                 Prospect | Member
  ├─ Pending Invite Mediation     invite bind / lifecycle / present vs schedule-CORE-apply
  ├─ InviteValuePresenter         scoped read context into the SAME prompt assembly
  ├─ ProspectWriteGate            pre-apply authz on the SAME validated ACTION
  └─ CoreRouter                   invokes ONLY existing CORE executors when allowed
```

**Does own:** eligibility, consent stage, invite status transitions, present-vs-apply routing, pre-apply refuse/strip, asker ממתין honesty.

**Does not own:** intent parsing engine, ACTION schema, validators, list/filing/reminder/job write semantics, Share co-mutate rules, conversation engine internals.

#### Two distinct mediation concerns (keep separate)

| Concern | When | Job | Must not |
|---------|------|-----|----------|
| **Pending Invite Mediation** | Around invite bind / pre-facts present / post-join or ack apply routing | Lifecycle of `WhatsAppInvite`; decide **present** vs **schedule existing CORE apply** (`confirmCollabInvite` etc.) by intent × stage | Reimplement Share/Assign writes; change Member Share semantics |
| **ProspectWriteGate** | After ACTION validate, before any side effect | Authorization on whatever the **same** ACTION planned — strip/refuse durable writes while Prospect | Become a second apply pipeline; run after CORE already wrote; alter Member apply when stage is Member |

For **Member**, ProspectWriteGate is a no-op pass-through: existing CORE behavior preserved.  
Pending Invite Mediation may still present Assign for ack or route Share to `confirmCollabInvite` — still the same CORE, not a fork.

### 2.2 Placement in the existing (single) pipeline

```text
Inbound
  → resolve speaker (existing)
  → ConsentStage
  → Pending Invite Mediation (lifecycle + present / schedule-apply decisions)
        Share+Prospect  → InviteValuePresenter into SAME facts/prompt  (no confirmCollab)
        Share+Member    → schedule existing confirmCollabInvite / share CORE
        Assign          → present for ack (same collab metadata contract)
        Send            → show content into chat/context (same conversation)
  → sendChatMessage (SAME loop for Prospect and Member):
        facts + ConsentStage-aware context framing
        → LLM (same model path)
        → parse + validate ACTION (same validators)
        → ★ ProspectWriteGate ★   (Member: pass-through)
             AFTER validation, BEFORE any side effect
        → CORE apply (same executors) for writes that passed
  → ExplicitJoinHandler (dedicated signal only)
       → Prospect→Member; then Pending Invite Mediation may call same confirmCollabInvite
  → asker path: existing partitionDeferred + cold invites + ממתין
```

**Hard rule:** No durable CORE side effect for a blocked Prospect ACTION after-the-fact. Member turns must not be regressed into a different apply semantics.

### 2.2b How one system serves Share / Assign / Send

Same ACTION vocabulary and CORE. Differences are **policy + context**, not engines.

#### Share

| Stage | Pipeline | Outcome |
|-------|----------|---------|
| **Member** (incl. registered partner / post-join) | Pending Invite Mediation schedules **existing** `confirmCollabInvite` → `planTargetedActions` → `applyEmployeeRecords` (co-mutate / `visibleTo` as today — **D9**) | Full Share via CORE; asker pending clears on consume |
| **Prospect** | Pending Invite Mediation: **present only** via InviteValuePresenter (scoped live read into prompt/chat). **No** `confirmCollabInvite`, **no** `visibleTo` grant | Read invited content; CORE Share not executed yet |
| **After Explicit Join** | Same Member Share path once: `confirmCollabInvite` | Co-mutate via unchanged CORE |

Prospect Share is **authorization delay**, not a second Share product type.

#### Assign

| Stage | Pipeline | Outcome |
|-------|----------|---------|
| **Prospect / Member (before ack)** | Same presentation contract (`collab_invite` / `decline_invite`); see ask + context | No responsibility row yet |
| **Member + accept** | Existing `confirmCollabInvite` (assign kind) through CORE | Responsibility on recipient book |
| **Decline / cancel / expiry** | Invite lifecycle only | No CORE assign write |
| **Join alone** | Does **not** accept Assign | Still needs explicit ack |

#### Send

| Stage | Pipeline | Outcome |
|-------|----------|---------|
| **Prospect** | Same conversation engine; content shown in chat / opening context; invite may `consumed` for asker “delivered” | History keeps original text; **ProspectWriteGate** blocks personal Workspace save |
| **Member** | Same ACTION/validate/apply; may save into **their** workspace via normal CORE list/filing ACTIONs | Invite `consumed` does not erase history or block save |

Asker-side Share/Assign/Send creation stays on existing `partitionDeferredCollabTargets` / cold invite / immediate partner apply — Member asker behavior unchanged.

### 2.3 PendingDelivery = evolved `WhatsAppInvite` (D5)

**No parallel invite table.**

Payload evolution (additive; keep parsing strict):

```text
payload v1 (today): { v:1, kind: share|assign, domain, rowId, action }
payload v2 (Wave 1): {
  v: 2
  intentKind: "send" | "share" | "assign"   // check_with|coordinate reserved; not applied in 1.0
  contentRef: { type, … }                     // wraps / supersedes domain+rowId+action
  requireRecipientAck?: boolean               // true for assign
}
```

Compatibility: parsers accept v1 and v2; writers emit v2 for new rows. Null payload remains legacy message/send invite.

**Note:** A durable `readSnapshot` blob inside the payload is **not** the preferred S1 design (see §2.4). If a short-lived display cache is ever used, it must be non-authoritative and re-authorized every turn against invite status + phone bind.

### 2.4 Prospect Share read path (S1) — security-first, mediation-only

**Goal:** Prospect sees the **original invited value** without `visibleTo`, without CORE permission modes, and without leftover access after cancel/expiry.

#### Preferred approach: **live `contentRef` resolve + status gate** (not a standing snapshot grant)

Each recipient turn that may show invite value:

1. Load invite candidate for this inbound (token/phone rules).  
2. **Authorize (every presentation):** phone match, invite bind, status ∈ allow-present set, lazy TTL 14d.  
3. **Validate `contentRef`:** must reference the **specific invite’s** source object; source must be **owned by the asker/sharer** for that invite; reject otherwise.  
4. **Resolve live** from that verified source — **do not** trust payload fields alone as the content of record.  
5. Inject **scoped** `INVITE_VALUE` / opening context per §2.4.1.  
6. Do **not** call `confirmCollabInvite`; do **not** write `visibleTo`.  
7. If any authorize/validate step fails → inject nothing; no cached fallback that bypasses steps 2–4.

#### 2.4.1 InviteValuePresenter — mandatory security conditions

| # | Condition |
|---|-----------|
| S1 | `contentRef` is bound to **this invite row** (not a free-floating id from the model or a different invite). |
| S2 | Resolved source is **owned by the sharer/asker** of the invite (ownership check on live row). |
| S3 | Payload / `contentRef` / embedded action text are **hints only** until verified against the live source; mismatch → refuse present. |
| S4 | **Every** present re-checks: recipient phone, invite linkage/bind, status, TTL (lazy expiry first). |
| S5 | Cancel / expire / fail / wrong phone → **no** present on this or later turns, even if the chat already started. |
| S6 | No `visibleTo` / CORE Share ACL for Prospect read (C2 out of baseline). |

#### 2.4.2 Scope of visible content (lists vs items)

| Invited content | Prospect may see | Prospect must **not** see |
|-----------------|------------------|---------------------------|
| **Single shared item** (shopping/tasks/custom item) | That item’s invite-relevant fields (e.g. title, qty/notes as on the invited row) | Other items on the same list; other lists; asker filings unrelated to the invite |
| **Filing** share/assign | That filing’s invite-relevant fields | Other filings; lists; contacts |
| **List-level / shell invite** (if ever in scope later; **not Wave 1.0** per D7) | Would require a separate scope definition | — |
| **Send** | The transferred message/content of the invite | Asker’s private workspace |

Wave 1.0 deferred collab payloads today are **item/filing add** shaped. Presenter scope for Share = **the invited item or filing only**, not “the whole list because the item lives on it.”

#### Why not prefer a stored `readSnapshot` as the access mechanism

| Concern | Risk if snapshot is the grant | Mitigation in preferred design |
|---------|------------------------------|--------------------------------|
| **Security / revocation** | Cancel or expiry leaves readable copy in payload/chat facts | Every turn re-checks invite status; no present if not allowed |
| **Freshness** | Stale title/qty vs asker’s current row | Live resolve from verified source |
| **Lifecycle** | Snapshot outlives invite row semantics | Access = invite lifecycle, not a second ACL |
| **Scope creep** | Snapshot may over-capture fields | Present minimal invite-scoped fields only |
| **Trusting payload** | Tampered/stale embedded action shown as truth | S3 — verify against live source |
| **CORE drift** | Temptation to bolt view-only onto Share | Forbidden without C2 approval; C2 out of baseline |

Optional non-authoritative display cache (e.g. last rendered text for the current turn only) is allowed **only if** S1–S5 still gate injection. It must not survive as a permission.

#### S1 spike outcomes (planning gate — still no coding)

| Outcome | Next |
|---------|------|
| Live resolve + context injection sufficient | Adopt; **no C2** |
| Insufficient for product-quality “see the item” | Document exact gap → **stop**; request approval only if still needed — **C2 remains unapproved and out of baseline** |
| Appears to need CORE Share ACL | Escalate under D0; do not implement |

### 2.5 Prospect boundaries (explicit)

Prospect may receive the **original invite value** and participate in **conversation** needed to understand it. Prospect does **not** receive a full personal Lucy workspace or durable-save privileges as if already joined.

#### Allowed while Prospect

| Allowed | Notes |
|---------|--------|
| Chat / Q&A about the invited content | Needed to deliver value |
| View scoped invite value (S1 presenter) | Status-gated; invite-scoped only |
| Collect preferred name / address gender | **Not** join consent |
| Open/maintain WhatsApp 24h window via inbound | Transport only |
| See Assign ask + context | No responsibility write until Member-eligible ack path |
| Explicit join control (when D1b copy exists) | Only path Prospect → Member |

#### Blocked while Prospect (durable personal workspace + sharer mutations)

**ProspectWriteGate** (§2.2) blocks **before write**, across **all** relevant paths:

| Block | Examples of CORE paths to gate |
|-------|--------------------------------|
| Personal list item adds/updates/removes | `lists.*` → `planTargetedActions` / `applyEmployeeRecords` |
| List shell ops | `listOps` → `applyListOps` |
| Personal filing adds/updates/removes | `filing.*` |
| Reminders / clocks | `reminders.*` |
| Directory / contact book durable writes | `directory.*` |
| Missions / other durable metadata writers used in apply | mission apply, etc. |
| Share co-mutate / Assign apply writes | `confirmCollabInvite` until policy allows |
| Jobs that persist obligation on Prospect’s book | out of 1.0 cold path; block if emitted |
| Saving Send content into “my” workspace | Member-only (Wave 0 matrix) |

#### Must **not** block

| Keep working | Why |
|--------------|-----|
| LLM reply / conversational turns | Deliver invite value |
| Invite value presentation / show of scoped content | Original purpose of invite |
| Read-only dumps **limited to invite scope** if used | Still not owner-wide inventory |
| Engine notices / buttons that are non-mutating | UX for value + later explicit join |
| Asker-side flows on other accounts | Unaffected |

**Private data rule:** only invitation-scoped content — never asker’s other private lists, unrelated filings, or owner-wide views.

### 2.6 Explicit Join (structural; D1b Open)

| Rule | Lock |
|------|------|
| Conversation continuation | **Not** join |
| Providing/confirming name | **Not** join |
| Address gender | **Not** join |
| Viewing invite value | **Not** join |
| Assign accept/decline | Responsibility decision — **not** account join (separate signals) |
| Prospect → Member | **Only** dedicated explicit join / terms-accept signal |

- **D1b** remains Open: no final Hebrew copy, button labels, or UX lock in this plan.  
- Implementation may later reserve an internal join signal for tests; product copy waits on D1b.  
- Join handler clears durable Prospect stage (after **C1** exists) then may route Member Share apply via existing `confirmCollabInvite` with idempotency (§2.8).

### 2.7 Assign ack — restore presentation path without new engines

Today presentation is stubbed (`loadPresentedCollabInvites` → `[]`) while auto-apply runs. Wave 1:

- **Stop** auto-apply for Assign in `applyPendingCollabInvites` (or replace that entrypoint with mediation IntentPolicy).  
- Present pending Assign via existing `formatCollabInviteContext` / `collab_invite` + `decline_invite` metadata contract.  
- On accept → existing `confirmCollabInvite` (Member-eligible policy), pre-gated.  
- On decline → existing `cancelCollabInvite`.

Share does **not** use Assign’s “participate” wording (D2). Assign ack ≠ Explicit Join.

### 2.8 Invite lifecycle by intent (Send / Share / Assign)

Statuses on `WhatsAppInvite` (existing vocabulary): `pending` | `consumed` | `cancelled` | `expired` | `failed`.

**Meaning of `pending` (system + asker UX):**

| Audience | Meaning while `pending` |
|----------|-------------------------|
| **System** | Invite is eligible for present/apply rules for its intent; not terminal |
| **Asker** | **ממתין** — delivery/apply not complete; **forbidden** to treat as «נשלח/שיתפתי/הוטל» as done |

#### Lifecycle table

| Stage | **Send** | **Share** | **Assign** |
|-------|----------|-----------|------------|
| **Created** | Cold/no-session (or continuity draft) → `WhatsAppInvite` (often null payload / send intent) | Deferred collab create → payload share + `contentRef` | Deferred collab create → payload assign + `requireRecipientAck` |
| **Asker-facing while waiting** | ממתין עד שהנמען כתב / התוכן הוצג לפי כללי Send | ממתין לגישה/הצטרפות לפי שלב הנמען — **לא** «אישר להשתתף» | ממתין לאישור **אחריות** |
| **Delivered (product sense)** | Recipient inbound + Send content shown in chat (opening/context). **Default:** mark invite `consumed` after successful verified present — **without** deleting chat history. Consumed ≠ “content gone.” | **Prospect:** value presented via InviteValuePresenter; invite stays **`pending`** (access ≠ co-mutate done) | Ask presented; stays **`pending`** until accept/decline/cancel/expiry |
| **Accessible while Prospect** | Original Send body remains in **conversation history** after present/`consumed`; no personal Workspace save until Member | **Yes** — live present while `pending` + authorize; until join, cancel, or expiry | Context only; no responsibility row until accept (+ Member rules) |
| **Terminal — success** | `consumed` after successful present (invite lifecycle complete for asker “delivered”). Chat transcript retains the original content for later Member save | **Member:** `confirmCollabInvite` → `consumed` + CORE co-mutate row. **Prospect never consumes Share via confirm** | Accept → `confirmCollabInvite` → `consumed` + CORE assign row |
| **Terminal — decline** | N/A (D2b is Share-after-grant; Send has no decline product) | N/A for Prospect read; post-grant unshare = **D2b Open** | Decline → `cancelled`; no assign row |
| **Terminal — asker cancel** | `cancelled` if still pending | `cancelled`; presenter stops next turn | `cancelled`; no accept possible |
| **Terminal — expiry** | Lazy 14d → `expired` | Lazy 14d → `expired`; presenter stops | Lazy 14d → `expired` |
| **After Explicit Join** | Member may save the **original Send content from chat history** (or an equivalent durable turn artifact) into **their** Workspace via normal CORE save ACTIONs. Invite `consumed` must **not** block that save — lifecycle of the invite row ≠ availability of the message content | If Share invite still `pending` and authorize OK → **one** `confirmCollabInvite`; else no-op | Join ≠ Assign accept. Pending Assign still needs explicit `collab_invite` / decline |
| **Double-apply prevention** | Consume/idempotent present marker; second present of same consumed send is no-op | `confirmCollabInvite` existing claim (`pending`→`consumed` in transaction); join handler calls confirm **once**; retry sees non-pending → lost/no-op | Same transactional claim on accept; decline/cancel/expiry block accept |
| **Cancel/expiry mid-conversation** | No further Send present from that invite | **Presenter refuses** on every subsequent turn (S4–S5); no residual snapshot grant; chat may continue without invite value | Assign present removed; accept refused |

**Prospect Share stays `pending` and presentable until** Explicit Join leads to consume, **or** cancel, **or** expiry — whichever first.

**Explicit Join does not** by itself consume Assign or re-apply an already `consumed` Share.

### 2.9 Prospect experience economics — three separate planes

Prospects should get a **real Lucy trial** (same system, meaningful conversation). That trial can incur AI, WhatsApp, and infra cost even if they never join. Cost control must **not** be implemented by inventing a second, weaker Lucy or by collapsing “not a Member yet” into “cannot talk.”

#### 2.9.1 Three planes (do not merge)

| Plane | Question it answers | Wave 1 stance |
|-------|---------------------|---------------|
| **1. Product Permissions** | What durable/product capabilities may run before Explicit Join? | Chat, orientation, planning talk, invite-scoped value, experience — **open**. Personal Workspace / Member-only CORE writes — **blocked** by ProspectWriteGate (§2.5). |
| **2. Usage Limits / Cost Control** | How much resource may this Prospect consume over the trial window? | **Design + measurement now**; **no numeric caps, Billing, or Quota product in Wave 1.0** until **U1** is approved. |
| **3. Conversion** | When do we invite Explicit Join? | When the user asks for Member-only value, and/or when usage approaches a future limit (U1). Copy = **D1b Open**. |

```text
Product permission refuse  ≠  usage-budget refuse  ≠  conversion offer

Example:
  “Save this to my list”     → Permissions plane → join / Member CORE
  “Keep chatting after cap”  → Usage plane (future) → pause or soft-stop + conversion
  Mid-trial curiosity        → still full conversational Lucy within budget
```

**Hard distinction:** Hitting a future usage limit must **not** be expressed as “you are Prospect so Lucy cannot converse.” Permissions stay about **Workspace / Member capabilities**; usage stays about **resource budget**.

#### 2.9.2 Costs a Prospect turn can generate (today’s stack)

| Cost driver | Where it shows up | Notes |
|-------------|-------------------|--------|
| **LLM chat turns** | `recordLlmUsage` → `LlmUsages` (`input`/`output`/`cached`/`reasoning` tokens, `costUsd`, `purpose` e.g. chat) | Dominant variable cost per message |
| **Secondary LLM** | Same table; purposes such as tips, weather tip, reminder compose, live_select, missions, images | Can multiply cost without “chat” feeling heavier |
| **Live / external APIs** | Weather, market, places, routes, flights, Mashov, etc. when ACTION emits them | Infra + provider fees; often gated today for guests — Prospect policy should stay explicit later |
| **WhatsApp channel** | Inbound processing + outbound free-form within 24h window (`whatsapp-window`) | Meta conversation pricing / session economics (outside app DB today) |
| **App infra** | DB reads/writes, invite present, jobs scheduling if any, hosting CPU | Smaller per turn; still real at abuse scale |
| **Asker-side** | Creating invites / drafts | Charged to asker account; not Prospect burn — keep attribution separate |

Prospect **Product Permissions** already reduce some write-side fan-out; they do **not** zero LLM or WhatsApp cost for a long exploratory chat.

#### 2.9.3 Measurement model (what to record to price a Prospect)

Reuse and extend existing `LlmUsages` + conversation metadata — **no Billing product required** to start measuring.

| Metric | Grain | Source (existing / planned) | Why |
|--------|-------|------------------------------|-----|
| `userId` + ConsentStage | Account | User (+ C1 when approved) | Isolate Prospect cohort |
| `employeeId` / phone | Speaker | Employee | Abuse / multi-device later |
| Invite linkage | Optional `inviteId` | WhatsAppInvite bind | Cost of contextual acquisition vs organic Prospect |
| Turn count | Per conversation / per day | ChatMessage or turn counter | Simple volume |
| LLM tokens | input / output / cached / reasoning | `LlmUsages` | Primary AI burn |
| LLM `costUsd` | Per row + rollup | `LlmUsages` + `LlmModelPrices` | Already computed when prices exist |
| LLM `purpose` mix | chat vs tips vs live helpers | `LlmUsages.purpose` | Spot secondary burn |
| Wall-clock trial age | First Prospect inbound → now | User/Employee `createdAt` or first message | Duration window |
| WA session opens | 24h windows touched | `WhatsAppInbound` / window helpers | Channel cost proxy |
| Conversion outcome | joined / abandoned / expired | ConsentStage transition + invite status | ROI of trial |

**Attribution rule:** Roll up **Prospect-attributable** spend as LLM (+ later WA estimates) on turns while ConsentStage = Prospect. Do not blame asker’s share-apply costs on the Prospect.

**Wave 1.0 coding implication (when implementation is approved):** Prefer **instrumentation / dashboards** over enforcement. Enforcement hooks can be designed as a future `ProspectUsageGate` **beside** (not instead of) ProspectWriteGate — still same pipeline, fail closed only when U1 says so.

#### 2.9.4 Future quota shape (policy open — U1)

No numbers locked. Recommended **knobs** product may combine later:

| Knob | Controls | Experience note |
|------|----------|-----------------|
| Token or USD budget per Prospect | Hard AI burn | Prefer soft warning before hard stop |
| Turn / day caps | Simple abuse brake | Must not feel like “Lucy is dumb,” only “trial pause” |
| Calendar trial window (e.g. N days from first inbound) | Duration | Align with invite TTL thinking, not replace it |
| Cap on expensive purposes | live APIs / image / missions | Keep ordinary chat available longer |
| Cap on concurrent cold Prospects per asker | Acquisition abuse | Protects asker-driven invite storms |

**Design for meaningful trial:**

1. Budget enough headroom for orientation + invite value + several natural turns.  
2. Soft conversion when user requests Member-only capability (**Permissions**), independent of budget.  
3. Soft conversion when approaching usage limit (**Usage**), without stripping conversational quality before the limit.  
4. At limit: pause further **billable** turns with a clear join path — do not silently degrade model quality or invent a guest prompt engine.  
5. After Explicit Join: usage plane switches to Member policy (out of Wave 1 Prospect scope).

#### 2.9.5 Preventing unlimited unpaid use (without locking numbers)

| Control | Plane | Wave 1.0 |
|---------|-------|----------|
| ProspectWriteGate (no durable Workspace) | Permissions | In scope when coding |
| Explicit Join for Member value | Permissions + Conversion | Hook in plan; copy D1b |
| Measure Prospect LLM USD/tokens | Usage | Recommended as soon as ConsentStage exists |
| Numeric trial budget / window | Usage | **U1 Open** — not implemented now |
| Abuse anomalies (extreme token/day) | Usage / ops | Future alert; optional emergency kill-switch under separate approval |
| Billing / paid plans | Monetization | Out of invite Wave 1 |

Unlimited free Member-equivalent **Workspace** is already blocked by Permissions. Unlimited free **chat burn** needs the Usage plane (U1) — measurement first, caps second.

#### 2.9.6 Architectural recommendation (advisory — not a numeric decision)

```text
sendChatMessage (one system)
  → Pending Invite Mediation
  → LLM / validate ACTION
  → ProspectWriteGate          // Permissions: Member capabilities
  → [future] ProspectUsageGate // Usage: budget / window (U1) — separate check
  → CORE apply if both allow
  → Conversion prompts when Permissions deny OR Usage nearing limit
```

| Recommendation | Rationale |
|----------------|-----------|
| Keep three planes separate in code and UX copy | Avoid “Prospect = mute Lucy” |
| Reuse `LlmUsages` as the cost spine | Already has tokens, USD, purpose, employee ids |
| Tag rollups by ConsentStage (+ inviteId when present) | Enables trial ROI without Billing |
| Add `ProspectUsageGate` only after U1 | No premature quota product |
| Soft-stop + join > quality degradation | Preserves brand and conversion |
| Do not use Product Permissions to approximate cost control | Would block harmless trial chat or miss expensive chat |

**U1 remains Open:** which knobs, which numbers, soft vs hard stop, and whether Wave 1.0 ships measurement-only or also a temporary emergency cap.

---

## 3. New components vs reused

### 3.1 New (mediation / invite track — policy only)

| Component | Purpose |
|-----------|---------|
| ConsentStage reader/writer | Prospect/Member; **writes only after C1 approval** |
| **Pending Invite Mediation** | Lifecycle + present vs schedule-CORE-apply (§2.1); not a write engine |
| InviteLifecycle helpers | Lazy 14d expiry; asker cancel; status `expired`; §2.8 |
| Payload v2 parse/validate | Beside existing `parseCollabInvitePayload` |
| InviteValuePresenter | Scoped context into **same** prompt assembly (§2.4.1) |
| **ProspectWriteGate** | Pre-apply authz on **same** ACTION; Member = pass-through |
| ExplicitJoinHandler | Dedicated signal; then same CORE Member path |
| Intent-specific draft builders | Lucy brand + CTAs (D11) |
| Asker pending notices | ממתין aligned with §2.8 |
| Prospect cost rollup (measurement) | Tag/aggregate `LlmUsages` by ConsentStage (+ invite) — §2.9; **not** Billing |
| **Future** `ProspectUsageGate` | Usage plane only after **U1**; separate from ProspectWriteGate |

These are **not** a second Prompt/Action/CORE stack.

### 3.2 Reused as-is (CORE)

`planTargetedActions`, `applyEmployeeRecords`, `applyListOps`, reminder apply, `createJobsFromRelays` (registered paths only), WhatsApp send/window, contact resolution, token bind/phone match, `confirmCollabInvite` write transaction for Member Share / Assign accept.

### 3.3 Evolve in place (not parallel systems)

| Existing | Evolution |
|----------|-----------|
| `WhatsAppInvite` | payload v2; lazy expiry; asker cancel; lifecycle §2.8 |
| `collab-invite.service` | Split Share vs Assign apply policy; presentation for Assign; Prospect skip co-mutate |
| `whatsapp-invite.service` | Drafts by intentKind; opening context + presenter hooks |
| `chat.service` hooks | IntentPolicy + **pre-apply** ProspectWriteGate; no post-write gate |
| `createIndependentWhatsAppAccount` | Still creates early User (R1); new accounts → Prospect **after C1** |

---

## 4. Touch points with CORE (hooks only)

| Hook point | File (likely) | Mediation action | CORE write? |
|------------|---------------|------------------|-------------|
| Speaker resolve | `whatsapp.service` | Attach ConsentStage | Identity create only (existing) |
| Invite bind | `whatsapp-invite.service` | Lazy expire; phone match unchanged | Status update |
| Pre-facts pending **present** | `chat.service` (replace unconditional auto-apply) | IntentPolicy + InviteValuePresenter | **No** write for Prospect Share |
| Invite value present | formatters / fact injection | Live scoped read if authorized | **No** `visibleTo` |
| Prompt context | invite + collab formatters | Value + Assign present | No |
| **Pre-apply gate** | After ACTION validate, before apply | ProspectWriteGate + write IntentPolicy | Refusal / strip only — **before** side effects |
| `confirmCollabInvite` | Only via CoreRouter after gate allows | Member Share / Assign accept | Yes (existing tx) |
| Explicit join | dedicated signal (D1b TBD) | Prospect→Member; then gated confirm if pending Share | Yes via existing confirm (idempotent) |
| Asker deferred create | `createDeferredCollabInvites`, cold invites | v2 payload + drafts | Invite row only |
| Asker cancel | invite lifecycle | status cancelled | No domain row; presenter stops next turn |

**Principle:** every durable Tasks/Lists/Filing/Reminders/Jobs mutation still flows through today’s apply functions — mediation may **block before invoke**, not reimplement them, and not “fix after.”

---

## 5. Proposed CORE / schema changes — **not approved**

> Per D0: do **not** include in implementation until you approve each item. Prefer mediation alternatives first.  
> **C1: recommendation only — not approved.**  
> **C2: outside approved planning baseline** until proven need + explicit approval.

### C1 — Persist ConsentStage (`consentPending` or equivalent) — **RECOMMENDATION ONLY**

#### Need

R1 requires a durable Prospect vs Member distinction across turns. Mediation can interpret a flag; it cannot invent durable storage without Schema (or an approved equivalent).

#### Why not invite-row-only

Wave 0 R1 is **account-level** until explicit join — not “Prospect only while one invite is open.”

#### Recommended field location: **`User`**

| Option | Pros | Cons |
|--------|------|------|
| **`User.consentPending` (recommended)** | Matches account-level R1; one stage per independent Lucy account; digitals/employees don’t each need a flag | Requires reading User on WhatsApp turns (already have `userId`) |
| `Employee.consentPending` on owner human | Closer to speaker row | Ambiguous with multi-human accounts; easy to desync; guest/legacy rows confuse meaning |
| Reuse `isGuest` | Already exists | **Wrong model** — guest = host shell, and independent path already sets `isGuest: false` |

**Transition mechanism (recommended):**

1. **Read:** ConsentStage from `User` (after C1 exists).  
2. **Clear Prospect → Member:** only `ExplicitJoinHandler` on dedicated join signal (D1b copy later).  
3. **Never clear on:** name, gender, chat, viewing value, Assign ack.  
4. **New path B/C accounts** (`createWhatsAppOnlyUser`): create as Prospect.  
5. **New path A (`createUser`):** create as Member **only if** that registration path **includes the required consent in product reality** — see **C1-A** (Open). If today’s `createUser` is credentials-only without join/terms, it must **not** silently mint Member; wire consent into that flow or create as Prospect until Explicit Join.  
6. **Legacy path D (guest):** leave on host-guest track; do not auto-map into independent Prospect without a separate decision.

#### Migration classes — audit labels, not auto-decisions

| Class | Who | Role of class | Stage decision |
|-------|-----|---------------|----------------|
| **M1** | `User.username` present (path A) | Credentialed account | Member **iff C1-A** says that path embeds required consent; else not automatic |
| **M2** | WhatsApp-only with established workspace / activity evidence | **Audit cohort only** | **C1-M2 Open** — must **not** be auto-Member from activity alone (R1 = Explicit Join) |
| **P1** | WhatsApp-only without established workspace evidence | Audit cohort | Default lean **Prospect** unless product says otherwise |
| **P2** | New accounts after ship (path B/C) | Future default | **Prospect** until Explicit Join |
| **L1** | `isGuest: true` / host promote | Legacy track | Not independent Prospect/Member |
| **U1** | Ambiguous WhatsApp-only | Audit cohort | No silent decision |

**C1-M2 — open product decision (required before migration approval):**

R1 requires Explicit Join. Workspace/activity evidence proves **usage**, not consent.

| Option | Meaning | Implications |
|--------|---------|--------------|
| **Grandfather M2 → Member** | Continuity for existing WhatsApp-only power users without a new join act | UX continuity; lower support friction; **weakens strict R1** for that cohort; must document exception; risk of treating non-consenting historical auto-accounts as Members |
| **Require Explicit Join for M2** | Same R1 for old and new; activity does not grant Membership | Principled consent; existing users hit ProspectWriteGate until they join; may surprise users mid-flight; needs careful messaging (D1b) and possibly a one-time re-consent campaign |

**Audit counts inform sizing and risk — they do not choose Grandfather vs Re-join.**

**Before any Schema migration is approved:** read-only audit counts + explicit product choice on **C1-M2** and **C1-A**.

#### Regression risk

Medium–high if misclassified: real members blocked from saves, or Prospects treated as Members. Mitigation = open decisions resolved explicitly + eval fixtures per class.

#### Approval

**Not approved.** No Schema change until explicit C1 approval including C1-M2 and C1-A.

---

### C2 — Prospect read via early `visibleTo` — **OUT OF APPROVED BASELINE**

| | |
|--|--|
| **Status** | **Not in approved plan.** Do not design implementation around it. |
| **When revisit** | Only after S1 proves live `contentRef` presenter cannot deliver original value, with written gap analysis |
| **If ever proposed** | Temporary `visibleTo` + hard mutate block — **not** product view-only Share (D9); requires explicit approval; high regression risk |
| **Default** | Prefer §2.4 live presenter indefinitely |

---

### C3 — Invite `expiresAt` column

| | |
|--|--|
| **Need** | 14-day TTL. |
| **Default** | Lazy `createdAt + 14d` — **no** schema change. |
| **Approval** | Not required if lazy-from-`createdAt` accepted. |

### C4 — Broaden CORE planners for Prospect ACL

| | |
|--|--|
| **Default** | Avoid — ProspectWriteGate in mediation (pre-apply). |
| **Approval** | Escalate only if gate holes remain. |

**No other CORE refactors are in Wave 1.0 scope.**

---

## 6. Staged delivery order (recommended)

> **Gate:** Do not start Stage A or later until this plan is approved for implementation **and** required Schema items (C1, including C1-M2 / C1-A) are separately approved. Spikes below are planning/analysis only unless you later authorize code spikes.

### Spike S0 — Freeze map (docs/analysis only)

Confirm call sites in §1; list every write entrypoint that ProspectWriteGate must wrap **pre-apply**; confirm no post-write “gate.” No behavior change.

### Spike S1 — Prospect read path security design (docs/analysis only)

Validate live `contentRef` + §2.4.1 conditions; list/item scope; revoke on cancel/expiry mid-chat. **C2 stays out.**

### Spike S1b — C1 account audit (read-only DB/product counts)

Produce class counts; **do not** pick C1-M2 from counts. **No Schema.**

### Stage A — Invite lifecycle & drafts (only after implementation approval)

1. Payload v2 parse/write beside v1  
2. Intent-specific Lucy drafts + asker ממתין notices (§2.8)  
3. Lazy 14-day expiry on bind/present/apply  
4. Asker cancel pending contextual invite  
5. Registered partner closed-session → forwardable contextual draft  

**Exit:** Asker pending honest; expire/cancel correct; no consent Schema required for A if drafts/expiry are invite-row only.

### Stage B — Consent stage (depends on **separate C1 approval**)

1. Persist Prospect/Member per approved C1  
2. New WhatsApp accounts → Prospect  
3. Migration per **approved** C1-M2 / C1-A decisions (not audit auto-pick)  
4. ExplicitJoinHandler structural hook; **copy gated on D1b**  
5. Name / gender / chat / view value **do not** join  

### Stage C — IntentPolicy apply split

1. Replace unconditional auto-apply with mediation policy  
2. Assign: present + ack/decline  
3. Share + Prospect: InviteValuePresenter only; stays pending  
4. Share + Member / post-join: gated `confirmCollabInvite` once  
5. Send: present + consume rule per §2.8  

### Stage D — ProspectWriteGate + private-data rule

1. Wire gate **after validate, before any side effect** (§2.2)  
2. Cover all durable paths including `confirmCollabInvite`  
3. Allow chat + scoped invite presentation  
4. Refuse silent personal stand-in on asker Share path  

### Stage E — Hardening & regression

Pack evals; Prospect→Member idempotent Share; Assign ack; cancel/expiry revoke mid-chat; wrong-phone bind; Member Share regression; double-apply attempts.

**Not in Stages A–E:** Check-with cold, shell deferred, ReferralCampaign, Templates, soft-try tips, D2b, C2.

---

## 7. Test & regression plan

### 7.1 Preserve (must stay green)

| Suite / area | Why |
|--------------|-----|
| `collab-invite.eval-db.test.ts` | Deferred share/assign continuity |
| `whatsapp-identity.eval-db.test.ts` | Independent accounts |
| `cross-account-share.test.ts`, `share-unified-*.eval-db.test.ts` | Member co-mutate |
| `shell-share-verify.eval-db.test.ts` | Registered shell share (no deferred expansion in 1.0) |
| `whatsapp-invite.test.ts` | Token/draft/bind |
| Core list/filing/reminder packs | No CORE rewrite regressions |
| Jobs tests for **registered** paths | Unchanged 1.0 behavior |

### 7.2 New / extend for Wave 1

| Case | Expect |
|------|--------|
| Prospect + Share | Scoped item/filing value; **no** `visibleTo` / co-mutate; invite remains `pending` |
| Presenter: bad `contentRef` / wrong owner | No present |
| Presenter: cancel/expire mid-thread | No further present |
| ProspectWriteGate order | Blocked ACTION never leaves durable writes |
| Prospect personal save (list/filing/reminder/directory/jobs) | Refused pre-apply |
| Prospect chat + view value | Allowed; still Prospect |
| Prospect name / gender | Still Prospect |
| Explicit join → pending Share | Single `confirmCollabInvite`; retry no-op |
| Join ≠ Assign accept | Assign still needs ack |
| Assign accept/decline | `consumed` / `cancelled` |
| Lazy expiry / asker cancel | No apply / no present; asker not “done” |
| Wrong phone + token | No bind / no value |
| Asker ממתין | Matches §2.8 pending meaning |
| Member Share regression | Same as today co-mutate |
| Migration | Follows approved C1-M2 / C1-A — not activity auto-Member |

### 7.3 Explicitly not tested as success in 1.0

Cold Check-with on invitee; shell deferred invite; ReferralCampaign; Templates; D2b; C2 visibleTo path.

### 7.4 Regression strategy

1. Existing share/identity/invite packs after Stage A and C.  
2. IntentPolicy + ProspectWriteGate unit matrix (including “no write if gated”).  
3. Eval-db: presenter revoke, write block, Explicit join idempotency, Assign ack.  
4. After C1: tests per **approved** migration policy.  
5. No final consent copy until D1b.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Gate runs too late | Normative §2.2 pre-apply placement; tests that assert zero writes on block |
| Building a Prospect parallel engine | Forbidden by §0; review PRs for second prompt/apply stack |
| Using Permissions to fake cost control | Keep Usage plane separate (§2.9); don’t mute trial chat |
| Shipping numeric quotas without U1 | Measurement-only until product locks U1 |
| Regressing Member Share/Assign | ProspectWriteGate pass-through for Member; D9 CORE unchanged |
| Accidental Prospect co-mutate | No `confirmCollabInvite` for Share until Member; gate covers confirm |
| Confusing Invite Mediation with WriteGate | Keep concerns separate (§2.1) |
| Snapshot / payload trust | §2.4.1 S1–S6; live owner-verified resolve |
| List over-exposure | Item/filing scope only (§2.4.2) |
| Chat continuation treated as join | ExplicitJoinHandler only; D1b Open |
| M2 auto-Member from activity | **Forbidden**; C1-M2 open product choice |
| `createUser` ⇒ Member without consent | **C1-A Open**; no silent Member mint |
| C2 / CORE creep | C2 out of baseline; D0 escalation |
| Double Share apply on join | Transactional claim + idempotent join handler |
| Starting coding too early | Plan status = not approved for implementation |

---

## 9. Prerequisites before coding starts

1. This plan approved for **implementation** (separate from “direction OK”).  
2. **C1** separately approved (field location + **C1-M2** + **C1-A** + audit numbers as input only).  
3. **S1** design accepted (live presenter + §2.4.1); **C2 not assumed**.  
4. D1b remains Open — no final Hebrew consent UX.  
5. D2b remains Open.  
6. No Wave 1.1 / Wave 2 items in first implementation PRs.  
7. No Stage A start until (1).

---

## 10. What “done” means for Wave 1.0

- **One system:** same conversation, ACTION, validation, and CORE for Prospect and Member; differences are context + authorization only (§0).  
- **Three planes:** Product Permissions ≠ Usage Limits ≠ Conversion (§2.9); no inferior Prospect Lucy; numeric quotas remain **U1 Open**.  
- Pending Invite Mediation and ProspectWriteGate remain distinct concerns; Member CORE behavior unchanged.  
- Contextual Send / Share / Assign invites use one `WhatsAppInvite` spine (v2) with lifecycle §2.8.  
- Prospect receives invite value under §2.5; no full personal workspace; no durable saves.  
- ProspectWriteGate is pre-apply and covers all relevant write paths (Member pass-through).  
- Invite cancel/expiry revokes presenter access mid-conversation.  
- Explicit join only → Member; then Share = existing CORE co-mutate once.  
- Assign requires explicit ack (≠ join).  
- Asker cancel + 14-day lazy expiry work; pending means ממתין.  
- Drafts branded Lucy.  
- CORE unchanged except **separately approved** §5 items.  
- D1b, D2b, C1-M2, C1-A still Open as applicable; C2 not shipped; deferred tracks untouched.

---

## Remaining open decisions — with implications

| ID | Decision | Status | If chosen A | If chosen B / notes |
|----|----------|--------|-------------|---------------------|
| — | One system / one CORE / ConsentStage policy (§0) | **Accepted** | — | Dual Member/Prospect engines forbidden |
| — | Architectural direction (mediation on CORE) | **Accepted** | — | — |
| — | Three planes: Permissions / Usage / Conversion (§2.9) | **Accepted as structure** | — | Numeric usage policy still **U1 Open** |
| — | Plan approved to start Stage A coding | **Not yet** | Enables implementation PRs | Remains docs-only |
| **D1b** | Exact Hebrew consent / join UX copy | **Open** | — | Must not invent copy; join hook waits on wording |
| **D2b** | Recipient self-unshare / decline after Share grant | **Open** | Allow decline-after-grant → need post-consume revoke UX | Disallow → access sticks until asker removes; document |
| **C1** | Persist ConsentStage on `User` (recommended shape) | **Not approved** | Unlocks Stage B | Without it, Prospect/Member cannot be durable |
| **C1-M2** | Grandfather active WhatsApp-only users as Member vs require Explicit Join | **Open** | **Grandfather:** continuity; R1 exception for cohort; consent weaker for history | **Re-join:** strict R1; existing users may lose durable saves until join; needs messaging |
| **C1-A** | Does `createUser` / web registration include required consent so new users are Member at create? | **Open** | **Yes (consent in flow):** path A → Member at create | **No:** path A must not auto-Member; add consent or start Prospect |
| **U1** | Prospect usage quota policy (which knobs + numbers + soft/hard stop) | **Open** | Measurement-only first (recommended) | Caps / windows / purpose limits — product picks numbers later |
| **C2** | Early `visibleTo` for Prospect read | **Out of baseline** | Only if S1 fails + explicit reopen | Default: live presenter |
| **S1** | Live presenter + §2.4.1 as baseline | **Preferred — confirm at plan approval** | Proceed without C2 | If rejected, stop and re-plan read path |
| Send consume rule | Consume on successful present | **Clarified** | Consume on present for asker “delivered”; content stays in chat history; Member save after join uses history/CORE save — **no gap** | Leave pending until TTL only if product prefers; still must not erase chat content |

### Contradictions

| Topic | Finding |
|-------|---------|
| Prior §2.2 “gate after CORE loop” vs “pre-apply” | **Resolved** — pre-apply only is normative |
| Dual Prospect runtime vs one CORE | **Resolved** — §0 / §2.2b: policy only, same engines |
| Pending Invite Mediation vs ProspectWriteGate | **Clarified** as two concerns, not two systems (§2.1) |
| Product Permissions vs cost control | **Clarified** — three planes (§2.9); Usage ≠ Permissions |
| Inferior Prospect Lucy | **Rejected** — meaningful trial; budget via Usage plane (U1), not crippled engine |
| M2 auto-Member from workspace evidence vs R1 Explicit Join | **Open C1-M2** — no automatic choice |
| `createUser` ⇒ Member vs missing consent in flow | **Open C1-A** |
| Wave 0 locks | **No new contradictions identified** |
| D9 vs Prospect read-only | Temporary mediation authorization delay; Member Share CORE unchanged |
| Assign ack vs Explicit Join | Kept separate (§2.6 / §2.8) |

---

*End of Wave 1 implementation plan (planning refinement). No implementation started. No Schema approved.*
