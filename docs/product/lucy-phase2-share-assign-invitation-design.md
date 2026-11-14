# Phase 2 — Share / Assign invitation continuity

**Status:** Implemented in `2a3ecf70d9b3ac31a204c86523420f70ac947382`  
**Updated:** 2026-11-14  
**Discovery:** `docs/product/lucy-phase2-share-assign-invitation-discovery.md`  
**Phase 1 commit:** `f841529651552dde061aa1dfe27982f69a8340a2`

This is the behavior of that commit. It does not add a second invite system, a household, billing, or a guest-mode change.

## Goal

When Lucy emits a share or an assign whose partner is a phone contact with no registered account, do not write a personal stand-in on the inviter. Store that emitted action on the existing `WhatsAppInvite`. The invited phone’s own Lucy presents it first. A later turn applies that one invite, through `planTargetedActions`, only when the model emits `metadata.collab_invite` set to its id.

A partner who is already a registered non-guest is still applied on the inviter’s turn, as today.

---

## 1. Verified constraints the design keeps

| Fact | Where |
|------|--------|
| Co-share is one row on the **inviter**, `visibleTo` includes the partner. Assign is one row on the **partner**, `addedById` is the inviter. | `planTargetedActions` / `isItemCoShareAdd` in `employee-targets.service.ts` |
| Unresolved targets fall back to the speaker, so an unknown name becomes a personal row. | `resolveActionTargets` |
| A contact phone becomes a partner only when `listRegisteredHumansByPhones` finds a non-guest human. | `resolveExternalSharePartners` |
| A registered non-guest is applied on the inviter’s turn. No payload invite is created for them. | `partitionDeferredCollabTargets` |
| An unregistered contact phone is stored on `WhatsAppInvite.payload`. Message relays stay null-payload prose. | `createDeferredCollabInvites`, `buildColdInvitesForNoSession` |
| `status` is `VARCHAR(16)`. `expired` is never written. Payload confirm consumes inside `prisma.$transaction`. Guest registration still consumes only a null payload. | `confirmCollabInvite`, `continueInviteAfterRegister` |
| `askerEmployeeId` is not a foreign key. Deleting the inviter’s `User` cascades the invite. Deleting only the employee row does not. | `schema.prisma` |
| A payload token from a different phone does not bind: no `guestEmployeeId`, no consume, no apply. A null-payload bind is unchanged. | `bindInboundToInvite` |
| Inbound message-id dedup is an in-memory set of 200 ids inside one process. Per-phone serialization is also in-memory. Neither is a cross-process lock. | `handleInboundWhatsAppTexts`, `runSerialized` |
| The existing atomic primitive is `prisma.$transaction(async (tx) => …)`. List delete and a new item-plus-clock use it. | `list-ops.service.ts`, `reminder.service.ts` |
| `planTargetedActions` does not write. Replay passes the transaction client into `applyEmployeeRecords`. `stableRowId` is the insert primary key. If that id is taken, the add throws `collab_row_id_taken` and does not allocate a replacement. Outside replay, a taken `items[].item_id` still allocates a new id. | `employee-records.service.ts` |
| `metadata.confirm` does not accept or decline an invitation. Accept is `metadata.collab_invite` set to that invite id. Decline is `metadata.decline_invite` set to that invite id. A delete confirmation is still a later `lists.remove` with an id. | `readCollabInviteDecision`, `sendChatMessage` |
| A shopping or tasks row the recipient can see through `visibleTo` is injected into their facts. It is not copied onto their employee. | `employee-records.service.ts` shared-item facts |
| `matchEmployee` returns the first name alias. Two people named `אורח` collapse. The same function matches a phone only when the string looks like a phone. | `matchEmployee` |
| Attachments usable for a link must belong to the actor’s `userId`. | `resolveUsableAttachments` |
| A guest speaker still cannot mutate. Guest registration still promotes onto the host and then consumes a null-payload invite into a job on the inviter. A payload invite is not that job. | `planTargetedActions`, `continueInviteAfterRegister` |

Requirement “apply only in the recipient’s account” does **not** mean the co-share row moves onto the recipient. That would turn Share into Assign. The trigger is the recipient’s own user and employee. The writes are only the applications `planTargetedActions` returns for this one partner. Share stays one row on the inviter’s list, and the recipient sees it through `visibleTo`. Assign creates the only row, on the recipient’s list. Nothing else is copied.

---

## 2. Data contract and lifecycle

### 2.1 What existing columns already are

