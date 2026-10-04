# Phase 3 — API + mocked LLM matrix

Branch: `test/qa-phase-2-ui` (same QA track).

**Rule:** `POST /api/chat/messages` (supertest) → LLM client stub returns fixed ACTION JSON → real `sendChatMessage` + engine → assert HTTP 200, Prisma side effects, saved assistant message. No live OpenAI / Lucy.

Diff vs Phase 1: same known ACTION, but full chat pipe (auth → parse → apply → save turn).

| Journey | Frozen ACTION (LLM stub) | Assert | File |
|---------|--------------------------|--------|------|
| Filing remove (email code) | `remove_filing` drifted name; `lists` empty | soft-delete resolved filing; no list mutate; reply saved | `chat.test.ts` |
| Filing update | `update_filing` → info `999` | `filing.update`; no create | `chat.test.ts` |
| Directory add | `directory.add` מיכל + phone | `contact.upsert` | `chat.test.ts` |
| Shopping single remove | one `lists.remove` shopping | soft-delete item immediately | `chat.test.ts` |
| Add shopping/task/filing | existing | create paths | `chat.test.ts` (pre-existing) |
| Targeted list / notify / relay / handoff | existing | orchestration | `chat.test.ts` (pre-existing) |

## Gaps (later)

- Bulk `delete_lists` confirm round-trip through chat API
- WhatsApp webhook inbound → same mocked LLM → apply (channel glue)
- Reminder save/cancel via chat API end-to-end
- Phase 3 chat stub for personal shopping + same-turn message (targets must stay `[]` — engine unit covered)

## Not Phase 3

- Live Lucy routing → Phase 4  
- Playwright / staging smoke → Phase 5  
- Apply-only unit → Phase 1  
- Exact-list-or-ask **prompt** behavior → Phase 4 (`list-ambiguous-name-ask`)  
