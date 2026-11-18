# Lucy guest-product removal plan

Audit only. This document does not remove Guest behavior, change runtime code, or migrate data.

Steps 1–3 are already in the working tree and are the baseline this plan must not regress:

- A new WhatsApp number gets its own account. `resolveRecordVisibility` uses the persisted `isGuest` flag, so a person named אורח with `isGuest: false` sees their own lists and clocks.
- A pending Share applies on the recipient’s first `sendChatMessage` through `confirmCollabInvite`. The row stays on the sender. The recipient is in `visibleTo`.
- A pending Assign applies the same way. The row is on the recipient. `addedById` is the sender.

An unregistered phone is an external contact. Trial and subscription are not identity and are not part of this removal.

## One Lucy, not a second employee

לוסי-אורח was built as a separate conversational identity, and the reason for that identity was a temporary onboarding flow.

The shipped behavior in `docs/features.md` §17–18 and `docs/future-considerations.md` is: an unknown number becomes an אורח shell on the inviter’s account and talks with לוסי-אורח, not Lucy. She is her own digital employee, with her own prompt (`GUEST_LUCY_INSTRUCTIONS`) and her own `ChatConversations` row (`digitalEmployeeId`). Her prompt tells her to hand the person to לוסי on the next message. `registerGuestMember` then clears WhatsApp sticky so the next turn selects protected Lucy, and `getChatHistory` merges the לוסי-אורח thread into Lucy’s history so the split does not last. She is hidden from Chat-with. That is a second speaker used as a gate, then discarded.

`docs/product/lucy-phase1-identity-invitation-design.md` §3.3–3.4 already decided the lasting product is the opposite for anyone new: “Talk to Lucy, not לוסי-אורח,” “No new digital type,” and invitation text on a normal turn (`formatInviteOpeningContext`) that does not refuse the rest of the catalog. Share and Assign were specified there as replays through `planTargetedActions`, not as a conversation with לוסי-אורח. Steps 2–3 implemented that replay on the recipient’s own Lucy.

Nothing found requires a replacement digital employee. Stating who invited someone, what the activity is, and collecting a name or form of address are instructions and facts on the account’s one Lucy. `formatInviteOpeningContext` is that path today for a non-guest. A second employee would open a second history and would need another handoff, which is the split this design already tried to repair with the history merge.

Implementation constraint:

- One Lucy identity and one conversation history per account and speaker.
- Invitation and onboarding may add instructions, facts, and engine rules on that same turn.
- Normal Lucy handles the conversation. Do not route the speaker to another digital employee, and do not create a successor to לוסי-אורח.
- Share and Assign stay on `applyPendingCollabInvites` / `confirmCollabInvite`. They do not read לוסי-אורח, `GUEST MODE`, or `metadata.register`.

## Classification

1. **Obsolete product behavior** — the separate Guest experience. Remove only after the data inspection below, and only together with the tests that lock the replacement.
2. **Necessary technical safety guard** — keep while any `isGuest: true` host shell can still exist. These guards stop Share, Assign, and phone matching from landing on the wrong row.
3. **Potentially obsolete data or model field** — do not drop, rename, or backfill until the inspection queries have been read.
4. **Unclear dependency** — a live call whose name says “guest” but whose current job is broader than the Guest product.

## What still happens on a live request

```text
WhatsApp inbound
  resolveWhatsAppSpeaker
    findExistingWhatsAppSpeaker     prefer a non-guest row for this phone
    createIndependentWhatsAppAccount  new User, human isGuest false, isOwner true, name אורח
  bindInboundToInvite                 may set guestEmployeeId; calls ensureGuestLucy on the inviter
  runWhatsAppTurn                     if the speaker is isGuest, route to לוסי-אורח
  sendChatMessage
    guestSpeaker = isGuestEmployee(speaker)
    if guest: GUEST MODE prompt, view-only engine, registerGuestMember, no Share/Assign apply
    if not guest: applyPendingCollabInvites, then facts
  getEmployeeRecordSnapshot
    guestMode from persisted isGuest
    guest shell: personal lists and clocks omitted
```

`listEmployeesForUser` calls `ensureGuestLucy` for every account, including a new independent WhatsApp user. That creates לוסי-אורח even when the human is not a guest. Routing uses that worker only when `isGuestEmployee(speaker)` is true.