| Column | Use in this phase |
|--------|-------------------|
| `token`, `recipientPhone`, `recipientLabel`, `askerEmployeeId`, `userId`, `digitalEmployeeId` | Unchanged identity of the invite. |
| `askSummary`, `draftText` | Human Hebrew only. Never the action JSON. |
| `guestEmployeeId` | Set in the confirm transaction to the recipient employee. Not an authorization source by itself. |
| `status`, `consumedAt` | Lifecycle. New string values fit in `VARCHAR(16)`. |
| `createdAt` | Order when several invites exist for one phone. |

These columns cannot store the action. `askSummary` is 500 characters, is shown to the model, and is not validated as an action. Overloading it is not safe.

### 2.2 One new column

Add nullable `payload Json?` on `WhatsAppInvite`. No backfill. Null means a legacy message invite: Phase 1 context only, no share/assign apply.

No new table. No second token. No household id.

### 2.3 Payload (version 1)

Stored only for a deferred add. Reject anything else at write time and again at read time.

```text
{
  v: 1,
  kind: "share" | "assign",
  domain: "list" | "filing",
  rowId: <uuid minted when the invite is created>,
  action: <one LlmListAction or one LlmFilingAction>
}
```

`rowId` is the primary key the replay insert will use. It lives in `payload`. It is not a new column. It is what a retry looks up so a second insert cannot allocate another id.

Validation (both when saving and when confirming):

- `v === 1`, `kind` is `share` or `assign`, `domain` matches the action.
- List action is `add` only. `listType` is `shopping`, `tasks`, or `custom`. Custom requires a non-empty `listName`.
- Filing action is `add_filing` only, with a non-empty `itemName` and `itemDescription`.
- Exactly one item on a list action.
- Targets stored on the action are empty. Kind is explicit so a later rename cannot flip share into assign.
- Reminders, attachment ids, and list or filing ids are stripped before save.
- Contacts-list adds, worker-tracking titles, and `«כולם»` are not deferred and are not replayed. They stay on the immediate path. `applyListAction` still refuses `lists.*` on contacts, so a contacts add writes nothing.
- `kind: "share"` means the inviter was among the emitted human targets. `kind: "assign"` means they were not.

`askSummary` is a short Hebrew label taken from the item title (existing label helper), truncated to 500 characters. The forwarded draft stays `buildFatherInviteDraft`. Recommended wording is a product decision in §10; the mechanism does not depend on it.

### 2.4 States

| Status | Meaning | Committed when |
|--------|---------|----------------|
| `pending` | Stored action, not yet confirmed. | Create, and again if a confirmation transaction rolls back. |
| `consumed` | The row exists and the invite is done. Also the legacy guest-registration consume of a null payload. | Same transaction as the item or filing insert, or today’s guest path for null payload. |
| `failed` | Payload or asker cannot be used. No row. Not retried. | Its own short transaction, with no insert. |
| `cancelled` | The recipient declined. No row. | Its own short transaction, with no insert. |
| `expired` | Not written. There is no TTL. | — |

`applying` is not a committed status. A compare-and-swap that commits `applying` and then writes the row is not atomic: a crash in between either strands the invite or, if a retry writes again, duplicates the row. In-memory message-id dedup is not the lock.

`consumed` means the recipient confirmed and the row was written. There is no separate `accepted` status.

### 2.5 Atomic confirm

`planTargetedActions` runs first. It does not touch the database.

The write is one existing `prisma.$transaction`:

1. `updateMany` the invite from `pending` to `consumed`, setting `guestEmployeeId` and `consumedAt`, where `id` and `status = 'pending'`.
2. If the count is not 1, stop. Do not insert.
3. If a live row (`deletedAt` null) already has `payload.rowId`, do not insert another. The consume commits. A soft-deleted row with that id throws `collab_row_id_taken`.
4. Insert that one planned row with `tx`, primary key `rowId`, using the application `employeeId` and `visibility` from the plan (`scope`, `addedById`, `visibleTo`, item fields). If the id is taken, throw. Do not allocate a replacement id.
5. If the insert did not leave a row with `rowId`, throw `collab_row_missing`. A throw rolls the status change and the insert back together. The invite stays `pending`. The next confirmation of that same id may try again.

`applyEmployeeRecords` takes that same `tx` for the plain-add writes (list find-or-create, item or filing insert) and inserts `rowId` as the primary key. A taken `rowId` throws. It does not allocate another id. A live row that already has `rowId` consumes the invite and does not insert a second row. A soft-deleted row with that id throws, and the transaction returns the invite to `pending`. Audit stays best-effort on the global client. Classification stays in `planTargetedActions`.

