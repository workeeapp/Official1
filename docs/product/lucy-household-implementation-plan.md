# Household — phased implementation plan

**Status:** **Deferred** — kept as future reference only. Do **not** implement Household while family collaboration relies on independent accounts + Share/Assign.  
**Updated:** 2026-11-17 (deferred)  
**Depends on evidence:** Team analysis; `lucy-existing-capabilities-gap-audit.md`; Phase 1–2 identity/invite code  
**Active track instead:** family invite/share experience on existing paths (see `lucy-family-collab-experience-gaps.md` when present)

## Locked product decisions

| # | Decision |
|---|----------|
| D1 | `Household` is a **separate** entity from `Team`. Do not change Team meaning. |
| D2 | Each `User` belongs to **0 or 1** household — permanent rule (incl. after pilot). |
| D3 | A household may contain **multiple independent** `User` accounts. |
| D4 | Lucy works **without** a household. |
| D5 | User may **create** a household and invite family **at any time**. |
| D6 | Join requires **invite + explicit accept**. |
| D7 | Share/assign/list/info invites **never** create household membership. |
| D8 | MVP household = **membership layer only** — no automatic data access; no change to existing permission engines. |
| D9 | No merging of `User`s; no moving personal data on join. |

---

## 1. What we reuse (do not reinvent)

| Need | Existing piece | Path |
|------|----------------|------|
| Independent accounts | WhatsApp own `User` + owner human + Lucy | `whatsapp.service.ts` `createIndependentWhatsAppAccount`, `user.service.ts` `createWhatsAppOnlyUser` |
| Cross-account collab without household | share/assign + `visibleTo` | `employee-targets.service.ts`, `employee-records.service.ts`, `collab-invite.service.ts` |
| Invite lifecycle patterns (pending / consume / cancel) | `WhatsAppInvite` + collab confirm/cancel | `whatsapp-invite.service.ts`, `collab-invite.service.ts` |
| Phone → existing account | `findExistingWhatsAppSpeaker` / phone unique on `Employee` | `whatsapp.service.ts`, schema `Employee.phone` |
| Auth session for web APIs | `requireAuth` | `auth` middleware, pattern in `team.routes.ts` |
| Account listing of humans | `listEmployeesForUser(userId)` | `employee.service.ts` |

**Do not reuse as household:** `Team`, `ensureSharedRegisteredTeam`, `New Registered 30 days`, `registerGuestMember`, `guestEmployeeId` semantics, or `visibleTo` as membership.

**Invitation reuse policy:** Prefer a **dedicated** `HouseholdInvite` table (or membership rows in `invited` status) rather than overloading `WhatsAppInvite.payload` with a third kind. Reasons: payload today is share/assign only (`collab-invite.service.ts`); `WhatsAppInvite.userId` means asker’s account; auto-apply path (`applyPendingCollabInvites`) must never touch household; D7 must stay hard. Patterns (token, status machine, phone match) can be copied.

---

## 2. Minimal data model

### 2.1 Recommended tables

```text
Household
  id            Uuid PK
  name          VarChar?     -- display; nullable until product decides
  createdAt     DateTime
  updatedAt     DateTime

HouseholdMembership
  id            Uuid PK
  householdId   Uuid FK → Household  ON DELETE CASCADE
  userId        Uuid FK → User       ON DELETE CASCADE   -- the independent account
  role          VarChar      -- MVP: "owner" | "member"
  status        VarChar      -- MVP: "active" | "left" | "removed"
  createdAt     DateTime
  updatedAt     DateTime
  leftAt        DateTime?

HouseholdInvite
  id              Uuid PK
  householdId     Uuid FK → Household
  inviterUserId   Uuid FK → User
  -- recipient identification (exactly one path must resolve on accept):
  recipientUserId Uuid? FK → User     -- when already known
  recipientPhone  VarChar?            -- when inviting by phone (WhatsApp)
  token           VarChar UNIQUE      -- opaque accept link / WhatsApp token
  status          VarChar             -- pending | accepted | declined | cancelled | expired
  expiresAt       DateTime
  createdAt       DateTime
  respondedAt     DateTime?
```

### 2.2 Is a separate `HouseholdMembership` required?

**Yes.** Reasons grounded in current code:

- `User` today has no cross-account graph (`schema.prisma` User → teams/employees only).
- Membership is many Users ↔ one Household; role/status/history need a join row.
- Putting `householdId` alone on `User` would encode 0..1 but lose role, leave/remove history, and make “invited but not joined” awkward.
- Partial unique on **active** membership (below) lives naturally on the membership table.

### 2.3 Enforcing 0..1 household per User at DB level

**Recommended:**

