# Feature catalog (branch additions)

Canonical product loop: **model understands → emits ACTION → engine executes**. This page documents features shipped on `feat/reminder-recurrence` (and related commits) so operators and contributors know what exists, which ACTION fields drive them, and where the code / tests live.

Architecture rules: `.cursor/rules/architecture.mdc`, `.cursor/rules/model-understands.mdc`. High-level setup: [README.md](../README.md).

**Speaker address gender:** each human `Employees.address_gender` (`male` / `female` / null) is set in the Employees UI or when Lucy files «לשון פנייה». Every chat turn injects `SPEAKER_ADDRESS`; if unknown she asks once «לפנות אליך בלשון זכר או נקבה?». Lucy’s own first-person stays feminine via engine extras.

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
| Min cadence | Every **5 minutes** (`freq=interval`, `unit=minutes`, `interval≥5`); faster / seconds → refuse |

**Freq values:** `interval` (seconds/minutes/hours), `daily`, `weekly`, `monthly`, `yearly`. Standing-task `time` is optional (all-day ok — do not ask באיזו שעה).

**Standing vs WhatsApp ping:** a standing chore with a time is calendar work on מטלות (`חוזר` / `(קבוע)`). A WhatsApp reminder clock is separate — either they said «תזכירי לי» (self-nudge now), or after a standing save **with** `recurrence.time` Lucy offers «רוצה שאשלח לך תזכורת בוואטסאפ…?» and only on כן emits `reminders` + her `להזכיר` task. On dumps, standing + linked clock folds into `(קבוע + תזכורת)` when the ping time matches the chore, or `(קבוע + תזכורת ב־20:45)` when it differs (no second `(תזכורת: …)` on that line); non-standing linked items still use `(תזכורת: …)`. `הצג תזכורות` keeps next-fire + cadence. All-day standing (no time) gets no clock offer.

**Self-nudge reuses existing wrappers:** if «תזכירי לי לקנות/לעשות X» and X is already on the speaker’s shopping/tasks in this turn’s `EMPLOYEE_SAVED_DATA` (same work by meaning), Lucy must **not** `lists.add` a second copy — only her `להזכיר` task + `reminders.add` (engine soft-links the clock to the existing row). Several matches → ask which; «עוד אחד» / «תוסיפי שוב» → add allowed. Same grain as snooze «not already in saved data».

**Reminder content keeps details:** `reminders[].item` and the `להזכיר` / speaker-task wording must keep the speaker’s concrete facts (light paraphrase OK). Hollow summaries that drop what they listed (e.g. «לטפל בשני הבאגים» when they named the bugs) are forbidden. Shopping rows stay product-only; that does not strip the clock label.

**Reminder-on-item never creates a product:** «הוסף תזכורת ל־X» / «תזכורת ל־X» / «תזכירי לי על X» / «על 3» after a dump — **forbidden** to `lists.add` a shopping/tasks row in every case. Existing X → clock + `להזכיר` only; missing X → not found (no invent). Contrast: «תזכירי לי לקנות X» may still create the wrapper when missing.

**Clock vs standing time edits:** updating only the WhatsApp clock (`reminders.update`) must not change the speaker standing `חוזר` — the engine syncs Lucy’s `להזכיר` worker task to the new fire time, not the soft-linked standing row. Moving a standing series that already has a linked clock → model asks «לעדכן גם את תזכורת הוואטסאפ בהתאם?» before cascading. After any reminder mutate, the engine ensures an `הצג תזכורות` reply button even if the model omitted `metadata.buttons`.