A poison payload or a missing asker is marked `failed` in a separate transaction that does not insert. A decline is marked `cancelled` the same way. Those are terminal on purpose. They are not stranded invitations.

---

## 3. Files and functions

| File | Change |
|------|--------|
| `prisma/schema.prisma` and `20261114120000_whatsapp_invite_payload` | Nullable `payload` JSONB. No other column. |
| `backend/src/services/collab-invite.service.ts` | Parse the payload, present `COLLAB INVITE`, confirm, and cancel. |
| `backend/src/services/whatsapp-invite.service.ts` | Optional payload on `createWhatsAppInvite`. `findPendingCollabInvites` and `findPendingMessageInviteByPhone`. A payload token from another phone does not bind. |
| `backend/src/services/employee-targets.service.ts` | `partitionDeferredCollabTargets` and `replayCollabMetadata`. Share versus assign stays in `planTargetedActions`. |
| `backend/src/services/employee-records.service.ts` | Transaction client and `stableRowId` on the plain-add path. |
| `backend/src/services/chat.service.ts` | Defer before `planTargetedActions`. Inject `COLLAB INVITE`. Apply or cancel only the named invite. Skip payload rows in `continueInviteAfterRegister`. |
| `backend/src/services/whatsapp.service.ts` | Unchanged. The inbound turn already calls `sendChatMessage`, which presents and confirms. |

Do not change `registerGuestMember`, `resolveWhatsAppSpeaker`’s account creation, guest instruction text, or `planTargetedActions`’ classification.

### 3.1 How a target is deferred

On the inviter’s turn, for each emitted list add and filing add:

1. Resolve targets with the current pools (account humans, workers, `externalPartners`).
2. A target that resolved to a registered non-guest stays on the action. `planTargetedActions` runs now. This is requirement “preserve immediate execution”.
3. A target that did **not** resolve, and that `matchContact` maps to a speaker contact with a phone, is deferred. One invite per such phone. Kind follows the same rule as today: inviter present in the human targets that were emitted → `share`; otherwise → `assign`. The contact is not added to the inviter’s row.
4. A target that is neither a registered human nor a contact-with-phone stays on today’s path (speaker fallback if nobody resolved, or dropped if somebody else resolved). Do not read the utterance for a phone number.
5. If every partner on that action was deferred, delete that action from the metadata passed to `planTargetedActions`. That is what stops the personal stand-in.
6. Empty `targets` is still the inviter’s own item. Do not invite.
7. A contacts-list add, a worker-tracking title, `«כולם»`, or a name that matches a guest employee stays on today’s path. Do not invite it.

Shell `add_participants` is unchanged in this slice. An unknown name still returns `unknown_participant`. It is not a second share engine; it is a later use of the same payload, and it is out of this implementation.

Directory book share (`directory.share_book`) is unchanged.

### 3.2 Delivery of the invite

The recipient has no account, so there is no 24-hour session to send into. Reuse `formatColdInviteNotice` and the wa.me draft. The inviter forwards it, as they already do for a cold message. Do not add a WhatsApp template sender.

`expectsReply` on this invite is `false` so the existing draft does not say “לברר” about a list item. Exact Hebrew is §10.

### 3.3 Present, then confirm

The first inbound from the invited phone is not acceptance.

`sendChatMessage` loads pending payload invites for a non-guest speaker’s phone and appends a `COLLAB INVITE` facts block (`formatCollabInviteContext`). `formatInviteOpeningContext` is unchanged. A guest does not receive this block and cannot confirm.

The block names `invite_id`, `kind`, `asker_name`, and `activity`. It tells the model:

- Accept one invitation by emitting `metadata.collab_invite` set to that invite id, with lists, filing, reminders, directory, jobs, messages, and missions empty, and with handoff and register unset.
- Decline one invitation by emitting `metadata.decline_invite` set to that invite id, the same way.
- `metadata.confirm` true or false does not accept or decline. A missing confirm is not a decline.
- Any other request on the turn does not accept or decline.

After the model reply, the engine reads those two fields from the raw metadata. It does not read the utterance and it does not treat `metadata.confirm` as a decision.

- The named id is one of the invites presented on this turn, the matching mutation arrays are empty, and only one of the two ids is set → confirm or cancel that invite.
- Both ids are set, the id was not presented, or the turn also contains another mutation → do nothing. The invite stays `pending`.
- One confirmation applies only that invite. Other pending invitations for the same phone stay pending until their own id is emitted.

