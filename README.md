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

New capabilities are developed on a **separate digital worker** with its own prompt. Reminders are developed on **דוד** (`LLM.david.json`). He emits `metadata.lists` plus `metadata.reminders`; the server stores a clock on the list item and fires WhatsApp/thread pings. Lucy’s prompt stays the front desk.

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

On WhatsApp, `מי העובדים` lists digital workers; `דבר עם <name>` switches the in-memory worker for that phone.

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
