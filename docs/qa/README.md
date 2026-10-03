# QA docs

Workee testing follows **Model → ACTION → engine**. Understanding is never in the server, so QA splits **execution** (deterministic) from **Lucy routing** (probabilistic), under a thin live tip.

## Five phases (canonical)

### Phase 1 — engine
Mainly an **engine** test (unit: call apply functions directly).

**Flow:** Frozen correct ACTION → engine apply → check DB/side effects (e.g. filing soft-deleted).

You’re not checking that Lucy chose `remove_filing`. You’re checking that **when the ACTION is already right, the server executes it correctly**.

### Phase 2 — UI
Mainly a **frontend** test.

**Flow:** Mock API returns canned JSON → UI renders/sends/errors → check screens and wiring.

You’re not checking Lucy or real Postgres apply. You’re checking that **the React app behaves when the backend “answers” as expected**.

### Phase 3 — API + mocked LLM
Mainly an **orchestration / API** test (real Express chat path; Lucy faked).

**Flow:** `POST /api/chat` → fake Lucy returns fixed metadata → real engine runs → check HTTP + DB + reply saved.

You’re not checking that a live model would pick that ACTION. You’re checking that **the chat path from request → apply → response works when the brain is stubbed**.

Diff vs Phase 1: same known ACTION at the end, but Phase 3 runs auth → `sendChatMessage` → parse → apply → save turn. Phase 1 only benches the gearbox; Phase 3 puts it in the car with a scripted driver.

### Phase 4 — model / prompt
Mainly a **model/prompt** test.

**Flow:** User says delete… → Lucy returns metadata → check that ACTION is the right one for the server (e.g. `remove_filing`, not `lists.remove`).

You’re not checking that Postgres deleted the row (Phase 1). You’re checking that **Lucy asked the engine for the right thing**.

Corpus tags: `happy` · `action-confusion` · `hallucination-boundaries` · `safety-rails`.

### Phase 5 — live smoke
Mainly a **thin end-to-end smoke** test.

**Flow:** Real (or staging) UI or WhatsApp → live/mostly-live stack → check the journey still works.

Not full coverage or exact Hebrew wording — a handful of paths before/after a release, not the regression backbone.

| Phase | Brain | Server path | Typical assert | Status |
|------:|-------|-------------|----------------|--------|
| 1 | N/A (frozen ACTION) | Apply function only | DB / mocks | Done (matrix + inventory) |
| 2 | N/A | UI only (API mocked) | Screen / UX | Done (matrix + inventory) |
| 3 | Fake fixed ACTION | Full chat API | HTTP + DB + message saved | Not started |
| 4 | Real Lucy | Thin harness | metadata constraints | Catalog seeded |
| 5 | Live / mostly live | Full stack | Journey still works | Not started |

## Doc index

| Doc | What it is |
|-----|------------|
| [phase-1-engine-matrix.md](./phase-1-engine-matrix.md) | Phase 1 coverage grid (domain × add/update/remove) |
| [phase-2-ui-matrix.md](./phase-2-ui-matrix.md) | Phase 2 coverage grid (screen × states) |
| [test-inventory.md](./test-inventory.md) | Full numbered list of every `it(...)` title |
| [journeys-catalog.md](./journeys-catalog.md) | Phase 4 utterance → ACTION seeds |
| [last-ci-report.md](./last-ci-report.md) | Latest CI report as markdown |
| [reports/](./reports/) | Vitest **HTML** reports (`backend/` · `frontend/` · `shared/`) — open via `npx vite preview --outDir docs/qa/reports/backend` |

## Running tests

```bash
npm test
```

**CI:** push/PR + on-demand (Actions → **Test** → **Run workflow**). Three jobs (`shared` / `backend` / `frontend`). Each publishes a Checks Summary, and uploads a **`*-test-report`** artifact (`index.html` + JUnit). Download the artifact and open with `npx vite preview --outDir <extracted-folder>` (raw `file://` often fails for Vitest HTML).

See also root [README.md](../../README.md#tests).
