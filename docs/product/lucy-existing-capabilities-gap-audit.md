# Lucy existing capabilities & product-gap audit

**Workstream:** Existing Capabilities & Product Gap Audit (reuse-first)  
**Updated:** 2026-11-17  
**Status:** Audit for review — **no code, prompt, database, configuration, or behavior change**  
**Scope:** Free ~20-user pilot · agreed product direction below  
**Related:** `lucy-product-discovery.md`, `lucy-phase1-identity-invitation-design.md`, `lucy-phase2-share-assign-invitation-discovery.md`, `lucy-guest-removal-plan.md`, `docs/features.md`

## How to read this document

| Label | Meaning |
|-------|---------|
| **Reuse as-is** | Keep the executor, schema, and tests; do not rebuild |
| **Prompt / orchestration** | Capability exists; exposure, instructions, or turn wiring is weak |
| **Small targeted code change** | Narrow edit on an existing path |
| **Genuine architectural change** | New concept or topology required for the agreed product |
| **Future / not for pilot** | Explicitly deferred |
| **Verified now** | Confirmed in current production paths (Official1 working tree) |

**Core principle:** product requirements do **not** imply a rebuild. Prefer reuse of lists, share/assign, jobs, reminders, invitations, and chat orchestration. Prefer prompt/context fixes when the engine already does the right thing.

---

## 0. Agreed product direction (audit baseline)

| # | Requirement |
|---|-------------|
| R1 | Every person has an **independent Lucy account** |
| R2 | **Registration is required** before participating in an invited action |
| R3 | **Household is optional**; may be offered at registration or later (Lucy or UI) |
| R4 | Each user belongs to **at most one household** during the pilot |
| R5 | Inviting someone to a **specific action does not** make them a household member |
| R6 | People can collaborate on **explicitly shared** actions/info without sharing entire household data |
| R7 | Pilot users receive **full** Lucy capabilities |
| R8 | Pilot **access duration / time limits are configurable** |
| R9 | **No billing** implementation (Stripe, plans, checkout) |
| R10 | Future monetization stays architecturally possible; **do not** decide per-user vs household pricing |

Earlier product-discovery text that treated guest/host-seat as the main topology is **superseded by shipped Phase 1–2 identity work** where noted below. Docs under `docs/features.md` §17–18 and parts of `lucy-product-discovery.md` §8 still describe older guest-on-host behavior and lag the working tree.

---

## 1. Capability inventory

### 1.1 Users and registration

| Piece | Verified now | Maturity | Paths | Tests |
|-------|--------------|----------|-------|-------|
| Web login (username/password) | Works; no public self-signup | **Full** | `auth.service.ts`, `auth.routes.ts`, `user.service.ts` `createUser` | `backend/tests/auth.test.ts`, `users.test.ts` |
| WhatsApp-only `User` factory | Credential-less `User` | **Full** | `user.service.ts` `createWhatsAppOnlyUser` | `users.test.ts` |
| Unknown phone → **own account** | Creates own `User`, human `isOwner: true`, `isGuest: false`, name `אורח…`, protected Lucy | **Full (shipped Phase 1)** | `whatsapp.service.ts` `resolveWhatsAppSpeaker` → `createIndependentWhatsAppAccount` | `whatsapp-identity.eval-db.test.ts` |
| Reuse existing phone | Prefers non-guest match; no second employee | **Full** | `findExistingWhatsAppSpeaker` | Same + phone unique constraint |
| Legacy guest registration | Still promotes guest **onto host** `New Registered 30 days` | **Legacy / conflict** | `guest-register.service.ts` `registerGuestMember` | `guest-register.test.ts` |
| Profile fields (name, gender) | Via `metadata.register` only on guest path today; independent users may stay named `אורח` with full capability | **Partial** | `chat.service.ts` register branch; `LLM.action.json` | Guest register tests; identity eval |