## Inventory

### Identity and routing

| Where | What it does | Class |
|---|---|---|
| `shared/src/types.ts` `isGuestEmployee` | If `isGuest` is a boolean, that value wins. If the flag is omitted, the name אורח or a nickname starting with `אורח ` still counts as a guest. | **2** for the boolean. **2** for the name fallback until every caller passes the flag. The fallback is how a real independent user would be misclassified if a caller forgets the column. |
| `shared/src/types.ts` `isGuestLucy`, `GUEST_LUCY_NAME` (`לוסי-אורח`) | Recognizes the onboarding digital worker by name. | **1** once no speaker is routed there. Keep the helper until that worker is no longer created or addressed. |
| `shared/src/types.ts` `workspaceHumans` | Drops `isGuest` humans from the Employees table set. | **1** as a product filter. **2** while shells exist, so they do not appear as normal teammates. |
| `backend/src/services/whatsapp.service.ts` `createIndependentWhatsAppAccount` | New phone: own user, `isGuest` left false, protected Lucy. This is the current product. | Not Guest behavior. Do not change it in the removal. |
| `backend/src/services/whatsapp.service.ts` `findExistingWhatsAppSpeaker` | Same phone on a guest shell and a real human: the non-guest row wins. | **2.** Removing this lets an old shell capture a number that already has an independent account. |
| `backend/src/services/whatsapp.service.ts` `runWhatsAppTurn` | `isGuestEmployee(speaker)` selects לוסי-אורח, otherwise sticky or protected Lucy. | **1** for new users, who are not guests. **2** for a leftover shell: this is the only route that still reaches the guest worker. Remove routing and shell handling in one step, after inspection. |
| `backend/src/services/employee.service.ts` `ensureGuestLucy` | Creates לוסי-אורח with `GUEST_LUCY_INSTRUCTIONS` when missing. Does not overwrite an edited prompt. Digitals are stored `isGuest: false`. | **1.** It still runs for every new account. |
| `backend/src/services/employee.service.ts` `listEmployeesForUser` | Calls `ensureProtectedLucy`, then `ensureGuestLucy`, then the mission executor. | **1** for the `ensureGuestLucy` call. The other two calls stay. |
| `backend/src/services/employee.service.ts` `createEmployeeForUser` | `options.isGuest === true` stores a human with `teamId: null`. | **1** as a way to create a shell. **2** until tests and any leftover creator stop needing it. |
| `backend/src/services/employee.service.ts` `updateEmployeeForUser` | A human who is already `isGuest` stays `isGuest` with `teamId: null`. The Employees form cannot promote or demote them. | **2** until shells are decided. A UI save must not silently turn a shell into an owner or the reverse. |
| `backend/src/services/employee.service.ts` `toPublicEmployee` | Copies `employee.isGuest` onto the public row. Digitals are reported false. | **3.** Callers of `isGuestEmployee` depend on this boolean being present. |

### Registration and the old invite continuation

