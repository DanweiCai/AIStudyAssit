<!-- One task per PR. See docs/WORKFLOW.md. Fill every section; delete none. -->

## Task

**T-XXX** — <task title from docs/TASKS.md>

**Spec references read:** `REQ §x`, `TD §x`
**Depends on:** T-XXX (merged) · **Blocks:** T-XXX

## What changed

<Two or three sentences. What this adds, and the one design decision worth knowing about.>

## Acceptance criteria

Each criterion from the task, with the evidence that it passes.

- [ ] <criterion> — *evidence: `test_name` / command output / manual repro*
- [ ] <criterion> — *evidence: …*

## Validation

Commands actually run, with their result. Name and justify anything skipped — a skipped gate is never reported as passing.

| Gate | Result |
|---|---|
| `ruff format --check .` | |
| `ruff check .` | |
| `mypy --strict .` | |
| `pytest` | |
| `npm run lint` / `typecheck` / `test` / `build` | |
| `npm run schemas:generate && git diff --exit-code` | |
| `docker compose up` smoke test | |

## Cross-cutting rules

Only tick what applies to this diff; strike through what does not.

- [ ] **X1** No fabricated grounding — user-visible factual content routes through the T-113/T-114 validators
- [ ] **X2** Model IDs from config; no literals, no date suffixes
- [ ] **X3** Money-spending endpoints are idempotent (both layers)
- [ ] **X4** Long operations are jobs; no synchronous LLM call holds a connection
- [ ] **X5** Artifacts record provenance — sources, model, prompt version, schema version, trace ID
- [ ] **X6** No silent truncation; dropped or capped output is surfaced to the user
- [ ] **X7** User content is not used for training
- [ ] **X8** LLM calls are streamed

## Open items

Anything the specs were silent or contradictory on, and what was assumed to keep moving. Mirror each into the Open Items table in `docs/TASKS.md`.

<none / list>

## Housekeeping

- [ ] `docs/TASKS.md` Status set to `DONE` in this PR
- [ ] Generated types regenerated and committed (if `packages/schemas/` was touched)
- [ ] Scope matches the task exactly — no unrelated changes