**Classification:** Independent-account creation → **Reuse as-is**. Host-promotion registration → **Genuine architectural change** (stop calling it for new product path; keep briefly for leftover shells). Profile-before-action (R2) → **Small targeted code change** + **Prompt/orchestration** (see §3, §5).

### 1.2 Guest handling

| Piece | Verified now | Maturity | Paths | Tests |
|-------|--------------|----------|-------|-------|
| `Employee.isGuest` + `isGuestEmployee` | Flag + name fallback (`אורח`) | **Present** | `shared/src/types.ts`, schema | Many |
| `לוסי-אורח` digital | Still **created** on every account via `ensureGuestLucy` | **Legacy** | `employee.service.ts` | `ensure-guest-lucy.test.ts`, `whatsapp-guest-routing.test.ts` |
| Guest capability gate | **`guestSpeaker` forced `false`** in `buildLucyInstructions` and `sendChatMessage`; `guestMutationBlocked` forced `false` in `planTargetedActions` | **Interim / experimental** | `chat.service.ts`, `employee-targets.service.ts` | `guest-capability-parity.eval-db.test.ts` (guests mutate like members) |
| Guest mode prompt text | Still in source; **unreachable** while `guestSpeaker=false` | Dead code path | `chat.service.ts` | — |
| Visibility for `isGuest: true` shells | Snapshot / routing still special-case guests in places | **Partial leftover** | `employee-records.service.ts`, `whatsapp.service.ts` routing | Guest routing / identity evals |

**Classification:** Product path for new users should **not** use guest. Remaining guest code → **Future cleanup** after data inspection (`lucy-guest-removal-plan.md`), not a rebuild of Lucy. Hardcoded `guestSpeaker=false` is a **small targeted** interim that already moves toward R7; docs that still say “guests view-only” are stale.

### 1.3 Lists and list sharing

| Piece | Verified now | Maturity | Paths | Tests |
|-------|--------------|----------|-------|-------|
| Built-in shopping / tasks / contacts | Full CRUD via ACTION | **Full** | `employee-records.service.ts`, `builtin-lists.ts` | `employee-records.test.ts`, shopping/tasks packs |
| Custom lists + columns | `list_ops` alter/delete | **Full** | `list-ops.service.ts` | `list-ops.test.ts` |
| Item co-share | One owner row + `visibleTo`; FCFS done | **Full** | `employee-targets.service.ts` | `share-unified-*.eval-db.test.ts` |
| Whole-list shell share | `alter_list` add/remove_participants | **Full** | `list-ops.service.ts` | `shell-share-verify.eval-db.test.ts` |
| Cross-account partners | Contact phone → registered non-guest `Employee` | **Full** | `contact.service.ts` `resolveExternalSharePartners` | `cross-account-share.test.ts` |
| Deferred share to unknown phone | Invite + payload; apply on recipient turn | **Full (Phase 2)** | `partitionDeferredCollabTargets`, `collab-invite.service.ts` | `collab-invite.eval-db.test.ts` |

**Classification:** **Reuse as-is.** This is the collaboration model for R5–R6. Do not invent a second sharing system.

### 1.4 Tasks, assignments, collaboration

| Piece | Verified now | Maturity | Paths | Tests |
|-------|--------------|----------|-------|-------|
| Tasks list + standing recurrence | Full | **Full** | `list-recurrence.ts`, shared recurrence | `recurrence.test.ts`, reminder-recurrence tests |
| Assign (הטלה) | Fan-out onto assignee book; `addedById` | **Full** | `planTargetedActions` | share + employee-targets tests |
| Deferred assign invite | Same as deferred share | **Full (Phase 2)** | `collab-invite.service.ts` | `collab-invite.eval-db.test.ts` |
| Open jobs / check-with | Multi-job, urgency, snooze, escalate, self-jobs, scheduled | **Full** | `jobs.service.ts`, OPEN_JOBS rules | `jobs.test.ts`, open-jobs offline |
| Partner notifies | Shared-item events, WhatsApp / thread | **Full** | `chat.service.ts` notify paths | share-notify tests |

