# Lucy — Cross-User Communication, Sharing, Collaboration & Growth

**Type:** Current-state audit + proposed architecture + staged plan  
**Status:** For approval — **no code, schema, prompt, test, or config changes**  
**Updated:** 2026-11-17  
**Related:** `lucy-existing-capabilities-gap-audit.md`, `lucy-family-collab-experience-gaps.md`, `lucy-phase1-identity-invitation-design.md`, `lucy-phase2-share-assign-invitation-discovery.md`, `lucy-household-implementation-plan.md` (**deferred**)

## How to read

| Label | Meaning |
|-------|---------|
| **Exists / Works** | Verified in production paths |
| **Partial** | Exists for some intents/content only |
| **Missing** | Required by this PRD; not in code |
| **Conflict** | Current behavior contradicts a PRD principle |
| **Extend** | Prefer grow existing module |
| **New** | New abstraction justified |
| **P0–P3** | Priority for staged delivery |

Semantic intents (do **not** collapse): **Send/Forward**, **Share**, **Assign**, **Check-with**, **Coordinate**, **Collaborate**.

---

## A. Current-state table

### A.1 Identity & accounts

| Component | Today | Where | Works? | Intents supported | Gap vs PRD | Path | Priority |
|-----------|-------|-------|--------|-------------------|------------|------|----------|
| Phone → account | Unique `Employee.phone`; prefer non-guest match | `whatsapp.service.ts` `findExistingWhatsAppSpeaker` | Yes | All | — | Extend | — |
| New phone | Own `User` + owner human + Lucy **immediately** on first inbound | `createIndependentWhatsAppAccount`, `createWhatsAppOnlyUser` | Yes for independence | Arrival | **Conflict:** PRD forbids account without consent; code creates account on first message | Product lock + Extend | **P0** |
| Guest/host promote | Legacy: guest → host Team `New Registered 30 days` | `guest-register.service.ts` | Legacy only | Old invite | Conflicts with independent-account product | Cleanup later | P2 |
| WhatsApp profile name | Not used for preferred Hebrew name | Inbound parsing has shared-contacts; **no pushName → preferred name** flow found | Missing | Onboarding | PRD wants “ask if this name is OK” | New light | P1 |
| Address gender | `addressGender` + SPEAKER_ADDRESS ask | `speaker-address.ts`, chat rules | Yes | All chats | — | Extend | — |

### A.2 WhatsApp send / 24h window

| Component | Today | Where | Works? | Intents | Gap | Path | Priority |
|-----------|-------|-------|--------|---------|-----|------|----------|
| Session window | `WhatsAppInbound.lastInboundAt`; 24h | `whatsapp-window.ts` | Yes | Outbound gate | Treated mainly as **technical** gate, not growth opportunity | Extend + product | **P1** |
| Free-form outbound | Skip when no session | `whatsapp-send.ts`, `deliverWhatsAppRelays` | Yes | Send to registered | — | Extend | — |
| Cold path (asker’s personal forward) | Draft + `wa.me` compose URL | `whatsapp-invite.service.ts` `buildFatherInviteDraft`, `buildWhatsAppComposeUrl` | Yes | Message + deferred collab | Copy is **generic**; CTA not action-specific | Extend | **P0** |
| Template / business-initiated | Not implemented; **out of invite/acquisition scope** | `whatsapp-send.ts` has no template send; window in `whatsapp-window.ts` | N/A now | — | Future: existing-user service/reminders when window closed — separate workstream | Defer | Future |
| Open link without message | Token in prefilled text; **no inbound until user sends** | Documented in product; Graph reality | Known | Invites | PRD correctly notes link-open ≠ session; process must require send | Design | — |

### A.3 Send / Forward

