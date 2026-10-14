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
| `time` | `HH:mm` Jerusalem; **required** for calendar reminder clocks; **optional** for standing tasks (all-day ok). For `freq=interval` it is the time of the **first** occurrence only (optional) |
| `end_time` | Standing tasks only: `HH:mm` end of each occurrence («כל יום שני מ־10:00 למשך שעתיים» → `time` 10:00, `end_time` 12:00 — the model computes it). Needs `time`; dropped on `interval` rules and on reminder clocks. Shows in `חוזר` as «ב־10:00–12:00» and in `next_occurrences` as `YYYY-MM-DD HH:mm–HH:mm` (a moved day keeps only its new start). |
| `until` | Last calendar day `YYYY-MM-DD` inclusive |
| `count` | Total occurrences including the first |

**Reminders:** `metadata.reminders[].recurrence` plus the usual `in` / `time` / `ping` / `text` / `compose`.  
**Standing tasks:** `metadata.lists` add/update with `list_type: tasks`, clean task name, **no** `תאריך לביצוע`, and `recurrence` on the item. Stop repeating with `lists.update` + `recurrence: null`.

**Occurrence done:** `lists.update` with `item_id` + `occurrence_done` (`YYYY-MM-DD` or `true` for today). The standing row stays; only that occurrence leaves `next_occurrences`. Do **not** `lists.remove` a standing task just because they finished today’s gym.

**Minimum repeat is every hour.** A new or changed repeat every N seconds/minutes (`freq=interval` with `unit` `seconds`/`minutes`, or legacy `every_unit`) is refused on every path (`isSubHourlyRecurrence`): reminders are skipped as `too_frequent`, list items are not saved, scheduled messages are not created, and when the model emits one anyway the server drops that turn's actions and replies «אי אפשר לקבוע חזרה כל כמה דקות או שניות. הכי תכוף שאפשר הוא כל שעה.». One-time delays in minutes (`in`) are unaffected; clocks already stored with minutes keep firing.

**Every X hours** (`freq=interval`, «כל שלוש שעות אני צריך להוריד את הכלב» / «תזכירי לי לשתות שוקו כל שעתיים»):

- Reminder: first fire is now + interval, unless the ACTION has `in` / `time`. No “which is first” question; fires 24/7.
- Standing task: stored with `start` + `time` as the anchor (default: the save moment). Slots are `anchor + k × interval`; `next_occurrences` lists the slot due now plus the following ones as `YYYY-MM-DD HH:mm`.
- Done marks are per slot: `occurrence_done: true` marks the slot due now; `"YYYY-MM-DD HH:mm"` snaps to the slot at or before it.
- A worker task linked to an interval clock mirrors the rule, anchored at the clock’s `fireAt`.
- `occurrence_change` (single-occurrence cancel/move) is not supported for interval rules.

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