**Classification:** **Reuse as-is.** Gaps are mostly **invite resume for message/check-with** and **model ACTION selection**, not missing task engines.

### 1.5 Reminders and recurring actions

| Piece | Verified now | Maturity | Paths | Tests |
|-------|--------------|----------|-------|-------|
| One-shot + recurrence clocks | Full; Asia/Jerusalem | **Full** | `reminder.service.ts`, `reminder-fire.ts`, `shared/src/recurrence.ts` | Large reminder test family |
| Soft-link clock ↔ task | Engine + prompt contract | **Full / sensitive** | `reminder-soft-link.ts` | soft-link phase tests |
| Compose / watches | Weather, market, mashov, bus, flights, … | **Full** | compose-* services | per-domain tests |
| Post-save reminder offer | Prompt + engine helpers | **Full** | prompt + `post-save-reminder-offer` | offer offline tests |

**Classification:** **Reuse as-is.** Failures here are overwhelmingly **Prompt/orchestration** (wrong ACTION), not missing clocks.

### 1.6 Events and meetings

| Piece | Verified now | Maturity | Paths | Tests |
|-------|--------------|----------|-------|-------|
| Meetings as tasks | Date/time/range, multi-day | **Full** | tasks + LLM rules | event-pack offline/db |
| Complex event host + linked lists | Prompt-driven host task + custom lists | **Full / model-heavy** | COMPLEX EVENTS in `LLM.config.json`, list-item links | `event-pack*.test.ts` |
| Coordinate / `messages.book` | Slot ask → book on both | **Full** | jobs + book fields | `jobs.test.ts` |
| Overlap check | **Model-only** (no server refuse) | **Partial by design** | prompt TEAM_SCHEDULES | event / jobs packs |
| Dedicated Event aggregate table | None | **Absent — OK** | — | — |

**Classification:** **Reuse as-is** for pilot. Dedicated event entity → **Future / not for pilot**. Overlap enforcement → optional **Prompt/orchestration** (or later small server guard).

### 1.7 Invitations and sharing flows

| Piece | Verified now | Maturity | Paths | Tests |
|-------|--------------|----------|-------|-------|
| Cold message / check-with invite | `WhatsAppInvite` + wa.me draft when no 24h session | **Full for messages** | `whatsapp-invite.service.ts`, `buildColdInvitesForNoSession` | `whatsapp-invite.test.ts` |
| Bind inbound | Sets `guestEmployeeId`; **never** rewrites `userId` / `isGuest` | **Full (Phase 1)** | `bindInboundToInvite` | `whatsapp-identity.eval-db.test.ts` |
| Invite opening context (non-guest) | `formatInviteOpeningContext` — subject only, not a gate | **Full** | `whatsapp-invite.service.ts`, `composeTurnContext` | whatsapp-invite / identity |
| Share/assign deferred invite | Payload `v:1` share\|assign | **Full (Phase 2)** | `createDeferredCollabInvites` | `collab-invite.eval-db.test.ts` |
| Apply pending collab | **Auto-applies** on first `sendChatMessage` for registered non-guest phone | **Full, product-sensitive** | `applyPendingCollabInvites` | collab-invite eval |
| Explicit accept / decline UX | `metadata.collab_invite` / `decline_invite` + `formatCollabInviteContext` exist; **`loadPresentedCollabInvites` always returns `[]`** | **Stubbed / dead presentation** | `collab-invite.service.ts` | unit cases for confirm false; presentation unused |
| Message invite after register | `continueInviteAfterRegister` opens job on **inviter** `userId` | **Legacy gap** | `chat.service.ts` | guest-register / invite tests |
| Invite expire / decline product | Schema allows `expired` / cancel; **no ticker writes `expired`**; decline only for collab cancel path | **Partial** | schema + `cancelCollabInvite` | weak |
| Invite ≠ household | True today: share/assign do not create Team membership across Users | **Aligned with R5** | — | — |