| Component | Today | Where | Works? | Intents | Gap | Path | Priority |
|-----------|-------|-------|--------|---------|-----|------|----------|
| Text to known human | `messages[]` → relay / WhatsApp | `employee-targets.service.ts`, `chat.service.ts` | Yes | Send | Exact quote confirm in prompt | Extend | — |
| Text to contact phone | `planPhoneRelays` | `employee-targets.service.ts` | Yes | Send | — | Extend | — |
| Send when no 24h | Cold `WhatsAppInvite` (null payload) + draft | `buildColdInvitesForNoSession` | Yes | Send / check-with text | Draft language “העברה/בירור”; not rich content packaging | Extend | P0 |
| Forward prior Lucy bubble / recipe-as-content | Model can put text in `messages[].text` | Prompt TELL/SEND | Partial | Forward text | No first-class “forward this saved object id” ACTION; quality depends on model | Extend prompt + maybe refs | P1 |
| Forward filing / document / media to **third party** | `send_attachments` delivers to **speaker** channel after reply; `deliverAttachmentsToPhone` exists | `chat.service.ts`, `attachment.service.ts` | Partial | Media to self | **No** standard “send these attachment_ids to Maya” in ACTION contract | Extend | **P1** |
| Scheduled send | `reminders` + compose | reminder services | Yes | Send later | — | Extend | — |

### A.4 Share

| Component | Today | Where | Works? | Intents | Gap | Path | Priority |
|-----------|-------|-------|--------|---------|-----|------|----------|
| Item co-share | One owner row + `visibleTo` | `planTargetedActions`, records | Yes | Share (edit co-owned) | No view-only share distinct from co-mutate | Product + Extend | P1 |
| Shell list share | `list_ops` add_participants | `list-ops.service.ts` | Yes for **registered** partners | Share list | Unknown name → `unknown_participant`; **no** deferred invite | Extend | **P0** |
| Filing share | targets / visibleTo | records + targets | Yes | Share filing | — | Extend | — |
| Cross-account via contacts | Phone → registered Employee | `contact.service.ts` `resolveExternalSharePartners` | Yes | Share/Assign | Partner must be in contacts with phone | UX | P1 |
| Deferred share (unregistered) | `WhatsAppInvite.payload` share | `partitionDeferredCollabTargets`, `collab-invite.service.ts` | Yes for **item/filing add** | Share | Auto-apply on first turn; draft not share-specific; no decline UX | Extend | **P0** |
| Dump clarity | Marks `(A,B)` / headers משותפת | `show-button-dump.ts`, ESD | Yes when user asks show | Share | First-turn may not narrate | UX/prompt | P0 |
| Notify partner | `fallbackNotificationText` «שיתף איתך» | `employee-targets.service.ts` | Yes if WA session | Share | Registered + closed session: **no** cold draft | Extend | **P0** |

### A.5 Assign / Check-with / Coordinate / Collaborate

| Component | Today | Where | Works? | Intents | Gap | Path | Priority |
|-----------|-------|-------|--------|---------|-----|------|----------|
| Assign | Fan-out row; `addedById`; mark באחריות | `planTargetedActions` | Yes | Assign | Deferred assign works like share | Extend | — |
| Check-with / jobs | `expects_reply`, OPEN_JOBS, urgency, snooze | `jobs.service.ts`, chat OPEN_JOBS | Yes same-account / registered | Check-with | Cold invite resume via **guest** `continueInviteAfterRegister` → job on **inviter**; independent invitee **does not** get job | **Fix** | **P0** |
| Coordinate / book | `messages.book`, counter, dual save | jobs + tasks | Yes | Coordinate | Overlap prompt-only | Extend | P2 |
| Collaborate (“מי מביא מה”) | Shared custom list / co-share items; FCFS done | lists + share | Partial | Collaborate | No dedicated claim/slot UX; model+list patterns | Prompt + light | P1 |
| Semantic separation ASSIGN vs SHARE vs TELL | Prompt + planner | `LLM.config.json`, targets | Yes in engine | All | Model still confuses sometimes | Prompt/QA | Ongoing |

### A.6 Pending action / invite linkage