| Where | What it does | Class |
|---|---|---|
| `backend/src/services/guest-register.service.ts` `registerGuestMember` | Requires a guest human talking to לוסי-אורח. Updates that same employee: name, gender, `isGuest: false`, `isOwner: false`, shared host team. Keeps the phone. Does not create a second `User`. Clears WhatsApp sticky. | **1.** This is the flow that joins someone into another person’s account. |
| `backend/src/services/chat.service.ts` `sendChatMessage` around the `guestSpeaker && metadata.register` branch | Calls `registerGuestMember`, then `continueInviteAfterRegister`. Success copy says they can now talk to לוסי. | **1.** |
| `backend/src/services/chat.service.ts` `continueInviteAfterRegister` | Loads a pending invite by `guestEmployeeId`, skips a payload invite, otherwise loads the null-payload message invite, consumes it, and opens a job on the **inviter’s** `userId`. | **1** as the post-registration job. **4** for the payload skip: Share and Assign must keep ignoring this function. Do not move payload invites onto this path when the function is deleted. |
| `backend/src/services/whatsapp-invite.service.ts` `ensureGuestLucy(invite.userId)` inside `bindInboundToInvite` | Every successful bind creates לוסי-אורח on the inviter’s account. Bind does not change the speaker’s `userId`, `teamId`, or `isGuest`. A payload invite whose phone does not match returns null before that call. | **1** for creating לוסי-אורח. **2** for the phone mismatch return: Share and Assign depend on it. |
| `backend/src/services/whatsapp-invite.service.ts` `findPendingInviteForGuest` | Latest pending invite whose `guestEmployeeId` is this employee. | **4.** The name is the Guest product. `runWhatsAppTurn` still uses it to rebind a sticky invite, and `continueInviteAfterRegister` uses it for the null-payload job. |
| `backend/src/services/whatsapp-invite.service.ts` `formatPendingInviteContext` | Injects `PENDING_INVITE` and tells the model to emit `metadata.register` before answering the ask. Comment says leftover אורח shells only. | **1.** New independent users must not receive this script. |
| `LLM.action.json` `metadata.register` | Schema text tells לוסי-אורח to promote the guest onto the host team. | **1.** |
| `backend/src/services/employee.service.ts` `GUEST_LUCY_INSTRUCTIONS` | Seed prompt for the לוסי-אורח row: view shared lists, collect name and gender, emit `metadata.register`. | **1.** |
| `backend/src/services/chat.service.ts` `buildLucyInstructions` | When `guestSpeaker` is true, replaces the normal catalog with `GUEST MODE` text, blocks jobs, missions, attachments, and the capability catalog, and points at `metadata.register`. | **1** as the product prompt. It does not run for `isGuest: false`. |
| `backend/src/services/chat.service.ts` `getChatHistory` | When the open digital is protected Lucy, merges that speaker’s לוסי-אורח thread into the history. | **1** after routing is gone. **4** until then: deleting the merge drops pre-registration history for any shell that still has those messages. |

`confirmCollabInvite` writes the consuming employee into `WhatsAppInvite.guestEmployeeId`. That column is the recipient who claimed a Share or Assign, not proof that the person is a guest. Treat the column as **4**: live Share/Assign data with a legacy name. Do not drop it in the Guest removal.

### Chat restrictions that follow `guestSpeaker`

`sendChatMessage` sets `guestSpeaker` once, from `isGuestEmployee(employee)` on the loaded public employee. That load includes the database flag, so a new אורח is not a guest speaker.

While `guestSpeaker` is true the turn skips contacts, external partners, jobs, missions, dumps, locations, team schedules, Share/Assign activation, collab presentation, reminders, directory, list ops, relays, weather, market, mashov, smartschool, places, routes, flights, and attachment send. A list, filing, reminder, directory, or message mutation is replaced with the Hebrew line `אפשר רק לצפות ברשימות ששותפו איתך — בלי להוסיף או לשנות.`

`backend/src/services/employee-targets.service.ts` `planTargetedActions` sets `guestMutationBlocked` when the actor is a guest and the metadata has a list or filing mutation. The same file drops guest targets out of mutate sets, and `partitionDeferredCollabTargets` keeps a guest name match on today’s path instead of deferring a Share or Assign to that phone.

`backend/src/services/tips.service.ts` skips tip delivery for a guest speaker. `backend/src/services/mission.service.ts` refuses missions for a guest speaker. `backend/src/services/list-ops.service.ts` removes guests from the name-resolution pool. `backend/src/services/reminder.service.ts` `shareWorkerTaskWithPingRecipients` does not add a guest to a worker task’s `visibleTo`.

Class for this whole group: **1** as the restricted Guest product. **2** as the fence around a leftover `isGuest: true` shell. Remove the product copy and the registration branch together. Leave a single refuse path for `isGuest: true` until the inspection shows no such humans, or until those rows have been handled by an explicit later decision. Do not replace that fence with a trial or a read-only subscription mode.

### Snapshot visibility

`backend/src/services/employee-records.service.ts` `resolveRecordVisibility` loads `isGuest` and passes it into `isGuestEmployee`. `guestMode` then:

- forces `seeAll` false
- drops personal lists
- keeps only shared filings
- returns no reminder clocks
- skips shared-into-own rows
- makes schedule helpers return empty

`getEmployeeRecordSnapshot` also returns an empty snapshot when `scopeItemsToViewerId` resolves to a guest.

Class: **2.** This is the Step 1 fix. A host shell must stay unable to see personal rows and clocks. An independent user with `isGuest: false` must keep seeing theirs. Do not delete these branches until `isGuest: true` humans are gone and the regression tests below have been rewritten to assert that absence rather than the shell behavior.