**Classification:** Share/assign continuity → **Reuse as-is** (executors). Accept-before-participate (R2) vs current auto-apply → **product decision** + possibly **small targeted** change. Message-job resume on recipient Lucy → **Small targeted code change**. Invite expiry lifecycle → **Small targeted**. Dead accept-presentation stub → either wire it or delete later (**not** a rebuild).

### 1.8 Conversations and continuity

| Piece | Verified now | Maturity | Paths | Tests |
|-------|--------------|----------|-------|-------|
| Per speaker×digital conversation | OpenAI thread + DB messages | **Full** | `chat.service.ts` | chat tests |
| 40-minute idle reset | New thread; **saved data survives** | **Full** | `CONVERSATION_IDLE_MS` | relative-date / chat |
| Facts every turn | EMPLOYEE_SAVED_DATA, OPEN_JOBS, contacts, … | **Full** | `composeTurnContext` | many eval packs |
| Guest↔Lucy history merge | Merges לוסי-אורח into Lucy history | **Legacy** | `getChatHistory` | guest register continuity |
| Sticky WhatsApp digital | Prefers non-guest Lucy | **Full** | `whatsapp-worker-sticky.ts` | routing tests |

**Classification:** **Reuse as-is.** Continuity problems after idle are **Prompt/orchestration** (re-inject invite / unfinished draft), not a new draft store.

### 1.9 Permissions and data isolation

| Piece | Verified now | Maturity | Paths | Tests |
|-------|--------------|----------|-------|-------|
| Account boundary = `User` | Employees, lists, filings under user | **Full** | schema | — |
| Owner `seeAll` within account | Owner sees all humans on same User | **Full** | `resolveRecordVisibility` | employee-records |
| Non-owner | Own + `visibleTo` / shared scope | **Full** | same | same |
| Cross-account | Only via explicit share/assign visibility or contact-resolved partner | **Full** | targets + owners | cross-account-share |
| `«כולם»` | Team/account scoped — not all Workee users | **Full** | `employee-targets.service.ts` | employee-targets |

**Classification:** **Reuse as-is.** Matches R6. Household (R3–R4) is **not** this layer yet.

### 1.10 Pilot access / billing

| Piece | Verified now | Maturity |
|-------|--------------|----------|
| Account entitlement / trial end | **Absent** | Missing for R8 |
| Stripe / plans / checkout | **Absent** | **Aligned with R9** |
| Mission `payment` tool | External mission helper only | **Not** account billing — leave alone |

**Classification:** Configurable pilot duration → **Genuine architectural change** (small entitlement field + gate), not a billing system. Pricing choice → **Future / not for pilot**.

---

## 2. Prompt and orchestration gaps

Do **not** assume every failure is a prompt bug. Causes below were checked against executors.

### 2.1 Where the engine already works (prefer prompt/context)

| Symptom | Likely cause | Evidence |
|---------|--------------|----------|
| Wrong assign vs share vs tell | Model ACTION / targets | `LLM.config.json` ASSIGN vs SHARE vs TELL; share packs |
| Missed show dump / wrong section | Model `show_dump` fields | Engine dump is ACTION-only (`features.md` §4) |
| Reminder vs standing-task confusion | Prompt routing + soft-link | Large reminder soft-link test surface |
| Meeting overlap not refused | **By design** model-only | No server overlap guard |
| After invite, generic “how can I help” | Opening context may be weak or idle reset dropped thread | `formatInviteOpeningContext` exists; still model-led |
| Complex event structure | Prompt COMPLEX EVENTS | event-pack suite |

**Classification:** **Prompt/orchestration improvement** first. Do not rebuild list/job engines.

### 2.2 Concrete “exists but under-used / mis-wired” cases

1. **`loadPresentedCollabInvites` returns `[]`**  
   Accept/decline instructions and `metadata.collab_invite` are implemented, but the model never sees pending collab invites. Meanwhile `applyPendingCollabInvites` applies automatically before facts.  
   **Cause:** orchestration stub, not missing DB.  
   **Class:** Small targeted + product choice (auto-apply vs accept).

