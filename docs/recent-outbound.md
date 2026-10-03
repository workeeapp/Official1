# Recent outbound (reminder fires in chat context)

## Problem

Scheduled reminder sends (WhatsApp / clock fire) are stored on the `Reminder` row (`last_composed_text`, `sent_at`) and often as a UI `ChatMessage`, but they are **not** part of the OpenAI conversation. When the speaker later says «לגבי מה ששלחת» / asks about the digest, the model had no fact block for that text (and done one-shot clocks leave `EMPLOYEE_SAVED_DATA`).

## Flow

1. Clock fires → WhatsApp (and optional chat UI message).
2. Later chat turn → server loads the latest **sent** reminder whose `ping` includes this speaker (within a long retention window so “latest” is not cut off after a day).
3. Inject `RECENT_OUTBOUND` into the turn facts (same pattern as `EMPLOYEE_SAVED_DATA`) — **one** message only.
4. Model answers from that block. **Does not** resend unless the speaker asks.

## Code

| Piece | Role |
|-------|------|
| `backend/src/services/recent-outbound.service.ts` | List + format |
| `backend/src/services/chat.service.ts` | Inject into context + runtime prompt |
| `LLM.config.json` | Seeded Lucy note |

## Tests

- `backend/tests/recent-outbound.test.ts`
