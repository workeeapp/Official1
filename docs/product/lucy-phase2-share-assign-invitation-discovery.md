# Phase 2 — Share / Assign invitation continuity

**Status:** Gap analysis before implementation. Shipped behavior is §8 and `docs/product/lucy-phase2-share-assign-invitation-design.md`  
**Updated:** 2026-11-14  
**Phase 1 commit:** `f841529651552dde061aa1dfe27982f69a8340a2`  
**Phase 2 commit:** `2a3ecf70d9b3ac31a204c86523420f70ac947382`  
**Prior docs:** `docs/product/lucy-existing-capabilities-gap-audit.md`, `docs/product/lucy-phase1-identity-invitation-design.md`

Sections 1–7 record the code after Phase 1 and before `2a3ecf7`. They are not the current behavior. Section 8 is what that commit shipped.

## How to read this document

| Label | Meaning in §§1–7 |
|-------|------------------|
| **Verified** | Read in the production path after `f841529`, before `2a3ecf7` |
| **Assumption** | A product reading of that path, not a separate code branch |
| **Not exercised** | No test at that time ran `sendChatMessage` through a real share or assign and then an inbound invite |

---

## 1. What Phase 1 already did

**Verified.**

| Piece | Where | After `f841529` |
|-------|--------|-----------------|
| Unknown WhatsApp phone | `resolveWhatsAppSpeaker` in `backend/src/services/whatsapp.service.ts` | Own `User` via `createWhatsAppOnlyUser`, human `isOwner: true`, `isGuest` not set, then `listEmployeesForUser` so protected Lucy exists. An existing phone is reused. |
| Invite bind | `bindInboundToInvite` in `backend/src/services/whatsapp-invite.service.ts` | Looks up `WRK-INV-…` or the latest pending row for the phone. Writes `guestEmployeeId` to the current employee. Does not write `userId`, `teamId`, or `isGuest`. Still calls `ensureGuestLucy` on the inviter’s user. |
| Who they talk to | `runWhatsAppTurn` in `whatsapp.service.ts` | A guest still goes to לוסי-אורח. Anyone else uses sticky or protected Lucy. |
| What the model sees | `composeTurnContext` in `chat.service.ts` | Guest + pending invite → `formatPendingInviteContext` (register before answering). Non-guest + pending invite → `formatInviteOpeningContext` (asker name, activity prose, not a limit). |
| Guest registration | `registerGuestMember`, called only when `guestSpeaker && metadata.register` | Still promotes the same employee onto the host. Unchanged. |
| After that registration | `continueInviteAfterRegister` | Still the only caller of `consumeWhatsAppInvite`. Opens a job on the **inviter’s** `userId`. |

`formatInviteOpeningContext` carries `asker_name` and `activity` (the stored `askSummary` string). Before `2a3ecf7` it did not carry a kind or a row id, and `WhatsAppInvite` had no payload column.

---

## 2. Current end-to-end flow for Share

**Verified**, unless marked otherwise.

Share here means item co-share and whole-list shell share. Both already exist. Neither creates an invitation.

### 2.1 Who can be named

`sendChatMessage` loads `resolveExternalSharePartners` (`contact.service.ts`) from the speaker’s contacts. That calls `listRegisteredHumansByPhones` (`employee.service.ts`): human, `isGuest: false`, phone match, any account. Guests and unknown numbers are omitted. `«כולם»` is resolved only against the speaker’s own account (`resolveNamedRelayTargets`).

### 2.2 Item co-share (shopping, tasks, custom item, filing)

`planTargetedActions` (`employee-targets.service.ts`):

- Speaker is among the human targets, and at least one other human resolved → **one row on the speaker’s book**. `visibleTo` includes the speaker and the partners. `addedById` is the speaker. Partners are notified. They do not get a second copy.
- That single row is the collaboration. A later update or remove is applied on the owner row when `loadListItemOwners` finds the actor in `visibleTo` or as owner (`employee-records.service.ts`). There is no separate claim queue.

**Assumption, stated as product language:** “first-come-first-win” is this one shared row. Whoever updates it changes it for everyone who can see it. The code does not implement a grocery-style claim lock, and this phase should not add one.

### 2.3 Whole-list shell

