# Feature catalog (branch additions)

Canonical product loop: **model understands → emits ACTION → engine executes**. This page documents features shipped on `feat/reminder-recurrence` (and related commits) so operators and contributors know what exists, which ACTION fields drive them, and where the code / tests live.

Architecture rules: `.cursor/rules/architecture.mdc`, `.cursor/rules/model-understands.mdc`. High-level setup: [README.md](../README.md).

---

## 1. Structured recurrence (reminders + standing tasks)

**Speech examples:** «תזכירי לי כל שלישי וחמישי ב־19:00», «כל 1 לחודש עד דצמבר», yearly birthdays, «חדר כושר כל שלישי».

| Piece | Behavior |
|-------|----------|
| ACTION | `reminders[].recurrence` and `lists[].items[].recurrence` — `{ freq, interval, weekdays?, month_day?, month?, time?, until?, count? }` |
| Engine | Parses/stores the object; all calendar math is Asia/Jerusalem (`shared/src/jerusalem-time.ts`, `shared/src/recurrence.ts`) |
| Snapshot | Standing tasks show `חוזר` + `next_occurrences` (no single `תאריך לביצוע`); clocks expose the same for date questions |
| Fire | Recurring clocks advance `fire_at` to the next occurrence; one-shot still becomes `status=done` |
| Done | «סיימתי» / «הלכתי לחדר כושר» on a standing task → `occurrence_done` (YYYY-MM-DD or `true` for today); row stays, past occurrences leave `next_occurrences` |
| Clear | `lists.update` with `recurrence: null` stops repeating |

**Freq values:** `interval` (seconds/minutes/hours), `daily`, `weekly`, `monthly`, `yearly`. Standing-task `time` is optional (all-day ok — do not ask באיזו שעה).

**Tests:** `shared/src/recurrence.test.ts`, `shared/src/jerusalem-time.test.ts`, `backend/tests/recurrence.test.ts`, `backend/tests/reminder-recurrence-apply.test.ts`, `backend/tests/reminder-fire.test.ts`.

**Deep dive:** [docs/recurrence.md](./recurrence.md).

---

## 2. Job urgency (chase + asker notify)

**Speech:** «תבדקי לי דחוף עם ערן…» / «ממש דחוף».

| Level | Server follow-ups | Interval |
|-------|-------------------|----------|
| `normal` | 0 | — |
| `urgent` | 2 | 60 min |
| `very_urgent` | 6 | 20 min |

- Model sets `messages[].urgency` when opening a job (`expects_reply` + `ask_summary`).
- Server creates the open job, schedules auto-nudges, exposes `follow_ups_sent` / `follow_ups_left` / `next_follow_up_at` in `OPEN_JOBS`.
- When auto-nudges run out, the **asker** is notified (skipped for self-jobs — see §3).
- After a nudge clock fires, the job becomes raisable again.

**Code:** `shared/src/job-urgency.ts`, `backend/src/services/jobs.service.ts`.  
**Tests:** `backend/tests/jobs.test.ts`.

---

## 3. Self-check jobs («תבדקי איתי…»)

Speaker asks Lucy to check **with them** (not with a third party).

- ACTION: `messages` targeting the **speaker**, `expects_reply: true`, `ask_summary`, `urgency`; `lists: []`.
- Engine: `planSelfJobDeliveries` opens a self-job (`asker === subject`); no chat/WhatsApp relay — the ask lives in `response`.
- `OPEN_JOBS` phrases `viewer_is=subject` as their own check («רצית שאבדוק איתך…»), never «עמית ביקש ממני…».
- Auto-nudge copy for self-jobs is the ask (plus urgency label), not «X מחכה לתשובה».
- Answer → `jobs.answer` with empty `report_text` (no third party).

**Code:** `employee-targets.service.ts` (`planSelfJobDeliveries`), `jobs.service.ts`, chat runtime prompts.  
**Tests:** `backend/tests/employee-targets.test.ts`, `backend/tests/jobs.test.ts`.

---

## 3b. Deferred check-with («תבדקי איתי בעוד שעתיים…» / recurring)

Speaker asks Lucy to check **later** (self or third party), including recurring rules.

