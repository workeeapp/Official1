# Phase 2 — UI coverage matrix

Branch: `test/qa-phase-2-ui` (same worktree as Phase 1). Product runtime stays on `feat/multi-instance-state`.

**Rule:** mock frontend services (`authApi` / `employeeApi` / `chatApi` / `whatsappApi`) → render page → assert UI. No Lucy, no real HTTP.

| Screen | Happy path | Validation / empty | API error | Auth / nav |
|--------|------------|--------------------|-----------|------------|
| Login | covered | empty fields, bad username | invalid credentials | redirect in/out |
| Dashboard | greeting | — | — | Employees, Chat, WhatsApp tabs; logout |
| Chat | history, send, Enter, threads, reset, SSE notify | — | send fail, abort/Stop | Chat As / Chat With isolation |
| Employees | list, select, usage, records, edit/delete item, Inherit Lucy | empty list; form kind fields | list load fail; records load fail | Lucy not deletable |
| WhatsApp | aligned status (no mismatch) | empty flow log | status load fail | Refresh |

## Cases added on this branch (Phase 2)

1. Dashboard → WhatsApp tab
2. WhatsApp healthy (no mismatch) + empty events
3. WhatsApp status API error
4. Employees list load error
5. Employees empty list copy
6. Employees create person (mocked `create` + reload)
7. Employees records load error

## Not Phase 2

- Live Playwright / browser against real API → Phase 5
- `POST /api/chat` with mocked LLM → Phase 3
- Utterance → ACTION → Phase 4
