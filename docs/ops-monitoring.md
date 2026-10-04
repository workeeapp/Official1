# Ops monitoring (POC)

Lightweight monitoring for the local / self-hosted Workee stack. Goal: notice Lucy/channel failures **before** (or without) waiting for a user report — without calling every API route.

## What we monitor

| Piece | What it checks | Alerts? |
|-------|----------------|---------|
| `GET /api/health` | Process up + Postgres `SELECT 1`. Reports whether OpenAI / WhatsApp / ops phones are **configured** (no live LLM or WhatsApp calls). | Use an **external** uptime ping (UptimeRobot, cron on another machine). Health alone cannot WhatsApp you if the API is dead. |
| Durable failures (`OpsEvents`) | Steps matching fail/error (e.g. `chat_failed`, `send_fail`) from the WhatsApp/chat flow logger. Survives API restart. | Shown on **WhatsApp** page (banner + list). |
| Ops WhatsApp alert | Same failures, rate-limited per `alertKey` (e.g. `llm_credits`, `chat_llm`). Cooldown is claimed before send so concurrent failures do not spam. Meta allow-list errors (`131030`) are logged but not alerted. Ops alert sends use `muteOps` so a bad ops phone cannot cascade more alerts. | Optional WhatsApp text to `OPS_ALERT_PHONES` via Meta Cloud API (`ignoreSession`). |

**Not in scope for health:** hitting `/api/chat`, employees CRUD, or sending WhatsApp on every probe. That would cost money, need auth, and mutate state. Full journeys stay in CI / Phase 5 smoke.

## Chicken-and-egg (alerts)

- **App-level failures** (OpenAI 429 / no credits, chat path errors): our API can still often send Meta WhatsApp → ops alert works.
- **API / tunnel / PC down:** ops WhatsApp from this process will **not** send. Use an external health ping for that case.

## Configuration

```env
# Comma-separated phones (digits / E.164). Empty = durable log only, no alert SMS/WA.
OPS_ALERT_PHONES=9725xxxxxxxx,9725yyyyyyyy
# Minutes between alerts for the same alert key (default 30)
OPS_ALERT_COOLDOWN_MINUTES=30
```

After pull:

```bash
npx prisma migrate deploy
```

Restart the API so env and schema load.

## Where to look in the UI

Signed-in **WhatsApp** tab:

- Banner when there were failures in the last hour
- **Durable failures** — from Postgres
- **Flow log** — in-memory events since this process started (unchanged)

## Alert body (example)

```text
Workee ops alert
step: chat_failed
detail: 429 You have no credits remaining…
failures last hour: 4
at: 2026-10-03T…
```

## Related

- Phase 4 model eval (prompt regressions): `docs/qa/README.md` / `npm run test:model-eval -w backend`
- Phase 5 live smoke: not started — separate from this ops POC