**Speech examples:** «תבדקי איתי בעוד שעתיים אם קניתי חלב», «תבררי עם טל מחר ב־20:00 אם הוא מקליט», «כל ראשון לחודש ב־17:00 תבררי איתי אם לקחתי אקמול», «כל יום שני ב־14:00 תבדקי אם עשיתי הליכה».

| Piece | Behavior |
|-------|----------|
| ACTION | Same job-opening `messages[]` entry (`expects_reply` + `ask_summary` + `urgency`) **plus** `in` / `date`+`time` / `recurrence`. `lists: []`. Response = ack only (no ask yet). |
| Create | `createScheduledJobsFromRelays` saves Lucy’s `לבדוק עם …` task with `תאריך לביצוע` / `שעה לביצוע`, `__job.pendingActivation`, and a linked Reminder. No WhatsApp; no urgency follow-ups yet. |
| OPEN_JOBS | Shows `scheduled: true`, `raisable: false` until fire. |
| Inventory | «מה את צריכה לעשות / לברר» lists every OPEN_JOBS row including scheduled (from `ask`, note not yet due) — does **not** RAISE a different raisable job. |
| Fire | Reminder sends the ask; `activateScheduledJob` clears date/time, drops `pendingActivation`, starts urgency follow-ups. Job row is kept (not soft-deleted). |
| Recurring | Clock advances as usual. On job answer/close, if the Reminder is still active with a future `fireAt`, the same row resets to pending with the next תאריך/שעה. |

Immediate self-check (no clock fields) is unchanged (§3).

**Code:** `shared/src/llm-message.ts` (`messageHasSchedule`), `employee-targets.service.ts` (`planScheduledJobDeliveries`), `jobs.service.ts`, `reminder-fire.ts`.  
**Tests:** `shared/src/llm-message.test.ts`, `backend/tests/employee-targets.test.ts`, `backend/tests/jobs.test.ts`, `backend/tests/reminder-fire.test.ts`.

---

## 4. List-item urgency

Same enum as jobs (`normal` / `urgent` / `very_urgent`) on shopping/tasks/contacts/custom rows.

- ACTION: `lists[].items[].urgency` (keep the title clean — no «דחוף» inside the name).
- Stored on `EmployeeListItems.urgency`; `EMPLOYEE_SAVED_DATA` shows `urgency` only when not `normal`.
- Listing in `response`: append «דחוף» / «דחוף מאוד» on that • line. «מה יש לי דחוף» → only those rows.

**Migration:** `prisma/migrations/20261007150000_list_item_urgency`.  
**Tests:** `backend/tests/employee-records.test.ts`, `backend/tests/chat.test.ts`.

---

## 5. `list_ops` — whole-list changes

Row mutations stay in `metadata.lists`. List shell changes use `metadata.list_ops`:

| Action | Effect |
|--------|--------|
| `alter_list` | Rename (`new_name`), columns (`add_columns` / `remove_columns` / `rename_columns`), participants (`add_participants` / `remove_participants`) — one object per list with every requested change |
| `delete_list` | Named custom list → soft-delete list + items; built-in קניות/מטלות/אנשי קשר → empty items only |

- Requires `list_id` from this turn’s `EMPLOYEE_SAVED_DATA`.
- Owner-only; guests may view shared lists, not mutate.
- Before `delete_list`, model asks confirm with empty `list_ops`, then emits after כן.
- Partners get notified on share/rename/delete (e.g. «X שיתף את רשימת «Y» עם «Z»»).

**Code:** `backend/src/services/list-ops.service.ts`.  
**Tests:** `backend/tests/list-ops.test.ts`.

---

## 6. No server Action State / HOLD

Multi-turn drafts live **only** in the model conversation.

- Incomplete turn → leave that ACTION empty and ask in `response`.
- Short follow-up (time, weekday, phone, כן, מחר) → emit the **complete** ACTION this turn.
- Bare date/day/time after the model asked for a slot fills the draft — not a new WHEN/TODAY query.
- Server delete-confirm removed for id-based mutates; only model-side confirm before `list_ops.delete_list`.

Speaker-only meetings with an outside party («פגישה עם אלסטיק») save on the speaker alone — do not ask «עם מי עוד?».

---

## 7. Id-only list update / remove

`lists.update` / `lists.remove` apply **only** with a matching `item_id` from this turn’s saved data. No fuzzy title match. Missing id → engine ignores the mutate.

`item_key` is a derived label only (not unique). Multiple live rows on the same list may share a key.