The cross-account shared-row load added for owners in Step 2 is not Guest behavior. Leave it.

### Share and Assign guards

`backend/src/services/collab-invite.service.ts`:

| Check | Class |
|---|---|
| `applyPendingCollabInvites` returns immediately when `isGuestEmployee(recipient)` | **2.** A host shell must not consume a pending Share or Assign. |
| `confirmCollabInvite` returns `lost` for a guest recipient | **2.** Same fence, including a direct call. |
| `confirmCollabInvite` marks the invite `failed` when the asker row is `isGuest` or has no phone | **2.** A shell must not become the owner of a replayed Share or the `addedById` of an Assign. |
| `plan.guestMutationBlocked` inside `confirmCollabInvite` fails the invite | **2.** It is the same actor fence, reached through the replay plan. |
| Phone mismatch returns `lost` before any write | **2.** Wrong account. Not a Guest feature. |
| Null payload returns `lost` and is not marked failed | **2** relative to Share/Assign. The null payload is the old message invite. |
| Invalid payload is marked `failed` | **2.** |

`partitionDeferredCollabTargets` (**2** for the guest-match branch): a name that matches a guest employee is not turned into a deferred phone invite. Removing that branch without a replacement would defer or apply work onto a shell.

`contact.service.ts` `resolveExternalSharePartners` and `employee.service.ts` `listRegisteredHumansByPhones` (**2**): only `isGuest: false` humans are cross-account partners. A shell phone must not resolve as a registered Share or Assign target.

`contact.service.ts` `applyDirectoryActions` (**2**): directory assign loads partner accounts with `isGuest: false` and skips anyone else.

### UI

| Where | What it does | Class |
|---|---|---|
| `frontend/src/hooks/useEmployees.ts` `toVisibleState` | Employees table uses `workspaceHumans`. Chat-as adds the guest humans back and hides them from the table. | **1** for the special guest treatment. **2** for keeping shells out of the teammate table until the rows are gone. |
| `frontend/src/pages/Chat/ChatPage.tsx` | Chat-as labels a guest as `אורח —` plus phone, in bold. | **1.** |
| `frontend/src/pages/Dashboard/DashboardPage.tsx` | Dashboard count includes a separate guest total. | **1.** |
| `backend/src/services/llm-usage.service.ts` `getTeamUsageSummary` | Splits `guestsUsd` from human usage via `workspaceHumans` and `isGuestEmployee`. | **4.** Billing display for shells. Decide with the data inspection whether those usage rows are kept, reassigned, or left historical. Do not invent a trial bucket here. |

### Tests and docs that still describe Guest as a product

Product tests, to rewrite or remove in the same change that removes the behavior they lock:

- `backend/tests/guest-register.test.ts` — `registerGuestMember`
- `backend/tests/ensure-guest-lucy.test.ts` — `ensureGuestLucy`
- `backend/tests/whatsapp-guest-routing.test.ts` — route a guest to לוסי-אורח; prefer a non-guest when both match the phone
- `backend/src/services/employee.service.ts` callers covered by `backend/tests/employees.test.ts` where a guest is hidden or preserved
- `shared/src/types.test.ts` — name fallback and `workspaceHumans`
- `shared/src/llm-message.test.ts` — `metadata.register`
- `backend/tests/whatsapp-identity.eval-db.test.ts` — “keeps guest registration on the host and does not reassign a registered user”; guest mutate blocked
- `frontend/src/pages/Dashboard/DashboardPage.test.tsx` — guest count fixture
- Offline prompt tests that snapshot `GUEST MODE` or לוסי-אורח text: `backend/tests/prompt-voice-alignment.offline.test.ts`, `prompt-sources-consistency.offline.test.ts`, `prompt-fixed-wording.offline.test.ts`, `open-jobs-rules-single-copy.offline.test.ts`, `turn-context-parity.offline.test.ts`, `batch-a-prompt-align.offline.test.ts`, `eval-prompt-source.offline.test.ts`, `q1-instructions-baseline.eval-db.test.ts`

Safety tests, which must stay green through every removal step:

- `backend/tests/whatsapp-identity.eval-db.test.ts` — independent owner, no `GUEST MODE` on the next turn, personal list and clock present in facts, host shell snapshot hides personal list and clock
- `backend/tests/collab-invite.eval-db.test.ts` — Share and Assign auto-apply, no `COLLAB INVITE`, decline and confirm do not cancel them, wrong phone, host shell, null payload, invalid payload, registered Share, registered Assign
- `backend/tests/whatsapp-invite.test.ts` — payload phone mismatch does not bind; `ensureGuestLucy` expectation changes only when that call is removed
- `backend/tests/cross-account-share.test.ts` and `backend/tests/employee-targets.test.ts` — guest targets are not partners; update these assertions in the same commit as the target-filter change, and keep a host-shell refusal if shells still exist

Docs that describe the Guest product or the older registration path. Update them only when the corresponding behavior is removed. Do not edit them in this audit:

- `docs/product/lucy-phase1-identity-invitation-design.md`
- `docs/product/lucy-phase2-share-assign-invitation-design.md`
- `docs/product/lucy-phase2-share-assign-invitation-discovery.md`
- `docs/product/lucy-existing-capabilities-gap-audit.md`
- `docs/product/lucy-product-discovery.md`
- `docs/features.md`
- `docs/future-considerations.md`
- `README.md`

`backend/scripts/.tmp-*`, `backend/.tmp-*`, and `.tmp-*` JSON files are old snapshots. They are not runtime. Leave them out of the removal.

## Removal order

Do not start at the column. Do not start by deleting `isGuestEmployee`.

### 1. Inspect data, change nothing

Run the inspection in the next section on the development database and, separately, record whether `workee_test` has shells created by tests. No `UPDATE`, no `DELETE`, no migration.

Stop if any `isGuest: true` human has a phone that also belongs to an `isGuest: false` human, or owns lists, filings, or reminders that are not clearly the old shared-view shell. That case is an ownership decision, not a code delete.

### 2. Stop creating the Guest product on accounts that are not shells

Remove `ensureGuestLucy` from `listEmployeesForUser` and from `bindInboundToInvite` only after step 1 shows either no `isGuest: true` humans, or every such human already has לוסי-אורח and a written decision to keep that worker until step 3.

Before and after, on `workee_test`:

```text
npm run test:eval-db -- tests/whatsapp-identity.eval-db.test.ts
npm run test:eval-db -- tests/collab-invite.eval-db.test.ts
```

Both must stay green. A new independent user must still get protected Lucy, not לוסי-אורח, and must still see personal rows. Share and Assign must still apply. Add one assertion to the identity eval: `listEmployeesForUser` on a new WhatsApp account does not create a digital named לוסי-אורח.

Update `backend/tests/whatsapp-invite.test.ts` and `backend/tests/ensure-guest-lucy.test.ts` in that same change. The phone-mismatch bind test stays.

### 3. Remove the Guest conversation

In one change, after step 1. Do not add another digital employee to take לוסי-אורח’s place. Invitation context stays a facts block on protected Lucy (`formatInviteOpeningContext`): who asked, and what the activity is, without refusing the rest of the turn. Share and Assign stay the existing auto-apply before facts. They are not wired to this conversation change.

- Delete the `guestSpeaker` registration branch, `registerGuestMember`, and `continueInviteAfterRegister`.
- Delete `GUEST MODE` from `buildLucyInstructions` and the view-only Hebrew notice.
- Stop routing `isGuestEmployee` speakers to לוסי-אורח. A leftover shell, until its row is decided, still must not receive Share, Assign, or personal clocks. That refusal stays on the flag. It does not need its own worker.
- Remove `metadata.register` from `LLM.action.json` and from `GUEST_LUCY_INSTRUCTIONS`. Name and form of address, if still collected, are a normal filing or employee update on that person’s own Lucy.
- Remove `formatPendingInviteContext` from the facts of a normal turn. A non-guest who still has invite context keeps `formatInviteOpeningContext` only. A pending Share or Assign must still be absent from facts because it was already applied, not because a registration script replaced it.
- Keep `applyPendingCollabInvites` and `confirmCollabInvite` refusing `isGuest` recipients and `isGuest` askers.
- Keep `resolveRecordVisibility` guest-mode filtering for `isGuest: true`.
- Keep `findExistingWhatsAppSpeaker` preferring a non-guest.