**Cancel / delete after a ping (standing + linked clock):** «בטל את המטלה» after a WhatsApp nudge is ambiguous — Lucy must **ASK** «למחוק את המטלה הקבועה «…» (וגם את תזכורות הוואטסאפ), או רק להפסיק את התזכורות?» (empty actions while asking). Confirm delete standing → `lists.remove` that speaker `item_id` only; the engine cancels the linked clock (`linkedReminderId` / worker FK) and soft-deletes Lucy’s `להזכיר`. Reminders-only → `reminders.remove`; standing stays. Explicit «תמחקי את המטלה הקבועה» / «בטלי את התזכורת» skip the ask. **FORBIDDEN:** removing only the worker `להזכיר` / נדנוד job while the standing chore remains (that produced «ביטלתי את המטלה לנדנד…» without deleting the real task).

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
- **Escalate:** asker-only `jobs.escalate` (or one higher-urgency `messages` entry when asker→subject has exactly one open job). Never a second job for the same check; subject cannot change urgency.
- **Snooze:** `jobs.snooze` moves the existing nudge Reminder in place when one exists — never a parallel `reminders.add` for that raise.
- **End job notify:** closing the whole check (`close` / `decline` / asker `clear_clock` / `lists.remove` of the job) notifies the other party. Clock-only clear by the subject does not.

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
| Inventory | «מה את צריכה לעשות / לברר» lists every OPEN_JOBS row including scheduled (from `ask`, note not yet due) once under waiting-for-reply; skips the shadow `לבדוק עם…` worker task under מטלות so consults are not duplicated — does **not** RAISE a different raisable job. |
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
- Listing in `response`: wrap the whole numbered line in «…» so it is bold (`urgent`). `very_urgent` adds ‼️ after the closing guillemet. Do not write דחוף / דחוף מאוד on the line. «מה יש לי דחוף» → only those rows.
- Status / free-form «מה יש לי לקנות» answers are **LIVE DATA ONLY** from this turn’s injected blocks (`EMPLOYEE_SAVED_DATA`, …); chat history must not resurrect soft-deleted rows.
- **Show / status dump (engine):** dump intent is **ACTION-only** — `metadata.show_dump` (`shopping`|`tasks`|`contacts`|`filings`|`reminders`|custom name), optional `show_dump_section` (`personal`|`shared`), `show_dump_partner`, `show_dump_assignee` (`self`|name), `show_dump_about` (other person), `show_dump_from` / `show_dump_to` (inclusive `YYYY-MM-DD`, Asia/Jerusalem). **OR within a field:** `partner` / `assignee` / `about` accept `string | string[]` (multiple = OR); **AND across fields** (incl. dates). Multi-`about` → union of dumps. «אישית או משותפת» → omit `section`. Cross-shape OR («אישיות שלי או משותפות עם מיכל») is out of scope — model asks or full dump. The engine never regexes free-form user text for dump intent. Known UI button payloads may synthesize bare `show_dump` by **string equality** only when the model omitted it. Filters always come from the model. `section=personal` → אישיות only; `shared` → משותפות עם … only; `partner` filters that bucket; `assignee` filters sole-responsibility marks (shopping/tasks); `about=X` dumps X under visibility (owners: X’s lists; non-owners: rows already visible involving X); `from`/`to` keep task rows whose date span or `next_occurrences` intersect the range (reminders by `fire_at` day; ignored for shopping/contacts/filings). Empty → one engine sentence. Dump layout: schedule / qty / marks. **Filings dump:** numbered `שם:` / `מידע:` / `תיאור:` lines; when exactly one address-bearing filing is shown, engine sets `navigate_address` for Waze if the model left it empty. **Custom lists:** numbered labeled columns. `show_dump` alone → read-only; + mutates → mutates win. **BY LINE NUMBER** after a numbered dump (`הציגי N` = that last-dump line only — never a new `show_dump`). Bare FULL DUMP stays model-written.
- **Shopping quantity:** every shopping row stores `כמות` (default `1` on apply if missing) and optional `יחידת מידה`. Dumps show `שם - כמות` or `שם - כמות יחידה` (e.g. `אורז - 2`, `עגבניות - 1 ק"ג`).
- **SHAREABLE STATUS ASK** («מה אני צריך לקנות» / «מה המטלות שלי» / תיוקים / **ABOUT X** «מה מיכל צריכה לקנות»): one category via `show_dump` (+ `show_dump_about` for X). Shopping|tasks|contacts|filings|phone_book: **one flat header** + row marks — co-share `(A, B)`; assign `(באחריות X · מאת Y)` (shopping/tasks only); cluster personal → co-share → assign. Engine `show_dump=filings` + button `הצג תיוקים`.
- **Share-only facts:** filings, contacts, directory are **co-share only**. Partners may mutate/unshare by id (`filing_id` / `contact_id` / `unshare_with`). Contacts may use `list_ops` **participants** for whole-list share; shopping/tasks builtins stay item-level only. Assign remains **shopping/tasks only**.
- **Item share vs list share vs assign (Stage 2 dump):**

  | Case | Data | Dump |
  |------|------|------|
  | Private row | no `shared_with`, no `assigned_by` | **אישיות** |
  | One-way assign («מיכל צריכה לקנות חלב») | `assigned_by` / `shared_items` | **משותפות עם \<partner\>** — mark `(assignee)` only (both parties see the same mark) |
  | Item co-share («שתפי עם מיכל») | personal list + item `shared_with` | **משותפות עם מיכל** — mark `(מיכל, טל)` all involved (no «עם» in the mark) |
  | Meeting with participants in the title | `shared_with` + `פגישה (טל, מיכל)` | **משותפות עם מיכל** — title only; no extra partner mark |
  | Whole shared list (custom, or contacts via `list_ops`) | list `scope=shared` | **משותפות עם X** (shopping/tasks) or contacts משותפים |
  | Filing / contacts / directory share | row `scope=shared` + `shared_with` | two-section אישיים / משותפים with `(עם …)` |

  Example:

  ```text
  קניות אישיות:
  1. לחם - 1

  קניות משותפות עם עמית:
  1. חלב - 1 (טל)             ← assign; mark = assignee

  קניות משותפות עם מיכל:
  1. קפה - 1 (מיכל, טל)       ← co-share
  2. קמח מלא - 1              ← scope=shared list
  3. שמן - 1 (מיכל)           ← shared_items folded in
  ```

  Builtin קניות/מטלות: `list_ops add_participants` **refused**. Contacts: participants allowed.