```sql
-- At most one ACTIVE membership per user
CREATE UNIQUE INDEX HouseholdMemberships_one_active_user
  ON "HouseholdMemberships" ("user_id")
  WHERE status = 'active';
```

Also:

- `@@unique([householdId, userId])` on membership (or unique where status in active/invited if you store invites as membership — see open decision).
- Application transaction: accept invite → insert/activate membership only if no other `active` row; unique index is the backstop.
- **Do not** put a non-partial unique on `userId` alone if you keep historical `left`/`removed` rows.

### 2.4 Owner representation

MVP options (product must pick — see §9):

| Option | Mechanism |
|--------|-----------|
| A | `role = owner` on exactly one active membership; partial unique `(householdId) WHERE role=owner AND status=active` |
| B | `Household.ownerUserId` column + memberships for everyone including owner |

Recommendation for MVP: **A** (role on membership) — one table to update on transfer; mirrors how collab already thinks in employee roles lightly.

---

## 3. Lifecycle flows (MVP)

### 3.1 Create household

1. Caller = authenticated `User` (web) or resolved WhatsApp account owner (`resolveWhatsAppSpeaker` already yields independent `User`).
2. Reject if user already has `HouseholdMembership.status = active`.
3. Transaction: create `Household` + create membership `role=owner`, `status=active`.
4. **No** Team changes. **No** list/share changes. **No** Lucy capability change.

**Service sketch:** `household.service.ts` `createHousehold({ userId, name? })`  
**API sketch:** `POST /api/household` (session auth, same pattern as `team.controller.ts`).

### 3.2 Invite family member

1. Inviter must have `active` membership with permission to invite (**open decision:** owner-only vs any member).
2. Resolve recipient:
   - By phone → `Employee.phone` unique / `findExistingWhatsAppSpeaker` style lookup across users (**reuse** phone matching in `backend/src/utils/phone.ts`, `listRegisteredHumansByPhones` in `employee.service.ts`).
   - Or by known `userId` if product adds directory later.
3. If recipient already `active` in **this** household → idempotent no-op / “already member”.
4. If recipient already `active` in **another** household → **do not** create accept path that would violate 0..1; return clear error to inviter (**open decision:** still create pending invite that fails on accept, or refuse at create — recommend **refuse at create** when known).
5. Create `HouseholdInvite` `pending` + `expiresAt` (default TBD).
6. Notify recipient:
   - If they have Lucy: inject opening context on their Lucy thread (**pattern:** `formatInviteOpeningContext` in `whatsapp-invite.service.ts`) and/or WhatsApp text via existing send helpers — **without** calling `applyPendingCollabInvites` / share payload.
   - If unknown phone: cold wa.me draft pattern may be copied from `buildFatherInviteDraft` / `createWhatsAppInvite`, but store as **HouseholdInvite**, not share payload.

### 3.3 Accept

1. Recipient authenticated as the invite’s phone/`recipientUserId`.
2. Invite `pending` and not past `expiresAt`.
3. Recipient has **no** other `active` membership (DB unique + app check).
4. Transaction: invite → `accepted`; membership → `active` `member` (or promote from invited row).
5. Notify inviter (optional MVP).
6. **Still no** data ACL change (D8).

### 3.4 Decline / cancel / expire

| Action | Who | Effect |
|--------|-----|--------|
| Decline | Recipient | invite `declined`; no membership |
| Cancel | Inviter (or owner) | invite `cancelled` |
| Expire | Job / on-read check | invite `expired` if `now > expiresAt` |

**Reuse idea:** collab’s `cancelCollabInvite` status flip pattern (`collab-invite.service.ts`) — new function on household invites, not a call into collab.

**Gap today:** `WhatsAppInvite` documents `expired` but no ticker writes it. Household MVP should either: (a) expire lazily on read/accept, or (b) add a small periodic job. Lazy-on-read is enough for MVP.

### 3.5 Already in another household

| Moment | Behavior (recommendation) |
|--------|---------------------------|
| Invite create, recipient known active elsewhere | Refuse invite create with explicit reason |
| Invite create, recipient unknown | Allow pending; on accept, if they created/joined another HH meantime → reject accept |
| Accept while active elsewhere | Fail; unique index prevents double active |
| User wants to switch | Must **leave** (or be removed) first, then accept — no auto-swap in MVP |

### 3.6 Leave and ownership transfer

| Case | MVP behavior |
|------|----------------|
| Member leaves | `status=left`, `leftAt=now`. Data stays on their `User`. Shares/`visibleTo` unchanged (D8/D9). |
| Owner leaves, other members remain | **Blocked** until transfer **or** dissolve — **product decision required** |
| Owner leaves, sole member | Dissolve household (delete or `Household` archived + membership left) |
| Transfer ownership | Existing owner → `member`; target `active` member → `owner` (one transaction) |
| Last member leaves | Household deleted or marked dissolved |