2. **`formatInviteOpeningContext` vs registration gate**  
   Independent users get opening subject (good for R7). Legacy `formatPendingInviteContext` still gates shells.  
   **Cause:** dual product eras.  
   **Class:** Prompt/orchestration cleanup after guest removal; not a new invite product.

3. **`continueInviteAfterRegister` job on inviter**  
   Check-with resume still creates the job under the asker’s account after host promotion. Independent recipients who never hit guest register never get this path; deferred **share/assign** already resume correctly.  
   **Cause:** leftover host-centric resume.  
   **Class:** Small targeted (point job at recipient’s Lucy / asker–subject correctly without moving identity).

4. **Guest instructions still claim view-only; runtime forces full pipeline**  
   Docs + dead prompt disagree with `guestSpeaker = false` and capability-parity tests.  
   **Cause:** interim code ahead of docs.  
   **Class:** Documentation + guest-removal plan; avoid “rebuilding guest mode.”

5. **Whole-list share to unknown name**  
   Shell `add_participants` refuses unknown; item share to contact phone **defers** invite. Inconsistent UX.  
   **Cause:** list-ops never got deferred-invite partition.  
   **Class:** Small targeted (optional for pilot) or **Prompt** (“share items / ask them to register first”).

6. **VOICE / naturalness**  
   Situational warmth shipped; LIVE QA accept-with-notes. Remaining stiffness is prompt, not missing features.  
   **Class:** Prompt/orchestration (already largely done).

### 2.3 Not prompt issues (verified)

| Issue | Actual cause |
|-------|----------------|
| No household membership | No schema / service |
| No configurable pilot end date | No entitlement field / gate |
| Legacy `registerGuestMember` joins host | Intentional old path still in code |
| Auto-apply share without explicit accept | `applyPendingCollabInvites` design |
| `docs/features.md` guest view-only | Doc drift |

---

## 3. Architectural compatibility

| Requirement | Compatible today? | Genuine gap? |
|-------------|-------------------|--------------|
| R1 Independent account | **Yes** for new WhatsApp phones | Leftover guest shells + host-promotion path; migration of already-merged registrants is separate |
| R2 Register before invited action | **Partial** | Account exists immediately; profile may be incomplete; share/assign **auto-apply** without explicit accept; message invites still tied to guest register |
| R3 Household optional | **Yes by absence** | No household entity yet — optional is vacuously true; need a **later** membership model when offering household |
| R4 At most one household | **N/A until household exists** | Cap is a membership rule when household ships |
| R5 Invite ≠ household member | **Yes** | Share/assign/job invites do not create cross-User Team membership |
| R6 Collaborate without full household data | **Yes** | `visibleTo` / assign fan-out already do this |
| R7 Full capabilities for pilot users | **Yes** for independent non-guests; interim also for `isGuest` via forced flags | Clean up guest product so “full” is unambiguous |
| R8 Configurable pilot duration | **No** | Need account-level access status + configurable end; **not** billing |
| R9 No billing | **Yes** | Keep it that way |
| R10 Monetization flexibility | **Mostly** | Add entitlement abstraction without plan types; do not bind pricing to Team vs User now |

### Architectural gaps that **genuinely** block the agreed direction

1. **Pilot access lifecycle (R8)** — no field, no gate, no operator restore.  
2. **Household as optional product object (R3–R4)** — only when you want to *offer* household; not required to ship independent accounts or share/assign (already shipped).  
3. **Registration-before-participate policy (R2)** — product rule not enforced: need a clear definition of “registered” (name+gender? any first message?) and whether share/assign wait for accept.  
4. **Legacy guest/host-promotion topology** — still present; blocks a clean reading of R1 if any path still creates or promotes guests. New-phone path is already fixed.

### Not genuine architectural blockers