**Migration:** `prisma/migrations/20261007220000_drop_list_item_key_unique`.

---

## 8. Open jobs (multi, consult, book)

- Several open jobs per person at once (no overwrite of the last ask).
- Consult another digital worker via `messages` (not handoff): one consult turn; answer appended under Lucy’s reply and into her model memory for follow-ups.
- `book` on a job message → on plain כן (not only after a counter), save the meeting on both participants’ tasks.
- Linked reminder clocks next to tasks from DB FKs (`linked_reminder_id` / `worker_item_id`).

---

## 9. Reply tap buttons (web + WhatsApp)

Lucy (and engine notifies) can attach tap buttons: show list / show reminders / snooze, etc.

- Model may emit reply buttons; partner notify path also builds «הצג» buttons (`showButtonsForNotify`).
- Web chat renders them; WhatsApp sends interactive buttons when available.
- Server-sent thread messages stay in the worker’s model memory.

**Tests:** `frontend/src/hooks/useChat.test.ts`, `frontend/src/pages/Chat/ChatPage.test.tsx`, `backend/tests/whatsapp.test.ts`.

---

## 10. WhatsApp «quoted» → bold

Outbound WhatsApp converts guillemet-quoted spans («…») to bold. Web chat and DB keep the original «…» characters. Urgency labels intentionally use guillemets for the same conversion.

**Code:** `backend/src/services/whatsapp-send.ts`, `outbound-text`.  
**Tests:** `backend/tests/outbound-text.test.ts`, `backend/tests/whatsapp.test.ts`.

---

## 11. Shared-list partner notices

- Shared shopping **delete** notifies partners as «X מחק «item» מרשימת «קניות»» (not a purchase guess).
- Custom-list remove/update notices use the list’s **title column**, never a raw item id.
- Share via `list_ops.alter_list` notifies every partner.

---

## 12. Inherit Lucy prompt (UI)

On add/edit of a digital worker:

- **Inherit from Lucy** — copy Lucy’s current **DB** prompt into the form.
- **Inherit Lucy config file** — reset the on-screen prompt to `LLM.config.json` before saving.

Employee instructions field limit raised so Lucy’s full prompt can be saved from the UI.

**Code:** `frontend/src/components/EmployeeFormDialog.tsx`.  
**Tests:** `frontend/src/pages/Employees/EmployeesPage.test.tsx`.

---

## 13. SPA from API + refresh deploy

- API serves `frontend/dist` (static + `index.html` fallback) when present — same origin as WhatsApp tunnel (`wa.workee.site`).
- `CLIENT_ORIGIN` may be a comma-separated list.
- `npm run refresh` → `scripts/refresh-workee.ps1`: pull, install, migrate, generate, build SPA, free ports, restart, health-check.

**Code:** `backend/src/utils/frontend-dist.ts`, `backend/src/app.ts`.

---

## 14. Meeting time presence

Clock digits count as שעה לביצוע even when glued to ב (`ב08:00`) or next to a period word (`בבוקר ב08:00`). Vague period alone («מחר בבוקר» with no digits) is **not** a time — model asks באיזו שעה / יום שלם.

---

## Quick reference — ACTION surface

| Metadata | Role |
|----------|------|
| `lists` | Row add/update/remove (needs `item_id` for update/remove); optional `recurrence`, `occurrence_done`, `urgency` |
| `list_ops` | Whole-list alter / delete by `list_id` |
| `filing` | Durable facts |
| `directory` | Personal contacts |
| `messages` | Send now / open jobs (`expects_reply`, `ask_summary`, `urgency`, `book`) |
| `reminders` | Clocks (`recurrence`, compose, ping) |
| `jobs` | answer / decline / progress / counter / snooze / clear_clock / close by `job_id` |
| `query` | `todos` / `self` / `reminders` (read hints only) |
| `handoff` | Conversation switch only |

---

## Related docs

| Doc | Topic |
|-----|-------|
| [recurrence.md](./recurrence.md) | Recurrence math and standing tasks |
| [session-clock.md](./session-clock.md) | Ask-time dates / `SESSION_CLOCK` |
| [recent-outbound.md](./recent-outbound.md) | Post-fire outbound context |
| [future-considerations.md](./future-considerations.md) | Backlog only |
| [qa/README.md](./qa/README.md) | QA phases |
