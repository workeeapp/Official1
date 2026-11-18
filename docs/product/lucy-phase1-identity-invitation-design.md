# Phase 1 — independent accounts and invitation context

**Status:** Design for review — no implementation  
**Updated:** 2026-11-14  
**Audit:** `docs/product/lucy-existing-capabilities-gap-audit.md`  
**Rule:** Reuse existing executors. Change only the identity boundary and the invite handoff.

## Goal

A person who messages Lucy, or who opens an invitation, gets their own `User` and their own Lucy. The invitation tells that Lucy which activity to open with. It does not create a guest, does not move an existing account, does not join a household, and does not turn capabilities off.

Share, assign, and jobs stay the collaboration mechanism.

## Non-goals

- Household table, multi-household, or membership implied by an invite.
- Pilot access status, expiry, grace, Stripe, subscriptions, billing.
- Public web signup, passwords for WhatsApp users.
- A second share engine, a new event model, or a reminder rewrite.
- Splitting people who were already promoted onto a host account. That is a later migration (§7).

---

## 1. Verified behavior this design replaces

| Path | Function | Verified behavior |
|------|----------|-------------------|
| Unknown WhatsApp phone | `resolveWhatsAppSpeaker` in `backend/src/services/whatsapp.service.ts` | Creates `אורח` / `isGuest: true` on `users[0]` |
| Invite bind | `bindInboundToInvite` in `backend/src/services/whatsapp-invite.service.ts` | If `employee.userId !== invite.userId`, sets `userId` to the inviter, `teamId` null, `isGuest: true`. No guest check. Also matches by phone with no token. |
| Who they talk to | `runWhatsAppTurn` in `whatsapp.service.ts` | `isGuestEmployee` selects לוסי-אורח |
| What Lucy is allowed to do | `formatRuntimeExtras` guest branch in `chat.service.ts`; `formatPendingInviteContext` | Forbids answering the invite and omits the normal capability rules. `planTargetedActions` sets `guestMutationBlocked`. |
| Registration | `registerGuestMember` in `guest-register.service.ts` | Same employee, same host `userId`, `isOwner=false`, team `New Registered 30 days` |
| After register | `continueInviteAfterRegister` in `chat.service.ts` | Consumes the invite and opens a job on the **host** user |
| Share / assign | `planTargetedActions`, `resolveExternalSharePartners` | Work when the partner is already a non-guest employee. They do not create an invite. |
| Cold invite creation | `buildColdInvitesForNoSession` in `chat.service.ts` | Only a `messages` send that WhatsApp could not deliver |

The identity move is real. Conditions, and the columns it does not update (`Reminder.userId`, `ChatConversation.userId`, contacts, attachments, tips), are in the audit §2.3.

Unused pieces to call instead of inventing: `createWhatsAppOnlyUser` (`user.service.ts`), `ensureProtectedLucy` (`employee.service.ts`).

---

## 2. Target flow

### New person, no invite

1. Inbound phone matches no employee.
2. Create a `User` (`createWhatsAppOnlyUser`), a human employee on that user (`isGuest: false`, `isOwner: true`, phone set), and protected Lucy (`ensureProtectedLucy`).
3. The turn calls `sendChatMessage` as that user, with that human, with that Lucy.
4. If name or gender is missing, Lucy may ask, in the normal prompt, and a later turn stores them on this employee. Other actions are allowed on the same turn.

### New person, invitation

1. Same account creation as above. Do not create the employee on the inviter’s user.
2. Resolve the pending invite by token, or by recipient phone if the token was already consumed into the thread.
3. Pass invite context into the **normal** Lucy turn: asker display name, activity summary, and the kind (`nudge` | `share` | `assign`) plus the ids the executors need.
4. Lucy’s first reply is about that activity. The context block does not forbid other capabilities.
5. Apply the pending activity once, with the existing executors (§4), then mark the invite consumed. Applying it is permission for that activity only (`visibleTo` or a job). It is not a household join and not a capability grant.

### Existing user, invitation

1. `resolveWhatsAppSpeaker` finds their current employee (it already prefers a non-guest).
2. `bindInboundToInvite` returns context and does not write `userId`, `teamId`, or `isGuest`.
3. Their Lucy receives the same context block.
4. The pending share, assign, or job is applied to **their** employee id.
5. Their lists, reminders, conversations, and `isOwner` stay on their `User`.

---

## 3. Code changes

Each step is the smallest edit that makes the requirement true. Do not delete guest code in this slice: existing `אורח` rows still resolve to לוסי-אורח until a migration says otherwise.

### 3.1 Create an account for a new phone

**File:** `backend/src/services/whatsapp.service.ts`  
**Function:** `resolveWhatsAppSpeaker`