`applyListOps` (`list-ops.service.ts`) resolves `add_participants` with `matchEmployee` against `humansForPlan`, which includes external partners. A known registered partner is added to the list’s `visibleTo` / `scope`. An unknown name throws `unknown_participant` (`לא מצאתי עובד בשם …`). No invite is created.

### 2.4 Unresolved name

`resolveActionTargets`: if the emitted targets match nobody, the function returns the **speaker**. The add is then stored as the speaker’s own row. A contact name that is not a registered non-guest never becomes a partner, even when the contact row has a phone.

**Verified consequence:** “share the milk with Danny” when Danny has no Lucy account becomes a personal item on the inviter, unless some other target on the same action did resolve.

### 2.5 Delivery after a successful share

`pushTargetNotification` (`chat.service.ts`) writes an assistant message on the **partner’s** user and their protected Lucy, then `deliverWhatsAppRelays`.

- Session open: WhatsApp text goes to the partner. No `WhatsAppInvite`.
- No 24-hour session, or send failure: a skip is returned (`no_session` / `failed` / `no_phone`) and shown to the inviter via `formatWhatsAppSkipNotice`.
- Those skips are **not** passed into `buildColdInvitesForNoSession`. That function only sees message relays (`attributedRelays`) and raw-phone sends (`attributedPhones`).

So a successful share to someone who already has Lucy is stored immediately. WhatsApp reaches them only inside the 24-hour window. Outside that window they get no invitation link. The notice sits on their Lucy thread in the database until they next open a conversation.

`deliverWhatsAppRelays` returns no skips when `NODE_ENV === "test"` or `WHATSAPP_ACCESS_TOKEN` is empty. Eval tests therefore do not exercise the closed-session branch.

---

## 3. Current end-to-end flow for Assign

**Verified.**

Same resolution as share. The split is in `planTargetedActions` / `isItemCoShareAdd`:

- Human targets are partners only (the speaker is not among them) → **fan-out**. One row on each assignee’s book, `addedById` = the speaker, `visibleTo` = that assignee. The product mark is `באחריות` (`classifyCollabFromTargets`, dump labels).
- The speaker does not keep a co-owned copy of that assigned row.
- Notification uses the same `pushTargetNotification` path as share. Same 24-hour gap. Same absence of an invite.

A digital worker named in the targets is not a share partner. Worker-tracking titles stay on the worker’s book. That path is unrelated to a cross-account invite.

---

## 4. Invitation link, token, and inbound resolution

**Verified.** This path exists for **messages**, not for share or assign.

### 4.1 When a row is created

`buildColdInvitesForNoSession` runs only when the speaker is not a guest, and only for:

- `planPhoneRelays`: a `messages` target that is a raw phone, or a contact name with a phone who is **not** already an employee in the relay pool
- employee relays whose WhatsApp send was skipped for `no_session`, or whose 24-hour session is closed

`createWhatsAppInvite` stores token, inviter `userId`, asker employee, digital employee, recipient phone, label, `askSummary` (message text, at most 500 characters), `draftText`, `status=pending`. No list id, no item id, no share/assign flag.

`buildFatherInviteDraft` builds Hebrew text the **asker** is told to forward from their personal WhatsApp. The business link is `wa.me/<business>?text=<token + greeting>`. If `WHATSAPP_DISPLAY_PHONE` is unset, the draft says to write to the business number and still embeds the token.

`expectsReply !== false` uses “לברר”. `expectsReply === false` uses “ביקש שאעביר”. Share and assign never set this flag, because they never call `createWhatsAppInvite`.

### 4.2 Inbound

`runWhatsAppTurn`:

1. `resolveWhatsAppSpeaker` (own account, or the existing employee).
2. `bindInboundToInvite` on the batch text.
3. If that returns null, it looks up a pending invite by `guestEmployeeId` or by phone and calls bind again with the stored token.

Bind never changes the speaker’s account (Phase 1). It does refresh `guestEmployeeId` on every bind.

The context passed into `sendChatMessage` is `PendingInviteContext`: invite id, token, asker display name, `askSummary`, recipient label.

### 4.3 New user versus existing user

| Arrival | Account | Invite effect on data |
|---------|---------|------------------------|
| Phone never seen | New user, own Lucy, not a guest | Opening context only. No share row, no assigned row, no job. |
| Phone already a non-guest | That employee, unchanged | Opening context only. If a share/assign already succeeded on the inviter’s turn, the row is already visible through `visibleTo` or already sits on their book. The invite does not apply it and does not point at it. |
| Leftover `אורח` guest | Still a guest, לוסי-אורח | `PENDING_INVITE` registration script. Unchanged on purpose. |

