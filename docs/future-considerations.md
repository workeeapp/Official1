# Future considerations (side backlog)

Ideas to consider later — not committed work. Captured from product discussion (guests, WhatsApp, shared lists).

## Guests vs employees

**Current intent**
- **Human employees** = workspace team members.
- **Guests** (`אורח` WhatsApp shells) = outsiders Lucy / other digital workers talk to: clients, suppliers, family, friends. They may **view** lists/filings shared with them; they do not get a full personal workspace.

**Features to consider**
1. **Promote guest → employee**  
   One identity: rename off `אורח`, keep the same employee id, phone, chats, and `visibleTo` on shared lists. No duplicate row.
2. **Create-employee merges matching guest phone**  
   If the UI adds a human with a phone that already belongs to a guest, merge/promote instead of creating a second person.
3. **WhatsApp resolution preference**  
   When several humans share a phone match, prefer a non-guest employee over an `אורח` shell (safety net if duplicates ever exist).
4. **Guest directory / labels**  
   Optional display name for guests (e.g. “מיכל”) without making them employees; clearer than nickname-on-אורח only.
5. **Invite / share link**  
   Share a list with a phone number → auto-create or attach guest, send WhatsApp notice.
6. **Guest chat scope knobs**  
   Account setting: shared-list Q&A only (today) vs allow limited chitchat vs block chat entirely (cost control).
7. **Audit “who is this guest”**  
   UI to see guest shells, which shared lists they see, and last WhatsApp activity — without listing them in the main Employees / Chat-as pickers.

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