- **FULL DUMP** (bare «מה יש לי» / «הציגי הכל» / `כל מה ששמור` / `סיכום מלא`): all sections; **מטלות** fully enumerated with the same three-way split; **קניות** and **רשימות אחרות** show **counts only**; hint «לפירוט רשימה: הצג רשימת …». **תזכורות פעילות** only for clocks not already on a task line — numbered `1. 2. 3.` (same as «הצג תזכורות»). **אנשי קשר** = built-in contacts list from `EMPLOYEE_SAVED_DATA`; **ספר הטלפונים** = `SPEAKER_CONTACTS` (directory) — separate section, never skip when the phone book has rows. Explicit «הצג רשימת X» / SHAREABLE STATUS ASK stay full item dumps.
- **SHOW MY LISTS** («הציגי את הרשימות שלי»): model-written; **same grain as FULL DUMP list sections** — **מטלות** fully enumerated; **קניות** + **custom lists** + אנשי קשר = **counts only** (`*name* — N פריטים` / ריקה). Hint «לפירוט רשימה: הצג רשימת …». Exact «הצג רשימת X» stays a full item dump.
- **Shared-with-X overview** («מה יש לי עם X» / «מה משותף עם X» / «מה משותף לי ול־X» / «מה יש לנו עם X» / «מה אנחנו חולקים עם X»): model-written from this turn’s `EMPLOYEE_SAVED_DATA` only for person X. **Shared lists** (`scope=shared`, X in `shared_with`) use the same **counts-only** grain as FULL DUMP רשימות אחרות (`*name* (עם X) — N פריטים` / ריקה) — never enumerate list rows here. **Enumerate** only atomic co-shares: item-level `shared_with`, meetings/tasks naming X, filings with X. Hint once «לפירוט רשימה: הצג רשימת …». Not category ABOUT X / exact הצג dumps.
- **תזכורות vs מטלות שלך:** any ask with «תזכורת/תזכורות» (including «התזכורות שלך» / «איזה תזכורות יש לך») → speaker ping clocks from `active_reminders` (same as «הצג תזכורות»). «מה את צריכה לעשות» / «מה המטלות שלך» → worker inventory from `WORKER_SAVED_DATA` (+ `OPEN_JOBS`); consults appear once under ממתינים לתשובה (not also as shadow `לבדוק עם…` under מטלות); linked clocks show as `(תזכורת: …)` or standing `(קבוע + תזכורת)` on those task lines.