- Rebuilding lists, reminders, jobs, meetings, WhatsApp send, or cross-account share.  
- Building Stripe.  
- Multi-household (explicitly capped at one).  
- Google / grocery (deferred).

---

## 4. What to preserve

- **ACTION → engine** loop and ACTION catalog.  
- **Cross-account share/assign** and deferred collab invite payload + `confirmCollabInvite` row semantics.  
- **Independent WhatsApp provisioning** (`createWhatsAppOnlyUser` + owner human + protected Lucy).  
- **`bindInboundToInvite` without identity move.**  
- **Jobs, reminders, recurrence, filings, contacts, attachments, compose/live domains.**  
- **Visibility model** (`scope` / `visibleTo` / owner seeAll within User).  
- **Invite opening context** as greeting, not capability lock.  
- **Eval harnesses** (share packs, collab-invite, whatsapp-identity, guest-capability-parity, jobs, reminders).  
- **Absence of billing.**

---

## 5. What genuinely needs changing (smallest set)

| Change | Class | Why smallest |
|--------|-------|--------------|
| Define and enforce **“registered enough to participate”** (profile and/or explicit accept) | Product input + small code / prompt | R2; executors already exist |
| Stop relying on **guest → host promote** for the pilot path; finish guest-removal plan when data allows | Architectural cleanup (planned) | R1, R7 |
| **Message/check-with resume** on recipient’s own Lucy (fix host-centric `continueInviteAfterRegister`) | Small targeted | Complements Phase 2 share/assign |
| Decide **auto-apply vs accept/decline** for collab invites; either wire `loadPresentedCollabInvites` or document auto-apply as the product | Product + small code | Dead stub today |
| **Pilot entitlement** field + configurable duration + soft gate (retain data) | Genuine architectural (thin) | R8; no Stripe |
| **Household membership** (0..1) when offering household — separate from invites | Genuine architectural (later than identity) | R3–R4; do not block share |
| Doc sync (`features.md` §17–18, product discovery §8) | Docs only | Prevent false “must rebuild” |

---

## 6. Current vs required (summary table)

| Required behavior | Current implementation | Gap class |
|-------------------|------------------------|-----------|
| Own account per person | New WhatsApp → own User + Lucy | **Mostly done** — leftover guest/host paths |
| No guest participation product | Guest worker + register still in tree; capability gate disabled | **Cleanup** |
| Register before invited action | Full Lucy before profile; collab auto-applies | **Policy + small change** |
| Contextual invite | Message cold invite + collab payload + opening context | **Reuse**; polish prompt |
| Share/assign without household | Cross-account + deferred invite | **Done — preserve** |
| Invite ≠ household join | No household join on invite | **Done** |
| ≤1 household | No household entity | **Add later** when offering household |
| Full pilot capabilities | Yes for independent users | **Done** |
| Configurable access duration | Missing | **Add thin entitlement** |
| No billing | None | **Done** |
| Accept / decline / expire invites | Cancel path + stub presentation; expire unused | **Partial** |
| Existing user receives invite | Bind keeps account; opening context; collab apply | **Mostly done** |
| Data retained when access ends | N/A until entitlement exists | Design with retain-by-default |

---

## 7. Recommended target identity / invitation model (reuse-shaped)

```text
Person
  └── User (account) + human Employee + Lucy
        ├── pilotAccess: active | expired   (NEW, thin)
        ├── householdMembership?: 0..1      (NEW when offering household)
        └── personal data (lists, clocks, filings, conversations)

Invitation (existing WhatsAppInvite + payload)
  ├── kind: message | share | assign | (later meet)
  ├── does NOT create household membership
  └── on participate: run EXISTING planTargetedActions / createJobsFromRelays
```

- **Collaboration unit for pilot:** explicit share/assign/job — already implemented.  
- **Household unit:** optional overlay for “our home,” not required for two people to share milk.  
- **Do not** reintroduce host-seat registration.

---

## 8. Recommended implementation sequence

