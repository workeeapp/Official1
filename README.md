# Workee

A React frontend, Express API, and PostgreSQL app. Users sign in with a username and password. Sessions use an httpOnly `workee_session` cookie. Chat talks to OpenAI through a digital employee (Lucy by default). WhatsApp Cloud API is an optional inbound channel into the same chat service.

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

Chat needs `OPENAI_API_KEY` in `.env`. Model, temperature, and the system message come from `LLM.config.json` (or `LLM.config`). Lucy’s structured reply schema is `LLM.action.json`. Do not put reminder experiments in Lucy’s file.

New capabilities are developed on a **separate digital worker** with its own prompt. Reminders are developed on **דוד** (`LLM.david.json`). The worker understands the speaker and emits metadata; the server only applies it:

- `lists` / `filing` / `messages` / `reminders` — write or send
- `handoff.worker` — switch the WhatsApp session to that digital employee
- `query: "reminders"` — list **active** rows from the database (not from chat memory)
- `confirm: true|false` — apply or drop a pending reminder delete

The engine does not invent a destination or a message body. An unknown name without digits is not saved. A spoken question (`?`) holds outbound WhatsApp until the speaker confirms. A phone in the reminder item or text is the ping, even if `ping` names the speaker. Outbound to someone else is attributed (`מאת טל` / `טל ביקש לתזכר אותך`).

A reminder row has two statuses: `status` is the clock (`active` / `done` / `cancelled`); `send_status` is the WhatsApp attempt (`pending` / `sent` / `failed`). `sent` is true only when `send_status` is `sent`. Recurring clocks use `repeat` as `once` or `count:unit` for any interval (`30:seconds`, `15:minutes`, `4:hours`, `1:days`, `1:weeks`, `1:months`) or `weekdays:1,3`. Legacy `daily` still means every day.

Do not add regex that guesses user intent. Lucy’s prompt stays the front desk.

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

On WhatsApp, asking to talk to a worker (any wording) is `metadata.handoff`. Asking which reminders exist is `metadata.query`. A raw phone in `messages.targets` or `reminders.ping` is a WhatsApp destination.

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