**Migration:** `prisma/migrations/20261007150000_list_item_urgency`.  
**Tests:** `backend/tests/employee-records.test.ts`, `backend/tests/chat.test.ts`, `backend/tests/show-button-dump.test.ts` (item share vs list share vs assign).

---

## 5. `list_ops` — whole-list changes

Row mutations stay in `metadata.lists`. List shell changes use `metadata.list_ops`:

| Action | Effect |
|--------|--------|
| `alter_list` | Rename (`new_name`), columns (`add_columns` / `remove_columns` / `rename_columns`), participants (`add_participants` / `remove_participants`) — one object per list with every requested change; **named custom lists only** for rename/columns/participants |
| `delete_list` | Named custom list → soft-delete list + items; built-in קניות/מטלות/אנשי קשר → empty items only |

- Requires `list_id` from this turn’s `EMPLOYEE_SAVED_DATA`.
- Owner-only; guests may view shared lists, not mutate.
- Built-in קניות / מטלות / אנשי קשר: `alter_list` is refused (no rename, columns, or whole-list participants) — share a single item via `lists` update + `targets`.
- Before `delete_list`, model asks confirm with empty `list_ops`, then emits after כן.
- Partners get notified on share/rename/delete of **custom** lists (e.g. «X שיתף את רשימת «Y» עם «Z»»).
- **Multi-item share/unshare notify:** several items shared (or unshared) with the same partner in one turn → **one** partner message that names **all** of them (e.g. «מיכל שיתף איתך שמן זית ורסק ואורז ברשימת הקניות»), not only the first.

**Code:** `backend/src/services/list-ops.service.ts`.  
**Tests:** `backend/tests/list-ops.test.ts`.

---

## 6. No server Action State / HOLD

Multi-turn drafts live **only** in the model conversation.

- Incomplete turn → leave that ACTION empty and ask in `response`.
- Short follow-up (time, weekday, phone, כן, מחר) → emit the **complete** ACTION this turn.
- Bare date/day/time after the model asked for a slot fills the draft — not a new WHEN/TODAY query.
- **Delete confirm (model-turn):** before any lists/filing/reminders/directory remove, the model asks with that remove empty; on כן it emits remove with id. The server still applies immediately once ACTION has a valid id — no server draft. Same pattern for `list_ops.delete_list`.
- **Save verb routing:** תייקי / תתייקי → always `add_filing`. תשמרי without a list name → infer (durable fact → filing; buying → shopping; chore → tasks) or ASK once; never invent a custom `list_name` from topic.

Speaker-only meetings with an outside party («פגישה עם אלסטיק») save on the speaker alone — do not ask «עם מי עוד?».

---

## 7. Id-only list update / remove

`lists.update` / `lists.remove` apply **only** with a matching `item_id` from this turn’s saved data. No fuzzy title match. Missing id → engine ignores the mutate.

`item_key` is a derived label only (not unique). Multiple live rows on the same list may share a key. Deleting one standing time (e.g. morning «להוריד את סקאזי») cancels only that row’s linked clock — it does **not** delete a sibling standing row with the same name and a different schedule (evening), nor cancel that sibling’s clock. Key-wide clock cancel still runs when the removed row had no linked reminder (shopping / self-nudge wrappers).

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
- Speaker path: when `metadata.reminders` has add/update/remove, `ensureSpeakerShowButtons` appends `הצג תזכורות` if the model omitted it (patched onto the reply JSON + persisted on the assistant row).
- Web chat renders them; WhatsApp sends interactive buttons when available.
- Server-sent thread messages stay in the worker’s model memory.

**Waze navigate button:** when the reply mentions exactly one physical address (street+city counts even without the word כתובת), the model sets `metadata.navigate_address` (the engine never looks for addresses in the utterance). On an engine **filings** dump, if the shown set has exactly one address-bearing row (`item_info` preferred, else place-encoded `item_name`), the engine sets `navigate_address` when the model left it empty. Web chat shows a Waze icon link under the first bubble (`https://waze.com/ul?q=…&navigate=yes`, opens the Waze app on a phone; stays tappable while sending). The address is saved in `ChatMessages.navigate_address` so history keeps the button. WhatsApp sends a `cta_url` button («פתח ב-Waze») right after the first reply, falling back to a text link.