Before: the two eval commands above, plus the offline guest-register suite `npm test -- tests/guest-register.test.ts tests/whatsapp-guest-routing.test.ts tests/ensure-guest-lucy.test.ts`.

After: the two eval commands must pass without the registration test. Replace `guest-register.test.ts`, `ensure-guest-lucy.test.ts`, and the routing-to-לוסי-אורח cases with a shorter test that a `isGuest: true` fixture is refused for Share, Assign, and personal snapshot, and that a new phone never enters that fixture. Prompt snapshot tests that required `GUEST MODE` get updated in this same change so they assert the normal catalog instead.

### 4. Remove Guest from target selection and the UI

After step 3, if inspection still shows zero `isGuest: true` humans in the development data that must be preserved:

- Chat-as, dashboard guest count, and `workspaceHumans` can stop special-casing guests.
- `guestMutationBlocked`, guest target filters, tip and mission refusals, and list-op filtering can go.
- `listRegisteredHumansByPhones` can stop filtering `isGuest` only when no shell rows remain. Until then the filter stays, so a shell phone cannot become a partner.

Run the two eval commands again, plus `npm test -- tests/employee-targets.test.ts tests/cross-account-share.test.ts tests/guest-register.test.ts` or the replacement file from step 3.

### 5. Only then consider the column

Dropping `Employees.isGuest` is a later migration, not part of steps 2–4. It requires the inspection, a decision about leftover rows, and a rewrite of every **2** guard onto something else. This plan does not authorize that migration.

The name fallback inside `isGuestEmployee` is removed only when no caller can omit the boolean. Removing it earlier reintroduces the Step 1 bug for any partial object whose name is אורח.

## Data inspection before touching `isGuest`

Read-only. Do not print secrets. Do not run these against a database other than the one explicitly chosen for the report. `workee_test` is not a substitute for the development data the team actually has.

Count and list, without updating:

- Humans with `is_guest = true`: id, user id, phone present or not, `is_owner`, `team_id` null or not, name, nickname, `created_at`.
- Digitals named or nicknamed לוסי-אורח: user id, whether that user also has an `is_guest` human.
- Humans with `is_guest = true` whose phone equals a human with `is_guest = false`.
- Lists, list items, filings, and reminders owned by an `is_guest` human, counts only.
- `WhatsAppInvite` rows with `guest_employee_id` set, split by `payload is null` versus payload present, and by status. Payload rows are Share/Assign consumption, not Guest registration.
- Chat conversations whose digital employee is לוסי-אורח, count only.

The report should say whether any shell is a real person who must keep their rows, or an empty onboarding leftover. That decision is outside this code audit. No automatic promotion onto a host, and no automatic move onto a new user.

## Risks

| Area | What removal can break | What must remain true |
|---|---|---|
| WhatsApp identity | Routing a new אורח to לוסי-אורח, or preferring a shell when a real account has the same phone | `createIndependentWhatsAppAccount` stays `isGuest: false` and `isOwner: true`. Phone match prefers the non-guest row while both can exist. |
| Snapshot | Treating persisted `isGuest: false` as a guest because of the display name, or letting a shell see personal clocks | `resolveRecordVisibility` keeps using the stored boolean. |
| Share | A shell consumes a sender-owned row, or a second turn duplicates it | `applyPendingCollabInvites` still returns before `confirmCollabInvite` for `isGuest` recipients. Wrong phone stays `lost`. |
| Assign | A shell becomes the owner, or `addedById` becomes a shell | Same refuse path. Registered Assign still writes the partner’s row immediately and stores no payload. |
| Account ownership | `registerGuestMember` sets `isOwner: false` on the host’s user | That function is removed rather than reused. New WhatsApp users stay owners of their own user. |
| Invite column | Dropping `guest_employee_id` because the name says guest | Share and Assign still store the consuming employee there. |
| History | Merging or deleting לוסי-אורח threads without counting them | Step 1 of this plan counts those conversations before `getChatHistory` changes. |

## Trial and subscription

Trial length and a future paid state are account billing. They are not `isGuest`, not לוסי-אורח, not `metadata.register`, and not a view-only prompt.

Removing Guest does not add a trial. A later subscription design gets its own field and its own checks. It must not reuse the host-shell flag, the guest worker, or the registration-onto-a-host flow. A person on a trial still has an independent account and the same Lucy capabilities this product already gives a new WhatsApp user.
