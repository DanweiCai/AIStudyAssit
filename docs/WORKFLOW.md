# Engineering Workflow

**How every task in [`TASKS.md`](./TASKS.md) gets from `TODO` to merged.** This is the operating procedure for any agent or person doing coding work in this repo. It is binding — a task that skips a step here is not done, regardless of whether the code works.

**One task → one branch → one PR.** No exceptions, no batching, no "while I was in there."

---

## The loop

```
 1. CLAIM      pick the next task whose deps are DONE; set Status = WIP
 2. READ       read every spec section the task cites, before writing code
 3. BRANCH     git checkout -b task/T-XXX-<slug>   (from an up-to-date main)
 4. BUILD      implement exactly the task's scope
 5. VALIDATE   run the full local gate — every command must pass
 6. VERIFY     check each acceptance criterion explicitly, with evidence
 7. COMMIT     one logical commit (or a few); message references the task ID
 8. PR         push the branch, open a PR using the template below
 9. RECORD     set Status = DONE in TASKS.md; append anything ambiguous to Open Items
```

Steps 5 and 6 are different things. Step 5 proves you did not break the system. Step 6 proves you built the thing that was asked for. A green test suite that does not exercise the acceptance criteria satisfies neither.

---

## 1. Claim

Pick the **next task whose `Depends on` are all `DONE`**. Prefer the critical path in `TASKS.md` § Critical Path when several are eligible.

Set its Status to `WIP` in `docs/TASKS.md` before starting. If you stop without finishing, set it back to `TODO` or `BLOCKED` with a note — never leave a stale `WIP`.

## 2. Read the spec first

Every task cites `REQ §x` and/or `TD §x`. Read those sections before writing a line. The specs are authoritative; `TASKS.md` is a sequencing aid, not a substitute.

**Never invent spec.** If the specs are silent or contradict each other on something you need:

1. Append a row to the Open Items table at the bottom of `docs/TASKS.md` — what is ambiguous, which task it blocks, what you assumed to keep moving.
2. Call it out in the PR body under **Open items**.
3. Keep moving under the stated assumption unless proceeding would be unsafe or would make the work useless if the assumption is wrong — in that case, stop and ask.

## 3. Branch

```bash
git checkout main && git pull --ff-only
git checkout -b task/T-104-pdf-text-extraction
```

**Naming:** `task/T-<id>-<short-kebab-slug>`. One branch per task. Never commit directly to `main`.

If a task turns out to depend on unmerged work from another branch, say so in the PR rather than cherry-picking commits between task branches.

## 4. Build — scope discipline

Implement **exactly** the task's scope.

- **Do not silently expand scope.** If a task cannot be completed as specified, stop and report why rather than substituting an adjacent implementation.
- Unrelated bugs or cleanups you notice go in the PR description as a note, or become a new task — not into this diff.
- Every PR must obey the eight cross-cutting rules (`TASKS.md` § Cross-Cutting Rules). They are restated in the PR checklist because they are the rules most easily forgotten under deadline.

## 5. Validate — the local gate

**Every command below must pass before you open a PR.** Not "mostly pass." Not "fails only on unrelated tests."

### Backend (`apps/api`, `apps/worker`)

```bash
uv run ruff format --check .        # formatting
uv run ruff check .                 # lint
uv run mypy --strict .              # types
uv run pytest                       # tests
uv run pytest path/to/test.py::test_name    # a single test, while iterating
```

### Frontend (`apps/web`)

```bash
npm run lint          # eslint
npm run typecheck     # tsc --noEmit
npm run test          # vitest run
npm run build         # next build — catches what tsc alone does not
npx vitest run -t "test name"       # a single test, while iterating
```

### Schema pipeline (any PR touching `packages/schemas/`)

```bash
npm run schemas:generate            # regenerate Pydantic + TS types
git diff --exit-code                # MUST be empty — stale generated types fail CI
```

This is the load-bearing check of the whole build (T-005). Generated types are committed; a non-empty diff here means the LLM contract, the backend validator, and the renderer have silently drifted apart.

### Stack smoke test (any PR touching services, models, or migrations)