**Tests:** `shared/src/llm-message.test.ts`, `frontend/src/hooks/useChat.test.ts`, `frontend/src/pages/Chat/ChatPage.test.tsx`, `backend/tests/whatsapp.test.ts`.

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
- Partner WhatsApp copy for a new shared list/filing uses «איתך» when the recipient is the only other party — never «לך ו<recipient>» (e.g. not «תיוק משותף לך ומיכל» to מיכל). With additional co-partners: «לך ולערן».

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
- By default refresh also runs `lucy:sync-prompt` (push `LLM.config.json` into Lucy + digital workers still on her previous prompt). Skip with `-InheritConfig:$false`, `npm run refresh:no-inherit`, or `WORKEE_REFRESH_INHERIT_CONFIG=0`.
- Live laptop layout: `npm run live:setup` creates sibling worktree `Official1-live`; edit in the primary folder. With `WORKEE_LIVE_ROOT` set, `refresh` / `refresh:watch` / `keep-up` run against live even if invoked from the primary checkout (`-Local` / `WORKEE_FORCE_LOCAL=1` to override).
- `npm run refresh:watch` / scheduled task `WorkeeRefreshWatch`: fetch loop; if remote is ahead and the tree is clean → refresh `-RequireClean -NoWait`.
- `npm run hooks:install` / `npm run push:live`: after local push, refresh `WORKEE_LIVE_ROOT` (or current repo).

**Code:** `backend/src/utils/frontend-dist.ts`, `backend/src/app.ts`, `scripts/refresh-workee.ps1`, `scripts/watch-and-refresh.ps1`, `scripts/setup-live-worktree.ps1`.

---

## 14. Meeting time presence

Clock digits count as שעה לביצוע even when glued to ב (`ב08:00`) or next to a period word (`בבוקר ב08:00`). Vague period alone («מחר בבוקר» with no digits) is **not** a time — model asks באיזו שעה / יום שלם.

---

## 14b. Time ranges (hours or days)

The model emits every field; the server never parses «בין 10 ל־12».

| Spoken | Saved |
|--------|-------|
| «פגישה עם טל ביום שלישי בין 10 ל־12» | tasks item `שעה לביצוע: 10:00`, `שעת סיום: 12:00` |
| «כל יום שני מ־10:00 למשך שעתיים» | standing task `recurrence.time: 10:00`, `recurrence.end_time: 12:00` |
| «מיום שלישי עד חמישי אני בחו"ל» | one item `תאריך לביצוע` = Tue, `תאריך סיום` = Thu (inclusive), `יום שלם: true` |

- **Overlap check (model only):** any tasks add/update with a date and time is checked against the speaker's rows that day (ranges, multi-day spans, standing `next_occurrences`). On overlap Lucy asks «יש לך באותו זמן … לשמור בכל זאת?» and saves only on כן. Meetings with participants also check `TEAM_SCHEDULES`. No server enforcement.
- **Answers:** ranges show as «10:00–12:00»; a multi-day row matches every day in its span (agenda, delete by day).
- **Coordination:** `messages[].book` carries `end_time` and `window`. `window: false` (default / unclear) = the meeting's length; `window: true` («מתישהו בין 10 ל־12») = pick a time inside it. A reply naming one time («מתאים ב־11:00») is a `counter`, so the asker approves. The counter's `end_time` replaces the old end; without one the end is dropped (`bookEndTime` never carries over), and `bookWindow` is cleared. On the final yes the meeting is saved on both with `שעת סיום` when known.
- **Injected facts:** `TEAM_SCHEDULES` rows carry `end_time` / `end_date`; saved task rows with `תאריך סיום` also get `יום בשבוע סיום`; OPEN_JOBS shows `book_end_time` / `book_window`.

**Code:** `LLM.config.json`, `LLM.action.json`, `chat.service.ts` runtime prompts, `shared/src/recurrence.ts`, `shared/src/llm-message.ts`, `list-recurrence.ts`, `employee-records.service.ts`, `jobs.service.ts`, `job-meta.ts`.  
**Tests:** `shared/src/recurrence.test.ts`, `shared/src/llm-message.test.ts`, `backend/tests/recurrence.test.ts`, `backend/tests/employee-records.test.ts`, `backend/tests/jobs.test.ts`.