| Component | Today | Where | Works? | Gap vs PRD | Path | Priority |
|-----------|-------|-------|--------|------------|------|----------|
| Persist action at draft time | Yes for cold message + deferred collab | `createWhatsAppInvite` | Yes | Not for all content types; shell share missing | Extend → generic PendingAction | **P0** |
| Link phone + asker + kind | Yes | `WhatsAppInvite` + payload | Partial | Payload only share\|assign list/filing add | Extend schema of payload / table | P0 |
| No second confirm that asker sent | Yes (draft; server already pending) | Invite create | Yes | Asker UX may still sound “completed” if model lies | Prompt | P0 |
| Pending ≠ completed messaging | Partial | Cold notice Hebrew | UX | Need clearer “ממתין להצטרפות” | Prompt/engine notice | P0 |
| Expiry / cancel / decline / dedupe | Status strings; cancel collab; expire **never written**; accept presentation stubbed (`loadPresentedCollabInvites` → `[]`); auto-apply | invite + collab services | Partial | PRD edge cases incomplete | Extend | P0–P1 |
| Token security | Opaque `WRK-INV-…`; phone match for payload bind | `bindInboundToInvite` | Yes | Opened from wrong phone blocked for payload | Extend | — |
| Idempotent re-open | Consumed / rowId stable | `confirmCollabInvite` | Yes for collab | Message invites linger pending | Extend | P1 |

### A.7 Onboarding, consent, growth

| Component | Today | Where | Works? | Gap vs PRD | Path | Priority |
|-----------|-------|-------|--------|------------|------|----------|
| Account without consent | Created on first inbound | `createIndependentWhatsAppAccount` | Conflict | PRD §7 | Product + possibly soft “pending person” | **P0** |
| Contextual opening | `formatInviteOpeningContext` | `whatsapp-invite.service.ts` | Partial | Weak; not growth journey | Extend | **P0** |
| Consent / terms | Tip `guest_terms` aimed at לוסי-אורח | `tip-catalog.ts` | Stale path | Independent users don’t get guest ladder; no clear consent gate | Redesign onboarding | **P0** |
| Capability tips ladder | Member tips on shopping/tasks/… | `tips.service.ts`, catalog | Yes for members | Not invite-context growth; not “experience then offer save” | Extend tips + orchestration | **P1** |
| Growth use of 24h window | Window opens on inbound; tips/actions possible | window + chat | Accidental | No designed growth sequence per invite kind | New orchestration | **P1** |
| Resume original action after join | Collab auto-apply; jobs weak | collab + continueInvite | Partial | PRD requires always resume | Fix I1 + narrative | **P0** |
| Household | Deferred | household plan doc | N/A | Out of this track | — | — |

### A.8 Content types coverage

| Content | Send | Share | Collab/Assign | Notes |
|---------|------|-------|---------------|-------|
| Shopping / tasks items | Via message text | Strong | Strong | Core path |
| Custom lists | Text / shell | Shell if registered | Co-share items | Shell→unknown missing invite |
| Filings | Text paraphrase | Share yes | Assign yes | Media attach on filing; forward file to third party weak |
| Attachments / media | To speaker; phone helper exists | Via item/filing links | — | Cross-user send gap |
| Meetings / events | Book / message | Task share patterns | Coordinate / book | Complex events prompt-heavy |
| Prior Lucy reply / recipe blob | Model-composed `messages.text` | N/A as object | N/A | No durable “content blob” id for forward |
| Links | In message text | — | — | Works as text |
| Contacts / phone book | — | directory share | — | Separate |

### A.9 Tests / QA (evidence)