**Do not** move `Employee` rows, lists, reminders, or `userId` (contrast legacy `registerGuestMember` / old bind — must not repeat).

---

## 4. API and services (MVP)

### 4.1 New modules (proposed)

| Module | Responsibility |
|--------|----------------|
| `backend/src/services/household.service.ts` | create, get mine, leave, transfer, dissolve |
| `backend/src/services/household-invite.service.ts` | create/accept/decline/cancel/expire |
| `backend/src/routes/household.routes.ts` + controller | HTTP surface |
| `shared` types | `PublicHousehold`, membership, invite DTOs |

Wire via `backend/src/routes/index.js` → `/api/household` (same as `team.routes.ts` under `/api`).

### 4.2 Suggested HTTP surface (MVP)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/household` | Create (caller becomes owner) |
| `GET` | `/api/household` | Current household + members (0 if none) |
| `POST` | `/api/household/invites` | Invite by phone (and/or userId) |
| `POST` | `/api/household/invites/:id/accept` | Accept |
| `POST` | `/api/household/invites/:id/decline` | Decline |
| `POST` | `/api/household/invites/:id/cancel` | Inviter cancel |
| `POST` | `/api/household/leave` | Leave (non-owner or after transfer rules) |
| `POST` | `/api/household/transfer` | Owner → other active member |
| `GET` | `/api/household/invites/pending` | Invites for current user |

WhatsApp/Lucy ACTION surface for household is **Phase 2+** unless product insists (see deferred).

### 4.3 What not to touch in MVP

| Area | Files | Rule |
|------|-------|------|
| Team | `employee.service.ts` team helpers, `team.routes.ts`, UI team filter | Unchanged |
| Permissions / seeAll | `resolveRecordVisibility` in `employee-records.service.ts` | Unchanged — still User-scoped |
| Share/assign | `employee-targets.service.ts`, `collab-invite.service.ts` | Unchanged; never write HouseholdMembership |
| Guest promote | `guest-register.service.ts` | Unchanged; household ≠ host seat |
| «כולם» | `resolveNamedRelayTargets` | Still account humans only — **not** household members |

---

## 5. Registration and WhatsApp independent accounts

| Moment | Integration |
|--------|-------------|
| New WhatsApp account | `createIndependentWhatsAppAccount` — **no** household created (D4) |
| Profile/name collection | Optional **offer** later (“רוצה ליצור משק בית?”) — prompt/UI only; not required for Lucy |
| Opening share/assign invite | Existing Phase 2 path only; **assert in tests** that no HouseholdMembership row appears |
| Opening household invite | Resolve/create independent account first if needed; then pending household invite; accept explicit |
| Web user without household | Full Lucy; `GET /api/household` empty |

**Do not** call `ensureSharedRegisteredTeam` or `registerGuestMember` as part of household join.

---

## 6. Impact matrix

| Subsystem | Impact in MVP |
|-----------|----------------|
| Team | **None** |
| Guest / לוסי-אורח | **None** (cleanup remains separate workstream) |
| Share / Assign / WhatsAppInvite payload | **None** functionally; add regression tests that household invite kind cannot be parsed as collab payload |
| Jobs / reminders / lists | **None** |
| `seeAll` / owner visibility | **None** — household members do **not** see each other’s private data |
| Cross-account `visibleTo` | Unrelated; remains the only data-sharing path |
| Billing / pilot entitlement | Orthogonal; may later key off User or Household — **do not decide now** |
| Frontend Employees Team picker | Unchanged; optional later “Household” settings page |

---

## 7. Tests required

### 7.1 MVP (must)

| Case | Assert |
|------|--------|
| Create household | Owner active membership; second create by same user fails |
| Unique active membership | Two active rows for same `userId` impossible (DB + service) |
| Invite + accept | Membership active; invite accepted |
| Invite + decline | No membership |
| Cancel / expire | Cannot accept afterward |
| Invitee already in other HH | Create refused or accept refused (per chosen rule) |
| Leave as member | status left; household remains if others |
| Owner sole leave | Household dissolved |
| Owner leave with others | Blocked without transfer (if that is the rule) |
| Transfer | Exactly one owner afterward |
| Share invite does not join HH | Create deferred collab / share; zero HouseholdMembership |
| Assign invite does not join HH | Same |
| Collab payload parser rejects household-shaped JSON | `parseCollabInvitePayload` still null |
| Team unchanged | Creating HH does not create/alter `Team` rows |
| No userId move | Accept does not change `Employee.userId` |
| Independent WhatsApp user | Can create HH; can accept; can use Lucy with HH=null |