---

## 15. Send by meaning + send-me free text

- **Send by meaning:** any deliver-words intent (תשלחי / תגידי / תמסרי / תכתבי / … — judged by meaning, not a closed verb list) → `messages` NOW or scheduled `reminders` + worker `לשלוח הודעה ל…`. Not assign-without-tell; not «תעדכני את התזכורת».
- **Exact outbound quote:** after any fixed-text send (NOW or scheduled), `response` confirms with **«את ההודעה «…»»** copying `messages[].text` / `reminders[].text` character-for-character — no bare «שלחתי לעמית» / paraphrase. `compose:true` → no invented final quote (wording at fire).
- **Send-me free text** («תשלחי לי הודעה מה נשמע»): no clock → ask **«מתי תרצה שאשלח?»** only. With a clock → schedule to the speaker; confirm **«אשלח לך … את ההודעה «…»»**. **«עכשיו»** refused (that is the live chat). Third-party («תמסרי למיכל…») still sends NOW without asking when; same exact-quote confirm.
- List/status dumps («תשלחי לי את הרשימה…») stay on `compose_source: saved_data`.
- **Weather:** live ask → `metadata.weather` { place, date, aspects }; scheduled → `compose_source: weather` + `compose_place`. Engine fetches Open-Meteo (forecast + wind + waves) and replaces the reply / fire body.
- **Market:** live ask → `metadata.market` { queries, aspects }; scheduled → `compose_source: market` + `compose_place` (comma-separated tickers). Engine fetches Yahoo Finance (stocks / indices / crypto) and replaces the reply / fire body.
- **Mashov (משוב):** credentials in filings including the password (`תעודת זהות למשוב` / `סיסמת משוב` / prefer `שם בית ספר למשוב` + required `שנת לימודים למשוב`, or `סמל בית ספר למשוב` + year); live → `metadata.mashov` { child, aspects }; scheduled → `compose_source: mashov` + `compose_place` (child). Aspects: `grades` | `homework` | `behavior` | `timetable` | `absences` (`/lessonsCount`, fallback filtered `/behave`) | `messages` (parent inbox `/mail/inbox/conversations`). With school name the engine resolves `semel` via public `GET /api/schools` (Hebrew spelling variants like תקווה/תקוה are folded). Academic year is never defaulted — the model asks and files it. Mashov requires the password filing to be at least 6 characters (API validation); shorter values get a clear ask to update the filing instead of a generic connect error. Uses the unofficial parent-portal API (`web.mashov.info`) — may change without notice. Password lives only in filing `item_info`, never in the ACTION or spoken reply.
- **Conditional watches («תעדכני אותי אם…»):** Lucy self-task + compose clock with `compose_condition` (`market_price` / `weather_rain` / `weather_changed` / `mashov_new` / `market_change_compare` / `expr` / `field_changed` / `bus_eta`). On create the engine samples facts and stamps `last_report_sha` (baseline); the model should same-turn live-sample and confirm the reference («כרגע… כשישתנה אעדכן»). At fire: quiet-skip when false; successful watch send is LLM-styled (tips + `addressGender`), not raw `fixedBody`. `watch_once: true` → after first successful condition send, `status=done` and Lucy’s worker task soft-deletes; omit for «בכל פעם». **`expr`:** structured arithmetic AST (`add`/`sub`/`mul`/`div`/`pct`) over catalog fields (`weather.temp_now|temp_max|temp_min|is_rain`, `market.price|change_pct|change_abs`) with compare `lt|lte|gt|gte|eq|approx`; edge via `expr:hold`/`expr:idle`. **`field_changed`:** alert when a catalog numeric field value changes (baseline = current value). Mashov broad watches set `compose_aspects` (e.g. grades+behavior+homework+absences+messages). No spoken time → hourly (bus_eta every 2 minutes). Speaker day-agenda («מה יש לי מחר») skips these clocks even when `ping` includes the speaker — they belong under Lucy inventory; `הצג תזכורות` still lists them.
- **Places (local business search):** live ask → `metadata.places` { query, place, aspects }. Engine uses Google **Places API (New)** Text Search (`places:searchText`) with `GOOGLE_PLACES_API_KEY`. Near-me («באזור שלי») → WhatsApp location pin stored as `PENDING_LOCATION` + `near: "speaker"` (Text Search with `locationBias`). When Google returns a postal code it is always shown as `מיקוד`. Guests skip. No scheduled compose for places in this slice.
- **Jewish calendar / Shabbat:** live ask → `metadata.jewish` { place, date, aspects }. Engine fetches Hebcal (`/shabbat`, `/hebcal`; no API key) for candle lighting, Havdalah, weekly parasha, and upcoming holidays (Israel calendar). Place required for candles/havdalah/summary; optional for parasha/holidays. Guests skip. **Candle-offset reminder:** «תזכירי לי להדליק נרות 10 דקות לפני כניסת שבת» → self-nudge + `reminders` with `schedule_anchor: jewish_candles`, `offset_minutes: -10`, `compose_place` (city); engine sets `fire_at` from Hebcal for the **next** Shabbat (one-shot). Weekly only when asked («כל שישי» / «כל שבוע») — then recurrence weekly Friday and re-resolve Hebcal each fire (times move). Not a live jewish dump.
- **Routes (public transit via Google):** live ask → `metadata.routes` { origin, destination?, departure?, arrival?, line?, headsign?, aspects }. Trip/ETA: Routes API `computeRoutes` with `travelMode: TRANSIT` (`GOOGLE_ROUTES_API_KEY`, falls back to Places key) — A→B, leave-by (`arrival`), next departure (stop→direction + `aspects: [eta]`), headway (`aspects: [frequency]`). **Stop board:** ambiguous «איזה קווים בתחנה X» → model clarifies (destination vs lines-at-stop); board intent → `aspects: [lines]`, empty destination; engine uses Places Text Search `transitStation` and lists line short names (never invents). `origin: "speaker"` uses `PENDING_LOCATION` (trips only). Guests skip. **Bus watch:** `compose_condition: { type: "bus_eta", origin, destination, line, minutes_before }` with a 2-minute interval (sub-hour refuse waived for this condition only); engine polls Routes and quiet-skips until ETA ≤ N. MOT GTFS/SIRI are not used.
- **No engine save ack:** successful reminder/scheduled-send saves never append `נשמרה התזכורת…` — only the model’s confirm (and skip/cancel/missed notices when needed).