| Area | Tests |
|------|-------|
| Independent identity | `whatsapp-identity.eval-db.test.ts` |
| Deferred share/assign | `collab-invite.eval-db.test.ts` |
| Cross-account share | `cross-account-share.test.ts`, `share-unified-*.eval-db.test.ts` |
| Shell share | `shell-share-verify.eval-db.test.ts` |
| Cold invite unit | `whatsapp-invite.test.ts` |
| Jobs | `jobs.test.ts` |
| Tips | `tips.test.ts` |
| Attachments | `attachments.test.ts` |
| **Missing QA** | Growth onboarding journeys; consent-before-account; third-party media forward; shell deferred invite; check-with on independent invitee; expire ticker |

---

## B. Proposed architecture (generic, reuse-first)

### B.1 Do not build

- Household (deferred).  
- Second visibility system beside `visibleTo` / assign / jobs.  
- Collapsing Share into Assign or Send.  
- Team as cross-user graph.

### B.2 Core idea: **OutboundIntent** + **PendingDelivery**

Unify what today is split across `messages` relays, `WhatsAppInvite`, and collab payload — **without** replacing list/job engines.

```text
OutboundIntent (logical; may start as evolved WhatsAppInvite)
  id, token
  askerUserId, askerEmployeeId
  recipientPhone / recipientUserId?
  intentKind: send | share | assign | check_with | coordinate | collaborate
  contentRef: { type, id?, snapshot? }   // list item, filing, attachment[], text body, job ask…
  permissionHint: view | co_mutate | assignee | reply | book  // semantic, enforced by existing engines
  status: pending | delivered | consumed | declined | cancelled | expired
  expiresAt
  growthProfile?: tip ladder key / invite persona   // optional later

On recipient inbound (verified phone):
  1. Resolve/create identity per consent policy (P0 decision)
  2. Inject INVITE CONTEXT (who + why + intentKind)
  3. Apply via EXISTING executors only:
       send     → show/deliver text/media (no visibleTo)
       share    → planTargetedActions / confirmCollabInvite
       assign   → same
       check_with → createJobsFromRelays on recipient Lucy (fix host-only path)
       coordinate → book/job flows
  4. Optional growth turns (tips / soft offers) — never block original value
```

**Map to code today**

| Piece | Reuse |
|-------|--------|
| Token + wa.me draft | `whatsapp-invite.service.ts` |
| Deferred apply | `collab-invite.service.ts` `confirmCollabInvite` |
| Share/assign writes | `planTargetedActions`, `applyEmployeeRecords` |
| Jobs | `jobs.service.ts` `createJobsFromRelays` |
| Session | `whatsapp-window.ts` |
| Notify | `pushTargetNotification`, `fallbackNotificationText` |
| Tips | `tips.service.ts` — new **invite-context** seeds, not guest_terms alone |

**Extend `WhatsAppInvite` vs new table:** Prefer **evolve** `WhatsAppInvite` (richer payload `v:2` with `intentKind` + `contentRef`) to avoid parallel invite stores; keep null-payload = legacy send/check text. Only split tables if payload validation becomes unsafe.

### B.3 Permission layers (keep separate)

| Layer | Mechanism | When |
|-------|-----------|------|
| Delivery | WhatsApp / Lucy thread | Send |
| Visibility | `visibleTo` / list scope | Share |
| Responsibility | Assign fan-out + `addedById` | Assign |
| Conversation obligation | OPEN_JOBS | Check-with / coordinate |
| Account | User + phone | Independent Lucy |
| Growth | Tips / soft offers | After value delivered |

View-only share (if product wants it) is a **new permission mode** on share — not present today (co-share implies co-mutate). Mark as product decision.

### B.4 Growth loop (product architecture)

```text
Inbound opens 24h window
  → Deliver original value first (PRD §6.1)
  → One contextual soft offer (save / list / remind) — tips or prompt
  → Optional second step later in window
  → Consent + profile (name preference, address gender) when required by policy
  → Never dump full capability catalog
```

Does **not** require Household. Uses existing tip ladder machinery with new keys keyed by `intentKind` + content type.

---

## C. User flows (target vs today)

### C.1 Asker → registered recipient — Send

