# Future considerations (side backlog)

Ideas to consider later — not committed work. Captured from product discussion (guests, WhatsApp, shared lists).

## Guests vs employees

**Current intent**
- **Human employees** = workspace team members.
- **Guests** (`אורח` WhatsApp shells) = outsiders who talk with **לוסי-אורח** (not Lucy). They may **view** lists/filings shared with them; they do not get a full personal workspace until they register.
- **Registration (shipped):** לוסי-אורח emits `metadata.register` `{ name, gender }` (+ optional surname) → promote guest **in place** on the host (`isGuest=false`, keep phone, shared team **`New Registered 30 days`**). Next WhatsApp turn talks with לוסי on a new conversation (same `employeeId`).

**Features to consider**
1. **Set password / web login for registered WhatsApp members**  
   Let a registered team member add username+password later so they can use the web UI (they remain on the host account until/unless a split-account flow is added).
2. **Create-employee merges matching guest phone**  
   If the UI adds a human with a phone that already belongs to a guest, merge/promote instead of creating a second person.
3. **Guest directory / labels**  
   Optional display name for guests (e.g. “מיכל”) without making them employees; clearer than nickname-on-אורח only.
4. **Invite / share link**  
   Share a list with a phone number → auto-create or attach guest, send WhatsApp notice.  
   *(Partial: cold check-with invite via personal `wa.me` + business token → לוסי-אורח register-first is shipped; list-share invite still future.)*
5. **Guest chat scope knobs**  
   Account setting: shared-list Q&A only (today) vs allow limited chitchat vs block chat entirely (cost control).
6. **Audit “who is this guest”**  
   UI to see guest shells, which shared lists they see, and last WhatsApp activity — without listing them in the main Employees / Chat-as pickers.

**Shipped:** Cross-account share/assign/mutate for registered non-guests via SPEAKER_CONTACTS phone → global Employee (guests stay view-only). Legacy `share_mirror_employee_id` rows may still exist from older registrations; new registrations promote in place and do not create a mirror.

## Related cleanup (done ad hoc when needed)

- Deduplicate guest + employee with the same phone (one-time DB merge).
- Soft-delete leftover personal guest shopping created before guest write locks.

## Prompt architecture (later, optional)

- Keep hard guest rules in **code**.
- Keep a **short** guest instruction block; avoid growing a second full Lucy catalog in `chat.service` runtime.
- Large prompt-layer cleanup is optional and not urgent.

## Retrieval actions (day / status questions)

**Today:** every turn preloads `EMPLOYEE_SAVED_DATA`, ownership-scoped `TEAM_SCHEDULES`, and ownership-scoped `WORKER_SAVED_DATA` (non-owners: only worker jobs tied to the speaker; owners: full worker list). The model still filters timed windows in `response` (SESSION_CLOCK + WHEN prompts), including standing/`next_occurrences` rows. Mixing the speaker’s tasks with **their own** Lucy jobs on «מה אני צריך ביום…» remains prompt-soft.

**Consider later:** real fetch actions — model declares what to load (retrieval action) → engine fetches that slice → second step answers only from the fetch.

## Digital-worker targeting follow-ups (after ba22249)

An **add** that names a digital worker persists a chore on that worker’s book and on each named person’s own book, including the speaker when the speaker is a target. A worker-tracking title (להזכיר ל… / לשלוח הודעה / לשלוח נדנוד / לעזור ל…) stays only on the worker’s book. It is not a share with the worker. These follow-ups are still open:

1. **Update / remove that targets Lucy.** Those actions still use the older per-target loop, so a change or delete that names Lucy can still land on the speaker’s book.
2. **Confirm the same add rule for shopping and custom lists.** Shopping adds go through the new split and are not covered by the task tests. A **named custom list** is matched as a shared collection *before* that split, so an add that names Lucy on a named custom list can still be written on the speaker.
3. **Partial range-delete copy when a tip is also appended.** The engine line is `הסרתי N פריטים.` plus `לא הוסר: …`. An existing tip can still be appended after that sentence; that combined reply is not asserted.