Replay inside the confirm transaction:

1. Load the asker. If the employee is missing, not a human, a guest, or has no phone, mark `failed` and do not insert.
2. Build the action with `replayCollabMetadata`. `share` targets are `[asker.phone, recipient.phone]`. `assign` targets are `[recipient.phone]`. The item body comes from the payload, with `item_id` set to `rowId`.
3. `planTargetedActions` with `actor` = asker, `employees` = `[asker]`, `externalPartners` = `[recipient]`, `workers` = `[]`, and the asker’s shells.
4. Require the plan to match the kind. Share: one application on the asker, `visibleTo` contains the recipient. Assign: one application on the recipient, `addedById` is the asker. Otherwise mark `failed` and do not insert.
5. Insert through the plain-add path on `tx`, as in §2.5.

Phone targets keep classification inside `planTargetedActions` when both profiles are still named `אורח`.

The confirming turn’s facts are composed before the insert, and the engine does not rewrite the model’s reply from the confirm result. The next turn sees the row in normal facts: share through `visibleTo`, assign because the row is on the recipient’s employee. The engine runs the action stored from the inviter’s earlier ACTION.

### 3.4 New account and existing account

| Recipient at invite time | Recipient when they message | Result |
|--------------------------|-----------------------------|--------|
| No employee for that phone | `resolveWhatsAppSpeaker` creates their user and Lucy (Phase 1), not a guest | First message presents. Confirm applies on that new employee. |
| Already a non-guest when the inviter spoke | Apply already happened on the inviter’s turn. No payload invite is created. | Unchanged. |
| No account at invite time, then they message before opening the link | The pending payload is still found by phone | Present. Confirm once. A later link does not write again. |
| Legacy `אורח` guest owns the phone | Speaker is a guest | Do not present this payload as a confirm, and do not consume it. Guest registration must not turn it into a host job. |

`continueInviteAfterRegister` selects a pending invite only when `payload` is null. A payload row is never the guest-registration job.

### 3.5 Item changed or deleted before acceptance

The deferred action is a create. There is no row until the confirm transaction commits, so the inviter cannot edit or delete “the shared item” in the meantime. The snapshot is the emitted add. That is intentional: a personal stand-in is what this phase refuses to save.

If the asker’s user is deleted, the database cascades the invite. If only the asker employee is gone, confirm marks `failed` and inserts nothing.

An immediate share to someone who already has an account can still be edited or deleted through today’s `loadListItemOwners` rules. This phase does not add a second apply for that row.

### 3.6 Repeated opens

| Event | Behavior |
|-------|----------|
| Link opened, or any message, before confirm | Context only. Status stays `pending`. No row. |
| Same confirm delivered twice in one process | The message-id set skips the second delivery before the turn. |
| Two processes confirm at once | Both open a transaction. One `updateMany` wins and inserts. The other sees a count of 0 and does not insert. |
| Crash before the transaction | `pending`, no row. The next confirm retries. |
| Crash inside the transaction | Postgres rolls back. `pending`, no row. Not stranded. The next confirm retries. |
| Crash after commit | `consumed` and exactly one row with `rowId`. Further messages do not write. |
| Token sent again after `consumed` or `cancelled` | Lookup requires `pending`. No context, no write. |
| Several pending payloads for one phone | Each invite is presented with its own id. A confirmation applies only the id the model emitted. |
| `metadata.confirm` true, false, or omitted | No accept and no decline. |
| Payload version not 1, or the shape is invalid | `failed`, no insert. A null payload is not marked `failed`. |
| Null payload | Phase 1 context. This confirm gate does not consume it. |

---

## 4. Authorization

- The invited phone is the only caller. A forwarded token from another phone does nothing.
- The asker is the actor inside `planTargetedActions`. The recipient is the only `externalPartner`.
- Share grants `visibleTo` on that one new or existing shell item. It does not set `seeAll`, does not list the asker’s other rows into the recipient’s facts, and does not change `userId` or `isGuest`.
- Assign creates one row on the recipient. The asker’s other lists stay on the asker.
- Later edits use `loadListItemOwners` / `loadFilingOwners` unchanged.
- `«כולם»` is not replayable.
- No team write, no household write, no `registerGuestMember`.
- Guest mutate block stays. A guest cannot confirm this payload.
- Attachment ids are not in the payload, so a file on the asker’s user is not linked into the recipient’s user.