### 4.4 Accept, decline, continue

**Verified.**

- There is no invite accept and no invite decline.
- `consumeWhatsAppInvite` runs only inside `continueInviteAfterRegister`, which runs only after a **guest** registers. A non-guest invite stays `pending`.
- Status `expired` is in the schema comment and is never written.
- A check-with that did create an invite becomes a job only on that guest-registration path, on the inviter’s user, with the guest employee as subject. A new independent user never enters that path, so the check-with is not opened on their Lucy either.
- Job answer, decline, counter, and snooze (`jobs.service.ts`) apply to jobs that already exist. They are not wired to `WhatsAppInvite`.

### 4.5 Opened twice, or after the activity changed

**Verified.**

- Every later WhatsApp message from that phone, while any pending invite exists, takes `findPendingInviteByPhone` (latest `createdAt`) and injects `INVITE CONTEXT` again. The block does not say the activity was already handled.
- A second share to the same phone creates another pending row. Inbound resolution sees only the newest. Older pending rows stay pending and are not resumed.
- `askSummary` is the text stored at creation. It is not updated if the list row later changes. Because share/assign invites do not exist, there is also no item id that could be re-read.
- Binding again overwrites `guestEmployeeId`. It does not re-apply a mutation.

---

## 5. Authorization

**Verified.** These rules already hold and must stay.

| Rule | Where |
|------|--------|
| Cross-account read of a list row | `loadListItemOwners`: same account, or the actor is owner, `addedById`, or in item/list `visibleTo` |
| Same for filings | `loadFilingOwners` |
| Owner view | `resolveRecordVisibility`: a human `isOwner` sees humans on **that same** `User` only. `seeAll` does not cross accounts. |
| Guest mutate | `planTargetedActions` returns `guestMutationBlocked`. Engine guest copy is unchanged. |
| `«כולם»` | Stays inside one account |
| Invite bind | Does not change `userId` or `isGuest` |
| Household | No membership table. An invite must not write one. |

A replay that called `planTargetedActions` with the recipient as `externalPartners` would grant only the `visibleTo` or the assigned row that the existing executor already writes. It would not copy the inviter’s other lists. That replay did not exist before `2a3ecf7`.

---

## 6. Exact missing links

| # | Gap | Why it blocks the objective |
|---|-----|------------------------------|
| 1 | Share and assign never call `createWhatsAppInvite` | User B is not sent an invitation for the activity. Closed-session share/assign only produces a skip notice for User A. |
| 2 | Unresolved partner falls back to the speaker | A new person never receives the row. The inviter silently keeps a personal item. |
| 3 | `WhatsAppInvite` stores prose only | Even if a message invite is opened, Lucy cannot replay share vs assign, and cannot name a stable item id. |
| 4 | Non-guest invites are never consumed | Opening context repeats on every later message. A future replay would run again unless consume happens after a successful apply. |
| 5 | Only the latest pending invite for a phone is resumed | A second activity hides the first. |
| 6 | Shell `add_participants` refuses an unknown name and stops | Same product hole as item share, with an explicit refusal instead of a silent personal row. |
| 7 | `continueInviteAfterRegister` still opens the job on the inviter | Out of this phase’s share/assign scope, but a message invite to a new independent user still does not become a job on their Lucy. Do not “fix” that by moving the person. |

Guest registration, cross-account share between two people who already exist, and WhatsApp speaker routing are intact. They are not the broken transition.

---

## 7. Files, functions, and tests

### Production paths to reuse

| Concern | File | Function |
|---------|------|----------|
| Share vs assign decision and apply plan | `backend/src/services/employee-targets.service.ts` | `planTargetedActions`, `isItemCoShareAdd`, `classifyCollabFromTargets` |
| Write the row | `backend/src/services/employee-records.service.ts` | `applyEmployeeRecords` via the loop in `sendChatMessage` |
| Who may edit later | `employee-records.service.ts` | `loadListItemOwners`, `loadFilingOwners` |
| Find a registered partner | `contact.service.ts`, `employee.service.ts` | `resolveExternalSharePartners`, `listRegisteredHumansByPhones` |
| Shell participants | `list-ops.service.ts` | `applyListOps` |
| Partner notice + WhatsApp | `chat.service.ts`, `whatsapp-send.ts` | `pushTargetNotification`, `deliverWhatsAppRelays` |
| Message-only cold invite | `chat.service.ts`, `whatsapp-invite.service.ts` | `buildColdInvitesForNoSession`, `createWhatsAppInvite`, `buildFatherInviteDraft` |
| Inbound identity and context | `whatsapp.service.ts`, `whatsapp-invite.service.ts`, `chat.service.ts` | `resolveWhatsAppSpeaker`, `bindInboundToInvite`, `composeTurnContext` |
| Job continuation (existing jobs only) | `jobs.service.ts` | answer / decline / counter inside the job applier |