| Step | Target | Today |
|------|--------|-------|
| Resolve by phone | Yes | Yes via contacts/employees |
| Deliver text | Yes | Yes if session; else cold draft for message path |
| Context on recipient Lucy | “מאת X” | Relay attribution partial |
| Growth | Soft offer after read | Tips not invite-aware |

### C.2 Asker → registered — Share / Assign

| Step | Target | Today |
|------|--------|-------|
| Apply immediately | Yes | Yes |
| Notify | Yes | Thread + WA if session |
| Closed session | Forwardable contextual draft | **Skip only** — gap |
| Clarity marks | Yes | Dump marks work |

### C.3 Asker → unregistered — Share / Assign

| Step | Target | Today |
|------|--------|-------|
| Persist pending at draft | Yes | Yes (item/filing) |
| Asker UX “ממתין” | Yes | Partial (notice exists; model may over-claim) |
| Personal contextual invite copy | Action-specific | **Generic העברה** |
| Dynamic CTA label | Per intent | Fixed draft |
| Recipient sends message | Required | Required |
| Consent before User | Per PRD | **User created immediately** — conflict |
| Resume action | Yes | Auto-apply share/assign |
| Decline | Yes | Stubbed / auto-apply |
| Growth after value | Yes | Missing designed journey |

### C.4 Forward simple content

| Step | Target | Today |
|------|--------|-------|
| Text text/link | Yes | messages + cold invite |
| Forward saved object / files to third party | Yes | **Weak** |
| Then growth | Soft | Missing |

### C.5 Check-with / coordinate

| Step | Target | Today |
|------|--------|-------|
| Registered + session | Job / book | Works |
| Unregistered cold | Pending → job on invitee Lucy | **Broken** for independent accounts |
| Growth | Soft | Missing |

### C.6 Collaborate (shared list update)

| Step | Target | Today |
|------|--------|-------|
| Co-share list/items | Yes | Works when partner registered / deferred item |
| Shell to unknown | Deferred invite | **Missing** |
| “מי מביא מה” | Shared list + updates | Prompt patterns; no special claim engine |

### C.7 New user onboarding (target)

1. Open link → send message (required).  
2. Lucy: who + why + original value.  
3. Name preference (if WA profile available — **not wired**).  
4. Address gender if needed.  
5. Explicit join/consent (**policy conflict with auto User**).  
6. Resume original intent.  
7. One contextual try-Lucy offer.  
8. Continue as independent user.

---

## D. Staged implementation plan

### Open product decisions (block or shape stages)

| ID | Decision |
|----|----------|
| D1 | **Consent vs instant User:** keep create-on-inbound, or pending-person until consent? (PRD conflict) |
| D2 | Share/assign: keep **auto-apply** or require explicit accept? |
| D3 | View-only share vs today’s co-mutate share? |
| D4 | Is check-with / coordinate in wave 1 with share/send? |
| D5 | Growth aggressiveness in 24h (1 soft offer vs multi-step)? |
| D6 | Approved WhatsApp templates for re-engagement outside window? |
| D7 | Shell-list deferred invite in wave 1? |

### Wave 0 — Lock (no code)

Approve D1–D4, D7. Keep Household deferred.

### Wave 1 — Continuity honest (highest ROI, extend existing)

**Goals:** Pending actions feel complete and truthful for share/assign/send; fix independent check-with if D4=yes.

| Work | Files (likely) | Data | Tests |
|------|-----------------|------|-------|
| Action-specific invite draft + CTA strings by intentKind | `whatsapp-invite.service.ts`, collab create | payload metadata only | invite unit + collab eval |
| Asker copy: pending ≠ done | prompt + engine notice | — | model/eval |
| First recipient turn narrates applied share/assign | `formatInviteOpeningContext` / engine ack | — | collab eval |
| Refuse silent personal stand-in when share intended | `employee-targets.service.ts` | — | targets tests |
| Shell share → deferred invite (if D7) | `list-ops.service.ts`, partition helpers | payload domain list_shell? | new eval |
| Registered partner no_session → forwardable “open Lucy” draft (not second apply) | `chat.service.ts` notify path | optional invite row | whatsapp + share tests |
| Check-with resume on invitee Lucy (if D4) | `continueInviteAfterRegister` / new path | job on recipient user | jobs + identity eval |
| Align accept UX with D2 (wire presentation or document auto-apply) | `collab-invite.service.ts` | — | collab eval |
| Lazy expire pending invites | invite service | status expired | unit |