When no phone matches:

- Call `createWhatsAppOnlyUser`.
- Create the human with `createEmployeeForUser` on that new id, `isGuest` omitted or false, `isOwner: true`, phone set, name still `אורח` until they give one (the name is not what makes them a guest; `isGuestEmployee` follows the boolean).
- Call `ensureProtectedLucy` for that user before the turn chooses a digital.

Remove the `users[0]` fallback for this case. Keep the match loop for phones that already exist.

**Do not** set `isGuest: true` on this path.

### 3.2 Stop moving an existing employee

**File:** `backend/src/services/whatsapp-invite.service.ts`  
**Function:** `bindInboundToInvite`

Delete the `employee.update` that sets `userId`, `teamId`, and `isGuest`. Keep the lookup by token and by phone. Store `guestEmployeeId` only as “the employee this invite is bound to”, or rename it in a later migration; for this slice, write the existing employee id into `guestEmployeeId` without moving the row. The column name can stay so the migration stays empty.

If the phone already belongs to a non-guest on another account, return that `userId` and `employeeId` unchanged.

**Test to replace:** `backend/tests/whatsapp-invite.test.ts` currently expects the move. The new assertion is that `employee.update` is not called with a different `userId` or `isGuest: true`.

### 3.3 Talk to Lucy, not לוסי-אורח

**File:** `backend/src/services/whatsapp.service.ts`  
**Function:** `runWhatsAppTurn`

The לוסי-אורח branch stays for `isGuestEmployee` rows that already exist. New accounts from §3.1 are not guests, so they take the protected-Lucy branch (`sessionDigitalFromSticky` / protected digital). No new digital type.

### 3.4 Invitation context on a normal turn

**Files:** `whatsapp-invite.service.ts` (`formatPendingInviteContext`), `chat.service.ts` (the guest extras around `pendingInvite`, and the fact block that already appends `formatPendingInviteContext`).

For a non-guest speaker:

- Inject asker name, activity summary, kind, and target ids.
- Instruct Lucy to open in that context in Hebrew (for example Tal’s shopping list) and to keep the rest of the catalog.
- Do not append the guest block. Do not set `guestMutationBlocked`. Do not omit `OPEN_JOBS_RULES` or the other capability extras.

`planTargetedActions` needs no new guest exception. New users are not guests, so the existing guest return stays for old shells only.

Profile collection, if still required by product copy, is a normal filing or employee update on **this** `userId`. `registerGuestMember` is not called for these turns.

### 3.5 Registration must not promote

**File:** `guest-register.service.ts`  
**Caller:** `chat.service.ts` where `metadata.register` is applied.

For a non-guest on their own account, `metadata.register` (or a plain employee update) writes `name`, optional `surname`, and `addressGender` on that employee id and leaves `userId`, `isOwner`, and `teamId` alone.

Leave `registerGuestMember` in place for an existing guest shell until those rows are migrated, so an old לוסי-אורח chat does not start throwing. Do not use it for accounts created in §3.1.

### 3.6 Connect share and assign

**Do not change** the share and assign rules inside `planTargetedActions`.

**Create path** — `buildColdInvitesForNoSession` and the call site in `chat.service.ts` that runs when a phone delivery is skipped:

- Today this runs for `messages` relays and phone sends.
- Also open a `WhatsAppInvite` when a list or filing action targeted a phone that did not resolve to a non-guest employee (share or assign). The model already emits `targets`. The engine records the emitted action; it does not infer the utterance.
- Persist, on the invite, enough to replay that action: kind `share` | `assign` | `nudge`, the list or item id, list type, and the inviter employee id. `askSummary` remains the Hebrew line Lucy shows. A narrow column or a single JSON payload is enough. No new table if `WhatsAppInvite` can hold it.

**Apply path** — when the recipient’s own employee id is known (new account or existing account) and the invite is still pending:

- `nudge`: `createJobsFromRelays` with the recipient as the subject, on the **recipient’s** `userId` and their Lucy, and notify the asker. This is the same function `continueInviteAfterRegister` already calls, with a different `userId`.
- `share` or `assign`: build the same `LlmMetadata` fragment the inviter’s turn already emitted, and run `planTargetedActions` with `externalPartners` set to the recipient employee (the same pool `resolveExternalSharePartners` fills). Apply the returned applications through the existing per-employee apply in `chat.service.ts`. Co-share stays one row with `visibleTo`. Assign stays a row on the recipient’s book.
- Then `consumeWhatsAppInvite`.
- A second delivery of the same invite is a no-op because status is no longer `pending`.

If the recipient already could have been resolved (they were a registered contact), the current turn already shares. Do not also create an invite. The invite exists only for the miss.

