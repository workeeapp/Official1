# Ops monitoring + Admin (POC)

Lightweight monitoring for the local / self-hosted Workee stack. Goal: notice Lucy/channel failures **before** (or without) waiting for a user report — without calling every API route.

## What we monitor

| Piece | What it checks | Where it shows |
|-------|----------------|----------------|
| `GET /api/health` | Process up + Postgres `SELECT 1`. Reports whether OpenAI / WhatsApp / ops phones are **configured** (no live LLM or WhatsApp calls). | External uptime pings; also folded into Admin monitoring. |
| Durable failures (`OpsEvents`) | Steps matching fail/error (e.g. `chat_failed`, `send_fail`) from the WhatsApp/chat flow logger. Survives API restart. | **Admin → System status** (not WhatsApp). |
| Ops WhatsApp alert | Rate-limited per `alertKey`. Gated by `OPS_ALERT_MODE`: **off** (default) never WhatsApps; **critical** only system-down (e.g. DB via `system_db_down`); **all** alertable app failures. Meta allow-list (`131030`) never alerts. Cooldown claimed before send; ops sends use `muteOps`. | Optional WhatsApp to `OPS_ALERT_PHONES`. |
| Code changes | Recent git commits (`git_log` source). | **Admin → Code changes** only. Chat digests via Lucy are **not supported**. |

**Not in scope for health:** hitting `/api/chat`, employees CRUD, or sending WhatsApp on every probe. That would cost money, need auth, and mutate state. Full journeys stay in CI / Phase 5 smoke.

## Admin access

- Flag: `Users.is_admin` (DB). **Not** the same as `Employees.is_owner`.
- Seed: `SEED_ADMIN_USERNAMES` (comma-separated login usernames). Runtime auth reads the DB flag, not this env on every request.
- UI: **Admin** tab only when `/api/auth/me` returns `isAdmin: true`.
- API: `GET /api/admin/monitoring`, `GET /api/admin/code-changes`, `GET /api/admin/users`, `PATCH /api/admin/users/:id/admin` require session + `requireAdmin` (reloads `isAdmin` from DB).
- **Admins** section on the Admin page can Grant/Revoke `is_admin` for login users. Cannot revoke the last admin.

After changing seed admins: `npm run db:seed`, then re-login. After Grant in UI, the other user must re-login (or refresh `/me`) to see the Admin tab.

## Admin UI layout

1. **System status** (top) — plain-language health board + categorized recent failures.
   - Severity: `noise` (allow-list / typing) · `attention` (chat/WhatsApp path) · `critical` (DB/system).
   - **Cause (log)** shows the stored root-cause string (OpenAI status/code, Meta Graph detail, or tagged reasons like `openai_api_key_missing`). New failures must not store only the generic public 503 text.
2. **Admins** — list login users; Grant/Revoke Admin tab (`Users.is_admin`). Blocks revoking the last admin.
3. **Code changes** (below) — commits in a lookback window (24 / 48 / 168h). Preview first **5**, then **Show all**.

**WhatsApp** tab is channel-only: webhook alignment + in-memory flow log. No durable ops banner, no git digest.

## Lucy / code digests

Chat requests for git/code digests are refused:

- Prompt: `CODE DIGEST NOT SUPPORTED` → reply only `זה לא נתמך.` (no Admin mention).
- Engine: strips `compose_source: git_log` reminder rows and forces that reply.

Operators read commits on Admin → Code changes.

## Chicken-and-egg (alerts)

- **App-level failures** (OpenAI 429 / no credits, chat path errors): only if `OPS_ALERT_MODE=all`.
- **DB down while process up:** `GET /api/health` records `system_db_down` → WhatsApp if mode is `critical` or `all`.
- **API / tunnel / PC down:** this process cannot WhatsApp. Use an external health ping.

## Configuration

```env
SEED_ADMIN_USERNAMES=Amit
OPS_ALERT_PHONES=9725xxxxxxxx,9725yyyyyyyy
# off | critical | all  (default off)
OPS_ALERT_MODE=off
OPS_ALERT_COOLDOWN_MINUTES=30
```

After pull:

```bash
npx prisma migrate deploy
npm run db:seed
```

Restart the API so env and schema load.

## Alert body (example)

```text
Workee ops alert
step: chat_failed
detail: status=429 code=insufficient_quota 429 You have no credits remaining…
failures last hour: 4
at: 2026-10-03T…
```

## Tests (this feature)

| Area | File |
|------|------|
| Ops alert keys / modes | `backend/tests/ops-monitor.test.ts` |
| Root-cause detail helper | `backend/tests/errors.test.ts` (`opsErrorDetail`) |
| Admin monitoring + code-changes API | `backend/tests/admin.test.ts` |
| Digest refuse in prompt | `backend/tests/llm-config.test.ts` |
| Monitoring view copy / severity | `frontend/src/pages/Admin/monitoring-view.test.ts` |
| Admin page layout + expand | `frontend/src/pages/Admin/AdminPage.test.tsx` |
| WhatsApp has no ops/digest UI | `frontend/src/pages/WhatsApp/WhatsAppPage.test.tsx` |

## Related

- Phase 4 model eval (prompt regressions): `docs/qa/README.md` / `npm run test:model-eval -w backend`
- Phase 5 live smoke: not started — separate from this ops POC
