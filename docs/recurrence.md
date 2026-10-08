# Structured recurrence

## Problem

Hebrew (and English) standing schedules — «כל שלישי וחמישי ב־19:00», «כל 1 לחודש עד דצמבר», yearly birthdays — need a single stored rule, Jerusalem wall-time math, and answers that talk about **occurrences**, not a one-off date stuck on the row forever.

Legacy `repeat` strings (`30:seconds`, `weekdays:1,3`) still exist for older clocks; new structured repeats use `recurrence`.

## Model → ACTION

The model emits a `recurrence` object (never invent clocks from weekday words in free text without the model saying so):

```json
{
  "freq": "weekly",
  "interval": 1,
  "weekdays": [2, 4],
  "time": "19:00",
  "until": "2026-12-31"
}
```

| Field | Meaning |
|-------|---------|
| `freq` | `interval` \| `daily` \| `weekly` \| `monthly` \| `yearly` |
| `interval` | Every N units / days / weeks / months / years |
| `unit` | Only for `freq=interval`: `seconds` \| `minutes` \| `hours` |
| `weekdays` | 0=Sunday … 6=Saturday |
| `month_day` | 1–31 (clamped on short months) |
| `month` | 1–12 (yearly) |
| `time` | `HH:mm` Jerusalem; **required** for reminder clocks; **optional** for standing tasks (all-day ok) |
| `until` | Last calendar day `YYYY-MM-DD` inclusive |
| `count` | Total occurrences including the first |

**Reminders:** `metadata.reminders[].recurrence` plus the usual `in` / `time` / `ping` / `text` / `compose`.  
**Standing tasks:** `metadata.lists` add/update with `list_type: tasks`, clean task name, **no** `תאריך לביצוע`, and `recurrence` on the item. Stop repeating with `lists.update` + `recurrence: null`.

**Occurrence done:** `lists.update` with `item_id` + `occurrence_done` (`YYYY-MM-DD` or `true` for today). The standing row stays; occurrences up through that day leave `next_occurrences`. Do **not** `lists.remove` a standing task just because they finished today’s gym.

## Engine

1. Parse with `parseRecurrence` (`shared/src/recurrence.ts`) — snake/camel aliases accepted.
2. Anchor missing weekday / month_day / time from the first fire (`anchorRecurrence`).
3. Persist JSON on the reminder / list-item data.
4. Advance clocks with Jerusalem wall time (`jerusalemWallTimeToDate`, `nextOccurrence`).
5. Inject snapshot fields: `חוזר`, `next_occurrences` (and linked worker task dates follow the repeating clock).

Date questions («מה יש לי ביום שלישי») must scan `next_occurrences` before answering empty — see WHEN prompts in `chat.service.ts`.

## Code

| Piece | Role |
|-------|------|
| `shared/src/recurrence.ts` | Parse, serialize, next occurrence, Hebrew labels |
| `shared/src/jerusalem-time.ts` | Asia/Jerusalem parts / wall-time → `Date` |
| `backend/src/services/reminder.service.ts` / `reminder-fire.ts` | Save + fire + advance |
| `backend/src/services/employee-records.service.ts` | Standing task shape, `occurrence_done`, snapshot |
| `LLM.action.json` / `LLM.config.json` | Schema + seeded Lucy guidance |

## Tests

- `shared/src/recurrence.test.ts` — parse / next / until / count
- `shared/src/jerusalem-time.test.ts` — wall-time edges
- `backend/tests/recurrence.test.ts` — engine shaping / snapshot
- `backend/tests/reminder-recurrence-apply.test.ts` — apply path
- `backend/tests/reminder-fire.test.ts` — fire advances recurring clocks