**Code:** `chat.service.ts` runtime prompts, `LLM.config.json`, `reminder.service.ts` (`formatReminderApplyNotice`), `weather.ts`, `market.ts`, `mashov.ts`, `compose-facts.ts`.  
**Tests:** `backend/tests/chat.test.ts`, `backend/tests/reminders.test.ts`, `backend/tests/weather.test.ts`, `backend/tests/market.test.ts`, `backend/tests/mashov.test.ts`, `backend/tests/compose-facts.test.ts`.

---

## 16. Media attachments (WhatsApp files)

WhatsApp images, videos, audio/voice notes, documents and stickers are stored on local disk (`UPLOADS_DIR`, default `.data/uploads`) as `Attachments` rows. The model decides what to do with them; the engine only stores, links and sends.

- **Inbound:** each file is downloaded right away (Meta URLs live about 5 minutes) and checked against the WhatsApp size limits. Forwarded files arrive one message each, so a phone's messages are batched while files keep coming (3s quiet, 15s cap) and run as one turn. A per-phone queue keeps turns in order. A caption is the spoken text; a voice note with no text is transcribed (`TRANSCRIBE_MODEL`) and the transcript is the request.
- **What the model sees:** files from this turn under «[קבצים שהתקבלו בהודעה זו]» (`new_attachments`), images as vision input, and `PENDING_ATTACHMENTS` (the speaker's files from the last 48h that are not attached to anything yet). Saved rows carry `attachments` on list items (shopping / tasks / contacts / custom), filings, and reminders; `has_attachments` is true only when the **list itself** has files (not because an item inside does). Any listed row with `attachments` gets 📎 in every dump (status, הצג רשימה, תיוקים, תזכורות, WHEN/week, FULL DUMP); list-header 📎 and the «📎 קבצים מצורפים» button only when `has_attachments` is true. Phone-book `SPEAKER_CONTACTS` / directory has no attachment links — no paperclip there. Base64 images are never written to the request audit.
- **Attach:** `lists[].items[].attachment_ids` / `detach_attachment_ids`, `lists[].list_attachment_ids`, `list_ops.add_attachments` / `remove_attachments`, `filing[].attachment_ids` / `detach_attachment_ids`, `reminders[].attachment_ids` / `detach_attachment_ids`. Ids are links (`AttachmentLinks`, exactly one target per link), never item data. An update that only attaches files does not change the row's other fields or send update notices.
- **No caption:** Lucy asks where to file or attach the files with the action empty; the next turn she emits the action with the ids from `PENDING_ATTACHMENTS`.
- **Send:** a reminder clock with files sends them right after the reminder text when it fires. `metadata.send_attachments` (max 10) sends saved files after the reply, e.g. a question about one item/filing/reminder/contacts-list row, or the «📎 קבצים מצורפים» reply button on a list with **list-level** files (`has_attachments`, any list type). That button is not shown when only items have files; when pressed it still sends list files plus item files (max 10). WhatsApp media ids from our uploads are cached for 25 days.
- **Web chat:** view only. Messages show images, video, audio players and document links served by `GET /api/attachments/:id/content` (session cookie, same account only, `nosniff`, inline only for image/video/audio/PDF).

**Code:** `attachment.service.ts`, `attachment-storage.ts`, `attachment-understanding.ts`, `whatsapp-media.ts`, `whatsapp-inbound-batch.ts`, `whatsapp.service.ts`, `whatsapp-send.ts` (`sendWhatsAppMedia`), `reminder-fire.ts`, `attachment.controller.ts`, `shared/src/attachments.ts`, `frontend/src/pages/Chat/ChatAttachments.tsx`.  
**Tests:** `backend/tests/attachments.test.ts`, `backend/tests/attachment-refs.test.ts`, `shared/src/attachments.test.ts`, `frontend/src/pages/Chat/ChatPage.test.tsx`.

---

## 17. Guest mode (לוסי-אורח → own workspace)

Unknown WhatsApp numbers become `אורח` shells on the host account and talk with **לוסי-אורח** (not Lucy). They may **view** shared lists/filings; mutations stay blocked.

| Piece | Behavior |
|-------|----------|
| ACTION | `metadata.register` `{ name, surname, username, password }` — לוסי-אורח only; null until all four are known |
| Engine | `createUser` + protected Lucy + human (`isOwner`) on the new account; host guest renamed, phone cleared, kept as share mirror; new human gets `share_mirror_employee_id` |
| After | Next WhatsApp turn resolves to the new member (non-guest preferred on phone match) and protected Lucy; host shared data still appears in `EMPLOYEE_SAVED_DATA` via the mirror (view-only) |
| Safety | Password redacted from stored chat messages / LLM raw; לוסי-אורח hidden from Chat-with |

**Code:** `guest-register.service.ts`, `whatsapp.service.ts`, `employee.service.ts` (`ensureGuestLucy`), `employee-records.service.ts` (mirror merge), `LLM.action.json`, `shared/src/llm-message.ts`.  
**Tests:** `backend/tests/guest-register.test.ts`, `shared/src/types.test.ts`, `shared/src/llm-message.test.ts`.

---

## Quick reference — ACTION surface

| Metadata | Role |
|----------|------|
| `lists` | Row add/update/remove (needs `item_id` for update/remove); optional `recurrence`, `occurrence_done`, `urgency` |
| `list_ops` | Whole-list alter / delete by `list_id` |
| `filing` | Durable facts |
| `directory` | Personal contacts |
| `messages` | Send now / open jobs (`expects_reply`, `ask_summary`, `urgency`, `book` with optional `end_time` / `window`) |
| `reminders` | Clocks (`recurrence`, compose, ping) |
| `jobs` | answer / decline / progress / counter / snooze / clear_clock / close by `job_id` |
| `register` | Guest onboarding (לוסי-אורח → new User + Lucy + share mirror) |
| `query` | `todos` / `self` / `reminders` (read hints only) |
| `send_attachments` | Saved file ids to send after the reply |
| `attachment_ids` (on items, filings, reminders; `list_attachment_ids`, `list_ops.add_attachments`) | Link uploaded files |
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