### 3.7 Prompt

One addition to the normal Lucy extras, not a second catalog: when `PENDING_INVITE` is present and the speaker is not a guest, open from that activity and do not refuse unrelated requests. Remove, for that case only, the sentences that forbid answering and that require `metadata.register` before any other action.

Those sentences remain on the לוסי-אורח instructions for leftover guest shells.

---

## 4. What is intentionally unchanged

| Piece | Why |
|-------|-----|
| `planTargetedActions` share vs assign | Already the cross-account behavior the pilot needs |
| `loadListItemOwners` | Later edits stay limited to owner or `visibleTo` |
| `«כולם»` | Stays inside one account, so an invite cannot mean “whole household” |
| Job answer, decline, counter | How the recipient continues a nudge |
| Reminders, recurrence, meetings-as-tasks | Not part of identity |
| `CONVERSATION_IDLE_MS` (40 minutes) | Saved rows and the re-injected invite survive it |
| Household | No schema. An invite must not write a membership that does not exist. |
| Billing and pilot expiry | No fields, no gates |

---

## 5. Implementation sequence

| Step | Change | Production paths | Done when |
|------|--------|------------------|-----------|
| 1 | New phone → own `User` + Lucy | `resolveWhatsAppSpeaker`, `createWhatsAppOnlyUser`, `ensureProtectedLucy` | A phone that matches nobody is not on `users[0]`, `isGuest` is false, and the turn uses protected Lucy |
| 2 | Invite bind never moves a row | `bindInboundToInvite` | An employee on user A, with a pending invite from user B, still has `userId` A and `isGuest` false after the webhook |
| 3 | Context on normal Lucy | `formatPendingInviteContext`, `chat.service.ts` extras | First reply can name the asker and the activity; a following “what’s the weather” is not refused by guest rules |
| 4 | Replay share, assign, or nudge | `buildColdInvitesForNoSession`, `planTargetedActions`, `createJobsFromRelays`, `consumeWhatsAppInvite` | After step 1 or 2, the invited list is visible through the existing `visibleTo` / fan-out rules, or the job exists on the recipient’s Lucy |
| 5 | Profile write stays local | `registerGuestMember` caller | Name and gender do not change `userId` |

Step 1 and step 2 ship together. Shipping step 1 alone still leaves step 2 able to move the new account onto the inviter on the next invite message.

Tests to add or retarget, on the local eval database only:

- `whatsapp-invite.test.ts`: bind does not update `userId` or `isGuest`.
- Guest-routing: unknown phone creates a user rather than using the oldest one.
- One sendChat (stubbed model) share replay: recipient employee on user B ends with `visibleTo` or an assigned row, and user B’s other lists are absent from user A’s non-owner view.
- Existing cross-account tests (`cross-account-share.test.ts`, `share-unified-sendchat-e2e.eval-db.test.ts`) stay green without modification of their assertions.

---

## 6. Prompt and context, not a new mode

Danny opens Tal’s shopping-list invite.

Verified today: Danny is a guest on Tal’s account. לוסי-אורח states the ask and refuses other work until host registration.

Desired: Danny’s Lucy receives `PENDING_INVITE` with Tal’s name and that list, greets him in that context, and still has the normal extras. The share replay from §3.6 is what lets him see the list. Authorization for everything else is the ordinary non-owner scope: his rows, plus rows whose `visibleTo` includes him.

No restricted-account flag is added.

---

## 7. Backward compatibility

| Existing data | Phase 1 behavior |
|---------------|------------------|
| Registered owner on their own `User` | Unchanged, unless they currently trip the move. Step 2 stops that. |
| Non-guest already on the host under `New Registered 30 days` | Left on the host. Not split in this slice. |
| `אורח` guest and לוסי-אורח | Still routed as today. No new guests are created. |
| `WhatsAppInvite` rows | Old rows have no share payload. Resume them only as nudges (`askSummary` + job), which is what `continueInviteAfterRegister` already does. Do not invent a list id. |
| `shareMirrorEmployeeId` | Leave null. Do not read it as identity. |
| Rows already damaged by a past move | Do not repair inside this slice. Before implementation, a read-only check can list `isGuest=true` employees whose name is not `אורח`, and employees whose `userId` disagrees with their reminders or conversations. Any repair is a separate reviewed write. |

Splitting old host members later must update `userId` on `Employee` and on `Reminder`, `ChatConversation`, `Contact`, `ContactBook`, `Attachment`, and `Tip` in one transaction. Updating only the employee repeats the clock and thread split.

---

## 8. Review stop

No application code, prompt, database, or configuration change is included here. The next implementation step is §5 step 1 together with step 2: own account for a new phone, and no `userId` rewrite when an invite is opened.