**Out of wave 1:** Household, view-only ACL, full growth campaign, third-party media ACTION, consent rewrite (unless D1 forces it).

### Wave 2 — Growth & onboarding (24h opportunity)

| Work | Depends | Notes |
|------|---------|-------|
| Invite-context tip seeds (shopping/task/event/filing) | Wave 1 context | `tip-catalog.ts` / tips service |
| Soft-offer orchestration after original value | Wave 1 | prompt + tip triggers; no capability dump |
| Preferred-name ask if profile available | WhatsApp inbound fields | Only if Graph provides name |
| Consent/terms for independent users | D1 | Replace guest_terms path |
| QA journeys: new user from share / from forward | — | eval-db multi-turn |

### Wave 3 — Generic content send/forward

| Work | Notes |
|------|-------|
| ACTION: send saved attachments / filing to recipient | Reuse `deliverAttachmentsToPhone` with session/cold rules |
| contentRef snapshots for text blobs / prior bubble ids | Avoid brittle paraphrase-only forward |
| Permission checks on attachment userId | Already actor-scoped; extend for cross-user send |

### Wave 4 — Semantic permission polish

| Work | Notes |
|------|-------|
| View-only share (if D3) | New visible mode or flag; dumps read-only for partner |
| Collaborate templates (“מי מביא מה”) | Mostly prompt + shared list; optional claim field later |
| Coordinate packaging | Book + invite continuity |

### Never in this program (without new approval)

- Team meaning change.  
- Household implementation.  
- Auto family see-all.  
- Aggressive multi-message marketing spam in 24h.  
- Assuming link-open creates inbound.

---

## Risks

| Risk | Mitigation |
|------|------------|
| Instant User vs consent PRD | Resolve D1 before Wave 2; don’t pretend guest mode is the answer |
| Overloading WhatsAppInvite | Versioned payload; keep parsers strict (`parseCollabInvitePayload` pattern) |
| Growth feels spammy | Value-first; one soft offer; tip maxShows |
| Model claims “שיתפתי” without ACTION | Existing SAY=DO rules; strengthen eval packs |
| Meta policy on business-initiated | Don’t design template growth until D6 |
| Two people named אורח | Push preferred name early (Wave 2) |

---

## Bottom line

Lucy already has a **strong spine** for cross-user work: independent accounts, Share/Assign (+ deferred invites), Send via messages, Jobs for check-with, 24h session tracking, and tip ladders.  

What the PRD adds beyond today’s family-collab gaps is mainly: **(1)** a **generic intent×content** pending-delivery model, **(2)** **growth-oriented** first sessions inside the WhatsApp window, **(3)** honest **pending vs done** UX and richer invite copy, **(4)** fixing **check-with / shell / registered-no-session** holes, and **(5)** resolving the **consent vs create-on-inbound** conflict.

Recommend approving **Wave 0 decisions** then **Wave 1** before any growth polish.

**Wave 0 extension:** see `lucy-wave0-decisions.md` §6. **Generic** + **Contextual** invitations = user-forwarded drafts (current acquisition priority). **WhatsApp Templates** = future infra for messaging **existing** users (near/after 24h window) — **not** part of invite/growth now; keep window detection (`whatsapp-window.ts`) so a later channel router can plug in. ReferralCampaign ≠ PendingDelivery.

---

*End of audit. No implementation. Awaiting approval.*