---

## 5. Failure and retry

| Failure | Status afterward | Row | Next confirm |
|---------|------------------|-----|--------------|
| Phone mismatch | `pending` | None | The right phone can still confirm. |
| Guest speaker | `pending` | None | Not offered. |
| User does something else | `pending` | None | Still offered. |
| Decline (`decline_invite` is the presented invite id, no other mutations) | `cancelled` | None | No. |
| `metadata.confirm` true or false, with no invite id | `pending` | None | Still offered. |
| Asker missing, or the plan does not match the kind | `failed` | None | No. |
| Insert throws | `pending` (transaction rolled back) | None | May try again. |
| Process dies before or during the transaction | `pending` | None | May try again. |
| Process dies after commit | `consumed` | The one `rowId` | No. |

Do not commit `applying`. Do not mark `failed` for a transient insert error; that would strand a valid invite. `failed` is only for a payload or asker that cannot succeed on a retry.

The inviter’s own turn, if invite creation fails, must not fall back to a personal row. Surface the existing cold-invite failure path (`cold_invite_failed` / the skip notice). The item stays unshared.

---

## 6. Backward compatibility

| Existing data | Behavior |
|---------------|----------|
| `payload` null, `pending` | Phase 1. Non-guest gets `formatInviteOpeningContext`. Guest gets the registration script. Guest registration may still consume it and open a host job. No list row is invented. |
| `payload` null, already `consumed` | Untouched. |
| Registered partner share/assign | Still immediate. No payload row. Existing eval assertions stay. |
| People already promoted onto a host | Not split. Not selected as external partners when `isGuest` is true. |
| Legacy guest who owns the invited phone | Invite waits. It is not applied onto the host and not consumed by registration. |

No production data rewrite. The migration adds a nullable column only.

---

## 7. Test plan

Eval database `workee_test` only. Stub the model. No WhatsApp send. No production database.

Call the real functions: `sendChatMessage` for the inviter and for the recipient’s confirm turn, `resolveWhatsAppSpeaker` for a new phone, and `planTargetedActions` inside the confirm transaction.

| # | Path | Assert |
|---|------|--------|
| 1 | Registered partner, co-share, through `sendChatMessage` | One row on the inviter, partner in `visibleTo`, no `WhatsAppInvite` payload. Partner `userId` unchanged. |
| 2 | Registered partner, assign, through `sendChatMessage` | One row on the partner, `addedById` is the inviter, no co-owned copy on the inviter, no payload invite. |
| 3 | Contact phone with no employee, co-share | No row on the inviter before the recipient arrives. One pending invite, `kind=share`, payload validates, `askSummary` has no JSON. |
| 4 | That phone’s first inbound | New user, `isGuest` false, `userId` is not the inviter. No row yet. Invite stays `pending`. Context asks; it does not contain `metadata.register`. |
| 5 | Following turn emits `collab_invite` equal to that invite id and no mutations, co-share | One inviter row, primary key `rowId`, recipient in `visibleTo`. Invite `consumed`. |
| 6 | Same for assign | No inviter row. One row on the recipient, `addedById` inviter, id `rowId`. |
| 7 | The same `collab_invite` again, and two overlapping transactions | Still one row. The loser does not insert. |
| 8 | Confirm turn also emits a list change, or the user only asks something else | Invite stays `pending`. No row. |
| 9 | `decline_invite` is that invite id and there are no mutations | `cancelled`. No row. `confirm: false` alone does not cancel. |
| 10 | Token from a different phone | Invite stays `pending`. That speaker’s `userId` unchanged. No row. |
| 11 | Existing non-guest confirms a payload created before their account existed | Their original `userId` and `isGuest`. One apply. |
| 12 | Null payload, non-guest | No new list row. This feature does not consume it. |
| 13 | Guest registration while a payload invite and a null-payload invite both exist | Guest stays on the host. Null payload may still become the host job. Payload invite is not consumed and not applied. |
| 14 | Asker missing, a guest, or without a phone; or a stored plan that does not match `kind` | `failed`. No row. A non-empty stored `targets` value fails parse. |
| 15 | Transaction rolls back (insert throws) | Status returns to `pending`. No row. A later confirm can succeed. |
| 16 | Existing suites | `share-unified-sendchat-e2e.eval-db.test.ts`, `cross-account-share.test.ts`, `whatsapp-identity.eval-db.test.ts`, `whatsapp-invite.test.ts`, `guest-register.test.ts` stay green. |