```bash
docker compose up -d
uv run alembic upgrade head
# exercise the touched path; then:
docker compose down
```

### If a gate cannot run

Say so explicitly in the PR body under **Validation**, with the reason. Do **not** report a skipped gate as passing, and do not report a task as done on the strength of gates you did not run. An honest "Docker is unavailable in this environment, so the compose smoke test was not executed" is worth more than a checkmark that means nothing.

## 6. Verify the acceptance criteria

Each task's acceptance criteria are written to be mechanically checkable. Go through them **one at a time** and record the evidence — a test name, a command's output, a screenshot, a manual reproduction.

Some tasks name a specific check. Honor them literally:

| Task | The check |
|---|---|
| T-005 | Regenerate types; the diff must be empty |
| T-008 | Kill a worker mid-job; the job returns to `queued` with `attempt` incremented |
| T-110 | `usage.cache_read_input_tokens` is non-zero on the second generation |
| T-117 | A test covers the double-click case specifically |
| T-135 | A user deletion purges trace blobs from the other bucket |

**A task is done when its acceptance criteria pass — not when the code is written.**

## 7. Commit

```
T-104: extract PDF text with page locators

Implements FR-ING-1 via PyMuPDF. Multi-column reading order verified
against the two-column fixture. Emits the common document representation
consumed by T-107 chunking.

Refs: REQ FR-ING-1, TD §8.5
```

First line: `T-<id>: <imperative summary>`, under ~70 chars. Body explains *why* and cites the requirement IDs. Keep commits logically coherent — one per task is the norm.

## 8. Pull request

```bash
git push -u origin task/T-104-pdf-text-extraction
gh pr create --fill --base main --title "T-104: extract PDF text with page locators" --body-file .github/pr-body.md
```

Use the template in [`.github/pull_request_template.md`](../.github/pull_request_template.md). Every section is required; delete none of them.

**Never merge a PR whose gates are red.** The point of the branch-per-task rule is that a broken task is contained to one branch and blocks only its dependents.

## 9. Record

- Set the task's Status to `DONE` in `docs/TASKS.md` — in the same PR as the work, so the two never disagree.
- Append any ambiguity discovered to the Open Items table.
- If the work revealed that a *later* task's spec is wrong, note it there too rather than editing the spec unilaterally. Requirements changes are decisions, not refactors.

---

## Phase exits are gates, not milestones

Do not start a Phase N+1 task until the Phase N exit criteria in `TASKS.md` are actually met. The exits exist because each phase leaves the system in a state the next phase assumes:

| Phase | Exit |
|---|---|
| 0 | `docker compose up` works; pytest and vitest green; generated types in sync; a stub job survives every state in `TD §3.1` including worker death; a trace lands in object storage |
| 1 | Upload a PDF → correct citation-backed study guide in < 3 min p95; eval suite green; cost per artifact measured against `TD §7.3` |
| 2 | All P0 requirements met; citation resolution > 95% on the full golden corpus |
| 3 | Audio overviews rated useful by > 70% of users who generate one |

---

## Definition of Done

A task is done when **all** of these are true:

- [ ] Every acceptance criterion verified, with evidence recorded in the PR
- [ ] Full local gate green (or any skipped gate explicitly named and justified)
- [ ] Cross-cutting rules X1–X8 hold for the diff
- [ ] Generated schema types are in sync (if `packages/schemas/` was touched)
- [ ] Tests cover the new behavior, including its failure modes — not just the happy path
- [ ] `docs/TASKS.md` Status updated in the same PR
- [ ] Open Items updated with anything ambiguous
- [ ] PR opened from a `task/T-XXX-*` branch against `main`, template fully filled

## Never

- Commit to `main` directly, or bundle two tasks into one PR
- Report a gate as passing when it was skipped, or a task as done on unrun checks
- Hand-edit generated Pydantic models or TS types — edit the JSON Schema and regenerate
- Put a model ID in application code, or append a date suffix to one (X2)
- Ship a code path that produces user-visible factual content without routing it through the T-113/T-114 validators (X1)
- Silently truncate, cap, sample, or drop output without telling the user (X6)
- Resolve a spec contradiction by editing one side — log it and ask (T-134 is the live example)
