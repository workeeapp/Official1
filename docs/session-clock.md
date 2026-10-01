# Session clock (ask-time dates)

## Problem

Saved tasks already store concrete dates (`YYYY-MM-DD` in Asia/Jerusalem). Questions like «מה אני צריך לעשות היום?» / «בעוד שעתיים» need a **known now** so the model can filter those rows.

This is **not** the same as save-time relative labels (`היום` → `2026-10-01` in `relative-date.ts` on write).

## Flow

1. User asks what is due today / soon / this week / a weekday.
2. Server loads live `EMPLOYEE_SAVED_DATA` (and schedules / active reminders) for this turn.
3. `TEAM_SCHEDULES` uses the **same ownership gate** as saved data (`resolveRecordVisibility`): owners → all humans’ dated tasks; non-owners → speaker only; guests → omitted.
4. Server also injects `SESSION_CLOCK` every turn (`formatSessionClockContext`).
5. The digital worker filters in `response` against `SESSION_CLOCK` — **no** server-built report, **no** extra DB query, **no** `query: "report"`.
6. For **אני / שלי**, prompts require speaker personal tasks + their active reminders only — not `WORKER_SAVED_DATA`, not other owners’ schedule rows, not someone-else custom lists as the day plan.
7. Empty timed window → plain Hebrew (e.g. «אין לך מטלות או תזכורות בשעה הקרובה»), never «מטלות מתוזמנות».

## Limits (current)

Context is still **preloaded** every turn (`WORKER_SAVED_DATA` included). First-person day answers therefore still rely on the model respecting WHEN prompts for worker/custom-list confusion. A harder design (model declares a fetch/`query`, engine loads only that slice, then answer) is backlog — see `docs/future-considerations.md`.

## Code

| Piece | Role |
|-------|------|
| `backend/src/utils/relative-date.ts` — `sessionClock`, `formatSessionClockContext` | Build / format clock facts + first-person filter hint |
| `backend/src/services/employee-records.service.ts` — `resolveRecordVisibility`, `getTeamSchedules` | Shared ownership gate for saved data + team schedules |
| `backend/src/services/chat.service.ts` | Prepend `SESSION_CLOCK` to turn context; WHEN/TODAY/SOON prompt lines |
| `LLM.config.json` | Same WHEN/TODAY/SOON guidance for Lucy’s seeded prompt |

## Tests

- `backend/tests/relative-date.test.ts` — clock parts and context string for a fixed `now`.
- `backend/tests/employee-records.test.ts` — team schedules format + ownership-scoped `getTeamSchedules` where clause.
