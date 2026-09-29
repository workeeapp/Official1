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

Or point `DATABASE_URL` at an existing PostgreSQL database. `docker-compose.yml` publishes Postgres on **5432**. If that port is taken, remap the container (this repo’s local box uses **5435**) and set `DATABASE_URL` to match.

- Frontend: [http://localhost:5173](http://localhost:5173) (`CLIENT_ORIGIN` / Vite; local override may use **5174**)
- API: [http://localhost:3001](http://localhost:3001) (`PORT`; local override may use **3003**)

Seeded user (from `.env` `SEED_*`):

```text
Username: Amit
Password: ChangeMe123!
```

Chat needs `OPENAI_API_KEY` in `.env`. Model, temperature, and the shared system message come from `LLM.config.json`. The structured reply schema is `LLM.action.json`. Every digital employee inherits that Lucy base catalog; identity (name / handoff) is per worker. Future capability add-ons can layer on top of the base.

## How chat works

The worker understands the speaker, asks until the schema is complete, then emits metadata. The server applies those fields (it does not invent destinations, message bodies, or Hebrew intent via regex).

| Metadata | Role |
|----------|------|
| `lists` | Shopping, tasks (incl. dated meetings), contacts-list type, or custom lists. Optional `targets` for other employees / everyone |
| `filing` | Durable facts / memory (IDs, family context, preferences). Injected every turn in `EMPLOYEE_SAVED_DATA` |
| `directory` | Personal phone book (`Contacts`) — not Employees |
| `messages` | Send **now** on WhatsApp / in-app |
| `reminders` | Clocks: self-nudges or **scheduled** sends (`in` / `time` / recurring) |
| `query` | Which saved data to read — see below |
| `confirm` | Apply or drop a pending reminder delete |
| `handoff.worker` | Switch the conversation to another digital employee |

**`query` values:**

| Value | Meaning |
|-------|---------|
| `todos` | Speaker shopping / tasks still open |
| `self` | This digital worker’s own lists and reminder jobs (`WORKER_SAVED_DATA`) |
| `reminders` | Active ping clocks only |
| `report` | Full or partial status digest (+ optional `sections`) |

**Response text:** normally the model writes `response`. The server may replace or correct it in a few cases: `query: "report"` (formatted status report), failed WhatsApp delivery notices, reminder-delete confirm prompts, and shopping/tasks wording fixes after list apply.

**Do not** expand `item: "all"`, parse weekday words in `date`, or harvest phones from free text. Unknown people need digits (or a saved contact name). Outbound to someone else is attributed (`מאת טל` / `טל ביקש לתזכר אותך`).

## Lists, meetings, sharing

- **Shopping** = things to buy. **Tasks** = work to do (including meetings with date/time). Dated tasks also appear in `TEAM_SCHEDULES` so the worker can see other people’s calendar rows without their private shopping.
- On remove/update, the server resolves `list_type` from where the item actually lives. If the spoken reply says קניות for a tasks item, the reply is corrected to מטלות (and the reverse).
- List/filing actions may target another human or `כולם`. Shared shopping changes can notify the other person’s assistant thread when someone buys or updates an item.

## People, visibility, contacts

- **Employees** — humans and digital workers on the account. `is_owner` marks account owners (any number, including zero). Owners see every human’s lists/tasks/filings/clocks in `EMPLOYEE_SAVED_DATA`; non-owners see their own.
- **Contacts** — the speaker’s personal phone book (`metadata.directory`). Resolve message/reminder targets via Employees first, then contacts. Do **not** create Employees for outsiders.
- WhatsApp inbound from an unknown number may create a temporary guest Employee named `אורח …XXXX`. Guests are hidden from the Employees UI and Chat-as picker.

## App UI

- **Chat** — pick **Chat as** (human speaker) and **Chat with** (Lucy or any other digital). Guests are omitted from Chat-as.
- **Employees** — CRUD for humans and digital workers (guests hidden); optional owner flag.
- **Dashboard** — signed-in home. **WhatsApp** — webhook/flow status for operators.

## Reminders and scheduled sends

A reminder row has two statuses: `status` is the clock (`active` / `done` / `cancelled`); `send_status` is the WhatsApp attempt (`pending` / `sent` / `failed`). Recurring clocks use `repeat` as `once` or `count:unit` (`30:seconds`, `1:days`, …) or `weekdays:1,3`.

- **Fixed copy:** `compose` false/omit; `text` is the final WhatsApp body.
- **Compose at fire:** `compose: true`; `text` is a brief only; the LLM writes the final body when the clock fires. `last_composed_text` stores the last send so repeats can be avoided.
- **Compose sources:** optional `compose_source` selects fire-time context. Today `git_log` reads repo commits since `last_report_sha` and summarizes in English (platform-owner recipe; not listed in the general capabilities catalog). Cancel/update like any other reminder.
- Reminder **update/match** searches all active clocks on the account (any owner), then keeps the existing row’s `owner_id`.
- Self-nudges are several actions: work on the speaker, a task on the digital worker, and a reminder clock. Worker task ↔ clock are linked (`ON DELETE CASCADE` both ways). On cancel, the model should also remove the speaker wrapper item when it matches that nudge (or ask if it looks like independent work).
- After a **one-shot** fire the clock is marked `done` (not deleted) with `sent_at` and kept in the DB for 14 days. It is **not** injected every chat turn — only when you ask via `query: "report"` + `sections: ["sends"]` (or a full report). `sent_text` is what went out (`last_composed_text` or `text`).
- Reminder **delete** uses server Action State on the conversation (`pending_action` / `pending_targets` / `pending_step`), injected each turn — not LLM memory.

## Status report

`query: "report"` asks for a saved-data digest. Optional `sections`: `reminders`, `sends`, `tasks`, `shopping`, `filings`, `contacts`, `custom`. Empty sections = full report. The **server** formats the Hebrew report from DB.

## Architecture note

Canonical rules live in `.cursor/rules/architecture.mdc` and `.cursor/rules/security.mdc`. Prefer those if this README and the code diverge after a change.

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

## Tests

```bash
npm test
```