`backend/tests/collab-invite.eval-db.test.ts` covers registered share (no payload), present without a row, `collab_invite`, `decline_invite`, a repeated and a concurrent confirm, an insert failure that restores `pending` and the same `rowId`, a wrong phone, a null payload, an invalid payload, and a confirm mixed with another add. Registered assign fan-out stays in `share-unified-sendchat-e2e.eval-db.test.ts`. There is no separate eval for a deleted asker.

---

## 8. Acceptance

### Share

- Registered partner: unchanged immediate co-share.
- Unregistered phone contact: no personal stand-in.
- After that phone messages Lucy: no row yet. Lucy asks. The person is on their own user, with full Lucy.
- After they agree and the model emits `metadata.collab_invite` set to that invite id, with no other mutations: one inviter-owned row, recipient in `visibleTo`.
- Recipient does not see the inviter’s other lists, reminders, or contacts.
- A second confirm does not add a second shared row or a second `visibleTo` entry.
- A refusal emits `metadata.decline_invite` set to that invite id and writes `cancelled` and no row. `metadata.confirm` does not do this.
- Wrong phone cannot apply it.

### Assign

- Registered partner: unchanged immediate fan-out, `באחריות` / `addedById` as today.
- Unregistered phone contact: nothing stored on the inviter.
- After that phone messages Lucy: nothing is stored yet.
- After `metadata.collab_invite` names that invite: one row on the recipient, `addedById` is the inviter, no copy on the inviter.
- A second confirm does not create a second accountable row.
- A refusal emits `metadata.decline_invite` for that invite and writes `cancelled` and no row.
- Wrong phone cannot apply it.
- Guest registration and Phase 1 identity tests still pass.

---

## 9. Shipped scope

Commit `2a3ecf7` adds the nullable payload, defers unregistered contact phones, presents `COLLAB INVITE` inside `sendChatMessage`, and applies only the named invite in one transaction. It does not add shell-list invitations, expiry, inviter-side cancel, or a closed-session draft for a partner who was already applied.

---

## 10. Decisions

### Product decisions, unresolved

| Decision | Recommendation if unanswered |
|----------|------------------------------|
| Should a registered partner with a closed 24-hour window also get a wa.me draft? | No. Their row is already written and already on their Lucy thread. A draft for them must not carry a payload. |
| Hebrew of the question Lucy asks, and of the forwarded draft? | One Hebrew question on the recipient’s turn (“טל שיתף איתך … לאשר?” / “טל הטיל עליך … לקחת?”). The forwarded draft keeps `buildFatherInviteDraft` with `expectsReply` false and a mission line that names the item. |
| Should the inviter see the item on their list before the recipient confirms a co-share? | No. A row without the partner is the stand-in this phase forbids. |
| Whole-list shell invite for an unknown participant? | Not this slice. |
| Expire, or let the inviter cancel from their side? | Not this slice. The recipient can decline. |

Confirmation is invite-specific. Accept is `metadata.collab_invite` set to the presented invite id, with empty mutation arrays. Decline is `metadata.decline_invite` set to that id, the same way. `metadata.confirm` does not accept or decline. One confirmation does not apply any other pending invitation.

### Technical decisions, settled by the code

| Decision | Choice |
|----------|--------|
| Where the action lives | New nullable `payload`, including `rowId`. Existing columns stay lifecycle and prose. |
| Who classifies share versus assign | `planTargetedActions`. The plan is checked against `kind` before the insert. |
| How the write is atomic | One `prisma.$transaction`. Status and the row commit together, or both stay uncommitted. `applying` is not stored. |
| Why the claim and the insert are one transaction | `updateMany` from `pending` to `consumed` and the insert share `tx`. A throw restores `pending`. `stableRowId` throws `collab_row_id_taken` instead of allocating a new id. A live row with that id consumes without a second insert. |
| How names are avoided | Replay targets are the two phone numbers, not display names. |
| Where share is written | Asker’s employee, recipient in `visibleTo`. The recipient sees it in their facts. They do not get a second owned row. Assign is the row on the recipient. |
| What confirms | `metadata.collab_invite` equal to the presented invite id, with empty mutation arrays. `metadata.confirm` is ignored. The engine does not read “כן”. |
| What declines | `metadata.decline_invite` equal to that invite id, with empty mutation arrays. |
| Several pending invites | Only the named id is applied or cancelled. |
| Legacy null payload | Unchanged, including guest registration consume. |
| Guest who still owns the phone | Do not apply and do not consume the payload. |