Ordered by pilot impact and risk. **No phase starts until review.**

| Phase | Work | Depends on | Risk |
|-------|------|------------|------|
| **A — Product lock** | Answer open decisions in §9 (register definition, auto-apply vs accept, pilot duration) | Review | Low |
| **B — Doc truth** | Align `features.md` / discovery gap tables with Phase 1–2 + interim guestSpeaker | A optional | Low |
| **C — Message invite resume** | Recipient-owned job continuation without host promote | A | Medium |
| **D — Participate policy** | Enforce R2 with smallest gate (profile and/or accept wiring) | A | Medium |
| **E — Guest removal** | Per `lucy-guest-removal-plan.md` after data inspection | C–D stable | Medium–high (data) |
| **F — Pilot entitlement** | Configurable duration + active/expired gate; retain data; operator restore | A | Medium |
| **G — Household 0..1** | Optional offer; invite still ≠ join | F optional | Medium |
| **H — Prompt polish** | Invite opening, assign/share confusions, event packs — continuous | Anytime | Low |
| **Later** | Google, grocery, monetization mapping, multi-household | Explicit ask | — |

**Dependency:** Infrastructure always-on + backups remain prerequisites for promising expiry/return at pilot scale (`docs/infra/lucy-infrastructure-discovery.md`).

---

## 9. Open decisions that need product input

Only decisions that change the smallest engineering path:

1. **What counts as “registered” for R2?** (name+gender on own account / any WhatsApp identity / explicit accept of invite)  
2. **Share/assign: auto-apply on first message (current) vs explicit accept/decline?**  
3. **Pilot duration model:** calendar end vs N days from first message; who sets it for ~20 users?  
4. **On access expiry:** hard stop vs grace for open jobs? (data retain assumed)  
5. **When to offer household:** at profile completion, later via Lucy, UI only, or defer entire household to post-pilot?  
6. **Message/check-with in pilot v1** alongside share/assign, or share/assign only?  
7. **Brand in invite copy:** Lucy vs Workee (draft text still says Workee/לוסי mix)

**Do not decide now:** per-user vs household pricing, Stripe, grocery, Drive.

---

## 10. Cross-references (evidence map)

| Area | Primary code | Primary tests |
|------|--------------|---------------|
| Identity | `whatsapp.service.ts`, `user.service.ts`, `employee.service.ts` | `whatsapp-identity.eval-db.test.ts`, `users.test.ts`, `team.test.ts` |
| Guest legacy | `guest-register.service.ts`, `ensureGuestLucy` | `guest-register.test.ts`, `guest-capability-parity.eval-db.test.ts` |
| Invites | `whatsapp-invite.service.ts`, `collab-invite.service.ts` | `whatsapp-invite.test.ts`, `collab-invite.eval-db.test.ts` |
| Share/assign | `employee-targets.service.ts`, `employee-records.service.ts`, `contact.service.ts` | `share-unified-*.eval-db.test.ts`, `cross-account-share.test.ts` |
| Jobs / meetings | `jobs.service.ts`, chat OPEN_JOBS | `jobs.test.ts`, `event-pack*.test.ts` |
| Reminders | `reminder*.ts`, shared recurrence | reminder test family |
| Chat orchestration | `chat.service.ts`, `LLM.config.json` | chat + live/eval packs |
| Prior designs | `lucy-phase1-*.md`, `lucy-phase2-*.md`, `lucy-guest-removal-plan.md` | — |

---

## 11. Bottom line

Most of Lucy’s product surface for the pilot **already exists**. Phase 1–2 already delivered **independent accounts** and **share/assign invitation continuity** without a household graph. The smallest remaining set is: **participate/registration policy**, **message-invite resume cleanup**, **thin pilot entitlement**, **optional one-household later**, and **guest-legacy removal** — plus ongoing **prompt/orchestration** polish. Rebuilding core collaboration would be unnecessary redevelopment.

---

*End of audit. No implementation. Stop for review.*