Harness patterns to copy: `whatsapp-identity.eval-db.test.ts`, `collab-invite.eval-db.test.ts`, `team.test.ts` (API auth), `cross-account-share.test.ts` (negative: no HH).

### 7.2 Deferred tests

- Lucy natural-language create/invite household
- UI household settings
- Multi-invite race under load beyond unique index
- Soft-delete / GDPR household wipe

---

## 8. MVP vs deferred

### MVP (membership layer)

1. Schema: `Household`, `HouseholdMembership`, `HouseholdInvite` + partial unique active user.  
2. Service + REST API for create / invite / accept / decline / cancel / leave / transfer.  
3. Lazy expire on read.  
4. WhatsApp or in-app notify for pending household invite (minimal).  
5. Regression: share/assign ≠ household.  
6. Docs: short feature note (when implementing).

### Deferred (explicitly out of MVP)

| Item | Why defer |
|------|-----------|
| Auto data visibility among household | Contradicts D8 |
| «כולם» = household | Would change permission semantics |
| Lucy ACTION `household.*` | Needs prompt design; API-first is enough |
| Offer during registration UX | Product copy / timing open |
| Household-scoped tips, schedules, digests | Product feature later |
| Merge Team UI with Household | Confusing; Team stays account-internal |
| Billing / seat limits per household | Monetization undecided |
| Multi-household | Forbidden by D2 |
| Changing Team or guest promotion | Separate workstreams |

---

## 9. Open product decisions (do not invent)

1. **Who may invite?** Owner only, or any active member?  
2. **Invite expiry default?** (7 / 14 / 30 days)  
3. **Owner leave with other members:** require transfer vs allow dissolve-all vs appoint automatic?  
4. **Household display name:** required at create, optional, or derived from owner name?  
5. **Invite channel for MVP:** web API only, WhatsApp draft like cold invite, or both?  
6. **Unknown phone invite:** create independent account on first message (already happens) then show HH invite — confirm.  
7. **Removed vs left:** need admin-remove in MVP or leave-only?  
8. **List members to non-members?** (privacy)  
9. **Hebrew product copy** for household vs family vs “משק בית”.

---

## 10. Risks

| Risk | Mitigation |
|------|------------|
| Overloading `WhatsAppInvite` causes share auto-apply to join HH | Separate `HouseholdInvite`; tests for isolation |
| Treating household as Team breaks seeAll | Never put foreign Users on Team; never change `resolveRecordVisibility` in MVP |
| Accept races (two HHs) | Partial unique index + transactional accept |
| Product pressure to “see family lists” early | Hold D8; use explicit share |
| Legacy guest/host users | Household join must not call `registerGuestMember`; document that already-merged host-seat users are a migration topic, not HH MVP |
| Name collision “team” in UI/API | Use `/api/household`; never rename Team |

---

## 11. Recommended implementation sequence

| Stage | Scope | In bounds | Out of bounds | Exit criteria |
|-------|--------|-----------|---------------|---------------|
| **H0 — Approve** | Lock §9 decisions that block schema | Product answers | Coding | Written answers to 1–5 at least |
| **H1 — Schema** | Migration: Household + Membership + Invite + partial unique | Prisma only | Services, prompts, Team | Migrate on test DB; index rejects double active |
| **H2 — Core service** | create / get / leave / transfer / dissolve rules | `household.service.ts` + unit/eval-db | WhatsApp, Lucy prompt | Tests §7.1 core membership |
| **H3 — Invites** | invite / accept / decline / cancel / lazy expire | `household-invite.service.ts` + API | Collab changes | Isolation tests vs share/assign |
| **H4 — Notify (thin)** | Pending invite visible to recipient (API + optional WhatsApp text) | Reuse send helpers carefully | Auto-share, opening collab apply | Recipient can accept from their account |
| **H5 — Registration offer (optional)** | Soft offer after profile — no force | Prompt/UI later | Capability gates | User can skip; Lucy works |
| **H6 — Lucy verbs (later)** | Natural-language create/invite/leave | Prompt + ACTION | Permission expansion | Separate approval |
| **Hx — Never in this track** | Team rewrite, guest promote, auto ACL, billing | — | — | — |

**Dependency note:** Household MVP does **not** require guest-removal or pilot entitlement. It **does** assume independent `User` accounts for members (already true for new WhatsApp phones). Do not block H1–H4 on guest cleanup.

---

## 12. Clear stage boundaries (summary)

```text
H1–H4: membership + invites only
       → no Team edits
       → no resolveRecordVisibility edits
       → no collab-invite payload kinds for household
       → no User merge / Employee.userId rewrite

H5–H6: product surface (offer, Lucy language)
       → still no auto data access

Later product approval required for any household-wide visibility
```

---

*End of plan. No implementation. Awaiting approval and §9 answers.*
