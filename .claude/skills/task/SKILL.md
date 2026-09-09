---
name: task
description: Execute one task from docs/TASKS.md end to end — claim it, read its spec sections, branch, implement, run the full local gate, verify each acceptance criterion, and open a PR. Use whenever picking up implementation work in this repo, or when the user names a task ID (e.g. "do T-104", "start the next task", "continue implementation").
---

# Execute one task from `docs/TASKS.md`

The binding procedure is [`docs/WORKFLOW.md`](../../../docs/WORKFLOW.md). **Read it now** — this skill is a pointer to it, not a summary of it.

## Arguments

`/task T-104` — do that task. `/task` with no argument — pick the next task whose `Depends on` are all `DONE`, preferring the critical path.

## Non-negotiables

1. **One task → one branch → one PR.** Branch `task/T-<id>-<slug>`, cut from an up-to-date `main`. Never commit to `main`.
2. **Read the cited spec sections before writing code.** Every task cites `REQ §x` / `TD §x`. The specs are authoritative.
3. **Run the full local gate before the PR** (`WORKFLOW.md` §5). If a gate cannot run in this environment, say so explicitly in the PR — never report a skipped gate as passing.
4. **Verify each acceptance criterion individually, with evidence** (§6). Done means the criteria pass, not that the code is written.
5. **Do not silently expand scope.** If the task cannot be completed as specified, stop and report why.
6. **Never invent spec.** Log ambiguity in the Open Items table in `docs/TASKS.md` and in the PR.
7. **Update the task's Status** (`TODO` → `WIP` → `DONE`/`BLOCKED`) in the same PR as the work.

## Before opening the PR

Walk the Definition of Done checklist at the bottom of `WORKFLOW.md` and fill every section of `.github/pull_request_template.md`.

## Repo-specific traps

Re-read these in `CLAUDE.md` before touching the relevant area — each is a rewrite if gotten wrong:

- `packages/schemas/*.json` is the single source of truth; Pydantic and TS types are generated and committed. Never hand-edit a generated model.
- `GenerationJob` in Postgres is the job record; Celery is only an executor.
- T-114 (degradation policy) must be built before the renderers.
- Prompt cache: corpus before the breakpoint, artifact spec after — reversing it forfeits a ~3× cost difference.
