# QA docs

| Doc | Phase |
|-----|-------|
| [phase-1-engine-matrix.md](./phase-1-engine-matrix.md) | Engine ACTION → DB |
| [phase-2-ui-matrix.md](./phase-2-ui-matrix.md) | UI + mocked API (Vitest / Testing Library) |
| [journeys-catalog.md](./journeys-catalog.md) | Utterance → ACTION seeds (Phase 4) |

## Worktree note (`Official1-qa-phase1`)

Product servers stay on `Official1` / `feat/multi-instance-state`.

This worktree junctions most of `node_modules` from the main tree, but **`node_modules/@workee/{backend,shared,frontend}` must point at this worktree** (not Official1). Otherwise `npm test -w backend` runs the wrong sources.

```powershell
# From Official1-qa-phase1, if tests look stale:
foreach ($pkg in "backend","shared","frontend") {
  $link = "node_modules\@workee\$pkg"
  if (Test-Path $link) { cmd /c "rmdir `"$link`"" }
  cmd /c "mklink /J `"$link`" `"$pwd\$pkg`""
}
```

Run Phase 1 tests:

```powershell
npm test --workspace backend -- employee-records.test.ts directory-apply.test.ts contact.test.ts
```