Do not add a second visibility model. Do not call `registerGuestMember` for these users.

### Tests

| Test | What it actually runs | Covers this phase? |
|------|------------------------|--------------------|
| `backend/tests/cross-account-share.test.ts` | Mocked Prisma. Partner lookup and owner checks. | Helpers only. No invite. |
| `backend/tests/employee-targets.test.ts` | In-process planner. Includes phone-relay / `expectsReply` cases. | Share vs assign planning. No WhatsApp invite row. |
| `backend/tests/share-unified-c1c4.eval-db.test.ts`, `share-unified-c5.eval-db.test.ts`, `shell-share-verify.eval-db.test.ts`, `share-unified-sendchat-e2e.eval-db.test.ts` | Real Prisma on `workee_test`. `sendChatMessage` with a stubbed model between **existing** harness users. | Real apply and authorization. No unknown phone, no `WhatsAppInvite`. |
| `backend/tests/share-by-index-model-apply.db.test.ts`, `share-pack-model-apply.eval-db.test.ts` | Real apply of an emitted share for an existing partner. | Same. No invite. |
| `backend/tests/whatsapp-invite.test.ts` | Mocked Prisma. Token, draft, bind does not move the employee, both context formatters. | Invite unit behavior. Not share/assign. |
| `backend/tests/whatsapp-identity.eval-db.test.ts` | Real Prisma. New account, bind does not move identity, guest registration stays on the host, `planTargetedActions` assign across two existing accounts, guest mutate blocked, and a **new** user opening an invite can emit their **own** shopping add. The stubbed model invents that add. The invite does not replay the inviter’s action. | Identity and “no registration gate”. Not share continuity. |
| `backend/tests/guest-register.test.ts` | Mocked Prisma. In-place host promotion. | Legacy guest only. |
| `backend/tests/whatsapp-guest-routing.test.ts` | Routing guest vs Lucy. | Unchanged routing. No share. |
| `backend/tests/jobs.test.ts` | Job answer / decline / counter on an existing job. | Not an invite accept/decline. |
| `backend/tests/whatsapp.test.ts` | Skip-notice wording, including `no_session`. | Copy only. |

**Not exercised at that time:** a share or assign emitted by user A, stored as an invite, opened by a new or existing user B, and applied once through `planTargetedActions` onto B’s employee without moving B’s `userId`. That path is what `2a3ecf7` added. See §8.

---

## 8. Shipped behavior

Commit `2a3ecf70d9b3ac31a204c86523420f70ac947382`. The design document is the as-built record. The earlier proposal (apply on the first message, an `already_applied` invite, and one confirmation applying every pending payload) was not built.

- Accept one invitation by emitting `metadata.collab_invite` set to that invite id, with no other mutations. Decline one invitation by emitting `metadata.decline_invite` set to that invite id, the same way.
- `metadata.confirm` true, false, or omitted does not accept or decline.
- A confirmation applies only the named invite. Other pending invitations for that phone stay pending.
- The claim and the insert are one `prisma.$transaction`: a conditional update from `pending` to `consumed`, then the row. A throw rolls both back, so the invite stays `pending` and can be retried.
- The payload includes a stable `rowId`. A taken id throws and does not allocate a replacement. A live row with that id consumes the invite and does not insert a second row.
- Share stays one inviter-owned row with the recipient in `visibleTo`. Assign stays one row on the recipient with `addedById` set to the inviter. A registered non-guest is still applied immediately and does not get a payload invite.
- Contacts-list adds are not deferred and are not replayed. Worker-tracking titles, `«כולם»`, empty targets, guests, and null payloads stay on their previous paths. There is no closed-session `already_applied` invite and no consume of a null payload on first open.
