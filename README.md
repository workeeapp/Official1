# Workee

A React frontend, Express API, and PostgreSQL app. Users sign in with a username and password. Sessions use an httpOnly `workee_session` cookie. Chat talks to OpenAI through a digital employee (Lucy by default; other digital workers via handoff). WhatsApp Cloud API is an optional inbound channel into the same chat service.

## Setup

```bash
cp .env.example .env
docker compose up -d
npm install
npm run db:generate
npm run db:deploy
npm run db:seed
npm run dev
```

`npm run dev` also runs `predev` → `prisma migrate deploy`, so pending schema migrations are applied before the API/frontend start.
Or point `DATABASE_URL` at an existing PostgreSQL database. `docker-compose.yml` publishes Postgres on **5432**. If that port is taken, remap the container (this repo’s local box uses **5435**) and set `DATABASE_URL` to match.

- Frontend: [http://localhost:5173](http://localhost:5173) (`CLIENT_ORIGIN` / Vite; local override may use **5174**)
- API: [http://localhost:3001](http://localhost:3001) (`PORT`; local override may use **3003**)

Seeded user (from `.env` `SEED_*`):

```text
Username: Amit
Password: ChangeMe123!
```

Chat needs `OPENAI_API_KEY` in `.env`. `LLM.config.json` seeds Lucy’s default model/temperature/system message; `LLM.action.json` is the shared structured-reply schema for every digital worker. Each digital employee stores their own `instructions` / model / temperature in the DB and that row is what chat loads. On add/edit you can **Inherit from Lucy** to copy Lucy’s current saved prompt into the form. A **custom** prompt runs alone (thin session identity only) — the server does **not** append Lucy’s capability engine unless the saved text matches Lucy / the file base (inherit) or the worker is protected Lucy.

**Sharing:** item-level `targets` sharing on shopping/tasks/custom items stays as before. In addition, a **named custom list** or **filing** with the speaker plus partners (or `all`) creates one shared object (`EmployeeLists` / `EmployeeFilings` `scope` + `visible_to`); every partner sees all items and is notified on add/update/remove. Guests (`אורח`) may be partners for viewing only — they cannot mutate. A bare «תוסיפי לי מטלה…» (no custom list named) is the speaker’s **built-in personal tasks** (`list_type: tasks`, empty `targets`) — not an existing shared custom list that merely sounds similar (e.g. משימות לעבודה).

## How chat works

The worker understands the speaker, asks until the schema is complete, then emits metadata. The server applies those fields (it does not invent destinations, message bodies, or Hebrew intent via regex).

| Metadata | Role |
|----------|------|
| `lists` | Shopping, tasks (incl. dated meetings / standing `recurrence`), contacts-list type, or custom lists. Optional `targets`, item `urgency`, `occurrence_done`. Update/remove need `item_id` |
| `list_ops` | Whole-list changes by `list_id`: `alter_list` (rename / columns / participants) or `delete_list` |
| `filing` | Durable facts / memory (IDs, family context, preferences). Fields: `item_name`, `item_description` (תיאור — required on add; model asks if missing; if they say «כמו השם» the **model** sets description = name), optional `item_info`. Injected every turn in `EMPLOYEE_SAVED_DATA` |
| `directory` | Personal phone book (`Contacts`) — not Employees |
| `messages` | Send **now** on WhatsApp / in-app; open jobs with `expects_reply` + `ask_summary` + optional `urgency` / `book` (incl. self-check «תבדקי איתי…») |
| `reminders` | Clocks: self-nudges or **scheduled** sends (`in` / `time` / structured `recurrence`) |
| `jobs` | answer / decline / progress / counter / snooze / clear_clock / close by `job_id` from `OPEN_JOBS` |
| `query` | Which saved data to read — see below |
| `handoff.worker` | Switch the conversation to another digital employee |

Full feature write-ups (recurrence, urgency, list_ops, self-check, buttons, deploy refresh, …): **[docs/features.md](docs/features.md)**.

**`query` values:**

| Value | Meaning |
|-------|---------|
| `todos` | Speaker shopping / tasks still open |
| `self` | This digital worker’s own lists and reminder jobs (`WORKER_SAVED_DATA`) |
| `reminders` | Active ping clocks only |

**Response text:** the model writes `response` and that is what the user sees. The server may still correct shopping/tasks wording after list apply, add WhatsApp delivery notices, or show reminder/bulk-delete confirm prompts — it does **not** append a mutation apply summary or replace answers with a server-built status report. Spoken replies must stay in product Hebrew — never expose schema/code words (`list_name`, `list_type`, `metadata`, `EMPLOYEE_SAVED_DATA`, …). A **full dump** ask («כל מה ששמור עלי» / «סיכום מלא») should list shopping, tasks/meetings, custom lists, active reminders, filings+memory, and contacts from this turn’s saved data — not tasks alone.

**Do not** expand `item: "all"`, invent reminder clocks from weekday words in free text, or harvest phones from free text. Unknown people need digits (or a saved contact name). Outbound to someone else is attributed (`מאת טל` / `טל ביקש לתזכר אותך`).

## Lists, meetings, sharing

- **Shopping** = things to buy. **Tasks** = work to do (including meetings with date/time). Dated tasks also appear in `TEAM_SCHEDULES` under the **same ownership gate** as `EMPLOYEE_SAVED_DATA` (`resolveRecordVisibility`): owners see every human’s dated tasks; non-owners see only their own. Guests get no team schedule block.
- **Personal task default:** «תוסיפי לי מטלה» / «מטלה ל…» without an explicit custom list name → built-in personal `tasks` (empty `targets`). Do not route that onto a shared custom list (e.g. משימות לעבודה) unless the speaker named that list.
- **Custom lists** = named lists with user-defined columns. Add/update/remove on a named list works for personal and shared (exact `list_name` from `EMPLOYEE_SAVED_DATA`). If several list names are similarly close and Lucy is unsure, she asks which one before mutating. When asked to show a list (e.g. שיעורי נהיגה של מאיה), answer with the **items and their fields**, not only the owner’s name.
- **Dates (save):** store concrete `YYYY-MM-DD` (Asia/Jerusalem). Exact labels `היום` / `מחר` / `אתמול` (and today/tomorrow/yesterday) are resolved on save — do not leave the word היום in saved data.
- **Dates (ask):** each chat turn injects `SESSION_CLOCK` (`current_date`, `current_time`, timezone Asia/Jerusalem). Questions like «מה לעשות היום / בעוד שעתיים / השבוע» are answered by the model filtering against that clock — the server does **not** pre-filter rows or build a status report. For **אני / שלי**, use only the speaker’s personal tasks + their active reminders in `EMPLOYEE_SAVED_DATA` — not `WORKER_SAVED_DATA` and not other people’s schedule rows. Empty timed windows should be spoken in plain Hebrew (e.g. אין לך מטלות או תזכורות בשעה הקרובה), not jargon like «מטלות מתוזמנות».
- On remove/update, the server resolves `list_type` from where the item actually lives. If the spoken reply says קניות for a tasks item, the reply is corrected to מטלות (and the reverse).
- List/filing actions may target another human or `כולם`. Shared shopping changes can notify the other person’s assistant thread when someone buys or updates an item.
- **Tell vs assign:** «תגידי / תשלחי ל־X …» → `messages` now. An optional shared-save offer is text only (`lists=[]`); on «כן» the model emits the `lists` add with `targets` = speaker + every recipient — never the speaker’s private shopping alone. Plain assign («מיכל צריכה לעשות טסט…» / «טל צריך לקנות…») saves **only on the assignee** (item = the work itself) — the server does **not** invent a speaker tracking task. After save, one bundled offer in `response`: due date/time + reminder to the assignee, optionally also to the speaker; «כן ב־9» without «גם אליי» → ping the assignee only. Scheduled outbound to someone else (daily greeting, delayed WhatsApp) keeps the clock + a **worker** task — if the model also emits a speaker tasks add while reminders ping only others, the server drops that speaker row.
- **Timed personal task:** saving «אני צריך … מחר ב־08:00» as a tasks row should *offer* a reminder clock in `response` — do not auto-create `reminders` unless they asked for a nudge or accepted the offer.

## People, visibility, contacts

- **Employees** — humans and digital workers on the account. `is_owner` marks account owners (any number, including zero). Owners see every human’s lists/tasks/filings/clocks in `EMPLOYEE_SAVED_DATA` (and the same scope in `TEAM_SCHEDULES`); non-owners see their own. `WORKER_SAVED_DATA` (the digital worker’s jobs) is scoped the same way for non-owners: only worker tasks tied to the current speaker (`addedBy` / `visibleTo` / linked reminder owner or ping). Owners see the worker’s full job list; guests get no worker block.
- **Contacts** — the speaker’s personal phone book (`metadata.directory`). Resolve message/reminder targets via Employees first, then contacts. Do **not** create Employees for outsiders.
- WhatsApp inbound from an unknown number may create a temporary guest Employee named `אורח …XXXX`. Guests are hidden from the Employees UI and Chat-as picker.

## App UI

- **Chat** — pick **Chat as** (human speaker) and **Chat with** (Lucy or any other digital). Guests are omitted from Chat-as. History is per `(Chat as, Chat with)` thread; after **24 hours** idle the server rotates the conversation and **deletes** stored chat messages (OpenAI context resets too).
- **Employees** — CRUD for humans and digital workers (guests hidden); optional owner flag.
- **Dashboard** — signed-in home. **WhatsApp** — webhook/flow status for operators.

## Reminders and scheduled sends

A reminder row has two statuses: `status` is the clock (`active` / `done` / `cancelled`); `send_status` is the WhatsApp attempt (`pending` / `sent` / `failed`). Prefer structured `recurrence` (`freq` / `interval` / `weekdays` / `month_day` / `time` / `until` / `count`) on Asia/Jerusalem — see [docs/recurrence.md](docs/recurrence.md). Legacy `repeat` strings (`once`, `30:seconds`, `weekdays:1,3`) may still appear on older rows.

**Standing tasks** use the same `recurrence` on a tasks item (one row, `חוזר` + `next_occurrences`). Finishing today’s occurrence uses `occurrence_done` — do not delete the standing row. Lucy’s linked reminder task follows the repeating clock date.

- **Fixed copy:** `compose` false/omit; `text` is the final WhatsApp body.
- **Compose at fire:** `compose: true`; `text` is a brief only; the LLM writes the final body when the clock fires. `last_composed_text` stores the last send so repeats can be avoided.
- **Compose sources:** optional `compose_source` picks a **facts plugin** at fire; one shared compose LLM call answers the brief from those facts (or invents from the brief alone when empty). Today: `git_log` loads repo commits (lookback / `last_report_sha` rules unchanged); `saved_data` loads live `EMPLOYEE_SAVED_DATA` (+ contacts / session clock). Same product idea as «show my tasks now» — schedule vs live ask; only the facts source differs. Example: «תשלחי לי בעוד 10 שניות את רשימת הקניות המשותפת עם מיכל» → `saved_data`, ping the speaker; «עם מיכל» is the list partner, not the WhatsApp target. Do **not** schedule deferred list mutations («תוסיפי מטלה בעוד שעה»). A compose clock with **no** `in` / `time` is not saved — the model asks when and emits the full clock with the answer.
- **Recent outbound context:** after a reminder fires, the next chat turns inject `RECENT_OUTBOUND` (latest sent body for that speaker) so the model can answer «לגבי מה ששלחת» without re-sending WhatsApp. «תזכירי לי שוב / את זה בעוד X» about that block → new self-nudge from the outbound item (new clock; do not revive the done one). Follow-ups on a code digest stay with the speaker — never invent a coworker (e.g. עמית from prompt examples) to «ask» or message unless the speaker named them.
- Reminder **update/match** searches all active clocks on the account (any owner), then keeps the existing row’s `owner_id`.
- Self-nudges are several actions: work on the speaker, a task on the digital worker, and a reminder clock. Worker task ↔ clock are linked (`ON DELETE CASCADE` both ways). On cancel, the model should also remove the speaker wrapper item when it matches that nudge (or ask if it looks like independent work). Removing a shopping/task item also cancels active clocks that match the same work by key/label (speaker wrapper is not FK-linked to the clock).
- **Remind someone else** is the same three-action pattern (task on them, worker «להזכיר ל…» job, clock with `ping` = them). When that same turn notifies them about the new task, the server notify text also mentions the linked clock (e.g. «הוסיף לך מטלה: …, ותזכורת בעוד שעה») — from the ACTION fields, not from re-parsing speech.
- After a **one-shot** fire the clock is marked `done` (not deleted) with `sent_at` and kept in the DB for retention. Soft-deleted list/filing rows and done/cancelled clocks **stay in the DB** but are **never** loaded into `EMPLOYEE_SAVED_DATA` — live/active data only.
- Reminder **cancel** marks `status=cancelled` (soft). List items and filings use `deleted_at` instead of hard DELETE. Mutations still append to `AuditEvents` for internal retention; they are not injected into the model.
- Custom lists must always have a real `EmployeeLists.name`. Prefer the name the speaker already said (or `list_name` on the item); only ask “what should we call this list?” when none exists. Never persist custom rows with an empty name — snapshots derive a title from item `list_name` when repairing legacy rows.
- **Multi-turn drafts:** the server keeps no Action State. While asking for a missing required field the model leaves that action empty; its own previous turn (OpenAI conversation history) is the draft, so a short reply like «דור» / «מחר» / «ב־9» makes it emit the complete action (not a new WHEN query). Id-based deletes/updates apply immediately; the only delete confirm is the model asking before `list_ops.delete_list`. Phone-book saves (אנשי קשר + name + phone) use `metadata.directory` — first name is enough; do not require last name.
- **Open jobs / urgency:** «תבדקי עם ערן…» opens a job (`expects_reply` + `ask_summary` + `urgency`). `urgent` / `very_urgent` get server follow-ups; when they run out the asker is notified. «תבדקי איתי…» is a self-job (ask in `response`, no third-party relay). List rows may also carry `urgency` for «מה יש לי דחוף».
- **list_ops:** rename / re-column / re-share / delete a whole list by `list_id` — not row-by-row.
- **Apply feedback:** the model’s `response` is the user-facing text after saves. The server does not append a Hebrew mutation inventory.

## Architecture note

Canonical rules live in `.cursor/rules/architecture.mdc` and `.cursor/rules/security.mdc`. Feature catalog: [docs/features.md](docs/features.md). Prefer those if this README and the code diverge after a change.

Do not commit `.env` or access tokens.

## WhatsApp (optional)

WhatsApp is a channel into `sendChatMessage`, not a second bot. Inbound texts hit the webhook; Lucy (or the worker you switched to) replies on WhatsApp. Relays in `metadata.messages` also go to a human’s WhatsApp if that employee has a phone.

1. Create a Meta WhatsApp Cloud API app (test number is enough for a POC).
2. Fill the `WHATSAPP_*` keys in `.env` (see `.env.example`). `WHATSAPP_VERIFY_TOKEN` is a string you invent. `WHATSAPP_ACCESS_TOKEN` should be a **system-user** token so it lasts more than a day. `WHATSAPP_DEFAULT_EMPLOYEE` is the human Lucy should treat as the speaker when the sender’s number is new (e.g. `טל`).
3. Publish the app **Live**, subscribe the WABA to `messages`, and add testers.
4. Expose the API with a **named Cloudflare tunnel** so the callback URL stays stable:

   `https://wa.workee.site/api/whatsapp/webhook`

   Meta → app → **Webhooks** → WhatsApp Business Account. Verify token = `WHATSAPP_VERIFY_TOKEN`.

   A `trycloudflare.com` URL works for a first test but changes when the process restarts.

5. Legal pages Meta may ask for (served by the API): `/privacy`, `/data-deletion`, `/terms`.

On WhatsApp, asking to talk to a worker is `metadata.handoff`. A raw phone in `messages.targets` or `reminders.ping` is a WhatsApp destination.

Inbound messages store `lastInboundAt` (`WhatsAppInbounds`). Free-form outbound text is skipped unless that number wrote to the business in the last 24 hours (Meta session window). Replies to someone who just wrote always send.

Two laptops can run the web app on different branches with their own Postgres. The Meta webhook is **one** URL (`wa.workee.site`), so only one machine’s tunnel should be up for WhatsApp.

Signed-in **WhatsApp** tab (and `GET /api/whatsapp/status`) shows the flow log: webhook POST, inbound, LLM, send, and whether Meta’s WABA `override_callback_uri` still points at a dead `trycloudflare.com` URL. Tokens are never returned.

After pulling schema changes, stop the API and run `npx prisma migrate deploy` (and `npx prisma generate` if the client is locked).

## Stay up on this machine (Windows)

WhatsApp needs the API, Postgres, and the Cloudflare tunnel. Cloudflared should run as a Windows service. Then:

```bash
npm run keep-up:install
```

That registers a logon task, starts `scripts/keep-workee-up.ps1`, and turns off sleep / lid-sleep **while on AC power**. Folding the laptop is fine if it is plugged in. Shutdown, log out, or long battery sleep still stop the API.

```bash
npm run keep-up
```

restarts the keeper in the current terminal. Log: `%LOCALAPPDATA%\Workee\keep-up.log`.

After pulling, a one-shot refresh (migrate, build SPA, restart API that serves `frontend/dist`):

```bash
npm run refresh
```

## Tests

```bash
npm test
```
