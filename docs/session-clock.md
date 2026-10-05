# Session clock (ask-time dates)

## Problem

Saved tasks already store concrete dates (`YYYY-MM-DD` in Asia/Jerusalem). Questions like «מה אני צריך לעשות היום?» / «בעוד שעתיים» need a **known now** so the model can filter those rows.

This is **not** the same as save-time relative labels (`היום` → `2026-10-01` in `relative-date.ts` on write).

## Flow

1. User asks what is due today / soon / this week / a weekday.
2. Server loads live `EMPLOYEE_SAVED_DATA` (and schedules / active reminders) for this turn.
3. `TEAM_SCHEDULES` uses the **same ownership gate** as saved data (`resolveRecordVisibility`): owners → all humans’ dated tasks; non-owners → speaker only; guests → omitted.
4. Server also injects `SESSION_CLOCK` every turn (`formatSessionClockContext`).
5. The digital worker filters in `response` against `SESSION_CLOCK` — **no** server-built report, **no** extra DB query.
6. For **אני / שלי**, prompts require speaker personal tasks + their active reminders only — not `WORKER_SAVED_DATA`, not other owners’ schedule rows, not someone-else custom lists as the day plan.
7. For **מה את צריכה ביום X** (what YOU need that day), answer only from this turn’s `WORKER_SAVED_DATA` rows whose date matches — do not resurrect older *saved* job claims that are missing from the JSON (OpenAI chat history can still remember pre-filter turns).
8. That “live saved facts” rule does **not** cancel `PENDING_ACTION_STATE` / `hold` multi-turn drafts (send text, delete confirm, missing phone/time, etc.) — those are re-injected by the server every turn.
9. Empty timed window → plain Hebrew (e.g. «אין לך מטלות או תזכורות בשעה הקרובה»), never «מטלות מתוזמנות».

## Limits (current)

`TEAM_SCHEDULES` and `WORKER_SAVED_DATA` use **server visibility gates** (not prompt-only): non-owners only get their own dated tasks / worker jobs tied to them; owners see all; guests omit both. First-person day answers can still mix the speaker’s tasks with **their own** Lucy jobs (relevance) — a harder fetch-action design remains backlog (`docs/future-considerations.md`). After a visibility change, an **old OpenAI conversation** may still repeat pre-filter claims until the thread is reset or the model follows the live-JSON / `PENDING_ACTION_STATE` split.

## Code

| Piece | Role |
|-------|------|
| `backend/src/utils/relative-date.ts` — `sessionClock`, `formatSessionClockContext` | Build / format clock facts + first-person / YOU-day filter hints |
| `backend/src/services/employee-records.service.ts` — `resolveRecordVisibility`, `getTeamSchedules`, `scopeItemsToViewerId` / `workerItemTiedToSpeaker`, `formatEmployeeContext` | Shared ownership gate; speaker-scoped worker jobs; LIVE FACTS vs hold note |
| `backend/src/services/chat.service.ts` | Prepend `SESSION_CLOCK`; WHEN prompts; `WORKER_SAVED_DATA` via `scopeItemsToViewerId` |
| `LLM.config.json` | Same WHEN/TODAY/SOON guidance for Lucy’s seeded prompt |

## Tests

- `backend/tests/relative-date.test.ts` — clock parts and context string for a fixed `now` (incl. YOU-day hint).
- `backend/tests/employee-records.test.ts` — team schedules format + ownership-scoped `getTeamSchedules`; worker item speaker ties + scoped `WORKER_SAVED_DATA`; LIVE FACTS header.
